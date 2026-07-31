/**
 * Tiny HTTP helpers — JSON responses and safe static file serving.
 * No framework; this is a local, single-user tool.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serve a file from `rootDir`, resolving `urlPath` safely. Any attempt to
 * escape the root (via `..`, absolute paths, etc.) yields a 403/404 rather
 * than reading outside the static directory.
 */
export function serveStatic(res: ServerResponse, rootDir: string, urlPath: string): void {
  const rel = decodeURIComponent(urlPath.split("?")[0]);
  const requested = rel === "/" || rel === "" ? "/index.html" : rel;
  // normalize collapses ".."; then confirm the result is still inside rootDir.
  const abs = resolve(rootDir, "." + normalize(requested));
  const rootWithSep = rootDir.endsWith(sep) ? rootDir : rootDir + sep;
  if (abs !== rootDir && !abs.startsWith(rootWithSep)) {
    sendError(res, 403, "Forbidden");
    return;
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    sendError(res, 404, "Not found");
    return;
  }
  const type = CONTENT_TYPES[extname(abs).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  createReadStream(abs).pipe(res);
}

/** Read a POST/PUT body up to a small cap and parse it as JSON. */
export function readJsonBody(
  req: IncomingMessage,
  limitBytes = 256 * 1024,
): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Guard: `child` must resolve to a path inside `parent`. Returns the abs path or null. */
export function containedPath(parent: string, child: string): string | null {
  const abs = resolve(parent, child);
  const parentWithSep = parent.endsWith(sep) ? parent : parent + sep;
  if (abs !== parent && !abs.startsWith(parentWithSep)) return null;
  return abs;
}

export { join };
