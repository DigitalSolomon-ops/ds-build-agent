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
import { analyzePlan } from "./plan-analysis.js";
import { HOST, PORT, PUBLIC_DIR, BUILDS_ROOT } from "./config.js";
import { sendJson, sendError, serveStatic } from "./http.js";

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
