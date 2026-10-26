# Apply pack: solomon-airspace (phase 7, human, behind the launch gate)

Phases 1-6 are built and tested on branch `feat/solomon-airspace` in two repos:

| Repo | Branch | Base |
|---|---|---|
| `ds-build-agent` | `feat/solomon-airspace` | `master` |
| `the-creator` | `feat/solomon-airspace` | `main` (NOT `local-builds-launch-gate`, see step 1) |

Nothing is deployed, nothing is merged, and no IAM or Firestore rule was changed.
The `ds-build` CLI installed on blacktop was rebuilt from `master`, so it behaves
exactly as before until you merge. Design and decisions: `docs/AIRSPACE.md`.

Do these in order. Each step says how to check it worked.

## 1. Merge the-creator branch (coordinate with the open launch-gate branch)

Another agent had `local-builds-launch-gate` (WIP, "safety commit") checked out in
`the-creator` while this was built. Both branches edit
`services/solomon/src/server.ts`, `services/solomon/public/local/index.html` and
`packages/shared/src/types.ts`. Every change on `feat/solomon-airspace` is an addition
(new routes, new card, new optional fields), so expect small, mechanical conflicts.
Merge whichever lands second carefully; keep both sets of routes.

Check: `cd the-creator; npm run build` succeeds, and
`ds-build-agent`'s parity test passes (step 2).

## 2. Merge ds-build-agent and rebuild

```powershell
cd C:\Users\marcu\Projects\portfolios\internal-tools\ds-build-agent
git checkout master; git merge feat/solomon-airspace
npm test        # expect: pass 163, fail 0 (the parity test runs once the-creator has airspace.ts; until then: 162 pass, 1 skipped)
```

From this moment the local CLI requires an `airspace` block and a reachable registry
for every real (non-dry) run.

## 3. Declare airspace in the plans that will run (decision: block until declared)

These plans have no `airspace` block and will not load until they get one. Only you
can say what each touches. Draft one with `ds-build airspace draft <plan>`, edit, save:

- `own-products/fast-insurance-group/plans/fastig-plan.yaml` (GHL location `OwTVypw5mcI0oznL5Bgd`, pipelines it writes)
- `own-products/frontdesk-sales/plans/frontdesk-sales-gcp-auth.plan.yaml`
- `own-products/digitalsolomon-rebuild/plans/post-launch-2026-10.plan.yaml` (and the `-harness-wt` worktree copies)
- `client-work/renuity/plans/renuity-measurement-console.plan.yaml`, `ttd-reporting-app.plan.yaml`, `ttd-write-agent.plan.yaml`
- `internal-tools/robinhood-trading-agent/plans/robinhood-options-lane.plan.yaml`, `robinhood-stock-lane.plan.yaml`
- `internal-tools/video-engine/plans/wave1.plan.yaml`, `wave2.plan.yaml`

Plans already saved in The Creator (`projects` with a `planUri`) need it too: the
Run button now refuses an invalid plan. Re-save them through Architect, or re-sync
them with `ds-build sync`.

## 4. IAM (human gate)

The cloud services already read and write the default Firestore database. Only the
blacktop identity is new to it.

- Whatever identity `ds-build` uses on blacktop (your ADC, or `local-runner-sa` per
  the `gcp-local-auth` skill) needs, on project `digitalsolomon-creator`:
  - `roles/datastore.user` on the **(default)** database (registry claims, sync
    records, Local Builds launch pickup). If you fence it with an IAM condition like
    the watcher's, allow `(default)`; the watcher's own SA does NOT need this.
  - `roles/storage.objectAdmin` on bucket `digitalsolomon-creator-creator`, limited
    to prefix `plans/` if you condition it (sync uploads plans; the runner reads them).
- Confirm `creator-solomon`'s and `solomon-runner`'s service accounts still have
  `roles/datastore.user` (they do today: they write `projects/` and `runs/`).

Check: `ds-build airspace list` prints `Active claims (0)` instead of a permission error.

## 5. Firestore rules

The new collections (`airspaceClaims`, `airspaceHeld`, `airspaceRegistry`,
`localRunner`, and the scratch `airspaceTest_*`) are only ever touched by server SDKs,
which bypass rules. If the default database has client rules, make sure they deny
these collections to browsers (the default deny already does).

## 6. Live acceptance against real Firestore

```powershell
cd C:\Users\marcu\Projects\portfolios\internal-tools\ds-build-agent
node checks/airspace-live.mjs
```

Uses scratch collections only. Expect four `✓` lines and
`All live airspace acceptance checks passed`. Run it twice (the reliability bar).

## 7. Deploy (human gate: production)

Rebuild and deploy in this order, so the cockpit never acquires a claim the runner
does not understand:

1. `solomon-runner` job image (ds-build-agent `cloudbuild-job.yaml`), as usual.
2. `creator-solomon` and `creator-architect` (the-creator `infra/redeploy.ps1`).

Check: open the 007 Agent page; an **Airspace** panel shows under the project. Launch
one plan, then try to launch a plan sharing a resource: it is refused with
`held: conflicts with ...`, and the held launch appears in the panel.

## 8. Local Builds plan runner on blacktop (human: installs a scheduled task)

```powershell
cd C:\Users\marcu\Projects\portfolios\internal-tools\ds-build-agent
node dist/index.js local-runner --once     # one pass; prints "nothing requested"
```

Then register `node <ds-build-agent>\dist\index.js local-runner` as a logon task, the
same way handoff-watcher starts. Check: the Local Builds page's Airspace card says
"Plan runner on blacktop is online".

End to end: `ds-build sync fast-insurance-group` → the plan appears under **Plans** as
a dry run → **Launch** → the runner picks it up within 10 s → the claim shows in
Airspace with the local lane → the claim is released when the run ends.
