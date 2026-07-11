# Digital Solomon — Agent Build Harness (Handoff for Claude Chat)

Paste this into Claude (chat) so it understands how our autonomous build system
works and can hand well-formed **build plans** to Claude Code, which runs them.

---

## 1. What this system is

An **orchestration harness**: it reads an application **build plan** (a YAML
file) and dispatches **Claude agents** — one per task — to write the actual
code, in dependency order, into a target folder.

The division of labor (matches our standard flow *Claude guides → Claude Code
executes → GitHub records*):

- **Claude Chat (you):** author the build plan in the schema below. This is the
  "plan and brief" step.
- **Claude Code + harness:** executes the plan — spawns an agent per task,
  builds files, (optionally) commits per task.
- **Human / GoHighLevel:** tasks the harness can't do itself (signups, DNS,
  GHL UI config) are written to handoff docs for a person to complete.

---

## 2. Where the files are

| What | Path |
|---|---|
| **Harness project (the code that runs agents)** | `C:\Users\marcu\ds-build-agent` |
| Harness source | `ds-build-agent\src\` (`types.ts`, `parser.ts`, `agent.ts`, `orchestrator.ts`, `index.ts`) |
| Compiled output (what actually runs) | `ds-build-agent\dist\` |
| Example plan (simple schema) | `ds-build-agent\examples\lead-capture.plan.yaml` |
| **Build plans live anywhere**; current one | `C:\Users\marcu\Downloads\fastig-plan.yaml` |
| **Build outputs (the app the agents write)** | `ds-build-agent\builds\<plan-name>\` |
| Current build output | `ds-build-agent\builds\fast-insurance-group\` |
| Human to-do handoff | `builds\<plan-name>\BLOCKERS.md` |
| GHL setup handoff | `builds\<plan-name>\GHL-SETUP.md` |

Environment: **Node 24** at `C:\Program Files\nodejs` (not on the persistent
PATH — prepend it per command). **git is NOT installed** yet, so the
`commit_after_each_task` policy no-ops until it is.

---

## 3. Build-plan format (what Claude Chat should produce)

A plan is one YAML file. Two shapes are accepted; use the **project shape**
below for real builds.

```yaml
project:
  name: fast-insurance-group        # kebab-case; also the output folder name
  domain: example.com
  stack:                            # a role->tool map (or a plain list)
    site_and_crm: gohighlevel
    orchestration: make.com
    ai_calls: vapi
  # model_id: sonnet                # optional: sonnet | opus | haiku (default sonnet)

deploy_policy:
  worker_defaults:
    commit_after_each_task: true    # git commit after each successful agent task
  launch_gate: true                 # presence enables the phase-6 -> phase-7 gate
  secrets: never write API keys into source; use .env + GHL Custom Values

tasks:
  - id: p1-scaffold                 # unique, kebab-case; referenced by deps
    phase: "1-site"                 # grouping label; drives the launch gate
    executor: agent                 # agent | human | ghl
    auto: true                      # true only for agent tasks the harness may build
    title: Scaffold static funnel project
    prompt: >-                      # the instruction handed to the agent
      Scaffold a static HTML/CSS/JS funnel project embeddable in GHL...
    deps: []                        # ids that must resolve first (acyclic!)
    outputs: [src/, config placeholders]
    acceptance:                     # done-criteria the agent self-checks
      - "Project builds; placeholder config documented"
```

### Executor semantics (critical)

- **`executor: agent` + `auto: true`** → the harness spawns a Claude agent that
  builds this task in `builds\<plan-name>\`.
- **`executor: human`** → written to `BLOCKERS.md`, marked **deferred** (a
  person does it: signups, DNS, legal, ad accounts).
- **`executor: ghl`** → written to `GHL-SETUP.md`, marked **deferred**
  (configured in the GoHighLevel UI: custom fields, pipelines, workflows).

"Deferred" **counts as resolved**, so agent tasks are NOT blocked waiting on
human/GHL signups — as long as you follow the authoring rules below.

### The launch gate

If `deploy_policy.launch_gate` is present, tasks in **phase 7** may not run
until every **phase 6** agent task has succeeded. Because phase 6 typically
includes a human compliance sign-off task, phase-7 tasks are intentionally
**skipped in an autonomous run** — launch stays a human decision.

---

## 4. Rules Claude Chat MUST follow when authoring a plan

1. **Dependency graph must be acyclic**, and every `deps` id must exist.
2. **Agent tasks that can use placeholders must NOT depend on human/ghl account
   tasks.** Build against placeholder URLs/ids (e.g. GHL Custom Values, mock
   webhooks); a later dependent task swaps in real values. This keeps the build
   loop from stalling on signups.
3. **Never put secrets in prompts or source.** Instruct agents to use `.env`
   (git-ignored) + documented placeholders.
4. **Put things a person/GHL must do as `human`/`ghl` tasks**, not `agent`.
5. Group tasks with `phase` labels (`0-prereq`, `1-site`, ... `7-launch`); use
   phases `6-*` / `7-*` for compliance/launch so the gate protects them.

---

## 5. How the harness is run (Claude Code does this)

From `C:\Users\marcu\ds-build-agent`, with `ANTHROPIC_API_KEY` set and Node on PATH:

```powershell
# 1. Preview only — no agents, no writes, no cost. Shows order + routing + gate.
node dist/index.js <plan.yaml> --dry-run

# 2. Run specific tasks (safe, scoped; deps outside the set are pruned)
node dist/index.js <plan.yaml> --only p1-advertorial,p1-quote-funnel --out .\builds

# 3. Full run
node dist/index.js <plan.yaml> --out .\builds --concurrency 3
```

Flags: `--out <dir>` (default `.\builds`), `--concurrency <n>` (default 3),
`--dry-run`, `--only <id,id,...>`.

Result line reports: **built / deferred / skipped / failed** counts.

---

## 6. Current build status — fast-insurance-group

- Plan: **47 tasks**, 24 agent-built (22 run autonomously; 2 gated in phase 7),
  21 deferred to human/GHL, 4 skipped by the launch gate.
- **Phase 0:** prerequisites are `human`/`ghl` → belong in `BLOCKERS.md` /
  `GHL-SETUP.md` on a full run.
- **Phase 1 (site/funnel): 8 of 9 agent tasks built** — scaffold, advertorial,
  URL param capture, multi-step quote funnel, TCPA consent block, submission
  webhook, legal pages, dataLayer events. The `p1-acceptance` sweep was
  interrupted (no `PHASE1-REPORT.md` yet) and should be re-run.
- Output is in `builds\fast-insurance-group\` (funnel HTML/CSS/JS, `legal/`,
  `quote/`, `thank-you.html`, `.env.example`).
- **Phases 2–7 not yet run.**

---

## 7. Open items

- **Re-run `p1-acceptance`** to finish Phase 1 and get the report.
- **Install git** if you want per-task rollback commits (policy asks for it).
- **Rotate the Anthropic API key** that was pasted into the chat session.
- To continue: run Phase 2+ with `--only <phase ids>` or a full run.

---

## 8. How to ask for a NEW build (template for Claude Chat)

> "Author a build plan (project-shape YAML, per the DS harness schema) for
> `<app>`. Stack: `<...>`. Break it into phases; mark signups/DNS/legal as
> `human`, GHL UI config as `ghl`, and everything buildable as `agent`+`auto`.
> Keep agent tasks on placeholders so nothing waits on signups. Save it to a
> `.yaml` file. Then Claude Code dry-runs it and executes phase by phase."
