/**
 * Core types for the Digital Solomon build-agent harness.
 *
 * A build plan describes an application to build as a graph of tasks.
 * The orchestrator dispatches one Claude agent per *agent* task, respecting
 * the dependency graph. Tasks owned by a human or configured in GoHighLevel
 * are not built by an agent — they are recorded to a handoff doc and treated
 * as deferred so agent work can proceed against placeholders.
 */

/**
 * Who performs a task.
 * - agent:  a Claude agent, via the Anthropic Agent SDK (the default).
 * - codex:  a build agent run through the OpenAI Codex CLI (`codex exec`),
 *           an alternative coding brain. Built and gated exactly like an
 *           `agent` task (it counts toward the launch gate, commits, and is
 *           adversarially verified by a Claude reviewer when sensitive).
 * - human:  recorded to BLOCKERS.md and deferred.
 * - ghl:    recorded to GHL-SETUP.md and deferred.
 */
export type Executor = "agent" | "codex" | "human" | "ghl";

/** Executors the harness actually BUILDS with (dispatched, not deferred). */
export const BUILD_EXECUTORS: readonly Executor[] = ["agent", "codex"];

/** True for an executor the harness dispatches to a build runner. */
export function isBuildExecutor(e: Executor): boolean {
  return e === "agent" || e === "codex";
}

/** A single unit of work. */
export interface Task {
  /** Stable, unique identifier used to reference this task in `deps`. */
  id: string;
  /** Short human-readable title (shown in logs). */
  title: string;
  /**
   * The full instruction handed to the agent (from `prompt` or `brief`).
   * For non-agent tasks this becomes the handoff-doc description.
   */
  brief: string;
  /** Who owns this task. Defaults to "agent". */
  executor: Executor;
  /** True only for agent tasks the harness is allowed to deploy. */
  auto: boolean;
  /** Optional phase/grouping label (e.g. "1-site"). Used for the launch gate. */
  phase?: string;
  /** IDs of tasks that must be resolved before this one starts. */
  deps?: string[];
  /** Files/artifacts this task is expected to produce (logging + handoff docs). */
  outputs?: string[];
  /** Acceptance criteria the agent must satisfy before reporting done. */
  acceptance?: string[];
  /** Optional per-task model override (defaults to the plan/global model). */
  model?: string;
  /**
   * Opt this task into a headless browser. When true, the build agent is handed
   * a Playwright MCP server (navigate/click/type/fill against a real Chromium)
   * plus the `mcp__playwright__*` tool allow-pattern. Off by default so an
   * ordinary code task never boots a browser. Applies to `agent` and `codex`
   * build tasks; ignored for human/ghl tasks. See integrations.ts.
   */
  browser?: boolean;
  /**
   * Risk tags (e.g. "compliance", "send", "secrets"). ONE shared field: it floors
   * the model up (see model.ts) and gates the adversarial verify pass (P7, which
   * triggers on the subset in verify.ts VERIFY_TRIGGERS). See SENSITIVITY_FLOOR in
   * model.ts for the recognized vocabulary.
   */
  sensitivity?: string[];
  /** Optional model for THIS task's adversarial verify pass (defaults to opus). */
  verifyModel?: string;
  /**
   * Write-boundary. When set, this task may only write files matching one of
   * these globs; a successful agent task that wrote outside its scope is
   * downgraded to "failed" before it can commit or unblock dependents (see
   * scope.ts). Supports `*` (within a segment), `**` (across segments), exact
   * paths, and a trailing "/" for "this directory and everything under it".
   * Absent = unconstrained (the pre-scope behaviour), so existing plans are
   * unaffected. Enforcement observes the agent's Write/Edit tool calls; writes
   * made only through a Bash shell are not yet tracked (documented gap).
   */
  scope?: string[];
}

/** Machine-enforceable pieces of a plan's deploy policy. */
export interface DeployPolicy {
  /** Commit to git after each successful agent task (rollback points). */
  commitAfterEachTask: boolean;
  /**
   * Launch-gate phase prefixes. Tasks whose phase starts with `gatedPhase`
   * may not run until every AGENT task whose phase starts with `gatePhase`
   * has succeeded. Human sign-off in the gate phase keeps the gate closed
   * for autonomous runs (recorded manually).
   */
  gatePhase?: string;
  gatedPhase?: string;
  /**
   * Optional per-run cost cap in USD (`deploy_policy.max_run_usd`). When set, it
   * OVERRIDES the runner's default (the `MAX_RUN_USD` env / built-in fallback) for
   * this plan — the cloud runner stops dispatching new tasks once accumulated
   * reported cost reaches it. A safety brake, not a budget: absent means "use the
   * runner default", never "no cap".
   */
  maxRunUsd?: number;
}

/** The whole application build, top to bottom. */
export interface BuildPlan {
  /** Project name — also used as the default repo folder name. */
  name: string;
  /** One-paragraph description of what the app is. */
  description?: string;
  /** Target technology stack, injected into every agent's context. */
  stack?: string[];
  /** Free-form conventions every agent should follow. */
  conventions?: string[];
  /** Default model for all tasks unless a task overrides it. */
  model?: string;
  /** Machine-enforceable deploy policy. */
  policy: DeployPolicy;
  /** The tasks that make up the build. */
  tasks: Task[];
  /**
   * Operator write-back, threaded into every agent's shared context: answers
   * the operator gave to prior blockers, plus the names of documents they
   * attached. Populated by the cloud runner (cloud-job.ts) from Firestore +
   * Cloud Storage at the start of a run, so an agent sees the answer without
   * being told to go looking. Absent on a plain CLI run — a no-op when unset.
   */
  operatorContext?: string;
}

/**
 * What one agent task actually consumed, read off the Agent SDK's terminal
 * `result` message. Present only when an agent ran and reported — a deferred,
 * skipped, or dry-run task has no usage because nothing was spent.
 *
 * `undefined` means UNKNOWN, never zero. Anything that sums these must skip
 * absent values rather than coercing them, or a run with no telemetry reports
 * a confident $0.00 (Canon 2: one measure, and it says what it means).
 */
export interface TaskUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Dollars, as reported by the SDK (`total_cost_usd`). */
  costUsd: number;
  /** Agentic turns the task took (`num_turns`) — the shape of the loop. */
  turns: number;
}

/**
 * Record of an adversarial verify pass (P7). Attached to a sensitive task's
 * result. FAIL-CLOSED: `passed` is false unless an explicit PASS verdict was
 * parsed, so a truncated or confused verifier reads as failure, never a silent
 * pass. Its `usage` is the verify pass's OWN bill — kept separate from the build
 * usage so cost sums don't double-count.
 */
export interface VerifyRecord {
  passed: boolean;
  /** The verifier's one-line verdict (or why it failed to produce one). */
  verdict: string;
  /** Concrete issues raised (empty on a clean pass). */
  findings: string[];
  /** Which sensitivity tags triggered this pass. */
  triggeredBy: string[];
  /** Model the verifier ran at. */
  model: string;
  durationMs: number;
  /** The verify pass's own cost, separate from the build task's usage. */
  usage?: TaskUsage;
  /** ISO timestamp recorded. */
  at: string;
}

/** Result of resolving a single task. */
export interface TaskResult {
  taskId: string;
  /**
   * - success:  an agent built it and reported done
   * - deferred: a human/ghl task recorded to a handoff doc (counts as resolved)
   * - failed:   an agent task errored
   * - skipped:  a dependency failed, or the launch gate blocked it
   */
  status: "success" | "deferred" | "failed" | "skipped";
  /** The agent's final summary, or the handoff note. */
  summary?: string;
  /** Error or skip reason. */
  error?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /**
   * Tokens and dollars this task cost. Undefined for deferred/skipped/dry-run
   * tasks, and for an agent task that died before the SDK emitted a result.
   */
  usage?: TaskUsage;
  /**
   * Adversarial verify pass (P7). Present only for a sensitive agent task in a
   * real run. `status === "success"` for a sensitive task IMPLIES
   * `verify?.passed === true` — the gate downgrades it to "failed" otherwise.
   */
  verify?: VerifyRecord;
  /**
   * Repo-relative paths this task wrote, observed from the agent's Write/Edit
   * tool calls (scope.ts gates against them). Present only for an agent task in
   * a real run; undefined for deferred/skipped/dry-run. An empty array means
   * "ran but wrote nothing via Write/Edit" — not the same as unknown.
   */
  filesWritten?: string[];
}
