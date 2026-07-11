# ds-build dashboard

A local, single-user web dashboard for the `ds-build-agent` harness. It **loads
a YAML plan and visualizes it**, **observes runs live**, and can **trigger runs**
(dry-run by default; a real run needs explicit confirmation).

It is additive: the harness runs exactly as before without it. The only harness
change it relies on is an **opt-in `--state` flag** (see below), which is off by
default and leaves the harness's normal behavior and output byte-for-byte
identical.

## Run it

```powershell
cd C:\Users\marcu\ds-build-agent
npm install
npm run dashboard          # tsc + node dist/dashboard/server.js
```

Then open **http://127.0.0.1:4317**. The server binds to loopback only.

Environment:

- `ANTHROPIC_API_KEY` — required only to start a **real** run (agent tasks call
  the API). Dry runs need nothing. The dashboard shows whether the key is set,
  never its value.
- `DS_BUILDS_ROOT` — where builds live. Default `C:\Users\marcu\ds-builds`
  (deliberately **outside** this repo — see "Builds location" below).
- `DS_DASHBOARD_PORT` — default `4317`.

## What it shows

- **Plan structure** — phases in order, tasks per phase, dependencies, and the
  three executor types visually separated: `agent` (built), `human`
  (→ `BLOCKERS.md`), `ghl` (→ `GHL-SETUP.md`).
- **Dependency graph** — a layered DAG; click a node to highlight its ancestors
  and dependents.
- **Launch gate** — whether the gated phase is blocked and which gate tasks
  hold it (including a human sign-off that keeps it closed autonomously).
- **Live run** — per-task status (pending / running / built / deferred /
  skipped / failed), active phase, concurrency slots in use, overall and
  per-phase progress, and the built/deferred/skipped/failed tallies that match
  the harness's own result line.
- **Run log** — the harness's stdout/stderr, streamed.
- **Reports & handoffs** — the `.md` files in the build folder, rendered inline
  (`BLOCKERS.md` / `GHL-SETUP.md` are flagged as harness-authored).
- **Commits** — when `commit_after_each_task` is on, each built task links to its
  commit as a rollback reference.

## Triggering runs

- **Dry run is the default** and the primary action — it costs nothing and
  writes nothing.
- A **real run** requires an explicit confirm step that shows exactly what will
  run (task scope, build folder, how many agent tasks call the API) and warns
  about cost.
- Task scope maps to `--only`; concurrency maps to `--concurrency`.
- Only **one active run per build folder**; a second is refused.
- **Stop** kills the run's whole process tree.

## How live state works

The dashboard spawns the harness with an opt-in **`--state <dir>`** flag
(`src/state-writer.ts`). When set, the harness writes — in a directory *outside*
the build repo — two files the dashboard reads:

- `run-state.json` — an atomic snapshot (per-task state, phases, gate,
  concurrency, tallies), rewritten on every event.
- `events.ndjson` — an append-only event log.

The dashboard streams the harness's stdout as the human-readable log and tails
these files for structured state, pushing both to the browser over SSE. Without
`--state`, the harness behaves exactly as it always did.

## Builds location (important)

The harness's `commit_after_each_task` gives each build folder its own git repo
for rollback. That assumes the build folder is **not nested inside another git
repo** — if it is, commits would land in the parent. Two things keep this safe:

1. The dashboard always spawns runs with `--out C:\Users\marcu\ds-builds`
   (outside this repo).
2. `gitCommit` initializes a repo in the **build folder itself** (checking for
   its own `.git` rather than an ancestor), so even a nested build folder keeps
   its commits local.

If you run the **CLI** directly, prefer `--out C:\Users\marcu\ds-builds` too.

## Verify

```powershell
npm run build
node dashboard/verify-ui.mjs   # drives system Edge through a dry run (Playwright)
```

`verify-ui.mjs` loads the FastIG plan, runs a dry build, and asserts the
visualization (task counts, executor split, gate blocked, per-state tallies,
live log, confirm-modal guardrail). It never triggers a paid run.

## Security posture

Loopback-only bind; the harness is spawned with an **args array** and
`shell:false` (no shell, ever); plan paths must be existing `.yaml` files;
`--only` ids must exist in the parsed plan; concurrency is bounded `[1, 16]`;
file serving is `.md`-only and path-traversal guarded; a real run needs an
explicit confirmation flag and an API key.
