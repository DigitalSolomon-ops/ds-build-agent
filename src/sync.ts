/**
 * Sync on command: load any project in the Projects tree into Local Builds,
 * ready for a dry run.
 *
 *   ds-build sync portfolios/own-products/fast-insurance-group
 *
 * One record per project+plan, in The Creator's `projects` collection with the
 * plan YAML in Cloud Storage: the SAME record the cloud runner (007 Agent) reads,
 * so a project is never duplicated across lanes and both lanes run one plan.
 *
 *   - Existing plan  -> queued as-is (the plan file is never modified), state
 *                       `drafted`, syncState `dry-run`. Nothing executes until
 *                       the Launch button is pressed.
 *   - Plan with no `airspace` block -> queued as syncState `needs-airspace` with
 *                       a drafted block for review. It cannot launch until the
 *                       block is declared in the plan and the project re-synced.
 *   - No plan at all -> a skeleton plan is generated, queued as syncState
 *                       `review`, and sync stops. Launch refuses a plan in review.
 *   - Re-sync with the same plan bytes -> no-op (no writes at all).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { validatePlan, PlanError } from "./parser.js";
import { orchestrate } from "./orchestrator.js";
import { draftAirspaceYaml, type AirspaceLane } from "./airspace.js";
import type { BuildPlan } from "./types.js";

/** Why a synced record cannot launch yet (absent = it can, from dry-run). */
export type SyncState = "dry-run" | "review" | "needs-airspace";

/** The fields sync owns on projects/{projectId}. Mirrors the-creator's Project type. */
export interface SyncedProject {
  projectId: string;
  name: string;
  description?: string;
  state: "drafted";
  planUri: string;
  source: "sync";
  /** Project folder, relative to the Projects root, forward slashes. */
  localPath: string;
  /** Plan file relative to the Projects root ("" for a generated draft). */
  planPath: string;
  planSource: "existing" | "generated";
  planSha256: string;
  syncState: SyncState;
  /** Normalized airspace keys; absent when the plan has none yet. */
  airspace?: string[];
  /** A drafted airspace block for review, when the plan has none. */
  airspaceDraft?: string;
  /** Agent-free routing preview, computed at sync time. */
  dryRun?: { wouldBuild: number; deferred: number; skipped: number; tasks: number };
  lanes: AirspaceLane[];
  syncedAt: number;
  createdAt: number;
  updatedAt: number;
}

/** Storage seam: Firestore + GCS in production, memory in the checks. */
export interface SyncBackend {
  getProject(projectId: string): Promise<(Partial<Omit<SyncedProject, "state">> & { state?: string; localLaunch?: { state?: string } }) | undefined>;
  putProject(doc: SyncedProject): Promise<void>;
  uploadPlan(projectId: string, yaml: string): Promise<string>;
}

export type SyncAction = "queued" | "updated" | "unchanged" | "generated-for-review" | "refused";

export interface SyncResult {
  action: SyncAction;
  projectId?: string;
  syncState?: SyncState;
  planPath?: string;
  message: string;
  /** The generated plan or drafted airspace, for the operator to review. */
  draft?: string;
}

/** Walk up from `start` to the folder holding studio.yaml (the Projects root). */
export function findProjectsRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "studio.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** A project folder from a path (absolute, cwd- or root-relative) or a bare project key. */
export function resolveProjectDir(arg: string, root: string): string | undefined {
  // Only folders inside portfolios/ are projects: a stray same-named folder at the
  // Projects root (pre-migration leftovers exist) must never be synced.
  const portfolios = join(root, "portfolios");
  const inPortfolios = (d: string) => {
    const rel = relative(portfolios, d);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  for (const c of [resolve(arg), resolve(root, arg)]) {
    if (existsSync(c) && statSync(c).isDirectory() && inPortfolios(c)) return c;
  }
  if (!existsSync(portfolios)) return undefined;
  const hits: string[] = [];
  for (const p of readdirSync(portfolios)) {
    const pd = join(portfolios, p);
    if (!statSync(pd).isDirectory()) continue;
    if (existsSync(join(pd, arg))) hits.push(join(pd, arg));
    for (const c of readdirSync(pd)) {
      const cd = join(pd, c);
      if (statSync(cd).isDirectory() && existsSync(join(cd, "client.yaml")) && existsSync(join(cd, arg))) {
        hits.push(join(cd, arg));
      }
    }
  }
  return hits.length === 1 ? hits[0] : undefined;
}

const toPosix = (p: string) => p.replace(/\\/g, "/");

function readProjectYaml(dir: string): Record<string, unknown> {
  try {
    const y = parseYaml(readFileSync(join(dir, "project.yaml"), "utf8"));
    return typeof y === "object" && y !== null ? (y as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Find a project's build plan. Order: an explicit --plan; project.yaml's
 * `spine.plan` (the plan-paths-are-contracts declaration); `plan.yaml`; exactly
 * one `plans/*.yaml`; exactly one `*.plan.yaml` at the project root. Throws when
 * a step finds several candidates — sync never guesses between plans.
 */
export function discoverPlan(dir: string, explicit?: string): string | undefined {
  if (explicit) {
    const p = resolve(dir, explicit);
    if (!existsSync(p)) throw new Error(`--plan ${explicit} does not exist`);
    return p;
  }
  const py = readProjectYaml(dir);
  const spine = (typeof py.spine === "object" && py.spine !== null ? py.spine : {}) as Record<string, unknown>;
  const declared = spine.plan ?? py.plan;
  if (typeof declared === "string" && declared.trim()) {
    const p = resolve(dir, declared.trim());
    if (!existsSync(p)) throw new Error(`project.yaml declares plan ${declared}, which does not exist`);
    return p;
  }
  if (existsSync(join(dir, "plan.yaml"))) return join(dir, "plan.yaml");
  const pick = (folder: string, test: (f: string) => boolean, label: string) => {
    if (!existsSync(folder)) return undefined;
    const files = readdirSync(folder).filter(test).sort();
    if (files.length > 1) {
      throw new Error(`several plans in ${label} (${files.join(", ")}); choose one with --plan`);
    }
    return files.length ? join(folder, files[0]) : undefined;
  };
  return (
    pick(join(dir, "plans"), (f) => /\.ya?ml$/i.test(f), "plans/") ??
    pick(dir, (f) => /\.plan\.ya?ml$/i.test(f), "the project root")
  );
}

/** owner/name of the project's GitHub remote, if it is its own repo. */
function gitRepoOf(dir: string): string | undefined {
  try {
    const cfg = readFileSync(join(dir, ".git", "config"), "utf8");
    const m = /url\s*=\s*(?:https:\/\/github\.com\/|git@github\.com:)([^\s]+?)(?:\.git)?\s*$/m.exec(cfg);
    return m?.[1];
  } catch {
    return undefined;
  }
}

/** Deterministic record id: the same project+plan always lands on the same doc. */
export function syncProjectId(localPath: string, planStem: string): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `sync--${slug(localPath.replace(/^portfolios\//, ""))}--${slug(planStem)}`.slice(0, 150);
}

/**
 * A skeleton plan for a project that has none. Deliberately thin: it exists to
 * be reviewed and replaced, never launched as-is (its record is `review`).
 */
export function generateSkeletonPlan(dir: string, localPath: string): string {
  const py = readProjectYaml(dir);
  const proj = (typeof py.project === "object" && py.project !== null ? py.project : {}) as Record<string, unknown>;
  const name = String(proj.key ?? basename(dir)).replace(/[^\w.-]+/g, "-");
  const purpose = String(proj.purpose ?? proj.name ?? "").replace(/\s+/g, " ").trim();
  const repo = gitRepoOf(dir);
  const airspace = draftAirspaceYaml({ projectPath: localPath, repo });
  return [
    `# GENERATED by ds-build sync for review. Replace these tasks with the real build,`,
    `# save it in the project (e.g. plan.yaml), then run sync again.`,
    `project:`,
    `  name: ${name}`,
    `  description: ${JSON.stringify(purpose || `Build plan for ${localPath}`)}`,
    airspace.trimEnd(),
    `tasks:`,
    `  - id: 0-review-plan`,
    `    title: Review and replace this generated plan`,
    `    executor: human`,
    `    prompt: >`,
    `      This plan was generated because ${localPath} had none. Confirm the airspace`,
    `      block, write the real tasks, save the plan in the project and sync again.`,
    `  - id: 1-survey`,
    `    title: Survey the project and propose a plan`,
    `    deps: [0-review-plan]`,
    `    prompt: >`,
    `      Read project.yaml, README.md and the code in this folder. Write PLAN-PROPOSAL.md`,
    `      listing the tasks, dependencies and acceptance checks a full build plan needs.`,
    `    outputs: [PLAN-PROPOSAL.md]`,
    `    scope: [PLAN-PROPOSAL.md]`,
    ``,
  ].join("\n");
}

/** Agent-free routing preview (orchestrate in dry-run: no agents, no writes). */
async function dryRunSummary(plan: BuildPlan): Promise<SyncedProject["dryRun"]> {
  const results = await orchestrate(plan, { repoPath: ".", concurrency: 3, dryRun: true });
  const n = (s: string) => results.filter((r) => r.status === s).length;
  return { wouldBuild: n("success"), deferred: n("deferred"), skipped: n("skipped"), tasks: plan.tasks.length };
}

/** Validate; on failure say whether the ONLY problem is the missing airspace block. */
function classify(yaml: string): { plan?: BuildPlan; missingAirspace?: boolean; error?: string } {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (e) {
    return { error: `plan is not parseable YAML: ${(e as Error).message}` };
  }
  try {
    return { plan: validatePlan(raw, { quiet: true }) };
  } catch (e) {
    if (!(e instanceof PlanError)) throw e;
    const r = raw as Record<string, unknown> | null;
    if (r && typeof r === "object" && r.airspace === undefined) {
      try {
        const plan = validatePlan({ ...r, airspace: ["path:__pending__"] }, { quiet: true });
        plan.airspace = [];
        return { plan, missingAirspace: true };
      } catch { /* invalid for other reasons too */ }
    }
    return { error: e.message };
  }
}

export async function syncProject(opts: {
  projectArg: string;
  root: string;
  backend: SyncBackend;
  planArg?: string;
  /** Preview only: report what sync would do, write nothing. */
  dryRun?: boolean;
  now?: number;
}): Promise<SyncResult> {
  const now = opts.now ?? Date.now();
  const dir = resolveProjectDir(opts.projectArg, opts.root);
  if (!dir) return { action: "refused", message: `no single project folder matches "${opts.projectArg}"` };
  const localPath = toPosix(relative(opts.root, dir));
  if (!localPath || localPath.startsWith("..")) {
    return { action: "refused", message: `${dir} is not inside the Projects tree (${opts.root})` };
  }

  let planFile: string | undefined;
  try {
    planFile = discoverPlan(dir, opts.planArg);
  } catch (e) {
    return { action: "refused", message: (e as Error).message };
  }

  const generated = !planFile;
  const yaml = planFile ? readFileSync(planFile, "utf8") : generateSkeletonPlan(dir, localPath);
  const planPath = planFile ? toPosix(relative(opts.root, planFile)) : "";
  const stem = planFile ? basename(planFile).replace(/(\.plan)?\.ya?ml$/i, "") : "generated";
  const projectId = syncProjectId(localPath, stem);

  const c = classify(yaml);
  if (c.error || !c.plan) {
    return { action: "refused", projectId, planPath, message: `plan is invalid, nothing queued: ${c.error}` };
  }
  const syncState: SyncState = generated ? "review" : c.missingAirspace ? "needs-airspace" : "dry-run";
  const sha = createHash("sha256").update(yaml).digest("hex");

  const existing = await opts.backend.getProject(projectId);
  if (existing && existing.planSha256 === sha && existing.planPath === planPath) {
    return {
      action: "unchanged",
      projectId,
      syncState: existing.syncState ?? syncState,
      planPath,
      message: `already queued (${projectId}); plan unchanged, nothing written`,
    };
  }
  if (existing && (existing.state === "running" || existing.localLaunch?.state === "running" ||
      existing.localLaunch?.state === "requested")) {
    return { action: "refused", projectId, planPath, message: `${projectId} is launching or running; sync again after it finishes` };
  }

  const airspaceDraft = c.missingAirspace || generated
    ? draftAirspaceYaml({ projectPath: localPath, repo: gitRepoOf(dir) })
    : undefined;
  const action: SyncAction = generated ? "generated-for-review" : existing ? "updated" : "queued";
  const draft = generated ? yaml : airspaceDraft;
  if (opts.dryRun) {
    return { action, projectId, syncState, planPath, message: `[preview] would ${action} ${projectId} as ${syncState}`, draft };
  }

  const planUri = await opts.backend.uploadPlan(projectId, yaml);
  const doc: SyncedProject = {
    projectId,
    name: c.plan.name,
    description: c.plan.description,
    state: "drafted",
    planUri,
    source: "sync",
    localPath,
    planPath,
    planSource: generated ? "generated" : "existing",
    planSha256: sha,
    syncState,
    airspace: c.missingAirspace ? undefined : c.plan.airspace,
    airspaceDraft,
    dryRun: await dryRunSummary(c.plan),
    lanes: ["local", "cloud"],
    syncedAt: now,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await opts.backend.putProject(doc);

  const why =
    syncState === "review" ? "generated plan; review it, save it in the project, and sync again"
    : syncState === "needs-airspace" ? "plan has no airspace block; declare it in the plan and sync again"
    : "ready for a dry run; nothing runs until Launch is pressed";
  return { action, projectId, syncState, planPath, message: `${action}: ${projectId} (${why})`, draft };
}

/* ── Production backend: The Creator's Firestore + bucket ─────────────────── */

export async function creatorSyncBackend(): Promise<SyncBackend> {
  const { Firestore } = await import("@google-cloud/firestore");
  const { Storage } = await import("@google-cloud/storage");
  const projectId = process.env.GCP_PROJECT_ID ?? "digitalsolomon-creator";
  const db = new Firestore({ projectId, ignoreUndefinedProperties: true });
  const bucket = new Storage({ projectId }).bucket(process.env.CREATOR_BUCKET ?? `${projectId}-creator`);
  return {
    async getProject(id) {
      const s = await db.collection("projects").doc(id).get();
      return s.exists ? (s.data() as SyncedProject) : undefined;
    },
    async putProject(doc) {
      // merge: never clobber fields other surfaces own (credentialSlots, runs' state...).
      // Sync-owned optionals go as null, so a re-sync clears a stale value.
      await db.collection("projects").doc(doc.projectId).set(
        { ...doc, airspace: doc.airspace ?? null, airspaceDraft: doc.airspaceDraft ?? null },
        { merge: true },
      );
    },
    async uploadPlan(id, yaml) {
      const path = `plans/${id}.plan.yaml`;
      await bucket.file(path).save(yaml, { contentType: "application/yaml", resumable: false });
      return `gs://${bucket.name}/${path}`;
    },
  };
}
