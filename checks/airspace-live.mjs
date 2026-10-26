#!/usr/bin/env node
/**
 * LIVE airspace checks against the real registry database (REGISTRY: project
 * digitalsolomon-creator, database local-builds), in collections prefixed
 * `airspaceTest_` so production claims are never touched. Every acquire runs in a
 * FORKED child with its own Firestore client: real cross-process contention.
 *
 *   node checks/airspace-live.mjs probe      write+read+delete a probe doc in one transaction
 *   node checks/airspace-live.mjs race       3 rounds x 5 children on one resource
 *   node checks/airspace-live.mjs disjoint   4 rounds x 5 children on disjoint resources (latency)
 *   node checks/airspace-live.mjs crash      a heartbeating child is killed; lease bounds checked
 *   node checks/airspace-live.mjs partition  a child whose renew hangs must fence itself in time
 *   node checks/airspace-live.mjs watcher    a ds-build-style local claim vs a real watcher claim loop (Python)
 *
 * Credentials: Application Default Credentials — point GOOGLE_APPLICATION_CREDENTIALS
 * at the handoff-watcher SA key (fenced to local-builds). Never print it.
 * Exit 0 = every assertion held; 1 = an assertion was violated (or the check could
 * not finish once it had started: a missing child message is a FAILED check);
 * 2 = BLOCKED before the first check, printed with its reason: `credential`
 * (PERMISSION_DENIED / UNAUTHENTICATED) or `transient` (UNAVAILABLE /
 * DEADLINE_EXCEEDED, after 3 attempts). Nothing else exits 2.
 * Needs `npm run build` (imports dist/).
 *
 * WATCHER_REPO + a Python on PATH (with the watcher's .deps on PYTHONPATH) adds a
 * mixed round to `race` (3 TS + 2 Python children) and powers `watcher`; with
 * AIRSPACE_CROSS_REPO=1 both are required.
 */
import { fork, spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = new URL("../dist/", import.meta.url);
const A = await import(new URL("airspace.js", DIST).href);
const L = await import(new URL("airspace-launch.js", DIST).href);
const PREFIX = "airspaceTest_";
const SELF = fileURLToPath(import.meta.url);
const HELD_RE = /^held: conflicts with .+ on /;
const CROSS = process.env.AIRSPACE_CROSS_REPO === "1";
let checksRun = 0;

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const violations = [];
const check = (ok, what, detail = {}) => {
  checksRun++;
  out({ check: what, ok, ...detail });
  if (!ok) violations.push(what);
  return ok;
};

/** A child message, or a FAILED check (never "could not run") when it does not arrive. */
async function expectMsg(c, pred, timeoutMs, what) {
  try {
    return await c.next(pred, timeoutMs);
  } catch (e) {
    check(false, what, { error: String(e?.message ?? e) });
    return undefined;
  }
}

/** gRPC / auth failures that make a live row BLOCKED rather than FAILED. */
function blockedReason(e) {
  const code = e?.code;
  const msg = String(e?.message ?? e);
  if (code === 7 || code === 16 || /PERMISSION_DENIED|UNAUTHENTICATED|Could not load the default credentials/i.test(msg)) return "credential";
  if (code === 14 || code === 4 || /UNAVAILABLE|DEADLINE_EXCEEDED/i.test(msg)) return "transient";
  return undefined;
}

/* ── Child modes (forked) ─────────────────────────────────────────────────── */

async function childAcquire([resource, runId, startAt]) {
  const reg = L.openAirspaceTestRegistry(PREFIX);
  await reg.now(); // anchor the clock before the start line
  const wait = Number(startAt) - Date.now();
  if (wait > 0) await sleep(wait);
  const t0 = performance.now();
  try {
    const r = await reg.acquire({ runId, planName: `live-${runId}`, lane: "local", resources: [resource], leaseMs: 60_000 });
    process.send({ runId, granted: r.granted, message: r.granted ? undefined : r.message, ms: performance.now() - t0 });
  } catch (e) {
    process.send({ runId, granted: false, error: String(e?.message ?? e), ms: performance.now() - t0 });
  }
  process.exit(0);
}

async function childHold([resource, runId, mode]) {
  const reg = L.openAirspaceTestRegistry(PREFIX);
  if (mode === "partition") {
    // After the acquire, every renewal hangs forever: the fence alone must stop us.
    const realAcquire = reg.acquire.bind(reg);
    reg.acquire = async (r) => {
      const res = await realAcquire(r);
      reg.renew = () => new Promise(() => {});
      return res;
    };
  }
  const claim = await L.claimAirspaceForRun({
    registry: reg, plan: { name: `live-${runId}`, airspace: [resource] }, runId, lane: "local",
    leaseMs: 60_000, heartbeatMs: 15_000,
  });
  if (!claim.granted) { process.send({ runId, granted: false, message: claim.message }); process.exit(0); }
  process.on("message", async (m) => {
    if (m === "release") { await claim.release(); process.send({ runId, released_at: await reg.now() }); process.exit(0); }
  });
  const c = (await reg.backend.listClaims("active")).find((x) => x.run_id === runId);
  process.send({ runId, granted: true, lease_expires_at: c?.lease_expires_at });
  claim.signal.addEventListener("abort", async () => {
    process.send({ runId, fenced_at: await reg.now().catch(() => NaN), reason: String(claim.signal.reason) });
  });
  setInterval(() => {}, 1_000);
}

/* ── Parent helpers ───────────────────────────────────────────────────────── */

function forkChild(args) {
  const child = fork(SELF, args, { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const messages = [];
  const waiters = [];
  child.on("message", (m) => { messages.push(m); waiters.splice(0).forEach((w) => w()); });
  return {
    child,
    next: async (pred = () => true, timeoutMs = 120_000) => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const hit = messages.find(pred);
        if (hit) return hit;
        if (Date.now() > until) throw new Error(`child ${args.join(" ")}: no message in ${timeoutMs} ms`);
        await new Promise((r) => { waiters.push(r); setTimeout(r, 500); });
      }
    },
  };
}

function killHard(pid) {
  if (process.platform === "win32") execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
  else process.kill(pid, "SIGKILL");
}

async function cleanup(reg, runIds) {
  for (const id of runIds) await reg.release(id).catch(() => {});
}

function watcherRepo() {
  const repo = process.env.WATCHER_REPO;
  const ok = !!repo && existsSync(join(repo, "tests", "live_child.py"));
  if (!ok && CROSS) throw Object.assign(new Error("WATCHER_REPO is not set or has no tests/live_child.py; AIRSPACE_CROSS_REPO=1 requires it"), { notBlocked: true });
  return ok ? repo : undefined;
}

function pythonRaceChild(resource, runId, startAt) {
  const repo = process.env.WATCHER_REPO;
  const script = repo && join(repo, "tests", "live_child.py");
  if (!script || !existsSync(script)) return undefined;
  return new Promise((resolve) => {
    const p = spawn("python", [script, "acquire", resource, runId, String(startAt), PREFIX], {
      cwd: repo, env: process.env, stdio: ["ignore", "pipe", "inherit"],
    });
    let buf = "";
    p.stdout.on("data", (d) => (buf += d));
    p.on("close", () => {
      try { resolve({ ...JSON.parse(buf.trim().split("\n").pop()), lang: "python" }); }
      catch { resolve({ runId, granted: false, error: `python child output unreadable: ${buf.slice(0, 200)}`, lang: "python" }); }
    });
  });
}

/* ── Modes ────────────────────────────────────────────────────────────────── */

async function probe() {
  const { Firestore, FieldValue } = await import("@google-cloud/firestore");
  const t = L.registryTarget();
  const db = new Firestore({ projectId: t.project, databaseId: t.database });
  const ref = db.collection(`${PREFIX}probe`).doc(randomUUID());
  // A transaction cannot read its own uncommitted write: write in one, then read
  // back and delete in a second, so the read and the delete are atomic together.
  await db.runTransaction(async (tx) => { tx.set(ref, { t: FieldValue.serverTimestamp(), who: "airspace-live probe" }); });
  const seen = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) tx.delete(ref);
    return snap.exists && !!snap.data()?.t;
  });
  check(seen, "probe: transactional write, then read back + delete in one transaction");
  check(!(await ref.get()).exists, "probe: the probe doc is gone");
}

async function race() {
  const reg = L.openAirspaceTestRegistry(PREFIX);
  const mixed = !!watcherRepo();
  const rounds = mixed ? 4 : 3;
  let exactlyOne = 0;
  for (let round = 1; round <= rounds; round++) {
    const resource = `path:airspace-test/race-${round}-${randomUUID().slice(0, 8)}`;
    const startAt = Date.now() + 8_000;
    const ids = Array.from({ length: 5 }, (_, i) => `race-${round}-${i}-${randomUUID().slice(0, 6)}`);
    const results = await Promise.all(ids.map(async (id, i) => {
      if (round === 4 && i >= 3) return pythonRaceChild(resource, id, startAt);
      const c = forkChild(["child-acquire", resource, id, String(startAt)]);
      return (await expectMsg(c, (m) => m.runId === id, 120_000, `race round ${round}: child ${id} reported`)) ?? { runId: id, granted: false, error: "no report" };
    }));
    const granted = results.filter((r) => r.granted).length;
    const losersOk = results.filter((r) => !r.granted).every((r) => (r.message && HELD_RE.test(r.message)) || (r.error && /^airspace:/.test(r.error)));
    out({ round, resource, granted, results: results.map((r) => ({ runId: r.runId, granted: r.granted, lang: r.lang ?? "ts", message: r.message ?? r.error })) });
    check(granted <= 1, `race round ${round}: at most one granted`, { granted });
    check(losersOk, `race round ${round}: every loser held with the conflict named, or refused fail-closed`);
    if (granted === 1) exactlyOne++;
    await cleanup(reg, ids);
  }
  check(exactlyOne >= Math.ceil((rounds * 2) / 3), `race: at least ${Math.ceil((rounds * 2) / 3)} of ${rounds} rounds grant exactly one`, { exactlyOne });
}

async function disjoint() {
  const reg = L.openAirspaceTestRegistry(PREFIX);
  const samples = [];
  for (let round = 1; round <= 4; round++) {
    const startAt = Date.now() + 8_000;
    const ids = Array.from({ length: 5 }, (_, i) => `dis-${round}-${i}-${randomUUID().slice(0, 6)}`);
    const results = await Promise.all(ids.map(async (id) => {
      const c = forkChild(["child-acquire", `path:airspace-test/disjoint-${id}`, id, String(startAt)]);
      return (await expectMsg(c, (m) => m.runId === id, 120_000, `disjoint round ${round}: child ${id} reported`)) ?? { runId: id, granted: false, ms: Infinity };
    }));
    for (const r of results) samples.push(r.ms);
    check(results.every((r) => r.granted), `disjoint round ${round}: all granted`, { results });
    const held = (await reg.backend.listHeld(500)).filter((h) => ids.includes(h.run_id));
    check(held.length === 0, `disjoint round ${round}: no held record written`, { held: held.length });
    await cleanup(reg, ids);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  out({ samples_ms: samples.map((x) => Math.round(x)) });
  // Bar set by Marcus on 2026-10-26 after the first live measurement: <= 3 s p95 for
  // 5 simultaneous launches (a lone launch is ~0.4 s); they queue on the one head doc.
  check(samples.length === 20 && p95 <= 3_000, "disjoint: acquire p95 <= 3000 ms over 20 samples (5 simultaneous)", { p95: Math.round(p95) });
}

async function crash() {
  const reg = L.openAirspaceTestRegistry(PREFIX);
  const resource = `path:airspace-test/crash-${randomUUID().slice(0, 8)}`;
  const id = `crash-${randomUUID().slice(0, 6)}`;
  const c = forkChild(["child-hold", resource, id, "normal"]);
  const got = await expectMsg(c, (m) => m.runId === id && m.granted !== undefined, 120_000, "crash: child reported its acquire");
  if (!got || !check(got.granted === true, "crash: child acquired")) return;
  await sleep(2_000);
  killHard(c.child.pid);
  const t0 = performance.now();
  await reg.now(); // anchored time
  const heartbeat = 15_000;
  // The child's heartbeat may have renewed before the kill: read the claim's real lease.
  const live = (await reg.backend.listClaims("active")).find((x) => x.run_id === id);
  const leaseEnd = live?.lease_expires_at ?? got.lease_expires_at;
  const probeAt = leaseEnd - 30_000;
  while ((await reg.now()) < probeAt) await sleep(1_000);
  const early = await reg.acquire({ runId: `crash-early-${randomUUID().slice(0, 6)}`, planName: "live-early", lane: "cloud", resources: [resource], leaseMs: 60_000 });
  check(!early.granted && early.message.includes(id), "crash: an acquire at lease - 30 s is held, naming the dead child", { message: early.message });
  let grantedAt;
  let rtt = 0;
  const nextId = `crash-next-${randomUUID().slice(0, 6)}`;
  for (;;) {
    const s = performance.now();
    const r = await reg.acquire({ runId: nextId, planName: "live-next", lane: "cloud", resources: [resource], leaseMs: 60_000 });
    rtt = Math.max(rtt, performance.now() - s);
    if (r.granted) { grantedAt = await reg.now(); break; }
    if (performance.now() - t0 > 150_000) break;
    await sleep(1_000);
  }
  check(grantedAt !== undefined && grantedAt <= leaseEnd + heartbeat + rtt,
    "crash: a new acquire is granted within lease + one heartbeat + one round-trip",
    { leaseEnd, grantedAt, slackMs: grantedAt ? Math.round(grantedAt - leaseEnd) : null });
  await cleanup(reg, [id, nextId]);
}

async function partition() {
  const reg = L.openAirspaceTestRegistry(PREFIX);
  const resource = `path:airspace-test/partition-${randomUUID().slice(0, 8)}`;
  const id = `part-${randomUUID().slice(0, 6)}`;
  const c = forkChild(["child-hold", resource, id, "partition"]);
  const got = await expectMsg(c, (m) => m.runId === id && m.granted !== undefined, 120_000, "partition: child reported its acquire");
  if (!got || !check(got.granted === true, "partition: child acquired")) return;
  const fenced = await expectMsg(c, (m) => m.runId === id && m.fenced_at !== undefined, 90_000, "partition: the child fenced itself at all");
  if (!fenced) { killHard(c.child.pid); return; }
  const margin = 2 * 15_000;
  check(fenced.fenced_at < got.lease_expires_at - margin + 2_000,
    "partition: the child fenced itself (anchored now) before lease_expires_at - margin",
    { fenced_at: fenced.fenced_at, lease_expires_at: got.lease_expires_at, reason: fenced.reason });
  killHard(c.child.pid);
  await cleanup(reg, [id]);
}

async function watcher() {
  const repo = watcherRepo();
  if (!repo) {
    out({ mode: "watcher", blocked: "not-configured", note: "set WATCHER_REPO (and AIRSPACE_CROSS_REPO=1 to require it)" });
    return;
  }
  const reg = L.openAirspaceTestRegistry(PREFIX);
  // A throwaway Projects tree: the watcher keys the project folder relative to it.
  const root = mkdtempSync(join(tmpdir(), "ds-live-watch-"));
  writeFileSync(join(root, "studio.yaml"), "studio: live-check\n");
  const rel = `portfolios/internal-tools/live-${randomUUID().slice(0, 8)}`;
  mkdirSync(join(root, ...rel.split("/")), { recursive: true });
  const resource = `path:${rel}`;
  const id = `plan-${randomUUID().slice(0, 6)}`;
  const poll = 5;
  const holder = forkChild(["child-hold", resource, id, "normal"]);
  const got = await expectMsg(holder, (m) => m.runId === id && m.granted !== undefined, 120_000, "watcher: the ds-build-style claim reported");
  if (!got || !check(got.granted === true, "watcher: the ds-build-style local claim is held")) return;
  const py = spawn("python", [join(repo, "tests", "live_child.py"), "watch", root, rel, PREFIX, String(poll)], {
    cwd: repo, env: process.env, stdio: ["ignore", "pipe", "inherit"],
  });
  const events = [];
  let buf = "";
  py.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) { try { events.push(JSON.parse(line)); } catch { /* ignore non-JSON */ } }
    }
  });
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const e = events.find(pred); if (e) return e; await sleep(200); }
    return undefined;
  };
  const held = await waitFor((e) => e.event === "held", 120_000);
  check(!!held && HELD_RE.test(held.message ?? "") && held.message.includes(id), "watcher: the watcher job is held, naming the plan run", { message: held?.message });
  holder.child.send("release");
  const rel_ = await expectMsg(holder, (m) => m.runId === id && m.released_at !== undefined, 60_000, "watcher: the plan run released");
  const started = await waitFor((e) => e.event === "started" || e.event === "timeout", 120_000);
  const bound = poll * 1_000 + 2_000; // one poll + one transaction (generous round-trip)
  check(!!rel_ && started?.event === "started" && started.at_ms - rel_.released_at <= bound,
    "watcher: the job starts on the first poll after release (<= POLL_SECONDS + 1 transaction)",
    { released_at: rel_?.released_at, started_at: started?.at_ms, waitedMs: started?.at_ms && rel_ ? Math.round(started.at_ms - rel_.released_at) : null });
  py.kill();
  await cleanup(reg, [id]);
}

/* ── Main ─────────────────────────────────────────────────────────────────── */

const [mode, ...rest] = process.argv.slice(2);
if (mode === "child-acquire") await childAcquire(rest);
else if (mode === "child-hold") await childHold(rest);
else {
  const modes = { probe, race, disjoint, crash, partition, watcher };
  if (!modes[mode]) {
    console.error(`usage: node checks/airspace-live.mjs <${Object.keys(modes).join(" | ")}>`);
    process.exit(2);
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await modes[mode]();
      break;
    } catch (e) {
      const reason = e?.notBlocked ? undefined : blockedReason(e);
      out({ mode, attempt, error: String(e?.message ?? e), code: e?.code, blocked: reason });
      // Once a check has run, any error is a FAILURE: the row started and did not finish.
      if (checksRun > 0 || !reason) process.exit(1);
      if (reason === "credential") { out({ mode, result: "BLOCKED", reason }); process.exit(2); }
      if (attempt >= 3) { out({ mode, result: "BLOCKED", reason: "transient" }); process.exit(2); }
      await sleep(5_000);
    }
  }
  out({ mode, violations });
  process.exit(violations.length ? 1 : 0);
}
