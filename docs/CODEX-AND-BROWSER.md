# Codex executor + headless browser (Playwright MCP)

Two capabilities added to the harness, wired through the same dispatch seam the
Claude runner already uses.

## TL;DR reality check (read this first)

The original ask was "wire OpenAI Codex in so the build clicks in the browser
better." Two facts shaped what actually got built:

1. **The Codex CLI (`@openai/codex`) is a coding agent, not a browser tool.** It
   competes with Claude Code. Wiring it in gives you a *second coding brain*, not
   better clicking.
2. **Codex's real "computer use" (clicking a browser) lives in the Codex desktop
   app and, on Windows, is *foreground-only* — it takes over the actual screen.**
   That cannot run headless in the unattended Cloud Run fleet.

So "better browser clicking in the autonomous build" is delivered by a **headless
browser MCP (Playwright)** plugged into the agent — not by Codex. Both were
wired:

- **`executor: codex`** — build a task through `codex exec` instead of the Claude
  Agent SDK (the second coding brain, for A/B or fallback).
- **`browser: true`** — hand a build task a real headless Chromium via the
  Playwright MCP server (navigate / click / type / fill), in the fleet.

---

## A) Headless browser — `browser: true`

Add `browser: true` to any build task. The agent then gets a Playwright MCP
server (key `playwright`) and the `mcp__playwright__*` tool allow-pattern, on top
of whatever run-level integrations (e.g. GHL) are already present. Ordinary tasks
never boot a browser.

```yaml
- id: e2e
  title: Drive the signup flow
  browser: true
  prompt: Open the app, click through signup, confirm the success page renders.
```

**Runtime:** by default the server launches via
`npx -y @playwright/mcp@latest --headless --isolated`. `--isolated` uses a
throwaway profile so no logged-in state leaks between builds. Override with:

| Env var                   | Effect                                                        |
| ------------------------- | ------------------------------------------------------------ |
| `PLAYWRIGHT_MCP_COMMAND`  | Executable that starts the MCP server (default `npx`).       |
| `PLAYWRIGHT_MCP_ARGS`     | Space-split args (default the pinned headless/isolated line). |

**Deployment note (fleet):** the container needs Chromium + its system libs.
`Dockerfile.job` (node:24-slim) does **not** ship them. To run browser tasks in
the cloud, add a layer:

```dockerfile
RUN npx -y playwright@latest install --with-deps chromium
```

Locally, run `npx playwright install chromium` once.

**Scope:** `browser: true` is honored by the **Claude** runner. A `codex` task
that sets it is warned and run without the browser (Codex MCP wiring is not part
of this cut). The adversarial verify pass stays browser-free (read-only).

---

## B) Codex executor — `executor: codex`

A `codex` task is a first-class **build** task: it counts toward the launch gate,
commits after success, and — when `sensitivity` flags it — is adversarially
verified by a Claude reviewer, exactly like an `agent` task. Only the coding
brain differs.

```yaml
- id: api
  title: Implement the API layer
  executor: codex
  model: gpt-5-codex        # a real Codex model; a Claude tier (opus/sonnet) is ignored here
  deps: [scaffold]
  prompt: Implement the REST handlers from the brief.
```

**Install:** `npm i -g @openai/codex` (or set `CODEX_BIN` to a pinned binary).
Fleet: add `RUN npm i -g @openai/codex` to `Dockerfile.job`.

**Auth:** a Codex login, or `CODEX_API_KEY` / `OPENAI_API_KEY` in the env. A
missing binary or key fails that task **soft** (a `failed` result with an
actionable message) — it never crashes the run.

**Invocation** (built by `buildCodexArgs`, all deterministic):
```
codex exec --json --skip-git-repo-check --sandbox workspace-write -C <repo> [-m <model>] "<prompt>"
```

| Env var          | Effect                                                              |
| ---------------- | ------------------------------------------------------------------ |
| `CODEX_BIN`      | Path/name of the codex binary (default `codex`).                   |
| `CODEX_MODEL`    | Model when a task doesn't set a (non-Claude) `model`.              |
| `CODEX_SANDBOX`  | Sandbox mode (default `workspace-write`; e.g. `read-only`).        |

### Known limitations (not hidden)

- **Cost is out of band.** The Codex CLI does not report a USD cost, so a codex
  task leaves `usage` undefined. The harness's per-run **USD cost cap brakes
  Anthropic spend only** — it does not see OpenAI spend. Bound codex spend on the
  OpenAI side or by task count. (Token counts, when Codex reports them, are
  parsed; the dollar figure is not.)
- **Scope tracking.** Codex writes go through its own sandboxed shell, so the
  Write/Edit `scope:` boundary (which observes Claude tool calls) does not see
  them — same documented gap as Bash-only writes.
- **No browser.** See (A).

---

## Where it lives

| File               | Role                                                              |
| ------------------ | ----------------------------------------------------------------- |
| `src/prompt.ts`    | SDK-free prompt composition, shared by both runners.              |
| `src/integrations.ts` | MCP config union (http + **stdio**), `browserIntegration`, `composeAgentIntegrations`. |
| `src/codex.ts`     | `runTaskCodex` + pure `buildCodexArgs` / `codexModel` / `parseCodexResult`. |
| `src/agent.ts`     | Claude runner; folds in the browser per task via the shared seam. |
| `src/orchestrator.ts` | Routes `codex` → Codex runner; treats `agent`/`codex` as build tasks. |
| `src/parser.ts` / `src/types.ts` | `codex` executor + `browser` opt-in in the plan schema. |
| `checks/codex.test.mjs`, `checks/browser.test.mjs` | Unit coverage (18 tests, SDK-free). |

Try it: `node dist/index.js examples/codex-browser.plan.yaml --dry-run`.
