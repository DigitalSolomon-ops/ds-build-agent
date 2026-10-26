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
 *
 * Credentials: Application Default Credentials — point GOOGLE_APPLICATION_CREDENTIALS
 * at the handoff-watcher SA key (fenced to local-builds). Never print it.
 * Exit 0 = every assertion held; 1 = an assertion was violated; 2 = could not run.
 * Needs `npm run build` (imports dist/).
 *
 * Optional: WATCHER_REPO + a Python on PATH adds a mixed round to `race`
 * (3 TS + 2 Python children) via handoff-watcher's own child script.
 */
import { fork, spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = new URL("../dist/", import.meta.url);
const A = await import(new URL("airspace.js", DIST).href);
const L = await import(new URL("airspace-launch.js", DIST).href);
const PREFIX = "airspaceTest_";
const SELF = fileURLToPath(import.meta.url);
const HELD_RE = /^held: conflicts with .+ on /;

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const violations = [];
const check = (ok, what, detail = {}) => {
  out({ check: what, ok, ...detail });
  if (!ok) violations.push(what);
};

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
  await db.runTransaction(async (tx) => { tx.set(ref, { t: FieldValue.serverTimestamp(), who: "airspace-live probe" }); });
  const snap = await ref.get();
  check(snap.exists && !!snap.data()?.t, "probe: write + read back");
  await db.runTransaction(async (tx) => { tx.delete(ref); });
  check(!(await ref.get()).exists, "probe: delete");
}

async function race() {
  const reg = L.openAirspaceTestRegistry(PREFIX);
  const mixed = !!process.env.WATCHER_REPO && existsSync(join(process.env.WATCHER_REPO, "tests", "live_child.py"));
  const rounds = mixed ? 4 : 3;
  let exactlyOne = 0;
  for (let round = 1; round <= rounds; round++) {
    const resource = `path:airspace-test/race-${round}-${randomUUID().slice(0, 8)}`;
    const startAt = Date.now() + 8_000;
    const ids = Array.from({ length: 5 }, (_, i) => `race-${round}-${i}-${randomUUID().slice(0, 6)}`);
    const results = await Promise.all(ids.map((id, i) => {
      if (round === 4 && i >= 3) return pythonRaceChild(resource, id, startAt);
      const c = forkChild(["child-acquire", resource, id, String(startAt)]);
      return c.next((m) => m.runId === id);
    }));
    const granted = results.filter((r) => r.granted).length;
    const losersOk = results.filter((r) => !r.granted).every((r) => (r.message && HELD_RE.test(r.message)) || (r.error && /airspace:/.test(r.error)));
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
    const results = await Promise.all(ids.map((id) => {
      const c = forkChild(["child-acquire", `path:airspace-test/disjoint-${id}`, id, String(startAt)]);
      return c.next((m) => m.runId === id);
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
  check(samples.length === 20 && p95 <= 2_000, "disjoint: acquire p95 <= 2000 ms over 20 samples", { p95: Math.round(p95) });
}

async function crash() {
  const reg = L.openAirspaceTestRegistry(PREFIX);
  const resource = `path:airspace-test/crash-${randomUUID().slice(0, 8)}`;
  const id = `crash-${randomUUID().slice(0, 6)}`;
  const c = forkChild(["child-hold", resource, id, "normal"]);
  const got = await c.next((m) => m.runId === id && m.granted !== undefined);
  check(got.granted === true, "crash: child acquired");
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
  check(grantedAt !== undefined && grantedAt <= leaseEnd + heartbeat + rtt + 1_000,
    "crash: a new acquire is granted within lease + one heartbeat + one round-trip",
    { leaseEnd, grantedAt, slackMs: grantedAt ? Math.round(grantedAt - leaseEnd) : null });
  await cleanup(reg, [id, nextId]);
}

async function partition() {
  const reg = L.openAirspaceTestRegistry(PREFIX);
  const resource = `path:airspace-test/partition-${randomUUID().slice(0, 8)}`;
  const id = `part-${randomUUID().slice(0, 6)}`;
  const c = forkChild(["child-hold", resource, id, "partition"]);
  const got = await c.next((m) => m.runId === id && m.granted !== undefined);
  check(got.granted === true, "partition: child acquired");
  const fenced = await c.next((m) => m.runId === id && m.fenced_at !== undefined, 90_000);
  const margin = 2 * 15_000;
  check(fenced.fenced_at < got.lease_expires_at - margin + 2_000,
    "partition: the child fenced itself (anchored now) before lease_expires_at - margin",
    { fenced_at: fenced.fenced_at, lease_expires_at: got.lease_expires_at, reason: fenced.reason });
  killHard(c.child.pid);
  await cleanup(reg, [id]);
}

/* ── Main ─────────────────────────────────────────────────────────────────── */

const [mode, ...rest] = process.argv.slice(2);
if (mode === "child-acquire") await childAcquire(rest);
else if (mode === "child-hold") await childHold(rest);
else {
  const modes = { probe, race, disjoint, crash, partition };
  if (!modes[mode]) {
    console.error(`usage: node checks/airspace-live.mjs <${Object.keys(modes).join(" | ")}>`);
    process.exit(2);
  }
  try {
    await modes[mode]();
  } catch (e) {
    out({ mode, error: String(e?.message ?? e) });
    process.exit(2);
  }
  out({ mode, violations });
  process.exit(violations.length ? 1 : 0);
}
