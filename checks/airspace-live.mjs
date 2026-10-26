/**
 * LIVE airspace acceptance against real Firestore — run by the operator after
 * phase 7 (IAM in place), never by CI. Uses SCRATCH collections
 * (airspaceTest_*), so production claims are never read or written, and deletes
 * nothing: each run uses fresh run ids, and its claims end released or expired.
 *
 *   npm run build
 *   node checks/airspace-live.mjs            # uses ADC; GCP_PROJECT_ID defaults to digitalsolomon-creator
 *
 * Exits 0 when all four Workstream 2 acceptance checks pass against Firestore.
 */
import assert from "node:assert/strict";
import { Firestore } from "@google-cloud/firestore";

const A = await import(new URL("../dist/airspace.js", import.meta.url).href);
const db = new Firestore({ projectId: process.env.GCP_PROJECT_ID ?? "digitalsolomon-creator", ignoreUndefinedProperties: true });
const backend = new A.FirestoreAirspaceBackend(db, {
  claimsCollection: "airspaceTest_claims",
  heldCollection: "airspaceTest_held",
  registryCollection: "airspaceTest_registry",
});
const tag = Date.now().toString(36);
const reg = new A.AirspaceRegistry(backend);
const req = (id, plan, lane, res, leaseMs) => ({
  runId: `${id}-${tag}`, planName: `${plan}-${tag}`, lane, resources: A.claimResources(`${plan}-${tag}`, res), leaseMs,
});
const r = (k) => `${k}-${tag}`;
const ok = (name) => console.log(`✓ ${name}`);

// 1. simultaneous overlapping launches: exactly one wins, the other is held naming the conflict.
const [a, b] = await Promise.all([
  reg.acquire(req("a", "fig", "local", [`ghl_pipeline:${r("Partner Sales")}`])),
  reg.acquire(req("b", "refresh", "cloud", [`ghl_pipeline:${r("Partner Sales")}`])),
]);
assert.equal([a, b].filter((x) => x.granted).length, 1);
const held = [a, b].find((x) => !x.granted);
assert.match(held.message, /^held: conflicts with .+ on ghl_pipeline:Partner Sales-/);
ok(`simultaneous overlap -> one wins; ${held.message}`);
for (const x of [a, b]) if (x.granted) await reg.release(x.claim.run_id);

// 2. local blocks cloud, and the reverse.
assert.ok((await reg.acquire(req("l1", "loc", "local", [`path:${r("p")}`]))).granted);
assert.equal((await reg.acquire(req("c1", "cld", "cloud", [`path:${r("p")}/sub`]))).granted, false);
await reg.release(r("l1"));
assert.ok((await reg.acquire(req("c2", "cld", "cloud", [`path:${r("q")}`]))).granted);
assert.equal((await reg.acquire(req("l2", "loc", "local", [`path:${r("q")}`]))).granted, false);
await reg.release(r("c2"));
ok("local blocks cloud and cloud blocks local");

// 3. a killed run's claim expires after its lease and a new launch succeeds.
assert.ok((await reg.acquire(req("dead", "crash", "local", [`path:${r("k")}`], 3000))).granted);
assert.equal((await reg.acquire(req("n1", "next", "cloud", [`path:${r("k")}`]))).granted, false);
await new Promise((res) => setTimeout(res, 3500));
const next = await reg.acquire(req("n2", "next", "cloud", [`path:${r("k")}`]));
assert.ok(next.granted);
await reg.release(r("n2"));
ok("killed run's lease expired; the next launch was granted");

// 4. non-overlapping runs side by side.
const t0 = Date.now();
const side = await Promise.all([1, 2, 3].map((i) => reg.acquire(req(`s${i}`, `side${i}`, i % 2 ? "local" : "cloud", [`path:${r(`own${i}`)}`]))));
assert.ok(side.every((x) => x.granted));
for (const x of side) await reg.release(x.claim.run_id);
ok(`three non-overlapping launches granted together in ${Date.now() - t0} ms`);

console.log("\nAll live airspace acceptance checks passed (scratch collections airspaceTest_*).");
process.exit(0);
