/**
 * Build-path resolution (repo-bridge).
 *
 * By default the harness builds a fresh app under `<out>/<name>/` — the right
 * shape for a greenfield project. But many projects EXTEND an existing repo
 * (add a lane to an agent, a feature to an app); dropping agents into an empty
 * folder there gives them nothing to extend. `--repo <path>` points the build at
 * an existing repo instead, so agents run with the real code in view.
 *
 * Pure so the mapping is unit-tested without a run. The caller (index.ts) keeps
 * harness telemetry (state / dashboard / STATUS) OUTSIDE the target repo so an
 * in-place build never commits the harness's own bookkeeping.
 */

import { resolve, join } from "node:path";

/**
 * Where the build runs.
 *  - `repo` set  → that existing repo, verbatim (in-place; caller verifies it exists).
 *  - otherwise   → `<outResolved>/<safeName>/` (the greenfield default).
 */
export function resolveBuildPath(
  repo: string | undefined,
  outResolved: string,
  safeName: string,
): string {
  return repo ? resolve(repo) : join(outResolved, safeName);
}
