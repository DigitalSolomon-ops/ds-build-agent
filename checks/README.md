# checks/ — verification drivers

Framework-free Node scripts that assert the harness's load-bearing invariants —
the subtle ones someone will break without realising they were holding weight.
No test runner, by design (the no-new-test-runner rule forbids a *framework*, not
plain scripts). Each is an `.mjs` run directly by `node`, exits `0` on pass and
non-zero on failure, and drives the **compiled** `dist/` — so build first.

## Run

```bash
npm run build          # compile src/ -> dist/ (the drivers import dist/, not src/)
node checks/cost-verify.mjs
node checks/cap-verify.mjs
node checks/writeback-verify.mjs
```

Each locates `dist/` relative to itself (`../dist/`), so it runs from any checkout
without a machine-specific path.

## What each proves

### `cost-verify.mjs` — 12 checks
Drives `dist/state-writer.js` through three synthetic runs and checks the `spend`
field in both `run-state.json` and the `run-end` event:

| Case | Expected `spend` |
|---|---|
| Two agent tasks report usage (one failed) + one deferred | present; `costUsd` sums **both** agent tasks incl. the failed one; `tasksReportingUsage: 2` |
| **No task reports usage** | **ABSENT — not `0`, not `{}`** |
| One task reports `costUsd: 0` | present, `costUsd: 0`, `tasksReportingUsage: 1` |

**The load-bearing invariant: a run where no task reported usage must leave `spend`
ABSENT, never `0`.** `spendToday()` (in the-creator's `guardrails.ts`) accounts a
run as `costUsd ?? estCostUsd ?? 0`. A confident `0` from the rollup would beat
the launch-time estimate and **silently erase the run from the daily spend cap** —
absent means "unknown, keep the estimate"; zero means "this run was genuinely
free". They are different facts and must stay distinguishable. If someone
"tidies" the rollup to default to `0`, this driver fails on case 2 — that failure
is the point.

### `cap-verify.mjs` — 6 checks
Drives `dist/orchestrator.js` to prove the per-run cost brake (B2): once
`capReached()` trips, dispatch halts — the tasks already started are the only ones
that ran, every remaining task comes back `skipped` with the cap reason, and
nothing starts after the cap. Also confirms an under-cap run completes normally
and that omitting the hook leaves behaviour unchanged (backward-compatible).

### `writeback-verify.mjs` — 13 checks
Drives `dist/operator-writeback.js` and `dist/agent.js` to prove operator answers
materialise into `BLOCKERS.md` / `GHL-SETUP.md` in the exact blockquote format of
the retired local endpoint (routed by source), that the assembled context lists
answers + attachments, and — the crux — that the context actually reaches an agent
via `sharedContext()`. Attachment filenames cannot escape their prefix.

## Note
These drive `dist/`. After changing `src/`, rebuild before trusting a pass.
