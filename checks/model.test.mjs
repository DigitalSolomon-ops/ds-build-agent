/**
 * Unit tests for the per-task model resolver (harness P10). Drives the COMPILED
 * dist/model.js — SDK-free, so no Agent SDK is dragged in. `npm test` builds dist/
 * first. Run alone: node --test checks/model.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const DIST = new URL("../dist/", import.meta.url);
const { resolveModel, explainModel, modelRank, sensitivityFloor } = await import(
  new URL("model.js", DIST).href
);

test("routine task is NOT escalated (the negative half of the accept)", () => {
  assert.equal(resolveModel({ model: "haiku" }, {}), "haiku");
  assert.equal(resolveModel({ model: "sonnet" }, {}), "sonnet");
  assert.equal(resolveModel({}, {}), "sonnet"); // DEFAULT_MODEL
});

test("a sensitive task escalates up to the floor", () => {
  assert.equal(resolveModel({ model: "haiku", sensitivity: ["send"] }, {}), "opus");
  assert.equal(resolveModel({ sensitivity: ["consent"] }, {}), "opus"); // base = default sonnet
  assert.equal(resolveModel({ sensitivity: ["security"] }, { model: "haiku" }), "opus"); // plan default is base
});

test("an explicit stronger model is never downgraded", () => {
  assert.equal(resolveModel({ model: "opus", sensitivity: ["compliance"] }, {}), "opus");
});

test("equal-tier keeps the exact base string (no alias rewrite)", () => {
  assert.equal(resolveModel({ model: "claude-opus-4-8", sensitivity: ["money"] }, {}), "claude-opus-4-8");
});

test("an unknown/custom base id is respected, never touched", () => {
  assert.equal(resolveModel({ model: "gpt-4o", sensitivity: ["send"] }, {}), "gpt-4o");
  assert.equal(explainModel({ model: "gpt-4o", sensitivity: ["send"] }, {}).escalated, false);
});

test("modelRank classifies aliases and full ids by substring", () => {
  assert.equal(modelRank("claude-haiku-4-5"), 1);
  assert.equal(modelRank("us.anthropic.claude-sonnet-4-5"), 2);
  assert.equal(modelRank("claude-opus-4-8"), 3);
  assert.equal(modelRank("gpt-4o"), undefined);
});

test("multi-tag takes the strongest floor; unrecognized tags contribute nothing", () => {
  assert.equal(sensitivityFloor(["send", "review"]), "opus");
  assert.equal(sensitivityFloor(["nonsense"]), undefined);
  assert.equal(sensitivityFloor([]), undefined);
});

test("explainModel returns the full decision shape", () => {
  assert.deepEqual(explainModel({ model: "haiku", sensitivity: ["send"] }, {}), {
    base: "haiku",
    resolved: "opus",
    escalated: true,
    floorTier: "opus",
    tags: ["send"],
  });
});
