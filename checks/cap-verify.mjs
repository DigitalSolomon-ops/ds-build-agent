/**
 * B2 — per-run cost abort. Drives the COMPILED dist/orchestrator.js to prove the
 * cap brake halts dispatch: once capReached() trips, no further task starts and
 * every remaining task comes back skipped with the cap reason. Uses dryRun so no
 * agent, no API, no cost — capReached is driven by a synthetic accumulator that
 * mirrors what cloud-job does (sum task-done cost, compare to the cap).
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// Self-locating: dist/ is one level up from this checks/ directory.
const DIST = new URL("../dist/", import.meta.url);
const { orchestrate } = await import(new URL("orchestrator.js", DIST).href);

const task = (id, deps = []) =>
  ({ id, title: `Task ${id}`, brief: "x", executor: "agent", auto: true, phase: "1", deps, outputs: [], acceptance: [] });
// Linear chain so tasks run strictly one at a time at concurrency 1.
const chain = (n) => Array.from({ length: n }, (_, i) => task(`t${i + 1}`, i ? [`t${i}`] : []));
const plan = (tasks) => ({ name: "cap-test", policy: { commitAfterEachTask: false }, tasks });

const CAP_REASON = "Run cost cap reached — dispatch halted.";
const checks = [];
const check = (name, ok) => checks.push([name, !!ok]);

// ── Case A: cap trips after 2 tasks — the rest must be skipped, none dispatched ──
{
  const starts = [];
  let done = 0;
  const CAP = 2;                       // synthetic: "cost" of 1 per task, cap at 2
  let spent = 0;
  const results = await orchestrate(plan(chain(5)), {
    repoPath: mkdtempSync(join(tmpdir(), "ds-cap-")),
    concurrency: 1,
    dryRun: true,
    capReached: () => spent >= CAP,
    onEvent: (e) => {
      if (e.type === "task-start") starts.push(e.task.id);
      if (e.type === "task-done") { done++; spent += 1; }   // each task "costs" 1
    },
  });
  const built = results.filter((r) => r.status === "success").length;
  const skipped = results.filter((r) => r.status === "skipped");
  const cappedSkips = skipped.filter((r) => r.error === CAP_REASON);
  check("A: exactly 2 tasks dispatched before the cap", starts.length === 2);
  check("A: 2 built, 3 skipped", built === 2 && skipped.length === 3);
  check("A: all 3 skips carry the cap reason", cappedSkips.length === 3);
  check("A: no task started after the cap tripped", starts.every((id) => ["t1", "t2"].includes(id)));
}

// ── Case B: cap never trips — the run completes normally, nothing skipped ──
{
  const results = await orchestrate(plan(chain(5)), {
    repoPath: mkdtempSync(join(tmpdir(), "ds-cap-")),
    concurrency: 1,
    dryRun: true,
    capReached: () => false,
    onEvent: () => {},
  });
  check("B: under cap — all 5 built, none skipped",
    results.filter((r) => r.status === "success").length === 5 &&
    results.every((r) => r.status !== "skipped"));
}

// ── Case C: no capReached hook at all — behaviour unchanged (backward compat) ──
{
  const results = await orchestrate(plan(chain(3)), {
    repoPath: mkdtempSync(join(tmpdir(), "ds-cap-")),
    concurrency: 1,
    dryRun: true,
    onEvent: () => {},
  });
  check("C: no cap hook — all 3 built (unchanged behaviour)",
    results.filter((r) => r.status === "success").length === 3);
}

console.log("=== checks ===");
let pass = 0;
for (const [name, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`); if (ok) pass++; }
console.log(`\n${pass}/${checks.length} checks passed`);
process.exit(pass === checks.length ? 0 : 1);
