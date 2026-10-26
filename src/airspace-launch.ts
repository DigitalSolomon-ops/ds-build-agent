/**
 * Launch-side airspace wiring, shared by the local CLI (index.ts) and the cloud
 * runner (cloud-job.ts): acquire every claim before the first task dispatches,
 * keep the lease alive by heartbeat, fence the run if the lease cannot be
 * confirmed, abort in-flight work when the airspace is lost, and release when
 * the run ends. The registry logic itself lives in airspace.ts.
 *
 * Fail-closed: if the registry cannot be reached, the run does not launch. There
 * is no flag and no env var that skips this or points it elsewhere — an unchecked
 * run is exactly the collision this exists to prevent.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Firestore, FieldValue } from "@google-cloud/firestore";
import {
  AirspaceRefused,
  AirspaceRegistry,
  AnchoredClock,
  FirestoreAirspaceBackend,
  REGISTRY,
  checkLeaseSettings,
  claimResources,
  normalizeResource,
  pathKeyFor,
  resourcesOverlap,
  startHeartbeat,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_MS,
  type AirspaceLane,
  type FirestoreLike,
} from "./airspace.js";
import type { BuildPlan } from "./types.js";

/** Local monotonic milliseconds (QueryPerformanceCounter / CLOCK_MONOTONIC). */
export const mono = (): number => performance.now();

/** Where the production registry lives. Always REGISTRY: nothing in the environment can change it. */
export function registryTarget(): { project: string; database: string } {
  return { project: REGISTRY.project, database: REGISTRY.database };
}

/**
 * Lease/heartbeat, tunable by env for tests and ops, then bounded:
 * lease 60 s–15 min, heartbeat ≤ lease/3. Out of bounds -> AirspaceRefused (exit 5).
 */
export function leaseSettings(env: NodeJS.ProcessEnv = process.env): { leaseMs: number; heartbeatMs: number } {
  const n = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" ? Number(v) : d);
  const leaseMs = n(env.AIRSPACE_LEASE_MS, DEFAULT_LEASE_MS);
  const heartbeatMs = n(env.AIRSPACE_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS);
  checkLeaseSettings(leaseMs, heartbeatMs);
  return { leaseMs, heartbeatMs };
}

function registryOn(db: FirestoreLike, collectionPrefix?: string): AirspaceRegistry {
  const backend = new FirestoreAirspaceBackend(db, {
    serverTimestamp: () => FieldValue.serverTimestamp(),
    collectionPrefix,
  });
  return new AirspaceRegistry(backend, new AnchoredClock(() => backend.serverTime(), mono));
}

/** The production registry: REGISTRY's Firestore database (ADC locally / the runtime SA in the cloud). */
export function openAirspaceRegistry(): AirspaceRegistry {
  const { project, database } = registryTarget();
  const db = new Firestore({ projectId: project, databaseId: database, ignoreUndefinedProperties: true });
  return registryOn(db as unknown as FirestoreLike);
}

/**
 * Test constructor for the live checks: the real registry database, every
 * collection prefixed (must start with "airspaceTest_"), so live checks never
 * touch production claims.
 */
export function openAirspaceTestRegistry(collectionPrefix: string): AirspaceRegistry {
  if (!collectionPrefix.startsWith("airspaceTest_")) {
    throw new AirspaceRefused(`airspace: test registries must use an "airspaceTest_" prefix, got "${collectionPrefix}"`);
  }
  const { project, database } = registryTarget();
  const db = new Firestore({ projectId: project, databaseId: database, ignoreUndefinedProperties: true });
  return registryOn(db as unknown as FirestoreLike, collectionPrefix);
}

/** A run id for a launch that did not get one from the cockpit. Unique per attempt. */
export function newRunId(lane: AirspaceLane): string {
  return `${lane}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/* ── Local folders: build target and derived repo keys ─────────────────────── */

/** The absolute folder a `path:` key names, or undefined for non-path keys. */
export function folderOf(key: string, root: string | undefined): string | undefined {
  const k = normalizeResource(key);
  if (k.startsWith("path:abs:")) return k.slice("path:abs:".length);
  if (k.startsWith("path:")) return root ? join(root, k.slice(5)) : undefined;
  return undefined;
}

/**
 * The build target must be inside the run's claimed airspace: a `path:` under
 * the Projects root, or a declared `path:abs:` outside it. Otherwise exit 5.
 */
export function checkBuildTarget(target: string, claimed: string[], root: string | undefined): void {
  const key = root ? pathKeyFor(resolve(target), root) : normalizeResource(`path:abs:${resolve(target)}`);
  const covered = claimed.some((c) => {
    const k = normalizeResource(c);
    return k.startsWith("path:") && resourcesOverlap(k, key) && (k === key || key.startsWith(k + "/"));
  });
  if (!covered) throw new AirspaceRefused(`airspace: build target ${resolve(target)} not claimed`);
}

function git(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).trim();
  } catch {
    return undefined;
  }
}

/** Is `a` the same folder as `b`, or an ancestor of it? (case-insensitive, separator-agnostic) */
function isAncestorOrSelf(a: string, b: string): boolean {
  const f = (p: string) => resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const x = f(a);
  const y = f(b);
  return x === y || y.startsWith(x + "/");
}

/**
 * repo:<origin> for the git working tree that contains `dir`, if any. A working
 * tree whose top level contains the whole Projects tree (e.g. a stray repo at the
 * home folder) is nobody's project repo and is ignored.
 */
function repoKeyOf(dir: string, root: string | undefined): string | undefined {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (!top) return undefined;
  if (root && isAncestorOrSelf(top, root)) return undefined;
  const url = git(top, ["remote", "get-url", "origin"]);
  if (!url) return undefined;
  try {
    return normalizeResource(`repo:${url}`);
  } catch {
    return undefined; // not a GitHub remote: nothing to derive
  }
}

/** Nested working trees under `dir` (a `.git` file or folder), depth-limited, skipping dependency folders. */
function nestedWorkingTrees(dir: string, depth = 4): string[] {
  const out: string[] = [];
  const walk = (d: string, left: number) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === "node_modules" || e === ".git" || e === ".deps" || e === "dist" || e.startsWith(".venv")) continue;
      const p = join(d, e);
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (existsSync(join(p, ".git"))) out.push(p);
      if (left > 1) walk(p, left - 1);
    }
  };
  walk(dir, depth);
  return out;
}

/**
 * Derived `repo:` keys: for every claimed `path:` that is (or sits inside) a git
 * working tree, its origin; plus the origin of every working tree nested under it.
 * A plan claiming the folder therefore also claims the remote, so a run that
 * declares only the remote contends with it.
 */
export function deriveRepoKeys(airspace: string[], root: string | undefined): string[] {
  const keys = new Set<string>();
  for (const k of airspace) {
    const dir = folderOf(k, root);
    if (!dir || !existsSync(dir)) continue;
    const own = repoKeyOf(dir, root);
    if (own) keys.add(own);
    for (const nested of nestedWorkingTrees(dir)) {
      const r = repoKeyOf(nested, root);
      if (r) keys.add(r);
    }
  }
  return [...keys].sort();
}

/* ── Claiming a run ────────────────────────────────────────────────────────── */

export type RunClaim =
  | { granted: false; message: string; conflicts: number }
  | {
      granted: true;
      adopted: boolean;
      resources: string[];
      /** Wire into orchestrate({ halt }): a reason once the airspace is lost. */
      halt: () => string | undefined;
      /** Aborted (with the reason) the moment the airspace is lost: in-flight work stops. */
      signal: AbortSignal;
      /** Renew now; undefined = still ours, else why not. Called before every commit. */
      confirm: () => Promise<string | undefined>;
      /** Stop the heartbeat and release the claim. Idempotent; never throws. */
      release: () => Promise<void>;
    };

/**
 * Acquire (or, in the cloud lane, adopt) the run's claims and start its
 * heartbeat + fence. Throws when the registry is unreachable or refuses —
 * callers treat that as "do not launch" (exit 5).
 */
export async function claimAirspaceForRun(opts: {
  registry: AirspaceRegistry;
  plan: Pick<BuildPlan, "name" | "airspace">;
  runId: string;
  lane: AirspaceLane;
  /** Keys derived from the plan's (repo: of claimed folders). */
  derived?: string[];
  leaseMs?: number;
  heartbeatMs?: number;
  log?: (level: "info" | "warn", msg: string) => void;
}): Promise<RunClaim> {
  const log = opts.log ?? (() => {});
  const settings =
    opts.leaseMs !== undefined && opts.heartbeatMs !== undefined
      ? { leaseMs: opts.leaseMs, heartbeatMs: opts.heartbeatMs }
      : leaseSettings();
  const leaseMs = opts.leaseMs ?? settings.leaseMs;
  const heartbeatMs = opts.heartbeatMs ?? settings.heartbeatMs;
  const resources = claimResources(opts.plan.name, opts.plan.airspace);

  const armedAt = mono(); // the fence starts counting from the moment the acquire is sent
  const r = await opts.registry.acquire({
    runId: opts.runId,
    planName: opts.plan.name,
    lane: opts.lane,
    resources,
    derived: opts.derived,
    leaseMs,
  });
  if (!r.granted) return { granted: false, message: r.message, conflicts: r.conflicts.length };

  const controller = new AbortController();
  let lost: string | undefined;
  const beat = startHeartbeat(opts.registry, opts.runId, {
    armedAt,
    mono,
    intervalMs: heartbeatMs,
    leaseMs,
    onLost: (reason) => {
      lost = `Airspace lost — work stopped: ${reason}`;
      log("warn", lost);
      controller.abort(lost);
    },
    onError: (e) => log("warn", `airspace heartbeat failed (will retry): ${(e as Error).message ?? e}`),
  });
  let released = false;
  return {
    granted: true,
    adopted: r.adopted,
    resources: r.claim.resources,
    halt: () => lost,
    signal: controller.signal,
    confirm: async () => {
      if (lost) return lost;
      const why = await beat.confirm();
      return why ? lost ?? `Airspace lost: ${why}` : undefined;
    },
    release: async () => {
      if (released) return;
      released = true;
      beat.stop();
      try {
        await opts.registry.release(opts.runId);
      } catch (e) {
        // The lease still expires on its own; say so rather than hide it.
        log("warn", `airspace release failed; the claim frees itself when its lease expires: ${(e as Error).message}`);
      }
    },
  };
}
