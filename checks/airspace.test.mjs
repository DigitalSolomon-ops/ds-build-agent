/**
 * Airspace control: schema, overlap rules, the transactional registry, time,
 * lease + heartbeat + fence, adoption, and the real entry points (index.ts and
 * cloud-job.ts main()) run in-process with an injected registry and a fake task
 * runner — no agent, no SDK, no subprocess of the harness.
 *
 * Offline: the registry runs on MemoryAirspaceBackend (Firestore's optimistic-
 * concurrency model) and on the REAL FirestoreAirspaceBackend over a fake
 * Firestore that enforces transaction rules. checks/fixtures/airspace-cases.json
 * is shared with handoff-watcher's Python port.
 *
 * Cross-repo checks (mirror parity, the no-override grep over all three repos)
 * read DS_BUILD_REPO / CREATOR_REPO / WATCHER_REPO; with AIRSPACE_CROSS_REPO=1 a
 * missing sibling FAILS, otherwise those checks skip with a reason.
 *
 * Run with: node --test checks/airspace.test.mjs   (npm test builds dist/ first)
 *
 * Brief item -> test name (HANDOFF-solomon-airspace-r2.md, Phase 1):
 *   1 registry   registry: foreign id refuses | registry: empty db stamps id | registry: env vars ignored
 *   2 time       time: idle registry grants after lease | time: poisoned head fails closed | time: slow round-trip discarded
 *   3 adoption   adopt: foreign run_id held | adopt: second adoption held | adopt: mismatched plan/resources held |
 *                adopt: released/expired claim not adopted | cli: --run-id rejected
 *   4 fence      fence: first renew never resolves | fence: renew throws | fence: renew reports lost |
 *                fence: renew never resolves | fence: expired not revived
 *   5 loss       loss: in-flight task aborted, HEAD unchanged, exit 4 | commit: fence passed refuses commit
 *   6 path/repo  overlap: path vs derived repo | cloud: no GitHub token in agent env | validator: shallow path refused
 *                (sync: derived repo written into synced plan — checks/sync.test.mjs)
 *   7 target     target: inside root unclaimed | target: outside root undeclared | target: path:abs ok
 *   8 normalize  fixture: normalize / overlap / path_key / block cases
 *   9 lease      lease: out-of-bounds refused
 *  10 ghl        validator: ghl task without location
 *  11 dry run    dry-run: zero lifecycle writes
 *  12 shutdown   exit: grandchild gone before release
 *  13 entry      entry: backend not selectable
 *  14 atomicity  acquire: partial conflict writes nothing | release: normal exit releases | release: failed run releases
 *  16 override   no override: identifiers outside comments
 *  17 sync       sync: no Architect call (checks/sync.test.mjs)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const DIST = new URL("../dist/", import.meta.url);
const A = await import(new URL("airspace.js", DIST).href);
const L = await import(new URL("airspace-launch.js", DIST).href);
const CLI = await import(new URL("index.js", DIST).href);
const CLOUD = await import(new URL("cloud-job.js", DIST).href);
const P = await import(new URL("proc-tree.js", DIST).href);
const { validatePlan, PlanError } = await import(new URL("parser.js", DIST).href);
const { orchestrate } = await import(new URL("orchestrator.js", DIST).href);
const {
  AirspaceRegistry, MemoryAirspaceBackend, FirestoreAirspaceBackend, AnchoredClock, REGISTRY,
  normalizeResource, resourcesOverlap, parseAirspaceBlock, claimResources, pathKeyFor, AirspaceError, AirspaceRefused,
  startHeartbeat,
} = A;

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/airspace-cases.json", import.meta.url), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mono = () => performance.now();
const req = (runId, planName, lane, resources, extra = {}) => ({
  runId, planName, lane, resources: claimResources(planName, resources), ...extra,
});
const CROSS = process.env.AIRSPACE_CROSS_REPO === "1";

/* ── Fake Firestore: just enough of the API, with real transaction rules ───── */
const SERVER_TS = { __serverTimestamp: true };
function fakeFirestore(serverNow = Date.now) {
  const store = new Map(); // "col/id" -> data
  let version = 0;
  const resolveTs = (d) => {
    const o = {};
    for (const [k, v] of Object.entries(d)) o[k] = v && typeof v === "object" && v.__serverTimestamp ? new Date(serverNow()) : v;
    return o;
  };
  const snap = (d) => ({ exists: d !== undefined, data: () => (d === undefined ? undefined : structuredClone(d)) });
  const docRef = (col, id) => ({
    kind: "doc", col, id, path: `${col}/${id}`,
    get: async () => snap(store.get(`${col}/${id}`)),
    set: async (data) => {
      store.set(`${col}/${id}`, resolveTs(data));
      version++;
      return { writeTime: { toMillis: () => serverNow() } };
    },
  });
  const query = (col, filters = [], lim = Infinity) => ({
    kind: "query", col,
    where: (f, op, v) => query(col, [...filters, [f, v]], lim),
    limit: (n) => query(col, filters, n),
    get: async () => run(col, filters, lim),
  });
  const run = (col, filters, lim) => ({
    docs: [...store.entries()]
      .filter(([k]) => k.startsWith(col + "/") && !k.slice(col.length + 1).includes("/"))
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
        for (const [p, d] of writes) store.set(p, resolveTs(d));
        version++;
        return out;
      }
      throw new Error("contention");
    },
  };
}
const fsBackend = (db) => new FirestoreAirspaceBackend(db, { serverTimestamp: () => SERVER_TS });

/* ── Shared fixture (also run by handoff-watcher's Python port) ────────────── */

test("fixture: normalize cases", () => {
  for (const c of FIXTURE.normalize) {
    if (c.error) assert.throws(() => normalizeResource(c.in), AirspaceError, c.in);
    else assert.equal(normalizeResource(c.in), c.out, c.in);
  }
});

test("fixture: overlap cases", () => {
  for (const c of FIXTURE.overlap) assert.equal(resourcesOverlap(c.a, c.b), c.overlap, `${c.a} ~ ${c.b}`);
});

test("fixture: path_key cases", () => {
  for (const c of FIXTURE.path_key) assert.equal(pathKeyFor(c.abs, c.root), c.out, c.abs);
});

test("fixture: block cases", () => {
  for (const c of FIXTURE.block) {
    if (c.error) assert.throws(() => parseAirspaceBlock(c.in), AirspaceError, JSON.stringify(c.in));
    else assert.deepEqual(parseAirspaceBlock(c.in), c.out);
  }
});

for (const sc of FIXTURE.registry) {
  test(`fixture: ${sc.name}`, async () => {
    const backend = new MemoryAirspaceBackend();
    backend.head = structuredClone(sc.head);
    for (const c of sc.claims) backend.claims.set(c.run_id, structuredClone(c));
    const reg = new AirspaceRegistry(backend, () => sc.now);
    const a = sc.acquire;
    const run = reg.acquire({ runId: a.run_id, planName: a.plan_name, lane: a.lane, resources: a.resources });
    if (sc.expect === "refused") {
      await assert.rejects(run, (e) => e instanceof AirspaceRefused && e.message.includes(sc.refused_contains));
      return;
    }
    const r = await run;
    assert.equal(r.granted, sc.expect === "granted", JSON.stringify(r));
    if (sc.held_message_prefix) assert.ok(r.message.startsWith(sc.held_message_prefix), r.message);
    if (sc.adopted !== undefined) assert.equal(r.adopted, sc.adopted);
    if (sc.head_after_registry_id) assert.equal(backend.head.registry_id, sc.head_after_registry_id);
    if (sc.claim_written === false) {
      const mine = backend.claims.get(a.run_id);
      assert.equal(mine, undefined, "no claim doc written for a held acquire");
    }
  });
}

for (const sc of FIXTURE.clock) {
  test(`fixture: ${sc.name}`, async () => {
    let m = 1_000;
    let i = 0;
    const clock = new AnchoredClock(async () => {
      const k = i++;
      m += sc.rtts[k];
      return sc.server[k];
    }, () => m, () => 0);
    if (sc.expect === "refused") {
      await assert.rejects(clock.measure(), (e) => e instanceof AirspaceRefused && /clock skew/.test(e.message));
      return;
    }
    await clock.measure();
    // m is now at the end of the accepted round-trip: half of it past the midpoint.
    const lastRtt = sc.rtts[i - 1];
    assert.equal(clock.now(), sc.expect_now_at_mono_mid + lastRtt / 2);
  });
}

test("time: slow round-trip discarded", async () => {
  let m = 0;
  const rtts = [6_000, 50];
  let i = 0;
  const clock = new AnchoredClock(async () => { m += rtts[i]; return [1, 777_000][i++]; }, () => m, () => 0);
  await clock.measure();
  assert.equal(i, 2, "the slow measurement was retried");
  assert.equal(clock.now(), 777_000 + 25);
});

test("time: idle registry grants after lease (anchored clock, no writes in between)", async () => {
  let server = 1_000_000;
  let m = 0;
  const backend = new MemoryAirspaceBackend(() => server);
  const reg = new AirspaceRegistry(backend, new AnchoredClock(() => backend.serverTime(), () => m, () => m));
  assert.ok((await reg.acquire(req("dead", "crashy", "local", ["path:a/b"], { leaseMs: 60_000 }))).granted);
  // Crash, then an hour of silence: no transaction touches the registry.
  server += 3_600_000;
  m += 3_600_000;
  const r = await reg.acquire(req("next", "next", "cloud", ["path:a/b"]));
  assert.ok(r.granted, "an idle hour does not make a dead claim look live");
});

test("time: poisoned head fails closed (no write)", async () => {
  const backend = new MemoryAirspaceBackend();
  backend.head = { registry_id: REGISTRY.id, updated_at: 9_999_999_999 };
  const reg = new AirspaceRegistry(backend, () => 1_000);
  await assert.rejects(reg.acquire(req("x", "p", "local", ["path:a/b"])), /registry clock ahead/);
  assert.equal(backend.commits, 0, "nothing was written");
});

/* ── Registry identity ─────────────────────────────────────────────────────── */

test("registry: foreign id refuses", async () => {
  const backend = new MemoryAirspaceBackend();
  backend.head = { registry_id: "someone-else/v9" };
  await assert.rejects(new AirspaceRegistry(backend, () => 1).acquire(req("x", "p", "local", ["path:a/b"])), AirspaceRefused);
});

test("registry: empty db stamps id", async () => {
  const db = fakeFirestore();
  const reg = new AirspaceRegistry(fsBackend(db), () => Date.now());
  await reg.acquire(req("r1", "p", "local", ["path:a/b"]));
  assert.equal(db.store.get("airspaceRegistry/head").registry_id, REGISTRY.id);
  assert.ok(db.store.get("airspaceRegistry/head").updated_at instanceof Date, "audit stamp is the server's commit time");
});

test("registry: env vars ignored", () => {
  const saved = { db: process.env.AIRSPACE_DATABASE, proj: process.env.GCP_PROJECT_ID };
  process.env.AIRSPACE_DATABASE = "(default)";
  process.env.GCP_PROJECT_ID = "some-other-project";
  try {
    assert.deepEqual(L.registryTarget(), { project: REGISTRY.project, database: REGISTRY.database });
    assert.deepEqual([REGISTRY.project, REGISTRY.database], ["digitalsolomon-creator", "local-builds"]);
  } finally {
    if (saved.db === undefined) delete process.env.AIRSPACE_DATABASE; else process.env.AIRSPACE_DATABASE = saved.db;
    if (saved.proj === undefined) delete process.env.GCP_PROJECT_ID; else process.env.GCP_PROJECT_ID = saved.proj;
  }
  const src = readFileSync(new URL("../src/airspace-launch.ts", import.meta.url), "utf8");
  const envReads = [...src.matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(envReads)].sort(), ["AIRSPACE_HEARTBEAT_MS", "AIRSPACE_LEASE_MS"],
    "the launcher reads only lease tuning from the environment");
});

test("registry: a test registry must use the airspaceTest_ prefix", () => {
  assert.throws(() => L.openAirspaceTestRegistry("prod_"), AirspaceRefused);
});

/* ── Schema and validator ──────────────────────────────────────────────────── */

test("parseAirspaceBlock: map form, list form, sorted + de-duplicated", () => {
  const out = parseAirspaceBlock({
    repos: ["DigitalSolomon-ops/fast-insurance-group"],
    paths: "portfolios/own-products/fast-insurance-group/build",
    ghl_locations: ["OwTVypw5mcI0oznL5Bgd"],
    ghl_pipelines: ["OwTVypw5mcI0oznL5Bgd/pipe1", "ghl_pipeline:OwTVypw5mcI0oznL5Bgd/pipe1"],
    other: ["n8n_workflow:lead-router"],
  });
  assert.deepEqual(out, [
    "ghl_location:OwTVypw5mcI0oznL5Bgd",
    "ghl_pipeline:OwTVypw5mcI0oznL5Bgd/pipe1",
    "n8n_workflow:lead-router",
    "path:portfolios/own-products/fast-insurance-group/build",
    "repo:digitalsolomon-ops/fast-insurance-group",
  ]);
});

test("parseAirspaceBlock: missing, empty, unknown key and untyped list entries all fail", () => {
  assert.throws(() => parseAirspaceBlock(undefined), /no `airspace` block/);
  assert.throws(() => parseAirspaceBlock({}), /declares no resources/);
  assert.throws(() => parseAirspaceBlock([]), /declares no resources/);
  assert.throws(() => parseAirspaceBlock({ path: ["a/b"] }), /`path` is not recognized/);
  assert.throws(() => parseAirspaceBlock(["just-a-folder"]), /has no type/);
  assert.throws(() => parseAirspaceBlock("path:a/b"), /must be a map/);
});

test("validator: shallow path refused", () => {
  assert.throws(() => parseAirspaceBlock({ paths: ["portfolios"] }), /too broad/);
  assert.throws(
    () => validatePlan({ name: "p", airspace: ["path:portfolios"], tasks: [{ id: "a", prompt: "x" }] }, { quiet: true }),
    (e) => e instanceof PlanError && /too broad/.test(e.message),
  );
});

test("validator: a plan with no airspace block fails validation (and says how to fix it)", () => {
  const base = { name: "p", tasks: [{ id: "a", prompt: "x" }] };
  assert.throws(() => validatePlan(base, { quiet: true }), (e) =>
    e instanceof PlanError && /no `airspace` block/.test(e.message) && /airspace:/.test(e.message));
  assert.throws(() => validatePlan({ project: { name: "p", airspace: ["path:a/b"] }, tasks: base.tasks }, { quiet: true }),
    /move it to the top level/);
  const ok = validatePlan({ ...base, airspace: { paths: ["x/y"] } }, { quiet: true });
  assert.deepEqual(ok.airspace, ["path:x/y"]);
  assert.deepEqual(claimResources(ok.name, ok.airspace), ["path:x/y", "plan:p"]);
});

test("validator: ghl task without location", () => {
  const tasks = [{ id: "g", executor: "ghl", prompt: "set up the pipeline" }];
  assert.throws(() => validatePlan({ name: "p", airspace: ["path:a/b"], tasks }, { quiet: true }),
    (e) => e instanceof PlanError && /ghl_location/.test(e.message));
  const ok = validatePlan({ name: "p", airspace: { paths: ["a/b"], ghl_locations: ["Loc1"] }, tasks }, { quiet: true });
  assert.ok(ok.airspace.includes("ghl_location:Loc1"));
});

/* ── Workstream 2 acceptance on both backends ──────────────────────────────── */

for (const [label, makeBackend] of [
  ["memory", (serverNow) => new MemoryAirspaceBackend(serverNow)],
  ["firestore-adapter", (serverNow) => fsBackend(fakeFirestore(serverNow ?? Date.now))],
]) {
  test(`[${label}] two simultaneous overlapping launches -> at most one wins, the other is held and names the conflict`, async () => {
    const reg = new AirspaceRegistry(makeBackend());
    const [a, b] = await Promise.all([
      reg.acquire(req("run-a", "fast-insurance-group", "local", ["ghl_pipeline:Loc1/PartnerSales", "path:p/fig"])),
      reg.acquire(req("run-b", "partner-sales-refresh", "cloud", ["ghl_pipeline:Loc1/PartnerSales"])),
    ]);
    if ("retries" in reg.backend) assert.ok(reg.backend.retries >= 1, "the two transactions really raced (one re-ran)");
    const wins = [a, b].filter((r) => r.granted);
    const held = [a, b].filter((r) => !r.granted);
    assert.equal(wins.length, 1, "exactly one launch is granted");
    assert.equal(held.length, 1, "the other is held");
    const winner = wins[0].claim.plan_name;
    assert.match(held[0].message, new RegExp(`^held: conflicts with ${winner} on ghl_pipeline:Loc1/PartnerSales`));
    assert.equal(held[0].conflicts[0].holder_run_id, wins[0].claim.run_id);
    const listed = await reg.listHeld();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].message, held[0].message);
  });

  test(`[${label}] ten racing launches on one folder -> exactly one claim`, async () => {
    const reg = new AirspaceRegistry(makeBackend());
    const rs = await Promise.all(
      Array.from({ length: 10 }, (_, i) => reg.acquire(req(`r${i}`, `plan-${i}`, i % 2 ? "cloud" : "local", [`path:shared/folder/sub${i}`, "path:shared/folder"]))),
    );
    assert.equal(rs.filter((r) => r.granted).length, 1);
    assert.equal((await reg.listActive()).length, 1);
  });

  test(`[${label}] a local run blocks a cloud launch on the same resource, and the reverse`, async () => {
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

  test(`[${label}] a killed run's claims expire after the lease and a new launch succeeds`, async () => {
    let now = 1_000_000;
    const reg = new AirspaceRegistry(makeBackend(() => now), () => now);
    assert.ok((await reg.acquire(req("dead", "crashy", "local", ["path:x/y"], { leaseMs: 60_000 }))).granted);
    now += 59_000;
    assert.equal((await reg.acquire(req("next-1", "next", "cloud", ["path:x/y/z"]))).granted, false, "still inside the lease");
    now += 2_000;
    const r = await reg.acquire(req("next-2", "next", "cloud", ["path:x/y/z"]));
    assert.ok(r.granted, "lease expired -> claim is free");
    const dead = (await reg.backend.listClaims()).find((c) => c.run_id === "dead");
    assert.equal(dead.status, "expired");
    assert.equal((await reg.renew("dead")).ok, false, "the dead run cannot revive its claim");
  });

  test(`[${label}] non-overlapping runs launch side by side`, async () => {
    const reg = new AirspaceRegistry(makeBackend());
    const rs = await Promise.all([
      reg.acquire(req("s1", "fig", "local", ["path:portfolios/own-products/fig", "ghl_location:Loc1"])),
      reg.acquire(req("s2", "renuity", "cloud", ["path:portfolios/client-work/renuity", "ghl_location:Loc2"])),
      reg.acquire(req("s3", "creator", "local", ["repo:the-creator", "path:portfolios/own-products/figgy"])),
    ]);
    assert.ok(rs.every((r) => r.granted), JSON.stringify(rs.filter((r) => !r.granted)));
    assert.equal((await reg.listActive()).length, 3);
  });

  test(`[${label}] cockpit claim adopted once by the cloud runner; renew, release; held launches resolve`, async () => {
    let now = 5_000_000;
    const reg = new AirspaceRegistry(makeBackend(() => now), () => now);
    const first = await reg.acquire(req("run-x", "fig", "cloud", ["path:f/g"], { adoptable: true }));
    assert.ok(first.granted && first.claim.adoptable === true);
    now += 10_000;
    const adopt = await reg.acquire(req("run-x", "fig", "cloud", ["path:f/g"]));
    assert.ok(adopt.granted && adopt.adopted);
    assert.equal(adopt.claim.adoptable, false, "adoption is one-shot");
    assert.equal(adopt.claim.acquired_at, first.claim.acquired_at);
    const held = await reg.acquire(req("run-y", "fig2", "local", ["path:f/g/sub"]));
    assert.equal(held.granted, false);
    assert.equal((await reg.listHeld()).length, 1);
    now += 10_000;
    const renewed = await reg.renew("run-x", 60_000);
    assert.ok(renewed.ok && renewed.claim.lease_expires_at === now + 60_000);
    assert.equal(await reg.release("run-x"), true);
    assert.equal(await reg.release("run-x"), false, "release is idempotent");
    assert.equal((await reg.renew("run-x")).ok, false, "a released claim cannot be renewed");
    const retry = await reg.acquire(req("run-z", "fig2", "local", ["path:f/g/sub"]));
    assert.ok(retry.granted);
    assert.equal((await reg.listHeld()).length, 0, "the plan's earlier hold is resolved");
  });
}

test("firestore adapter: stores real timestamps, serializes on airspaceRegistry/head, prefixes test collections", async () => {
  const db = fakeFirestore();
  const reg = new AirspaceRegistry(new FirestoreAirspaceBackend(db, { serverTimestamp: () => SERVER_TS, collectionPrefix: "airspaceTest_" }), () => Date.now());
  await reg.acquire(req("r1", "p", "local", ["path:a/b"]));
  const doc = db.store.get("airspaceTest_airspaceClaims/r1");
  for (const f of ["acquired_at", "heartbeat_at", "lease_expires_at"]) assert.ok(doc[f] instanceof Date, f);
  assert.equal(db.store.get("airspaceTest_airspaceRegistry/head").version, 1);
  assert.equal(db.store.get("airspaceClaims/r1"), undefined, "nothing written to production collections");
  const [c] = await reg.listActive();
  assert.equal(typeof c.lease_expires_at, "number");
});

/* ── Adoption ──────────────────────────────────────────────────────────────── */

test("adopt: foreign run_id held", async () => {
  const reg = new AirspaceRegistry(new MemoryAirspaceBackend(), () => 1_000);
  assert.ok((await reg.acquire(req("holder", "real-plan", "local", ["path:a/b"]))).granted);
  const takeover = await reg.acquire(req("holder", "other-plan", "cloud", ["path:c/d"]));
  assert.equal(takeover.granted, false, "a run id never takes over a live claim");
  const c = (await reg.backend.listClaims()).find((x) => x.run_id === "holder");
  assert.equal(c.plan_name, "real-plan", "the holder's claim is untouched");
  assert.deepEqual(c.resources, ["path:a/b", "plan:real-plan"]);
});

test("adopt: second adoption held", async () => {
  const reg = new AirspaceRegistry(new MemoryAirspaceBackend(), () => 1_000);
  await reg.acquire(req("r1", "p", "cloud", ["path:a/b"], { adoptable: true }));
  assert.ok((await reg.acquire(req("r1", "p", "cloud", ["path:a/b"]))).adopted);
  assert.equal((await reg.acquire(req("r1", "p", "cloud", ["path:a/b"]))).granted, false);
});

test("adopt: mismatched plan/resources held", async () => {
  const reg = new AirspaceRegistry(new MemoryAirspaceBackend(), () => 1_000);
  await reg.acquire(req("r1", "p", "cloud", ["path:a/b"], { adoptable: true }));
  assert.equal((await reg.acquire(req("r1", "q", "cloud", ["path:a/b"]))).granted, false, "different plan");
  assert.equal((await reg.acquire(req("r1", "p", "cloud", ["path:a/b", "path:c/d"]))).granted, false, "different resources");
  assert.equal((await reg.acquire(req("r1", "p", "local", ["path:a/b"]))).granted, false, "local lane never adopts");
  assert.ok((await reg.acquire(req("r1", "p", "cloud", ["path:a/b"]))).adopted, "the matching runner still adopts");
});

test("adopt: released/expired claim not adopted", async () => {
  let now = 1_000;
  const reg = new AirspaceRegistry(new MemoryAirspaceBackend(), () => now);
  await reg.acquire(req("r1", "p", "cloud", ["path:a/b"], { adoptable: true }));
  await reg.release("r1");
  const after = (await reg.backend.listClaims()).find((c) => c.run_id === "r1");
  assert.equal(after.adoptable, false, "release clears adoptable");
  // Another run takes the folder; the cockpit's runner must NOT slip in by run id.
  assert.ok((await reg.acquire(req("other", "o", "local", ["path:a/b"]))).granted);
  assert.equal((await reg.acquire(req("r1", "p", "cloud", ["path:a/b"]))).granted, false);
  await reg.release("other");
  // Expired: a fresh acquire, conflicts checked, never an adoption.
  await reg.acquire(req("r2", "p2", "cloud", ["path:e/f"], { adoptable: true, leaseMs: 60_000 }));
  now += 61_000;
  const fresh = await reg.acquire(req("r2", "p2", "cloud", ["path:e/f"]));
  assert.ok(fresh.granted);
  assert.equal(fresh.adopted, false);
});

test("cancel: releaseIfUnadopted frees only a never-adopted claim", async () => {
  const reg = new AirspaceRegistry(new MemoryAirspaceBackend(), () => 1_000);
  await reg.acquire(req("r1", "p", "cloud", ["path:a/b"], { adoptable: true }));
  await reg.acquire(req("r1", "p", "cloud", ["path:a/b"])); // the runner adopted it
  assert.equal(await reg.releaseIfUnadopted("r1"), false, "an adopted claim belongs to a live runner");
  await reg.acquire(req("r2", "p2", "cloud", ["path:c/d"], { adoptable: true }));
  assert.equal(await reg.releaseIfUnadopted("r2"), true);
});

/* ── Heartbeat + fence ─────────────────────────────────────────────────────── */

function fenceRig(renew, { intervalMs = 40, leaseMs = 200 } = {}) {
  const t0 = mono();
  const lost = [];
  const h = startHeartbeat({ renew }, "r", {
    armedAt: t0, mono, intervalMs, leaseMs, onLost: (why) => lost.push({ why, at: mono() - t0 }), fenceTickMs: 5,
  });
  return { h, lost, leaseMs, t0 };
}

test("fence: first renew never resolves", async () => {
  const { h, lost, leaseMs } = fenceRig(() => new Promise(() => {}));
  await sleep(260);
  h.stop();
  assert.equal(lost.length, 1);
  assert.match(lost[0].why, /lease unconfirmed/);
  assert.ok(lost[0].at < leaseMs, `fenced at ${lost[0].at} ms, before the ${leaseMs} ms lease`);
});

test("fence: renew throws", async () => {
  const { h, lost, leaseMs } = fenceRig(async () => { throw new Error("UNAVAILABLE"); });
  await sleep(260);
  h.stop();
  assert.equal(lost.length, 1);
  assert.ok(lost[0].at < leaseMs);
});

test("fence: renew reports lost", async () => {
  const { h, lost } = fenceRig(async () => ({ ok: false, reason: "claim was released" }));
  await sleep(120);
  h.stop();
  assert.equal(lost.length, 1);
  assert.equal(lost[0].why, "claim was released");
});

test("fence: renew never resolves (after succeeding)", async () => {
  let n = 0;
  let lastOk = 0;
  const t0 = mono();
  const { h, lost, leaseMs } = fenceRig(() => {
    if (n++ < 2) { lastOk = mono() - t0; return Promise.resolve({ ok: true, claim: {} }); }
    return new Promise(() => {});
  });
  await sleep(400);
  h.stop();
  assert.equal(lost.length, 1);
  assert.ok(lost[0].at < lastOk + leaseMs, `fenced at ${lost[0].at}, last good renew sent at ${lastOk}`);
});

test("fence: expired not revived", async () => {
  let now = 1_000;
  const reg = new AirspaceRegistry(new MemoryAirspaceBackend(), () => now);
  await reg.acquire(req("r", "p", "local", ["path:a/b"], { leaseMs: 60_000 }));
  now += 61_000; // nobody else claimed it, but the lease is gone
  const r = await reg.renew("r");
  assert.equal(r.ok, false);
  const c = (await reg.backend.listClaims()).find((x) => x.run_id === "r");
  assert.equal(c.status, "expired");
  assert.equal((await reg.renew("r")).ok, false, "and stays expired");
});

test("losing the airspace halts dispatch: orchestrate skips everything not yet started", async () => {
  let now = 0;
  const reg = new AirspaceRegistry(new MemoryAirspaceBackend(), () => now);
  const lost = [];
  const c = await L.claimAirspaceForRun({
    registry: reg, plan: { name: "lose", airspace: ["path:l/m"] }, runId: "l-1", lane: "cloud",
    leaseMs: 100, heartbeatMs: 20, log: (_l, m) => lost.push(m),
  });
  now += 500;
  assert.ok((await reg.acquire(req("l-2", "taker", "local", ["path:l/m"]))).granted);
  await sleep(80);
  assert.match(c.halt() ?? "", /Airspace lost/);
  assert.ok(c.signal.aborted, "in-flight work is told to stop");
  const plan = validatePlan({ name: "lose", airspace: ["path:l/m"], tasks: [{ id: "a", prompt: "x" }, { id: "b", prompt: "y", deps: ["a"] }] }, { quiet: true });
  const results = await orchestrate(plan, { repoPath: ".", concurrency: 2, dryRun: true, halt: c.halt });
  assert.ok(results.every((r) => r.status === "skipped" && /Airspace lost/.test(r.error)));
  await c.release();
});

test("an unreachable registry throws (callers fail closed and do not launch)", async () => {
  const broken = {
    transact: async () => { throw new Error("PERMISSION_DENIED"); },
    serverTime: async () => Date.now(),
    listClaims: async () => [], listHeld: async () => [],
  };
  await assert.rejects(
    L.claimAirspaceForRun({ registry: new AirspaceRegistry(broken), plan: { name: "p", airspace: ["path:a/b"] }, runId: "r", lane: "local", leaseMs: 60_000, heartbeatMs: 1_000 }),
    /PERMISSION_DENIED/,
  );
});

/* ── The real CLI entry point, in-process ──────────────────────────────────── */

function projectsTree() {
  const root = mkdtempSync(join(tmpdir(), "ds-air-"));
  writeFileSync(join(root, "studio.yaml"), "studio: test\n");
  const proj = join(root, "portfolios", "internal-tools", "demo");
  mkdirSync(proj, { recursive: true });
  const git = (...a) => execFileSync("git", ["-C", proj, ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(proj, "README.md"), "demo\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { root, proj, git, head: () => git("rev-parse", "HEAD") };
}

function writePlan(dir, airspace, extra = "") {
  const p = join(dir, "test.plan.yaml");
  writeFileSync(p, [
    "name: demo-build",
    "airspace:",
    ...airspace.map((a) => `  - "${a}"`),
    "deploy_policy:",
    "  worker_defaults:",
    "    commit_after_each_task: true",
    "tasks:",
    "  - id: build",
    "    prompt: build it",
    extra,
  ].join("\n") + "\n");
  return p;
}

/**
 * Run an in-process entry point with `vars` set and its console/stdout output
 * captured: node --test uses this process's stdout as its message channel, and
 * the CLI's and cloud runner's own logging would corrupt it.
 */
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const con = { log: console.log, warn: console.warn, error: console.error };
  const write = process.stdout.write;
  console.log = console.warn = console.error = () => {};
  process.stdout.write = () => true;
  try { return await fn(); } finally {
    Object.assign(console, con);
    process.stdout.write = write;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const CLI_ENV = { ANTHROPIC_API_KEY: "test-not-a-key", AIRSPACE_LEASE_MS: "60000", AIRSPACE_HEARTBEAT_MS: "1000" };
const cliArgs = (plan, repo, ...more) => ["node", "ds-build", plan, "--repo", repo, "--api", ...more];
const okRunner = (fn) => async (task, _plan, repo, _m, _i, signal) => {
  await fn?.(repo, signal);
  return { taskId: task.id, status: "success", summary: "fake", durationMs: 1 };
};

test("cli: --run-id rejected", async () => {
  const t = projectsTree();
  const plan = writePlan(t.proj, ["path:portfolios/internal-tools/demo"]);
  const backend = new MemoryAirspaceBackend();
  const code = await withEnv(CLI_ENV, () =>
    CLI.main(cliArgs(plan, t.proj, "--run-id", "someone-elses"), { registry: new AirspaceRegistry(backend), taskRunner: okRunner(), projectsRoot: t.root }));
  assert.equal(code, 1);
  assert.equal(backend.claims.size, 0, "nothing claimed");
});

test("release: normal exit releases (CLI)", async () => {
  const t = projectsTree();
  const plan = writePlan(t.proj, ["path:portfolios/internal-tools/demo"]);
  const backend = new MemoryAirspaceBackend();
  const code = await withEnv(CLI_ENV, () =>
    CLI.main(cliArgs(plan, t.proj), { registry: new AirspaceRegistry(backend), taskRunner: okRunner((repo) => writeFileSync(join(repo, "a.txt"), "a")), projectsRoot: t.root }));
  assert.equal(code, 0);
  const [c] = [...backend.claims.values()];
  assert.equal(c.status, "released");
  assert.equal(c.lane, "local");
});

test("release: failed run releases (CLI)", async () => {
  const t = projectsTree();
  const plan = writePlan(t.proj, ["path:portfolios/internal-tools/demo"]);
  const backend = new MemoryAirspaceBackend();
  const code = await withEnv(CLI_ENV, () =>
    CLI.main(cliArgs(plan, t.proj), {
      registry: new AirspaceRegistry(backend),
      taskRunner: async (task) => ({ taskId: task.id, status: "failed", error: "boom", durationMs: 1 }),
      projectsRoot: t.root,
    }));
  assert.equal(code, 1);
  assert.equal([...backend.claims.values()][0].status, "released");
});

test("held: a conflicting live claim makes the CLI exit 3 naming the holder", async () => {
  const t = projectsTree();
  const plan = writePlan(t.proj, ["path:portfolios/internal-tools/demo"]);
  const reg = new AirspaceRegistry(new MemoryAirspaceBackend());
  await reg.acquire(req("cloud-1", "fig-cloud", "cloud", ["path:portfolios/internal-tools"]));
  let ran = false;
  const code = await withEnv(CLI_ENV, () =>
    CLI.main(cliArgs(plan, t.proj), { registry: reg, taskRunner: okRunner(() => { ran = true; }), projectsRoot: t.root }));
  assert.equal(code, 3);
  assert.equal(ran, false, "nothing ran");
});

test("loss: in-flight task aborted, HEAD unchanged, exit 4", async () => {
  const t = projectsTree();
  const plan = writePlan(t.proj, ["path:portfolios/internal-tools/demo"]);
  const backend = new MemoryAirspaceBackend();
  const reg = new AirspaceRegistry(backend);
  const before = t.head();
  let sawAbort = false;
  const runner = async (task, _plan, repo, _m, _i, signal) => {
    writeFileSync(join(repo, "half-done.txt"), "partial");
    // Someone (an operator, a lease lapse) takes the claim away mid-task.
    const [c] = [...backend.claims.values()];
    await reg.release(c.run_id);
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    sawAbort = true;
    return { taskId: task.id, status: "success", summary: "finished anyway", durationMs: 1 };
  };
  const code = await withEnv(CLI_ENV, () => CLI.main(cliArgs(plan, t.proj), { registry: reg, taskRunner: runner, projectsRoot: t.root }));
  assert.ok(sawAbort, "the in-flight task was aborted");
  assert.equal(code, 4);
  assert.equal(t.head(), before, "nothing committed");
});

test("commit: fence passed refuses commit", async () => {
  const t = projectsTree();
  const plan = writePlan(t.proj, ["path:portfolios/internal-tools/demo"]);
  const backend = new MemoryAirspaceBackend();
  const reg = new AirspaceRegistry(backend);
  const before = t.head();
  const runner = async (task, _plan, repo) => {
    writeFileSync(join(repo, "done.txt"), "work");
    const [c] = [...backend.claims.values()];
    await reg.release(c.run_id); // the lease is no longer ours by the time we would commit
    return { taskId: task.id, status: "success", summary: "ok", durationMs: 1 };
  };
  const code = await withEnv(CLI_ENV, () => CLI.main(cliArgs(plan, t.proj), { registry: reg, taskRunner: runner, projectsRoot: t.root }));
  assert.equal(code, 4);
  assert.equal(t.head(), before, "the commit was refused");
});

test("target: inside root unclaimed", async () => {
  const t = projectsTree();
  const other = join(t.root, "portfolios", "internal-tools", "other");
  mkdirSync(other, { recursive: true });
  const plan = writePlan(t.proj, ["path:portfolios/internal-tools/demo"]);
  const backend = new MemoryAirspaceBackend();
  const code = await withEnv(CLI_ENV, () => CLI.main(cliArgs(plan, other), { registry: new AirspaceRegistry(backend), taskRunner: okRunner(), projectsRoot: t.root }));
  assert.equal(code, 5);
  assert.equal(backend.claims.size, 0);
});

test("target: outside root undeclared", async () => {
  const t = projectsTree();
  const outside = mkdtempSync(join(tmpdir(), "ds-outside-"));
  const plan = writePlan(t.proj, ["path:portfolios/internal-tools/demo"]);
  const code = await withEnv(CLI_ENV, () => CLI.main(cliArgs(plan, outside), { registry: new AirspaceRegistry(new MemoryAirspaceBackend()), taskRunner: okRunner(), projectsRoot: t.root }));
  assert.equal(code, 5);
});

test("target: path:abs ok", async () => {
  const t = projectsTree();
  const outside = mkdtempSync(join(tmpdir(), "ds-outside-"));
  const plan = writePlan(t.proj, [`path:abs:${outside.replace(/\\/g, "/")}`]);
  const code = await withEnv(CLI_ENV, () => CLI.main(cliArgs(plan, outside), { registry: new AirspaceRegistry(new MemoryAirspaceBackend()), taskRunner: okRunner(), projectsRoot: t.root }));
  assert.equal(code, 0);
});

test("lease: out-of-bounds refused", async () => {
  const t = projectsTree();
  const plan = writePlan(t.proj, ["path:portfolios/internal-tools/demo"]);
  for (const [lease, beat] of [["1000", "100"], ["3600000", "1000"], ["60000", "30000"]]) {
    const backend = new MemoryAirspaceBackend();
    const code = await withEnv({ ...CLI_ENV, AIRSPACE_LEASE_MS: lease, AIRSPACE_HEARTBEAT_MS: beat }, () =>
      CLI.main(cliArgs(plan, t.proj), { registry: new AirspaceRegistry(backend), taskRunner: okRunner(), projectsRoot: t.root }));
    assert.equal(code, 5, `lease ${lease} / heartbeat ${beat}`);
    assert.equal(backend.claims.size, 0);
  }
});

test("overlap: path vs derived repo", async () => {
  const t = projectsTree();
  t.git("remote", "add", "origin", "https://github.com/DigitalSolomon-ops/demo-repo.git");
  const nested = join(t.proj, "vendor", "lib");
  mkdirSync(nested, { recursive: true });
  execFileSync("git", ["-C", nested, "init", "-q"]);
  execFileSync("git", ["-C", nested, "remote", "add", "origin", "git@github.com:Other/nested-lib.git"]);
  const derived = L.deriveRepoKeys(["path:portfolios/internal-tools/demo"], t.root);
  assert.deepEqual(derived, ["repo:digitalsolomon-ops/demo-repo", "repo:other/nested-lib"]);
  // A run claiming the folder (plus its derived repo) blocks a run that names only the remote.
  const reg = new AirspaceRegistry(new MemoryAirspaceBackend());
  assert.ok((await reg.acquire({ ...req("folder", "f", "local", ["path:portfolios/internal-tools/demo"]), derived })).granted);
  const r = await reg.acquire(req("remote", "r", "cloud", ["repo:DigitalSolomon-ops/demo-repo"]));
  assert.equal(r.granted, false);
  assert.match(r.message, /repo:digitalsolomon-ops\/demo-repo/);
});

/* ── Shutdown: child trees die before the claim is released ────────────────── */

test("exit: grandchild gone before release", async () => {
  const t = projectsTree();
  const plan = writePlan(t.proj, ["path:portfolios/internal-tools/demo"]);
  const backend = new MemoryAirspaceBackend();
  const reg = new AirspaceRegistry(backend);
  let grandPid;
  let aliveAtRelease;
  const realRelease = reg.release.bind(reg);
  reg.release = async (id) => {
    aliveAtRelease = grandPid ? P.isAlive(grandPid) : undefined;
    return realRelease(id);
  };
  let started;
  const ready = new Promise((r) => { started = r; });
  const runner = async (task, _plan, _repo, _m, _i, signal) => {
    // child -> grandchild, both long-lived; the child prints the grandchild's pid.
    const child = spawn(process.execPath, ["-e", [
      "const { spawn } = require('node:child_process');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });",
      "console.log(g.pid);",
      "setInterval(()=>{}, 1000);",
    ].join(" ")], { stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32" });
    P.trackChild(child);
    grandPid = Number((await new Promise((r) => child.stdout.once("data", r))).toString().trim());
    started();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return { taskId: task.id, status: "failed", error: "stopped", durationMs: 1 };
  };
  const run = withEnv(CLI_ENV, () => CLI.main(cliArgs(plan, t.proj), { registry: reg, taskRunner: runner, projectsRoot: t.root }));
  await ready;
  assert.ok(P.isAlive(grandPid), "grandchild is running");
  await CLI.shutdown("test shutdown", { watch: [grandPid] });
  assert.equal(aliveAtRelease, false, "the grandchild was confirmed dead before the claim was released");
  assert.equal([...backend.claims.values()][0].status, "released");
  await run;
});

/* ── The real cloud entry point, in-process ────────────────────────────────── */

function fakeCloud(planYaml, { projectAirspace } = {}) {
  const db = fakeFirestore();
  const writes = [];
  const origCollection = db.collection;
  db.collection = (col) => {
    const c = origCollection(col);
    const doc = c.doc;
    c.doc = (id) => {
      const d = doc(id);
      const set = d.set;
      d.set = async (data, opts) => { writes.push({ col, id, data }); const prev = opts?.merge ? db.store.get(`${col}/${id}`) ?? {} : {}; db.store.set(`${col}/${id}`, { ...prev, ...data }); return set ? { writeTime: { toMillis: () => Date.now() } } : undefined; };
      d.update = async (data) => { writes.push({ col, id, data, update: true }); db.store.set(`${col}/${id}`, { ...(db.store.get(`${col}/${id}`) ?? {}), ...data }); };
      return d;
    };
    return c;
  };
  if (projectAirspace) db.store.set("projects/proj-1", { airspace: projectAirspace });
  const storage = {
    bucket: () => ({
      file: () => ({ download: async () => [Buffer.from(planYaml)] }),
      getFiles: async () => [[]],
      upload: async () => {},
    }),
  };
  const projectWrites = () => writes.filter((w) => w.col === "projects");
  return { db, storage, writes, projectWrites };
}
const CLOUD_PLAN = "name: cloud-demo\nairspace:\n  - path:portfolios/internal-tools/demo\ntasks:\n  - id: build\n    prompt: build it\n";
const cloudEnv = (extra = {}) => ({
  PLAN_URI: "gs://b/p.yaml", PROJECT_DOC_ID: "proj-1", RUN_ID: "run-cloud-1", GCP_PROJECT_ID: "test",
  AIRSPACE_LEASE_MS: "60000", AIRSPACE_HEARTBEAT_MS: "1000", ...extra,
});

test("cloud: no GitHub token in agent env", async () => {
  const f = fakeCloud(CLOUD_PLAN);
  const asked = [];
  let tokenSeen = "unset";
  const code = await withEnv({ GITHUB_TOKEN: "ghp_should_not_reach_agents", GH_TOKEN: "x" }, () =>
    CLOUD.main(cloudEnv(), {
      db: f.db, storage: f.storage, registry: new AirspaceRegistry(new MemoryAirspaceBackend()),
      secretVal: async (slot) => { asked.push(slot); return slot === "global-github" ? "ghp_from_vault" : undefined; },
      taskRunner: async (task) => { tokenSeen = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN; return { taskId: task.id, status: "success", durationMs: 1 }; },
    }));
  assert.equal(code, 0);
  assert.equal(tokenSeen, undefined, "agents get no GitHub token");
  assert.ok(!asked.includes("global-github"), "the GitHub secret is never even fetched");
});

test("dry-run: zero lifecycle writes", async () => {
  const f = fakeCloud(CLOUD_PLAN);
  const backend = new MemoryAirspaceBackend();
  const code = await withEnv({}, () => CLOUD.main(cloudEnv({ DRY_RUN: "true" }), {
    db: f.db, storage: f.storage, registry: new AirspaceRegistry(backend), secretVal: async () => undefined,
  }));
  assert.equal(code, 0);
  assert.equal(f.projectWrites().length, 0, JSON.stringify(f.projectWrites()));
  assert.equal(backend.claims.size, 0, "a dry run claims nothing");
});

test("release: normal exit releases (cloud), with the record's derived keys claimed", async () => {
  const f = fakeCloud(CLOUD_PLAN, { projectAirspace: ["path:portfolios/internal-tools/demo", "repo:DigitalSolomon-ops/demo-repo"] });
  const backend = new MemoryAirspaceBackend();
  let resourcesWhileRunning;
  const code = await withEnv({}, () => CLOUD.main(cloudEnv(), {
    db: f.db, storage: f.storage, registry: new AirspaceRegistry(backend), secretVal: async () => undefined,
    taskRunner: async (task) => { resourcesWhileRunning = [...backend.claims.values()][0].resources; return { taskId: task.id, status: "success", durationMs: 1 }; },
  }));
  assert.equal(code, 0);
  assert.ok(resourcesWhileRunning.includes("repo:digitalsolomon-ops/demo-repo"));
  assert.equal([...backend.claims.values()][0].status, "released");
});

test("release: failed run releases (cloud)", async () => {
  const f = fakeCloud(CLOUD_PLAN);
  const backend = new MemoryAirspaceBackend();
  const code = await withEnv({}, () => CLOUD.main(cloudEnv(), {
    db: f.db, storage: f.storage, registry: new AirspaceRegistry(backend), secretVal: async () => undefined,
    taskRunner: async (task) => ({ taskId: task.id, status: "failed", error: "boom", durationMs: 1 }),
  }));
  assert.equal(code, 1);
  assert.equal([...backend.claims.values()][0].status, "released");
});

test("cloud: held exits 3, records held, builds nothing; the cockpit's adoptable claim is adopted once", async () => {
  const reg = new AirspaceRegistry(new MemoryAirspaceBackend());
  await reg.acquire(req("local-9", "fig-local", "local", ["path:portfolios/internal-tools"]));
  const f = fakeCloud(CLOUD_PLAN);
  let ran = false;
  const code = await withEnv({}, () => CLOUD.main(cloudEnv(), {
    db: f.db, storage: f.storage, registry: reg, secretVal: async () => undefined,
    taskRunner: async (task) => { ran = true; return { taskId: task.id, status: "success", durationMs: 1 }; },
  }));
  assert.equal(code, 3);
  assert.equal(ran, false);
  assert.equal(f.db.store.get("runs/run-cloud-1").status, "held");

  const reg2 = new AirspaceRegistry(new MemoryAirspaceBackend());
  await reg2.acquire(req("run-cloud-1", "cloud-demo", "cloud", ["path:portfolios/internal-tools/demo"], { adoptable: true }));
  const f2 = fakeCloud(CLOUD_PLAN);
  const code2 = await withEnv({}, () => CLOUD.main(cloudEnv(), {
    db: f2.db, storage: f2.storage, registry: reg2, secretVal: async () => undefined,
    taskRunner: async (task) => ({ taskId: task.id, status: "success", durationMs: 1 }),
  }));
  assert.equal(code2, 0, "the runner adopted the cockpit's claim");
});

/* ── Static guards ─────────────────────────────────────────────────────────── */

test("entry: backend not selectable", () => {
  for (const f of ["../src/index.ts", "../src/cloud-job.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(src, /process\.env[^;\n]*(BACKEND|REGISTRY|DATABASE)/, f);
    assert.doesNotMatch(src, /procEnv[^;\n]*(BACKEND|REGISTRY|DATABASE)/, f);
  }
});

/**
 * Identifiers named force/override/bypass/skip* within 3 lines of "airspace", in
 * code (comments stripped), across all three repos. Each allowed line is listed
 * with the reason it is not an airspace bypass.
 */
const OVERRIDE_ALLOW = new Map([
  // ds-build-agent: the orchestrator's existing "skipped" task status and counters.
  ['finish(id, { taskId: id, status: "skipped", error: reason, durationMs: 0 });', "orchestrator: a halted task is recorded as skipped (the opposite of a bypass)"],
  ['opts.onEvent?.({ type: "task-skipped", task, reason });', "orchestrator: the skip event for a halted task"],
  ['const skipped = results.filter((r) => r.status === "skipped").length;', "cloud-job: end-of-run counter"],
  ['status: "finished", finishedAt: stamp(), failed, deferred, skipped, ...usageRollup, ...capFields,', "cloud-job: end-of-run counters"],
  ["dryRun?: { wouldBuild: number; deferred: number; skipped: number; tasks: number };", "sync: the dry-run preview's counters"],
]);
function overrideHits(rootDir, subdirs, exts) {
  const hits = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      if (["node_modules", "dist", ".git", ".deps", "__pycache__", "test", "tests"].includes(e)) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (exts.some((x) => p.endsWith(x))) {
        const py = p.endsWith(".py");
        const lines = readFileSync(p, "utf8").split(/\r?\n/);
        let inBlock = false;
        const code = lines.map((l) => {
          let s = l;
          if (!py) {
            if (inBlock) { const end = s.indexOf("*/"); if (end < 0) return ""; s = s.slice(end + 2); inBlock = false; }
            s = s.replace(/\/\*.*?\*\//g, "");
            const open = s.indexOf("/*");
            if (open >= 0) { s = s.slice(0, open); inBlock = true; }
            s = s.replace(/(^|[^:])\/\/.*$/, "$1");
          } else {
            s = s.replace(/#.*$/, "");
            if (/^\s*("""|''')/.test(s)) return "";
          }
          return s;
        });
        code.forEach((l, i) => {
          if (!/\b(force|override|bypass|skip)\w*\b/i.test(l)) return;
          const near = code.slice(Math.max(0, i - 3), i + 4).join("\n");
          if (!/airspace/i.test(near)) return;
          if (OVERRIDE_ALLOW.has(l.trim())) return;
          hits.push(`${p}:${i + 1}: ${l.trim()}`);
        });
      }
    }
  };
  for (const s of subdirs) if (existsSync(join(rootDir, s))) walk(join(rootDir, s));
  return hits;
}

test("no override: identifiers outside comments", (t) => {
  const hits = overrideHits(new URL("..", import.meta.url).pathname.replace(/^\/([a-z]:)/i, "$1"), ["src"], [".ts"]);
  const repos = { CREATOR_REPO: [["services", "packages"], [".ts", ".js", ".mjs"]], WATCHER_REPO: [["handoff_watcher"], [".py"]] };
  for (const [envName, [dirs, exts]] of Object.entries(repos)) {
    const dir = process.env[envName];
    if (!dir || !existsSync(dir)) {
      if (CROSS) assert.fail(`${envName} is not set or missing; AIRSPACE_CROSS_REPO=1 requires it`);
      t.diagnostic(`skipped ${envName}: not set (set AIRSPACE_CROSS_REPO=1 and the repo paths to check it)`);
      continue;
    }
    hits.push(...overrideHits(dir, dirs, exts));
  }
  assert.deepEqual(hits, [], "airspace code paths must have no override/force/skip/bypass identifier");
});

test("parity: the-creator's mirrored airspace.ts is byte-identical", (t) => {
  const mine = readFileSync(new URL("../src/airspace.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const dir = process.env.CREATOR_REPO;
  const theirsPath = dir && join(dir, "packages", "shared", "src", "airspace.ts");
  if (!theirsPath || !existsSync(theirsPath)) {
    if (CROSS) assert.fail("CREATOR_REPO is not set or has no packages/shared/src/airspace.ts; AIRSPACE_CROSS_REPO=1 requires it");
    return t.skip("CREATOR_REPO not set (set AIRSPACE_CROSS_REPO=1 and CREATOR_REPO to check parity)");
  }
  const theirs = readFileSync(theirsPath, "utf8").replace(/\r\n/g, "\n");
  assert.equal(theirs, mine, "copy src/airspace.ts to the-creator/packages/shared/src/airspace.ts");
});
