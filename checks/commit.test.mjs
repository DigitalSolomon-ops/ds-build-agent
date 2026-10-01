// Per-task commit attribution, run against compiled dist/. Drives the real
// orchestrator + git with a fake build runner (the `taskRunner` seam), so no
// agent is spawned. Regression for the video-engine wave-1 run, where a task
// that finished first committed its concurrent siblings' half-written files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { orchestrate } from "../dist/orchestrator.js";
import { validatePlan } from "../dist/parser.js";
import { gateScopeResult } from "../dist/scope.js";
import { sharedContext } from "../dist/prompt.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (repo, ...args) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const newRepo = () => mkdtempSync(join(tmpdir(), "ds-commit-"));
const write = (repo, rel, body = rel) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), body);
};

const task = (id, deps = []) => ({
  id, title: `Task ${id}`, brief: "x", executor: "agent", auto: true, phase: "1", deps,
  outputs: [], acceptance: [],
});
const plan = (tasks) => ({ name: "commit-test", policy: { commitAfterEachTask: true }, tasks });

/** Commit subjects, oldest first. Empty when the repo has no commits. */
const subjects = (repo) => {
  try { return git(repo, "log", "--reverse", "--format=%s").trim().split("\n").filter(Boolean); }
  catch { return []; }
};
/** Files changed by the commit whose subject starts with `<id>:`. */
const filesIn = (repo, id) => {
  const sha = git(repo, "log", "--format=%H", `--grep=^${id}:`).trim().split("\n")[0];
  assert.ok(sha, `no commit for ${id}`);
  return git(repo, "show", "--name-only", "--format=", sha).trim().split("\n").filter(Boolean).sort();
};

/**
 * A fake runner driven by a per-task script: each step either writes a file
 * (observed → filesWritten, like a Write/Edit call), writes one unobserved
 * (like a Bash redirect), deletes one, or waits.
 */
const fakeRunner = (scripts) => async (t, _plan, repo) => {
  const observed = [];
  for (const step of scripts[t.id] ?? []) {
    if (step.wait) await sleep(step.wait);
    if (step.write) { write(repo, step.write); observed.push(step.write); }
    if (step.shellWrite) write(repo, step.shellWrite);
    if (step.delete) { rmSync(join(repo, step.delete)); observed.push(step.delete); }
  }
  return { taskId: t.id, status: "success", summary: "ok", durationMs: 0, filesWritten: observed };
};

test("two concurrent tasks each commit only their own files", async () => {
  const repo = newRepo();
  // A writes its file, then finishes while B is mid-way: B's first file is
  // already on disk (half-done), its second not yet written.
  const scripts = {
    assets: [{ write: "src/assets/a.ts" }, { wait: 80 }],
    slides: [{ wait: 20 }, { write: "src/slides/s1.ts" }, { wait: 200 }, { write: "src/slides/s2.ts" }],
  };
  const results = await orchestrate(plan([task("assets"), task("slides")]), {
    repoPath: repo, concurrency: 3, taskRunner: fakeRunner(scripts),
  });
  assert.deepEqual(results.map((r) => r.status), ["success", "success"]);
  assert.deepEqual(subjects(repo), ["assets: Task assets", "slides: Task slides"]);
  assert.deepEqual(filesIn(repo, "assets"), ["src/assets/a.ts"]);
  assert.deepEqual(filesIn(repo, "slides"), ["src/slides/s1.ts", "src/slides/s2.ts"]);
  assert.equal(git(repo, "status", "--porcelain").trim(), "");
});

test("a concurrent task that writes nothing makes no commit", async () => {
  const repo = newRepo();
  const scripts = {
    idle: [{ wait: 30 }],
    busy: [{ write: "b.txt" }, { wait: 120 }],
  };
  await orchestrate(plan([task("idle"), task("busy")]), {
    repoPath: repo, concurrency: 2, taskRunner: fakeRunner(scripts),
  });
  // `idle` finished first, while busy's b.txt sat uncommitted on disk.
  assert.deepEqual(subjects(repo), ["busy: Task busy"]);
  assert.deepEqual(filesIn(repo, "busy"), ["b.txt"]);
});

test("a solo task that writes nothing makes no commit", async () => {
  const repo = newRepo();
  await orchestrate(plan([task("noop")]), {
    repoPath: repo, concurrency: 1, taskRunner: fakeRunner({ noop: [] }),
  });
  assert.deepEqual(subjects(repo), []);
});

test("sequential run keeps git add -A: shell-only writes are still committed", async () => {
  const repo = newRepo();
  const scripts = {
    t1: [{ write: "src/a.ts" }, { shellWrite: "package-lock.json" }],
    t2: [{ shellWrite: "dist/out.js" }],
  };
  await orchestrate(plan([task("t1"), task("t2", ["t1"])]), {
    repoPath: repo, concurrency: 3, taskRunner: fakeRunner(scripts),
  });
  assert.deepEqual(filesIn(repo, "t1"), ["package-lock.json", "src/a.ts"]);
  assert.deepEqual(filesIn(repo, "t2"), ["dist/out.js"]);
});

test("concurrent task: a deleted tracked file is committed as a deletion", async () => {
  const repo = newRepo();
  write(repo, "old.ts");
  git(repo, "init", "-q");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  const scripts = {
    del: [{ write: "new.ts" }, { delete: "old.ts" }, { write: "tmp.ts" }, { delete: "tmp.ts" }],
    other: [{ write: "o.ts" }, { wait: 100 }],
  };
  await orchestrate(plan([task("del"), task("other")]), {
    repoPath: repo, concurrency: 2, taskRunner: fakeRunner(scripts),
  });
  assert.deepEqual(filesIn(repo, "del"), ["new.ts", "old.ts"]);
  assert.match(git(repo, "show", "--name-status", "--format=", "HEAD~1"), /^D\s+old\.ts/m);
  assert.deepEqual(filesIn(repo, "other"), ["o.ts"]);
});

test("concurrent codex task (writes unobservable) is not committed over its sibling", async () => {
  const repo = newRepo();
  const codex = { ...task("cx"), executor: "codex" };
  const scripts = {
    cx: [{ shellWrite: "cx.ts" }],
    ag: [{ write: "ag.ts" }, { wait: 100 }],
  };
  const logs = [];
  await orchestrate(plan([codex, task("ag")]), {
    repoPath: repo, concurrency: 2, taskRunner: fakeRunner(scripts),
    onEvent: (e) => { if (e.type === "task-log") logs.push(e.text); },
  });
  assert.deepEqual(subjects(repo), ["ag: Task ag"]);
  assert.deepEqual(filesIn(repo, "ag"), ["ag.ts"]);
  assert.ok(logs.some((l) => l.startsWith("Commit skipped")));
});

test("shared_files: plan- and task-level globs widen a scoped task's boundary", () => {
  const p = validatePlan({
    name: "s",
    shared_files: ["tsconfig.json"],
    tasks: [
      { id: "a", brief: "x", scope: ["src/a/**"], shared_files: ["src/index.ts"] },
      { id: "b", brief: "x" },
    ],
  }, { quiet: true });
  const [a, b] = p.tasks;
  assert.deepEqual(a.sharedFiles, ["src/index.ts", "tsconfig.json"]);
  const ok = { taskId: "a", status: "success", durationMs: 0,
    filesWritten: ["src/a/x.ts", "tsconfig.json", "src/index.ts"] };
  assert.equal(gateScopeResult(a, ok).status, "success");
  const bad = { ...ok, filesWritten: ["src/b/y.ts"] };
  assert.equal(gateScopeResult(a, bad).status, "failed");
  // An unscoped task stays unconstrained — shared_files never creates a scope.
  assert.equal(gateScopeResult(b, bad).status, "success");
});

test("shared_files is a known key (no ignored-key warning)", () => {
  let warnings = [];
  validatePlan({ name: "s", shared_files: ["x"], tasks: [{ id: "a", brief: "x", shared_files: ["y"] }] },
    { quiet: true, onWarnings: (w) => { warnings = w; } });
  assert.deepEqual(warnings.filter((w) => w.includes("shared_files")), []);
});

test("agent context tells build agents not to commit", () => {
  const ctx = sharedContext({ name: "x", policy: { commitAfterEachTask: true }, tasks: [] });
  assert.match(ctx, /Do NOT run git commands/);
  assert.match(ctx, /git commit/);
});
