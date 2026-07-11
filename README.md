# ds-build-agent

Digital Solomon's orchestration harness. It takes an **application build plan**
and dispatches **Claude agents** to execute it — one agent per task, running in
dependency order with bounded concurrency, editing files directly in a target
repo folder.

This is the "code that runs agents" layer: `Claude guides the plan → this
harness dispatches Claude Code agents to build it → GitHub stores the result.`

## How it works

```
build-plan.yaml ──▶ parse ──▶ task graph ──▶ orchestrate ──▶ Claude agents ──▶ your app repo
                                  │                              │
                          deps + acceptance          per-task cwd, model, tools
```

1. **Plan** — a YAML file describing the app, the approved stack, house
   conventions, and a list of tasks (each with `id`, `deps`, `brief`,
   `acceptance`). See [`examples/lead-capture.plan.yaml`](examples/lead-capture.plan.yaml).
2. **Parser** ([src/parser.ts](src/parser.ts)) — validates the plan, checks
   dependency references, and rejects cycles.
3. **Orchestrator** ([src/orchestrator.ts](src/orchestrator.ts)) — runs each
   task once its dependencies succeed, up to `--concurrency` at a time. If a
   dependency fails, its dependents are skipped rather than built on a broken
   foundation.
4. **Agent** ([src/agent.ts](src/agent.ts)) — wraps the Claude Agent SDK
   `query()`; each task gets the shared stack context + its own brief, and
   builds headlessly (`permissionMode: "acceptEdits"`).

## Setup

Requires **Node.js 18+** and an Anthropic API key.

```powershell
cd C:\Users\marcu\ds-build-agent
npm install
$env:ANTHROPIC_API_KEY = "sk-ant-..."   # the Agent SDK authenticates via API key
npm run build
```

## Run

```powershell
node dist/index.js examples\lead-capture.plan.yaml --out .\builds --concurrency 3
```

- `<plan.yaml>` — the build plan (required, first positional arg).
- `--out <dir>` — where to build (default `./builds`). The app is created under
  `<out>/<plan-name>/`.
- `--concurrency <n>` — max tasks running at once (default 3).

The process exits non-zero if any task failed or was skipped.

## Writing a build plan

```yaml
name: my-app
description: One paragraph on what the app is.
stack:
  - "Front end: ..."
conventions:
  - "House rule every agent follows."
model: sonnet            # opus | sonnet | haiku, per task or plan-wide
tasks:
  - id: scaffold
    title: Project scaffold
    brief: What to build, in prose.
    acceptance:
      - "A concrete, checkable criterion."
  - id: feature-x
    deps: [scaffold]     # runs only after scaffold succeeds
    brief: ...
```

## Notes & next steps

- **Auth:** the Agent SDK uses `ANTHROPIC_API_KEY` (not a claude.ai
  subscription login).
- **Git:** the harness does not commit for you yet. Natural next step: run
  `git init` in the target folder and commit per successful task so work is
  recoverable (matches the "GitHub records" principle).
- **Make.com trigger:** because it's headless, a Make webhook or a scheduled
  job can invoke `ds-build` to kick off a build — the intended orchestration
  pattern for the stack.
