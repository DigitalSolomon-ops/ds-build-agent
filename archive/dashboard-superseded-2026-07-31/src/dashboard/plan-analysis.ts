/**
 * Structural analysis of a BuildPlan for the dashboard's plan view.
 * This is static (no run state): phase ordering, executor tallies, and the
 * launch-gate structure — all derivable from the plan alone. It mirrors the
 * gate logic in orchestrator.ts / state-writer.ts.
 */
import type { BuildPlan, Executor, Task } from "../types.js";

export const NO_PHASE = "(no phase)";

export interface PlanView {
  name: string;
  description?: string;
  stack?: string[];
  model?: string;
  policy: {
    commitAfterEachTask: boolean;
    gatePhase?: string;
    gatedPhase?: string;
  };
  executorCounts: Record<Executor, number>;
  /** Phases in first-appearance order, each with its tasks. */
  phases: { phase: string; tasks: Task[] }[];
  gate: GateStructure;
  taskIds: string[];
}

export interface GateStructure {
  enabled: boolean;
  gatePhase?: string;
  gatedPhase?: string;
  /** Agent tasks in the gate phase that must succeed for the gate to open. */
  gateAgentTaskIds: string[];
  /** Human/ghl tasks in the gate phase — their presence keeps the gate closed
   *  in an autonomous run (recorded by hand). */
  gateHumanTaskIds: string[];
  /** Tasks held behind the gate (in the gated phase). */
  gatedTaskIds: string[];
  /** Structurally, can this gate ever open autonomously? */
  canOpenAutonomously: boolean;
}

export function analyzePlan(plan: BuildPlan): PlanView {
  const phaseOrder: string[] = [];
  const byPhase = new Map<string, Task[]>();
  const executorCounts: Record<Executor, number> = { agent: 0, human: 0, ghl: 0 };

  for (const t of plan.tasks) {
    const phase = t.phase ?? NO_PHASE;
    if (!byPhase.has(phase)) {
      byPhase.set(phase, []);
      phaseOrder.push(phase);
    }
    byPhase.get(phase)!.push(t);
    executorCounts[t.executor]++;
  }

  return {
    name: plan.name,
    description: plan.description,
    stack: plan.stack,
    model: plan.model,
    policy: {
      commitAfterEachTask: plan.policy.commitAfterEachTask,
      gatePhase: plan.policy.gatePhase,
      gatedPhase: plan.policy.gatedPhase,
    },
    executorCounts,
    phases: phaseOrder.map((phase) => ({ phase, tasks: byPhase.get(phase)! })),
    gate: gateStructure(plan),
    taskIds: plan.tasks.map((t) => t.id),
  };
}

export function gateStructure(plan: BuildPlan): GateStructure {
  const { gatePhase, gatedPhase } = plan.policy;
  if (gatePhase === undefined) {
    return {
      enabled: false,
      gateAgentTaskIds: [],
      gateHumanTaskIds: [],
      gatedTaskIds: [],
      canOpenAutonomously: false,
    };
  }
  const inGate = (t: Task) => !!t.phase?.startsWith(gatePhase);
  const gateAgentTaskIds = plan.tasks.filter((t) => inGate(t) && t.executor === "agent").map((t) => t.id);
  const gateHumanTaskIds = plan.tasks.filter((t) => inGate(t) && t.executor !== "agent").map((t) => t.id);
  const gatedTaskIds = plan.tasks
    .filter((t) => gatedPhase !== undefined && t.phase?.startsWith(gatedPhase))
    .map((t) => t.id);
  return {
    enabled: true,
    gatePhase,
    gatedPhase,
    gateAgentTaskIds,
    gateHumanTaskIds,
    gatedTaskIds,
    // The orchestrator only opens the gate when there are zero human/ghl gate
    // tasks; a human sign-off in the gate phase keeps it permanently closed.
    canOpenAutonomously: gateHumanTaskIds.length === 0,
  };
}
