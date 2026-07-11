import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BuildPlan, Task, TaskResult } from "./types.js";
import { runTask } from "./agent.js";

const exec = promisify(execFile);

export interface OrchestratorOptions {
  /** Absolute path to the repo folder the agents will build in. */
  repoPath: string;
  /** Max agent tasks to run at once. Default 3. */
  concurrency?: number;
  /** Plan only — route and order tasks without calling any agent or writing files. */
  dryRun?: boolean;
  /** Called whenever a task changes state, for logging. */
  onEvent?: (event: OrchestratorEvent) => void;
}

export type OrchestratorEvent =
  | { type: "task-start"; task: Task }
  | { type: "task-log"; task: Task; text: string }
  | { type: "task-done"; task: Task; result: TaskResult }
  | { type: "task-deferred"; task: Task; doc: string }
  | { type: "task-skipped"; task: Task; reason: string };

/** Terminal states a dependency can be in. */
const isResolved = (r?: TaskResult) => r?.status === "success" || r?.status === "deferred";
const isTerminal = (r?: TaskResult) => r !== undefined;

/**
 * Execute a build plan.
 *
 * - `agent` tasks are built by one Claude agent each, in dependency order,
 *   with bounded concurrency; on success we optionally git-commit.
 * - `human` / `ghl` tasks are recorded to a handoff doc and marked `deferred`
 *   (they count as resolved so agent work can proceed against placeholders).
 * - The launch gate holds `gatedPhase` tasks until every agent task in
 *   `gatePhase` succeeds; if the gate can never open autonomously (a human
 *   sign-off task sits in the gate phase), gated tasks are skipped, not run.
 * - A dependency that fails causes its dependents to be skipped.
 */
export async function orchestrate(
  plan: BuildPlan,
  opts: OrchestratorOptions,
): Promise<TaskResult[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const results = new Map<string, TaskResult>();
  const remaining = new Set(plan.tasks.map((t) => t.id));
  const running = new Set<string>();

  const { gatePhase, gatedPhase } = plan.policy;
  const gateAgentTasks = plan.tasks.filter(
    (t) => gatePhase && t.phase?.startsWith(gatePhase) && t.executor === "agent",
  );
  const gateHumanTasks = plan.tasks.filter(
    (t) => gatePhase && t.phase?.startsWith(gatePhase) && t.executor !== "agent",
  );
  const isGated = (t: Task) => gatedPhase !== undefined && !!t.phase?.startsWith(gatedPhase);
  // Gate can only open autonomously if all gate agent tasks pass AND there is
  // no human/ghl sign-off task in the gate phase (that must be recorded by hand).
  const gateOpen = () =>
    gateAgentTasks.every((t) => results.get(t.id)?.status === "success") &&
    gateHumanTasks.length === 0;
  const gatePermanentlyClosed = () =>
    !gateOpen() &&
    [...gateAgentTasks, ...gateHumanTasks].every((t) => isTerminal(results.get(t.id)));

  const depsResolved = (t: Task) => (t.deps ?? []).every((d) => isResolved(results.get(d)));
  const failedDep = (t: Task) =>
    (t.deps ?? []).find((d) => {
      const r = results.get(d);
      return r && !isResolved(r);
    });

  const finish = (id: string, result: TaskResult) => {
    results.set(id, result);
    running.delete(id);
    remaining.delete(id);
  };

  return new Promise((resolve) => {
    const pump = () => {
      let progressed = true;
      // Loop so instant resolutions (skips, deferrals in dry-run) cascade.
      while (progressed) {
        progressed = false;

        for (const id of [...remaining]) {
          if (running.has(id)) continue;
          const task = byId.get(id)!;

          // 1) A failed/skipped dependency poisons this task.
          const bad = failedDep(task);
          if (bad) {
            const result: TaskResult = {
              taskId: id,
              status: "skipped",
              error: `Skipped: dependency "${bad}" did not resolve.`,
              durationMs: 0,
            };
            finish(id, result);
            opts.onEvent?.({ type: "task-skipped", task, reason: result.error! });
            progressed = true;
            continue;
          }

          // 2) Not ready until deps resolve.
          if (!depsResolved(task)) continue;

          // 3) Launch gate.
          if (isGated(task) && !gateOpen()) {
            if (gatePermanentlyClosed()) {
              const reason =
                `Skipped: launch gate closed — phase "${gatePhase}" not fully passed` +
                (gateHumanTasks.length ? ` (awaiting human compliance sign-off)` : ``) + `.`;
              const result: TaskResult = { taskId: id, status: "skipped", error: reason, durationMs: 0 };
              finish(id, result);
              opts.onEvent?.({ type: "task-skipped", task, reason });
              progressed = true;
            }
            continue; // otherwise hold until gate resolves
          }

          // 4) Non-agent tasks: record to a handoff doc and defer.
          if (task.executor !== "agent" || !task.auto) {
            const doc = task.executor === "ghl" ? "GHL-SETUP.md" : "BLOCKERS.md";
            if (!opts.dryRun) writeHandoff(opts.repoPath, doc, task);
            finish(id, {
              taskId: id,
              status: "deferred",
              summary: `Recorded to ${doc} (${task.executor}).`,
              durationMs: 0,
            });
            opts.onEvent?.({ type: "task-deferred", task, doc });
            progressed = true;
            continue;
          }

          // 5) Agent task: dispatch (respect concurrency).
          if (running.size >= concurrency) continue;
          running.add(id);
          remaining.delete(id);
          opts.onEvent?.({ type: "task-start", task });

          const run = opts.dryRun
            ? Promise.resolve<TaskResult>({
                taskId: id,
                status: "success",
                summary: "[dry-run] would build",
                durationMs: 0,
              })
            : runTask(task, plan, opts.repoPath, (text) =>
                opts.onEvent?.({ type: "task-log", task, text }),
              );

          run
            .then(async (result) => {
              if (!opts.dryRun && result.status === "success" && plan.policy.commitAfterEachTask) {
                await gitCommit(opts.repoPath, task).catch(() => {});
              }
              running.add(id); // keep counted until finish() removes it
              finish(id, result);
              opts.onEvent?.({ type: "task-done", task, result });
              pump();
            });
        }
      }

      if (running.size === 0 && remaining.size === 0) {
        resolve(plan.tasks.map((t) => results.get(t.id)!));
      }
    };

    pump();
  });
}

/** Append a task to a handoff doc (BLOCKERS.md / GHL-SETUP.md). */
function writeHandoff(repoPath: string, doc: string, task: Task): void {
  const lines = [
    `\n## ${task.id} — ${task.title}`,
    `**Executor:** ${task.executor}${task.phase ? `  |  **Phase:** ${task.phase}` : ""}`,
    ``,
    task.brief,
  ];
  if (task.outputs?.length) lines.push(``, `_Outputs:_ ${task.outputs.join(", ")}`);
  if (task.acceptance?.length) lines.push(``, `_Done when:_ ${task.acceptance.join("; ")}`);
  appendFileSync(join(repoPath, doc), lines.join("\n") + "\n");
}

/** git add -A && commit after a successful agent task (best-effort). */
async function gitCommit(repoPath: string, task: Task): Promise<void> {
  const git = (args: string[]) => exec("git", args, { cwd: repoPath });
  // Ensure a repo + identity exist; ignore "already exists".
  await git(["rev-parse", "--git-dir"]).catch(async () => {
    await git(["init"]);
    await git(["config", "user.email", "harness@digitalsolomon.local"]);
    await git(["config", "user.name", "ds-build-agent"]);
  });
  await git(["add", "-A"]);
  // Nothing to commit is fine.
  await git(["commit", "-m", `${task.id}: ${task.title}`]).catch(() => {});
}
