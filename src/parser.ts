import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { BuildPlan, DeployPolicy, Executor, Task } from "./types.js";

/** Thrown when a plan file is structurally invalid. */
export class PlanError extends Error {}

const EXECUTORS: Executor[] = ["agent", "human", "ghl"];

/** Load and validate a build plan from a YAML file on disk. */
export function loadPlan(path: string): BuildPlan {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (e) {
    throw new PlanError(`Could not read/parse plan at ${path}: ${(e as Error).message}`);
  }
  return validatePlan(raw);
}

/**
 * Validate an untyped object into a BuildPlan. Accepts two shapes:
 *  - flat:    top-level `name`/`stack`; tasks use `brief`
 *  - project: a `project:` block; tasks use `prompt`, `executor`, `auto`
 */
export function validatePlan(raw: unknown): BuildPlan {
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
    // Agent tasks default to auto:true unless explicitly disabled.
    auto: executor === "agent" ? task.auto !== false : false,
    phase: str(task.phase),
    deps: strArray(task.deps, `Task "${task.id}" \`deps\``),
    outputs: looseStrArray(task.outputs),
    acceptance: looseStrArray(task.acceptance),
    model: str(task.model),
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
