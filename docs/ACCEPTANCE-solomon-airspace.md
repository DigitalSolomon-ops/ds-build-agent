# Acceptance: solomon-airspace r2

Brief: `HANDOFF-solomon-airspace-r2.md` edition 4, with the review amendments in
`GOLDFISH-REVIEW-solomon-airspace.md` (Phase 0 pass P0-1..P0-10, post-build pass PB-1..PB-7).
Built on 2026-10-26 in an interactive Claude Code session (Marcus: "build it here"), not by the watcher.

## What the rows ran on

Every row below ran at these HEADs. No code changed after the run: the only later commit is
this document, which is docs only.

| Repo | Branch | HEAD |
|---|---|---|
| ds-build-agent | `feat/solomon-airspace` | `a0a7161e0198da1bcc60363e2a1eed02bbdccc1c` |
| the-creator | `feat/solomon-airspace-r2` | `8ea67aa4a74de22da6299ed2b7366d2ab57a9565` |
| handoff-watcher | `feat/airspace-claims` | `0ea6356ca7b2a3c81f0c242e518d0cc963b89e7a` |

**How the runs were set up**

- Each repo was a worktree outside the Projects tree (`%LOCALAPPDATA%\ds-worktrees\solomon-airspace\<repo>`).
- Environment: `AIRSPACE_CROSS_REPO=1` and `DS_BUILD_REPO` / `CREATOR_REPO` / `WATCHER_REPO` set to those worktrees.
- `PYTHONPATH` pointed at the live watcher's `.deps`, read only.
- Live checks used the handoff-watcher SA key through `GOOGLE_APPLICATION_CREDENTIALS`, which is already fenced to `local-builds`.
- They wrote only `airspaceTest_*` collections.

**Evidence files** sit beside this doc in `docs/acceptance-evidence/`:

- `rows.txt`
- `shas*.txt`
- `live-*.jsonl`, for run 1 and run 2
- `live-checkouts-*.txt`

## Results

The status rules are those in the brief, Phase 4:

| Status | Meaning |
|---|---|
| PASS | Ran, and every assertion held. |
| FAIL | An assertion was violated in some attempt. |
| BLOCKED | Only for `credential` or `transient`. |
| MANUAL | Only for the rows named as MANUAL. |
| NOT RUN | Not run, with no STOP fired. This counts as FAIL. |

| # | Row | Status | Command | Exit | Firestore |
|---|---|---|---|---|---|
| 1 | Probe: transactional write, then read and delete | PASS | `node checks/airspace-live.mjs probe` | 0 | live |
| 2 | Suites | PASS | `npm test` gives 198 pass / 0 fail / 0 skip. `python -m pytest tests -q` gives 162 passed. `node --test "services/solomon/test/**/*.test.*"` gives 23 pass. | 0 / 0 / 0 | fake |
| 3 | Build | PASS | `packages/shared` `tsc -p .`, then `npx tsc -p services/<svc> --noEmit` for architect, delivered, hub, outreach, solomon, status, vault and video | all 0 | none |
| 4 | Parity: mirror and fixture byte-equal, run with no skip | PASS | It is inside row 2 under `AIRSPACE_CROSS_REPO=1`; the ds suite reports `skipped 0`, and the watcher's `test_fixture_byte_equal_to_ds_build_repo` ran | 0 | none |
| 5 | Clean trees | PASS | `git status --porcelain` printed 0 bytes in all three worktrees after the suites and after the live checks. The live checkouts' HEAD and porcelain were the same before and after (`live-checkouts-*.txt`). | n/a | none |
| 6 | Sync, existing plan | PASS (offline) | `ACCEPT 1: sync on a project with an existing plan …`: the stored copy hashes like the file, and `planSha256` is the hash of the raw bytes. The live sync is MANUAL by design (apply pack 7.2) because sync writes `(default)/projects`, which the allowed credential cannot reach. | 0 | fake |
| 7 | Sync, no plan | PASS | `ACCEPT 2 …` and `sync: no Architect call`. The-creator has `launch: returns 409 on review` and `send: refused for a review plan`. | 0 | fake |
| 8 | Sync, repeat, and the same plan in two lanes | PASS | `ACCEPT 3 …` makes 0 writes. The watcher has `test_cloud_plan_claim_holds_watcher_plan_brief` and `test_watcher_plan_brief_holds_cloud_launch`. The fixture covers plan-key cases. | 0 | fake |
| 9 | Concurrent launches | PASS | `node checks/airspace-live.mjs race`: 4 rounds of 5 forked children. Round 4 mixes 3 TS and 2 Python children. Every round granted exactly 1, and every loser was held with the conflict named. | 0 | live |
| 10 | Non-overlapping launches | PASS | `node checks/airspace-live.mjs disjoint`: 20 acquires, all granted, no held records. p95 was 2237 ms in run 1. The bar is 3000 ms (Marcus, 2026-10-26). | 0 | live |
| 11 | Local vs cloud | PASS | `checks/airspace-crosslane.test.mjs` runs the-creator's real Launch route and the CLI `main()` on one registry. A local hold gives a 409 with the held message and 0 `runJob` calls. A cloud claim makes the CLI exit 3 with the same message shape. | 0 | fake |
| 12 | Crash | PASS | `node checks/airspace-live.mjs crash`. Held at lease − 30 s, naming the dead child. Granted 759 ms after the lease ended in run 1, which is within lease + heartbeat + round-trip. | 0 | live |
| 13 | Partition | PASS | `node checks/airspace-live.mjs partition`. The child fenced itself about 30 s before `lease_expires_at`, in anchored server time. | 0 | live |
| 14 | Watcher vs plan | PASS | The watcher has `test_watcher_vs_plan_starts_within_one_poll_after_release`. Live: `node checks/airspace-live.mjs watcher` with the real Python claim loop. It was held, named the plan run, and started 5217 ms after release at POLL_SECONDS 5 (bound 7000 ms). | 0 | fake + live |
| 15 | Cancel | PASS (pytest) / **MANUAL** (page) | `test_cancel_releases_within_two_polls`. The end-to-end page Cancel needs a deployed cockpit, so it is in apply pack 7.3. | 0 | fake |
| 16 | Live lanes unchanged | PASS / **MANUAL** (page rendering) | The-creator API tests cover archive, Launch recording the IAP identity, Cancel and Remove. `git diff main...HEAD -- infra/firestore.local-builds.rules` is 0 bytes. Rendering of the 007 Agent and Local Builds pages is in apply pack 7.1. | 0 | fake |
| 17 | No unattended SDK | PASS | `no unattended SDK: …` checks all three repos. `Get-ScheduledTask` found no task that runs ds-build, node or local-runner; the only watcher task is `pythonw watcher.py run`. | 0 | none |
| 18 | No override, force or skip | PASS | `no override: identifiers outside comments` checks all three repos, including the-creator HTML. The allow-list is exact lines with reasons. | 0 | none |
| 19 | Goldfish BLOCKING IDs mapped | **NOT RUN, counted as FAIL** | Every ID is mapped to its fix and test below. The strict proof was not produced: running each test on the fix's parent commit in a detached worktree and seeing it fail at an assertion. See "Goldfish IDs". | n/a | n/a |

**Live runs.** All six live modes ran twice at these HEADs with no code change in between. Both runs exited 0 for every mode; see `docs/acceptance-evidence/run1` and `run2`. Earlier runs at older HEADs failed twice, and both failures were fixed before these runs:

- Disjoint p95 was 7.0 s. Fixed by retrying contended transactions within milliseconds, and by parallel reads.
- In the race's mixed round, a Python loser surfaced a raw 409. Fixed by porting the same contention retry to Python.

## Spec deviations

- Sync never calls the Architect. A project with no plan gets a deterministic skeleton marked `review`.
- "One sync command queues it" became two steps: `ds-build sync`, then **Send to Local Builds** in the cockpit, then Launch.
- The local lane runs one watcher job at a time, not "3 tasks at a time". A plan brief tells `claude` to use at most three subagents, which is advisory only.
- "Exactly one wins" became "at most one wins; every loser is held, or refused fail-closed". The live check also requires at least 2 of 3 rounds to grant exactly one.
- Adoption: the cockpit claims at cloud Launch as `adoptable`, and the cloud runner adopts it once.
- Plans reach Local Builds only as briefs. `ds-build local-runner` was deleted under D1.
- The cloud lane sees local-lane plans only through the registry, and local plan runs never write `runs/`.
- "Non-overlapping runs launch side by side with no delay" became p95 ≤ 3 s for 5 simultaneous launches. A lone launch takes about 0.4 s. Marcus decided this on 2026-10-26.
- The cloud runner gives agents no GitHub token. Marcus decided this on 2026-10-26 (P0-7).

## Goldfish IDs

All of the code fixes below are covered by the named tests, and those tests run green in row 2. The brief also asks for proof that each test fails at an assertion on the parent commit. That was **not produced**.

The reason: almost every test imports modules or exports that only exist after the fix (`REGISTRY`, `AnchoredClock`, `proc-tree`, `main(argv, deps)`, the Python port). On the parent commit each would fail at import, which the brief rules out. A faithful proof needs a stub per module.

Independent verification came from the post-build Goldfish pass and the live runs instead. Row 19 is therefore NOT RUN, and the final line reflects it.

| IDs | Fix (commit) | Evidence |
|---|---|---|
| R1 D1, D2 | ds `e120d6c`, creator `35cd0fe`, watcher `96120fc` | rows 14, 17; `registry: env vars ignored` |
| R1 B1 (`--run-id` takeover), P0-9, P0-10 | ds `e120d6c` | `adopt: *`, `cli: --run-id rejected`, fixture adopt cases |
| R1 B2, R2-2, R3-2 (fence) | ds `e120d6c`, watcher `8b2dbfb` | `fence: *` (TS + Python), row 13 |
| R1 B3 (loss aborts work) | ds `e120d6c` | `loss: in-flight task aborted, HEAD unchanged, exit 4`, `commit: fence passed refuses commit` |
| R1 B4, P0-1 (cancel) | creator `35cd0fe` | `cancel: *`, `cancel: stale launching with adopted claim not released` |
| R1 B5, R2-6 (path↔repo) | ds `e120d6c`, creator `8ea67aa` | `overlap: path vs derived repo`, `sync: derived repo written …`, `launch: claims the record's derived repo: keys` |
| R1 B6 (build target) | ds `e120d6c` | `target: *` |
| R1 B7, PB-2 (env bypass) | ds `e120d6c`, `020128e`; creator `8ea67aa`; watcher `d17c43c` | `registry: env vars ignored`, `registry: refuses FIRESTORE_EMULATOR_HOST`, `test_registry_refuses_emulator_env` |
| R1 B8, R2-3, R2-4, R3-3, R3-4 (watcher claims, Job Object, front matter) | watcher `96120fc`, `ad17541` | `test_jobobject_*`, `test_orphan_*`, `test_front_matter_*`, `test_claim_set_union` |
| R1 A1, A2, A4, R2, R3, NO (criteria) | row rewrites in edition 4 | rows 9–11, 15, 16, 18 |
| R2-1, R3-1 (time) | ds `e120d6c` | `time: *` (TS + Python + fixture) |
| R2-5 (worktrees) | process | row 5 plus `live-checkouts-*.txt` |
| R2-7 (plan brief format) | creator `35cd0fe`, watcher `96120fc` | `send: writes an awaiting brief …`, `test_front_matter_*` |
| R2-8, R2-14, R3-6 (testable entries, tests in worktrees, Windows signals) | ds `e120d6c` | `exit: grandchild gone before release`, row 5 |
| R2-9, R2-10, R2-11, R2-12, R2-13 | edition 4 and `020128e` | rows 1, 9, 15, 19, and this table |
| R3-5 (grep) | ds `5106de7` | row 18 |
| R3-7..R3-17 (status rules and rows) | edition 4 | rows 1–19 |
| P0-2..P0-6, P0-8 | this doc; ds `020128e`; watcher tests | SHAs recorded, rows 12, 2 |
| P0-7 (GitHub token) | ds `e120d6c` | `cloud: no GitHub token in agent env` |
| PB-1 (confirm before release) | ds `020128e`, watcher `1535bf8` | `exit: children not confirmed dead -> the claim is NOT released`, `test_kill_raises_claim_left_to_lease` |
| PB-3 (live exit codes) | ds `020128e` | `airspace-live.mjs` header and code |
| PB-4, PB-5, PB-6 | watcher `db752c0`, `47c0258`; ds `020128e` | rows 8, 14, 17 |
| PB-7 (apply pack) | ds `a0a7161` | `docs/APPLY-PACK-solomon-airspace.md` |

## Final line

Row 19 is NOT RUN, and the brief counts that as FAIL. Every other row is PASS, apart from rows 6, 15 and 16, which have MANUAL parts.

HANDOFF-STOP: acceptance failed: 19 (Goldfish-ID parent-commit proofs not produced; everything else PASS, MANUAL: 6-live-sync, 15-page-cancel, 16-page-rendering)

## Post-deploy manual checks (2026-10-26)

These ran after the merge and deploy. Marcus ran the commands for the IAM grant and the ADC login; the page actions ran in his Chrome as marcus.barber.

| Row | Check | Result |
|---|---|---|
| 6 (live part) | `ds-build sync ds-build-agent --plan plans/harness-smoke.plan.yaml` | PASS. Record `sync--internal-tools-ds-build-agent--harness-smoke` is `drafted` / `dry-run`, and its `planSha256` equals the file's hash. |
| 15 (page part) | Page Cancel on a running watcher job (a 240 s sleep brief in scratch-project) | PASS. Cancel requested at 17:39:05; the Job Object was terminated at 17:39:06.9; the claim was `released` at 17:39:07.1. The lease would otherwise have held until 17:44. |
| 16 (page part) | The Airspace panel on Local Builds and 007 Agent | PASS. Both list live claims with run, lane, resources and lease. |
| — | Send to Local Builds, then Launch, then the watcher | PASS. The plan brief landed as Awaiting launch, and Send was disabled for the duplicate. Launch recorded marcus.barber. The watcher claimed path + plan + derived `repo:digitalsolomon-ops/ds-build-agent` before starting, ran 5/5 tasks in 71 s, wrote only inside `builds/harness-smoke/`, and released the claim. |
| — | Cloud Cancel | PASS. The cancel landed before any task ran, so the cost was $0. The claim was left to the lease and expired on its own. |
| — | `local-runner-sa` grant | PASS. `ds-build airspace list` as local-runner-sa reads the registry. |

**The conflict check was mistimed.** The cloud Launch came after the local run had already finished and released its claim, so it was correctly granted. The registry pre-check had reported the held conflict while the local claim was live, and rows 9 and 11 cover the block.
