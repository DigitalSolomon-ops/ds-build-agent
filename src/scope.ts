/**
 * Task write-boundary enforcement (whetstone W3).
 *
 * A task may declare `scope: [globs]` — the only files it is permitted to write.
 * After a successful agent task, the orchestrator gates the result through
 * `gateScopeResult`: if the task wrote any file outside its scope, the result is
 * downgraded to "failed" BEFORE it commits or unblocks dependents. This keeps a
 * task that was briefed to touch one module from wandering into, say, a live
 * broker or a credentials file.
 *
 * Pure and side-effect-free by design (like verify.ts's pure core), so the
 * matching logic is unit-tested without spawning an agent. The orchestrator
 * supplies the observed writes (from the agent's Write/Edit tool calls).
 *
 * Known gap: writes made only through a Bash shell (`echo > f`, `cp`, `sed -i`)
 * are not observed here, so scope covers the Write/Edit path, not arbitrary
 * shell writes. Documented on Task.scope in types.ts.
 */

import type { Task, TaskResult } from "./types.js";

/** Forward slashes; drop a leading `./` or `/` so paths compare uniformly. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Compile one glob to an anchored RegExp.
 *  - `*`  matches within a single path segment (no `/`)
 *  - `**` matches across segments (including `/`), and swallows an immediately
 *         following `/` so `src/**` matches `src/a` and `a/**​/c` matches `a/c`
 *  - a trailing `/` means "this directory and everything under it"
 *  - every other character is matched literally
 */
export function globToRegExp(glob: string): RegExp {
  let g = normalizePath(glob);
  if (g.endsWith("/")) g += "**"; // a bare directory = all descendants
  const special = /[.+^${}()|[\]\\]/g;
  let out = "";
  for (let i = 0; i < g.length; i++) {
    if (g[i] === "*" && g[i + 1] === "*") {
      out += ".*";
      i++; // consume the second star
      if (g[i + 1] === "/") i++; // and an optional following slash
    } else if (g[i] === "*") {
      out += "[^/]*";
    } else {
      out += g[i].replace(special, "\\$&");
    }
  }
  return new RegExp("^" + out + "$");
}

/** True if `file` matches at least one of the scope globs. */
export function inScope(file: string, scope: string[]): boolean {
  const f = normalizePath(file);
  return scope.some((pat) => globToRegExp(pat).test(f));
}

/** The subset of `files` that fall OUTSIDE `scope`. Empty scope constrains nothing. */
export function filesOutsideScope(files: string[], scope: string[]): string[] {
  if (!scope.length) return [];
  return files.filter((f) => !inScope(f, scope));
}

/**
 * Gate a task result against its declared scope. A no-op unless the task set
 * `scope` and succeeded — so an unscoped task, or a failed/deferred one, passes
 * through byte-for-byte. A scope violation becomes a "failed" result carrying
 * the offending paths, so the orchestrator neither commits it nor unblocks its
 * dependents (mirrors gateSensitiveResult in verify.ts).
 */
export function gateScopeResult(task: Task, result: TaskResult): TaskResult {
  if (!task.scope?.length || result.status !== "success") return result;
  const outside = filesOutsideScope(result.filesWritten ?? [], task.scope);
  if (outside.length === 0) return result;
  return {
    ...result,
    status: "failed",
    error:
      `Scope violation: task "${task.id}" wrote outside its declared scope — ` +
      `${outside.join(", ")}. Allowed: ${task.scope.join(", ")}.`,
  };
}
