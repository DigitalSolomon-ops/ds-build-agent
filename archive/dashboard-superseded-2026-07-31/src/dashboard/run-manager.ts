/**
 * Run manager — spawns the harness as a child process and tracks it.
 *
 * Security posture (this spawns real, sometimes paid, processes):
 *   - node is invoked with an ARGS ARRAY and shell:false — no string
 *     interpolation, no shell ever sees user input.
 *   - callers must validate planPath / only-ids / concurrency first.
 *   - one active run per build folder; a second is refused, never run
 *     concurrently against the same builds/<name>/.
 */
import { spawn, ChildProcess, execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import type { BuildPlan } from "../types.js";
import { BUILDS_ROOT, HARNESS_ENTRY, HARNESS_ROOT, safePlanName } from "./config.js";

export interface StartRunParams {
  planPath: string;
  plan: BuildPlan;
  dryRun: boolean;
  concurrency: number;
  only?: string[];
}

type RunStatus = "starting" | "running" | "succeeded" | "failed" | "stopped";

interface SseMsg {
  type: "hello" | "log" | "state" | "event" | "status";
  [k: string]: unknown;
}

const MAX_LOG_LINES = 4000;

/**
 * Write to an SSE response, swallowing errors from a client that has already
 * disconnected. Returns false if the socket is dead so the caller can drop it.
 * Without this, a browser tab closing mid-run throws inside a timer/stdio
 * callback (outside any request try/catch) and crashes the whole server.
 */
function safeWrite(res: ServerResponse, data: string): boolean {
  try {
    if (res.writableEnded || res.destroyed) return false;
    res.write(data);
    return true;
  } catch {
    return false;
  }
}

class Run {
  readonly id: string;
  readonly buildFolder: string;
  readonly stateDir: string;
  readonly dryRun: boolean;
  status: RunStatus = "starting";
  exitCode: number | null = null;
  child: ChildProcess | null = null;

  private readonly runStatePath: string;
  private readonly eventsPath: string;
  private readonly subscribers = new Set<ServerResponse>();
  private readonly logBuffer: SseMsg[] = [];
  private lastState: unknown = null;
  private eventsOffset = 0;
  private lastStateMtime = 0;
  private poll: NodeJS.Timeout | null = null;
  private stdoutRemainder = "";
  private stderrRemainder = "";

  constructor(id: string, params: StartRunParams) {
    this.id = id;
    this.dryRun = params.dryRun;
    const safe = safePlanName(params.plan.name);
    this.buildFolder = join(BUILDS_ROOT, safe);
    this.stateDir = join(BUILDS_ROOT, ".ds-runs", safe);
    this.runStatePath = join(this.stateDir, "run-state.json");
    this.eventsPath = join(this.stateDir, "events.ndjson");
    this.spawnChild(params);
  }

  private buildArgs(params: StartRunParams): string[] {
    // node <harness-entry> <plan> --out <BUILDS_ROOT> --concurrency <n>
    //   --state <stateDir> [--dry-run] [--only a,b]
    const args = [
      HARNESS_ENTRY,
      params.planPath,
      "--out",
      BUILDS_ROOT,
      "--concurrency",
      String(params.concurrency),
      "--state",
      this.stateDir,
    ];
    if (params.dryRun) args.push("--dry-run");
    if (params.only && params.only.length) args.push("--only", params.only.join(","));
    return args;
  }

  private spawnChild(params: StartRunParams): void {
    const child = spawn(process.execPath, this.buildArgs(params), {
      cwd: HARNESS_ROOT,
      shell: false, // never — args are passed as an array
      env: process.env,
      windowsHide: true,
    });
    this.child = child;
    this.status = "running";

    child.stdout?.on("data", (b: Buffer) => this.onStdio("stdout", b));
    child.stderr?.on("data", (b: Buffer) => this.onStdio("stderr", b));

    child.on("error", (err) => {
      this.pushLog("stderr", `[dashboard] failed to start harness: ${err.message}`);
      this.finish(null, "failed");
    });
    child.on("exit", (code, signal) => {
      this.readStateNow();
      this.readEventsNow();
      const status: RunStatus =
        this.status === "stopped" ? "stopped" : code === 0 ? "succeeded" : "failed";
      this.finish(code, status, signal);
    });

    // Poll the state files while the child is alive (reliable on Windows,
    // and the harness writes atomically so partial reads are avoided).
    this.poll = setInterval(() => {
      this.readStateNow();
      this.readEventsNow();
    }, 200);
  }

  private onStdio(stream: "stdout" | "stderr", buf: Buffer): void {
    const key = stream === "stdout" ? "stdoutRemainder" : "stderrRemainder";
    const text = this[key] + buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    this[key] = lines.pop() ?? "";
    for (const line of lines) this.pushLog(stream, line);
  }

  private readStateNow(): void {
    try {
      if (!existsSync(this.runStatePath)) return;
      const mtime = statSync(this.runStatePath).mtimeMs;
      if (mtime === this.lastStateMtime) return;
      this.lastStateMtime = mtime;
      const parsed = JSON.parse(readFileSync(this.runStatePath, "utf8"));
      this.lastState = parsed;
      this.push({ type: "state", state: parsed });
    } catch {
      /* mid-write or transient; next poll catches it */
    }
  }

  private readEventsNow(): void {
    try {
      if (!existsSync(this.eventsPath)) return;
      const size = statSync(this.eventsPath).size;
      if (size <= this.eventsOffset) return;
      const fd = readFileSync(this.eventsPath);
      const slice = fd.subarray(this.eventsOffset).toString("utf8");
      this.eventsOffset = size;
      for (const line of slice.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          this.push({ type: "event", event: JSON.parse(t) });
        } catch {
          /* skip a partial trailing line */
        }
      }
    } catch {
      /* transient */
    }
  }

  private pushLog(stream: "stdout" | "stderr", line: string): void {
    this.push({ type: "log", stream, line });
  }

  /** Broadcast to subscribers and retain replayable history. */
  private push(msg: SseMsg): void {
    if (msg.type === "log") {
      this.logBuffer.push(msg);
      if (this.logBuffer.length > MAX_LOG_LINES) this.logBuffer.shift();
    }
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of this.subscribers) {
      if (!safeWrite(res, data)) this.subscribers.delete(res); // drop dead clients
    }
  }

  private finish(code: number | null, status: RunStatus, signal?: NodeJS.Signals | null): void {
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    this.exitCode = code;
    this.status = status;
    this.push({ type: "status", status, exitCode: code, signal: signal ?? null });
  }

  subscribe(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    safeWrite(res, `retry: 2000\n\n`);
    this.subscribers.add(res);
    // Replay so a late subscriber sees the whole run so far.
    safeWrite(res, `data: ${JSON.stringify({ type: "hello", runId: this.id, dryRun: this.dryRun, status: this.status })}\n\n`);
    if (this.lastState) safeWrite(res, `data: ${JSON.stringify({ type: "state", state: this.lastState })}\n\n`);
    for (const msg of this.logBuffer) safeWrite(res, `data: ${JSON.stringify(msg)}\n\n`);
    if (this.status !== "running" && this.status !== "starting") {
      safeWrite(res, `data: ${JSON.stringify({ type: "status", status: this.status, exitCode: this.exitCode })}\n\n`);
    }
    const ping = setInterval(() => {
      if (!safeWrite(res, `: ping\n\n`)) {
        clearInterval(ping);
        this.subscribers.delete(res);
      }
    }, 15000);
    res.on("close", () => {
      clearInterval(ping);
      this.subscribers.delete(res);
    });
    res.on("error", () => {
      clearInterval(ping);
      this.subscribers.delete(res);
    });
  }

  isActive(): boolean {
    return this.status === "starting" || this.status === "running";
  }

  stop(): void {
    if (!this.isActive() || !this.child?.pid) return;
    this.status = "stopped";
    const pid = this.child.pid;
    if (process.platform === "win32") {
      // Kill the whole tree — agent tasks spawn git and other children.
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
    } else {
      this.child.kill("SIGTERM");
      setTimeout(() => this.child?.kill("SIGKILL"), 4000);
    }
  }

  summary() {
    return {
      id: this.id,
      status: this.status,
      dryRun: this.dryRun,
      exitCode: this.exitCode,
      buildFolder: this.buildFolder,
      stateDir: this.stateDir,
    };
  }
}

// ---- registry ----
const runs = new Map<string, Run>();
let counter = 0;

export function harnessBuilt(): boolean {
  return existsSync(HARNESS_ENTRY);
}

/** Build folder a plan would run into (for the per-folder lock + UI). */
export function buildFolderFor(plan: BuildPlan): string {
  return join(BUILDS_ROOT, safePlanName(plan.name));
}

export function activeRunForFolder(folder: string): Run | undefined {
  for (const r of runs.values()) if (r.buildFolder === folder && r.isActive()) return r;
  return undefined;
}

export function startRun(params: StartRunParams): Run {
  const id = `run-${Date.now()}-${++counter}`;
  const run = new Run(id, params);
  runs.set(id, run);
  return run;
}

export function getRun(id: string): Run | undefined {
  return runs.get(id);
}

export function listRuns() {
  return [...runs.values()].map((r) => r.summary());
}

export type { Run };
