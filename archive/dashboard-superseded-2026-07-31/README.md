# Local dashboard — superseded 2026-07-31

This is the harness's original **local** web dashboard (`Agent Solomon - 007`),
a loopback-only Node server that loaded a plan, visualised it, observed runs
live, and could trigger runs. It is retired: The Creator's cloud **Solomon 007
cockpit** ("Mission Control") is now the one dashboard. Nothing here is deleted
— it is kept for reference and because it was the only surface that ever showed
a real run and the only place the operator write-back originally worked.

Do not wire this back up. It is superseded, not paused.

## What was moved here

| Original path | Now |
|---|---|
| `dashboard/` (README, `public/` UI, `baseline/`, `verify-ui.mjs`, screenshot) | `dashboard-superseded-2026-07-31/dashboard/` |
| `src/dashboard/` (`server.ts`, `config.ts`, `http.ts`, `load-env.ts`, `plan-analysis.ts`, `run-manager.ts`) | `dashboard-superseded-2026-07-31/src/dashboard/` |
| `start-dashboard.cmd` | `dashboard-superseded-2026-07-31/start-dashboard.cmd` |

The `dashboard` npm script (`tsc && node dist/dashboard/server.js`) was removed
from `package.json`. The `--state` flag and `src/state-writer.ts` that the local
dashboard relied on are **kept in the harness** — the cloud runner writes the
same structured run-state, so that code is not dead.

## What replaced each capability

| Local dashboard capability (`src/dashboard/server.ts`) | Cloud replacement |
|---|---|
| Plan visualisation (phases, tasks, executor split, dependency graph) | Solomon 007 cockpit — phase lanes + dependency DAG (`the-creator/services/solomon/public/index.html`) |
| Launch gate view | Cockpit's visible 6→7 gate wall |
| Live run state (`run-state.json` / `events.ndjson` tail over SSE) | Cockpit reads Firestore `runs/{runId}`, streamed via `GET /api/runs/:runId/stream` (SSE) with a 4 s poll fallback |
| Run log (harness stdout) | Cockpit live-agent strip renders each task's `lastLog` |
| Trigger dry run / real run, kill switch | `the-creator/services/solomon` — `POST /api/projects/:id/run`, `POST /api/runs/:runId/cancel`, guardrails pre-flight |
| Commits / rollback references | (not reproduced in the cloud cockpit — cloud runs are not per-task git-committed) |
| **"Provide to agents"** — `POST /api/handoff-note` (answer a blocker → appended to `BLOCKERS.md`/`GHL-SETUP.md`) | `POST /api/human-tasks/:taskId/answer` → persists on the `humanTasks` doc; the runner (`cloud-job.ts` + `src/operator-writeback.ts`) materialises it into the fresh workspace's `BLOCKERS.md`/`GHL-SETUP.md` **and** every agent's context |
| **"Provide to agents"** — `POST /api/build-files` (attach docs → `inputs/`) | `POST /api/projects/:id/inputs` → Cloud Storage under the creator bucket, keyed by project; the runner downloads them into `inputs/` at the start of each run |

The write-back was rebuilt rather than ported because a naive port is a no-op in
the cloud: the runner's `/workspace` is recreated empty on every execution, so an
answer written straight to a file there evaporates. The durable state lives
outside the container (Firestore + Cloud Storage) and is materialised in.
