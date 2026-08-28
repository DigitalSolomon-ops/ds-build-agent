/**
 * STATUS.md — a durable, human-readable RESUME artifact for a build (harness P9).
 *
 * PURE (no I/O), structurally like renderDashboard: derives shape from the PLAN,
 * overlays live state from the run-state snapshot, two modes (plan-only / live).
 * But it emits Markdown shaped for RESUME rather than monitoring: where to pick
 * up, what a human still owns, what failed, and the launch-gate state. The
 * state-writer rides its existing per-event snapshot() to (re)write this, so
 * "after a task completes, STATUS reflects it" needs no orchestrator change.
 *
 * Two invariants matter here:
 *   - TIMESTAMP comes from runState.run.updatedAt, NEVER Date.now(), so
 *     re-rendering the same snapshot is byte-identical (idempotent regen; clean
 *     diffs if the file is ever committed).
 *   - ASCII-ONLY output. The operator's PowerShell 5.1 mojibakes non-ASCII in a
 *     BOM-less context, so use "->", "|", "#" — never unicode arrows/box chars.
 *     Interpolated plan/agent text is passed through asciiSafe() defensively.
 */
import type { BuildPlan } from "./types.js";
import type { DashboardRunState } from "./dashboard.js";

/** A task counts as RESOLVED when built OR deferred — the orchestrator's rule, so
 *  a human/ghl deferral correctly unblocks its dependents in "what's next". */
const RESOLVED = new Set(["built", "deferred"]);

/** Replace any non-ASCII with '?' so the file is safe in a PS 5.1 pipeline. */
function asciiSafe(s: unknown): string {
  return String(s ?? "").replace(/[^\x00-\x7F]/g, "?");
}
/** Collapse whitespace and cap length for one-line summaries/errors. */
function oneLine(s: unknown, cap = 200): string {
  const t = asciiSafe(s).replace(/\s+/g, " ").trim();
  return t.length > cap ? t.slice(0, cap - 1) + "…".replace("…", "...") : t;
}

export function renderStatus(plan: BuildPlan, runState?: DashboardRunState): string {
  const live = runState !== undefined;
  const stateById = new Map<string, string>();
  const viewById = new Map<string, { state?: string; error?: string; summary?: string; doc?: string }>();
  for (const t of runState?.tasks ?? []) {
    if (t.state) stateById.set(t.id, t.state);
    viewById.set(t.id, t);
  }

  const gatePhase = plan.policy.gatePhase;
  const gatedPhase = plan.policy.gatedPhase;
  const gated = gatePhase !== undefined && gatedPhase !== undefined;
  const gateOpen = runState?.gate?.open;

  const isResolved = (id: string) => RESOLVED.has(stateById.get(id) ?? "");
  const isPending = (id: string) => {
    if (!live) return true; // plan-only: everything is yet to run
    const s = stateById.get(id);
    return s === undefined || s === "pending";
  };
  // Held by a CLOSED gate: a gated-phase task is not actionable until the gate opens.
  const heldByGate = (phase?: string) =>
    gated && (phase ?? "").startsWith(gatedPhase!) && gateOpen === false;

  const actionable = plan.tasks.filter(
    (t) => isPending(t.id) && (t.deps ?? []).every((d) => isResolved(d)) && !heldByGate(t.phase),
  );

  const L: string[] = [];
  L.push(`# ${asciiSafe(plan.name)} - build status`);
  L.push("");
  if (live && runState?.run?.updatedAt) {
    const when = new Date(runState.run.updatedAt).toISOString();
    L.push(`_Updated ${when} - run status: ${asciiSafe(runState.run.status ?? "running")}_`);
    L.push("");
  }

  if (live && runState?.totals) {
    const total = runState.totals.total ?? plan.tasks.length;
    const done = (runState.totals.built ?? 0) + (runState.totals.deferred ?? 0);
    const pct = total ? Math.round((done / total) * 100) : 0;
    L.push(`**Progress:** ${done} / ${total} resolved (${pct}%)`);
    L.push("");
  }

  // ---- Resume here ----
  L.push("## Resume");
  L.push("");
  if (live && runState?.run?.status === "complete") {
    L.push("Run complete - nothing actionable remains.");
  } else if (actionable.length === 0) {
    const anyPending = plan.tasks.some((t) => isPending(t.id));
    L.push(
      anyPending
        ? "No task is currently actionable - remaining work is blocked by unmet deps or a held gate."
        : "Nothing actionable remains.",
    );
  } else {
    L.push("Start here (deps resolved, not gated):");
    L.push("");
    for (const t of actionable) {
      L.push(`- **${asciiSafe(t.id)}** (${asciiSafe(t.phase ?? "-")}, ${t.executor}) - ${asciiSafe(t.title)}`);
    }
  }
  L.push("");

  // ---- Last completed (live) ----
  if (live) {
    const built = (runState?.tasks ?? []).filter((t) => t.state === "built");
    const last = built[built.length - 1];
    if (last) {
      L.push("## Last completed");
      L.push("");
      L.push(`**${asciiSafe(last.id)}**${last.summary ? " - " + oneLine(last.summary) : ""}`);
      L.push("");
    }
  }

  // ---- Failed (live) ----
  if (live) {
    const failed = plan.tasks.filter((t) => stateById.get(t.id) === "failed");
    if (failed.length) {
      L.push("## Failed");
      L.push("");
      for (const t of failed) {
        L.push(`- **${asciiSafe(t.id)}** - ${oneLine(viewById.get(t.id)?.error ?? "error")}`);
      }
      L.push("");
    }
  }

  // ---- Human gates ----
  const gates = plan.tasks.filter((t) => t.executor !== "agent");
  if (gates.length) {
    L.push("## Human gates");
    L.push("");
    for (const t of gates) {
      const v = viewById.get(t.id);
      const st = stateById.get(t.id) ?? "pending";
      const doc = v?.doc ? ` -> recorded to ${asciiSafe(v.doc)}` : "";
      L.push(`- **${asciiSafe(t.id)}** (${t.executor}, ${st})${doc} - ${asciiSafe(t.title)}`);
    }
    L.push("");
  }

  // ---- Launch gate ----
  if (gated) {
    L.push("## Launch gate");
    L.push("");
    const g = runState?.gate;
    if (live && g) {
      const held = g.open === false;
      L.push(
        `Phase ${gatePhase} -> ${gatedPhase} gate: ${held ? "HELD" : "open"}` +
          `${g.heldByHumanSignoff ? " (awaiting human sign-off)" : ""}.`,
      );
      if (g.blockingAgentTasks && g.blockingAgentTasks.length) {
        L.push(`Blocking agent tasks: ${g.blockingAgentTasks.map(asciiSafe).join(", ")}.`);
      }
    } else {
      L.push(`Phase ${gatedPhase} tasks are held until every phase ${gatePhase} agent task passes.`);
    }
    L.push("");
  }

  // ---- Per-phase table ----
  const phases = [...new Set(plan.tasks.map((t) => t.phase ?? "(none)"))];
  L.push("## Phases");
  L.push("");
  L.push("| Phase | Tasks | Resolved |");
  L.push("|---|---|---|");
  for (const p of phases) {
    const inP = plan.tasks.filter((t) => (t.phase ?? "(none)") === p);
    const res = inP.filter((t) => isResolved(t.id)).length;
    L.push(`| ${asciiSafe(p)} | ${inP.length} | ${res} |`);
  }
  L.push("");

  return L.join("\n");
}
