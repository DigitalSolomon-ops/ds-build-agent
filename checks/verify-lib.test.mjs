/**
 * Offline tests for the tools/verify live-read library. No network, no gcloud:
 * `http` is injected (a recording fake that applies the caller's isSuccess rule,
 * exactly as the real P5 httpJson would) and a pre-resolved `token` short-circuits
 * getSecretFast. Imports the source .mjs directly — NOT the compiled dist.
 *
 * Run: node --test checks/verify-lib.test.mjs   (also run by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inventory, upsertField } from "../tools/verify/ghl.mjs";
import { campaignState } from "../tools/verify/datasphere.mjs";

/**
 * A recording fake of P5's httpJson. Applies the caller's isSuccess rule to the
 * canned response so we test that verify wires the RIGHT predicate. `responses`
 * is either a single canned {status,parsed,text} or a queue consumed in order.
 */
function makeHttp(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : null;
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", headers: opts.headers || {}, body: opts.body });
    const canned = queue ? queue.shift() : responses;
    const status = canned && canned.status !== undefined ? canned.status : 200;
    const parsed = canned && "parsed" in canned ? canned.parsed : null;
    const text = canned && canned.text !== undefined ? canned.text : parsed !== null ? JSON.stringify(parsed) : "";
    const verdict = opts.isSuccess
      ? opts.isSuccess({ status, parsed, text })
      : { ok: status >= 200 && status < 300, detail: "" };
    return { ok: verdict.ok, status, parsed, text, detail: verdict.detail };
  };
  fn.calls = calls;
  return fn;
}

test("inventory: shape, matchesId, formatting, GET-only, auth headers", async () => {
  const http = makeHttp([
    { parsed: { location: { id: "LOC1", name: "Acme" } } }, // /locations/LOC1
    { parsed: { customValues: [{ name: "addr", id: "cv1" }] } },
    { parsed: { customFields: [{ name: "USDOT", id: "cf1" }, { name: "Lane", id: "cf2" }] } },
    { parsed: { tags: [{ name: "member", id: "t1" }] } },
    { parsed: { pipelines: [{ name: "ROK", id: "p1" }] } },
    { parsed: { workflows: [{ name: "Join", id: "w1" }] } },
  ]);
  const out = await inventory({ locationId: "LOC1", token: "test-token", http });

  assert.equal(out.locationId, "LOC1");
  assert.equal(out.location.matchesId, true);
  assert.equal(out.location.name, "Acme");
  assert.equal(out.customFields.count, 2);
  assert.deepEqual(out.customFields.items, ["USDOT  [cf1]", "Lane  [cf2]"]);
  assert.equal(out.tags.items[0], "member  [t1]");

  assert.ok(http.calls.every((c) => c.method === "GET"), "inventory must never mutate");
  assert.equal(http.calls[0].headers.Authorization, "Bearer test-token");
  assert.equal(http.calls[0].headers.Version, "2021-07-28");
});

test("inventory: a per-endpoint error is reported, not thrown", async () => {
  const http = makeHttp([
    { parsed: { location: { id: "LOC1", name: "Acme" } } },
    { status: 403, text: "forbidden" },
    { parsed: { customFields: [] } },
    { parsed: { tags: [] } },
    { parsed: { pipelines: [] } },
    { parsed: { workflows: [] } },
  ]);
  const out = await inventory({ locationId: "LOC1", token: "t", http });
  assert.equal(out.customValues.status, 403);
  assert.match(out.customValues.error, /forbidden/);
  assert.equal(out.customFields.count, 0);
});

test("upsertField: EXISTS is idempotent (contact.-strip) and issues NO POST", async () => {
  const http = makeHttp([
    { parsed: { customFields: [{ id: "F1", name: "Trucking USDOT", dataType: "TEXT", fieldKey: "contact.trucking_usdot" }] } },
  ]);
  const r = await upsertField({ locationId: "LOC1", token: "t", field: { name: "Trucking USDOT", dataType: "TEXT" }, http });
  assert.equal(r.status, "exists");
  assert.equal(r.id, "F1");
  assert.ok(http.calls.every((c) => c.method === "GET"), "an existing field must not be re-created");
  assert.equal(http.calls.filter((c) => c.method === "POST").length, 0);
});

test("upsertField: CREATED issues one POST and read-back confirms", async () => {
  const http = makeHttp([
    { parsed: { customFields: [] } }, // list: empty
    { parsed: { customField: { id: "NEW1", fieldKey: "contact.trucking_lane" } } }, // POST
    { parsed: { customFields: [{ id: "NEW1", name: "Trucking Lane", dataType: "TEXT", fieldKey: "contact.trucking_lane" }] } }, // read-back
  ]);
  const r = await upsertField({ locationId: "LOC1", token: "t", field: { name: "Trucking Lane", dataType: "TEXT" }, http });
  assert.equal(r.status, "created");
  assert.equal(r.id, "NEW1");
  assert.ok(r.readback && r.readback.id === "NEW1");
  const posts = http.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { name: "Trucking Lane", dataType: "TEXT" });
});

test("upsertField: offer-shaped names are refused before any network call", async () => {
  const http = makeHttp({ parsed: { customFields: [] } });
  await assert.rejects(
    () => upsertField({ locationId: "LOC1", token: "t", field: { name: "Funded Amount", dataType: "TEXT" }, http }),
    /offer-shaped/,
  );
  assert.equal(http.calls.length, 0, "no request may fire for a refused field");
});

test("upsertField: a caller guard runs before any network call", async () => {
  const http = makeHttp({ parsed: { customFields: [] } });
  const guard = (f) => {
    if (f.name.includes("Secret")) throw new Error("guard: blocked");
  };
  await assert.rejects(
    () => upsertField({ locationId: "LOC1", token: "t", field: { name: "Secret Field", dataType: "TEXT" }, guard, http }),
    /guard: blocked/,
  );
  assert.equal(http.calls.length, 0);
});

test("datasphere.campaignState: body-level rejection is a failure; api_key in the BODY, not headers", async () => {
  const reject = makeHttp({ parsed: { event: "Missing key state: running or paused or all." } });
  const bad = await campaignState({ token: "KEY123", state: "paused", http: reject });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /error|missing/i);
  // api_key travels in the body, never a header, and the method is POST.
  const call = reject.calls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.body.api_key, "KEY123");
  assert.equal(call.body.state, "paused");
  assert.equal(call.headers.Authorization, undefined);
});

test("datasphere.campaignState: a good campaigns array succeeds and is returned", async () => {
  const good = makeHttp({ parsed: [{ name: "Trucking Cold", list_name: "TRUCKING-COLD", state: "paused" }] });
  const r = await campaignState({ token: "KEY123", http: good });
  assert.equal(r.ok, true);
  assert.equal(r.campaigns.length, 1);
  assert.equal(r.campaigns[0].list_name, "TRUCKING-COLD");
});
