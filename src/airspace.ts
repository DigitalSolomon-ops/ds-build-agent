/**
 * Airspace control — one registry of what every active run is touching, shared by
 * the local lane (ds-build on blacktop) and the cloud lane (solomon-runner), so
 * no two runs ever work the same resources at the same time.
 *
 *   - Every plan declares an `airspace` block: the repos, folders, GHL locations,
 *     GHL pipelines and other shared resources it writes to (parseAirspaceBlock).
 *   - Before any launch the launcher acquires claims for ALL of them in one
 *     transaction. All are granted or none are (AirspaceRegistry.acquire).
 *   - Any overlap with a live claim is a HARD BLOCK. There is deliberately no
 *     override flag and no force option anywhere in this file — do not add one.
 *   - Each claim carries a lease the run renews by heartbeat. An expired lease
 *     frees the claim, so a crashed run cannot lock a project forever.
 *
 * MIRRORED FILE. This exact file is copied byte-for-byte into
 * the-creator/packages/shared/src/airspace.ts (the cockpit launches cloud runs and
 * renders the panel from the same registry). ds-build-agent is the source of
 * truth; checks/airspace-parity.test.mjs fails if the two copies drift. It is
 * self-contained on purpose: no imports, and Firestore is duck-typed so the two
 * repos' different @google-cloud/firestore versions both fit.
 */

/* ── Resource keys ─────────────────────────────────────────────────────────── */

/** Which lane a run belongs to. They bill differently and never merge. */
export type AirspaceLane = "local" | "cloud";

/** Known resource types. Any other `type:value` key is allowed and matched exactly. */
export const KNOWN_RESOURCE_TYPES = ["repo", "path", "ghl_location", "ghl_pipeline", "plan"] as const;

/** Lease and heartbeat defaults (open question 1, decided in docs/AIRSPACE.md). */
export const DEFAULT_LEASE_MS = 5 * 60_000;
export const DEFAULT_HEARTBEAT_MS = 60_000;

/** Default owner for a bare repo name (`repo:ds-build-agent`). */
const DEFAULT_REPO_OWNER = "digitalsolomon-ops";

/** Types whose values compare case-sensitively. GHL location ids are opaque ids. */
const CASE_SENSITIVE_TYPES = new Set(["ghl_location"]);

/** Thrown for an invalid `airspace` block or resource key. */
export class AirspaceError extends Error {}

/**
 * Normalize one typed resource key, e.g. `path:Portfolios\Foo\` -> `path:portfolios/foo`.
 * Throws AirspaceError on anything malformed. Folder-level only: no globs.
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
    value = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (/^[a-z]:/i.test(value) || value.startsWith("/")) {
      throw new AirspaceError(`path "${value}" must be relative to the Projects root, not absolute`);
    }
    if (value.split("/").some((s) => s === "..")) throw new AirspaceError(`path "${value}" may not contain ".."`);
    if (/[*?[\]]/.test(value)) throw new AirspaceError(`path "${value}" is a glob; claim the folder instead`);
    if (!value || value === ".") throw new AirspaceError(`path "${key}" claims the whole tree; name a folder`);
    value = value.toLowerCase();
  } else if (type === "repo") {
    value = value
      .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
      .replace(/^git@github\.com:/i, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
    if (!value.includes("/")) value = `${DEFAULT_REPO_OWNER}/${value}`;
    if (value.split("/").length !== 2 || value.split("/").some((s) => !s)) {
      throw new AirspaceError(`repo "${key}" must be owner/name, a bare name, or a GitHub URL`);
    }
  }
  return `${type}:${value}`;
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

/**
 * Parse a plan's `airspace` block into a sorted, de-duplicated list of normalized
 * typed keys. Accepts the map form
 *
 *   airspace:
 *     repos: [DigitalSolomon-ops/fast-insurance-group]
 *     paths: [portfolios/own-products/fast-insurance-group/build]
 *     ghl_locations: [OwTVypw5mcI0oznL5Bgd]
 *     ghl_pipelines: ["Partner Sales"]
 *     other: ["n8n_workflow:lead-router"]
 *
 * or a flat list of typed keys (`["repo:x", "path:y"]`). Strict on purpose: an
 * unknown map key (`path:` for `paths:`) would otherwise drop a claim silently,
 * and a missing or empty block is a plan that has not said what it touches.
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
  resources: string[];
  status: ClaimStatus;
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

/** "held: conflicts with fast-insurance-group on ghl_pipeline:Partner Sales" (+ the rest, counted). */
export function formatHeld(conflicts: AirspaceConflict[]): string {
  if (!conflicts.length) return "";
  const first = conflicts[0];
  const more = conflicts.length > 1 ? ` (+${conflicts.length - 1} more)` : "";
  return (
    `held: conflicts with ${first.holder_plan} on ${first.held_resource}` +
    ` [run ${first.holder_run_id}, ${first.holder_lane} lane]${more}`
  );
}

/* ── Backends ──────────────────────────────────────────────────────────────── */

/** What one registry transaction may do. All reads happen before any write lands. */
export interface RegistryTx {
  readActive(): Promise<ClaimRecord[]>;
  readClaim(runId: string): Promise<ClaimRecord | undefined>;
  readHeldForPlan(planName: string): Promise<HeldRecord[]>;
  writeClaim(c: ClaimRecord): void;
  writeHeld(h: HeldRecord): void;
}

export interface AirspaceBackend {
  /** Run `fn` serializably against the registry; retried by the backend on contention. */
  transact<T>(fn: (tx: RegistryTx) => Promise<T>): Promise<T>;
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
const TS_FIELDS = ["acquired_at", "heartbeat_at", "lease_expires_at", "released_at", "held_at", "resolved_at"];
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

/* Minimal structural Firestore types: both repos' SDK versions satisfy these. */
interface FsSnap { exists: boolean; data(): Record<string, unknown> | undefined }
interface FsQuerySnap { docs: { data(): Record<string, unknown> }[] }
interface FsQuery { get(): Promise<FsQuerySnap>; where(f: string, op: string, v: unknown): FsQuery; limit(n: number): FsQuery }
interface FsDocRef { get(): Promise<FsSnap> }
interface FsCollection extends FsQuery { doc(id: string): FsDocRef }
interface FsTransaction {
  get(ref: FsDocRef): Promise<FsSnap>;
  get(q: FsQuery): Promise<FsQuerySnap>;
  set(ref: FsDocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): unknown;
}
export interface FirestoreLike {
  collection(name: string): FsCollection;
  runTransaction<T>(fn: (t: FsTransaction) => Promise<T>): Promise<T>;
}

export interface FirestoreBackendOptions {
  claimsCollection?: string;
  heldCollection?: string;
  /** Collection holding the single `head` doc every transaction reads and writes. */
  registryCollection?: string;
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
  constructor(private readonly db: FirestoreLike, opts: FirestoreBackendOptions = {}) {
    this.claims = opts.claimsCollection ?? "airspaceClaims";
    this.held = opts.heldCollection ?? "airspaceHeld";
    this.registry = opts.registryCollection ?? "airspaceRegistry";
  }

  transact<T>(fn: (tx: RegistryTx) => Promise<T>): Promise<T> {
    const db = this.db;
    return db.runTransaction(async (t) => {
      const headRef = db.collection(this.registry).doc("head");
      const head = await t.get(headRef);
      const writes: ((t: FsTransaction) => void)[] = [];
      const tx: RegistryTx = {
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
      for (const w of writes) w(t);
      const version = Number(head.exists ? head.data()?.version ?? 0 : 0) + 1;
      t.set(headRef, { version, updated_at: new Date() });
      return out;
    });
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
 * the acceptance checks, and a faithful model of how the real registry behaves
 * under simultaneous launches.
 */
export class MemoryAirspaceBackend implements AirspaceBackend {
  private version = 0;
  readonly claims = new Map<string, ClaimRecord>();
  readonly held = new Map<string, HeldRecord>();
  /** Number of transaction attempts that lost a race and re-ran (for tests). */
  retries = 0;

  async transact<T>(fn: (tx: RegistryTx) => Promise<T>): Promise<T> {
    const tick = () => new Promise<void>((r) => setImmediate(r));
    for (let attempt = 0; attempt < 25; attempt++) {
      const start = this.version;
      const writes: (() => void)[] = [];
      const clone = <V>(v: V): V => JSON.parse(JSON.stringify(v));
      const tx: RegistryTx = {
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
      this.version++;
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
  /** Normalized typed keys, from claimResources(plan.name, plan.airspace). */
  resources: string[];
  leaseMs?: number;
}

export class AirspaceRegistry {
  constructor(
    readonly backend: AirspaceBackend,
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * Acquire every resource for one run, atomically. Granted -> one claim doc,
   * status active, with a lease. Any overlap with another run's live claim ->
   * nothing is claimed, a held record names the holder, and the caller must not
   * launch. If this run already holds a live claim (the cockpit acquired it and
   * the runner is now starting), the claim is ADOPTED and its lease renewed.
   * Expired claims seen along the way are marked expired.
   */
  acquire(req: AcquireRequest): Promise<AcquireResult> {
    if (!req.runId || !req.planName) throw new AirspaceError("acquire needs a runId and a planName");
    if (!req.resources.length) throw new AirspaceError("acquire needs at least one resource");
    const resources = [...new Set(req.resources.map(normalizeResource))].sort();
    const leaseMs = req.leaseMs ?? DEFAULT_LEASE_MS;
    return this.backend.transact(async (tx) => {
      const now = this.clock();
      const active = await tx.readActive();
      const mine = await tx.readClaim(req.runId);
      const priorHeld = await tx.readHeldForPlan(req.planName);

      for (const c of active) {
        if (c.lease_expires_at <= now && c.run_id !== req.runId) tx.writeClaim({ ...c, status: "expired" });
      }
      const conflicts = findConflicts(resources, active, req.runId, now);
      if (conflicts.length) {
        const message = formatHeld(conflicts);
        tx.writeHeld({
          run_id: req.runId,
          plan_name: req.planName,
          lane: req.lane,
          resources,
          conflicts,
          message,
          held_at: now,
        });
        return { granted: false, conflicts, message };
      }
      const adopted = !!mine && isLive(mine, now);
      const claim: ClaimRecord = {
        run_id: req.runId,
        plan_name: req.planName,
        lane: req.lane,
        resources,
        status: "active",
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
   * Heartbeat: push this run's lease out. Fails (the run has LOST its airspace)
   * when the claim was released, or its lease lapsed and another run has since
   * claimed overlapping resources. A lapsed lease nobody contested is revived.
   */
  renew(runId: string, leaseMs = DEFAULT_LEASE_MS): Promise<RenewResult> {
    return this.backend.transact(async (tx) => {
      const now = this.clock();
      const mine = await tx.readClaim(runId);
      const active = await tx.readActive();
      if (!mine) return { ok: false, reason: `no claim for run ${runId}` };
      if (mine.status === "released") return { ok: false, reason: "claim was released" };
      if (mine.lease_expires_at <= now || mine.status === "expired") {
        const conflicts = findConflicts(mine.resources, active, runId, now);
        if (conflicts.length) {
          if (mine.status !== "expired") tx.writeClaim({ ...mine, status: "expired" });
          return { ok: false, reason: `lease expired and the airspace was taken: ${formatHeld(conflicts)}` };
        }
      }
      const claim: ClaimRecord = { ...mine, status: "active", heartbeat_at: now, lease_expires_at: now + leaseMs };
      tx.writeClaim(claim);
      return { ok: true, claim };
    });
  }

  /** Release this run's claim. Idempotent; a missing or already-released claim is a no-op. */
  release(runId: string): Promise<boolean> {
    return this.backend.transact(async (tx) => {
      const mine = await tx.readClaim(runId);
      if (!mine || mine.status === "released") return false;
      tx.writeClaim({ ...mine, status: "released", released_at: this.clock() });
      return true;
    });
  }

  /** Live claims only (active and inside the lease), soonest-expiring first. */
  async listActive(): Promise<ClaimRecord[]> {
    const now = this.clock();
    return (await this.backend.listClaims("active"))
      .filter((c) => isLive(c, now))
      .sort((a, b) => a.lease_expires_at - b.lease_expires_at);
  }

  /** Recent held launches that have not since been granted. */
  async listHeld(limit = 20, withinMs = 24 * 3_600_000): Promise<HeldRecord[]> {
    const now = this.clock();
    return (await this.backend.listHeld(200))
      .filter((h) => !h.resolved_at && now - h.held_at <= withinMs)
      .slice(0, limit);
  }
}

/**
 * Keep a run's lease alive. Renews every `intervalMs`; when a renewal reports the
 * airspace LOST, calls `onLost` once and stops (the caller halts dispatch). A
 * renewal that merely errors (network) is reported to `onError` and retried on
 * the next beat — the lease is several beats long, so one blip does not lose it.
 */
export function startHeartbeat(
  registry: AirspaceRegistry,
  runId: string,
  opts: {
    intervalMs?: number;
    leaseMs?: number;
    onLost?: (reason: string) => void;
    onError?: (e: unknown) => void;
  } = {},
): () => void {
  let stopped = false;
  let inFlight = false;
  const timer = setInterval(async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const r = await registry.renew(runId, opts.leaseMs ?? DEFAULT_LEASE_MS);
      if (!r.ok && !stopped) {
        stopped = true;
        clearInterval(timer);
        opts.onLost?.(r.reason);
      }
    } catch (e) {
      opts.onError?.(e);
    } finally {
      inFlight = false;
    }
  }, opts.intervalMs ?? DEFAULT_HEARTBEAT_MS);
  (timer as { unref?: () => void }).unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
