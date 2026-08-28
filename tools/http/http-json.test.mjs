/**
 * Hermetic unit tests for httpJson + the two success rules. No network: fetch is
 * injected. Ports the DataSphere body-rejection matrix from the TBFC pipeline's
 * test_datasphere.py so the JS port stays faithful to the Python reference.
 *
 * Run: node --test tools/http/http-json.test.mjs   (also run by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  httpJson,
  statusSuccess,
  datasphereSuccess,
  BROWSER_UA,
} from "./http-json.mjs";

/** A fake fetch that records the last {url, init} and returns a canned response. */
function fakeFetch(status, bodyStr) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { status, text: async () => bodyStr };
  };
  impl.calls = calls;
  impl.last = () => calls[calls.length - 1];
  return impl;
}

test("1. browser UA is sent by default (the 1010 fix)", async () => {
  const f = fakeFetch(200, "{}");
  await httpJson("https://x.example", { fetchImpl: f });
  const ua = f.last().init.headers["user-agent"];
  assert.equal(ua, BROWSER_UA);
  assert.notEqual(ua, undefined);
});

test("2. caller header override is case-insensitive with no duplicate UA key", async () => {
  const f = fakeFetch(200, "{}");
  await httpJson("https://x.example", { headers: { "User-Agent": "custom" }, fetchImpl: f });
  const h = f.last().init.headers;
  assert.equal(h["user-agent"], "custom");
  const uaKeys = Object.keys(h).filter((k) => k.toLowerCase() === "user-agent");
  assert.equal(uaKeys.length, 1);
});

test("3. object body is JSON-stringified with content-type; string body passes through", async () => {
  const f1 = fakeFetch(200, "{}");
  await httpJson("https://x.example", { method: "POST", body: { a: 1 }, fetchImpl: f1 });
  assert.equal(f1.last().init.body, JSON.stringify({ a: 1 }));
  assert.equal(f1.last().init.headers["content-type"], "application/json");

  const f2 = fakeFetch(200, "{}");
  await httpJson("https://x.example", { method: "POST", body: "raw=1", fetchImpl: f2 });
  assert.equal(f2.last().init.body, "raw=1");
  assert.equal(f2.last().init.headers["content-type"], undefined);
});

test("4. default statusSuccess: 200 ok; non-2xx fails with a body snippet", async () => {
  const ok = await httpJson("https://x.example", { fetchImpl: fakeFetch(200, "{}") });
  assert.equal(ok.ok, true);
  const bad = await httpJson("https://x.example", {
    fetchImpl: fakeFetch(403, "<html>Cloudflare 1010</html>"),
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 403);
  assert.equal(bad.parsed, null);
  assert.match(bad.detail, /Cloudflare/);
});

test("5. datasphereSuccess: a 200 with an error-marker event is a FAILURE", async () => {
  const r = await httpJson("https://x.example", {
    isSuccess: datasphereSuccess,
    fetchImpl: fakeFetch(200, '{"event":"Missing key state: running or paused or all.","state":true}'),
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /error|missing/i);
});

test("6. datasphereSuccess: a 200 with a benign event is a SUCCESS (event alone is not a rejection)", async () => {
  const r = await httpJson("https://x.example", {
    isSuccess: datasphereSuccess,
    fetchImpl: fakeFetch(200, '{"event":"contact created","state":true}'),
  });
  assert.equal(r.ok, true);
});

test("7. datasphereSuccess matrix: empty/[]/plain 2xx ok; non-JSON error body + non-2xx fail", () => {
  assert.equal(datasphereSuccess({ status: 200, parsed: null, text: "" }).ok, true);
  assert.equal(datasphereSuccess({ status: 200, parsed: [], text: "[]" }).ok, true);
  assert.equal(datasphereSuccess({ status: 200, parsed: null, text: "queued" }).ok, true);
  assert.equal(datasphereSuccess({ status: 200, parsed: null, text: "Invalid api key" }).ok, false);
  const bad = datasphereSuccess({ status: 400, parsed: null, text: "anything" });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /400/);
});

test("8. the body-rejection rule is per-call: same body, statusSuccess ok, datasphereSuccess fail", async () => {
  const body = '{"tags":[{"name":"invalid-leads"}]}';
  const asGhl = await httpJson("https://x.example", { fetchImpl: fakeFetch(200, body) });
  const asDs = await httpJson("https://x.example", {
    isSuccess: datasphereSuccess,
    fetchImpl: fakeFetch(200, body),
  });
  assert.equal(asGhl.ok, true, "GHL default must not apply the body-marker scan");
  assert.equal(asDs.ok, false, "datasphere rule catches the 'invalid' marker");
});

test("9. transport errors never throw: timeout and network map to status 0", async () => {
  const timeoutFetch = async () => {
    throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
  };
  const t = await httpJson("https://x.example", { fetchImpl: timeoutFetch, timeoutMs: 1234 });
  assert.equal(t.ok, false);
  assert.equal(t.status, 0);
  assert.match(t.detail, /timeout after 1234ms/);

  const netFetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const n = await httpJson("https://x.example", { fetchImpl: netFetch });
  assert.equal(n.status, 0);
  assert.match(n.detail, /network error/);
  assert.match(n.detail, /ECONNREFUSED/);
});

test("10. secret hygiene: request headers never appear in the return value", async () => {
  const r = await httpJson("https://x.example", {
    headers: { Authorization: "Bearer SEKRET" },
    fetchImpl: fakeFetch(200, '{"ok":true}'),
  });
  assert.ok(!JSON.stringify(r).includes("SEKRET"), "an Authorization value must not surface in the result");
});
