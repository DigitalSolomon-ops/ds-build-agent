/**
 * Child-process trees the harness started, so shutdown and airspace loss can
 * kill them — and confirm they are gone — before a claim is released. A released
 * claim with a still-running grandchild is exactly the overlap airspace forbids.
 *
 *   - POSIX: children are spawned `detached` (their own process group) and killed
 *     as a group: process.kill(-pid).
 *   - Windows: `taskkill /T /F /PID` walks the tree from the child.
 *
 * The Agent SDK's own `claude` subprocess is stopped through its AbortController;
 * processes it spawned through Bash are outside this registry (documented in
 * docs/AIRSPACE.md).
 */
import { execFileSync, type ChildProcess } from "node:child_process";

const tracked = new Map<number, ChildProcess>();

/** Register a child the harness started. Untracked automatically when it exits. */
export function trackChild(child: ChildProcess): void {
  if (!child.pid) return;
  const pid = child.pid;
  tracked.set(pid, child);
  child.once("exit", () => tracked.delete(pid));
}

/** PIDs still tracked (alive or not yet reaped). */
export function trackedPids(): number[] {
  return [...tracked.keys()];
}

/** Is `pid` still a live process? */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Kill one process and everything under it. Never throws. */
export function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", timeout: 15_000 });
    } else {
      try {
        process.kill(-pid, "SIGKILL"); // detached: the child leads its own group
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    /* already gone */
  }
}

/**
 * Kill every tracked tree plus `extra` pids, then wait until none of them (and
 * none of `watch`, e.g. known grandchildren) is alive. Resolves true when all are
 * confirmed gone within `timeoutMs`.
 */
export async function killAllTrees(opts: { extra?: number[]; watch?: number[]; timeoutMs?: number } = {}): Promise<boolean> {
  const roots = [...new Set([...trackedPids(), ...(opts.extra ?? [])])];
  for (const pid of roots) killTree(pid);
  const all = [...new Set([...roots, ...(opts.watch ?? [])])];
  const until = Date.now() + (opts.timeoutMs ?? 10_000);
  while (Date.now() < until) {
    if (all.every((p) => !isAlive(p))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return all.every((p) => !isAlive(p));
}
