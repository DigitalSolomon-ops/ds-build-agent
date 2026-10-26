/**
 * Airspace control — one registry of what every active run is touching, shared by
 * the local lane (handoff-watcher jobs and hand-run ds-build on blacktop) and the
 * cloud lane (solomon-runner), so no two runs ever work the same resources at the
 * same time.
 *
 *   - Every plan declares an `airspace` block: the repos, folders, GHL locations,
 *     GHL pipelines and other shared resources it writes to (parseAirspaceBlock).
 *   - Before any launch the launcher acquires claims for ALL of them in one
 *     transaction. All are granted or none are (AirspaceRegistry.acquire).
 *   - Any overlap with a live claim is a HARD BLOCK. There is deliberately no
 *     override flag and no force option anywhere in this file — do not add one.
 *   - Each claim carries a lease the run renews by heartbeat. An expired lease
 *     frees the claim, so a crashed run cannot lock a project forever, and a run
 *     that cannot confirm its lease stops itself before the lease runs out (fence).
 *   - Time is the SERVER's: "now" is anchored to a Firestore commit time plus a
 *     local monotonic clock (AnchoredClock), never the local wall clock and never a
 *     timestamp some other writer stored.
 *
 * The registry lives in Firestore project digitalsolomon-creator, database
 * `local-builds` (REGISTRY). Nothing selects another one: no env var, no flag.
 *
 * MIRRORED FILE. This exact file is copied byte-for-byte into
 * the-creator/packages/shared/src/airspace.ts, and handoff-watcher ports it to
 * Python (handoff_watcher/airspace.py). ds-build-agent is the source of truth;
 * checks/airspace.test.mjs fails if the TS copies drift, and both languages run
 * checks/fixtures/airspace-cases.json. It is self-contained on purpose: no
 * imports, and Firestore is duck-typed so the repos' SDK versions all fit.
 */

/* ── Registry identity ─────────────────────────────────────────────────────── */

/** Where the one registry lives. Hard-coded on purpose: an override is a bypass. */
export const REGISTRY = {
  project: "digitalsolomon-creator",
  database: "local-builds",
  id: "solomon-airspace/local-builds/v1",
} as const;

/* ── Resource keys ─────────────────────────────────────────────────────────── */

/** Which lane a run belongs to. They bill differently and never merge. */
export type AirspaceLane = "local" | "cloud";

/** Known resource types. Any other `type:value` key is allowed and matched exactly. */
export const KNOWN_RESOURCE_TYPES = ["repo", "path", "ghl_location", "ghl_pipeline", "plan"] as const;

/** Lease and heartbeat defaults (open question 1, decided in docs/AIRSPACE.md). */
export const DEFAULT_LEASE_MS = 5 * 60_000;
export const DEFAULT_HEARTBEAT_MS = 60_000;
/** Lease bounds: shorter churns the registry, longer locks a crashed run's project too long. */
export const MIN_LEASE_MS = 60_000;
export const MAX_LEASE_MS = 15 * 60_000;

/** Clock anchoring: re-measure this often, and discard a measurement slower than this. */
export const CLOCK_REANCHOR_MS = 10 * 60_000;
export const CLOCK_MAX_RTT_MS = 5_000;
/** Re-anchor at once when wall and monotonic clocks drift apart by more than this (sleep). */
export const CLOCK_DRIFT_MS = 10_000;
/** A head stamped further ahead of our server-anchored now than this means a broken clock. */
export const HEAD_AHEAD_TOLERANCE_MS = 5_000;

/** Default owner for a bare repo name (`repo:ds-build-agent`). */
const DEFAULT_REPO_OWNER = "digitalsolomon-ops";

/** Types whose values compare case-sensitively. GHL ids are opaque ids. */
const CASE_SENSITIVE_TYPES = new Set(["ghl_location", "ghl_pipeline"]);

/** Thrown for an invalid `airspace` block or resource key. */
export class AirspaceError extends Error {}

/**
 * The registry refused before any claim was taken: wrong registry, clock trouble,
 * bad lease settings, an unclaimed build target. Launchers exit 5 on it.
 */
export class AirspaceRefused extends AirspaceError {}

/** Collapse `.` segments and doubled slashes in a forward-slash path. */
function cleanSegments(p: string): string[] {
  return p.split("/").filter((s) => s !== "" && s !== ".");
}

/**
 * Normalize one typed resource key, e.g. `path:Portfolios\Foo\` -> `path:portfolios/foo`.
 * Throws AirspaceError on anything malformed. Folder-level only: no globs.
 *
 *   path:<relative to the Projects root>   lower-cased (NTFS), `.` collapsed, a
 *                                          leading `projects/` stripped
 *   path:abs:<absolute path>               a folder OUTSIDE the Projects root,
 *                                          lower-cased, drive letter included
 *   repo:<owner/name | name | URL>         userinfo and `.git` stripped
 *   ghl_pipeline:<locationId>/<pipelineId> ids, case-sensitive
 */
export function normalizeResource(key: string): string {
  if (typeof key !== "string") throw new AirspaceError(`resource must be a string, got ${JSON.stringify(key)}`);
  const i = key.indexOf(":");
  if (i <= 0) {
    throw new AirspaceError(
      `resource "${key}" has no type; write it as type:value (repo:, path:, ghl_location:, ghl_pipeline:)`,
    );
  }
  const type = key.slice(0, i).trim().toLowerCase();
  let value = key.slice(i + 1).trim().replace(/\s+/g, " ");
  if (!/^[a-z][a-z0-9_]*$/.test(type)) throw new AirspaceError(`resource "${key}" has an invalid type "${type}"`);
  if (!value) throw new AirspaceError(`resource "${key}" has an empty value`);

  if (type === "path") {
    const abs = /^abs:/i.test(value);
    let p = (abs ? value.slice(4) : value).trim().replace(/\\/g, "/");
    if (/[*?[\]]/.test(p)) throw new AirspaceError(`path "${p}" is a glob; claim the folder instead`);
    if (abs) {
      const m = /^([a-z]):\/(.*)$/i.exec(p) ?? (p.startsWith("/") ? ["", "", p.slice(1)] : null);
      if (!m) throw new AirspaceError(`path:abs "${p}" must be an absolute path (C:/... or /...)`);
      const segs = cleanSegments(m[2]);
      if (segs.some((s) => s === "..")) throw new AirspaceError(`path "${p}" may not contain ".."`);
      if (!segs.length) throw new AirspaceError(`path:abs "${p}" claims a whole drive; name a folder`);
      return `path:abs:${m[1] ? m[1].toLowerCase() + ":" : ""}/${segs.join("/")}`.toLowerCase();
    }
    if (/^[a-z]:/i.test(p) || p.startsWith("/")) {
      throw new AirspaceError(
        `path "${p}" must be relative to the Projects root; claim a folder outside it as path:abs:<path>`,
      );
    }
    let segs = cleanSegments(p);
    if (segs.some((s) => s === "..")) throw new AirspaceError(`path "${p}" may not contain ".."`);
    if (segs.length && segs[0].toLowerCase() === "projects") segs = segs.slice(1);
    if (!segs.length) throw new AirspaceError(`path "${key}" claims the whole tree; name a folder`);
    return `path:${segs.join("/").toLowerCase()}`;
  }
  if (type === "repo") {
    value = value
      .replace(/^(ssh:\/\/)?git@github\.com[:/]/i, "")
      .replace(/^https?:\/\/([^@/]+@)?(www\.)?github\.com\//i, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
    if (!value.includes("/")) value = `${DEFAULT_REPO_OWNER}/${value}`;
    if (value.split("/").length !== 2 || value.split("/").some((s) => !s)) {
      throw new AirspaceError(`repo "${key}" must be owner/name, a bare name, or a GitHub URL`);
    }
  } else if (type === "ghl_pipeline") {
    const parts = value.split("/").map((s) => s.trim());
    if (parts.length !== 2 || parts.some((s) => !s)) {
      throw new AirspaceError(`ghl_pipeline "${value}" must be <locationId>/<pipelineId>`);
    }
    value = parts.join("/");
  }
  return `${type}:${value}`;
}

/**
 * Map an absolute filesystem path to its resource key: `path:<relative>` inside
 * the Projects root, `path:abs:<path>` outside it. `root` is the Projects root.
 */
export function pathKeyFor(absPath: string, root: string): string {
  const fold = (s: string) => cleanSegments(s.replace(/\\/g, "/")).join("/").toLowerCase();
  const p = fold(absPath);
  const r = fold(root);
  if (p === r) throw new AirspaceError(`"${absPath}" is the Projects root itself; name a folder`);
  if (p.startsWith(r + "/")) return normalizeResource(`path:${p.slice(r.length + 1)}`);
  return normalizeResource(`path:abs:${absPath}`);
}

/** The comparison form of a normalized key (case-folded unless the type is opaque). */
function compareKey(normalized: string): string {
  const i = normalized.indexOf(":");
  const type = normalized.slice(0, i);
  return CASE_SENSITIVE_TYPES.has(type) ? normalized : normalized.toLowerCase();
}

/**
 * Do two normalized keys contend? Same type only. Paths overlap when one is the
 * other or an ancestor of it (folder-level claims, on segment boundaries:
 * `path:a/b` overlaps `path:a/b/c` but not `path:a/bc`). Everything else matches exactly.
 */
export function resourcesOverlap(a: string, b: string): boolean {
  const ka = compareKey(a);
  const kb = compareKey(b);
  const ta = ka.slice(0, ka.indexOf(":"));
  const tb = kb.slice(0, kb.indexOf(":"));
  if (ta !== tb) return false;
  if (ta === "path") {
    const pa = ka.slice(5);
    const pb = kb.slice(5);
    return pa === pb || pb.startsWith(pa + "/") || pa.startsWith(pb + "/");
  }
  return ka === kb;
}

/** Map-form keys of the `airspace` block and the resource type each holds. */
const BLOCK_KEYS: Record<string, string | null> = {
  repos: "repo",
  paths: "path",
  folders: "path",
  ghl_locations: "ghl_location",
  ghl_pipelines: "ghl_pipeline",
  other: null, // already-typed keys, e.g. "n8n_workflow:lead-router"
};

/** A relative `path:` must name at least this many folders (no `path:portfolios`). */
export const MIN_PATH_DEPTH = 2;

/**
 * Parse a plan's `airspace` block into a sorted, de-duplicated list of normalized
 * typed keys. Accepts the map form
 *
 *   airspace:
 *     repos: [DigitalSolomon-ops/fast-insurance-group]
 *     paths: [portfolios/own-products/fast-insurance-group/build]
 *     ghl_locations: [OwTVypw5mcI0oznL5Bgd]
 *     ghl_pipelines: ["OwTVypw5mcI0oznL5Bgd/pipe123"]
 *     other: ["n8n_workflow:lead-router"]
 *
 * or a flat list of typed keys (`["repo:x", "path:y"]`). Strict on purpose: an
 * unknown map key (`path:` for `paths:`) would otherwise drop a claim silently,
 * a missing or empty block is a plan that has not said what it touches, and a
 * shallow path (`portfolios`) would lock half the tree.
 */
export function parseAirspaceBlock(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    throw new AirspaceError(
      "Plan has no `airspace` block. Every plan must declare what it writes to (repos, paths, " +
        "ghl_locations, ghl_pipelines, other) so conflicting runs can be blocked before launch.",
    );
  }
  const out: string[] = [];
  const add = (type: string | null, v: unknown, where: string) => {
    const items = Array.isArray(v) ? v : [v];
    for (const item of items) {
      if (typeof item !== "string" || !item.trim()) {
        throw new AirspaceError(`airspace ${where} must hold non-empty strings, got ${JSON.stringify(item)}`);
      }
      const s = item.trim();
      if (type === null) out.push(normalizeResource(s));
      else out.push(normalizeResource(s.toLowerCase().startsWith(type + ":") ? s : `${type}:${s}`));
    }
  };
  if (Array.isArray(raw)) add(null, raw, "list");
  else if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!(k in BLOCK_KEYS)) {
        throw new AirspaceError(
          `airspace key \`${k}\` is not recognized (expected ${Object.keys(BLOCK_KEYS).join(", ")})`,
        );
      }
      if (v === null || v === undefined) continue;
      add(BLOCK_KEYS[k], v, `\`${k}\``);
    }
  } else {
    throw new AirspaceError("`airspace` must be a map (repos/paths/...) or a list of typed keys");
  }
  const unique = [...new Set(out)].sort();
  if (unique.length === 0) {
    throw new AirspaceError("`airspace` declares no resources. Name at least one repo, path or other resource.");
  }
  for (const k of unique) {
    if (k.startsWith("path:") && !k.startsWith("path:abs:") && k.slice(5).split("/").length < MIN_PATH_DEPTH) {
      throw new AirspaceError(
        `airspace ${k} is too broad: name a folder at least ${MIN_PATH_DEPTH} levels below the Projects root`,
      );
    }
  }
  return unique;
}

/** Everything a run claims: its own plan name (so a plan never runs twice at once) plus its airspace. */
export function claimResources(planName: string, airspace: string[]): string[] {
  return [...new Set([normalizeResource(`plan:${planName}`), ...airspace.map(normalizeResource)])].sort();
}

/**
 * Draft an `airspace` block for a plan that has none, FOR REVIEW. Never written
 * into a plan automatically: a human (or The Creator's review step) confirms it.
 */
export function draftAirspaceYaml(hints: {
  projectPath?: string;
  repo?: string;
  ghlLocationId?: string;
  ghlPipelines?: string[];
}): string {
  const lines = ["airspace:   # DRAFT - review before launch; declare everything this plan writes to"];
  if (hints.repo) lines.push("  repos:", `    - ${hints.repo}`);
  if (hints.projectPath) lines.push("  paths:", `    - ${hints.projectPath.replace(/\\/g, "/")}`);
  if (hints.ghlLocationId) lines.push("  ghl_locations:", `    - ${hints.ghlLocationId}`);
  if (hints.ghlPipelines?.length) {
    lines.push("  ghl_pipelines:", ...hints.ghlPipelines.map((p) => `    - ${JSON.stringify(p)}`));
  }
  if (lines.length === 1) lines.push("  paths:", "    - portfolios/<portfolio>/<project>");
  return lines.join("\n") + "\n";
}

/* ── Claims ────────────────────────────────────────────────────────────────── */

export type ClaimStatus = "active" | "released" | "expired";

/** airspaceClaims/{run_id} — one document per run. Timestamps are epoch ms in memory. */
export interface ClaimRecord {
  run_id: string;
  plan_name: string;
  lane: AirspaceLane;
  /** Everything claimed: declared resources plus derived ones (repo: of claimed paths). */
  resources: string[];
  /** The resources the plan itself declared; adoption compares these only. */
  declared?: string[];
  status: ClaimStatus;
  /**
   * True only on a claim the cockpit took at cloud Launch, until the cloud runner
   * adopts it. Adoption flips it false in the same transaction; so do release and expiry.
   */
  adoptable?: boolean;
  adopted_at?: number;
  acquired_at: number;
  heartbeat_at: number;
  lease_expires_at: number;
  released_at?: number;
}

/** One contested resource: what I asked for, what the holder has, and who the holder is. */
export interface AirspaceConflict {
  resource: string;
  held_resource: string;
  holder_run_id: string;
  holder_plan: string;
  holder_lane: AirspaceLane;
}

/** airspaceHeld/{run_id} — a launch that was blocked, for the cockpit's held list. */
export interface HeldRecord {
  run_id: string;
  plan_name: string;
  lane: AirspaceLane;
  resources: string[];
  conflicts: AirspaceConflict[];
  message: string;
  held_at: number;
  resolved_at?: number;
}

export type AcquireResult =
  | { granted: true; claim: ClaimRecord; adopted: boolean }
  | { granted: false; conflicts: AirspaceConflict[]; message: string };

export type RenewResult = { ok: true; claim: ClaimRecord } | { ok: false; reason: string };

/** A claim counts only while active AND inside its lease. */
export function isLive(c: ClaimRecord, now: number): boolean {
  return c.status === "active" && c.lease_expires_at > now;
}

/** Every overlap between `resources` and the live claims of OTHER runs. */
export function findConflicts(
  resources: string[],
  claims: ClaimRecord[],
  selfRunId: string,
  now: number,
): AirspaceConflict[] {
  const out: AirspaceConflict[] = [];
  for (const c of claims) {
    if (c.run_id === selfRunId || !isLive(c, now)) continue;
    for (const mine of resources) {
      for (const theirs of c.resources) {
        if (resourcesOverlap(mine, theirs)) {
          out.push({
            resource: mine,
            held_resource: theirs,
            holder_run_id: c.run_id,
            holder_plan: c.plan_name,
            holder_lane: c.lane,
          });
        }
      }
    }
  }
  return out;
}

/** "held: conflicts with fast-insurance-group on ghl_pipeline:loc/pipe" (+ the rest, counted). */
export function formatHeld(conflicts: AirspaceConflict[]): string {
  if (!conflicts.length) return "";
  const first = conflicts[0];
  const more = conflicts.length > 1 ? ` (+${conflicts.length - 1} more)` : "";
  return (
    `held: conflicts with ${first.holder_plan} on ${first.held_resource}` +
    ` [run ${first.holder_run_id}, ${first.holder_lane} lane]${more}`
  );
}

const sameSet = (a: string[], b: string[]) => {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/* ── Time ──────────────────────────────────────────────────────────────────── */

/** A registry clock: server-anchored milliseconds, refreshed before each transaction. */
export interface RegistryClock {
  now(): number;
  /** Make sure the anchor is fresh (first use, every CLOCK_REANCHOR_MS, after a sleep). */
  refresh?(): Promise<void>;
}

/**
 * Server time from a Firestore commit, carried forward on the local MONOTONIC
 * clock. `now = t_server + (mono() − mono_mid)`, where mono_mid is the midpoint of
 * the round-trip that produced t_server, so the error is at most half that
 * round-trip (and round-trips over CLOCK_MAX_RTT_MS are discarded). The local
 * wall clock is used only to notice a sleep/resume, never as time itself.
 */
export class AnchoredClock implements RegistryClock {
  private anchor?: { server: number; mono: number; wall: number };
  constructor(
    /** Writes the clock doc with a server-timestamp sentinel; resolves to its commit time (ms). */
    private readonly serverTime: () => Promise<number>,
    private readonly mono: () => number,
    private readonly wall: () => number = Date.now,
  ) {}

  async refresh(): Promise<void> {
    const a = this.anchor;
    if (a) {
      const elapsedMono = this.mono() - a.mono;
      const elapsedWall = this.wall() - a.wall;
      const fresh = elapsedMono < CLOCK_REANCHOR_MS && Math.abs(elapsedWall - elapsedMono) <= CLOCK_DRIFT_MS;
      if (fresh) return;
    }
    await this.measure();
  }

  /** Take a new anchor. Three slow round-trips in a row refuse (fail closed). */
  async measure(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const m0 = this.mono();
      const t = await this.serverTime();
      const m1 = this.mono();
      if (m1 - m0 > CLOCK_MAX_RTT_MS) continue;
      this.anchor = { server: t, mono: (m0 + m1) / 2, wall: this.wall() };
      return;
    }
    throw new AirspaceRefused(
      `airspace: clock skew — could not anchor to server time (3 round-trips over ${CLOCK_MAX_RTT_MS} ms)`,
    );
  }

  now(): number {
    if (!this.anchor) throw new AirspaceRefused("airspace: clock not anchored (refresh() before use)");
    return this.anchor.server + (this.mono() - this.anchor.mono);
  }
}

const asClock = (c: RegistryClock | (() => number)): RegistryClock => (typeof c === "function" ? { now: c } : c);

/* ── Backends ──────────────────────────────────────────────────────────────── */

/** The registry's `head` doc: who owns this registry, and when it was last written (audit only). */
export interface RegistryHead {
  registry_id?: string;
  updated_at?: number;
}

/** What one registry transaction may do. All reads happen before any write lands. */
export interface RegistryTx {
  readHead(): Promise<RegistryHead>;
  readActive(): Promise<ClaimRecord[]>;
  readClaim(runId: string): Promise<ClaimRecord | undefined>;
  readHeldForPlan(planName: string): Promise<HeldRecord[]>;
  writeClaim(c: ClaimRecord): void;
  writeHeld(h: HeldRecord): void;
}

export interface AirspaceBackend {
  /**
   * Run `fn` serializably against the registry; retried by the backend on
   * contention. Every transaction reads and rewrites the head doc (stamping
   * REGISTRY.id), which is what serializes them.
   */
  transact<T>(fn: (tx: RegistryTx) => Promise<T>): Promise<T>;
  /** Server time in ms, from a write's commit time (for AnchoredClock). */
  serverTime(): Promise<number>;
  listClaims(status?: ClaimStatus): Promise<ClaimRecord[]>;
  listHeld(limit: number): Promise<HeldRecord[]>;
}

/** Firestore Timestamp | Date | number -> epoch ms. */
function toMs(v: unknown): number {
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (v && typeof (v as { toMillis?: unknown }).toMillis === "function") return (v as { toMillis(): number }).toMillis();
  return 0;
}
const TS_FIELDS = [
  "acquired_at", "heartbeat_at", "lease_expires_at", "released_at", "held_at", "resolved_at", "adopted_at",
];
function fromStored<T>(d: Record<string, unknown>): T {
  const o: Record<string, unknown> = { ...d };
  for (const f of TS_FIELDS) if (o[f] !== undefined && o[f] !== null) o[f] = toMs(o[f]);
  return o as T;
}
/** Epoch ms -> Date, so Firestore stores real timestamps (the brief's schema). */
function toStored(o: object): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    d[k] = TS_FIELDS.includes(k) && typeof v === "number" ? new Date(v) : v;
  }
  return d;
}

/* Minimal structural Firestore types: every repo's SDK version satisfies these. */
interface FsSnap { exists: boolean; data(): Record<string, unknown> | undefined }
interface FsQuerySnap { docs: { data(): Record<string, unknown> }[] }
interface FsQuery { get(): Promise<FsQuerySnap>; where(f: string, op: string, v: unknown): FsQuery; limit(n: number): FsQuery }
interface FsDocRef { get(): Promise<FsSnap>; set(data: Record<string, unknown>): Promise<{ writeTime?: unknown }> }
interface FsCollection extends FsQuery { doc(id: string): FsDocRef }
interface FsTransaction {
  get(ref: FsDocRef): Promise<FsSnap>;
  get(q: FsQuery): Promise<FsQuerySnap>;
  set(ref: FsDocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): unknown;
}
export interface FirestoreLike {
  collection(name: string): FsCollection;
  runTransaction<T>(fn: (t: FsTransaction) => Promise<T>, opts?: { maxAttempts?: number }): Promise<T>;
}

/** Contended registry transactions are retried here, quickly, instead of by the SDK's ~1 s backoff. */
export const CONTENTION_MAX_ATTEMPTS = 25;

/** Firestore ABORTED (gRPC 10): another transaction won the head doc. Safe to re-run from scratch. */
function isContention(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown };
  return err?.code === 10 || err?.code === "ABORTED" || /ABORTED|contention/i.test(String(err?.message ?? ""));
}

export interface FirestoreBackendOptions {
  /** The SDK's server-timestamp sentinel (FieldValue.serverTimestamp()), injected so this file has no imports. */
  serverTimestamp: () => unknown;
  /** Test-only: prefix every collection (live checks use "airspaceTest_"). */
  collectionPrefix?: string;
}

/**
 * Firestore backend. Every transaction reads AND writes `airspaceRegistry/head`,
 * so Firestore serializes all registry transactions against each other: two
 * simultaneous acquires on overlapping airspace cannot both commit — one is
 * retried, re-reads the claim the other wrote, and is held. Launches are rare, so
 * one serialization point costs milliseconds and buys correctness for folder
 * (prefix) overlap, which per-resource lock docs cannot express.
 */
export class FirestoreAirspaceBackend implements AirspaceBackend {
  private readonly claims: string;
  private readonly held: string;
  private readonly registry: string;
  constructor(private readonly db: FirestoreLike, private readonly opts: FirestoreBackendOptions) {
    if (typeof opts?.serverTimestamp !== "function") {
      throw new AirspaceRefused("airspace: the Firestore backend needs the SDK's serverTimestamp sentinel");
    }
    const p = opts.collectionPrefix ?? "";
    this.claims = `${p}airspaceClaims`;
    this.held = `${p}airspaceHeld`;
    this.registry = `${p}airspaceRegistry`;
  }

  async serverTime(): Promise<number> {
    const wr = await this.db.collection(this.registry).doc("clock").set({ t: this.opts.serverTimestamp() });
    const ms = toMs(wr?.writeTime);
    if (!ms) throw new AirspaceRefused("airspace: clock write returned no commit time");
    return ms;
  }

  /**
   * One registry transaction. The SDK is told to make ONE attempt; a contended
   * (ABORTED) attempt is re-run here after a short jittered pause (20–400 ms),
   * not the SDK's second-scale backoff, so simultaneous non-overlapping launches
   * serialize in milliseconds. Every attempt re-reads everything: correctness is
   * Firestore's, only the waiting is ours. Any other error is thrown at once.
   */
  async transact<T>(fn: (tx: RegistryTx) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(fn);
      } catch (e) {
        if (!isContention(e) || attempt >= CONTENTION_MAX_ATTEMPTS) throw e;
        const pause = Math.min(400, 20 + Math.random() * 40 * attempt);
        await new Promise((r) => setTimeout(r, pause));
      }
    }
  }

  private attempt<T>(fn: (tx: RegistryTx) => Promise<T>): Promise<T> {
    const db = this.db;
    return db.runTransaction(async (t) => {
      const headRef = db.collection(this.registry).doc("head");
      // Started now, awaited where needed: the head read runs alongside the others.
      const headRead = t.get(headRef);
      const writes: ((t: FsTransaction) => void)[] = [];
      const tx: RegistryTx = {
        readHead: async () => {
          const head = await headRead;
          const d = head.exists ? head.data() ?? {} : {};
          return {
            registry_id: typeof d.registry_id === "string" ? d.registry_id : undefined,
            updated_at: d.updated_at !== undefined && d.updated_at !== null ? toMs(d.updated_at) : undefined,
          };
        },
        readActive: async () =>
          (await t.get(db.collection(this.claims).where("status", "==", "active"))).docs.map((d) =>
            fromStored<ClaimRecord>(d.data()),
          ),
        readClaim: async (runId) => {
          const s = await t.get(db.collection(this.claims).doc(runId));
          return s.exists ? fromStored<ClaimRecord>(s.data()!) : undefined;
        },
        readHeldForPlan: async (planName) =>
          (await t.get(db.collection(this.held).where("plan_name", "==", planName))).docs.map((d) =>
            fromStored<HeldRecord>(d.data()),
          ),
        writeClaim: (c) => writes.push((tt) => tt.set(db.collection(this.claims).doc(c.run_id), toStored(c))),
        writeHeld: (h) => writes.push((tt) => tt.set(db.collection(this.held).doc(h.run_id), toStored(h))),
      };
      const out = await fn(tx);
      const head = await headRead;
      for (const w of writes) w(t);
      const version = Number(head.exists ? head.data()?.version ?? 0 : 0) + 1;
      // updated_at is the server's commit time: audit only, it never feeds "now".
      t.set(headRef, { version, registry_id: REGISTRY.id, updated_at: this.opts.serverTimestamp() });
      return out;
    }, { maxAttempts: 1 });
  }

  async listClaims(status?: ClaimStatus): Promise<ClaimRecord[]> {
    const col = this.db.collection(this.claims);
    const snap = await (status ? col.where("status", "==", status) : col.limit(500)).get();
    return snap.docs.map((d) => fromStored<ClaimRecord>(d.data()));
  }

  async listHeld(limit: number): Promise<HeldRecord[]> {
    const snap = await this.db.collection(this.held).limit(500).get();
    return snap.docs
      .map((d) => fromStored<HeldRecord>(d.data()))
      .sort((a, b) => b.held_at - a.held_at)
      .slice(0, limit);
  }
}

/**
 * In-memory backend with Firestore's optimistic-concurrency semantics: each
 * transaction reads a snapshot, yields (so concurrent callers interleave), and
 * commits only if nothing committed in between — otherwise it re-runs. Used by
 * the offline checks, and a faithful model of how the real registry behaves
 * under simultaneous launches. `serverClock` stands in for Firestore's clock.
 */
export class MemoryAirspaceBackend implements AirspaceBackend {
  private version = 0;
  readonly claims = new Map<string, ClaimRecord>();
  readonly held = new Map<string, HeldRecord>();
  head: RegistryHead = {};
  /** Number of transaction attempts that lost a race and re-ran (for tests). */
  retries = 0;
  /** Committed transactions, for write-count assertions. */
  commits = 0;
  /** `serverClock` stands in for Firestore's commit clock; without one the head gets no audit stamp. */
  constructor(private readonly serverClock?: () => number) {}

  async serverTime(): Promise<number> {
    return (this.serverClock ?? Date.now)();
  }

  async transact<T>(fn: (tx: RegistryTx) => Promise<T>): Promise<T> {
    const tick = () => new Promise<void>((r) => setImmediate(r));
    for (let attempt = 0; attempt < 25; attempt++) {
      const start = this.version;
      const writes: (() => void)[] = [];
      const clone = <V>(v: V): V => JSON.parse(JSON.stringify(v));
      const tx: RegistryTx = {
        readHead: async () => clone(this.head),
        readActive: async () => {
          await tick();
          return [...this.claims.values()].filter((c) => c.status === "active").map(clone);
        },
        readClaim: async (id) => {
          await tick();
          const c = this.claims.get(id);
          return c ? clone(c) : undefined;
        },
        readHeldForPlan: async (plan) => {
          await tick();
          return [...this.held.values()].filter((h) => h.plan_name === plan).map(clone);
        },
        writeClaim: (c) => writes.push(() => this.claims.set(c.run_id, clone(c))),
        writeHeld: (h) => writes.push(() => this.held.set(h.run_id, clone(h))),
      };
      const out = await fn(tx);
      await tick();
      if (this.version !== start) {
        this.retries++;
        continue; // someone committed first: re-read and re-decide
      }
      for (const w of writes) w();
      this.head = { registry_id: REGISTRY.id, ...(this.serverClock ? { updated_at: this.serverClock() } : {}) };
      this.version++;
      this.commits++;
      return out;
    }
    throw new Error("airspace registry: too much contention, transaction gave up");
  }

  async listClaims(status?: ClaimStatus): Promise<ClaimRecord[]> {
    return [...this.claims.values()].filter((c) => !status || c.status === status);
  }

  async listHeld(limit: number): Promise<HeldRecord[]> {
    return [...this.held.values()].sort((a, b) => b.held_at - a.held_at).slice(0, limit);
  }
}

/* ── Registry ──────────────────────────────────────────────────────────────── */

export interface AcquireRequest {
  runId: string;
  planName: string;
  lane: AirspaceLane;
  /** Normalized typed keys the plan declared, from claimResources(plan.name, plan.airspace). */
  resources: string[];
  /** Keys derived from the declared ones (repo: of a claimed git folder). Claimed too, never compared for adoption. */
  derived?: string[];
  leaseMs?: number;
  /** Set ONLY by the cockpit's cloud Launch: the cloud runner may adopt this claim once. */
  adoptable?: boolean;
}

export class AirspaceRegistry {
  private readonly clock: RegistryClock;
  constructor(
    readonly backend: AirspaceBackend,
    clock: RegistryClock | (() => number) = Date.now,
  ) {
    this.clock = asClock(clock);
  }

  /** Server-anchored now, after making sure the anchor is fresh. */
  async now(): Promise<number> {
    await this.clock.refresh?.();
    return this.clock.now();
  }

  /** Refuse a foreign registry or a head stamped from the future; neither writes anything. */
  private async checkHead(tx: RegistryTx, now: number): Promise<void> {
    const head = await tx.readHead();
    if (head.registry_id !== undefined && head.registry_id !== REGISTRY.id) {
      throw new AirspaceRefused(
        `airspace: registry mismatch — head says "${head.registry_id}", expected "${REGISTRY.id}"`,
      );
    }
    if (head.updated_at !== undefined && head.updated_at > now + HEAD_AHEAD_TOLERANCE_MS) {
      throw new AirspaceRefused(
        `airspace: registry clock ahead — head was stamped ${head.updated_at - now} ms after our server-anchored now`,
      );
    }
  }

  /**
   * Acquire every resource for one run, atomically. Granted -> one claim doc,
   * status active, with a lease. Any overlap with another run's live claim ->
   * nothing is claimed, a held record names the holder, and the caller must not
   * launch.
   *
   * ADOPTION (cloud only): the cockpit acquires at Launch with adoptable:true and
   * the cloud runner, starting with the same run id, adopts it — once — when the
   * claim is still live and its plan, lane and DECLARED resources match. Any other
   * live claim under the same run id is held: a run id never takes over a claim.
   * A same-id claim that is no longer live (released, expired) is replaced by a
   * fresh acquire, conflicts checked like any other.
   */
  async acquire(req: AcquireRequest): Promise<AcquireResult> {
    if (!req.runId || !req.planName) throw new AirspaceError("acquire needs a runId and a planName");
    if (!req.resources.length) throw new AirspaceError("acquire needs at least one resource");
    const declared = [...new Set(req.resources.map(normalizeResource))].sort();
    const resources = [...new Set([...declared, ...(req.derived ?? []).map(normalizeResource)])].sort();
    const leaseMs = req.leaseMs ?? DEFAULT_LEASE_MS;
    await this.clock.refresh?.();
    return this.backend.transact(async (tx) => {
      const now = this.clock.now();
      // Reads run in parallel (one round-trip, not four): a transaction's latency is
      // what serializes simultaneous launches on the head doc.
      const [, active, mine, priorHeld] = await Promise.all([
        this.checkHead(tx, now),
        tx.readActive(),
        tx.readClaim(req.runId),
        tx.readHeldForPlan(req.planName),
      ]);

      for (const c of active) {
        if (c.lease_expires_at <= now && c.run_id !== req.runId) {
          tx.writeClaim({ ...c, status: "expired", adoptable: false });
        }
      }
      const hold = (conflicts: AirspaceConflict[], message: string): AcquireResult => {
        tx.writeHeld({ run_id: req.runId, plan_name: req.planName, lane: req.lane, resources, conflicts, message, held_at: now });
        return { granted: false, conflicts, message };
      };

      // A live claim under this run id: adopt it exactly once, or hold. Never take over.
      let adopted = false;
      if (mine && isLive(mine, now)) {
        const canAdopt =
          mine.adoptable === true &&
          req.lane === "cloud" &&
          mine.lane === req.lane &&
          mine.plan_name === req.planName &&
          sameSet(mine.declared ?? mine.resources, declared);
        if (!canAdopt) {
          const conflict: AirspaceConflict = {
            resource: `plan:${req.planName}`,
            held_resource: `run:${mine.run_id}`,
            holder_run_id: mine.run_id,
            holder_plan: mine.plan_name,
            holder_lane: mine.lane,
          };
          const why = mine.adoptable === true ? "does not match this launch" : "is not adoptable (already adopted, or not a cockpit Launch)";
          return hold([conflict], `held: run ${mine.run_id} already holds a live claim for ${mine.plan_name} that ${why}`);
        }
        adopted = true;
      }

      const all = adopted ? [...new Set([...mine!.resources, ...resources])].sort() : resources;
      const conflicts = findConflicts(all, active, req.runId, now);
      if (conflicts.length) return hold(conflicts, formatHeld(conflicts));

      const claim: ClaimRecord = {
        run_id: req.runId,
        plan_name: req.planName,
        lane: req.lane,
        resources: all,
        declared,
        status: "active",
        adoptable: adopted ? false : req.adoptable === true && req.lane === "cloud",
        ...(adopted ? { adopted_at: now } : {}),
        acquired_at: adopted ? mine!.acquired_at : now,
        heartbeat_at: now,
        lease_expires_at: now + leaseMs,
      };
      tx.writeClaim(claim);
      // A plan that was held earlier is no longer waiting on anyone.
      for (const h of priorHeld) if (!h.resolved_at) tx.writeHeld({ ...h, resolved_at: now });
      return { granted: true, claim, adopted };
    });
  }

  /**
   * Heartbeat: push this run's lease out. A claim that is released, expired, or
   * past its lease is NEVER revived — the run has lost its airspace and must stop.
   */
  async renew(runId: string, leaseMs = DEFAULT_LEASE_MS): Promise<RenewResult> {
    await this.clock.refresh?.();
    return this.backend.transact(async (tx) => {
      const now = this.clock.now();
      const [, mine] = await Promise.all([this.checkHead(tx, now), tx.readClaim(runId)]);
      if (!mine) return { ok: false, reason: `no claim for run ${runId}` };
      if (mine.status === "released") return { ok: false, reason: "claim was released" };
      if (mine.status === "expired") return { ok: false, reason: "claim expired" };
      if (mine.lease_expires_at <= now) {
        tx.writeClaim({ ...mine, status: "expired", adoptable: false });
        return { ok: false, reason: "lease expired before this renewal" };
      }
      const claim: ClaimRecord = { ...mine, heartbeat_at: now, lease_expires_at: now + leaseMs };
      tx.writeClaim(claim);
      return { ok: true, claim };
    });
  }

  /** Release this run's claim. Idempotent; a missing or already-released claim is a no-op. */
  async release(runId: string): Promise<boolean> {
    await this.clock.refresh?.();
    return this.backend.transact(async (tx) => {
      const now = this.clock.now();
      await this.checkHead(tx, now);
      const mine = await tx.readClaim(runId);
      if (!mine || mine.status === "released") return false;
      tx.writeClaim({ ...mine, status: "released", adoptable: false, released_at: now });
      return true;
    });
  }

  /**
   * Release only if the claim was never adopted (still adoptable). For the cockpit's
   * Cancel of a cloud run whose execution may exist: an adopted claim belongs to a
   * live runner, which releases it itself on shutdown (or the lease frees it).
   */
  async releaseIfUnadopted(runId: string): Promise<boolean> {
    await this.clock.refresh?.();
    return this.backend.transact(async (tx) => {
      const now = this.clock.now();
      await this.checkHead(tx, now);
      const mine = await tx.readClaim(runId);
      if (!mine || mine.status !== "active" || mine.adoptable !== true) return false;
      tx.writeClaim({ ...mine, status: "released", adoptable: false, released_at: now });
      return true;
    });
  }

  /** Live claims only (active and inside the lease), soonest-expiring first. */
  async listActive(): Promise<ClaimRecord[]> {
    const now = await this.now();
    return (await this.backend.listClaims("active"))
      .filter((c) => isLive(c, now))
      .sort((a, b) => a.lease_expires_at - b.lease_expires_at);
  }

  /** Recent held launches that have not since been granted. */
  async listHeld(limit = 20, withinMs = 24 * 3_600_000): Promise<HeldRecord[]> {
    const now = await this.now();
    return (await this.backend.listHeld(200))
      .filter((h) => !h.resolved_at && now - h.held_at <= withinMs)
      .slice(0, limit);
  }
}

/* ── Lease settings ────────────────────────────────────────────────────────── */

/** Refuse a lease outside [MIN_LEASE_MS, MAX_LEASE_MS] or a heartbeat slower than lease/3. */
export function checkLeaseSettings(leaseMs: number, heartbeatMs: number): void {
  if (!(leaseMs >= MIN_LEASE_MS && leaseMs <= MAX_LEASE_MS)) {
    throw new AirspaceRefused(`airspace: lease ${leaseMs} ms is outside ${MIN_LEASE_MS}–${MAX_LEASE_MS} ms`);
  }
  if (!(heartbeatMs > 0 && heartbeatMs <= leaseMs / 3)) {
    throw new AirspaceRefused(`airspace: heartbeat ${heartbeatMs} ms must be > 0 and ≤ lease/3 (${Math.floor(leaseMs / 3)} ms)`);
  }
}

/* ── Heartbeat + fence ─────────────────────────────────────────────────────── */

export interface HeartbeatHandle {
  /** Stop renewing (does not release). */
  stop(): void;
  /** True while the last confirmed lease is still safely ahead (before the fence deadline). */
  confirmed(): boolean;
  /** Renew now and report whether the lease is confirmed; undefined = fine, else the reason it is lost. */
  confirm(): Promise<string | undefined>;
}

/**
 * Keep a run's lease alive, and FENCE it: the run stops itself before its lease
 * can lapse unnoticed.
 *
 *   - sentAt: the local monotonic time the last SUCCESSFUL renew (or the acquire)
 *     was sent. The lease that renew set cannot end before sentAt + leaseMs.
 *   - deadline = sentAt + leaseMs − margin (margin = 2 × heartbeat).
 *   - A separate fence timer trips onLost at the deadline, whether renewals are
 *     failing, throwing, or hanging — it does not wait on any renewal.
 *   - Each renewal times out after one heartbeat interval; a late success still
 *     moves sentAt (it is conservative: it uses the send time), unless the fence
 *     already tripped.
 *   - A renewal the registry reports as lost (released, expired) trips onLost at once.
 */
export function startHeartbeat(
  registry: AirspaceRegistry,
  runId: string,
  opts: {
    /** Monotonic ms when the acquire transaction was sent: arms the fence before acquire returns. */
    armedAt: number;
    mono: () => number;
    intervalMs?: number;
    leaseMs?: number;
    onLost?: (reason: string) => void;
    onError?: (e: unknown) => void;
    /** Fence check cadence; defaults to min(1 s, interval / 4). */
    fenceTickMs?: number;
  },
): HeartbeatHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_HEARTBEAT_MS;
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const margin = 2 * intervalMs;
  let sentAt = opts.armedAt;
  let stopped = false;
  let tripped = false;
  let inFlight = false;

  const deadline = () => sentAt + leaseMs - margin;
  const trip = (reason: string) => {
    if (tripped) return;
    tripped = true;
    stopped = true;
    clearInterval(beat);
    clearInterval(fence);
    opts.onLost?.(reason);
  };

  const renewOnce = async (): Promise<string | undefined> => {
    const sent = opts.mono();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), intervalMs); });
    const attempt = registry.renew(runId, leaseMs).then(
      (r) => {
        if (r.ok && !tripped) sentAt = Math.max(sentAt, sent);
        return r;
      },
    );
    try {
      const r = await Promise.race([attempt, timeout]);
      if (r === "timeout") {
        attempt.catch((e) => opts.onError?.(e)); // a late settle still updates sentAt above
        return undefined;
      }
      if (!r.ok) return r.reason;
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const beat = setInterval(async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const lost = await renewOnce();
      if (lost && !stopped) trip(lost);
    } catch (e) {
      opts.onError?.(e);
    } finally {
      inFlight = false;
    }
  }, intervalMs);
  const fence = setInterval(() => {
    if (!stopped && opts.mono() >= deadline()) trip("lease unconfirmed: no successful renewal before the fence deadline");
  }, opts.fenceTickMs ?? Math.max(10, Math.min(1_000, Math.floor(intervalMs / 4))));
  (beat as { unref?: () => void }).unref?.();
  (fence as { unref?: () => void }).unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(beat);
      clearInterval(fence);
    },
    confirmed: () => !tripped && opts.mono() < deadline(),
    async confirm() {
      if (tripped) return "airspace lost";
      let lost: string | undefined;
      try {
        lost = await renewOnce();
      } catch (e) {
        opts.onError?.(e);
      }
      if (lost) {
        trip(lost);
        return lost;
      }
      return opts.mono() < deadline() ? undefined : "lease unconfirmed";
    },
  };
}
