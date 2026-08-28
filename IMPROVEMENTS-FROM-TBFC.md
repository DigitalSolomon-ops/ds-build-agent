# Harness improvements — from the TBFC trucking build (2026-08-28)

Ten improvements, each drawn from a concrete stall in the TBFC trucking-lane build.
**Rule for this workstream: additive, backward-compatible, tested, committed one at a
time** — the harness (and shared tools) stay working after every commit, so an
in-flight build is never broken. Order below is by leverage; do the top three first.

Legend — repo: `dsba` = this repo (ds-build-agent), `vault` = `_tools/vault`,
`skill` = `Projects/Skills/harness-local-dashboard` (+ installed copy), `creator` =
`the-creator/infra`.

## Progress — ALL 11 SHIPPED (2026-08-28)

Design pass: 9 agents ground-truthed every item before implementation (several were
already partly built — P3 ~80%, P8 ~70%, P6 ~40%, P9 ~30%, P2's renderer reusable).
Each improvement additive + tested + committed on its own. ~60 tests, all green.

| # | What | Branch (repo) | Commit |
|---|---|---|---|
| P1 | `getSecretFast` — win32 CLI-first, fail-fast reauth | `feat/vault-getSecretFast` (projects-spine) | `473dae8` |
| P3 | parser warns when `launch_gate` gates nothing | `feat/harness-improvements-from-tbfc` (dsba) | `26d6147` |
| P5 | `httpJson` — browser UA + parse-body success | dsba | `02807ec` |
| P4 | `tools/verify` live-read library | dsba | `c3eb6c6` |
| P10 | per-task model escalation + shared `sensitivity` | dsba | `c0a7622` |
| P7 | adversarial verify (2 slices; 3-lens verified pre-commit) | dsba | `bee251f`, `c350199` |
| P9 | STATUS.md resume artifact + dashboard determinism | dsba | `d56bef8` |
| P6 | safe Cloud Run deploy helper | `feat/harness-safe-deploy-from-tbfc` (the-creator) | `65fb1fa` |
| P2 | `progress.json` single-source generator | `feat/harness-skills-from-tbfc` (projects-spine) | `06b90ea` |
| P8 | GHL build-path selector (automation-first) | `feat/harness-skills-from-tbfc` | `5e7b443` |
| P11 | pre-compaction memory capture + filing (NEW skill) | `feat/harness-skills-from-tbfc` | `c55a825` |

**Operator follow-ups (gated, not auto-applied):** P11 `install.mjs --apply` (edits
settings.json); P8 install-copy to `~/.claude/skills` + the-creator API-doctrine
clause; open PRs for the 4 branches.

---

## P1 — Robust secret access (biggest time sink) — repo: `vault`
**Stall:** gcloud daily reauth (`invalid_rapt`) blocked secret reads; the Node SM SDK
**hung** on gRPC (Windows); the gcloud CLI hung on non-interactive reauth; failures were
silent 90s timeouts, not errors.
**Do:** in `vault.mjs`, add `getSecretFast(name, {project})` that (a) runs a <2s auth
**preflight** and, on a reauth/`invalid_rapt` error, throws immediately with the exact
remedy (`gcloud auth login --force`); (b) prefers the **gcloud CLI** over the SM SDK on
win32 (CLI worked, SDK hung), SDK as fallback; (c) caches the resolved token in-process.
Keep `loadSecrets`/`getSecret` unchanged (add, don't replace).
**Accept:** a unit/integration test shows the reauth path fails fast with the remedy
string; existing callers unaffected.

## P2 — One progress source → generate STATUS + dashboard + PR body — repo: `skill` (+ `dsba`)
**Stall:** three views kept in sync by hand; the dashboard needed fragile string-replace
"bump" scripts that broke when a badge's assumed state was wrong.
**Do:** define `progress.json` (task→status, gate→cleared, live URLs). Write an
**idempotent generator** that renders `plan-visualization.html`, `STATUS.md`, and a PR-body
snippet from `progress.json` + the parsed plan. Updating a status = edit json + regen (no
HTML surgery). Fold into the harness-local-dashboard skill.
**Accept:** regenerating twice from the same json yields identical output; changing one
task's status updates all three views correctly.

## P3 — Fail loud on plan-schema drift — repo: `dsba` (`src/parser.ts`)
**Stall:** `deps` vs `depends_on`, `project:` scalar vs block, misnested
`commit_after_each_task` all failed **silently**.
**Do:** extend the existing warnings (feat/plan-schema-warnings) to a **strict mode**:
unknown/misplaced keys are errors (opt-in flag first, default-on after a soak); assert the
phase-6→7 launch-gate prefix. Keep `--dry-run` behavior; add `--strict`.
**Accept:** a plan with a wrong key fails `--strict` with the key named + the correct key
suggested; a clean plan passes.

## P4 — Reusable live-read tooling per platform — repo: `dsba` (or `vault`/shared)
**Stall:** every acceptance read-back needed a bespoke script (GHL inventory, create-field,
Cloud Run describe, DataSphere fetch-campaigns).
**Do:** a small `tools/verify/` library: `ghl.inventory()/upsertField()`,
`datasphere.campaignState()`, `cloudrun.revisionReady()`. Each reads a secret via P1,
sends the P5 client, returns structured data. Port the TBFC ad-hoc scripts
(`ghl-inventory.mjs`, `ghl-create-fields.mjs`) as the seed.
**Accept:** "prove it by live read" is a library call in a task; the TBFC scripts are
replaced by calls to it.

## P5 — Bake recurring API quirks into the default HTTP client — repo: `dsba`/`vault`
**Stall:** Cloudflare **1010** (browser-UA) and DataSphere's **"200 can be a rejection,
parse the body"** both recur (they have their own fix-skills).
**Do:** a default `httpJson()` helper that sends a browser UA and returns
`{ok, parsed, detail}` using a parse-the-body success rule. Used by P4.
**Accept:** a request that would 1010 succeeds; a 200-with-error-event is reported as a
failure.

## P6 — New-service- and PS-5.1-safe deploy helper — repo: `creator`/`dsba`
**Stall:** `--no-traffic` is invalid when *creating* a Cloud Run service; PowerShell 5.1
turns a native command's stderr (`gcloud … describe` on a missing service) into a
*terminating* error.
**Do:** a shared deploy step that branches new-vs-existing (new → `--no-allow-unauthenticated`;
existing → `--no-traffic --tag`) and uses `run services list --filter` (never `describe`)
for presence checks; a clean-SHA guard.
**Accept:** deploying a brand-new service and a redeploy both succeed non-interactively.

## P7 — Adversarial verification as a standard acceptance phase — repo: `dsba` (orchestrator)
**Stall:** the security review caught two real Medium bugs (client-trusted consent
timestamp; `startsWith` path-traversal) that unit tests passed over; the 3.5 compliance
audit caught a missing CAN-SPAM footer.
**Do:** for tasks flagged `sensitivity: security|compliance|send`, the orchestrator
auto-spawns an adversarial verify pass against the acceptance before marking done.
**Accept:** a sensitive task cannot be marked done without a verify pass on record.

## P8 — Drive GHL by browser automation where reliable; apply-pack as fallback — repo: skill/creator
**Stall:** GHL workflows were treated as strictly UI-only → human apply-pack, but
`ghl-workflow-browser-automation` shows a full workflow built live via claude-in-chrome.
**Do:** the GHL builder attempts browser-driven builds first (per that skill); apply-pack
only when the SPA resists. Turns several human gates into agent work.
**Accept:** a workflow is built via automation in a test location; fallback path documented.

## P9 — STATUS.md as a first-class, auto-updated resume artifact — repo: `dsba`/skill
**Stall:** frequent commits + a live STATUS doc were what made a long, context-heavy build
survivable across compaction.
**Do:** the harness writes/refreshes a resume-point doc after each task (part of P2's
generator). New session / post-compaction resumes from it.
**Accept:** after a task completes, STATUS reflects it without a manual edit.

## P10 — Per-task model escalation by risk — repo: `dsba` (orchestrator/verifier)
**Stall:** some haiku/sonnet assignments were fine; compliance/security/secret/send tasks
deserved a stronger model + the P7 verify.
**Do:** the verifier escalates the model when a task's `sensitivity` touches consent, money,
secrets, or a live send.
**Accept:** a sensitive task runs at the escalated tier; a routine one does not.

---

## Sequencing note
Do these **after** the TBFC build reaches its human-gate wall (it is ~3 items away). The
shared tools (`vault`, dashboard skill) are used by other projects, so every change is
additive + tested + committed on its own; nothing here rewrites a working path in place.
Branch: `feat/harness-improvements-from-tbfc`.
