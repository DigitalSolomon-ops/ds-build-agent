// Unit tests for the task write-boundary (whetstone W3), run against compiled
// dist/. Pure functions — no agent spawned. `npm test` builds first, so these
// import the freshly-compiled output.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePath,
  globToRegExp,
  inScope,
  filesOutsideScope,
  gateScopeResult,
} from "../dist/scope.js";

test("normalizePath: backslashes, leading ./ and / are stripped", () => {
  assert.equal(normalizePath("src\\a\\b.ts"), "src/a/b.ts");
  assert.equal(normalizePath("./src/a.ts"), "src/a.ts");
  assert.equal(normalizePath("/src/a.ts"), "src/a.ts");
});

test("glob: * stays within one segment", () => {
  assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/sub/a.ts"));
});

test("glob: ** crosses segments", () => {
  assert.ok(globToRegExp("src/**").test("src/a.ts"));
  assert.ok(globToRegExp("src/**").test("src/sub/deep/a.ts"));
  assert.ok(globToRegExp("a/**/c.ts").test("a/c.ts")); // ** swallows the slash
  assert.ok(globToRegExp("a/**/c.ts").test("a/b/c.ts"));
});

test("glob: a trailing slash means the whole directory", () => {
  assert.ok(globToRegExp("agent/src/").test("agent/src/x.py"));
  assert.ok(!globToRegExp("agent/src/").test("agent/other.py"));
});

test("glob: exact path matches only itself", () => {
  assert.ok(globToRegExp("config/trading_rules.yaml").test("config/trading_rules.yaml"));
  assert.ok(!globToRegExp("config/trading_rules.yaml").test("config/other.yaml"));
});

test("inScope: any-glob match, backslash paths normalize", () => {
  const scope = ["agent/src/robinhood_equity_client.py", "agent/tests/**"];
  assert.ok(inScope("agent\\src\\robinhood_equity_client.py", scope));
  assert.ok(inScope("agent/tests/test_x.py", scope));
  assert.ok(!inScope("agent/src/live_broker.py", scope));
});

test("filesOutsideScope: empty scope constrains nothing", () => {
  assert.deepEqual(filesOutsideScope(["anything.ts"], []), []);
});

test("filesOutsideScope: returns only the violators", () => {
  const scope = ["src/feature/**"];
  const files = ["src/feature/a.ts", "src/live_broker.py", "config/keys.env"];
  assert.deepEqual(filesOutsideScope(files, scope), ["src/live_broker.py", "config/keys.env"]);
});

test("gateScopeResult: a clean scoped task passes through unchanged", () => {
  const task = { id: "t", scope: ["src/feature/**"] };
  const result = { taskId: "t", status: "success", durationMs: 1, filesWritten: ["src/feature/a.ts"] };
  assert.equal(gateScopeResult(task, result), result); // same object, untouched
});

test("gateScopeResult: an out-of-scope write is downgraded to failed with the paths", () => {
  const task = { id: "equity-client", scope: ["agent/src/robinhood_equity_client.py"] };
  const result = {
    taskId: "equity-client",
    status: "success",
    durationMs: 1,
    filesWritten: ["agent/src/robinhood_equity_client.py", "agent/src/live_broker.py"],
  };
  const gated = gateScopeResult(task, result);
  assert.equal(gated.status, "failed");
  assert.match(gated.error, /live_broker\.py/);
  assert.match(gated.error, /Allowed:/);
});

test("gateScopeResult: no-op when the task has no scope", () => {
  const task = { id: "t" };
  const result = { taskId: "t", status: "success", durationMs: 1, filesWritten: ["anything.ts"] };
  assert.equal(gateScopeResult(task, result), result);
});

test("gateScopeResult: a failed task is never re-touched", () => {
  const task = { id: "t", scope: ["src/**"] };
  const result = { taskId: "t", status: "failed", durationMs: 1, error: "boom" };
  assert.equal(gateScopeResult(task, result), result);
});

test("gateScopeResult: missing filesWritten reads as no observed writes (passes)", () => {
  const task = { id: "t", scope: ["src/**"] };
  const result = { taskId: "t", status: "success", durationMs: 1 };
  assert.equal(gateScopeResult(task, result).status, "success");
});
