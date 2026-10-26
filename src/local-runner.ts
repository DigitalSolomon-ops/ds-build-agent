/**
 * Local Builds plan runner — the blacktop half of a Local Builds launch.
 *
 *   ds-build local-runner           poll forever (install as a scheduled task)
 *   ds-build local-runner --once    one pass; waits for what it started
 *
 * The cockpit's Launch button (the only way a synced plan starts) acquires the
 * airspace claim and marks projects/{id}.localLaunch = requested. This runner
 * picks the request up atomically, downloads the SAME plan the cloud lane would
 * run (projects/{id}.planUri), and runs it through the ordinary CLI:
 *
 *   ds-build <plan> --repo <project folder> --run-id <runId> --concurrency 3 --state
 *
 * so the CLI ADOPTS the cockpit's claim, heartbeats it, and releases it — the
 * airspace path is identical to a hand-started local run. Runs on the Claude
 * subscription (the CLI's local default). It never launches anything that was
 * not requested from the cockpit, and it never touches the cloud lane's runs/.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LocalLaunchState = "requested" | "running" | "held" | "done" | "failed";

/** projects/{id}.localLaunch — written by the cockpit (requested) and this runner. */
export interface LocalLaunch {
  state: LocalLaunchState;
  runId: string;
  requestedAt: number;
  requestedBy?: string;
  host?: string;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number;
  message?: string;
  logTail?: string[];
  updatedAt?: number;
}

export interface LaunchRecord {
  projectId: string;
  name: string;
  planUri: string;
  localPath: string;
  localLaunch: LocalLaunch;
}

export interface LocalRunnerBackend {
  /** Atomically flip ONE requested launch to running for this host; undefined if none. */
  claimNext(host: string, now: number): Promise<LaunchRecord | undefined>;
  update(projectId: string, patch: Partial<LocalLaunch>): Promise<void>;
  downloadPlan(planUri: string): Promise<string>;
  beat(status: { host: string; beatAt: number; running: string[] }): Promise<void>;
}

/** Strip anything key-shaped before a log line leaves blacktop. */
export function redact(line: string): string {
  return line
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AIza[0-9A-Za-z_-]{10,}|pit-[A-Za-z0-9-]{8,})/g, "[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, "$1[redacted]");
}

/** Exit code -> launch state. 3 = the CLI was held by airspace. */
export function stateForExit(code: number | null): LocalLaunchState {
  return code === 0 ? "done" : code === 3 ? "held" : "failed";
}

export type SpawnRun = (args: string[], onLine: (line: string) => void) => Promise<number | null>;

/** Run the CLI as a child process, streaming its output line by line. */
export const spawnCli: SpawnRun = (args, onLine) =>
  new Promise((done) => {
    const harnessRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
    const child = spawn(process.execPath, [join(harnessRoot, "dist", "index.js"), ...args], {
      cwd: harnessRoot,
      env: process.env,
      windowsHide: true,
    });
    let buf = "";
    const feed = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) onLine(l);
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("close", (code) => {
      if (buf.trim()) onLine(buf);
      done(code);
    });
    child.on("error", (e) => {
      onLine(`✗ could not start ds-build: ${e.message}`);
      done(1);
    });
  });

/** Run one launch to completion and record the outcome. Never throws. */
export async function runLaunch(
  rec: LaunchRecord,
  deps: { backend: LocalRunnerBackend; projectsRoot: string; spawnRun?: SpawnRun; concurrency?: number; now?: () => number },
): Promise<LocalLaunchState> {
  const now = deps.now ?? Date.now;
  const tail: string[] = [];
  let lastErr = "";
  let lastPush = 0;
  const push = (force = false) => {
    if (!force && now() - lastPush < 20_000) return;
    lastPush = now();
    void deps.backend.update(rec.projectId, { logTail: tail.slice(-50), updatedAt: now() }).catch(() => {});
  };
  try {
    const yaml = await deps.backend.downloadPlan(rec.planUri);
    const dir = mkdtempSync(join(tmpdir(), "ds-local-"));
    const planFile = join(dir, `${rec.projectId}.plan.yaml`);
    writeFileSync(planFile, yaml);
    const repo = resolve(deps.projectsRoot, rec.localPath);
    const args = [planFile, "--repo", repo, "--run-id", rec.localLaunch.runId,
      "--concurrency", String(deps.concurrency ?? 3), "--state"];
    const code = await (deps.spawnRun ?? spawnCli)(args, (line) => {
      const l = redact(line);
      tail.push(l);
      if (tail.length > 200) tail.shift();
      if (l.trimStart().startsWith("✗")) lastErr = l.trim().replace(/^✗\s*/, "");
      push();
    });
    const state = stateForExit(code);
    await deps.backend.update(rec.projectId, {
      state,
      endedAt: now(),
      exitCode: code ?? -1,
      message: state === "done" ? "finished" : lastErr || `ds-build exited ${code}`,
      logTail: tail.slice(-50),
      updatedAt: now(),
    });
    return state;
  } catch (e) {
    await deps.backend
      .update(rec.projectId, { state: "failed", endedAt: now(), message: (e as Error).message, logTail: tail.slice(-50), updatedAt: now() })
      .catch(() => {});
    return "failed";
  }
}

/** One poll: start every waiting launch up to `maxPlans` concurrently, and wait for them. */
export async function runnerPass(deps: {
  backend: LocalRunnerBackend;
  projectsRoot: string;
  spawnRun?: SpawnRun;
  maxPlans?: number;
  host?: string;
}): Promise<string[]> {
  const host = deps.host ?? hostname();
  const started: Promise<LocalLaunchState>[] = [];
  const ids: string[] = [];
  while (started.length < (deps.maxPlans ?? 2)) {
    const rec = await deps.backend.claimNext(host, Date.now());
    if (!rec) break;
    ids.push(rec.projectId);
    started.push(runLaunch(rec, deps));
  }
  await deps.backend.beat({ host, beatAt: Date.now(), running: ids }).catch(() => {});
  await Promise.all(started);
  return ids;
}

/* ── Production backend ───────────────────────────────────────────────────── */

export async function creatorRunnerBackend(): Promise<LocalRunnerBackend> {
  const { Firestore } = await import("@google-cloud/firestore");
  const { Storage } = await import("@google-cloud/storage");
  const projectId = process.env.GCP_PROJECT_ID ?? "digitalsolomon-creator";
  const db = new Firestore({ projectId, ignoreUndefinedProperties: true });
  const storage = new Storage({ projectId });
  const projects = db.collection("projects");
  return {
    async claimNext(host, now) {
      const snap = await projects.where("localLaunch.state", "==", "requested").limit(5).get();
      for (const d of snap.docs) {
        const got = await db.runTransaction(async (tx) => {
          const cur = await tx.get(d.ref);
          const ll = cur.data()?.localLaunch as LocalLaunch | undefined;
          if (!ll || ll.state !== "requested") return undefined;
          tx.update(d.ref, { "localLaunch.state": "running", "localLaunch.host": host,
            "localLaunch.startedAt": now, "localLaunch.updatedAt": now });
          return cur.data();
        });
        if (got) {
          return {
            projectId: d.id,
            name: String(got.name),
            planUri: String(got.planUri),
            localPath: String(got.localPath),
            localLaunch: { ...(got.localLaunch as LocalLaunch), state: "running" },
          };
        }
      }
      return undefined;
    },
    async update(id, patch) {
      const flat: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) flat[`localLaunch.${k}`] = v;
      await projects.doc(id).update(flat);
    },
    async downloadPlan(uri) {
      const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
      if (!m) throw new Error(`planUri is not a gs:// URI: ${uri}`);
      const [buf] = await storage.bucket(m[1]).file(m[2]).download();
      return buf.toString("utf8");
    },
    async beat(status) {
      await db.collection("localRunner").doc("status").set(status);
    },
  };
}
