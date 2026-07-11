// Thin API client for the dashboard backend.

export async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

export async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export const api = {
  health: () => getJson("/api/health"),
  plan: (path) => getJson("/api/plan?path=" + encodeURIComponent(path)),
  runs: () => getJson("/api/runs"),
  startRun: (payload) => postJson("/api/runs", payload),
  stopRun: (id) => postJson(`/api/runs/${encodeURIComponent(id)}/stop`, {}),
  state: (build) => getJson("/api/state?build=" + encodeURIComponent(build)),
  files: (build) => getJson("/api/files?build=" + encodeURIComponent(build)),
  file: (build, name) =>
    getJson(`/api/file?build=${encodeURIComponent(build)}&file=${encodeURIComponent(name)}`),
  commits: (build) => getJson("/api/commits?build=" + encodeURIComponent(build)),
};

/**
 * Subscribe to a run's SSE stream. Calls handlers.{hello,log,state,event,status}.
 * Returns the EventSource so the caller can close it.
 */
export function streamRun(runId, handlers) {
  const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const fn = handlers[msg.type];
    if (fn) fn(msg);
  };
  es.onerror = () => {
    if (handlers.error) handlers.error();
  };
  return es;
}
