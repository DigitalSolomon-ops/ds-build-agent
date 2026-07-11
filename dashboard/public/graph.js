// Layered SVG dependency graph. Columns = dependency depth (longest chain),
// nodes colored by executor, recolorable by live task status. Clicking a node
// highlights its ancestors + descendants.

const NS = "http://www.w3.org/2000/svg";
const NODE_W = 150;
const NODE_H = 30;
const COL_GAP = 70;
const ROW_GAP = 12;
const PAD = 16;

function el(name, attrs = {}) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** Longest-path level for each task (0 = no deps). */
function computeLevels(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const level = new Map();
  const visit = (id, seen) => {
    if (level.has(id)) return level.get(id);
    if (seen.has(id)) return 0; // guard (plan is acyclic, but be safe)
    seen.add(id);
    const t = byId.get(id);
    const deps = (t?.deps || []).filter((d) => byId.has(d));
    const lv = deps.length ? 1 + Math.max(...deps.map((d) => visit(d, seen))) : 0;
    level.set(id, lv);
    return lv;
  };
  for (const t of tasks) visit(t.id, new Set());
  return level;
}

export function renderGraph(container, planView) {
  container.innerHTML = "";
  const tasks = planView.phases.flatMap((p) => p.tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const level = computeLevels(tasks);

  // Bucket by level, order within a level by original task order.
  const byLevel = new Map();
  for (const t of tasks) {
    const lv = level.get(t.id);
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv).push(t.id);
  }

  const pos = new Map();
  let maxRows = 0;
  for (const [lv, ids] of byLevel) {
    ids.forEach((id, row) => {
      pos.set(id, {
        x: PAD + lv * (NODE_W + COL_GAP),
        y: PAD + row * (NODE_H + ROW_GAP),
      });
    });
    maxRows = Math.max(maxRows, ids.length);
  }

  const maxLevel = Math.max(...level.values(), 0);
  const width = PAD * 2 + (maxLevel + 1) * NODE_W + maxLevel * COL_GAP;
  const height = PAD * 2 + maxRows * (NODE_H + ROW_GAP);

  const svg = el("svg", {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    class: "depgraph",
  });

  // Edges first (under nodes).
  const edgeEls = [];
  const edgeLayer = el("g");
  svg.appendChild(edgeLayer);
  for (const t of tasks) {
    for (const dep of t.deps || []) {
      if (!pos.has(dep)) continue;
      const a = pos.get(dep);
      const b = pos.get(t.id);
      const x1 = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x;
      const y2 = b.y + NODE_H / 2;
      const mx = (x1 + x2) / 2;
      const path = el("path", {
        d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
        class: "edge",
        fill: "none",
      });
      path.dataset.from = dep;
      path.dataset.to = t.id;
      edgeLayer.appendChild(path);
      edgeEls.push(path);
    }
  }

  // Nodes.
  const nodeEls = new Map();
  const nodeLayer = el("g");
  svg.appendChild(nodeLayer);
  for (const t of tasks) {
    const p = pos.get(t.id);
    const g = el("g", { class: "node", transform: `translate(${p.x},${p.y})` });
    g.dataset.id = t.id;
    g.dataset.executor = t.executor;
    const rect = el("rect", {
      width: NODE_W,
      height: NODE_H,
      rx: 6,
      class: `node-rect exec-${t.executor}`,
    });
    const label = el("text", { x: 8, y: NODE_H / 2 + 4, class: "node-label" });
    label.textContent = t.id.length > 20 ? t.id.slice(0, 19) + "…" : t.id;
    g.appendChild(rect);
    g.appendChild(label);
    nodeLayer.appendChild(g);
    nodeEls.set(t.id, g);
  }

  container.appendChild(svg);

  // ---- interaction ----
  const ancestors = (id, acc = new Set()) => {
    for (const dep of byId.get(id)?.deps || []) {
      if (pos.has(dep) && !acc.has(dep)) {
        acc.add(dep);
        ancestors(dep, acc);
      }
    }
    return acc;
  };
  const descendants = (id, acc = new Set()) => {
    for (const t of tasks) {
      if ((t.deps || []).includes(id) && !acc.has(t.id)) {
        acc.add(t.id);
        descendants(t.id, acc);
      }
    }
    return acc;
  };

  let selected = null;
  function highlight(id) {
    selected = id;
    if (!id) {
      svg.classList.remove("has-selection");
      nodeEls.forEach((g) => g.classList.remove("sel", "related"));
      edgeEls.forEach((e) => e.classList.remove("sel"));
      return;
    }
    const rel = new Set([id, ...ancestors(id), ...descendants(id)]);
    svg.classList.add("has-selection");
    nodeEls.forEach((g, nid) => {
      g.classList.toggle("sel", nid === id);
      g.classList.toggle("related", rel.has(nid) && nid !== id);
    });
    edgeEls.forEach((e) => {
      e.classList.toggle("sel", rel.has(e.dataset.from) && rel.has(e.dataset.to));
    });
  }

  let onSelect = null;
  nodeEls.forEach((g, id) => {
    g.addEventListener("click", () => {
      highlight(selected === id ? null : id);
      if (onSelect) onSelect(selected);
    });
  });

  return {
    /** Recolor nodes by live status: statesById = { id: "built"|... }. */
    update(statesById) {
      nodeEls.forEach((g, id) => {
        const st = statesById[id];
        g.dataset.state = st || "pending";
      });
    },
    highlight,
    onSelect(fn) {
      onSelect = fn;
    },
  };
}
