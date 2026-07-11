// DOM builders for the plan view + a patcher that overlays live run state.

const STATUS_LABEL = {
  pending: "pending",
  running: "running",
  built: "built",
  deferred: "deferred",
  skipped: "skipped",
  failed: "failed",
};

export function h(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "dataset") Object.assign(e.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

const docFor = (executor) => (executor === "ghl" ? "GHL-SETUP.md" : "BLOCKERS.md");

/** Plan header: name, description, model, stack, policy. */
export function renderHeader(planView, path) {
  const p = planView.policy;
  return h("section", { class: "card" },
    h("div", { class: "card-head" },
      h("h2", {}, planView.name),
      h("span", { class: "muted mono small" }, path)),
    planView.description ? h("p", { class: "muted" }, planView.description) : null,
    h("div", { class: "meta-row" },
      planView.model ? h("span", { class: "chip" }, "model: " + planView.model) : null,
      h("span", { class: "chip" }, p.commitAfterEachTask ? "commit_after_each_task: on" : "commit_after_each_task: off"),
      p.gatePhase ? h("span", { class: "chip" }, `launch gate ${p.gatePhase}→${p.gatedPhase}`) : null),
    planView.stack && planView.stack.length
      ? h("details", { class: "stack" }, h("summary", {}, "stack"),
          h("ul", {}, planView.stack.map((s) => h("li", { class: "muted small" }, s))))
      : null,
  );
}

/** Legend + executor tallies. */
export function renderLegend(counts) {
  const mk = (cls, label, n) => h("span", { class: "legend-item" },
    h("span", { class: "exec-badge exec-" + cls }, label), h("span", { class: "muted small" }, `× ${n}`));
  return h("section", { class: "card legend" },
    h("strong", { class: "small" }, "Executors: "),
    mk("agent", "agent", counts.agent), mk("human", "human", counts.human), mk("ghl", "ghl", counts.ghl),
    h("span", { class: "muted small legend-note" }, "agent → built · human → BLOCKERS.md · ghl → GHL-SETUP.md"),
  );
}

/** Launch-gate panel (patched live via applyGate). */
export function renderGatePanel(gate) {
  const body = h("div", { class: "gate-body" });
  const wrap = h("section", { class: "card gate", id: "gatePanel" },
    h("div", { class: "card-head" }, h("h3", {}, "Launch gate"), h("span", { class: "gate-status pill" }, "—")),
    body);
  wrap._body = body;
  applyGate(wrap, gate, null);
  return wrap;
}

export function applyGate(wrap, gate, liveGate) {
  const statusEl = wrap.querySelector(".gate-status");
  const body = wrap._body;
  body.innerHTML = "";
  if (!gate || !gate.enabled) {
    statusEl.textContent = "none";
    statusEl.className = "gate-status pill";
    body.append(h("p", { class: "muted small" }, "This plan declares no launch gate."));
    return;
  }
  const open = liveGate ? liveGate.open : false;
  statusEl.textContent = open ? "OPEN" : "BLOCKED";
  statusEl.className = "gate-status pill " + (open ? "ok" : "bad");

  body.append(h("p", {},
    `Phase `, h("strong", {}, gate.gatedPhase), ` is held until every agent task in phase `,
    h("strong", {}, gate.gatePhase), ` succeeds.`));

  // Which phase-6 agent tasks still gate it (live), else list all of them.
  const blocking = liveGate ? liveGate.blockingAgentTasks : gate.gateAgentTaskIds;
  if (blocking && blocking.length) {
    body.append(h("div", { class: "gate-list" },
      h("span", { class: "muted small" }, "waiting on agent tasks: "),
      blocking.map((id) => h("span", { class: "chip mono small" }, id))));
  } else if (liveGate) {
    body.append(h("p", { class: "small ok" }, "All gate agent tasks have succeeded."));
  }

  if (gate.gateHumanTaskIds && gate.gateHumanTaskIds.length) {
    body.append(h("div", { class: "gate-list warn" },
      h("span", { class: "small" }, "⚠ held by human sign-off (never opens autonomously): "),
      gate.gateHumanTaskIds.map((id) => h("span", { class: "chip mono small" }, id))));
  }
  if (gate.gatedTaskIds && gate.gatedTaskIds.length) {
    body.append(h("div", { class: "muted small" },
      `Gated tasks: ${gate.gatedTaskIds.join(", ")}`));
  }
}

/** Progress summary card (patched via applyProgress). */
export function renderProgress() {
  return h("section", { class: "card progress", id: "progressCard" },
    h("div", { class: "card-head" }, h("h3", {}, "Progress"),
      h("span", { class: "active-phase muted small" }, "")),
    h("div", { class: "bar big" }, h("div", { class: "bar-fill overall" })),
    h("div", { class: "tallies" },
      ["built", "deferred", "skipped", "failed", "running", "pending"].map((k) =>
        h("span", { class: "tally t-" + k }, h("b", { class: "n" }, "0"), " " + k))),
    h("div", { class: "slots muted small" }, ""),
  );
}

export function applyProgress(card, state) {
  const pct = state ? state.progress.percentComplete : 0;
  card.querySelector(".bar-fill.overall").style.width = pct + "%";
  const t = state ? state.totals : { built: 0, deferred: 0, skipped: 0, failed: 0, running: 0, pending: 0 };
  for (const k of ["built", "deferred", "skipped", "failed", "running", "pending"]) {
    const el = card.querySelector(".tally.t-" + k + " .n");
    if (el) el.textContent = t[k] ?? 0;
  }
  const ap = card.querySelector(".active-phase");
  ap.textContent = state && state.activePhase ? "active phase: " + state.activePhase : "";
  const slots = card.querySelector(".slots");
  if (state) {
    slots.textContent = `concurrency: ${state.concurrency.inUse}/${state.concurrency.limit} slots in use` +
      (state.run ? `  ·  ${state.run.dryRun ? "dry run" : "REAL run"} · ${state.run.status}` : "");
  } else slots.textContent = "";
}

/** Phases + task cards. Returns { section, cardById }. */
export function renderPhases(planView) {
  const cardById = new Map();
  const section = h("section", { class: "phases", id: "phases" });
  for (const phase of planView.phases) {
    const fill = h("div", { class: "bar-fill phase-fill" });
    const pct = h("span", { class: "phase-pct muted small" }, "");
    const tasksEl = h("div", { class: "phase-tasks" });
    const phaseEl = h("div", { class: "phase", dataset: { phase: phase.phase } },
      h("div", { class: "phase-head" },
        h("h3", {}, phase.phase),
        h("span", { class: "muted small" }, `${phase.tasks.length} task${phase.tasks.length === 1 ? "" : "s"}`),
        h("div", { class: "bar" }, fill), pct),
      tasksEl);
    phaseEl._fill = fill;
    phaseEl._pct = pct;
    for (const t of phase.tasks) {
      const card = renderTaskCard(t);
      cardById.set(t.id, card);
      tasksEl.append(card);
    }
    section.append(phaseEl);
  }
  return { section, cardById };
}

function renderTaskCard(t) {
  const detail = h("div", { class: "task-detail" });
  const deps = (t.deps && t.deps.length)
    ? h("div", { class: "task-deps" }, h("span", { class: "muted small" }, "deps: "),
        t.deps.map((d) => h("span", { class: "chip mono small dep", dataset: { dep: d } }, d)))
    : null;
  const card = h("div", {
    class: "task", dataset: { taskId: t.id, executor: t.executor, state: "pending" },
  },
    h("div", { class: "task-head" },
      h("span", { class: "status-dot" }),
      h("span", { class: "task-id mono" }, t.id),
      h("span", { class: "exec-badge exec-" + t.executor }, t.executor),
      t.executor !== "agent" ? h("span", { class: "muted small" }, "→ " + docFor(t.executor)) : null,
      h("span", { class: "status-label" }, "pending"),
      h("span", { class: "task-dur muted small" }, "")),
    h("div", { class: "task-title" }, t.title),
    deps,
    detail);
  card._detail = detail;
  return card;
}

/** Overlay live state onto the task cards, phases, progress, gate. */
export function applyState(refs, planView, state) {
  const byId = new Map((state?.tasks || []).map((t) => [t.id, t]));
  for (const [id, card] of refs.cardById) {
    const tv = byId.get(id);
    const st = tv ? tv.state : "pending";
    card.dataset.state = st;
    card.querySelector(".status-label").textContent = STATUS_LABEL[st] || st;
    const dur = card.querySelector(".task-dur");
    dur.textContent = tv && tv.durationMs ? Math.round(tv.durationMs / 1000) + "s" : "";
    const detail = card._detail;
    detail.innerHTML = "";
    if (tv && tv.error) detail.append(h("div", { class: "task-error small" }, tv.error));
    else if (tv && tv.summary) detail.append(h("div", { class: "task-summary small muted" }, truncate(tv.summary, 240)));
    // keep an existing commit link if present
    if (card._commit) detail.append(card._commit);
  }
  // per-phase progress
  const phaseState = new Map((state?.phases || []).map((p) => [p.phase, p]));
  refs.phasesSection.querySelectorAll(".phase").forEach((phaseEl) => {
    const ps = phaseState.get(phaseEl.dataset.phase);
    const pct = ps ? ps.percentComplete : 0;
    phaseEl._fill.style.width = pct + "%";
    phaseEl._pct.textContent = pct + "%";
  });
  applyProgress(refs.progressCard, state);
  applyGate(refs.gatePanel, planView.gate, state ? state.gate : null);
}

/** Attach commit rollback links to built task cards. commitMap: id -> {short,hash}. */
export function applyCommits(refs, commitMap) {
  for (const [id, card] of refs.cardById) {
    const c = commitMap.get(id);
    if (!c) continue;
    const link = h("div", { class: "task-commit small" },
      h("span", { class: "muted" }, "commit "),
      h("code", { title: c.hash + " — rollback reference" }, c.short));
    card._commit = link;
    // ensure it's shown even if applyState already ran
    if (!card._detail.contains(link)) card._detail.append(link);
  }
}

function truncate(s, n) {
  const flat = String(s).replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}
