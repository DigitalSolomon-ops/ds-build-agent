/**
 * Launch-side airspace wiring, shared by the local CLI (index.ts) and the cloud
 * runner (cloud-job.ts): acquire every claim before the first task dispatches,
 * keep the lease alive by heartbeat, halt dispatch if the airspace is lost, and
 * release when the run ends. The registry logic itself lives in airspace.ts.
 *
 * Fail-closed: if the registry cannot be reached, the run does not launch. There
 * is no flag that skips this — an unchecked run is exactly the collision this
 * exists to prevent.
 */
import { randomBytes } from "node:crypto";
import { Firestore } from "@google-cloud/firestore";
import {
  AirspaceRegistry,
  FirestoreAirspaceBackend,
  claimResources,
  startHeartbeat,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_MS,
  type AirspaceLane,
  type FirestoreLike,
} from "./airspace.js";
import type { BuildPlan } from "./types.js";

/** GCP project holding the registry. Same project The Creator and the runner use. */
export const AIRSPACE_PROJECT = process.env.GCP_PROJECT_ID ?? "digitalsolomon-creator";
/** Firestore database holding the registry: the default one both lanes can reach. */
export const AIRSPACE_DATABASE = process.env.AIRSPACE_DATABASE ?? "(default)";

/** Lease/heartbeat, tunable by env for tests and ops; defaults in airspace.ts. */
export function leaseSettings(): { leaseMs: number; heartbeatMs: number } {
  const n = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) : d);
  return {
    leaseMs: n(process.env.AIRSPACE_LEASE_MS, DEFAULT_LEASE_MS),
    heartbeatMs: n(process.env.AIRSPACE_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS),
  };
}

/** The production registry (Firestore, ADC locally / the runtime SA in the cloud). */
export function openAirspaceRegistry(db?: FirestoreLike): AirspaceRegistry {
  const fs =
    db ??
    (new Firestore({
      projectId: AIRSPACE_PROJECT,
      databaseId: AIRSPACE_DATABASE,
      ignoreUndefinedProperties: true,
    }) as unknown as FirestoreLike);
  return new AirspaceRegistry(new FirestoreAirspaceBackend(fs));
}

/** A run id for a launch that did not get one from the cockpit. */
export function newRunId(lane: AirspaceLane): string {
  return `${lane}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export type RunClaim =
  | { granted: false; message: string; conflicts: number }
  | {
      granted: true;
      adopted: boolean;
      resources: string[];
      /** Wire into orchestrate({ halt }): a reason once the airspace is lost. */
      halt: () => string | undefined;
      /** Stop the heartbeat and release the claim. Idempotent; never throws. */
      release: () => Promise<void>;
    };

/**
 * Acquire (or adopt) the run's claims and start its heartbeat. Throws only when
 * the registry is unreachable — callers treat that as "do not launch".
 */
export async function claimAirspaceForRun(opts: {
  registry: AirspaceRegistry;
  plan: Pick<BuildPlan, "name" | "airspace">;
  runId: string;
  lane: AirspaceLane;
  leaseMs?: number;
  heartbeatMs?: number;
  log?: (level: "info" | "warn", msg: string) => void;
}): Promise<RunClaim> {
  const log = opts.log ?? (() => {});
  const settings = leaseSettings();
  const leaseMs = opts.leaseMs ?? settings.leaseMs;
  const heartbeatMs = opts.heartbeatMs ?? settings.heartbeatMs;
  const resources = claimResources(opts.plan.name, opts.plan.airspace);

  const r = await opts.registry.acquire({
    runId: opts.runId,
    planName: opts.plan.name,
    lane: opts.lane,
    resources,
    leaseMs,
  });
  if (!r.granted) return { granted: false, message: r.message, conflicts: r.conflicts.length };

  let lost: string | undefined;
  const stop = startHeartbeat(opts.registry, opts.runId, {
    intervalMs: heartbeatMs,
    leaseMs,
    onLost: (reason) => {
      lost = `Airspace lost — dispatch halted: ${reason}`;
      log("warn", lost);
    },
    onError: (e) => log("warn", `airspace heartbeat failed (will retry): ${(e as Error).message ?? e}`),
  });
  let released = false;
  return {
    granted: true,
    adopted: r.adopted,
    resources,
    halt: () => lost,
    release: async () => {
      if (released) return;
      released = true;
      stop();
      try {
        await opts.registry.release(opts.runId);
      } catch (e) {
        // The lease still expires on its own; say so rather than hide it.
        log("warn", `airspace release failed; the claim frees itself when its lease expires: ${(e as Error).message}`);
      }
    },
  };
}
