/**
 * Adversarial verification of sensitive tasks (harness P7). SDK-FREE and pure —
 * the runtime hook (a read-only reviewer agent) lives in agent.ts/orchestrator.ts;
 * everything decision-shaped is here so it is unit-testable without the SDK.
 *
 * The safety property is FAIL-CLOSED: a sensitive task can only stay "success" if
 * an explicit PASS verdict was parsed. A truncated, errored, or absent verify
 * reads as failure — which, because success is also the precondition for the
 * rollback commit and for unblocking dependents, automatically stops both.
 */
import type { Task, TaskResult, VerifyRecord } from "./types.js";

/**
 * The sensitivity tags that TRIGGER an adversarial verify pass — a subset of the
 * shared `sensitivity` vocabulary (model.ts SENSITIVITY_FLOOR is the full set used
 * for model escalation). A task flagged only with, say, "money" is floored up but
 * not verified; "compliance"/"security"/"send" get both.
 */
export const VERIFY_TRIGGERS: ReadonlySet<string> = new Set(["security", "compliance", "send"]);

/** The task's sensitivity tags that fall in the verify-trigger set. */
export function verifyTriggers(task: Task): string[] {
  return (task.sensitivity ?? []).filter((t) => VERIFY_TRIGGERS.has(t));
}

/** True when the task carries at least one verify-triggering sensitivity tag. */
export function isSensitive(task: Task): boolean {
  return verifyTriggers(task).length > 0;
}

/**
 * Parse a verifier's output into a verdict. FAIL-CLOSED: `passed` is true only
 * when an explicit `VERDICT: PASS` is present AND no `VERDICT: FAIL` co-occurs.
 * No token at all → not passed.
 */
export function parseVerdict(text: string): { passed: boolean; verdict: string; findings: string[] } {
  const s = String(text || "");
  const hasPass = /VERDICT:\s*PASS/i.test(s);
  const hasFail = /VERDICT:\s*FAIL/i.test(s);
  const passed = hasPass && !hasFail;
  const line = s.match(/VERDICT:\s*(PASS|FAIL)[^\n]*/i);
  const verdict = line ? line[0].trim() : "no VERDICT token found";
  const findings = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter((f) => f.length > 0 && !/^none\.?$/i.test(f));
  return { passed, verdict, findings };
}

/**
 * The gate. Acts ONLY on a sensitive task whose build succeeded — for everything
 * else it returns the result unchanged (identity), so an unflagged task's path is
 * byte-for-byte what it was before P7 existed. A sensitive success stays success
 * only if `verify.passed`; otherwise it is downgraded to "failed" with the verdict
 * as the error, which skips the post-success commit and poisons dependents.
 */
export function gateSensitiveResult(
  task: Task,
  result: TaskResult,
  verify: VerifyRecord | undefined,
): TaskResult {
  if (!isSensitive(task) || result.status !== "success") return result;
  if (verify?.passed) return { ...result, verify };
  return {
    ...result,
    status: "failed",
    verify,
    error: `Adversarial verify did not pass: ${verify?.verdict ?? "no verify pass on record"}`,
  };
}
