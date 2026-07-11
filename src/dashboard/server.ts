/**
 * ds-build-agent dashboard — local, read-and-run web UI for the harness.
 *
 * Bound to 127.0.0.1 only. It can spawn the harness (a real, paid operation),
 * so every input is validated and nothing is ever passed through a shell.
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { loadPlan, PlanError } from "../parser.js";
import type { BuildPlan } from "../types.js";
import { analyzePlan } from "./plan-analysis.js";
import { HOST, PORT, PUBLIC_DIR, BUILDS_ROOT, MIN_CONCURRENCY, MAX_CONCURRENCY } from "./config.js";
import { sendJson, sendError, serveStatic, readJsonBody } from "./http.js";
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

  if (pathname === "/api/runs" && method === "GET") {
    return sendJson(res, 200, { runs: listRuns() });
  }

  if (pathname === "/api/runs" && method === "POST") {
    const body = await readJsonBody(req);
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

  // ---- Static client ----
  if (method === "GET") {
    return serveStatic(res, PUBLIC_DIR, pathname);
  }

  sendError(res, 405, "Method not allowed");
}

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

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`▸ ds-build dashboard on http://${HOST}:${PORT}`);
  console.log(`▸ Builds root:        ${BUILDS_ROOT}`);
  console.log(`▸ ANTHROPIC_API_KEY:  ${process.env.ANTHROPIC_API_KEY ? "set" : "not set"}`);
});

export { server };
