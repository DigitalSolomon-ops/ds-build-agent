/**
 * Core types for the Digital Solomon build-agent harness.
 *
 * A build plan describes an application to build as a graph of tasks.
 * The orchestrator dispatches one Claude agent per *agent* task, respecting
 * the dependency graph. Tasks owned by a human or configured in GoHighLevel
 * are not built by an agent — they are recorded to a handoff doc and treated
 * as deferred so agent work can proceed against placeholders.
 */

/** Who performs a task. */
export type Executor = "agent" | "human" | "ghl";

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
}
