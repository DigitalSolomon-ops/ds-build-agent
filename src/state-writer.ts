/**
 * Opt-in run-state emitter for the dashboard.
 *
 * This module is ADDITIVE and side-effect-free unless index.ts explicitly
 * constructs it (behind the `--state` flag). It consumes the orchestrator's
 * existing `OrchestratorEvent` stream — the orchestrator itself is never
 * modified — and maintains two files the dashboard reads:
 *
 *   run-state.json   a full snapshot rewritten atomically on every event
 *   events.ndjson    an append-only log, one JSON object per event
 *
 * State is written to a directory OUTSIDE the build repo (default
 * `<out>/.ds-runs/<plan-name>/`) so `commit_after_each_task`'s `git add -A`
 * — which runs with cwd inside `builds/<plan-name>/` — never captures it.
 */
import { mkdirSync, writeFileSync, appendFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { BuildPlan, Task, TaskResult, VerifyRecord } from "./types.js";
import { isBuildExecutor } from "./types.js";
import type { OrchestratorEvent } from "./orchestrator.js";
import { renderDashboard, type DashboardRunState } from "./dashboard.js";
import { renderStatus } from "./status.js";

/** Dashboard-facing task status. Maps the harness's 4 result states plus the
 * two transient in-memory states (pending/running) the harness never records. */
export type TaskState =
  | "pending"
  | "running"
  | "built"
  | "deferred"
  | "skipped"
  | "failed";

/** Map a terminal TaskResult.status to the dashboard vocabulary. */
function fromResult(status: TaskResult["status"]): TaskState {
  return status === "success" ? "built" : status; // deferred | skipped | failed pass through
}

const TERMINAL: ReadonlySet<TaskState> = new Set(["built", "deferred", "skipped", "failed"]);
const NO_PHASE = "(no phase)";

interface TaskView {
  id: string;
  title: string;
  phase: string;
  executor: Task["executor"];
  auto: boolean;
  deps: string[];
  outputs: string[];
  state: TaskState;
  error?: string;
  summary?: string;
  durationMs?: number;
  /** Handoff doc a deferred task was recorded to (BLOCKERS.md / GHL-SETUP.md). */
  doc?: string;
  /** What this task cost. Absent = no agent ran, or the SDK reported nothing. */
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** Adversarial verify pass (P7), present only for a verified sensitive task. */
  verify?: VerifyRecord;
  turns?: number;
}

/** Sum a usage field across tasks, skipping absent values.
 *  Returns undefined when NOTHING reported — absent is not zero. */
function sumReported(views: TaskView[], pick: (v: TaskView) => number | undefined): number | undefined {
  const values = views.map(pick).filter((n): n is number => typeof n === "number");
  return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
}

export interface StateWriterInit {
  plan: BuildPlan;
  planPath: string;
  /** The build folder (`builds/<plan-name>/`). */
  repoPath: string;
  /** Directory the two state files are written into. */
  stateDir: string;
  concurrency: number;
  dryRun: boolean;
  /** Epoch ms the run started (so the CLI and state agree on start time). */
  startedAt: number;
  /**
   * When set, the self-contained HTML dashboard is (re)written to this path on
   * every snapshot — run start and after each task event — so the "autosave"
   * view stays current off the SAME event plumbing that writes run-state.json.
   * Absent = no dashboard is emitted (default; state-only behaviour unchanged).
   */
  dashboardPath?: string;
  /**
   * When set, the Markdown STATUS.md resume doc is (re)written here on every
   * snapshot — off the SAME event plumbing as run-state.json and the dashboard.
   * Defaults (in index.ts) to the STATE dir, never the build repo, so
   * commit_after_each_task never captures it. Absent = not emitted.
   */
  statusPath?: string;
}

/**
 * Create a state writer. Returns handlers the CLI attaches to its existing
 * event callback; nothing here changes what the orchestrator does.
 */
export function createStateWriter(init: StateWriterInit) {
  const { plan, planPath, repoPath, stateDir, concurrency, dryRun, startedAt, dashboardPath, statusPath } = init;
  const runStatePath = join(stateDir, "run-state.json");
  const eventsPath = join(stateDir, "events.ndjson");

  mkdirSync(stateDir, { recursive: true });

  // --- task model, seeded pending from the (possibly --only-pruned) plan ---
  const tasks = new Map<string, TaskView>();
  for (const t of plan.tasks) {
    tasks.set(t.id, {
      id: t.id,
      title: t.title,
      phase: t.phase ?? NO_PHASE,
      executor: t.executor,
      auto: t.auto,
      deps: t.deps ?? [],
      outputs: t.outputs ?? [],
      state: "pending",
    });
  }

  // Phase order = first appearance in the plan's task list.
  const phaseOrder: string[] = [];
  for (const t of plan.tasks) {
    const p = t.phase ?? NO_PHASE;
    if (!phaseOrder.includes(p)) phaseOrder.push(p);
  }

  // --- launch-gate model, mirroring orchestrator.ts exactly ---
  const { gatePhase, gatedPhase } = plan.policy;
  const gateEnabled = gatePhase !== undefined;
  const gateAgentIds = plan.tasks
    .filter((t) => gatePhase && t.phase?.startsWith(gatePhase) && isBuildExecutor(t.executor))
    .map((t) => t.id);
  const gateHumanIds = plan.tasks
    .filter((t) => gatePhase && t.phase?.startsWith(gatePhase) && !isBuildExecutor(t.executor))
    .map((t) => t.id);

  const runningIds = new Set<string>();
  let activePhase: string | null = null;
  let seq = 0;

  // Fresh files for a fresh run.
  writeFileSync(eventsPath, "");
  appendEvent({ type: "run-start", planName: plan.name, dryRun });
  snapshot("running");

  function appendEvent(fields: Record<string, unknown>): void {
    const line = JSON.stringify({ seq: seq++, ts: Date.now(), ...fields });
    appendFileSync(eventsPath, line + "\n");
  }

  function writeAtomic(file: string, data: string): void {
    const tmp = file + ".tmp";
    writeFileSync(tmp, data);
    try {
      renameSync(tmp, file); // overwrites on Windows (MoveFileEx replace-existing)
    } catch {
      writeFileSync(file, data);
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort */
      }
    }
  }

  function gateView() {
    if (!gateEnabled) return { enabled: false };
    const built = (id: string) => tasks.get(id)?.state === "built";
    const blockingAgentTasks = gateAgentIds.filter((id) => !built(id));
    const heldByHumanSignoff = gateHumanIds.length > 0;
    const open = blockingAgentTasks.length === 0 && !heldByHumanSignoff;
    // Autonomously the gate can never open while a human sign-off sits in the
    // gate phase, or once a gate agent task has failed/skipped.
    const gateFailed = gateAgentIds.some((id) => {
      const s = tasks.get(id)?.state;
      return s === "failed" || s === "skipped";
    });
    return {
      enabled: true,
      gatePhase,
      gatedPhase,
      open,
      blockingAgentTasks,
      heldByHumanSignoff,
      permanentlyClosed: !open && (heldByHumanSignoff || gateFailed),
      humanGateTasks: gateHumanIds,
    };
  }

  function snapshot(runStatus: "running" | "complete"): void {
    const all = [...tasks.values()];
    const count = (s: TaskState) => all.filter((t) => t.state === s).length;
    const totals = {
      total: all.length,
      built: count("built"),
      deferred: count("deferred"),
      skipped: count("skipped"),
      failed: count("failed"),
      pending: count("pending"),
      running: count("running"),
    };
    const terminal = all.filter((t) => TERMINAL.has(t.state)).length;
    // Cost so far. Omitted entirely when no task has reported — the dashboard
    // must be able to tell "nothing spent yet" from "we are not measuring".
    const spendSoFar = sumReported(all, (t) => t.costUsd);
    const spend = spendSoFar === undefined ? undefined : {
      costUsd: Math.round(spendSoFar * 1e4) / 1e4,
      tokensIn: sumReported(all, (t) => t.tokensIn) ?? 0,
      tokensOut: sumReported(all, (t) => t.tokensOut) ?? 0,
      tasksReportingUsage: all.filter((t) => typeof t.costUsd === "number").length,
    };

    const phases = phaseOrder.map((phase) => {
      const inPhase = all.filter((t) => t.phase === phase);
      const c = (s: TaskState) => inPhase.filter((t) => t.state === s).length;
      const done = inPhase.filter((t) => TERMINAL.has(t.state)).length;
      return {
        phase,
        total: inPhase.length,
        byState: {
          pending: c("pending"),
          running: c("running"),
          built: c("built"),
          deferred: c("deferred"),
          skipped: c("skipped"),
          failed: c("failed"),
        },
        percentComplete: inPhase.length ? Math.round((done / inPhase.length) * 100) : 0,
      };
    });

    const state = {
      version: 1,
      run: {
        planName: plan.name,
        planPath,
        repoPath,
        stateDir,
        concurrency,
        dryRun,
        startedAt,
        updatedAt: Date.now(),
        status: runStatus,
      },
      policy: {
        commitAfterEachTask: plan.policy.commitAfterEachTask,
        gatePhase: plan.policy.gatePhase,
        gatedPhase: plan.policy.gatedPhase,
      },
      concurrency: {
        limit: concurrency,
        inUse: runningIds.size,
        runningTaskIds: [...runningIds],
      },
      activePhase,
      gate: gateView(),
      totals,
      spend,
      progress: { percentComplete: all.length ? Math.round((terminal / all.length) * 100) : 0 },
      phases,
      tasks: all,
    };
    writeAtomic(runStatePath, JSON.stringify(state, null, 2));
    // Autosave the dashboard off the SAME snapshot — one source of truth. The
    // state object is structurally the DashboardRunState the renderer reads.
    if (dashboardPath) {
      writeAtomic(dashboardPath, renderDashboard(plan, state as DashboardRunState));
    }
    // ...and the Markdown resume doc off the very same snapshot.
    if (statusPath) {
      writeAtomic(statusPath, renderStatus(plan, state as DashboardRunState));
    }
  }

  /** Attach to the CLI's onEvent: update the model, append, re-snapshot. */
  function handleEvent(e: OrchestratorEvent): void {
    const view = tasks.get(e.task.id);
    switch (e.type) {
      case "task-start":
        if (view) view.state = "running";
        runningIds.add(e.task.id);
        activePhase = e.task.phase ?? NO_PHASE;
        appendEvent({ type: e.type, taskId: e.task.id, phase: view?.phase, title: e.task.title });
        break;
      case "task-log":
        appendEvent({ type: e.type, taskId: e.task.id, text: e.text });
        return; // logs don't change task state — append only, no re-snapshot
      case "task-done":
        runningIds.delete(e.task.id);
        if (view) {
          view.state = fromResult(e.result.status);
          view.durationMs = e.result.durationMs;
          if (e.result.error) view.error = e.result.error;
          if (e.result.summary) view.summary = e.result.summary;
          if (e.result.usage) {
            view.costUsd = e.result.usage.costUsd;
            view.tokensIn = e.result.usage.inputTokens;
            view.tokensOut = e.result.usage.outputTokens;
            view.turns = e.result.usage.turns;
          }
          if (e.result.verify) {
            view.verify = e.result.verify;
            // The verify pass has its OWN bill; fold it into this task's cost so
            // the per-task view and the spend rollup match what actually billed.
            if (e.result.verify.usage) view.costUsd = (view.costUsd ?? 0) + e.result.verify.usage.costUsd;
          }
        }
        appendEvent({
          type: e.type,
          taskId: e.task.id,
          state: view?.state,
          durationMs: e.result.durationMs,
          error: e.result.error,
          summary: e.result.summary,
          costUsd: e.result.usage?.costUsd,
          tokensIn: e.result.usage?.inputTokens,
          tokensOut: e.result.usage?.outputTokens,
          turns: e.result.usage?.turns,
          verifyPassed: e.result.verify?.passed,
        });
        break;
      case "task-verify":
        // Append-only durable record of the verify pass; the record itself rides
        // task-done onto the view (above), so no state mutation / re-snapshot here.
        appendEvent({
          type: e.type,
          taskId: e.task.id,
          passed: e.verify.passed,
          verdict: e.verify.verdict,
          findings: e.verify.findings,
          triggeredBy: e.verify.triggeredBy,
          model: e.verify.model,
          costUsd: e.verify.usage?.costUsd,
        });
        return;
      case "task-deferred":
        if (view) {
          view.state = "deferred";
          view.doc = e.doc;
        }
        appendEvent({ type: e.type, taskId: e.task.id, executor: e.task.executor, doc: e.doc });
        break;
      case "task-skipped":
        if (view) {
          view.state = "skipped";
          view.error = e.reason;
        }
        appendEvent({ type: e.type, taskId: e.task.id, reason: e.reason });
        break;
    }
    snapshot("running");
  }

  /** Reconcile against the authoritative results array and mark the run done. */
  function finalize(results: TaskResult[]): void {
    for (const r of results) {
      const view = tasks.get(r.taskId);
      if (!view) continue;
      view.state = fromResult(r.status);
      view.durationMs = r.durationMs;
      if (r.error) view.error = r.error;
      if (r.summary) view.summary = r.summary;
      if (r.usage) {
        view.costUsd = r.usage.costUsd;
        view.tokensIn = r.usage.inputTokens;
        view.tokensOut = r.usage.outputTokens;
        view.turns = r.usage.turns;
      }
    }
    runningIds.clear();
    activePhase = null;
    const count = (s: TaskResult["status"]) => results.filter((r) => r.status === s).length;
    const reported = results.filter((r) => r.usage);
    appendEvent({
      type: "run-end",
      totals: {
        built: count("success"),
        deferred: count("deferred"),
        skipped: count("skipped"),
        failed: count("failed"),
      },
      // Absent when nothing reported — see sumReported().
      spend: reported.length
        ? {
            costUsd:
              Math.round(
                reported.reduce((s, r) => s + r.usage!.costUsd + (r.verify?.usage?.costUsd ?? 0), 0) * 1e4,
              ) / 1e4,
            tokensIn: reported.reduce((s, r) => s + r.usage!.inputTokens, 0),
            tokensOut: reported.reduce((s, r) => s + r.usage!.outputTokens, 0),
            tasksReportingUsage: reported.length,
          }
        : undefined,
    });
    snapshot("complete");
  }

  return { handleEvent, finalize, paths: { runStatePath, eventsPath, dashboardPath, statusPath } };
}
