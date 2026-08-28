/**
 * Unit tests for the STATUS.md resume renderer (harness P9). Drives compiled
 * dist/status.js against examples/plan-template.yaml + synthetic run-states.
 * `npm test` builds dist/ first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const DIST = new URL("../dist/", import.meta.url);
const { renderStatus } = await import(new URL("status.js", DIST).href);
const { loadPlan } = await import(new URL("parser.js", DIST).href);

const plan = loadPlan(new URL("../examples/plan-template.yaml", import.meta.url), { quiet: true });
const isAscii = (s) => /^[\x00-\x7F]*$/.test(s);
const resumeOf = (md) => md.split("## Resume")[1].split("\n## ")[0];

test("1. plan-only STATUS.md is resume-shaped Markdown", () => {
  const md = renderStatus(plan);
  assert.ok(md.startsWith("# "));
  assert.match(md, /my-new-build/);
  assert.match(md, /## Resume/);
  assert.match(md, /Human gates/);
  assert.ok(md.length > 300);
});

test("2. STATUS.md is ASCII-only (plan-only and live)", () => {
  assert.ok(isAscii(renderStatus(plan)), "plan-only ascii");
  const rs = { run: { status: "running", updatedAt: 1700000000000 }, totals: { total: 7, built: 1 }, tasks: [{ id: "validate-plan", state: "built", summary: "done" }] };
  assert.ok(isAscii(renderStatus(plan, rs)), "live ascii");
});

test("3. renderer is deterministic in plan-only mode (no wall-clock)", () => {
  assert.equal(renderStatus(plan), renderStatus(plan));
});

test("4. idempotent regen from a FIXED snapshot is byte-identical", () => {
  const rs = { run: { status: "running", updatedAt: 1700000000000 }, totals: { total: 7, built: 2 }, tasks: [{ id: "validate-plan", state: "built" }, { id: "scaffold", state: "built" }] };
  assert.equal(renderStatus(plan, rs), renderStatus(plan, rs));
});

test("5. live overlay reflects per-task state (built/summary, failed/error, deferred gates+docs)", () => {
  const rs = {
    run: { status: "running", updatedAt: 1700000000000 },
    totals: { total: 7, built: 1, failed: 1, deferred: 2, running: 1 },
    tasks: [
      { id: "validate-plan", state: "built", summary: "scaffolded parser check" },
      { id: "scaffold", state: "running" },
      { id: "backend-proxy", state: "failed", error: "boom" },
      { id: "crm-fields", state: "deferred", doc: "GHL-SETUP.md" },
      { id: "dns-cutover", state: "deferred", doc: "BLOCKERS.md" },
    ],
  };
  const md = renderStatus(plan, rs);
  assert.match(md, /scaffolded parser check/); // last-completed summary
  assert.match(md, /## Failed/);
  assert.match(md, /backend-proxy/);
  assert.match(md, /boom/);
  assert.match(md, /GHL-SETUP\.md/);
  assert.match(md, /BLOCKERS\.md/);
  assert.match(md, /Progress/);
});

test("6. Resume names the next-actionable task, not a blocked one", () => {
  const rs = { run: { status: "running", updatedAt: 1 }, tasks: [{ id: "validate-plan", state: "built" }] };
  const resume = resumeOf(renderStatus(plan, rs));
  assert.match(resume, /scaffold/); // dep validate-plan is built
  assert.ok(!/qa-sweep/.test(resume)); // its deps are not resolved
});

test("7. a deferred dep counts as RESOLVED and unblocks its dependent", () => {
  const rs = { run: { status: "running", updatedAt: 1 }, tasks: [{ id: "validate-plan", state: "built" }, { id: "scaffold", state: "deferred" }] };
  const resume = resumeOf(renderStatus(plan, rs));
  assert.match(resume, /landing-page/); // its only dep (scaffold) is deferred = resolved
});

test("8. a completed run shows nothing actionable", () => {
  const rs = {
    run: { status: "complete", updatedAt: 1 },
    totals: { total: 7, built: 5, deferred: 2 },
    tasks: plan.tasks.map((t) => ({ id: t.id, state: t.executor === "agent" ? "built" : "deferred" })),
  };
  assert.match(renderStatus(plan, rs), /Run complete/);
});

test("9. a held launch gate is surfaced, referencing phase 7", () => {
  const rs = { run: { status: "running", updatedAt: 1 }, gate: { enabled: true, open: false, heldByHumanSignoff: true }, tasks: [] };
  const md = renderStatus(plan, rs);
  assert.match(md, /## Launch gate/);
  assert.match(md, /HELD/);
  assert.match(md, /7/);
});
