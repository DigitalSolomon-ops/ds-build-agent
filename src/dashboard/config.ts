/**
 * Dashboard configuration. All values are local-only and overridable via env.
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// This file compiles to dist/dashboard/config.js, so the repo root is two up.
const here = dirname(fileURLToPath(import.meta.url));
export const HARNESS_ROOT = resolve(here, "..", "..");

/** The compiled harness entrypoint the run manager spawns. */
export const HARNESS_ENTRY = join(HARNESS_ROOT, "dist", "index.js");

/** Static client assets (plain HTML/CSS/JS, not compiled). */
export const PUBLIC_DIR = join(HARNESS_ROOT, "dashboard", "public");

/**
 * Where builds live — OUTSIDE the harness repo, so commit_after_each_task
 * creates standalone per-build git repos and never commits into this repo.
 * See the "builds-outside-harness-repo" decision.
 */
export const BUILDS_ROOT = process.env.DS_BUILDS_ROOT
  ? resolve(process.env.DS_BUILDS_ROOT)
  : resolve(HARNESS_ROOT, "..", "ds-builds");

/** Loopback only. Never bind 0.0.0.0 or a LAN address — this can spawn processes. */
export const HOST = "127.0.0.1";
export const PORT = Number(process.env.DS_DASHBOARD_PORT ?? "4317");

/** Concurrency bounds accepted from the UI. */
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 16;

/** The harness's own build-folder name sanitizer (must match index.ts). */
export function safePlanName(name: string): string {
  return name.replace(/[^\w.-]+/g, "-");
}
