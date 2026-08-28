/**
 * Per-task model resolution + risk-based escalation. SDK-FREE on purpose (like
 * parser.ts): the checks/ drivers import the compiled module directly and must
 * not drag in the Agent SDK. Pure functions only — no I/O, no side effects.
 *
 * The rule: a task's model is `task.model ?? plan.model ?? DEFAULT_MODEL`, but a
 * task flagged with a sensitivity that touches consent, money, secrets, security,
 * compliance, or a live send is floored UP to a minimum tier. Escalation is a
 * monotonic max — an already-strong explicit model is never downgraded, and an
 * exact model string (a full id) is never rewritten to a bare alias.
 */

export type ModelTier = "haiku" | "sonnet" | "opus";

export const TIER_RANK: Record<ModelTier, number> = { haiku: 1, sonnet: 2, opus: 3 };

/** Canonical default model alias for build tasks — the home for this constant. */
export const DEFAULT_MODEL = "sonnet";

/**
 * Recognized risk tags → minimum tier. The UNION of P7 (security|compliance|send)
 * and P10 (consent|money|secrets|send) so both features read one `sensitivity`
 * field. A map (not a boolean) keeps the floor tunable per tag without touching
 * call sites. All map to opus today.
 */
export const SENSITIVITY_FLOOR: Record<string, ModelTier> = {
  consent: "opus",
  compliance: "opus",
  security: "opus",
  secrets: "opus",
  money: "opus",
  payment: "opus",
  send: "opus",
};

export const RECOGNIZED_SENSITIVITIES: ReadonlySet<string> = new Set(
  Object.keys(SENSITIVITY_FLOOR),
);

/**
 * Classify an alias OR a full model id by substring. Returns undefined for an
 * unknown/custom id — which the caller must NOT silently reinterpret.
 */
export function modelRank(model: string): number | undefined {
  const m = String(model || "").toLowerCase();
  if (m.includes("haiku")) return TIER_RANK.haiku;
  if (m.includes("sonnet")) return TIER_RANK.sonnet;
  if (m.includes("opus")) return TIER_RANK.opus;
  return undefined;
}

/** Strongest floor across a task's tags; undefined if none are recognized. */
export function sensitivityFloor(tags: string[] | undefined): ModelTier | undefined {
  if (!Array.isArray(tags)) return undefined;
  let best: ModelTier | undefined;
  let bestRank = 0;
  for (const t of tags) {
    const floor = SENSITIVITY_FLOOR[String(t).toLowerCase()];
    if (floor && TIER_RANK[floor] > bestRank) {
      best = floor;
      bestRank = TIER_RANK[floor];
    }
  }
  return best;
}

export interface ModelDecision {
  /** task.model ?? plan.model ?? DEFAULT_MODEL */
  base: string;
  /** base, or the escalated tier alias when a stronger floor applies */
  resolved: string;
  escalated: boolean;
  /** the strongest recognized floor, if any tag matched */
  floorTier?: ModelTier;
  tags: string[];
}

/** Full decision, for logging and tests. */
export function explainModel(
  task: { model?: string; sensitivity?: string[] },
  plan: { model?: string },
): ModelDecision {
  const tags = Array.isArray(task?.sensitivity) ? task.sensitivity.map(String) : [];
  const base = task?.model ?? plan?.model ?? DEFAULT_MODEL;
  const floor = sensitivityFloor(tags);
  if (!floor) return { base, resolved: base, escalated: false, tags };
  const b = modelRank(base);
  // Never touch a custom id; only escalate when the floor STRICTLY out-ranks base.
  if (b !== undefined && TIER_RANK[floor] > b) {
    return { base, resolved: floor, escalated: true, floorTier: floor, tags };
  }
  return { base, resolved: base, escalated: false, floorTier: floor, tags };
}

/** Drop-in replacement for `task.model ?? plan.model ?? DEFAULT_MODEL`. */
export function resolveModel(
  task: { model?: string; sensitivity?: string[] },
  plan: { model?: string },
): string {
  return explainModel(task, plan).resolved;
}
