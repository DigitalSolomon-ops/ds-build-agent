import { isAbsolute, relative } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { BuildPlan, Task, TaskResult, TaskUsage, VerifyRecord } from "./types.js";
import { explainModel } from "./model.js";
import { normalizePath } from "./scope.js";
import { parseVerdict, verifyTriggers } from "./verify.js";
import { sharedContext, taskPrompt } from "./prompt.js";
import { composeAgentIntegrations, type AgentIntegrations } from "./integrations.js";

// AgentIntegrations moved to integrations.ts (SDK-free, shared with the Codex
// runner). Re-exported here so existing importers (orchestrator.ts) are unaffected.
export type { AgentIntegrations };

/**
 * Pull a repo-relative written path out of a Write/Edit tool_use block, for
 * scope enforcement (scope.ts). Returns undefined for any other tool or a
 * malformed block. A path outside the repo normalizes to a `../…` form, which
 * no in-repo scope glob matches — so an out-of-repo write reads as a violation,
 * exactly as intended.
 */
function writtenPath(block: unknown, repoPath: string): string | undefined {
  if (typeof block !== "object" || block === null) return undefined;
  const b = block as { type?: unknown; name?: unknown; input?: unknown };
  if (b.type !== "tool_use") return undefined;
  if (b.name !== "Write" && b.name !== "Edit") return undefined;
  const input = b.input as { file_path?: unknown } | undefined;
  const fp = input?.file_path;
  if (typeof fp !== "string" || !fp.trim()) return undefined;
  return normalizePath(isAbsolute(fp) ? relative(repoPath, fp) : fp);
}

/** Tools each build agent is allowed to use without prompting. */
const BUILD_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];

/** Default model for an adversarial verify pass — stronger than the build tier. */
const VERIFY_MODEL = "opus";

/**
 * Read tokens and dollars off the SDK's terminal `result` message.
 *
 * Both branches of SDKResultMessage — `subtype: "success"` and the error
 * subtypes — carry `usage` and `total_cost_usd`, which is the whole reason
 * this is read before the success/failure branch below: a task that burns
 * sixty turns and then fails still spent the money, and a cost report that
 * omits failures is not a cost report.
 *
 * Every field is coerced defensively. A future SDK that renames or nulls one
 * of these should degrade to 0 for that field, never to NaN, which would
 * poison every sum downstream.
 */
function readUsage(message: {
  usage?: Record<string, unknown>;
  total_cost_usd?: number;
  num_turns?: number;
}): TaskUsage {
  const u = message.usage ?? {};
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadInputTokens: num(u.cache_read_input_tokens),
    cacheCreationInputTokens: num(u.cache_creation_input_tokens),
    costUsd: num(message.total_cost_usd),
    turns: num(message.num_turns),
  };
}

/**
 * Run one task to completion in the target repo, headlessly.
 * Streams the agent's messages to `onMessage` (for live logging) and
 * resolves to a structured result.
 */
export async function runTask(
  task: Task,
  plan: BuildPlan,
  repoPath: string,
  onMessage?: (text: string) => void,
  integrations?: AgentIntegrations,
): Promise<TaskResult> {
  const start = Date.now();
  // Resolve the model, flooring it up when the task's sensitivity demands it.
  const decision = explainModel(task, plan);
  const model = decision.resolved;
  if (decision.escalated) {
    console.error(
      `[model] escalated ${decision.base} -> ${decision.resolved} for "${task.id}" ` +
        `(sensitivity: ${decision.tags.join(", ")})`,
    );
  }
  // Declared outside the try so a throw after the result message still
  // reports what was already spent.
  let usage: TaskUsage | undefined;
  // Repo-relative files this task wrote via Write/Edit, for scope enforcement.
  const filesWritten = new Set<string>();

  // Fold in the headless browser (Playwright MCP) when the task opts in, so a
  // browser task can navigate/click/fill while an ordinary code task never
  // boots Chromium. One seam (integrations.ts) decides this for both runners.
  const eff = composeAgentIntegrations(integrations, task);

  try {
    let finalSummary = "";
    for await (const message of query({
      prompt: taskPrompt(task),
      options: {
        cwd: repoPath,
        model,
        systemPrompt: { type: "preset", preset: "claude_code", append: sharedContext(plan) },
        allowedTools: [...BUILD_TOOLS, ...(eff?.extraAllowedTools ?? [])],
        permissionMode: "acceptEdits",
        maxTurns: 60,
        ...(eff?.mcpServers ? { mcpServers: eff.mcpServers } : {}),
      },
    })) {
      // Surface the assistant's streamed text for live logs, and record any
      // file the agent wrote (Write/Edit) so scope.ts can gate against it.
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && onMessage) onMessage(block.text);
          const wrote = writtenPath(block, repoPath);
          if (wrote) filesWritten.add(wrote);
        }
      }
      // The terminal `result` message carries the final outcome — and the bill.
      if (message.type === "result") {
        usage = readUsage(message);
        if (message.subtype === "success") {
          finalSummary = message.result ?? "";
        } else {
          return {
            taskId: task.id,
            status: "failed",
            error: `Agent ended with subtype "${message.subtype}".`,
            durationMs: Date.now() - start,
            usage,
          };
        }
      }
    }

    return {
      taskId: task.id,
      status: "success",
      summary: finalSummary,
      durationMs: Date.now() - start,
      usage,
      filesWritten: [...filesWritten],
    };
  } catch (e) {
    return {
      taskId: task.id,
      status: "failed",
      error: (e as Error).message,
      durationMs: Date.now() - start,
      usage,
    };
  }
}

/** The adversarial reviewer prompt: try to REFUTE the done-claim, fail-closed. */
function verifyPrompt(task: Task): string {
  const acceptance =
    (task.acceptance ?? []).map((a) => `  - ${a}`).join("\n") ||
    "  (none stated explicitly — judge against the brief)";
  return [
    `You are an ADVERSARIAL REVIEWER. A build agent has just reported task "${task.id}" as DONE.`,
    `Your job is to try to REFUTE that claim, not to help. You are READ-ONLY: do NOT modify, create,`,
    `or delete any file (no Write/Edit; do not write via Bash redirection either).`,
    ``,
    `The task's brief:`,
    task.brief,
    ``,
    `Acceptance criteria to check against:`,
    acceptance,
    ``,
    `Inspect the ACTUAL repository state (read files, grep, run the test/build read-only) and decide`,
    `whether EVERY acceptance criterion is genuinely met. Be skeptical: a plausible-looking change`,
    `that does not actually satisfy an acceptance criterion is a FAIL.`,
    ``,
    `List each concrete issue as a "- " bullet (write "- none" if clean), then end with EXACTLY ONE`,
    `final line, one of:`,
    `  VERDICT: PASS   (only if every criterion is genuinely met)`,
    `  VERDICT: FAIL   (if any criterion is unmet, unverifiable, or you are unsure)`,
    `If you cannot positively confirm a PASS for ANY reason, you MUST answer VERDICT: FAIL.`,
  ].join("\n");
}

/**
 * Adversarially verify a sensitive task after its build agent reported success.
 * A SECOND, READ-ONLY agent (Write/Edit withheld so it judges rather than
 * silently fixing), defaulting to opus. FAIL-CLOSED: any error, timeout, or
 * missing verdict yields a not-passed record.
 */
export async function runVerify(
  task: Task,
  plan: BuildPlan,
  repoPath: string,
  onMessage?: (text: string) => void,
  integrations?: AgentIntegrations,
): Promise<VerifyRecord> {
  const start = Date.now();
  const model = task.verifyModel ?? VERIFY_MODEL;
  let usage: TaskUsage | undefined;
  let finalText = "";
  try {
    for await (const message of query({
      prompt: verifyPrompt(task),
      options: {
        cwd: repoPath,
        model,
        systemPrompt: { type: "preset", preset: "claude_code", append: sharedContext(plan) },
        // Read-only: NO Write/Edit. Bash stays for tests/greps.
        allowedTools: ["Read", "Grep", "Glob", "Bash", ...(integrations?.extraAllowedTools ?? [])],
        permissionMode: "acceptEdits",
        maxTurns: 30,
        ...(integrations?.mcpServers ? { mcpServers: integrations.mcpServers } : {}),
      },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && onMessage) onMessage(block.text);
        }
      }
      if (message.type === "result") {
        usage = readUsage(message);
        if (message.subtype === "success") finalText = message.result ?? "";
      }
    }
  } catch (e) {
    return {
      passed: false,
      verdict: `verify errored: ${(e as Error).message}`,
      findings: [],
      triggeredBy: verifyTriggers(task),
      model,
      durationMs: Date.now() - start,
      usage,
      at: new Date().toISOString(),
    };
  }
  const parsed = parseVerdict(finalText);
  return {
    passed: parsed.passed,
    verdict: parsed.verdict,
    findings: parsed.findings,
    triggeredBy: verifyTriggers(task),
    model,
    durationMs: Date.now() - start,
    usage,
    at: new Date().toISOString(),
  };
}
