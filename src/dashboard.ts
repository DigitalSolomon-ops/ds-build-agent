/**
 * Self-contained LOCAL status dashboard for a build plan.
 *
 * `renderDashboard(plan, runState?)` returns one HTML string that opens straight
 * from `file://` — no server, no external assets, all CSS/JS inlined. It is the
 * TypeScript port of the proven `gen-viz.mjs` design: summary tiles, a prominent
 * HUMAN GATES section (every non-agent task, its brief rendered as the
 * instruction), a phase rail carrying the 6→7 launch-gate marker, and a per-task
 * list with click-to-trace dependency highlighting.
 *
 * Two modes, same renderer:
 *   - PLAN-ONLY  (no runState): a static preview of the plan the harness parsed.
 *   - LIVE       (runState from the state-writer's snapshot): every task carries
 *     its live status (pending/running/built/deferred/skipped/failed) and the
 *     tiles show live counts. While the run is `running` the page adds a
 *     `<meta http-equiv="refresh">` so an open tab re-reads the file the
 *     state-writer keeps rewriting at each milestone — the "autosave".
 *
 * Structure derives from the PLAN (phases, deps, briefs, acceptance, gates);
 * only live status is overlaid from runState. This keeps the plan-only view
 * complete and the two sources of truth cleanly separated.
 */
import type { BuildPlan } from "./types.js";
import type { TaskState } from "./state-writer.js"; // type-only: erased, no runtime cycle

/**
 * The subset of the state-writer's `run-state.json` snapshot the dashboard reads.
 * Every field is optional so a caller (or a test) can pass a minimal object; the
 * full snapshot the state-writer builds is structurally assignable to this.
 */
export interface DashboardRunState {
  run?: { status?: string; startedAt?: number; updatedAt?: number; dryRun?: boolean };
  totals?: Partial<Record<TaskState | "total", number>>;
  spend?: { costUsd?: number; tokensIn?: number; tokensOut?: number };
  gate?: {
    enabled?: boolean;
    open?: boolean;
    permanentlyClosed?: boolean;
    heldByHumanSignoff?: boolean;
    blockingAgentTasks?: string[];
  };
  tasks?: Array<{
    id: string;
    state?: TaskState;
    error?: string;
    durationMs?: number;
    costUsd?: number;
    doc?: string;
  }>;
}

const STATUS_LABEL: Record<TaskState, string> = {
  pending: "pending",
  running: "running",
  built: "built",
  deferred: "deferred",
  skipped: "skipped",
  failed: "failed",
};

/** HTML-escape text destined for element content or attributes. */
function esc(s: string | undefined): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Collapse runs of whitespace to single spaces. */
function flat(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Numeric-prefix sort ("6-qa" -> 6), falling back to end-of-list. */
function phaseRank(p: string): number {
  const n = parseInt(p, 10);
  return Number.isFinite(n) ? n : 99;
}

/**
 * Render the full dashboard HTML for a plan, optionally overlaid with live run
 * state. Pure: no I/O, deterministic apart from the generated-at timestamp.
 */
export function renderDashboard(plan: BuildPlan, runState?: DashboardRunState): string {
  const gatePhase = plan.policy.gatePhase;
  const gatedPhase = plan.policy.gatedPhase;
  const gated = gatePhase !== undefined && gatedPhase !== undefined;

  // Live status overlay (empty in plan-only mode).
  const hasRun = runState !== undefined;
  const statusById = new Map<string, TaskState>();
  for (const t of runState?.tasks ?? []) if (t.state) statusById.set(t.id, t.state);

  // dep -> [dependents]
  const dependents = new Map<string, string[]>();
  for (const t of plan.tasks) {
    for (const d of t.deps ?? []) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d)!.push(t.id);
    }
  }

  const tasks = plan.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    phase: t.phase ?? "(none)",
    executor: t.executor,
    model: t.model ?? plan.model ?? "sonnet(default)",
    deps: t.deps ?? [],
    unblocks: dependents.get(t.id) ?? [],
    brief: flat(t.brief),
    acceptance: flat((t.acceptance ?? []).join(" ")),
    state: statusById.get(t.id),
  }));
  type TV = (typeof tasks)[number];

  const humanGates = tasks.filter((t) => t.executor !== "agent");
  const phases = [...new Set(tasks.map((t) => t.phase))].sort((a, b) => phaseRank(a) - phaseRank(b));

  const total = tasks.length;
  const agentCount = tasks.filter((t) => t.executor === "agent").length;
  const maxRunUsd = plan.policy.maxRunUsd ?? null;
  const commitEach = plan.policy.commitAfterEachTask;
  const liveCount = (s: TaskState) => tasks.filter((t) => t.state === s).length;
  const runStatus = runState?.run?.status ?? (hasRun ? "running" : "plan");
  const running = hasRun && runStatus === "running";
  const terminal = liveCount("built") + liveCount("deferred") + liveCount("skipped") + liveCount("failed");
  const percent = total ? Math.round((terminal / total) * 100) : 0;

  // ── fragment builders ──
  const statusBadge = (st?: TaskState) =>
    st ? `<span class="sbadge s-${st}">${STATUS_LABEL[st]}</span>` : "";

  // `v`/`sub` are trusted, pre-formatted HTML (entities like &#8594; and any
  // dynamic value the caller already escaped); only the literal key is escaped.
  const tile = (k: string, v: string, sub = "") =>
    `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${v}${
      sub ? ` <small>${sub}</small>` : ""
    }</div></div>`;

  const planTiles = [
    tile("Tasks", String(total)),
    tile("Agent-built", String(agentCount), "auto"),
    tile("Human gates", String(humanGates.length), "you"),
    tile("Launch gate", gated ? `P${gatePhase}&#8594;P${gatedPhase}` : "none"),
    tile("Max run", maxRunUsd != null ? `$${maxRunUsd}` : "&#8212;", "cap"),
    tile("Commit/task", commitEach ? "on" : "off"),
  ].join("");

  const liveTiles = hasRun
    ? `<div class="tiles live">${[
        tile("Status", esc(runStatus), running ? "live" : ""),
        tile("Built", String(liveCount("built"))),
        tile("Running", String(liveCount("running"))),
        tile("Pending", String(liveCount("pending"))),
        tile("Deferred", String(liveCount("deferred")), "gate"),
        tile("Skipped", String(liveCount("skipped"))),
        tile("Failed", String(liveCount("failed"))),
        tile("Progress", `${percent}%`),
      ].join("")}</div>`
    : "";

  const gateHtml = humanGates
    .map((g, i) => {
      const waits = g.deps.length
        ? `<span class="chip wait">waits on ${g.deps.length}</span>`
        : "";
      const unbl = g.unblocks.length
        ? `<span class="chip unblock">unblocks ${g.unblocks.length}</span>`
        : `<span class="chip unblock">final step</span>`;
      return (
        `<div class="gate"><div class="num">${i + 1}</div><div>` +
        `<div class="g-title">${esc(g.title)}</div>` +
        `<div class="g-meta"><span class="chip phase">${esc(g.phase)}</span>` +
        `<span class="badge b-human">${esc(g.executor)}</span>` +
        `<span class="chip" style="color:#8ea9c9">${esc(g.id)}</span>` +
        (g.state ? statusBadge(g.state) : "") +
        waits +
        unbl +
        `</div>` +
        `<div class="g-do">${esc(g.brief)}</div>` +
        (g.acceptance ? `<div class="g-done"><b>Done when:</b> ${esc(g.acceptance)}</div>` : "") +
        `</div></div>`
      );
    })
    .join("");

  // Phase rail with the launch-gate marker inserted before the first gated phase.
  let railHtml = "";
  let gateInserted = false;
  for (const p of phases) {
    const inPhase = tasks.filter((t) => t.phase === p);
    const cnt = inPhase.length;
    const isGate = gated && String(p).startsWith(gatePhase!);
    const isGated = gated && String(p).startsWith(gatedPhase!);
    if (isGated && !gateInserted) {
      railHtml += `<div class="gatemark"><div class="bar"></div>GATE<br>HELD<div class="bar"></div></div>`;
      gateInserted = true;
    }
    const done = inPhase.filter((t) => t.state && t.state !== "pending" && t.state !== "running").length;
    const prog = hasRun ? `<div class="pp">${done}/${cnt} done</div>` : "";
    railHtml +=
      `<div class="pcard${isGate ? " gatephase" : ""}${isGated ? " gatedphase" : ""}">` +
      `<div class="pn">${esc(p)}</div><div class="pc">${cnt} task${cnt > 1 ? "s" : ""}</div>${prog}</div>`;
  }

  // Per-task list, grouped by phase.
  let bodyHtml = "";
  for (const p of phases) {
    const list = tasks.filter((t) => t.phase === p);
    bodyHtml +=
      `<div class="phase"><h3>${esc(p)}</h3><div class="line"></div><span class="cnt">${list.length}</span></div>` +
      `<div class="tasks">`;
    for (const t of list) {
      const ex =
        t.executor === "agent"
          ? `<span class="badge b-agent">agent</span>`
          : `<span class="badge b-gate">${esc(t.executor)} &#183; GATE</span>`;
      const depChips = t.deps.length
        ? t.deps.map((d) => `<span class="chip">${esc(d)}</span>`).join("")
        : `<span class="chip" style="opacity:.5">none</span>`;
      bodyHtml +=
        `<div class="task" data-id="${esc(t.id)}"><div class="row1">` +
        `<span class="tid">${esc(t.id)}</span> ${ex} ` +
        `<span class="badge b-model">${esc(t.model)}</span> ${statusBadge(t.state)} ` +
        `<span class="ttl">${esc(t.title)}</span></div>` +
        `<div class="deps"><span class="lbl">deps</span>${depChips}</div>` +
        (t.acceptance ? `<div class="acc"><b>done when:</b> ${esc(t.acceptance).slice(0, 800)}</div>` : "") +
        `</div>`;
    }
    bodyHtml += `</div>`;
  }

  // Dependency graph for click-to-trace (only edges — the DOM carries the rest).
  const graph: Record<string, { deps: string[]; unblocks: string[] }> = {};
  for (const t of tasks) graph[t.id] = { deps: t.deps, unblocks: t.unblocks };
  const graphJson = JSON.stringify(graph).replace(/</g, "\\u003c");

  const generatedAt = new Date().toISOString();
  const refreshMeta = running ? `<meta http-equiv="refresh" content="4">` : "";
  const gateMarker = gated ? `<!-- launch-gate:${gatePhase}->${gatedPhase} -->` : "";
  const subKind = hasRun
    ? `live run &#183; status <b>${esc(runStatus)}</b>${running ? " &#183; auto-refresh 4s" : ""}`
    : "plan view, no run, no spend";

  const runBanner = hasRun
    ? `<div class="runbar${running ? " running" : ""}">` +
      `<span class="rb-status">${esc(runStatus)}</span>` +
      `<span class="rb-prog">${terminal}/${total} tasks resolved &#183; ${percent}%</span>` +
      (running ? `<span class="rb-note">page reloads every 4s while the run is live</span>` : "") +
      `</div>`
    : "";

  // ── static CSS (no ${} — safe inside the template literal) ──
  const css = `
:root{--bg:#0f1216;--panel:#161b22;--panel2:#1c232c;--line:#2a333f;--ink:#e6edf3;--dim:#8b98a5;--agent:#3fb950;--human:#d29922;--gate:#f85149;--acc:#3b82f6;--mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 "Inter",system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 22px 60px}
h1{font-size:20px;margin:0 0 2px;letter-spacing:.2px}
.sub{color:var(--dim);font-size:13px;margin-bottom:18px}
.sub code{font-family:var(--mono);color:#b9c4cf}
.runbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;border:1px solid var(--line);background:var(--panel);border-radius:10px;padding:10px 14px;margin-bottom:16px}
.runbar.running{border-color:#1f6feb;background:#0d1930}
.rb-status{font-family:var(--mono);font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#58a6ff}
.rb-prog{font-size:13px;color:#c9d3dd}
.rb-note{font-size:12px;color:var(--dim);margin-left:auto}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:14px}
.tiles.live{margin-bottom:22px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.tile .k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.tile .v{font-size:24px;font-weight:600;margin-top:4px}.tile .v small{font-size:13px;color:var(--dim);font-weight:400}
.section-h{display:flex;align-items:center;gap:10px;margin:26px 0 12px}
.section-h h2{font-size:15px;margin:0}.section-h .line{flex:1;height:1px;background:var(--line)}
.section-h .cnt{color:var(--dim);font-size:12px}
.gatewrap{border:1px solid #5c4a1a;background:linear-gradient(180deg,#1b1810,#161b22);border-radius:12px;padding:6px 4px}
.gatewrap.empty{border-color:var(--line);background:var(--panel);padding:14px 16px;color:var(--dim);font-size:13px}
.gate{display:grid;grid-template-columns:34px 1fr;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line)}
.gate:last-child{border-bottom:none}
.gate .num{width:30px;height:30px;border-radius:8px;background:#211c10;border:1px solid #5c4a1a;color:var(--human);font-weight:700;font-family:var(--mono);display:flex;align-items:center;justify-content:center;font-size:13px}
.gate .g-title{font-weight:600;font-size:15px}
.gate .g-meta{display:flex;gap:8px;flex-wrap:wrap;margin:5px 0 8px;align-items:center}
.gate .g-do{color:#cdd6df;font-size:13.5px;margin:2px 0 8px}
.gate .g-done{color:var(--dim);font-size:12.5px;margin-top:4px}
.gate .g-done b{color:#9fb0c0}
.chip{font-family:var(--mono);font-size:11px;padding:1px 7px;border-radius:6px;background:var(--panel2);border:1px solid var(--line);color:#aeb9c4}
.chip.phase{color:#c9d3dd}.chip.wait{color:var(--gate);border-color:#5c2420;background:#241413}
.chip.unblock{color:var(--agent);border-color:#26502f;background:#132018}
.badge{font-family:var(--mono);font-size:10.5px;padding:2px 7px;border-radius:20px;border:1px solid transparent;white-space:nowrap}
.b-human{color:var(--human);border-color:#5c4a1a;background:#211c10}
.b-agent{color:var(--agent);border-color:#26502f;background:#132018}.b-gate{color:var(--gate);border-color:#5c2420;background:#241413}.b-model{color:#9fb0c0;border-color:var(--line);background:var(--panel2)}
.sbadge{font-family:var(--mono);font-size:10.5px;padding:2px 8px;border-radius:20px;border:1px solid transparent;white-space:nowrap}
.s-pending{color:var(--dim);border-color:var(--line);background:var(--panel2)}
.s-running{color:#58a6ff;border-color:#1f6feb;background:#0d1f33}
.s-built{color:var(--agent);border-color:#26502f;background:#132018}
.s-deferred{color:var(--human);border-color:#5c4a1a;background:#211c10}
.s-skipped{color:#8b98a5;border-color:var(--line);background:var(--panel2)}
.s-failed{color:var(--gate);border-color:#5c2420;background:#241413}
.rail{display:flex;align-items:stretch;gap:8px;overflow-x:auto;padding-bottom:10px;margin-bottom:8px}
.pcard{min-width:118px;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:10px 12px;flex:0 0 auto}
.pcard.gatephase{border-color:var(--acc)}.pcard.gatedphase{border-color:var(--gate)}
.pcard .pn{font-family:var(--mono);font-size:12px;color:#c9d3dd;white-space:nowrap}
.pcard .pc{font-size:12px;color:var(--dim);margin-top:6px}
.pcard .pp{font-size:11px;color:#8ea9c9;margin-top:3px;font-family:var(--mono)}
.gatemark{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:60px;color:var(--gate);font-size:10px;font-weight:700;letter-spacing:.05em;text-align:center}
.gatemark .bar{width:2px;flex:1;background:repeating-linear-gradient(var(--gate),var(--gate) 5px,transparent 5px,transparent 10px);margin:4px 0}
.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--dim);font-size:12px;margin:14px 0 6px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}
.phase{margin:22px 0 6px;display:flex;align-items:center;gap:10px}
.phase h3{font-size:14px;font-family:var(--mono);margin:0;color:#c9d3dd}.phase .line{flex:1;height:1px;background:var(--line)}.phase .cnt{color:var(--dim);font-size:12px}
.tasks{display:flex;flex-direction:column;gap:8px}
.task{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:11px 14px;cursor:pointer;transition:border-color .12s,background .12s}
.task:hover{border-color:#3a4552}.task .row1{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.tid{font-family:var(--mono);font-size:12px;color:#8ea9c9}.ttl{font-weight:500}
.deps{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}.deps .lbl{color:var(--dim);font-size:11px;margin-right:2px}
.task.sel{border-color:var(--acc);background:#141c28}.task.dep{border-color:var(--agent)}.task.dependent{border-color:var(--human)}.task.dim{opacity:.35}
.acc{color:var(--dim);font-size:12px;margin-top:8px;display:none}.task.sel .acc{display:block}
.hint{color:var(--dim);font-size:12px;margin:6px 0 14px}
`;

  // ── static interaction JS (no ${} — safe inside the template literal) ──
  const script = `
const byId = GRAPH;
let sel = null;
const clear = () => document.querySelectorAll('.task').forEach(e => e.classList.remove('sel','dep','dependent','dim'));
const anc = (id,a) => {((byId[id]||{}).deps||[]).forEach(d=>{if(!a.has(d)){a.add(d);anc(d,a);}});return a;};
const desc = (id,a) => {((byId[id]||{}).unblocks||[]).forEach(d=>{if(!a.has(d)){a.add(d);desc(d,a);}});return a;};
document.getElementById('body').addEventListener('click', e => {
  const el = e.target.closest('.task'); if(!el) return;
  const id = el.dataset.id;
  if(sel===id){sel=null;clear();return;}
  sel=id; clear();
  const up=anc(id,new Set()), dn=desc(id,new Set());
  document.querySelectorAll('.task').forEach(t=>{
    const d=t.dataset.id;
    if(d===id)t.classList.add('sel');
    else if(up.has(d))t.classList.add('dep');
    else if(dn.has(d))t.classList.add('dependent');
    else t.classList.add('dim');
  });
});
`;

  const gatesSection = humanGates.length
    ? `<div class="gatewrap" id="gates">${gateHtml}</div>`
    : `<div class="gatewrap empty" id="gates">No human gates in this plan &mdash; every task is agent-built.</div>`;

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    refreshMeta +
    `<title>${esc(plan.name)} &mdash; Local Harness Dashboard</title>` +
    gateMarker +
    `<style>${css}</style></head><body><div class="wrap">` +
    `<h1>${esc(plan.name)} &mdash; Local Harness Dashboard</h1>` +
    `<div class="sub">Rendered from <code>ds-build-agent</code>'s own parser &#183; ${esc(
      generatedAt,
    )} &#183; ${subKind}</div>` +
    runBanner +
    `<div class="tiles">${planTiles}</div>` +
    liveTiles +
    `<div class="section-h"><h2>&#9873; Human gates &mdash; what needs you</h2><div class="line"></div><span class="cnt">${
      humanGates.length
    } gate${humanGates.length === 1 ? "" : "s"}</span></div>` +
    `<!-- human-gates -->` +
    `<p class="hint">These are the only steps the harness will NOT do on its own. In a run each is written to <code>BLOCKERS.md</code> (or <code>GHL-SETUP.md</code>) and waits for you. Ranked in run order.</p>` +
    gatesSection +
    `<div class="section-h"><h2>Phase map</h2><div class="line"></div></div>` +
    `<div class="rail">${railHtml}</div>` +
    `<div class="legend">` +
    `<span><span class="dot" style="background:var(--agent)"></span>agent &#183; auto-build</span>` +
    `<span><span class="dot" style="background:var(--human)"></span>human &#183; gate</span>` +
    (gated
      ? `<span><span class="dot" style="background:var(--gate)"></span>launch gate: phase ${esc(
          gatedPhase!,
        )} holds until phase ${esc(gatePhase!)} passes</span>`
      : "") +
    `</div>` +
    `<p class="hint">Click any task to trace its dependency chain &mdash; <b style="color:var(--agent)">green</b> = what it waits on, <b style="color:var(--human)">amber</b> = what waits on it.</p>` +
    `<div id="body">${bodyHtml}</div>` +
    `</div>` +
    `<script>const GRAPH = ${graphJson};</script>` +
    `<script>${script}</script>` +
    `</body></html>`
  );
}
