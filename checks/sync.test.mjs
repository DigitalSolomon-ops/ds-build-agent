/**
 * Sync on command (Workstream 1 acceptance) and the Local Builds plan runner.
 * Offline: a throwaway Projects tree in a temp dir and an in-memory backend
 * standing in for The Creator's Firestore + bucket.
 *
 * Run with: node --test checks/sync.test.mjs   (npm test builds dist/ first)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const DIST = new URL("../dist/", import.meta.url);
const S = await import(new URL("sync.js", DIST).href);
const R = await import(new URL("local-runner.js", DIST).href);
const { validatePlan } = await import(new URL("parser.js", DIST).href);

const PLAN = `name: fig-build
airspace:
  paths: [portfolios/own-products/fig]
  ghl_pipelines: ["Partner Sales"]
deploy_policy:
  launch_gate: true
tasks:
  - id: a
    phase: 1-build
    prompt: build a
  - id: qa
    phase: 6-qa
    prompt: qa
    deps: [a]
  - id: go
    phase: 7-launch
    executor: human
    prompt: go live
    deps: [qa]
`;

function tree() {
  const root = mkdtempSync(join(tmpdir(), "ds-sync-"));
  writeFileSync(join(root, "studio.yaml"), "studio: test\n");
  const mk = (rel, files) => {
    const d = join(root, rel);
    mkdirSync(d, { recursive: true });
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(join(d, f, ".."), { recursive: true });
      writeFileSync(join(d, f), body);
    }
    return d;
  };
  return { root, mk };
}

function memBackend() {
  const docs = new Map();
  const uploads = new Map();
  const calls = { put: 0, upload: 0 };
  return {
    docs, uploads, calls,
    async getProject(id) { return docs.has(id) ? structuredClone(docs.get(id)) : undefined; },
    async putProject(doc) { calls.put++; docs.set(doc.projectId, { ...docs.get(doc.projectId), ...structuredClone(doc) }); },
    async uploadPlan(id, yaml) { calls.upload++; uploads.set(id, yaml); return `gs://test-creator/plans/${id}.plan.yaml`; },
  };
}

test("ACCEPT 1: sync on a project with an existing plan queues it without changes to the plan", async () => {
  const { root, mk } = tree();
  const dir = mk("portfolios/own-products/fig", { "plans/fig.plan.yaml": PLAN, "project.yaml": "project: { key: fig }\n" });
  const b = memBackend();
  const r = await S.syncProject({ projectArg: "portfolios/own-products/fig", root, backend: b, now: 1000 });
  assert.equal(r.action, "queued", r.message);
  assert.equal(r.syncState, "dry-run");
  assert.equal(readFileSync(join(dir, "plans/fig.plan.yaml"), "utf8"), PLAN, "plan file untouched");
  assert.equal(b.uploads.get(r.projectId), PLAN, "the uploaded record is the plan, byte for byte");
  const doc = b.docs.get(r.projectId);
  assert.equal(doc.state, "drafted", "awaiting Launch, nothing executes");
  assert.equal(doc.syncState, "dry-run");
  assert.equal(doc.source, "sync");
  assert.equal(doc.planPath, "portfolios/own-products/fig/plans/fig.plan.yaml");
  assert.equal(doc.localPath, "portfolios/own-products/fig");
  assert.deepEqual(doc.lanes, ["local", "cloud"], "one record, visible to both lanes");
  assert.deepEqual(doc.airspace, ["ghl_pipeline:Partner Sales", "path:portfolios/own-products/fig"]);
  assert.deepEqual(doc.dryRun, { wouldBuild: 2, deferred: 1, skipped: 0, tasks: 3 });
  assert.match(doc.planUri, /^gs:\/\//);
});

test("ACCEPT 2: sync on a project with no plan produces one and stops for review", async () => {
  const { root, mk } = tree();
  mk("portfolios/internal-tools/newthing", { "project.yaml": "project:\n  key: newthing\n  purpose: A new internal tool.\n" });
  const b = memBackend();
  const r = await S.syncProject({ projectArg: "newthing", root, backend: b });
  assert.equal(r.action, "generated-for-review", r.message);
  assert.equal(r.syncState, "review");
  const doc = b.docs.get(r.projectId);
  assert.equal(doc.syncState, "review", "the record cannot launch until reviewed");
  assert.equal(doc.planSource, "generated");
  // The draft is a VALID plan with a drafted airspace block, ready to edit.
  const plan = validatePlan(parseYaml(r.draft), { quiet: true });
  assert.equal(plan.name, "newthing");
  assert.deepEqual(plan.airspace, ["path:portfolios/internal-tools/newthing"]);
  assert.equal(plan.tasks[0].executor, "human", "first task is the human review");
});

test("ACCEPT 3: re-running sync on an already queued project is a no-op, not a second copy", async () => {
  const { root, mk } = tree();
  mk("portfolios/own-products/fig", { "plan.yaml": PLAN });
  const b = memBackend();
  const first = await S.syncProject({ projectArg: "fig", root, backend: b });
  assert.equal(first.action, "queued");
  const before = { ...b.calls };
  const again = await S.syncProject({ projectArg: "fig", root, backend: b });
  assert.equal(again.action, "unchanged", again.message);
  assert.equal(again.projectId, first.projectId, "same record id");
  assert.deepEqual(b.calls, before, "nothing written: no upload, no record write");
  assert.equal(b.docs.size, 1, "exactly one record");
  // Generated drafts are idempotent too.
  mk("portfolios/own-products/empty", {});
  const g1 = await S.syncProject({ projectArg: "empty", root, backend: b });
  const g2 = await S.syncProject({ projectArg: "empty", root, backend: b });
  assert.equal(g1.action, "generated-for-review");
  assert.equal(g2.action, "unchanged");
  assert.equal(b.docs.size, 2);
});

test("sync: a changed plan updates the same record; a running record is refused", async () => {
  const { root, mk } = tree();
  const dir = mk("portfolios/own-products/fig", { "plan.yaml": PLAN });
  const b = memBackend();
  const first = await S.syncProject({ projectArg: "fig", root, backend: b, now: 1 });
  writeFileSync(join(dir, "plan.yaml"), PLAN.replace("build a", "build a better"));
  const upd = await S.syncProject({ projectArg: "fig", root, backend: b, now: 2 });
  assert.equal(upd.action, "updated");
  assert.equal(upd.projectId, first.projectId);
  assert.equal(b.docs.get(first.projectId).createdAt, 1, "createdAt survives an update");
  b.docs.get(first.projectId).localLaunch = { state: "running" };
  writeFileSync(join(dir, "plan.yaml"), PLAN.replace("build a", "build c"));
  const busy = await S.syncProject({ projectArg: "fig", root, backend: b });
  assert.equal(busy.action, "refused");
  assert.match(busy.message, /running/);
});

test("sync: a plan with no airspace is queued as needs-airspace with a drafted block", async () => {
  const { root, mk } = tree();
  mk("portfolios/own-products/old", { "plan.yaml": "name: old\ntasks:\n  - id: a\n    prompt: x\n" });
  const b = memBackend();
  const r = await S.syncProject({ projectArg: "old", root, backend: b });
  assert.equal(r.action, "queued");
  assert.equal(r.syncState, "needs-airspace");
  const doc = b.docs.get(r.projectId);
  assert.equal(doc.airspace, undefined);
  assert.match(doc.airspaceDraft, /paths:\n\s+- portfolios\/own-products\/old/);
});

test("sync: discovery honours project.yaml spine.plan, refuses ambiguity and invalid plans", async () => {
  const { root, mk } = tree();
  mk("portfolios/client-work/acme/app", {
    "../client.yaml": "client: acme\n",
    "project.yaml": "spine:\n  plan: ../plans/app.plan.yaml\n",
    "../plans/app.plan.yaml": PLAN,
  });
  const b = memBackend();
  const r = await S.syncProject({ projectArg: "app", root, backend: b });
  assert.equal(r.action, "queued", r.message);
  assert.equal(r.planPath, "portfolios/client-work/acme/plans/app.plan.yaml");

  mk("portfolios/own-products/two", { "plans/a.yaml": PLAN, "plans/b.yaml": PLAN });
  const two = await S.syncProject({ projectArg: "two", root, backend: b });
  assert.equal(two.action, "refused");
  assert.match(two.message, /several plans/);

  mk("portfolios/own-products/bad", { "plan.yaml": "name: bad\nairspace: [path:x]\ntasks: []\n" });
  const bad = await S.syncProject({ projectArg: "bad", root, backend: b });
  assert.equal(bad.action, "refused");
  assert.match(bad.message, /invalid/);
});

test("sync --dry-run previews and writes nothing", async () => {
  const { root, mk } = tree();
  mk("portfolios/own-products/fig", { "plan.yaml": PLAN });
  const b = memBackend();
  const r = await S.syncProject({ projectArg: "fig", root, backend: b, dryRun: true });
  assert.match(r.message, /\[preview\]/);
  assert.deepEqual(b.calls, { put: 0, upload: 0 });
});

/* ── Local Builds runner ───────────────────────────────────────────────────── */

function runnerBackend(records) {
  const queue = [...records];
  const updates = [];
  return {
    updates,
    async claimNext() { return queue.shift(); },
    async update(id, patch) { updates.push({ id, ...patch }); },
    async downloadPlan() { return PLAN; },
    async beat() {},
  };
}
const rec = (id, runId) => ({
  projectId: id, name: id, planUri: "gs://b/p.yaml", localPath: "portfolios/own-products/fig",
  localLaunch: { state: "running", runId, requestedAt: 1 },
});

test("runner: runs the CLI with the cockpit's run id (adopt) in-place, records done", async () => {
  const b = runnerBackend([rec("p1", "local-abc")]);
  let seen;
  const n = await R.runnerPass({
    backend: b, projectsRoot: "/projects", host: "blacktop",
    spawnRun: async (args, onLine) => { seen = args; onLine("▸ Plan: fig-build"); return 0; },
  });
  assert.deepEqual(n, ["p1"]);
  assert.ok(seen[0].endsWith("p1.plan.yaml"));
  assert.equal(seen[seen.indexOf("--run-id") + 1], "local-abc");
  assert.equal(seen[seen.indexOf("--concurrency") + 1], "3");
  assert.match(seen[seen.indexOf("--repo") + 1].replace(/\\/g, "/"), /portfolios\/own-products\/fig$/);
  const last = b.updates.at(-1);
  assert.equal(last.state, "done");
  assert.equal(last.exitCode, 0);
});

test("runner: an airspace hold (exit 3) is recorded as held with the CLI's message", async () => {
  const b = runnerBackend([rec("p2", "local-def")]);
  await R.runnerPass({
    backend: b, projectsRoot: "/projects",
    spawnRun: async (_a, onLine) => {
      onLine("✗ held: conflicts with fast-insurance-group on ghl_pipeline:Partner Sales [run cloud-1, cloud lane]");
      return 3;
    },
  });
  const last = b.updates.at(-1);
  assert.equal(last.state, "held");
  assert.match(last.message, /^held: conflicts with fast-insurance-group on ghl_pipeline:Partner Sales/);
});

test("runner: log lines are redacted before they leave blacktop", () => {
  assert.equal(R.redact("key sk-ant-api03-abcdefghijkl and ghp_abcdefghijklmnop"), "key [redacted] and [redacted]");
  assert.equal(R.redact("Authorization: Bearer abc.def.ghijklmnop"), "Authorization: Bearer [redacted]");
  assert.equal(R.stateForExit(0), "done");
  assert.equal(R.stateForExit(3), "held");
  assert.equal(R.stateForExit(1), "failed");
  assert.equal(R.stateForExit(null), "failed");
});

test("sync: a same-named stray folder at the Projects root is never taken for the project", async () => {
  const { root, mk } = tree();
  mk("fig", { "plan.yaml": PLAN.replace("fig-build", "stray") });           // pre-migration leftover
  mk("portfolios/own-products/fig", { "plan.yaml": PLAN });
  const r = await S.syncProject({ projectArg: "fig", root, backend: memBackend() });
  assert.equal(r.action, "queued", r.message);
  assert.equal(r.planPath, "portfolios/own-products/fig/plan.yaml");
  const only = tree();
  only.mk("loose", { "plan.yaml": PLAN });
  const refused = await S.syncProject({ projectArg: "loose", root: only.root, backend: memBackend() });
  assert.equal(refused.action, "refused");
});
