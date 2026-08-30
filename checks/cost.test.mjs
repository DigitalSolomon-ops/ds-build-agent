// Unit tests for the local per-run cost cap (parity with the cloud runner).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRunCapUsd, DEFAULT_RUN_CAP_USD, CostAccumulator } from "../dist/cost.js";

test("precedence: --max-usd flag beats plan, env, and default", () => {
  assert.equal(resolveRunCapUsd(10, "20", "5"), 5);
});

test("precedence: plan cap beats env and default when no flag", () => {
  assert.equal(resolveRunCapUsd(10, "20", undefined), 10);
});

test("precedence: env used when no flag and no plan cap", () => {
  assert.equal(resolveRunCapUsd(undefined, "20", undefined), 20);
});

test("falls back to the default floor when nothing is set", () => {
  assert.equal(resolveRunCapUsd(undefined, undefined, undefined), DEFAULT_RUN_CAP_USD);
});

test("non-positive / non-finite values are ignored at every level", () => {
  assert.equal(resolveRunCapUsd(0, "0", "-5"), DEFAULT_RUN_CAP_USD);
  assert.equal(resolveRunCapUsd(NaN, "abc", ""), DEFAULT_RUN_CAP_USD);
  // a bad flag falls through to the plan cap
  assert.equal(resolveRunCapUsd(12, undefined, "notanumber"), 12);
});

test("CostAccumulator sums build + verify cost and reports total", () => {
  const c = new CostAccumulator();
  c.add(1.5, 0.5); // build + verify
  c.add(2.0, undefined); // build only
  c.add(undefined, undefined); // a task with no usage adds nothing
  assert.equal(c.total, 4.0);
});

test("CostAccumulator.reached flips at the cap", () => {
  const c = new CostAccumulator();
  c.add(4.99);
  assert.equal(c.reached(5), false);
  c.add(0.02);
  assert.equal(c.reached(5), true); // 5.01 >= 5
});

test("CostAccumulator ignores NaN/Infinity so a bad usage report can't poison the sum", () => {
  const c = new CostAccumulator();
  c.add(3.0);
  c.add(NaN, Infinity);
  assert.equal(c.total, 3.0);
});
