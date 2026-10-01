# ds-build-agent

Digital Solomon's orchestration harness. It takes an **application build plan**
and dispatches **Claude agents** to execute it — one agent per task, running in
dependency order with bounded concurrency, committing per task into a target
repo. Tasks only a human can do (mint a credential, sign a compliance approval)
are deferred to a handoff document instead of faked, so a build runs unattended
until it genuinely needs a person.

```
build-plan.yaml ──▶ parse ──▶ task graph ──▶ orchestrate ──▶ coding agents ──▶ your app repo
                                  │                              │
                          deps + acceptance          per-task cwd, model, tools,
                          + human gates              write scope, cost budget
```

## Safety rails (the actual point)

Autonomous agents with a repo and an API key need interlocking brakes, not
vibes. Four independent mechanisms:

- **Per-run cost cap** ([src/cost.ts](src/cost.ts)) — dispatch halts once the
  run's accumulated spend (including the verify agents' separate bill) reaches
  `max_run_usd`. There is deliberately no "no cap" option: an unbounded run is
  a footgun. Default $25.
- **Write-boundary enforcement** ([src/scope.ts](src/scope.ts)) — a task that
  wrote any file outside its declared globs is downgraded to *failed* **before**
  it commits or unblocks dependents. An agent briefed to touch one module
  can't wander into a live broker or a credentials file.
- **Adversarial verify** ([src/verify.ts](src/verify.ts)) — security/compliance/
  send-tagged tasks get a second, adversarial agent review. Fail-closed: a
  truncated or errored review reads as failure; only an explicit parsed PASS
  keeps the task green.
- **Launch gate** ([src/orchestrator.ts](src/orchestrator.ts)) — a plan phase
  can be gated on human sign-off; downstream work is *skipped*, not run, until
  the gate passes. `human`/`ghl` tasks are recorded to the handoff doc and
  marked `deferred`.

Plus a **gate battery** ([src/gate-battery.ts](src/gate-battery.ts)): static
analysis that tells the operator up front which human gates are front-loadable
and what fraction of the build then runs unattended.

The cloud job runs with `--max-retries 0` on purpose — a retried task would
double-apply a mutation that committed before a gateway error. Failure
propagates as skipped dependents, never as a blind re-run.

## How it works

1. **Plan** — YAML describing the app, approved stack, house conventions, and
   tasks (`id`, `deps`, `brief`, `acceptance`, optional `phase`, `owner`,
   `scope`). See [`examples/lead-capture.plan.yaml`](examples/lead-capture.plan.yaml).
2. **Parser** ([src/parser.ts](src/parser.ts)) — validates the plan, checks
   dependency references, rejects cycles, and fails loud on mistyped keys
   (`--strict`).
3. **Orchestrator** ([src/orchestrator.ts](src/orchestrator.ts)) — runs each
   task once its dependencies succeed, up to `--concurrency` at a time. A
   failed dependency skips its dependents rather than building on a broken
   foundation. Each successful task is committed to the target repo.
4. **Executors** — [src/agent.ts](src/agent.ts) wraps the Claude Agent SDK
   `query()` (headless, `permissionMode: "acceptEdits"`); tasks can instead
   route to the OpenAI Codex CLI ([src/codex.ts](src/codex.ts)) as a second
   coding brain. Model escalates by task risk ([src/model.ts](src/model.ts)).
5. **Integrations** ([src/integrations.ts](src/integrations.ts)) — MCP servers
   ride along per task: a headless Playwright browser (`browser: true`) and a
   GoHighLevel MCP endpoint scoped to one sub-account with tools narrowed to
   `mcp__ghl__*`.

## Running

Requires **Node.js 18+** and a Claude login.

```powershell
npm install
npm run build
npm link            # once: puts `ds-build` on your PATH
ds-build examples\lead-capture.plan.yaml --out .\builds --concurrency 3
```

### Auth: subscription by default

Local runs use your **Claude subscription**, not the API. Claude Code bills an
API key whenever one is in its environment, so the harness strips
`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from every agent it spawns. Nothing
is billed per token; usage counts against your plan's limits (watch them when
running `--concurrency 3` or more).

One-time setup, for unattended runs: create a long-lived subscription token and
store it as a user environment variable.

```powershell
& .\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe setup-token
[Environment]::SetEnvironmentVariable("CLAUDE_CODE_OAUTH_TOKEN", "<paste the token>", "User")
```

Open a new terminal afterwards. The harness refuses to start in subscription
mode when it finds neither that token nor a stored Claude Code login.

| Mode | When | Billing |
|---|---|---|
| `subscription` | default for local runs; `--subscription`; `DS_BUILD_AUTH=subscription` | your Claude plan |
| `api` | default inside Cloud Run (`solomon-runner`); `--api`; `DS_BUILD_AUTH=api` | `ANTHROPIC_API_KEY`, per token |

The `$` cost cap still applies in subscription mode. There it is the
API-equivalent cost, so it limits how much of your plan one run can use.

- `--repo <dir>` — build in-place into an existing repo.
- `--dashboard [path]` — emit an auto-updating local status page
  (`builds/<name>/dashboard.html`) with human gates surfaced as operator
  instructions.
- `--dry-run` — routing simulation; no agents, no spend.
- `--subscription` / `--api` — override the auth mode (see above).

Exit code is non-zero if any task failed or was skipped.

## Cloud

The same harness runs as the Cloud Run Job `solomon-runner`
([Dockerfile.job](Dockerfile.job), [cloudbuild-job.yaml](cloudbuild-job.yaml)),
launched and observed by the sibling `the-creator` control plane. Auth is
injected at runtime from Google Secret Manager — no key is baked into any
image. Run state streams to Firestore; artifacts land in GCS.

## Tests

```powershell
npm test
```

`node:test` suites cover the parser, orchestrator routing, scope enforcement,
verify verdict parsing, gate battery, cost accounting, codex + browser wiring,
and the state writer — all offline. CI runs them on every push.
