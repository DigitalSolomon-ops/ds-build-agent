# Airspace control and sync on command (solomon-airspace)

Briefs:
- `HANDOFF-solomon-airspace.md` is the spec.
- `HANDOFF-solomon-airspace-r2.md` is revision 2, edition 4, the brief this was built to.
- `GOLDFISH-REVIEW-solomon-airspace.md` is the review record.

These three files sit untracked beside the repo root in the main checkout.

Deployment and IAM are the human launch step: see `docs/APPLY-PACK-solomon-airspace.md`.

## What it does

No two runs can ever work the same resources at the same time, whether they run locally or in the cloud. Conflicts are blocked before launch, not detected afterwards.

1. **Every plan declares `airspace`.** It is required and sits at the top level. A plan without it fails validation in the harness and in The Creator, so it cannot be saved or launched.

   ```yaml
   airspace:
     repos: [DigitalSolomon-ops/fast-insurance-group]      # owner/name, bare name, or GitHub URL
     paths: [portfolios/own-products/fast-insurance-group]  # folders, relative to the Projects root, >= 2 levels deep
     ghl_locations: [OwTVypw5mcI0oznL5Bgd]                  # required when the plan has executor: ghl tasks
     ghl_pipelines: ["OwTVypw5mcI0oznL5Bgd/pipelineId"]     # <locationId>/<pipelineId>
     other: ["n8n_workflow:lead-router", "path:abs:C:/somewhere/outside/projects"]
   ```

   `ds-build airspace draft <plan.yaml>` prints a starting block for review. It never writes the block into the plan.

2. **Every launch claims its airspace first, in one Firestore transaction.**
   - What is claimed:
     - every resource the plan declares;
     - `plan:<name>`, so one plan never runs twice at once in either lane;
     - the **derived** `repo:` keys: the GitHub origin of every claimed `path:` that is a git working tree, and of every working tree nested under it.
   - All of these are granted, or none are.
   - **Why derived keys:** a run that names only the folder and a run that names only the remote still contend.
   - **Repos that are never derived:** a repo whose top level contains the whole Projects tree, such as the stray repo at `C:\Users\marcu`, is nobody's project repo.
3. **Any overlap is a hard block.** The message names the holder and the contested resource, for example: `held: conflicts with fast-insurance-group on ghl_pipeline:Loc/Pipe [run local-..., local lane]`.
   - There is no override, force or skip, in any lane or runner.
   - The tests enforce this by behaviour and by a grep across all three repos.
4. **The registry is fixed.** It lives in Firestore project `digitalsolomon-creator`, database `local-builds` (`REGISTRY` in `src/airspace.ts`). No env var or flag can point a run anywhere else.
   - Every transaction checks the head's `registry_id`. A foreign id fails closed.
5. **Time is the server's.**
   - "Now" is a Firestore commit time, written to `airspaceRegistry/clock` and read back from the write result, carried forward on the local **monotonic** clock (`AnchoredClock`).
   - The anchor is refreshed every 10 minutes, and immediately after a sleep (when wall and monotonic time drift apart by more than 10 s).
   - Round-trips slower than 5 s are discarded. Three slow ones in a row refuse (exit 5).
   - A timestamp some other writer stored (`head.updated_at`) is audit only and never feeds "now". A head stamped more than 5 s in our future means a broken clock, so the run fails closed without writing.
6. **Leases and the fence.**
   - **Lease and heartbeat.** A claim lasts 5 minutes, and the run renews it every 60 seconds. Bounds are 60 s to 15 min, with the heartbeat at most lease/3; anything else exits 5.
   - **The fence.** The run stops itself when no renewal has been confirmed before `sentAt + lease − 2 × heartbeat`.
     - `sentAt` is when the last *successful* renewal (or the acquire) was sent.
     - The fence runs on its own timer, so a hung renewal cannot hold it open.
   - **No revival.** A claim that is released, expired or past its lease is never revived.
   - **Crashes.** A killed run stops renewing, and its claim frees itself when the lease ends.
7. **Losing the airspace stops the work.**
   - The run's `AbortSignal` fires, and in-flight agent calls (SDK `abortController`) and Codex process trees are killed.
   - Those tasks are recorded `failed: airspace lost`, and nothing more is committed.
   - Before every commit, the run renews and refuses to commit on a lease it cannot confirm.
   - The run exits 4.
8. **Adoption (cloud only, once).**
   - The cockpit acquires at Launch with `adoptable: true`.
   - The cloud runner, starting with the same `RUN_ID`, adopts that claim only when all of these hold:
     - it is still live;
     - it is still adoptable;
     - its lane is cloud;
     - its plan and declared resources match.
   - Adoption flips `adoptable` to false. Release and expiry also clear it.
   - Any other live claim under the same run id is held: a run id never takes over a claim. There is no `--run-id` flag.
9. **Release, after the children are confirmed dead.** On finish, on error, and on SIGINT or SIGTERM (`shutdown()`), the harness does these in order:
   1. Aborts its agents.
   2. Kills every child process tree it started (`src/proc-tree.ts`).
   3. Confirms they are gone.
   4. Releases.
   - The cockpit's Cancel releases only a claim that was never adopted (`releaseIfUnadopted`). An adopted claim belongs to a live runner.

## Exit codes (`ds-build <plan>` and the cloud runner)

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | a task failed, or a non-airspace error |
| 3 | held: another run holds overlapping airspace |
| 4 | airspace lost mid-run (fence or renewal), work stopped |
| 5 | airspace refused before launch: unclaimed build target, lease settings, clock, registry mismatch, registry unreachable |

The build target must be inside the claimed airspace:
- The target is `--repo`, otherwise `--out`, otherwise `cwd/builds`.
- Inside the Projects root, a claimed `path:` must cover it.
- Outside the Projects root, the plan must declare it as `path:abs:<absolute path>`.

## Where it lives

| Piece | File |
|---|---|
| Schema, overlap, registry, time, lease, fence (source of truth) | `src/airspace.ts` |
| Mirror used by the cockpit (byte-identical, parity test) | `the-creator/packages/shared/src/airspace.ts` |
| Python port used by handoff-watcher | `handoff-watcher/handoff_watcher/airspace.py` |
| Shared normalize, overlap, registry and clock cases (both languages run it) | `checks/fixtures/airspace-cases.json` |
| Acquire, heartbeat, derive, build-target check, release | `src/airspace-launch.ts` |
| Child-process trees | `src/proc-tree.ts` |
| Local CLI | `src/index.ts`, exporting `main(argv, deps)` and `shutdown()` |
| Cloud runner | `src/cloud-job.ts`, exporting `main(env, deps)` |
| Cockpit launch preflight, Airspace panel, Send to Local Builds | `the-creator/services/solomon` |
| Sync on command | `src/sync.ts`, `ds-build sync <project>` |
| Live checks (forked children, real registry, `airspaceTest_` collections) | `checks/airspace-live.mjs` |

All of these live in Firestore project `digitalsolomon-creator`, database `local-builds`:

| Collection | Holds |
|---|---|
| `airspaceClaims/{run_id}` | One doc per run: `run_id`, `plan_name`, `lane`, `resources[]`, `declared[]`, `status` (active/released/expired), `adoptable`, `adopted_at`, `acquired_at`, `heartbeat_at`, `lease_expires_at` (timestamps) |
| `airspaceHeld/{run_id}` | A blocked launch: the conflicts, including the holder's run id, and the message. `resolved_at` is set once the plan later gets its airspace. |
| `airspaceRegistry/head` | `version`, `registry_id` and `updated_at` (server time, audit only). Every registry transaction reads and writes it. |
| `airspaceRegistry/clock` | The doc the clock anchor writes a server timestamp to |

**Why one `head` doc.** Folder claims overlap by prefix (`path:a/b` vs `path:a/b/c`), which per-resource lock documents cannot express. Because every registry transaction reads and writes this one doc, Firestore serializes them:
- two simultaneous launches cannot both commit;
- the loser re-runs, sees the winner's claim, and is held.

Launches are rare, so the cost is milliseconds.

**Who may write.** The `local-builds` Firestore rules deny every rules-bound caller everything except creating a webhook `localBriefs` doc. Only service accounts (through IAM) touch the registry:
- the cockpit and the cloud runner, as the default compute SA;
- handoff-watcher, as its SA, which is fenced to this database;
- a hand-run `ds-build`, using `local-runner-sa` once granted (see the apply pack).

## The local lane: handoff-watcher only

Only the unmodified `claude` CLI may use Marcus's subscription, so **nothing unattended on blacktop starts `ds-build` or the Agent SDK**. Marcus decided this on 2026-10-26, and `ds-build local-runner` was deleted. handoff-watcher (`claude -p`) is the only unattended local runner.

How a synced plan runs locally:
1. The cockpit's Plans card has **Send to Local Builds**. It writes a *plan brief* into `local-builds/localBriefs`, awaiting launch.
2. The plan brief's front matter carries `project`, `source: plan`, `plan_name`, `plan_path`, `plan_sha256` and `airspace`.
3. Marcus presses Launch, as for any brief.
4. The watcher claims the brief's airspace in the local lane, prepends its preamble, and runs `claude -p` in the project folder.

The interactive `ds-build` CLI still runs locally on its existing auth default. That is an open decision for Marcus, recorded in the apply pack.

The cloud lane (Cloud Run, API key) is outside that rule. Since 2026-10-26 it gives agents **no GitHub token**: nothing in the harness pushes, and a shared token would let an agent write to repos the run never claimed. A per-run token scoped to the claimed `repo:` keys is the follow-up.

## Sync on command

```
ds-build sync portfolios/own-products/fast-insurance-group   # or just: ds-build sync fast-insurance-group
ds-build sync <project> --plan plans/other.plan.yaml
ds-build sync <project> --dry-run                            # preview, writes nothing
```

**Finding the plan.** Sync checks, in order:
1. `--plan`;
2. `project.yaml` `spine.plan`;
3. `plan.yaml`;
4. exactly one `plans/*.yaml`;
5. exactly one `*.plan.yaml`.

Several candidates is a refusal, never a guess.

**What it writes.** One record, `projects/sync--<project>--<plan>`, with the plan's exact bytes in the creator bucket:
- `planSha256` is the hash of the plan file's raw bytes.
- The record's `airspace` is the declared block plus the derived `repo:` keys.

| Case | Result |
|---|---|
| Existing plan | Queued unchanged (the plan file is never modified), `syncState: dry-run`. Nothing runs until Launch or Send. |
| Plan with no `airspace` | Queued as `needs-airspace` with a drafted block. Launch and Send refuse it. |
| No plan | A deterministic skeleton plan is generated (no Architect call) and queued as `review`. Launch and Send refuse it. The draft is written to `builds/sync/<id>.plan.yaml`. |
| Same plan bytes again | No-op: nothing is uploaded or written. |
| Changed plan | The same record is updated and reset to a dry run. This is refused while the record is running. |

## Open questions: what was decided

| Question | Decision |
|---|---|
| Lease length and heartbeat | 5 min lease and 60 s heartbeat, bounded to 60 s–15 min with the heartbeat at most lease/3, plus the fence |
| Repo paths at folder or file level | Folder level, at least two segments under the Projects root, plus derived `repo:` keys |
| Sync as CLI, cockpit button, or both | CLI now. A cockpit button can come later through the brief queue's pull channel |
| Plans with no `airspace` | Blocked until declared. `airspace draft` and sync's `needs-airspace` hand you a draft to review, which is never auto-accepted |

## Known limits

- **Untracked processes.** The guarantee covers the process trees the harness started. Processes the Agent SDK's own `claude` spawns through Bash, or anything detached (`Start-Process`, background shells), are outside it. Aborting the SDK stops its `claude` subprocess.
- **Writers outside both runners bypass airspace by design.** These include Site Grower publishes, scheduled tasks and interactive Claude Code sessions.
- **Spec deviations** are listed in `docs/ACCEPTANCE-solomon-airspace.md`:
  - generated plans are a skeleton, not an Architect draft;
  - sync then Send is two steps;
  - the local lane runs one watcher job at a time.
