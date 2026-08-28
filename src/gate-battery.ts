/**
 * Gate-battery analysis (whetstone W1).
 *
 * The operator's goal: clear as many human gates as possible UP FRONT, then walk
 * away while the harness builds the rest in one unattended pass. This module
 * separates the gates that can be front-loaded from the ones that legitimately
 * must wait, and reports how much of the build runs with no human in the loop
 * once the front-loadable battery is cleared.
 *
 * A human/ghl task ("gate") is FRONT-LOADABLE when none of its transitive
 * dependencies is an agent task — nothing has to be built before the operator
 * can clear it. A gate that transitively depends on agent work is SEQUENTIAL:
 * it belongs after the build/verification (e.g. a live-arm behind the phase-6
 * launch gate), and front-loading it would defeat that safety ordering. This is
 * the honest line: the analysis front-loads everything that is safe to, and
 * leaves the genuinely-sequential gates where they are.
 *
 * Pure and side-effect-free, so it is unit-tested without running anything.
 */

import type { BuildPlan, Task } from "./types.js";

export interface GateBattery {
  /** Front-loadable gates (no agent task upstream), in plan order. Clear these first. */
  battery: Task[];
  /** Gates that transitively depend on agent work — the irreducible post-build returns. */
  sequentialGates: Task[];
  /**
   * Front-loadable gates authored AFTER the first agent task in plan order.
   * They need nothing built first, so they could be moved into the upfront
   * battery — a front-loading opportunity, not an error.
   */
  lateGates: Task[];
  /** Count of agent tasks that run unattended once only the battery is cleared. */
  unattendedAgentCount: number;
  /** Total agent tasks (the denominator for unattendedAgentCount). */
  totalAgentCount: number;
}

const isGate = (t: Task) => t.executor === "human" || t.executor === "ghl";
const isAgent = (t: Task) => t.executor === "agent";

/**
 * Does `task` transitively depend on any task for which `pred` is true?
 * Memoized DFS over the dependency graph; a missing dep id is skipped (the
 * parser has already rejected unknown deps and cycles by the time we run).
 */
function dependsOn(
  task: Task,
  byId: Map<string, Task>,
  pred: (t: Task) => boolean,
  memo: Map<string, boolean>,
): boolean {
  const cached = memo.get(task.id);
  if (cached !== undefined) return cached;
  memo.set(task.id, false); // cycle guard (defensive; parser rejects cycles)
  let result = false;
  for (const depId of task.deps ?? []) {
    const dep = byId.get(depId);
    if (!dep) continue;
    if (pred(dep) || dependsOn(dep, byId, pred, memo)) {
      result = true;
      break;
    }
  }
  memo.set(task.id, result);
  return result;
}

/** Analyze how front-loadable a plan's human gates are. */
export function analyzeGateBattery(plan: BuildPlan): GateBattery {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const memo = new Map<string, boolean>();
  const dependsOnAgent = (t: Task) => dependsOn(t, byId, isAgent, memo);

  const gates = plan.tasks.filter(isGate);
  const battery = gates.filter((g) => !dependsOnAgent(g));
  const sequentialGates = gates.filter((g) => dependsOnAgent(g));

  // "Late" = a front-loadable gate placed after the first agent task in plan
  // order. Deterministic and order-based (no fuzzy phase-string compare).
  const firstAgentIndex = plan.tasks.findIndex(isAgent);
  const indexOf = new Map(plan.tasks.map((t, i) => [t.id, i]));
  const lateGates =
    firstAgentIndex < 0
      ? []
      : battery.filter((g) => (indexOf.get(g.id) ?? 0) > firstAgentIndex);

  // An agent task runs unattended (after the battery is cleared) when it does
  // NOT transitively depend on a sequential gate and is not held behind the
  // launch gate's gated phase. Sequential gates are the only human waits left
  // once the battery is done; the launch gate is the other structural hold.
  const seqMemo = new Map<string, boolean>();
  const isSequentialGate = (t: Task) => sequentialGates.some((s) => s.id === t.id);
  const dependsOnSequentialGate = (t: Task) => dependsOn(t, byId, isSequentialGate, seqMemo);
  const gatedPhase = plan.policy.gatedPhase;
  const agentTasks = plan.tasks.filter(isAgent);
  const unattendedAgentCount = agentTasks.filter(
    (t) =>
      !dependsOnSequentialGate(t) &&
      !(gatedPhase !== undefined && t.phase?.startsWith(gatedPhase)),
  ).length;

  return {
    battery,
    sequentialGates,
    lateGates,
    unattendedAgentCount,
    totalAgentCount: agentTasks.length,
  };
}
