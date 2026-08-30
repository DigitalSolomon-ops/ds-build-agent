/**
 * Per-run cost cap for the LOCAL CLI (parity with the cloud runner's B2 brake).
 *
 * The cloud runner (cloud-job.ts) has always enforced a run-level dollar cap by
 * summing reported per-task cost and telling the orchestrator to stop dispatching
 * once it crosses the cap. The local CLI did NOT — so a local `--repo` build ran
 * to completion regardless of spend. This resolves the same cap for the CLI.
 *
 * Precedence (highest wins): an explicit `--max-usd` flag, then the plan's
 * `deploy_policy.max_run_usd`, then the `MAX_RUN_USD` env, then a built-in floor.
 * Like the cloud, there is DELIBERATELY no "no cap" — an unbounded local run is a
 * footgun. To run effectively uncapped, pass a deliberately high `--max-usd`.
 */

export const DEFAULT_RUN_CAP_USD = 25;

/** Only a positive, finite number counts; anything else is ignored. */
function pos(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolve the run cap in USD. `flagRaw` is the `--max-usd` value (string|undefined),
 * `planCap` is `plan.policy.maxRunUsd`, `envRaw` is `process.env.MAX_RUN_USD`.
 */
export function resolveRunCapUsd(
  planCap: number | undefined,
  envRaw: string | undefined,
  flagRaw: string | undefined,
): number {
  return pos(flagRaw) ?? pos(planCap) ?? pos(envRaw) ?? DEFAULT_RUN_CAP_USD;
}

/**
 * Accumulate reported cost as task-done events land. The adversarial verify pass
 * is a SEPARATE agent with its own bill in `result.verify.usage` — counted too,
 * or a verify-heavy run under-counts. A task with no usage (deferred/skipped/
 * dry-run) adds nothing.
 */
export class CostAccumulator {
  private spent = 0;
  add(usageCost?: number, verifyCost?: number): void {
    if (typeof usageCost === "number" && Number.isFinite(usageCost)) this.spent += usageCost;
    if (typeof verifyCost === "number" && Number.isFinite(verifyCost)) this.spent += verifyCost;
  }
  get total(): number {
    return this.spent;
  }
  /** True once accumulated spend has reached the cap. */
  reached(cap: number): boolean {
    return this.spent >= cap;
  }
}
