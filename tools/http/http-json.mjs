/**
 * httpJson — the default JSON HTTP client for harness live-read/verify tooling.
 *
 * WHY THIS EXISTS: two API quirks recur across the builds this harness runs and
 * each has cost real debugging time:
 *   1. Cloudflare-fronted hosts (DataSphere/myapiconnect) reject a request with
 *      no browser User-Agent — error 1010. So a browser UA is ON BY DEFAULT here.
 *   2. DataSphere answers a MALFORMED request with HTTP 200 and a body-level
 *      rejection ({"event":"Missing key ..."}). A status check alone counts that
 *      rejection as success. So the success verdict is a pluggable rule, and the
 *      body-parsing rule (`datasphereSuccess`) is a faithful port of the proven
 *      pipeline/tbfc/datasphere.py:interpret_response.
 *
 * The transport (headers, body, timeout, parse) is split from the success
 * semantics so GHL, Cloud Run and DataSphere can share one client while each
 * keeps its own verdict rule. Pure and injectable: pass `fetchImpl` and no
 * network is touched, which is how the test file runs hermetically.
 *
 * Never logs a value. The return surfaces only the RESPONSE (status/parsed/text/
 * detail) — never the request headers — so a secret in an Authorization header
 * cannot leak through this function.
 */

/** Chrome-on-Windows UA — byte-identical to datasphere.py's BROWSER_UA. */
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Substrings that mark a 2xx body as a real error — verbatim from datasphere.py. */
export const BODY_ERROR_MARKERS = [
  "missing key",
  "invalid",
  "error",
  "not found",
  "unauthor",
  "failed",
  "no api",
  "wrong",
  "denied",
];

const is2xx = (s) => s >= 200 && s < 300;

/**
 * Default success rule: HTTP status only. What GHL and ordinary JSON APIs need.
 * @param {{status:number, parsed:any, text:string}} ctx
 */
export function statusSuccess({ status, text }) {
  return is2xx(status)
    ? { ok: true, detail: "2xx" }
    : { ok: false, detail: `HTTP ${status}: ${(text || "").slice(0, 300)}` };
}

/**
 * Opt-in success rule: a faithful port of datasphere.py interpret_response.
 * A 2xx can still be a body-level rejection. IMPORTANT: an `event` key alone is
 * NOT a rejection — {"event":"contact created","state":true} is SUCCESS. Only an
 * error MARKER inside the event (or anywhere in the body) fails a 2xx.
 * @param {{status:number, parsed:any, text:string}} ctx
 */
export function datasphereSuccess({ status, parsed, text }) {
  if (!is2xx(status)) return { ok: false, detail: `HTTP ${status}: ${(text || "").slice(0, 200)}` };
  const t = (text || "").trim();
  if (!t) return { ok: true, detail: "2xx, empty body" };
  if (parsed === null) {
    // Non-JSON body: fall back to the status, but a 2xx with an error marker fails.
    const low = t.toLowerCase();
    return BODY_ERROR_MARKERS.some((m) => low.includes(m))
      ? { ok: false, detail: `2xx but body signals error: ${t.slice(0, 200)}` }
      : { ok: true, detail: `2xx: ${t.slice(0, 120)}` };
  }
  const event =
    parsed && typeof parsed === "object" ? String(parsed.event ?? parsed.message ?? "") : "";
  const blob = JSON.stringify(parsed).toLowerCase();
  if (event && BODY_ERROR_MARKERS.some((m) => event.toLowerCase().includes(m))) {
    return { ok: false, detail: `2xx but event signals error: ${event.slice(0, 200)}` };
  }
  if (BODY_ERROR_MARKERS.some((m) => blob.includes(m))) {
    return { ok: false, detail: `2xx but body signals error: ${blob.slice(0, 200)}` };
  }
  return { ok: true, detail: `2xx: ${event.slice(0, 120) || "ok"}` };
}

/** Case-insensitive header merge; later wins; keys normalized to lower-case. */
function mergeHeaders(defaults, overrides) {
  const out = {};
  for (const [k, v] of Object.entries(defaults)) out[k.toLowerCase()] = v;
  for (const [k, v] of Object.entries(overrides || {})) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Perform a JSON HTTP request with a browser UA by default and a pluggable
 * success verdict. Never throws for network/timeout — those return
 * {ok:false, status:0, ...}, mirroring datasphere.py's URLError→(0,...) contract.
 *
 * @param {string} url
 * @param {{
 *   method?: string,
 *   headers?: Record<string,string>,
 *   body?: unknown,                // object → JSON.stringify + content-type json; string → passthrough
 *   timeoutMs?: number,
 *   userAgent?: string,            // override the default browser UA
 *   isSuccess?: (ctx:{status:number, parsed:any, text:string}) => {ok:boolean, detail:string},
 *   fetchImpl?: typeof fetch,      // inject for tests
 * }} [opts]
 * @returns {Promise<{ok:boolean, status:number, parsed:any, text:string, detail:string}>}
 */
export async function httpJson(url, opts = {}) {
  const {
    method = "GET",
    headers: callerHeaders,
    body,
    timeoutMs = 15000,
    userAgent,
    isSuccess = statusSuccess,
    fetchImpl,
  } = opts;
  const doFetch = fetchImpl || fetch;

  const defaults = { "user-agent": userAgent || BROWSER_UA, accept: "application/json" };
  let sendBody = body;
  if (body !== undefined && body !== null && typeof body !== "string") {
    sendBody = JSON.stringify(body);
    defaults["content-type"] = "application/json";
  }
  const headers = mergeHeaders(defaults, callerHeaders);

  const init = { method, headers };
  if (sendBody !== undefined && sendBody !== null) init.body = sendBody;

  // Own the timer so it is cleared and never keeps the event loop alive.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`timeout after ${timeoutMs}ms`, "TimeoutError")),
    timeoutMs,
  );
  if (typeof timer.unref === "function") timer.unref();

  let status = 0;
  let text = "";
  let parsed = null;
  try {
    const res = await doFetch(url, { ...init, signal: controller.signal });
    status = res.status;
    text = await res.text();
  } catch (e) {
    const name = e && e.name;
    const detail =
      name === "TimeoutError" || name === "AbortError"
        ? `timeout after ${timeoutMs}ms`
        : `network error: ${String((e && e.message) || e).slice(0, 200)}`;
    return { ok: false, status: 0, parsed: null, text: "", detail };
  } finally {
    clearTimeout(timer);
  }

  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const verdict = isSuccess({ status, parsed, text });
  return { ok: verdict.ok, status, parsed, text, detail: verdict.detail };
}
