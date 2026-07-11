// ds-build dashboard — main client. Vanilla ES modules, SSE for live updates.
import { api, streamRun } from "./api.js";
import {
  h, renderHeader, renderLegend, renderGatePanel, renderProgress,
  renderPhases, applyState, applyCommits,
} from "./render.js";
import { renderGraph } from "./graph.js";
import { renderMarkdown } from "./md.js";

const $ = (s) => document.querySelector(s);

const state = {
  plan: null,      // { path, view }
  refs: null,      // rendered handles
  graph: null,
  es: null,        // EventSource
  runId: null,
  latest: null,    // last run-state snapshot
};

// ---------- boot ----------
async function boot() {
  let health;
  try {
    health = await api.health();
    const pill = $("#health");
    pill.textContent = health.apiKeySet ? "API key: set" : "API key: not set";
    pill.className = "pill " + (health.apiKeySet ? "ok" : "");
  } catch {
    $("#health").textContent = "server offline";
    $("#health").className = "pill bad";
  }
  $("#app").innerHTML = "";
  $("#app").append(loadBar(health));
}

function loadBar(health) {
  const input = h("input", {
    type: "text", id: "planPath", class: "path-input",
    placeholder: "C:\\Users\\marcu\\Downloads\\fastig-plan.yaml",
    value: "C:\\Users\\marcu\\Downloads\\fastig-plan.yaml",
    onkeydown: (e) => { if (e.key === "Enter") doLoad(); },
  });
  return h("section", { class: "card loadbar" },
    h("div", { class: "card-head" }, h("h2", {}, "Load a plan")),
    h("div", { class: "load-row" },
      input,
      h("button", { class: "btn primary", onclick: doLoad }, "Load"),
      ...uploadControl()),
    h("p", { class: "muted small" }, "Type a path and Load, or ", h("strong", {}, "Upload YAML"), " to pick a file."),
    health ? h("p", { class: "muted small" }, `builds root: `, h("code", {}, health.buildsRoot)) : null,
    h("p", { class: "load-msg muted small", id: "loadMsg" }, ""),
  );
}

/**
 * A hidden file input + a button that opens the OS file picker. The browser
 * only hands us the file's bytes (not its path), so we read the text and POST
 * it to /api/plans, which persists it and returns a real on-disk path.
 */
function uploadControl() {
  const input = h("input", {
    type: "file", id: "planFile", accept: ".yaml,.yml", style: "display:none",
    onchange: (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = ""; // let the same file be re-picked later
      handleUpload(file);
    },
  });
  const btn = h("button", { class: "btn", onclick: () => input.click() }, "Upload YAML…");
  return [btn, input];
}

async function handleUpload(file) {
  if (!file) return;
  const msg = $("#loadMsg");
  msg.className = "load-msg muted small";
  msg.textContent = `Uploading ${file.name}…`;
  try {
    const content = await file.text();
    const { path: abs, view } = await api.uploadPlan(file.name, content);
    state.plan = { path: abs, view };
    state.latest = null; // a freshly uploaded plan has no prior run overlay yet
    renderDashboard();
    await refreshBuildData();
  } catch (e) {
    msg.textContent = "Upload error: " + e.message;
    msg.className = "load-msg small bad";
  }
}

async function doLoad() {
  const path = $("#planPath").value.trim();
  const msg = $("#loadMsg");
  msg.textContent = "Loading…";
  try {
    const { path: abs, view } = await api.plan(path);
    state.plan = { path: abs, view };
    renderDashboard();
    await refreshBuildData();
  } catch (e) {
    msg.textContent = "Error: " + e.message;
    msg.className = "load-msg small bad";
  }
}

// ---------- dashboard layout ----------
function renderDashboard() {
  const { view, path } = state.plan;
  const app = $("#app");
  app.innerHTML = "";
  app.append(loadBarCompact());

  app.append(renderHeader(view, path));
  app.append(renderLegend(view.executorCounts));
  const runControl = renderRunControl();
  app.append(runControl);

  const gatePanel = renderGatePanel(view.gate);
  const progressCard = renderProgress();
  app.append(gatePanel, progressCard);

  const { section: phasesSection, cardById } = renderPhases(view);
  const logPanel = renderLogPanel();
  const filesPanel = renderFilesPanel();
  app.append(h("div", { class: "cols" },
    phasesSection,
    h("aside", { class: "side" }, logPanel, filesPanel)));

  const graphPanel = h("section", { class: "card graph-card" },
    h("details", { open: true },
      h("summary", {}, "Dependency graph"),
      h("div", { class: "graph-scroll", id: "graphScroll" })));
  app.append(graphPanel);

  state.refs = { cardById, phasesSection, progressCard, gatePanel, runControl, logPanel, filesPanel };

  // graph
  state.graph = renderGraph($("#graphScroll"), view);
  state.graph.onSelect((id) => { if (id) focusTask(id); });

  // cross-linking: click task id -> highlight graph; click dep chip -> scroll
  for (const [id, card] of cardById) {
    card.querySelector(".task-id").addEventListener("click", () => {
      state.graph.highlight(id);
      focusTask(id);
    });
    card.querySelectorAll(".dep").forEach((chip) =>
      chip.addEventListener("click", () => focusTask(chip.dataset.dep)));
  }

  // apply any state we already have (e.g. after reload)
  applyEverywhere(state.latest);
}

function loadBarCompact() {
  return h("section", { class: "card loadbar compact" },
    h("div", { class: "load-row" },
      h("input", { type: "text", id: "planPath", class: "path-input", value: state.plan.path,
        onkeydown: (e) => { if (e.key === "Enter") doLoad(); } }),
      h("button", { class: "btn", onclick: doLoad }, "Reload"),
      ...uploadControl(),
      h("span", { class: "muted small", id: "loadMsg" }, "")));
}

function focusTask(id) {
  const card = state.refs?.cardById.get(id);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 1200);
}

// ---------- run control ----------
function renderRunControl() {
  const view = state.plan.view;
  const dryToggle = h("input", { type: "checkbox", id: "dryRun", checked: true });
  const conc = h("input", { type: "number", id: "concurrency", min: "1", max: "16", value: "3", class: "num" });

  // scope: per-phase checkboxes (all checked = no --only)
  const scopeBody = h("div", { class: "scope-body" });
  for (const phase of view.phases) {
    const boxes = phase.tasks.map((t) =>
      h("label", { class: "scope-task" },
        h("input", { type: "checkbox", class: "scope-box", checked: true, dataset: { id: t.id } }),
        h("span", { class: "mono small" }, t.id),
        h("span", { class: "exec-badge exec-" + t.executor + " tiny" }, t.executor[0])));
    scopeBody.append(h("div", { class: "scope-phase" },
      h("label", { class: "scope-phase-head" },
        h("input", { type: "checkbox", class: "scope-phase-box", checked: true,
          onchange: (e) => scopeBody.querySelectorAll(`.scope-phase[data-p="${phase.phase}"] .scope-box`)
            .forEach((b) => { b.checked = e.target.checked; }) }),
        h("strong", { class: "small" }, phase.phase)),
      h("div", { class: "scope-tasks" }, boxes)));
    scopeBody.lastChild.dataset.p = phase.phase;
  }

  const startBtns = h("div", { class: "run-actions" },
    h("button", { class: "btn primary big", id: "dryBtn", onclick: () => startRun(true) }, "▶ Dry run"),
    h("button", { class: "btn danger", id: "realBtn", onclick: openConfirm }, "Real run…"),
    h("button", { class: "btn stop", id: "stopBtn", onclick: stopRun, disabled: true }, "■ Stop"));

  return h("section", { class: "card run-control" },
    h("div", { class: "card-head" }, h("h3", {}, "Run"),
      h("span", { class: "muted small", id: "runMsg" }, "")),
    h("div", { class: "run-row" },
      h("label", { class: "switch" }, dryToggle, h("span", {}, "dry run (no agents, no writes)")),
      h("label", { class: "conc" }, "concurrency ", conc)),
    h("details", { class: "scope" },
      h("summary", {}, "Task scope (--only) — all tasks by default"),
      h("div", { class: "scope-actions" },
        h("button", { class: "btn tiny", onclick: () => setAllScope(scopeBody, true) }, "all"),
        h("button", { class: "btn tiny", onclick: () => setAllScope(scopeBody, false) }, "none")),
      scopeBody),
    startBtns);
}

function setAllScope(scopeBody, on) {
  scopeBody.querySelectorAll(".scope-box, .scope-phase-box").forEach((b) => { b.checked = on; });
}

function selectedOnly() {
  const all = [...document.querySelectorAll(".scope-box")];
  const checked = all.filter((b) => b.checked).map((b) => b.dataset.id);
  if (checked.length === all.length) return undefined; // all => no --only
  return checked;
}

function runPayload(dryRun) {
  const p = {
    planPath: state.plan.path,
    dryRun,
    concurrency: Number($("#concurrency").value) || 3,
  };
  const only = selectedOnly();
  if (only) p.only = only;
  return p;
}

async function startRun(dryRun, confirmed) {
  const msg = $("#runMsg");
  try {
    const payload = runPayload(dryRun);
    if (!dryRun) payload.confirmed = confirmed === true;
    const { runId } = await api.startRun(payload);
    beginStreaming(runId, dryRun);
    msg.textContent = "";
  } catch (e) {
    msg.textContent = "Error: " + e.message;
    msg.className = "small bad";
  }
}

function beginStreaming(runId, dryRun) {
  state.runId = runId;
  if (state.es) state.es.close();
  $("#dryBtn").disabled = true;
  $("#realBtn").disabled = true;
  $("#stopBtn").disabled = false;
  const logEl = $("#log");
  logEl.textContent = "";
  setRunStatus(dryRun ? "dry run: running…" : "REAL run: running…", "running");

  state.es = streamRun(runId, {
    log: (m) => appendLog(m.line, m.stream),
    state: (m) => { state.latest = m.state; applyEverywhere(m.state); },
    status: (m) => onRunEnded(m),
    error: () => {/* EventSource auto-retries */},
  });
}

async function stopRun() {
  if (!state.runId) return;
  try { await api.stopRun(state.runId); setRunStatus("stopping…", "running"); }
  catch (e) { $("#runMsg").textContent = "Stop error: " + e.message; }
}

function onRunEnded(m) {
  $("#dryBtn").disabled = false;
  $("#realBtn").disabled = false;
  $("#stopBtn").disabled = true;
  const cls = m.status === "succeeded" ? "ok" : m.status === "stopped" ? "" : "bad";
  setRunStatus(`${m.status}${m.exitCode != null ? " (exit " + m.exitCode + ")" : ""}`, cls);
  if (state.es) { state.es.close(); state.es = null; }
  refreshBuildData(); // pick up new files + commits
}

function setRunStatus(text, cls) {
  const el = $("#logStatus");
  if (el) { el.textContent = text; el.className = "pill " + (cls || ""); }
}

// ---------- confirm modal (real run) ----------
function openConfirm() {
  const view = state.plan.view;
  const only = selectedOnly();
  const scopeIds = only || view.taskIds;
  const scopeSet = new Set(scopeIds);
  const agentTasks = view.phases.flatMap((p) => p.tasks)
    .filter((t) => t.executor === "agent" && scopeSet.has(t.id));
  const folder = view.name; // display; server resolves the real absolute path

  const modal = h("div", { class: "modal-backdrop", onclick: (e) => { if (e.target.classList.contains("modal-backdrop")) modal.remove(); } },
    h("div", { class: "modal" },
      h("h2", {}, "Confirm a REAL run"),
      h("p", { class: "warn-box" }, "⚠ Agent tasks call the Anthropic API and cost money. This writes files into the build folder and commits after each task."),
      h("ul", { class: "confirm-list" },
        h("li", {}, "Plan: ", h("strong", {}, view.name)),
        h("li", {}, "Build folder: ", h("code", {}, "ds-builds\\" + folder + "\\")),
        h("li", {}, "Concurrency: ", h("strong", {}, String(Number($("#concurrency").value) || 3))),
        h("li", {}, "Scope: ", h("strong", {}, only ? `${scopeIds.length} selected task(s)` : "all tasks")),
        h("li", {}, h("strong", {}, `${agentTasks.length} agent task(s)`), " will call the API",
          agentTasks.length ? h("span", { class: "muted small" }, " — " + agentTasks.map((t) => t.id).join(", ")) : null),
        view.gate.enabled && !view.gate.canOpenAutonomously
          ? h("li", { class: "muted small" }, `Launch gate: phase ${view.gate.gatedPhase} will be skipped (held by human sign-off).`)
          : null),
      h("div", { class: "modal-actions" },
        h("button", { class: "btn", onclick: () => modal.remove() }, "Cancel"),
        h("button", { class: "btn danger", onclick: () => { modal.remove(); startRun(false, true); } },
          "Yes, run for real"))));
  document.body.append(modal);
}

// ---------- log panel ----------
function renderLogPanel() {
  const pre = h("pre", { class: "log", id: "log" });
  const panel = h("section", { class: "card log-panel" },
    h("div", { class: "card-head" }, h("h3", {}, "Run log"),
      h("span", { class: "pill", id: "logStatus" }, "idle")),
    pre);
  panel._pre = pre;
  return panel;
}

function appendLog(line, stream) {
  const pre = $("#log");
  if (!pre) return;
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  const span = h("span", { class: "log-line " + (stream === "stderr" ? "err" : "") }, line + "\n");
  pre.append(span);
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

// ---------- files panel ----------
function renderFilesPanel() {
  const list = h("div", { class: "files-list", id: "filesList" }, h("span", { class: "muted small" }, "—"));
  return h("section", { class: "card files-panel" },
    h("div", { class: "card-head" }, h("h3", {}, "Reports & handoffs"),
      h("button", { class: "btn tiny", onclick: () => loadFiles() }, "refresh")),
    list);
}

async function loadFiles() {
  const list = $("#filesList");
  try {
    const { files } = await api.files(state.plan.view.name);
    list.innerHTML = "";
    if (!files.length) { list.append(h("span", { class: "muted small" }, "No .md files in the build folder yet.")); return; }
    for (const f of files) {
      list.append(h("button", { class: "file-item", onclick: () => openFile(f.name) },
        h("span", { class: "mono small" }, f.name),
        f.harnessAuthored ? h("span", { class: "chip tiny" }, "harness") : null,
        h("span", { class: "muted tiny" }, (f.size / 1024).toFixed(1) + " KB")));
    }
  } catch (e) {
    list.innerHTML = "";
    list.append(h("span", { class: "muted small" }, e.message));
  }
}

async function openFile(name) {
  try {
    const { content } = await api.file(state.plan.view.name, name);
    const modal = h("div", { class: "modal-backdrop", onclick: (e) => { if (e.target.classList.contains("modal-backdrop")) modal.remove(); } },
      h("div", { class: "modal wide" },
        h("div", { class: "card-head" }, h("h2", {}, name),
          h("button", { class: "btn tiny", onclick: () => modal.remove() }, "close")),
        h("div", { class: "md-body" })));
    modal.querySelector(".md-body").innerHTML = renderMarkdown(content);
    document.body.append(modal);
  } catch (e) {
    alert("Could not open file: " + e.message);
  }
}

// ---------- commits ----------
async function loadCommits() {
  try {
    const { isRepo, commits } = await api.commits(state.plan.view.name);
    if (!isRepo) return;
    const map = new Map();
    for (const c of commits) if (c.taskId && !map.has(c.taskId)) map.set(c.taskId, c);
    applyCommits(state.refs, map);
  } catch { /* no repo yet */ }
}

// ---------- state application ----------
function applyEverywhere(snapshot) {
  if (!state.refs) return;
  applyState(state.refs, state.plan.view, snapshot);
  if (state.graph && snapshot) {
    const map = {};
    for (const t of snapshot.tasks || []) map[t.id] = t.state;
    state.graph.update(map);
  }
}

/** After load or run end: pull last state, files, commits. */
async function refreshBuildData() {
  loadFiles();
  loadCommits();
  try {
    const { state: snap } = await api.state(state.plan.view.name);
    if (snap) { state.latest = snap; applyEverywhere(snap); }
  } catch { /* no prior run */ }
}

boot();
