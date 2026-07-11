// ds-build dashboard client (vanilla, no framework).
// Skeleton: confirm the server is up and can parse a plan.

const $ = (sel) => document.querySelector(sel);

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function checkHealth() {
  const health = $("#health");
  try {
    const h = await getJson("/api/health");
    health.textContent = h.apiKeySet ? "API key: set" : "API key: not set";
    health.classList.add("ok");
    return h;
  } catch (e) {
    health.textContent = "server error";
    health.classList.add("bad");
    throw e;
  }
}

async function init() {
  const app = $("#app");
  const h = await checkHealth();
  app.innerHTML = `
    <section class="card">
      <h2 style="margin-top:0">Load a plan</h2>
      <p class="muted">Builds root: <code>${h.buildsRoot}</code></p>
      <input id="planPath" type="text" style="width:70%;padding:8px;background:#0f1115;color:#e6e8ee;border:1px solid #2a2f3a;border-radius:6px"
             placeholder="C:\\Users\\marcu\\Downloads\\fastig-plan.yaml" />
      <button id="loadBtn" style="padding:8px 14px;margin-left:8px;background:#5b8cff;color:#fff;border:0;border-radius:6px;cursor:pointer">Load</button>
      <pre id="planOut" class="muted" style="white-space:pre-wrap;margin-top:14px"></pre>
    </section>`;

  $("#loadBtn").addEventListener("click", async () => {
    const out = $("#planOut");
    out.textContent = "Loading…";
    try {
      const { view } = await getJson("/api/plan?path=" + encodeURIComponent($("#planPath").value.trim()));
      out.textContent =
        `Plan: ${view.name}\n` +
        `Phases: ${view.phases.map((p) => p.phase + " (" + p.tasks.length + ")").join(", ")}\n` +
        `Executors: agent ${view.executorCounts.agent} / human ${view.executorCounts.human} / ghl ${view.executorCounts.ghl}\n` +
        `Gate: ${view.gate.enabled ? view.gate.gatePhase + "→" + view.gate.gatedPhase + (view.gate.canOpenAutonomously ? " (can open)" : " (held by human sign-off)") : "none"}`;
    } catch (e) {
      out.textContent = "Error: " + e.message;
    }
  });
}

init().catch((e) => {
  $("#app").innerHTML = `<p class="pill bad">${e.message}</p>`;
});
