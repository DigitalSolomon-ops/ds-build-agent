# Airspace control and sync on command (solomon-airspace)

Brief: `handoffs/2026-10-26-Creator-Local-Sync-Airspace-Control-Notes.md`.
Deployment and IAM are the human launch step: see `docs/APPLY-PACK-solomon-airspace.md`.

## What it does

No two runs, local or cloud, can ever work the same resources at the same time.
Conflicts are blocked before launch, not detected afterwards.

1. **Every plan declares `airspace`** (required, top level). A plan without one fails
   validation in the harness and in The Creator, so it cannot be saved or launched.

   ```yaml
   airspace:
     repos: [DigitalSolomon-ops/fast-insurance-group]      # owner/name, bare name, or URL
     paths: [portfolios/own-products/fast-insurance-group]  # folders, relative to the Projects root
     ghl_locations: [OwTVypw5mcI0oznL5Bgd]
     ghl_pipelines: ["Partner Sales"]
     other: ["n8n_workflow:lead-router"]                    # any other shared resource, type:value
   ```

   `ds-build airspace draft <plan.yaml>` prints a starting block for review.
2. **Every launch claims it first**, in one Firestore transaction: all of the plan's
   resources plus `plan:<name>` (so one plan never runs twice at once, in either lane).
   All are granted or none are.
3. **Any overlap is a hard block.** The message names the holder and the contested
   resource: `held: conflicts with fast-insurance-group on ghl_pipeline:Partner Sales
   [run local-..., local lane]`. There is no override flag, force option or skip in
   any code path. A test fails if one appears in `src/airspace*.ts`.
4. **Leases.** A claim lasts 5 minutes and the run renews it every 60 seconds. A
   killed run stops renewing and its claim frees itself within 5 minutes. A run that
   loses its claim (lease lapsed and someone else took the airspace) halts dispatch.
5. **Release** on finish, on a fatal error, on SIGINT/SIGTERM (the cockpit's kill
   switch), and by the cockpit's cancel route.

## Where it lives

| Piece | File |
|---|---|
| Schema, overlap rules, registry, lease/heartbeat (source of truth) | `src/airspace.ts` |
| Mirror used by the cockpit (byte-identical, parity test) | `the-creator/packages/shared/src/airspace.ts` |
| Acquire/heartbeat/release around a run | `src/airspace-launch.ts` |
| Local CLI launch | `src/index.ts` (exit 3 = held, exit 1 = registry unreachable) |
| Cloud runner | `src/cloud-job.ts` (adopts the cockpit's claim by `RUN_ID`) |
| Cockpit launch preflight, Airspace panel, Local Builds plans | `the-creator/services/solomon` |
| Sync on command | `src/sync.ts`, `ds-build sync <project>` |
| Local Builds plan runner | `src/local-runner.ts`, `ds-build local-runner` |

Firestore, default database, project `digitalsolomon-creator`:

| Collection | Holds |
|---|---|
| `airspaceClaims/{run_id}` | one doc per run: `run_id, plan_name, lane, resources[], status (active/released/expired), acquired_at, heartbeat_at, lease_expires_at` (timestamps) |
| `airspaceHeld/{run_id}` | a launch that was blocked: the conflicts and the message; `resolved_at` once the plan later gets its airspace |
| `airspaceRegistry/head` | a version counter every registry transaction reads and writes |

Why one `head` doc: folder claims overlap by prefix (`path:a/b` vs `path:a/b/c`), which
per-resource lock documents cannot express. Making every registry transaction read and
write one doc means Firestore serializes them, so two simultaneous launches cannot
both commit; the loser re-runs, sees the winner's claim, and is held. Launches are
rare, so the cost is milliseconds.

The cloud never reaches blacktop. The cockpit only writes Firestore docs; blacktop
pulls them.

## Sync on command

```
ds-build sync portfolios/own-products/fast-insurance-group   # or just: ds-build sync fast-insurance-group
ds-build sync <project> --plan plans/other.plan.yaml
ds-build sync <project> --dry-run                            # preview, writes nothing
```

Finds the plan (`--plan`, then `project.yaml` `spine.plan`, then `plan.yaml`, then
exactly one `plans/*.yaml`, then exactly one `*.plan.yaml`; several candidates is a
refusal, never a guess) and writes ONE record, `projects/sync--<project>--<plan>`, with
the plan YAML in the creator bucket. It is the same record the 007 Agent launches in
the cloud and Local Builds launches on blacktop, so a project is never duplicated.

| Case | Result |
|---|---|
| Existing plan | queued unchanged (the plan file is never modified), `syncState: dry-run`, with an agent-free dry-run summary. Nothing runs until Launch. |
| Plan with no `airspace` | queued as `needs-airspace` with a drafted block for review. Launch refuses it. |
| No plan | a skeleton plan is generated and queued as `review`, and sync stops. Launch refuses it. The draft is written to `builds/sync/<id>.plan.yaml`. |
| Same plan bytes again | no-op: nothing uploaded, nothing written. |
| Changed plan | the same record is updated and reset to a dry run (refused while it is launching or running). |

Launching a synced plan locally: the Local Builds page's **Launch** button claims the
airspace for the local lane and marks the record `localLaunch: requested`. `ds-build
local-runner` on blacktop picks it up atomically and runs
`ds-build <plan> --repo <project> --run-id <id> --concurrency 3 --state` on the Claude
subscription, which adopts the claim. Outcome (`done` / `held` / `failed`) and a
redacted log tail are written back to the record. Local runs never write `runs/`, so
they never count against the cloud spend cap.

## Open questions: what was decided

| Question | Decision | Why |
|---|---|---|
| Lease length and heartbeat interval | 5 min lease, 60 s heartbeat (`AIRSPACE_LEASE_MS`, `AIRSPACE_HEARTBEAT_MS`) | Five missed beats before a claim frees: one network blip never loses a claim, and a crashed run frees within 5 minutes. |
| Repo paths at folder or file level | Folder level. `path:` claims a folder and everything under it; globs are rejected. | File-level claims would need every plan to predict every file. Plans should name the narrowest folder that covers the work. |
| Sync as CLI, cockpit button, or both | CLI (`ds-build sync`). The cockpit lists synced plans and owns Launch. | The cloud never reaches blacktop, so it cannot read a project folder. A cockpit sync button would need a pull channel like the brief queue; not built. |
| Existing plans with no `airspace` | Block until declared. `ds-build airspace draft` and sync's `needs-airspace` state hand you a drafted block to review. | Gates only accumulate: an auto-written airspace block would launch a plan on a guess about what it touches. |

## Known limits

- `repo:` and `path:` do not cross-match: a repo cloned at a path is two keys. Declare both.
- Generated plans are a deterministic skeleton, not an Architect (LLM) draft. The brief
  asked for generation "through The Creator"; the cloud cannot see the project folder,
  so that would need a new upload path.
- Every plan in the Projects tree without an `airspace` block now fails to load in
  `ds-build` and cannot be launched from the cockpit until one is added.
