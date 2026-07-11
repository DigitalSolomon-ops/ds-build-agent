/**
 * ds-build-agent dashboard — local, read-and-run web UI for the harness.
 *
 * Bound to 127.0.0.1 only. It can spawn the harness (a real, paid operation),
 * so every input is validated and nothing is ever passed through a shell.
 */
import "./load-env.js"; // must be first: loads .env before anything reads process.env
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, statSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, resolve, join, basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadPlan, validatePlan, PlanError } from "../parser.js";
import type { BuildPlan } from "../types.js";
import { analyzePlan } from "./plan-analysis.js";
import { HOST, PORT, PUBLIC_DIR, BUILDS_ROOT, PLANS_ROOT, MIN_CONCURRENCY, MAX_CONCURRENCY, safePlanName } from "./config.js";
import { sendJson, sendError, serveStatic, readJsonBody, containedPath } from "./http.js";

const execFileP = promisify(execFile);

/** The two docs the HARNESS itself authors; everything else is agent output. */
const HARNESS_DOCS = new Set(["BLOCKERS.md", "GHL-SETUP.md"]);

/** Resolve a `build` query param to an existing folder inside BUILDS_ROOT. */
function resolveBuildFolder(buildParam: string | null): string {
  if (!buildParam) throw new HttpError(400, "Missing `build` query parameter.");
  const safe = safePlanName(buildParam);
  const abs = containedPath(BUILDS_ROOT, safe);
  if (!abs) throw new HttpError(400, "Invalid build name.");
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new HttpError(404, `No build folder for "${buildParam}".`);
  }
  return abs;
}
import {
  startRun,
  getRun,
  listRuns,
  activeRunForFolder,
  buildFolderFor,
  harnessBuilt,
} from "./run-manager.js";

/** Validate & load a plan path from a query param. Throws a 4xx-worthy Error. */
function loadPlanFromQuery(pathParam: string | null) {
  if (!pathParam) throw new HttpError(400, "Missing `path` query parameter.");
  const abs = resolve(pathParam);
  const ext = extname(abs).toLowerCase();
  if (ext !== ".yaml" && ext !== ".yml") {
    throw new HttpError(400, "Plan path must be a .yaml or .yml file.");
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new HttpError(404, `Plan file not found: ${abs}`);
  }
  try {
    return { abs, plan: loadPlan(abs) };
  } catch (e) {
    if (e instanceof PlanError) throw new HttpError(400, `Invalid plan: ${e.message}`);
    throw e;
  }
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Validate a POST /api/runs body into StartRunParams. Enforces every guardrail:
 * a real (non-dry) run needs an explicit confirm + an API key; --only ids must
 * exist; concurrency is bounded; and no second run may target the same folder.
 */
function validateRunRequest(body: unknown) {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "Expected a JSON object.");
  const b = body as Record<string, unknown>;

  const { abs: planPath, plan } = loadPlanFromQuery(typeof b.planPath === "string" ? b.planPath : null);

  // Dry-run is the DEFAULT; a real run must opt out explicitly.
  const dryRun = b.dryRun !== false;

  let concurrency = 3;
  if (b.concurrency !== undefined) {
    const n = Number(b.concurrency);
    if (!Number.isInteger(n) || n < MIN_CONCURRENCY || n > MAX_CONCURRENCY) {
      throw new HttpError(400, `concurrency must be an integer in [${MIN_CONCURRENCY}, ${MAX_CONCURRENCY}].`);
    }
    concurrency = n;
  }

  let only: string[] | undefined;
  if (b.only !== undefined) {
    if (!Array.isArray(b.only) || b.only.some((x) => typeof x !== "string")) {
      throw new HttpError(400, "only must be an array of task-id strings.");
    }
    const ids = new Set(plan.tasks.map((t) => t.id));
    const unknown = (b.only as string[]).filter((id) => !ids.has(id));
    if (unknown.length) throw new HttpError(400, `Unknown task id(s) in only: ${unknown.join(", ")}`);
    only = b.only as string[];
    if (!only.length) only = undefined;
  }

  if (!harnessBuilt()) {
    throw new HttpError(409, "Harness is not built. Run `npm run build` first.");
  }

  if (!dryRun) {
    if (b.confirmed !== true) {
      throw new HttpError(428, "A real (non-dry) run requires explicit confirmation (confirmed: true).");
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new HttpError(400, "ANTHROPIC_API_KEY is not set; a real run cannot call the API.");
    }
  }

  const folder = buildFolderFor(plan as BuildPlan);
  const active = activeRunForFolder(folder);
  if (active) {
    throw new HttpError(409, `A run is already active for ${folder} (run ${active.id}). Stop it first.`);
  }

  return { planPath, plan, dryRun, concurrency, only };
}

/**
 * Read the build's own git repo (created by commit_after_each_task). Commit
 * subjects are `<task-id>: <title>`, so we split off the id for task linking.
 * Returns { isRepo:false } when the folder was never committed.
 */
async function readCommits(folder: string) {
  // Require the build folder's OWN `.git`, not an ancestor's. `git rev-parse
  // --git-dir` would succeed against a parent repo (e.g. an archived build
  // nested inside the harness repo) and surface that repo's commits as if they
  // were this build's rollback points. This mirrors the isolation fix in
  // orchestrator.ts gitCommit — the dashboard only ever reads a build's own repo.
  if (!existsSync(join(folder, ".git"))) {
    return { isRepo: false, commits: [] as unknown[] };
  }
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", folder, "log", "--no-color", "--pretty=format:%H%x1f%s%x1f%aI"],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const commits = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, subject, date] = line.split("\x1f");
        const sep = subject.indexOf(": ");
        const taskId = sep > 0 ? subject.slice(0, sep) : null;
        return { hash, short: hash.slice(0, 8), subject, date, taskId };
      });
    return { isRepo: true, commits };
  } catch (e) {
    return { isRepo: true, commits: [] as unknown[], error: (e as Error).message };
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const { pathname } = url;
  const method = req.method ?? "GET";

  // ---- API routes ----
  if (pathname === "/api/health" && method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      buildsRoot: BUILDS_ROOT,
      apiKeySet: Boolean(process.env.ANTHROPIC_API_KEY),
    });
  }

  if (pathname === "/api/plan" && method === "GET") {
    const { abs, plan } = loadPlanFromQuery(url.searchParams.get("path"));
    return sendJson(res, 200, { path: abs, view: analyzePlan(plan) });
  }

  // Upload a plan chosen in the browser. A file input only exposes bytes, not a
  // path, so we validate the YAML and PERSIST it under PLANS_ROOT — giving it a
  // real on-disk path the run manager can later spawn the harness against.
  if (pathname === "/api/plans" && method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(req, 1024 * 1024); // plans are small; 1 MB is ample
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    if (typeof body !== "object" || body === null) throw new HttpError(400, "Expected a JSON object.");
    const b = body as Record<string, unknown>;
    const filename = typeof b.filename === "string" ? b.filename : "";
    const content = typeof b.content === "string" ? b.content : "";
    if (!content.trim()) throw new HttpError(400, "Uploaded file is empty.");
    const base = basename(filename);
    const ext = extname(base).toLowerCase();
    if (ext !== ".yaml" && ext !== ".yml") throw new HttpError(400, "Only .yaml or .yml files.");

    // Validate BEFORE writing so a bad plan never lands on disk.
    let plan: BuildPlan;
    try {
      plan = validatePlan(parseYaml(content));
    } catch (e) {
      if (e instanceof PlanError) throw new HttpError(400, `Invalid plan: ${e.message}`);
      throw new HttpError(400, `Could not parse YAML: ${(e as Error).message}`);
    }

    // basename + safePlanName strip any directory and traversal; the result is
    // always a plain filename inside PLANS_ROOT.
    const abs = join(PLANS_ROOT, safePlanName(base));
    mkdirSync(PLANS_ROOT, { recursive: true });
    writeFileSync(abs, content, "utf8");
    return sendJson(res, 201, { path: abs, view: analyzePlan(plan) });
  }

  if (pathname === "/api/runs" && method === "GET") {
    return sendJson(res, 200, { runs: listRuns() });
  }

  if (pathname === "/api/runs" && method === "POST") {
    // A malformed or oversized body is the client's fault → 400, not a 500.
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const params = validateRunRequest(body);
    const run = startRun(params);
    return sendJson(res, 201, { runId: run.id, run: run.summary() });
  }

  const streamMatch = pathname.match(/^\/api\/runs\/([^/]+)\/stream$/);
  if (streamMatch && method === "GET") {
    const run = getRun(decodeURIComponent(streamMatch[1]));
    if (!run) throw new HttpError(404, "Unknown run id.");
    return run.subscribe(res); // takes over the response (SSE)
  }

  const stopMatch = pathname.match(/^\/api\/runs\/([^/]+)\/stop$/);
  if (stopMatch && method === "POST") {
    const run = getRun(decodeURIComponent(stopMatch[1]));
    if (!run) throw new HttpError(404, "Unknown run id.");
    run.stop();
    return sendJson(res, 200, { run: run.summary() });
  }

  // Last persisted run-state.json for a build (for reloading a finished run).
  if (pathname === "/api/state" && method === "GET") {
    const folder = resolveBuildFolder(url.searchParams.get("build"));
    const statePath = join(BUILDS_ROOT, ".ds-runs", basename(folder), "run-state.json");
    if (!existsSync(statePath)) return sendJson(res, 200, { state: null });
    try {
      return sendJson(res, 200, { state: JSON.parse(readFileSync(statePath, "utf8")) });
    } catch {
      throw new HttpError(409, "run-state.json is mid-write; retry.");
    }
  }

  // List the report/handoff markdown files present in a build folder.
  if (pathname === "/api/files" && method === "GET") {
    const folder = resolveBuildFolder(url.searchParams.get("build"));
    const files = readdirSync(folder, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".md"))
      .map((d) => ({
        name: d.name,
        harnessAuthored: HARNESS_DOCS.has(d.name),
        size: statSync(join(folder, d.name)).size,
      }))
      .sort((a, b) => Number(b.harnessAuthored) - Number(a.harnessAuthored) || a.name.localeCompare(b.name));
    return sendJson(res, 200, { files });
  }

  // Raw text of a single whitelisted .md file inside a build folder.
  if (pathname === "/api/file" && method === "GET") {
    const folder = resolveBuildFolder(url.searchParams.get("build"));
    const nameParam = url.searchParams.get("file") ?? "";
    if (extname(nameParam).toLowerCase() !== ".md") throw new HttpError(400, "Only .md files.");
    const abs = containedPath(folder, nameParam);
    if (!abs) throw new HttpError(403, "Path escapes the build folder.");
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new HttpError(404, "File not found.");
    return sendJson(res, 200, { name: basename(abs), content: readFileSync(abs, "utf8") });
  }

  // Git commits in a build's own repo — rollback references per task.
  if (pathname === "/api/commits" && method === "GET") {
    const folder = resolveBuildFolder(url.searchParams.get("build"));
    return sendJson(res, 200, await readCommits(folder));
  }

  // ---- Static client ----
  if (pathname === "/favicon.ico" && method === "GET") {
    res.writeHead(204).end();
    return;
  }
  if (method === "GET") {
    return serveStatic(res, PUBLIC_DIR, pathname);
  }

  sendError(res, 405, "Method not allowed");
}

// Safety net: a stray error anywhere (e.g. an SSE write to a socket that
// closed mid-run) must LOG and keep the server alive, never crash the process.
// This is what stops the dashboard from silently dying → ERR_CONNECTION_REFUSED.
process.on("uncaughtException", (err) => {
  console.error("[dashboard] uncaught exception (kept running):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[dashboard] unhandled rejection (kept running):", reason);
});

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (e instanceof HttpError) sendError(res, e.status, e.message);
    else {
      // eslint-disable-next-line no-console
      console.error("Unhandled error:", e);
      sendError(res, 500, "Internal server error");
    }
  });
});

// Fail loudly and clearly if the port is taken (instead of a raw stack trace).
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`✗ Port ${PORT} is already in use — the dashboard is probably already running.`);
    console.error(`  Open http://${HOST}:${PORT}, or set DS_DASHBOARD_PORT to a free port.`);
    process.exit(1);
  }
  console.error("✗ Server error:", err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`▸ Agent Solomon - 007 on http://${HOST}:${PORT}`);
  console.log(`▸ Builds root:        ${BUILDS_ROOT}`);
  console.log(`▸ Plans root:         ${PLANS_ROOT}`);
  console.log(`▸ ANTHROPIC_API_KEY:  ${process.env.ANTHROPIC_API_KEY ? "set" : "not set"}`);
});

export { server };
