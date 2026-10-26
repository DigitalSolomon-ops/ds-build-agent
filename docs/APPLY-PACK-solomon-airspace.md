# Apply pack: solomon-airspace r2 (phase 7, human, behind the launch gate)

Built on 2026-10-26 to `HANDOFF-solomon-airspace-r2.md` edition 4, with the
review amendments in `GOLDFISH-REVIEW-solomon-airspace.md`. The design is
described in `docs/AIRSPACE.md`, and the evidence is in
`docs/ACCEPTANCE-solomon-airspace.md`.

**Branch state.**

- Nothing is merged or deployed.
- No IAM, Firestore rule, secret or database was changed.
- Live checks wrote only to `airspaceTest_*` collections in `local-builds`.
- The three branches are pushed. Nothing went to `main` or `master`.

| Repo | Branch | Base |
|---|---|---|
| handoff-watcher | `feat/airspace-claims` | `main` |
| ds-build-agent | `feat/solomon-airspace` | `master` |
| the-creator | `feat/solomon-airspace-r2` | `main` (the old `feat/solomon-airspace` is superseded; do not merge it) |

The decisions, all made by Marcus on 2026-10-26:

- **D1:** handoff-watcher is the only unattended local runner. `ds-build local-runner` is deleted.
- **D2:** the registry lives in the `local-builds` database.
- **Cloud:** the cloud runner gets no GitHub token.
- **Latency bar:** non-overlapping launches must meet p95 ≤ 3 s when 5 start at once.

Do these steps in order. Each one says how to check that it worked.

## 1. IAM: verify, and one grant for hand-run CLI use

The registry is in `local-builds`, so neither the cockpit nor the watcher needs a new grant.

- **Verify the existing grants.**
  - The default compute SA (it runs the cockpit and the `solomon-runner` job, which sets no `--service-account`) holds `roles/datastore.user` with no condition. That covers `local-builds`.
  - The `handoff-watcher` SA holds `roles/datastore.user`, fenced to `databases/local-builds`. It stays unchanged.
- **Grant (needed only to run `ds-build <plan>` by hand on blacktop).** Give `local-runner-sa` the role `roles/datastore.user`, with an IAM condition that fences it to `databases/local-builds`, the same way as the watcher. Without this grant, a hand-run CLI exits 5 with `airspace: registry unreachable`. That is fail-closed, by design.
- **Verify the job.** `gcloud run jobs describe solomon-runner --region us-central1` should show `maxRetries: 0`. It is set by `infra/06-solomon-job.ps1:35`. A retry would otherwise be held by its own spent claim.

Check: `ds-build airspace list` prints `Active claims (0)` instead of a permission error.

## 2. Firestore rules: no change

`infra/firestore.local-builds.rules` already denies every rules-bound caller everything except creating a webhook `localBriefs` doc. The `airspace*` collections are reached only by service accounts through IAM.

Check: run `python infra\test-local-builds-rules.py` from the-creator. It runs online and is yours to run. Every case should pass, including "the webhook can touch nothing but localBriefs create".

## 3. Merge and restart handoff-watcher FIRST

```powershell
cd C:\Users\marcu\Projects\portfolios\internal-tools\handoff-watcher
git fetch; git checkout main; git merge --ff-only origin/feat/airspace-claims
$env:PYTHONPATH = "$PWD\.deps"; python -m pytest tests -q        # expect all passed
python watcher.py status                                          # must show NO running job
```

Restart the watcher only when `status` shows no running job. Use the `handoff-watcher` scheduled task, ending and starting it the usual way.

Check: the Local Builds page shows the watcher's version as **3.0.0**.

**Why it goes first:** from now on every job claims airspace. Send to Local Builds (step 5) must only ever reach a watcher that claims.

**What changes for you:**

- A brief that conflicts with a live run stays **queued**, and Local Builds shows the reason `held: conflicts with <plan> on <resource>`. It starts on the first poll after the holder finishes.
- With no key, or an unreachable registry, nothing starts. Jobs show `held: airspace registry unreachable`. This is intentional: v1 used to run without the cloud.
- A brief may declare extra resources in its front matter (`airspace:` list). The watcher claims them too.

## 4. Merge ds-build-agent, rebuild the job image and the CLI

```powershell
cd C:\Users\marcu\Projects\portfolios\internal-tools\ds-build-agent
git fetch; git checkout master; git merge --ff-only origin/feat/solomon-airspace
npm ci; npm test                                                  # expect: fail 0
```

1. Rebuild the `solomon-runner` job image the usual way (`cloudbuild-job.yaml`).
2. Reinstall the global `ds-build`: `npm install -g .` (or your usual link).

**What changes for you:**

- Every real (non-dry) run claims airspace, and its build target must be inside the claimed airspace. That means a `path:` under the Projects root, or a `path:abs:` outside it.
- The CLI's exit codes: 3 = held, 4 = airspace lost mid-run (work stopped), 5 = refused before launch.
- `--run-id` is gone.
- The cloud runner gives agents **no GitHub token**. Any cloud plan that pushed to GitHub will now fail at the push. See step 8.

## 5. Merge the-creator and redeploy

```powershell
cd C:\Users\marcu\Projects\portfolios\internal-tools\the-creator
git fetch; git checkout main; git merge --ff-only origin/feat/solomon-airspace-r2
npm ci; npm run build --workspace packages/shared
node --test "services/solomon/test/**/*.test.*"                   # expect: fail 0
.\infra\redeploy.ps1 solomon hub architect
```

**What changes for you:**

- The Plans card has **Send to Local Builds**. It writes a plan brief that waits behind Launch, like any brief.
- The old local Launch is gone.
- Cancel on a cloud run behaves differently:
  - while the run is starting it returns 409 (try again in a moment);
  - once the run is running, it cancels the execution, and the runner releases the claim on its way out.

## 6. Declare airspace in the plans that will run

Every plan now needs a top-level `airspace` block. Plans without one fail to load and cannot be launched. Draft a block with `ds-build airspace draft <plan>`, edit it, then save. These plans have none yet:

- `client-work/renuity/plans/renuity-measurement-console.plan.yaml`, `ttd-reporting-app.plan.yaml`, `ttd-write-agent.plan.yaml`
- `client-work/renuity/renuity-measurement-console/renuity-measurement-console.plan.yaml`
- `internal-tools/robinhood-trading-agent/plans/robinhood-options-lane.plan.yaml`, `robinhood-stock-lane.plan.yaml`
- `internal-tools/video-engine/plans/wave1.plan.yaml`, `wave2.plan.yaml`
- `own-products/digitalsolomon-rebuild/plans/post-launch-2026-10.plan.yaml`
- `own-products/digitalsolomon-rebuild-harness-wt/plans/*.plan.yaml` (4 plans)
- `own-products/frontdesk-sales/plans/frontdesk-sales-gcp-auth.plan.yaml`
- `own-products/fast-insurance-group/docs/from-downloads/ghl-mcp-connection.plan.yaml`. It has `executor: ghl` tasks, so it also needs a `ghl_location`.

`ds-build-agent/plans/ghl-mcp-connection.plan.yaml` now declares `ghl_locations: [REPLACE-WITH-CHOSEN-LOCATION-ID]`. Put the chosen location id there before launching it.

Paths must be at least two levels below the Projects root (`portfolios/<portfolio>/<project>`). `ghl_pipelines` are written as `<locationId>/<pipelineId>`.

Plans already saved in The Creator need a block too. Re-sync them with `ds-build sync <project>`.

## 7. Live checks to run after the deploy

Run these from ds-build-agent with the watcher SA key. They use test collections only.

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = (Get-Content C:\Users\marcu\Projects\portfolios\internal-tools\handoff-watcher\.env | Select-String '^LOCAL_BUILDS_SA_KEY=').ToString().Split('=',2)[1]
$env:WATCHER_REPO = "C:\Users\marcu\Projects\portfolios\internal-tools\handoff-watcher"
$env:PYTHONPATH = "$env:WATCHER_REPO\.deps"
foreach ($m in "probe","race","disjoint","crash","partition","watcher") { node checks/airspace-live.mjs $m; "$m exit $LASTEXITCODE" }
```

Each mode must exit 0. Run the set twice; the reliability bar is "ran unattended twice".

Then do these by hand. They are the rows marked MANUAL or BLOCKED in `docs/ACCEPTANCE-solomon-airspace.md`:

1. **Pages.** Open the 007 Agent and Local Builds pages. Both show the **Airspace** panel: live claims, with run, lane, resources and lease time left, plus held launches naming the holder.
2. **Sync, end to end.**
   1. Run `ds-build sync <a project>`. The plan appears under Plans as a dry run.
   2. Press **Send to Local Builds**. The brief lands as *Awaiting launch*.
   3. Press **Launch**. The watcher runs it, its claim shows in Airspace in the local lane, and the claim is released when the run ends.
3. **Page Cancel.** Start a long brief, press Cancel, and confirm the claim reads `released`. Allow up to REQUESTS_SECONDS + 2 × POLL_SECONDS (about 20 s).
4. **Conflict.** Launch one plan in the cloud, then launch a plan sharing a folder. The second is refused with `held: conflicts with ...` and appears in the panel.

## 8. Decisions still open for you

- **The interactive `ds-build` CLI's auth default.** On blacktop it still runs agents through the Agent SDK on the subscription. D1 removed every *unattended* use; interactive use predates this work and was left as it was. Your options:
  - keep it;
  - default it to `--api`;
  - route hand-run plans through Local Builds too.
- **A GitHub token for the cloud lane.** The cloud runner now gives agents no token. If cloud plans must push, mint a per-run token scoped to the run's claimed `repo:` keys, for example a GitHub App installation token restricted to those repositories. That needs a new App or secret, so it is your call.
- **Interactive and other writers.** Site Grower publishes, scheduled tasks and interactive Claude Code sessions don't claim airspace. This is by design and documented in `docs/AIRSPACE.md`.
