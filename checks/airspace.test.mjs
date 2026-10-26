/**
 * Airspace control: schema, overlap rules, the transactional registry, lease +
 * heartbeat, and the brief's Workstream 2 acceptance checks. Offline: the
 * registry runs on MemoryAirspaceBackend (Firestore's optimistic-concurrency
 * model) and on the REAL FirestoreAirspaceBackend over a fake Firestore that
 * enforces transaction rules (reads before writes, retry on a conflicting commit).
 *
 * Run with: node --test checks/airspace.test.mjs   (npm test builds dist/ first)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const DIST = new URL("../dist/", import.meta.url);
const A = await import(new URL("airspace.js", DIST).href);
const L = await import(new URL("airspace-launch.js", DIST).href);
const { validatePlan, PlanError } = await import(new URL("parser.js", DIST).href);
const { orchestrate } = await import(new URL("orchestrator.js", DIST).href);
const {
  AirspaceRegistry, MemoryAirspaceBackend, FirestoreAirspaceBackend,
  normalizeResource, resourcesOverlap, parseAirspaceBlock, claimResources, AirspaceError,
} = A;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = (runId, planName, lane, resources, extra = {}) => ({
  runId, planName, lane, resources: claimResources(planName, resources), ...extra,
});

/* ── Fake Firestore: just enough of the API, with real transaction rules ───── */
function fakeFirestore() {
  const store = new Map(); // "col/id" -> data
  let version = 0;
  const docRef = (col, id) => ({ kind: "doc", col, id, path: `${col}/${id}`,
    get: async () => snap(store.get(`${col}/${id}`)) });
  const snap = (d) => ({ exists: d !== undefined, data: () => (d === undefined ? undefined : structuredClone(d)) });
  const query = (col, filters = [], lim = Infinity) => ({
    kind: "query", col,
    where: (f, op, v) => query(col, [...filters, [f, v]], lim),
    limit: (n) => query(col, filters, n),
    get: async () => run(col, filters, lim),
  });
  const run = (col, filters, lim) => ({
    docs: [...store.entries()]
      .filter(([k]) => k.startsWith(col + "/"))
      .map(([, d]) => d)
      .filter((d) => filters.every(([f, v]) => d[f] === v))
      .slice(0, lim)
      .map((d) => ({ data: () => structuredClone(d) })),
  });
  return {
    store,
    collection: (col) => Object.assign(query(col), { doc: (id) => docRef(col, id) }),
    async runTransaction(fn) {
      for (let attempt = 0; attempt < 25; attempt++) {
        const start = version;
        const writes = [];
        let wrote = false;
        const t = {
          async get(ref) {
            if (wrote) throw new Error("Firestore transactions require all reads to be executed before all writes.");
            await new Promise((r) => setImmediate(r));
            return ref.kind === "doc" ? snap(store.get(ref.path)) : ref.get();
          },
          set(ref, data) { wrote = true; writes.push([ref.path, structuredClone(data)]); },
        };
        const out = await fn(t);
        await new Promise((r) => setImmediate(r));
        if (version !== start) continue;
        for (const [p, d] of writes) store.set(p, d);
        version++;
        return out;
      }
      throw new Error("contention");
    },
  };
}

/* ── Schema ────────────────────────────────────────────────────────────────── */

test("normalizeResource: paths, repos, and typed keys", () => {
  assert.equal(normalizeResource("path:Portfolios\\Own-Products\\FIG\\"), "path:portfolios/own-products/fig");
  assert.equal(normalizeResource("path:./a//b/"), "path:a/b");
  assert.equal(normalizeResource("repo:https://github.com/DigitalSolomon-ops/The-Creator.git"), "repo:digitalsolomon-ops/the-creator");
  assert.equal(normalizeResource("repo:ds-build-agent"), "repo:digitalsolomon-ops/ds-build-agent");
  assert.equal(normalizeResource("ghl_pipeline:  Partner   Sales "), "ghl_pipeline:Partner Sales");
  assert.equal(normalizeResource("N8N_Workflow:lead-router"), "n8n_workflow:lead-router");
  for (const bad of ["nocolon", "path:C:/x", "path:/abs", "path:a/../b", "path:a/*", "path:", ":x", "9x:y"]) {
    assert.throws(() => normalizeResource(bad), AirspaceError, bad);
  }
});

test("resourcesOverlap: folder prefixes on segment boundaries; same type only", () => {
  assert.ok(resourcesOverlap("path:a/b", "path:a/b/c"));
  assert.ok(resourcesOverlap("path:a/b/c", "path:a/b"));
  assert.ok(resourcesOverlap("path:a/b", "path:a/b"));
  assert.ok(!resourcesOverlap("path:a/b", "path:a/bc"));
  assert.ok(resourcesOverlap("ghl_pipeline:Partner Sales", "ghl_pipeline:partner sales"));
  assert.ok(!resourcesOverlap("ghl_location:AbC", "ghl_location:abc"), "location ids are opaque, case-sensitive");
  assert.ok(!resourcesOverlap("repo:x/y", "path:x/y"));
});

test("parseAirspaceBlock: map form, list form, sorted + de-duplicated", () => {
  const out = parseAirspaceBlock({
    repos: ["DigitalSolomon-ops/fast-insurance-group"],
    paths: "portfolios/own-products/fast-insurance-group/build",
    ghl_locations: ["OwTVypw5mcI0oznL5Bgd"],
    ghl_pipelines: ["Partner Sales", "ghl_pipeline:Partner Sales"],
    other: ["n8n_workflow:lead-router"],
  });
  assert.deepEqual(out, [
    "ghl_location:OwTVypw5mcI0oznL5Bgd",
    "ghl_pipeline:Partner Sales",
    "n8n_workflow:lead-router",
    "path:portfolios/own-products/fast-insurance-group/build",
    "repo:digitalsolomon-ops/fast-insurance-group",
  ]);
  assert.deepEqual(parseAirspaceBlock(["path:a", "repo:b"]), ["path:a", "repo:digitalsolomon-ops/b"]);
});

test("parseAirspaceBlock: missing, empty, unknown key and untyped list entries all fail", () => {
  assert.throws(() => parseAirspaceBlock(undefined), /no `airspace` block/);
  assert.throws(() => parseAirspaceBlock({}), /declares no resources/);
  assert.throws(() => parseAirspaceBlock([]), /declares no resources/);
  assert.throws(() => parseAirspaceBlock({ path: ["a"] }), /`path` is not recognized/);
  assert.throws(() => parseAirspaceBlock(["just-a-folder"]), /has no type/);
  assert.throws(() => parseAirspaceBlock("path:a"), /must be a map/);
});

test("validator: a plan with no airspace block fails validation (and says how to fix it)", () => {
  const base = { name: "p", tasks: [{ id: "a", prompt: "x" }] };
  assert.throws(() => validatePlan(base, { quiet: true }), (e) =>
    e instanceof PlanError && /no `airspace` block/.test(e.message) && /airspace:/.test(e.message));
  assert.throws(() => validatePlan({ project: { name: "p", airspace: ["path:a"] }, tasks: base.tasks }, { quiet: true }),
    /move it to the top level/);
  const ok = validatePlan({ ...base, airspace: { paths: ["x/y"] } }, { quiet: true });
  assert.deepEqual(ok.airspace, ["path:x/y"]);
  assert.deepEqual(claimResources(ok.name, ok.airspace), ["path:x/y", "plan:p"]);
});

test("no override exists: the registry and launcher expose no force/override/skip option", () => {
  for (const f of ["../src/airspace.ts", "../src/airspace-launch.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8")
      .split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n"); // code, not comments
    assert.doesNotMatch(src, /\b(force|override|skipAirspace|bypass|ignoreConflicts)\b/i, f);
  }
});

/* ── Workstream 2 acceptance ───────────────────────────────────────────────── */

for (const [label, makeBackend] of [
  ["memory", () => new MemoryAirspaceBackend()],
  ["firestore-adapter", () => new FirestoreAirspaceBackend(fakeFirestore())],
]) {
  test(`[${label}] ACCEPT 1: two simultaneous overlapping launches -> exactly one wins, the other is held and names the conflict`, async () => {
    const reg = new AirspaceRegistry(makeBackend());
    const [a, b] = await Promise.all([
      reg.acquire(req("run-a", "fast-insurance-group", "local", ["ghl_pipeline:Partner Sales", "path:p/fig"])),
      reg.acquire(req("run-b", "partner-sales-refresh", "cloud", ["ghl_pipeline:Partner Sales"])),
    ]);
    if ("retries" in reg.backend) assert.ok(reg.backend.retries >= 1, "the two transactions really raced (one re-ran)");
    const wins = [a, b].filter((r) => r.granted);
    const held = [a, b].filter((r) => !r.granted);
    assert.equal(wins.length, 1, "exactly one launch is granted");
    assert.equal(held.length, 1, "the other is held");
    const winner = wins[0].claim.plan_name;
    assert.match(held[0].message, new RegExp(`^held: conflicts with ${winner} on ghl_pipeline:Partner Sales`));
    assert.equal(held[0].conflicts[0].holder_run_id, wins[0].claim.run_id);
    const listed = await reg.listHeld();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].message, held[0].message);
  });

  test(`[${label}] ACCEPT 1b: ten racing launches on one folder -> exactly one claim`, async () => {
    const reg = new AirspaceRegistry(makeBackend());
    const rs = await Promise.all(
      Array.from({ length: 10 }, (_, i) => reg.acquire(req(`r${i}`, `plan-${i}`, i % 2 ? "cloud" : "local", [`path:shared/folder/sub${i}`, "path:shared/folder"]))),
    );
    assert.equal(rs.filter((r) => r.granted).length, 1);
    assert.equal((await reg.listActive()).length, 1);
  });

  test(`[${label}] ACCEPT 2: a local run blocks a cloud launch on the same resource, and the reverse`, async () => {
    const reg = new AirspaceRegistry(makeBackend());
    assert.ok((await reg.acquire(req("loc-1", "fig-local", "local", ["repo:fast-insurance-group"]))).granted);
    const c = await reg.acquire(req("cld-1", "fig-cloud", "cloud", ["repo:DigitalSolomon-ops/fast-insurance-group"]));
    assert.equal(c.granted, false);
    assert.match(c.message, /held: conflicts with fig-local on repo:digitalsolomon-ops\/fast-insurance-group \[run loc-1, local lane\]/);
    await reg.release("loc-1");

    assert.ok((await reg.acquire(req("cld-2", "fig-cloud", "cloud", ["path:portfolios/own-products/fig"]))).granted);
    const l = await reg.acquire(req("loc-2", "fig-local", "local", ["path:portfolios/own-products/fig/build"]));
    assert.equal(l.granted, false);
    assert.match(l.message, /conflicts with fig-cloud on path:portfolios\/own-products\/fig \[run cld-2, cloud lane\]/);
  });

  test(`[${label}] ACCEPT 3: a killed run's claims expire after the lease and a new launch succeeds`, async () => {
    let now = 1_000_000;
    const reg = new AirspaceRegistry(makeBackend(), () => now);
    assert.ok((await reg.acquire(req("dead", "crashy", "local", ["path:x"], { leaseMs: 60_000 }))).granted);
    // The process is killed: no heartbeat, no release.
    now += 59_000;
    assert.equal((await reg.acquire(req("next-1", "next", "cloud", ["path:x/y"]))).granted, false, "still inside the lease");
    now += 2_000;
    const r = await reg.acquire(req("next-2", "next", "cloud", ["path:x/y"]));
    assert.ok(r.granted, "lease expired -> claim is free");
    const dead = (await reg.backend.listClaims()).find((c) => c.run_id === "dead");
    assert.equal(dead.status, "expired");
    const lost = await reg.renew("dead");
    assert.equal(lost.ok, false, "the dead run cannot revive a claim someone else now holds");
  });

  test(`[${label}] ACCEPT 4: non-overlapping runs launch side by side with no delay`, async () => {
    const reg = new AirspaceRegistry(makeBackend());
    const t0 = Date.now();
    const rs = await Promise.all([
      reg.acquire(req("s1", "fig", "local", ["path:portfolios/own-products/fig", "ghl_location:Loc1"])),
      reg.acquire(req("s2", "renuity", "cloud", ["path:portfolios/client-work/renuity", "ghl_location:Loc2"])),
      reg.acquire(req("s3", "creator", "local", ["repo:the-creator", "path:portfolios/own-products/figgy"])),
    ]);
    assert.ok(rs.every((r) => r.granted), JSON.stringify(rs.filter((r) => !r.granted)));
    assert.ok(Date.now() - t0 < 1000, "granted immediately, no waiting on each other");
    assert.equal((await reg.listActive()).length, 3);
  });

  test(`[${label}] adopt, renew, release; held launches resolve once granted`, async () => {
    let now = 5_000_000;
    const reg = new AirspaceRegistry(makeBackend(), () => now);
    // The cockpit acquires at Launch; the runner starts with the same run id and adopts.
    const first = await reg.acquire(req("run-x", "fig", "cloud", ["path:f"]));
    now += 10_000;
    const adopt = await reg.acquire(req("run-x", "fig", "cloud", ["path:f"]));
    assert.ok(adopt.granted && adopt.adopted);
    assert.equal(adopt.claim.acquired_at, first.claim.acquired_at);
    const held = await reg.acquire(req("run-y", "fig2", "local", ["path:f/sub"]));
    assert.equal(held.granted, false);
    assert.equal((await reg.listHeld()).length, 1);
    now += 10_000;
    const renewed = await reg.renew("run-x", 60_000);
    assert.ok(renewed.ok && renewed.claim.lease_expires_at === now + 60_000);
    assert.equal(await reg.release("run-x"), true);
    assert.equal(await reg.release("run-x"), false, "release is idempotent");
    assert.equal((await reg.renew("run-x")).ok, false, "a released claim cannot be renewed");
    const retry = await reg.acquire(req("run-z", "fig2", "local", ["path:f/sub"]));
    assert.ok(retry.granted);
    assert.equal((await reg.listHeld()).length, 0, "the plan's earlier hold is resolved");
  });
}

test("firestore adapter: stores real timestamps and serializes on airspaceRegistry/head", async () => {
  const fs = fakeFirestore();
  const reg = new AirspaceRegistry(new FirestoreAirspaceBackend(fs));
  await reg.acquire(req("r1", "p", "local", ["path:a"]));
  const doc = fs.store.get("airspaceClaims/r1");
  for (const f of ["acquired_at", "heartbeat_at", "lease_expires_at"]) assert.ok(doc[f] instanceof Date, f);
  assert.deepEqual(Object.keys(doc).sort(), [
    "acquired_at", "heartbeat_at", "lane", "lease_expires_at", "plan_name", "resources", "run_id", "status",
  ]);
  assert.equal(fs.store.get("airspaceRegistry/head").version, 1);
  const [c] = await reg.listActive();
  assert.equal(typeof c.lease_expires_at, "number");
});

/* ── Heartbeat + launcher ──────────────────────────────────────────────────── */

test("heartbeat keeps a live run's claim past its lease; killing it frees the claim after the lease", async () => {
  const reg = new AirspaceRegistry(new MemoryAirspaceBackend());
  const plan = { name: "beat", airspace: ["path:hb"] };
  const c = await L.claimAirspaceForRun({ registry: reg, plan, runId: "hb-1", lane: "local", leaseMs: 150, heartbeatMs: 40 });
  assert.ok(c.granted);
  await sleep(400); // well past one lease: the heartbeat must have renewed it
  assert.equal((await reg.acquire(req("hb-2", "other", "cloud", ["path:hb"]))).granted, false, "heartbeat held the claim");
  await c.release();
  assert.ok((await reg.acquire(req("hb-3", "other", "cloud", ["path:hb"]))).granted, "release frees immediately");
  await reg.release("hb-3");

  // A killed run: heartbeat stops, nothing releases.
  const reg2 = new AirspaceRegistry(new MemoryAirspaceBackend());
  const k = await L.claimAirspaceForRun({ registry: reg2, plan, runId: "k-1", lane: "local", leaseMs: 150, heartbeatMs: 40 });
  assert.ok(k.granted);
  const backendRenew = reg2.renew.bind(reg2);
  reg2.renew = async () => { throw new Error("process killed"); }; // the heartbeat can no longer reach the registry
  assert.equal((await reg2.acquire(req("k-2", "next", "cloud", ["path:hb"]))).granted, false);
  await sleep(220);
  assert.ok((await reg2.acquire(req("k-3", "next", "cloud", ["path:hb"]))).granted, "expired lease -> new launch succeeds");
  reg2.renew = backendRenew;
  await k.release();
});

test("losing the airspace halts dispatch: orchestrate skips everything not yet started", async () => {
  let now = 0;
  const reg = new AirspaceRegistry(new MemoryAirspaceBackend(), () => now);
  const lost = [];
  const c = await L.claimAirspaceForRun({
    registry: reg, plan: { name: "lose", airspace: ["path:l"] }, runId: "l-1", lane: "cloud",
    leaseMs: 100, heartbeatMs: 20, log: (_l, m) => lost.push(m),
  });
  now += 500; // lease lapses (e.g. a long network partition) ...
  assert.ok((await reg.acquire(req("l-2", "taker", "local", ["path:l"]))).granted); // ... and another run takes it
  await sleep(80);
  assert.match(c.halt() ?? "", /Airspace lost/);
  assert.equal(lost.length, 1);
  const plan = validatePlan({ name: "lose", airspace: ["path:l"], tasks: [{ id: "a", prompt: "x" }, { id: "b", prompt: "y", deps: ["a"] }] }, { quiet: true });
  const results = await orchestrate(plan, { repoPath: ".", concurrency: 2, dryRun: true, halt: c.halt });
  assert.ok(results.every((r) => r.status === "skipped" && /Airspace lost/.test(r.error)));
  await c.release();
});

test("an unreachable registry throws (callers fail closed and do not launch)", async () => {
  const broken = { transact: async () => { throw new Error("PERMISSION_DENIED"); }, listClaims: async () => [], listHeld: async () => [] };
  await assert.rejects(
    L.claimAirspaceForRun({ registry: new AirspaceRegistry(broken), plan: { name: "p", airspace: ["path:a"] }, runId: "r", lane: "local" }),
    /PERMISSION_DENIED/,
  );
});

test("parity: the-creator's mirrored airspace.ts is byte-identical (when the sibling repo is present)", (t) => {
  const mine = readFileSync(new URL("../src/airspace.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  let theirs;
  try {
    theirs = readFileSync(new URL("../../the-creator/packages/shared/src/airspace.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  } catch {
    return t.skip("the-creator is not checked out beside ds-build-agent");
  }
  assert.equal(theirs, mine, "copy src/airspace.ts to the-creator/packages/shared/src/airspace.ts");
});
