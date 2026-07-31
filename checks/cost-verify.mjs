/**
 * Task 3 — cost verification. Drives the COMPILED dist/state-writer.js through
 * three synthetic runs and checks the `spend` field in run-state.json AND in
 * the run-end event, against the brief's table. No agents, no API, no cost.
 *
 * The one that matters: case 2 (no usage) must leave `spend` ABSENT — not 0,
 * not {}. An absent field is what lets spendToday() keep the launch estimate
 * instead of a confident, wrong $0.00.
 */
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Self-locating: dist/ is one level up from this checks/ directory, so the
// driver runs from its committed path on any machine (no absolute path).
const DIST = new URL("../dist/", import.meta.url);
const { createStateWriter } = await import(new URL("state-writer.js", DIST).href);

const usage = (costUsd, tin = 0, tout = 0) => ({
  inputTokens: tin, outputTokens: tout,
  cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
  costUsd, turns: 1,
});
const task = (id, executor, phase = "1-build") =>
  ({ id, title: `Task ${id}`, brief: "x", executor, auto: executor === "agent", phase, deps: [], outputs: [] });
const plan = (tasks) => ({
  name: "cost-verify", description: "synthetic", stack: [], conventions: [],
  policy: { commitAfterEachTask: false }, tasks,
});

function run(label, tasks, events, results) {
  const stateDir = mkdtempSync(join(tmpdir(), "ds-cost-"));
  const w = createStateWriter({
    plan: plan(tasks), planPath: "synthetic.yaml", repoPath: stateDir,
    stateDir, concurrency: 1, dryRun: false, startedAt: Date.now(),
  });
  for (const e of events) w.handleEvent(e);
  w.finalize(results);

  const runState = JSON.parse(readFileSync(w.paths.runStatePath, "utf8"));
  const lines = readFileSync(w.paths.eventsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const runEnd = lines.find((l) => l.type === "run-end");
  return {
    label,
    stateHasSpendKey: Object.prototype.hasOwnProperty.call(runState, "spend") && runState.spend !== undefined,
    stateSpend: runState.spend,
    endHasSpendKey: Object.prototype.hasOwnProperty.call(runEnd, "spend") && runEnd.spend !== undefined,
    endSpend: runEnd.spend,
  };
}

const cases = [];

// ── Case 1: two agent tasks report usage (one failed), one human deferred ──
{
  const tasks = [task("a1", "agent"), task("a2", "agent"), task("h1", "human")];
  const events = [
    { type: "task-start", task: tasks[0] },
    { type: "task-done", task: tasks[0], result: { taskId: "a1", status: "success", durationMs: 10, usage: usage(1.2345, 1000, 500) } },
    { type: "task-start", task: tasks[1] },
    { type: "task-done", task: tasks[1], result: { taskId: "a2", status: "failed", error: "boom", durationMs: 20, usage: usage(0.6, 800, 200) } },
    { type: "task-deferred", task: tasks[2], doc: "BLOCKERS.md" },
  ];
  const results = [
    { taskId: "a1", status: "success", durationMs: 10, usage: usage(1.2345, 1000, 500) },
    { taskId: "a2", status: "failed", error: "boom", durationMs: 20, usage: usage(0.6, 800, 200) },
    { taskId: "h1", status: "deferred", durationMs: 0 },
  ];
  cases.push(run("case1 (2 agent incl. failed + 1 deferred)", tasks, events, results));
}

// ── Case 2: no task reports usage ──
{
  const tasks = [task("h1", "human"), task("g1", "ghl")];
  const events = [
    { type: "task-deferred", task: tasks[0], doc: "BLOCKERS.md" },
    { type: "task-deferred", task: tasks[1], doc: "GHL-SETUP.md" },
  ];
  const results = [
    { taskId: "h1", status: "deferred", durationMs: 0 },
    { taskId: "g1", status: "deferred", durationMs: 0 },
  ];
  cases.push(run("case2 (no usage — must be ABSENT)", tasks, events, results));
}

// ── Case 3: one task reports costUsd: 0 ──
{
  const tasks = [task("a1", "agent")];
  const events = [
    { type: "task-start", task: tasks[0] },
    { type: "task-done", task: tasks[0], result: { taskId: "a1", status: "success", durationMs: 5, usage: usage(0, 0, 0) } },
  ];
  const results = [{ taskId: "a1", status: "success", durationMs: 5, usage: usage(0, 0, 0) }];
  cases.push(run("case3 (one task costUsd:0)", tasks, events, results));
}

// ── report + assert ──
const checks = [];
const c1 = cases[0];
checks.push(["case1 run-state spend present", c1.stateHasSpendKey === true]);
checks.push(["case1 run-state costUsd == 1.8345", c1.stateSpend?.costUsd === 1.8345]);
checks.push(["case1 run-state tasksReportingUsage == 2", c1.stateSpend?.tasksReportingUsage === 2]);
checks.push(["case1 run-end spend present", c1.endHasSpendKey === true]);
checks.push(["case1 run-end costUsd == 1.8345 (incl. failed)", c1.endSpend?.costUsd === 1.8345]);
checks.push(["case1 run-end tasksReportingUsage == 2", c1.endSpend?.tasksReportingUsage === 2]);

const c2 = cases[1];
checks.push(["case2 run-state spend ABSENT (not 0, not {})", c2.stateHasSpendKey === false]);
checks.push(["case2 run-end spend ABSENT (not 0, not {})", c2.endHasSpendKey === false]);

const c3 = cases[2];
checks.push(["case3 run-state spend present, costUsd == 0", c3.stateHasSpendKey === true && c3.stateSpend?.costUsd === 0]);
checks.push(["case3 run-state tasksReportingUsage == 1", c3.stateSpend?.tasksReportingUsage === 1]);
checks.push(["case3 run-end spend present, costUsd == 0", c3.endHasSpendKey === true && c3.endSpend?.costUsd === 0]);
checks.push(["case3 run-end tasksReportingUsage == 1", c3.endSpend?.tasksReportingUsage === 1]);

console.log("\n=== raw spend values ===");
for (const c of cases) {
  console.log(`\n[${c.label}]`);
  console.log("  run-state.spend:", JSON.stringify(c.stateSpend ?? "(absent)"));
  console.log("  run-end.spend:  ", JSON.stringify(c.endSpend ?? "(absent)"));
}

console.log("\n=== checks ===");
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} checks passed`);
process.exit(pass === checks.length ? 0 : 1);
