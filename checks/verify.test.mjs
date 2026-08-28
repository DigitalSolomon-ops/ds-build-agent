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

const DIST = new URL("../dist/", import.meta.url);
const { isSensitive, parseVerdict, gateSensitiveResult, VERIFY_TRIGGERS } = await import(
  new URL("verify.js", DIST).href
);
const { validatePlan, collectPlanWarnings } = await import(new URL("parser.js", DIST).href);

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

test("parseVerdict is FAIL-CLOSED", () => {
  assert.equal(parseVerdict("looks good\nVERDICT: PASS\n- none").passed, true);
  const fail = parseVerdict("VERDICT: FAIL\n- missing CAN-SPAM footer");
  assert.equal(fail.passed, false);
  assert.ok(fail.findings.includes("missing CAN-SPAM footer"));
  assert.equal(parseVerdict("the reviewer rambled and never concluded").passed, false); // no token → fail
  assert.equal(parseVerdict("VERDICT: PASS ... but also VERDICT: FAIL").passed, false); // both → fail
  assert.equal(parseVerdict("").passed, false);
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
