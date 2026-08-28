import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { BuildPlan, DeployPolicy, Executor, Task } from "./types.js";
import { isBuildExecutor } from "./types.js";
import { RECOGNIZED_SENSITIVITIES } from "./model.js";

/** Thrown when a plan file is structurally invalid. */
export class PlanError extends Error {}

const EXECUTORS: Executor[] = ["agent", "codex", "human", "ghl"];

/** Options controlling how the warning pass surfaces its findings. */
export interface ValidateOptions {
  /**
   * Called with the full list of non-fatal warnings BEFORE any hard error is
   * thrown, so a caller can count them (for `--strict`) or gate on them even
   * when the plan then fails to load. Receives an empty array for a clean plan.
   */
  onWarnings?: (warnings: string[]) => void;
  /**
   * Suppress the default `console.warn` print of each warning. Off by default:
   * unknown keys are loud on stderr unless a caller opts to render them itself.
   */
  quiet?: boolean;
}

/** Load and validate a build plan from a YAML file on disk. */
export function loadPlan(path: string, opts: ValidateOptions = {}): BuildPlan {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (e) {
    throw new PlanError(`Could not read/parse plan at ${path}: ${(e as Error).message}`);
  }
  return validatePlan(raw, opts);
}

/**
 * Validate an untyped object into a BuildPlan. Accepts two shapes:
 *  - flat:    top-level `name`/`stack`; tasks use `brief`
 *  - project: a `project:` block; tasks use `prompt`, `executor`, `auto`
 *
 * Before validating, runs a non-fatal warning pass (`collectPlanWarnings`) that
 * names every key the harness does not read — a mistyped key (`depends_on` for
 * `deps`, a misplaced `commit_after_each_task`, a scalar `project`) is otherwise
 * dropped silently and never surfaces until someone hand-audits the plan. The
 * warnings are printed to stderr and handed to `opts.onWarnings`; they never
 * change what a valid plan parses to.
 */
export function validatePlan(raw: unknown, opts: ValidateOptions = {}): BuildPlan {
  const warnings = collectPlanWarnings(raw);
  if (!opts.quiet) for (const w of warnings) console.warn(`⚠ plan: ${w}`);
  opts.onWarnings?.(warnings);

  if (typeof raw !== "object" || raw === null) {
    throw new PlanError("Plan must be a YAML object.");
  }
  const p = raw as Record<string, unknown>;
  const project = (typeof p.project === "object" && p.project !== null
    ? (p.project as Record<string, unknown>)
    : p) as Record<string, unknown>;

  const name = project.name;
  if (typeof name !== "string" || !name.trim()) {
    throw new PlanError("Plan is missing a non-empty `name` (or `project.name`).");
  }
  if (!Array.isArray(p.tasks) || p.tasks.length === 0) {
    throw new PlanError("Plan must have a non-empty `tasks` list.");
  }

  const ids = new Set<string>();
  const tasks: Task[] = p.tasks.map((t, i) => parseTask(t, i, ids));

  // Every dep must reference a real task.
  for (const task of tasks) {
    for (const dep of task.deps ?? []) {
      if (!ids.has(dep)) {
        throw new PlanError(`Task "${task.id}" depends on unknown task "${dep}".`);
      }
    }
  }
  detectCycles(tasks);

  return {
    name,
    description: str(project.description) ?? str(project.model_note),
    stack: flattenStack(project.stack),
    conventions: strArray(project.conventions, "`conventions`"),
    model: str(project.model_id) ?? str(p.model),
    policy: parsePolicy(p.deploy_policy),
    tasks,
  };
}

// Every key the parser actually reads, per level. Anything a plan carries that
// is NOT on the matching list is dropped silently by the YAML load — so we name
// it. Keep these in lockstep with what validatePlan/parseTask/parsePolicy read.
const TOP_LEVEL_KEYS = new Set(["project", "name", "tasks", "model", "deploy_policy"]);
// When there is no `project:` block, project metadata lives at the top level
// (the `project = p` fallback), so these are legitimate top-level keys too.
const TOP_LEVEL_FALLBACK_KEYS = new Set([
  "stack",
  "conventions",
  "description",
  "model_id",
  "model_note",
]);
const PROJECT_BLOCK_KEYS = new Set([
  "name",
  "description",
  "model_note",
  "stack",
  "conventions",
  "model_id",
]);
const DEPLOY_POLICY_KEYS = new Set(["worker_defaults", "launch_gate", "max_run_usd"]);
const TASK_KEYS = new Set([
  "id",
  "phase",
  "executor",
  "model",
  "title",
  "prompt",
  "brief",
  "deps",
  "acceptance",
  "auto",
  "outputs",
  "sensitivity",
  "verify_model",
  "scope",
  "browser",
]);

/** Accept a scalar or a list; trim, lower-case, drop blanks. Undefined if empty. */
function normalizeSensitivity(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  const out = arr
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim().toLowerCase());
  return out.length ? out : undefined;
}

/**
 * Collect every key the harness will ignore, as human-readable warning strings.
 * Non-fatal by design: a plan may legitimately carry documentation keys (config,
 * gates, lane, portfolio, repo). This pass exists so a MISTYPED functional key —
 * the kind that silently voids a dependency edge or a rollback policy — is caught
 * automatically instead of during a hand audit. Pure: no printing, no throwing.
 */
export function collectPlanWarnings(raw: unknown): string[] {
  const warnings: string[] = [];
  if (typeof raw !== "object" || raw === null) return warnings; // hard error handled by validatePlan
  const p = raw as Record<string, unknown>;

  const hasProjectBlock = typeof p.project === "object" && p.project !== null;
  const projectIsScalar = "project" in p && !hasProjectBlock && p.project != null;

  // ── Top level ──
  const topAllow = new Set(TOP_LEVEL_KEYS);
  if (!hasProjectBlock) for (const k of TOP_LEVEL_FALLBACK_KEYS) topAllow.add(k);
  for (const key of Object.keys(p)) {
    if (key === "project" && projectIsScalar) {
      warnings.push("`project` is a scalar; did you mean a `project:` block with a `name:` field?");
      continue;
    }
    if (topAllow.has(key)) continue;
    warnings.push(`top-level key \`${key}\` is not read by the harness and will be ignored.`);
  }

  // ── project: block ──
  if (hasProjectBlock) {
    const proj = p.project as Record<string, unknown>;
    for (const key of Object.keys(proj)) {
      if (PROJECT_BLOCK_KEYS.has(key)) continue;
      warnings.push(`\`project.${key}\` is not read by the harness and will be ignored.`);
    }
  }

  // ── deploy_policy: ──
  if (typeof p.deploy_policy === "object" && p.deploy_policy !== null) {
    const dp = p.deploy_policy as Record<string, unknown>;
    for (const key of Object.keys(dp)) {
      if (DEPLOY_POLICY_KEYS.has(key)) continue;
      if (key === "commit_after_each_task") {
        warnings.push(
          "`deploy_policy.commit_after_each_task` is ignored here; nest it under `worker_defaults:`.",
        );
        continue;
      }
      warnings.push(`\`deploy_policy.${key}\` is not read by the harness and will be ignored.`);
    }
  }

  // ── per-task ──
  if (Array.isArray(p.tasks)) {
    p.tasks.forEach((t, i) => {
      if (typeof t !== "object" || t === null) return;
      const task = t as Record<string, unknown>;
      const label = typeof task.id === "string" && task.id.trim() ? task.id : `#${i}`;
      for (const key of Object.keys(task)) {
        if (TASK_KEYS.has(key)) continue;
        if (key === "depends_on") {
          warnings.push(`task "${label}": \`depends_on\` is ignored — did you mean \`deps\`?`);
          continue;
        }
        warnings.push(`task "${label}": key \`${key}\` is not read by the harness and will be ignored.`);
      }
      // Loud-on-drift for sensitivity VALUES (the key itself is recognized above):
      // an unrecognized tag floors nothing / gates nothing, so name it.
      const sens = normalizeSensitivity(task.sensitivity);
      if (sens) {
        const unknown = sens.filter((tag) => !RECOGNIZED_SENSITIVITIES.has(tag));
        if (unknown.length) {
          warnings.push(
            `task "${label}": unrecognized sensitivity ${JSON.stringify(unknown)} — ` +
              `recognized: ${[...RECOGNIZED_SENSITIVITIES].join(", ")}.`,
          );
        }
      }
    });
  }

  // ── launch-gate integrity ──
  // A declared `launch_gate` hardcodes the 6→7 phase gate (see parsePolicy): the
  // gate WAITS on agent tasks whose phase starts with "6" and HOLDS tasks whose
  // phase starts with "7". If the plan carries the key but no task sits in the
  // gate phase (or the gated phase), the gate silently protects nothing — the
  // exact class of error this pass exists to catch. Prefixes match parsePolicy.
  if (
    typeof p.deploy_policy === "object" &&
    p.deploy_policy !== null &&
    (p.deploy_policy as Record<string, unknown>).launch_gate !== undefined &&
    Array.isArray(p.tasks)
  ) {
    const GATE_PHASE = "6";
    const GATED_PHASE = "7";
    const phaseOf = (t: unknown): string =>
      typeof t === "object" && t !== null && typeof (t as Record<string, unknown>).phase === "string"
        ? ((t as Record<string, unknown>).phase as string)
        : "";
    // Executor defaults to "agent" when absent (parseTask), so a missing executor
    // counts as a build task — the same rule the gate enforcement uses. `codex`
    // is a build executor too, so it counts toward the gate exactly like `agent`.
    const isAgent = (t: unknown): boolean => {
      if (typeof t !== "object" || t === null) return false;
      const e = (t as Record<string, unknown>).executor ?? "agent";
      return e === "agent" || e === "codex";
    };
    const hasGateAgentTask = p.tasks.some((t) => phaseOf(t).startsWith(GATE_PHASE) && isAgent(t));
    const hasGatedTask = p.tasks.some((t) => phaseOf(t).startsWith(GATED_PHASE));
    if (!hasGateAgentTask) {
      warnings.push(
        `\`deploy_policy.launch_gate\` is declared but no agent task has a phase starting with ` +
          `"${GATE_PHASE}"; the ${GATE_PHASE}→${GATED_PHASE} launch gate would gate nothing.`,
      );
    }
    if (!hasGatedTask) {
      warnings.push(
        `\`deploy_policy.launch_gate\` is declared but no task has a phase starting with ` +
          `"${GATED_PHASE}"; nothing sits behind the launch gate.`,
      );
    }
  }

  return warnings;
}

function parseTask(t: unknown, i: number, ids: Set<string>): Task {
  if (typeof t !== "object" || t === null) {
    throw new PlanError(`Task #${i} must be an object.`);
  }
  const task = t as Record<string, unknown>;
  if (typeof task.id !== "string" || !task.id.trim()) {
    throw new PlanError(`Task #${i} is missing a non-empty \`id\`.`);
  }
  if (ids.has(task.id)) {
    throw new PlanError(`Duplicate task id: "${task.id}".`);
  }
  ids.add(task.id);

  const brief = str(task.prompt) ?? str(task.brief);
  if (!brief) {
    throw new PlanError(`Task "${task.id}" is missing a non-empty \`prompt\`/\`brief\`.`);
  }

  let executor: Executor = "agent";
  if (task.executor !== undefined) {
    if (!EXECUTORS.includes(task.executor as Executor)) {
      throw new PlanError(
        `Task "${task.id}" has invalid executor "${String(task.executor)}" ` +
          `(expected one of ${EXECUTORS.join(", ")}).`,
      );
    }
    executor = task.executor as Executor;
  }

  return {
    id: task.id,
    title: str(task.title) ?? task.id,
    brief,
    executor,
    // Build tasks (agent | codex) default to auto:true unless explicitly disabled.
    auto: isBuildExecutor(executor) ? task.auto !== false : false,
    phase: str(task.phase),
    deps: strArray(task.deps, `Task "${task.id}" \`deps\``),
    outputs: looseStrArray(task.outputs),
    acceptance: looseStrArray(task.acceptance),
    model: str(task.model),
    sensitivity: normalizeSensitivity(task.sensitivity),
    verifyModel: str(task.verify_model),
    scope: strArray(task.scope, `Task "${task.id}" \`scope\``),
    // Opt-in headless browser (Claude runner). Only a literal `true` enables it.
    browser: task.browser === true ? true : undefined,
  };
}

function parsePolicy(raw: unknown): DeployPolicy {
  const d = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const workerDefaults = (typeof d.worker_defaults === "object" && d.worker_defaults !== null
    ? d.worker_defaults
    : {}) as Record<string, unknown>;
  return {
    commitAfterEachTask: workerDefaults.commit_after_each_task === true,
    // If the plan declares a launch_gate, enforce the 6→7 phase gate used by
    // the FastIG plan. Presence of the key is the switch; the prefixes are fixed.
    gatePhase: d.launch_gate !== undefined ? "6" : undefined,
    gatedPhase: d.launch_gate !== undefined ? "7" : undefined,
    // Optional per-plan cost cap; only a positive finite number counts.
    maxRunUsd:
      typeof d.max_run_usd === "number" && Number.isFinite(d.max_run_usd) && d.max_run_usd > 0
        ? d.max_run_usd
        : undefined,
  };
}

/** Depth-first cycle detection over the dependency graph. */
function detectCycles(tasks: Task[]): void {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, "visiting" | "done">();

  const visit = (id: string, trail: string[]): void => {
    const s = state.get(id);
    if (s === "done") return;
    if (s === "visiting") {
      const cycle = [...trail.slice(trail.indexOf(id)), id].join(" → ");
      throw new PlanError(`Dependency cycle detected: ${cycle}`);
    }
    state.set(id, "visiting");
    for (const dep of byId.get(id)!.deps ?? []) visit(dep, [...trail, id]);
    state.set(id, "done");
  };

  for (const t of tasks) visit(t.id, []);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Strict: must be a list of strings if present. */
function strArray(v: unknown, label: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new PlanError(`${label} must be a list of strings.`);
  }
  return v as string[];
}

/** Lenient: accept a string, a list, or a comma-list; stringify entries. */
function looseStrArray(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
  return [String(v)];
}

/** The FastIG `stack` is a map of role->tool; flatten to readable lines. */
function flattenStack(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>).map(
      ([role, tool]) => `${role}: ${Array.isArray(tool) ? tool.join(", ") : String(tool)}`,
    );
  }
  return [String(v)];
}
