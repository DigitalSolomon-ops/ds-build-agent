/**
 * Phase 4 "Local vs cloud": the REAL entry points of both lanes, in-process, on
 * ONE shared registry.
 *
 *   - the-creator's Express app (services/solomon/src/server.ts) — the cockpit's
 *     cloud Launch route, with fake Firestore and a fake Cloud Run injected
 *     through its useDeps() factory;
 *   - ds-build-agent's CLI main() — the local lane, with a fake task runner.
 *
 * A local run holding R makes the cockpit's Launch return 409 with the held
 * message and never call Cloud Run; a cloud claim on R makes the CLI exit 3 with
 * the same message shape. No agent, no SDK, no subprocess.
 *
 * Needs CREATOR_REPO (the-creator checkout with packages/shared built). With
 * AIRSPACE_CROSS_REPO=1 a missing CREATOR_REPO fails; otherwise it skips.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DIST = new URL("../dist/", import.meta.url);
const A = await import(new URL("airspace.js", DIST).href);
const CLI = await import(new URL("index.js", DIST).href);

const CREATOR = process.env.CREATOR_REPO;
const SERVER = CREATOR && join(CREATOR, "services", "solomon", "src", "server.ts");
const FAKES = CREATOR && join(CREATOR, "services", "solomon", "test", "fakes.mjs");
const present = !!SERVER && existsSync(SERVER) && existsSync(FAKES);
if (!present && process.env.AIRSPACE_CROSS_REPO === "1") {
  throw new Error("CREATOR_REPO is not set or incomplete; AIRSPACE_CROSS_REPO=1 requires it");
}

const PLAN_URI = "gs://creator-bucket/plans/demo.yaml";
const RESOURCE = "path:portfolios/internal-tools/demo";
const HELD = (plan, lane) => new RegExp(`^held: conflicts with ${plan} on path:portfolios/internal-tools/demo \\[run [^,]+, ${lane} lane\\]`);

let server;
let base;
let C;

before(async () => {
  if (!present) return;
  C = {
    ...(await import(pathToFileURL(SERVER).href)),
    ...(await import(pathToFileURL(FAKES).href)),
  };
  server = C.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

/** One registry both lanes share, on the real clock. */
function setup() {
  const registry = new A.AirspaceRegistry(new A.MemoryAirspaceBackend(), () => Date.now());
  const db = new C.FakeFirestore();
  const cloud = new C.FakeCloudRun();
  const planYaml = `project:\n  name: demo-plan\nairspace:\n  paths: [portfolios/internal-tools/demo]\ntasks:\n  - id: t1\n    prompt: build it\n`;
  const restore = C.useDeps({
    db: () => db,
    localDb: () => new C.FakeFirestore(),
    registry: () => registry,
    cloudRun: () => cloud,
    readText: async (uri) => { if (uri !== PLAN_URI) throw new Error(`no such file ${uri}`); return planYaml; },
    getGuardrails: async () => ({ paused: false, softCapUsd: 1000, updatedAt: 0 }),
    spendToday: async () => 0,
    listPrefix: async () => [],
    uploadBytes: async () => {},
    now: () => Date.now(),
  });
  db.seed("projects", "sync--demo", {
    projectId: "sync--demo", name: "demo-plan", state: "drafted", planUri: PLAN_URI,
    createdAt: 1, updatedAt: 1, source: "sync", localPath: "portfolios/internal-tools/demo",
    planPath: "portfolios/internal-tools/demo/plan.yaml", planSource: "existing", planSha256: "ab".repeat(32),
    syncState: "dry-run", airspace: [RESOURCE], airspaceDraft: null, syncedAt: 1,
  });
  return { registry, db, cloud, restore };
}

/** A Projects tree holding the demo project and a local plan on it. */
function localPlan() {
  const root = mkdtempSync(join(tmpdir(), "ds-xlane-"));
  writeFileSync(join(root, "studio.yaml"), "studio: test\n");
  const proj = join(root, "portfolios", "internal-tools", "demo");
  mkdirSync(proj, { recursive: true });
  execFileSync("git", ["-C", proj, "init", "-q"]);
  const plan = join(proj, "local.plan.yaml");
  writeFileSync(plan, `name: demo-local\nairspace:\n  - ${RESOURCE}\ntasks:\n  - id: build\n    prompt: build it\n`);
  return { root, proj, plan };
}

async function launch() {
  const r = await fetch(`${base}/api/projects/sync--demo/run`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  return { status: r.status, json: await r.json() };
}

/** Run the CLI in-process with its output captured (node --test owns stdout). */
async function cli(argv, deps) {
  const lines = [];
  const con = { log: console.log, warn: console.warn, error: console.error };
  const write = process.stdout.write;
  const env = { k: process.env.ANTHROPIC_API_KEY, l: process.env.AIRSPACE_LEASE_MS, h: process.env.AIRSPACE_HEARTBEAT_MS };
  console.log = console.warn = () => {};
  console.error = (...a) => lines.push(a.join(" "));
  process.stdout.write = () => true;
  Object.assign(process.env, { ANTHROPIC_API_KEY: "test-not-a-key", AIRSPACE_LEASE_MS: "60000", AIRSPACE_HEARTBEAT_MS: "5000" });
  try {
    return { code: await CLI.main(argv, deps), errors: lines };
  } finally {
    Object.assign(console, con);
    process.stdout.write = write;
    for (const [k, v] of [["ANTHROPIC_API_KEY", env.k], ["AIRSPACE_LEASE_MS", env.l], ["AIRSPACE_HEARTBEAT_MS", env.h]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test("local vs cloud: a local CLI run holding R makes the cockpit's Launch 409, and Cloud Run is never called", { skip: !present && "CREATOR_REPO not set" }, async () => {
  const env = setup();
  try {
    const t = localPlan();
    let seen;
    const { code } = await cli(["node", "ds-build", t.plan, "--repo", t.proj, "--api"], {
      registry: env.registry,
      projectsRoot: t.root,
      taskRunner: async (task) => {
        seen = await launch(); // the cockpit tries to launch the same folder mid-run
        return { taskId: task.id, status: "success", durationMs: 1 };
      },
    });
    assert.equal(code, 0);
    assert.equal(seen.status, 409, JSON.stringify(seen.json));
    assert.equal(seen.json.held, true);
    assert.match(seen.json.error, HELD("demo-local", "local"));
    assert.equal(env.cloud.runJobCalls.length, 0, "no Cloud Run execution was created");
  } finally {
    env.restore();
  }
});

test("cloud vs local: a cloud claim on R makes the CLI exit 3 with the same held message", { skip: !present && "CREATOR_REPO not set" }, async () => {
  const env = setup();
  try {
    const launched = await launch();
    assert.equal(launched.status, 200, JSON.stringify(launched.json));
    assert.equal(env.cloud.runJobCalls.length, 1);
    const t = localPlan();
    let ran = false;
    const { code, errors } = await cli(["node", "ds-build", t.plan, "--repo", t.proj, "--api"], {
      registry: env.registry,
      projectsRoot: t.root,
      taskRunner: async (task) => { ran = true; return { taskId: task.id, status: "success", durationMs: 1 }; },
    });
    assert.equal(code, 3);
    assert.equal(ran, false, "nothing ran");
    const held = errors.map((l) => l.replace(/^✗ /, "")).find((l) => l.startsWith("held:"));
    assert.match(held ?? "", HELD("demo-plan", "cloud"));
  } finally {
    env.restore();
  }
});
