/**
 * Codex build runner — executes one task through the OpenAI Codex CLI
 * (`codex exec`) instead of the Claude Agent SDK. This is the "second coding
 * brain" option: a task with `executor: codex` is built here, then gated,
 * committed, and (when sensitive) adversarially verified by a Claude reviewer
 * exactly like an `agent` task.
 *
 * SDK-FREE: this module shells out to the `codex` binary and never imports the
 * Anthropic Agent SDK, so its pure helpers (buildCodexArgs, parseCodexResult)
 * are unit-testable from checks/ without dragging the SDK in.
 *
 * KNOWN LIMITATIONS (documented, not hidden):
 *  - Cost: the Codex CLI does not report a USD cost, so a codex task leaves
 *    `usage` undefined. OpenAI spend is therefore OUT OF BAND — the harness's
 *    per-run USD cost cap (which brakes Anthropic spend) does not see it. Bound
 *    codex spend on the OpenAI side or by task count.
 *  - Browser: `task.browser` is a Claude-runner feature (Playwright MCP). A
 *    codex task that sets it is warned and run without the browser hookup.
 *  - Auth: needs a Codex login or CODEX_API_KEY / OPENAI_API_KEY in the env.
 */
import { spawn } from "node:child_process";
import type { BuildPlan, Task, TaskResult, TaskUsage } from "./types.js";
import { sharedContext, taskPrompt } from "./prompt.js";
import { modelRank } from "./model.js";
import type { AgentIntegrations } from "./integrations.js";

/** The single prompt string handed to `codex exec` (context + task, combined). */
export function codexPrompt(task: Task, plan: BuildPlan): string {
  return `${sharedContext(plan)}\n\n---\n\n${taskPrompt(task)}`;
}

/**
 * Resolve the model to pass to `codex -m`, or undefined to use Codex's default.
 * A Claude alias (haiku/sonnet/opus) or a Claude-tier plan model is NOT a valid
 * Codex model, so it is ignored here — only a task model that is clearly not a
 * Claude tier, or CODEX_MODEL, is forwarded. This keeps a plan whose global
 * `model` is a Claude tier from accidentally being sent to Codex.
 */
export function codexModel(
  task: { model?: string },
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (task.model && modelRank(task.model) === undefined) return task.model;
  const envModel = env.CODEX_MODEL?.trim();
  return envModel ? envModel : undefined;
}

/**
 * Build the argv for `codex exec` (everything after the binary name). Pure and
 * deterministic so it can be asserted in tests. The prompt is the final
 * positional arg and is passed through argv (no shell), so it needs no escaping.
 */
export function buildCodexArgs(
  task: Task,
  plan: BuildPlan,
  repoPath: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const sandbox = env.CODEX_SANDBOX?.trim() || "workspace-write";
  const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", sandbox, "-C", repoPath];
  const model = codexModel(task, env);
  if (model) args.push("-m", model);
  args.push(codexPrompt(task, plan));
  return args;
}

/** Coerce any finite number, else 0 — never NaN (which would poison sums). */
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** First string found among the given keys of an object, if any. */
function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length) return v;
  }
  return undefined;
}

export interface CodexParsed {
  /** The final agent message (the task's done-summary), best-effort. */
  summary: string;
  /**
   * Token usage IF Codex reported it. costUsd is always 0 here — the CLI does
   * not price the run — so a caller that needs an honest "cost unknown" should
   * treat a codex result's usage as token-only. Undefined when nothing parsed.
   */
  usage?: TaskUsage;
  /** How many JSONL events were understood (0 ⇒ likely not JSON / wrong binary). */
  events: number;
}

/**
 * Parse Codex `exec --json` output (JSONL). Tolerant by design: the event
 * schema has shifted across Codex versions, so rather than bind to one shape we
 * scan each line for (a) human-readable text to stream, (b) a plausible final
 * message, and (c) token counts. A line that is not JSON is treated as raw text
 * (Codex falls back to plain text on some paths). Pure except for the optional
 * `onText` sink.
 */
export function parseCodexResult(
  lines: Iterable<string>,
  onText?: (t: string) => void,
): CodexParsed {
  let summary = "";
  let events = 0;
  let inTok = 0;
  let outTok = 0;
  let sawUsage = false;
  let turns = 0;

  const TEXT_KEYS = ["last_agent_message", "message", "text", "content", "delta"];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      // Not JSON — treat as streamed prose.
      onText?.(line);
      summary = line;
      continue;
    }
    events++;
    if (typeof obj !== "object" || obj === null) continue;
    const o = obj as Record<string, unknown>;

    // Text: forward anything human-readable, and keep the latest as the summary.
    // Nested `item`/`msg` payloads are common, so look one level down too.
    const nested =
      typeof o.item === "object" && o.item !== null
        ? (o.item as Record<string, unknown>)
        : typeof o.msg === "object" && o.msg !== null
          ? (o.msg as Record<string, unknown>)
          : undefined;
    const text = firstString(o, TEXT_KEYS) ?? (nested ? firstString(nested, TEXT_KEYS) : undefined);
    if (text) {
      onText?.(text);
      summary = text;
    }

    // Count agent turns/messages if the event names itself as one.
    const type = typeof o.type === "string" ? o.type : "";
    if (/message|turn|item\.completed/.test(type)) turns++;

    // Usage: accept a `usage`/`token_usage` sub-object or flat token fields.
    const usageObj =
      (typeof o.usage === "object" && o.usage !== null && (o.usage as Record<string, unknown>)) ||
      (typeof o.token_usage === "object" &&
        o.token_usage !== null &&
        (o.token_usage as Record<string, unknown>)) ||
      (nested &&
        typeof nested.usage === "object" &&
        nested.usage !== null &&
        (nested.usage as Record<string, unknown>)) ||
      undefined;
    const src = usageObj || o;
    const i = num(src.input_tokens) || num(src.prompt_tokens) || num(src.inputTokens);
    const out = num(src.output_tokens) || num(src.completion_tokens) || num(src.outputTokens);
    if (i || out) {
      sawUsage = true;
      // Prefer cumulative totals when present; otherwise accumulate deltas.
      inTok = Math.max(inTok, i) || inTok + i;
      outTok = Math.max(outTok, out) || outTok + out;
    }
  }

  const parsed: CodexParsed = { summary, events };
  if (sawUsage) {
    parsed.usage = {
      inputTokens: inTok,
      outputTokens: outTok,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0, // Codex CLI does not price the run — see module header.
      turns,
    };
  }
  return parsed;
}

/** Path/name of the Codex binary. Overridable for pinned installs. */
function codexBin(env: Record<string, string | undefined> = process.env): string {
  return env.CODEX_BIN?.trim() || "codex";
}

/**
 * Run one task through `codex exec`, headlessly, in `repoPath`. Streams Codex's
 * output to `onMessage` for live logs and resolves to the same TaskResult shape
 * the Claude runner returns, so the orchestrator treats both identically.
 *
 * FAIL-SOFT: a missing binary (ENOENT) or a non-zero exit resolves to a
 * `failed` result with an actionable message rather than throwing — a codex
 * misconfiguration must not crash the whole run.
 */
export async function runTaskCodex(
  task: Task,
  plan: BuildPlan,
  repoPath: string,
  onMessage?: (text: string) => void,
  integrations?: AgentIntegrations,
): Promise<TaskResult> {
  const start = Date.now();
  void integrations; // Reserved: Codex MCP wiring is not part of this first cut.
  if (task.browser) {
    onMessage?.(
      "[codex] note: task.browser is a Claude-runner (Playwright MCP) feature; " +
        "running this codex task WITHOUT the browser hookup.",
    );
  }

  const env = process.env;
  const args = buildCodexArgs(task, plan, repoPath, env);

  return await new Promise<TaskResult>((resolve) => {
    let stdoutBuf = "";
    const stderrChunks: string[] = [];
    const streamedLines: string[] = [];
    let settled = false;
    const done = (r: TaskResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    let child;
    try {
      child = spawn(codexBin(env), args, { cwd: repoPath, env });
    } catch (e) {
      return done({
        taskId: task.id,
        status: "failed",
        error: `codex spawn failed: ${(e as Error).message}`,
        durationMs: Date.now() - start,
      });
    }

    child.on("error", (e: NodeJS.ErrnoException) => {
      const hint =
        e.code === "ENOENT"
          ? " — Codex CLI not found on PATH. Install with `npm i -g @openai/codex` " +
            "(or set CODEX_BIN), and provide CODEX_API_KEY / OPENAI_API_KEY."
          : "";
      done({
        taskId: task.id,
        status: "failed",
        error: `codex error: ${e.message}${hint}`,
        durationMs: Date.now() - start,
      });
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        streamedLines.push(line);
        // Parse+stream incrementally is unnecessary; we forward text at the end
        // through parseCodexResult so summary + live logs share one code path.
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrChunks.push(chunk);
      // Codex streams progress to stderr; surface it as live log lines.
      for (const l of chunk.split("\n")) if (l.trim()) onMessage?.(l.trim());
    });

    child.on("close", (code: number | null) => {
      if (stdoutBuf.trim()) streamedLines.push(stdoutBuf);
      const parsed = parseCodexResult(streamedLines, onMessage);
      if (code === 0) {
        return done({
          taskId: task.id,
          status: "success",
          summary: parsed.summary || "(codex reported no final message)",
          durationMs: Date.now() - start,
          usage: parsed.usage,
          // Codex file writes go through its own sandboxed shell, so the
          // Write/Edit scope tracking used for Claude does not observe them.
          // A scoped codex task is handled by the orchestrator's scope gate
          // against an empty set (documented gap, same as Bash-only writes).
          filesWritten: [],
        });
      }
      const tail = stderrChunks.join("").split("\n").filter(Boolean).slice(-4).join(" | ");
      done({
        taskId: task.id,
        status: "failed",
        error: `codex exec exited ${code ?? "null"}${tail ? `: ${tail}` : ""}`,
        durationMs: Date.now() - start,
        usage: parsed.usage,
      });
    });
  });
}
