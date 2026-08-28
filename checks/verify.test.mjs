/**
 * Unit tests for the adversarial-verify pure core (harness P7): verify.ts's
 * isSensitive / parseVerdict / gateSensitiveResult, plus the parser's verify_model
 * field. Drives compiled dist/ (SDK-free). `npm test` builds dist/ first.
 *
 * The FAIL-CLOSED cases are the load-bearing ones — a sensitive task must not be
 * markable "success" without an explicit PASS on record.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIST = new URL("../dist/", import.meta.url);
const { isSensitive, parseVerdict, gateSensitiveResult, VERIFY_TRIGGERS } = await import(
  new URL("verify.js", DIST).href
);
const { validatePlan, collectPlanWarnings } = await import(new URL("parser.js", DIST).href);
const { createStateWriter } = await import(new URL("state-writer.js", DIST).href);

const ok = (over = {}) => ({ taskId: "a", status: "success", durationMs: 1, ...over });
const rec = (over = {}) => ({ passed: true, verdict: "VERDICT: PASS", findings: [], triggeredBy: ["send"], model: "opus", durationMs: 1, at: "t", ...over });

test("isSensitive triggers on the verify subset only", () => {
  assert.equal(isSensitive({ sensitivity: ["send"] }), true);
  assert.equal(isSensitive({ sensitivity: ["compliance"] }), true);
  assert.equal(isSensitive({ sensitivity: ["money"] }), false); // floors the model, but no verify pass
  assert.equal(isSensitive({ sensitivity: [] }), false);
  assert.equal(isSensitive({}), false);
  assert.ok(VERIFY_TRIGGERS.has("security") && VERIFY_TRIGGERS.has("send"));
});

test("parseVerdict is FAIL-CLOSED and truncation-safe", () => {
  // The prompt puts the verdict on the FINAL line, findings above it.
  assert.equal(parseVerdict("looks good\n- none\nVERDICT: PASS").passed, true);
  const fail = parseVerdict("- missing CAN-SPAM footer\nVERDICT: FAIL");
  assert.equal(fail.passed, false);
  assert.ok(fail.findings.includes("missing CAN-SPAM footer"));
  assert.equal(parseVerdict("the reviewer rambled and never concluded").passed, false); // no token → fail
  assert.equal(parseVerdict("VERDICT: PASS ... but also VERDICT: FAIL").passed, false); // both → fail
  assert.equal(parseVerdict("").passed, false);
  // A stray early PASS with the real verdict truncated away must FAIL-CLOSE.
  assert.equal(parseVerdict("criterion met, so VERDICT: PASS in my view, next I will check the").passed, false);
});

test("gateSensitiveResult: unflagged task is pure identity (zero behavior change)", () => {
  const r = ok();
  assert.equal(gateSensitiveResult({ sensitivity: [] }, r, undefined), r); // same reference
  assert.equal(gateSensitiveResult({}, r, undefined).status, "success");
});

test("gateSensitiveResult: a sensitive success needs a PASS on record", () => {
  const task = { sensitivity: ["send"] };
  // pass → stays success, verify attached
  const passed = gateSensitiveResult(task, ok(), rec({ passed: true }));
  assert.equal(passed.status, "success");
  assert.equal(passed.verify.passed, true);
  // fail → downgraded to failed
  const failed = gateSensitiveResult(task, ok(), rec({ passed: false, verdict: "VERDICT: FAIL" }));
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /verify did not pass/i);
  assert.ok(failed.verify);
  // NO verify record at all → failed (THE acceptance)
  const none = gateSensitiveResult(task, ok(), undefined);
  assert.equal(none.status, "failed");
  assert.match(none.error, /no verify pass on record/i);
});

test("gateSensitiveResult: an already-failed build is not re-judged", () => {
  const task = { sensitivity: ["compliance"] };
  const r = ok({ status: "failed", error: "build broke" });
  const out = gateSensitiveResult(task, r, undefined);
  assert.equal(out, r); // identity — status stays "failed", no double error
});

test("parser: verify_model is read and does not warn", () => {
  const plan = { project: { name: "x" }, tasks: [{ id: "a", prompt: "do", sensitivity: ["compliance"], verify_model: "opus" }] };
  assert.deepEqual(collectPlanWarnings(plan), []);
  assert.equal(validatePlan(plan, { quiet: true }).tasks[0].verifyModel, "opus");
});

test("persistence: a verify record reaches run-state.json and events.ndjson", () => {
  const plan = validatePlan(
    { project: { name: "x" }, tasks: [{ id: "a", phase: "1-build", prompt: "do", sensitivity: ["compliance"] }] },
    { quiet: true },
  );
  const stateDir = mkdtempSync(join(tmpdir(), "p7-state-"));
  const sw = createStateWriter({ plan, planPath: "plan.yaml", repoPath: ".", stateDir });
  const task = plan.tasks[0];
  const u = (costUsd) => ({ inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd, turns: 1 });
  const verify = { passed: true, verdict: "VERDICT: PASS", findings: [], triggeredBy: ["compliance"], model: "opus", durationMs: 5, usage: u(0.25), at: "t" };
  const result = { taskId: "a", status: "success", durationMs: 5, usage: u(0.5), verify };

  sw.handleEvent({ type: "task-start", task });
  sw.handleEvent({ type: "task-verify", task, verify });
  sw.handleEvent({ type: "task-done", task, result });

  const runState = JSON.parse(readFileSync(sw.paths.runStatePath, "utf8"));
  const t0 = runState.tasks.find((t) => t.id === "a");
  assert.equal(t0.verify.passed, true, "verify record must reach the dashboard's durable source");
  // Cost folds the verify pass's own bill into the task (0.5 build + 0.25 verify).
  assert.equal(t0.costUsd, 0.75);
  assert.equal(runState.spend.costUsd, 0.75, "spend rollup must include the verify bill");

  const events = readFileSync(sw.paths.eventsPath, "utf8");
  assert.match(events, /"type":"task-verify"/);
  assert.match(events, /"passed":true/);
});
