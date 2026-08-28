# Local dashboard

A self-contained HTML status page for a build plan. It opens straight from
`file://` — no server, no cloud cockpit, no spend — and it follows a run,
refreshing at every milestone (the "autosave"). The human gates are surfaced up
top as plain operator instructions.

It is the local counterpart to The Creator's cloud cockpit: same shape (summary
tiles, a prominent HUMAN GATES section, a phase rail with the 6→7 launch-gate
marker, a click-to-trace task list), rendered by `src/dashboard.ts` from the
harness's own parser, so the view matches exactly what the harness will do.

## Generate a plan dashboard (no run)

```bash
ds-build <plan>.yaml --dashboard
```

Writes `builds/<name>/dashboard.html` immediately — a static preview of the plan
the parser loaded. No agent runs, no API key is needed, nothing is spent. Open
the file in a browser.

Give it a path to write somewhere else:

```bash
ds-build <plan>.yaml --dashboard docs/plan-view.html
```

Combine with `--dry-run` to also route/order the tasks without building:

```bash
ds-build <plan>.yaml --dashboard --dry-run
```

## Follow a run (the autosave)

The dashboard auto-emits and refreshes **whenever `--state` is on** — that is the
default. There is nothing extra to enable:

```bash
ds-build <plan>.yaml --state          # dashboard.html written + kept live
ds-build <plan>.yaml --state --dashboard <path>   # same, at your path
```

While a run is live the page carries a `<meta http-equiv="refresh">`, so an open
browser tab re-reads the file the harness keeps rewriting. When the run finishes,
the final write drops the refresh and the page settles.

### How the milestone refresh is wired

There is **one** source of truth. The `--state` run-state emitter
(`src/state-writer.ts`) already rewrites `run-state.json` on run start and after
every task event (start / done / deferred / skipped, and at finalize). The
dashboard is rendered from that **same snapshot, in the same `snapshot()` call** —
no parallel loop. So every gate/milestone that updates the state file also
updates `dashboard.html`, atomically (temp file + rename).

- **event:** the orchestrator's `OrchestratorEvent` stream (via the state-writer's
  `handleEvent` / `finalize`), which triggers `snapshot()`.
- **file:** `builds/<name>/dashboard.html` by default (or the `--dashboard` path).

### Where the file lives

There is one dashboard file per run:

| Flags | Path |
|---|---|
| `--dashboard` (bare) or `--state` | `builds/<name>/dashboard.html` |
| `--dashboard <path>` | `<path>` |

Default-on-with-`--state` is the documented choice: if you already asked for run
state, you already want a view of it, and coupling them keeps a single file and a
single event loop. `--state` behaviour is otherwise unchanged; without `--state`
(and without `--dashboard`) nothing new is written and the harness behaves exactly
as before.

> Note: unlike `run-state.json` (which the state writer keeps in
> `<out>/.ds-runs/<name>/`, outside the build repo), the dashboard defaults to
> inside `builds/<name>/`, matching the `--dashboard` flag's documented default.
> If `commit_after_each_task` is on and you don't want the generated view captured
> by the rollback commits, point `--dashboard` at a path outside the build folder.

## Human gates carry instructions

Every task whose `executor` is not `agent` (a `human` or `ghl` task) is always
listed in the HUMAN GATES section, whether or not a run is in progress. Each gate
shows, in run order:

- its **title** and phase,
- the task **brief, rendered as the instruction** ("what to do"),
- **acceptance** as "Done when:",
- **waits on** (dependency count) and **unblocks** (dependent count),
- and, during a run, its live status.

These are the only steps the harness will not do on its own; in a run each is also
recorded to `BLOCKERS.md` (human) or `GHL-SETUP.md` (ghl).

## Task states

With run state, each task shows one of: **pending**, **running**, **built**,
**deferred**, **skipped**, **failed**. Click any task to trace its dependency
chain — green = what it waits on, amber = what waits on it.

## Resume artifact — STATUS.md

`--status [path]` (and, like the dashboard, `--state` implicitly) emits a
Markdown **STATUS.md** off the *same* per-event snapshot — a durable, human-
readable resume point: where to pick up (next-actionable tasks), the last task's
summary, what a human still owns (each gate + the doc it was recorded to), any
failures, the launch-gate state, and a per-phase table.

Unlike the HTML dashboard, STATUS.md defaults to the **state dir** (outside
`builds/<name>/`), so `commit_after_each_task` never sweeps it into the product
repo. Pass an explicit `--status <path>` to place it in-repo on purpose. Its
timestamp comes from the snapshot (`run.updatedAt`), so re-rendering the same
snapshot is byte-identical — clean diffs if you do commit it.
