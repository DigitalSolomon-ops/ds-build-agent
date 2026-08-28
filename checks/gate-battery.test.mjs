// Unit tests for gate-battery analysis (whetstone W1), against compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeGateBattery } from "../dist/gate-battery.js";

// Minimal plan factory — only the fields the analyzer reads.
const plan = (tasks, gatedPhase) => ({
  name: "t",
  policy: { commitAfterEachTask: false, gatedPhase },
  tasks: tasks.map((t) => ({ title: t.id, brief: "x", auto: t.executor === "agent", ...t })),
});

test("a gate with no deps is front-loadable", () => {
  const b = analyzeGateBattery(plan([{ id: "creds", executor: "human" }]));
  assert.deepEqual(b.battery.map((t) => t.id), ["creds"]);
  assert.equal(b.sequentialGates.length, 0);
});

test("a gate depending on an agent task is sequential, not front-loadable", () => {
  const b = analyzeGateBattery(
    plan([
      { id: "build", executor: "agent" },
      { id: "arm", executor: "human", deps: ["build"] },
    ]),
  );
  assert.deepEqual(b.battery.map((t) => t.id), []);
  assert.deepEqual(b.sequentialGates.map((t) => t.id), ["arm"]);
});

test("transitive agent dependency makes a gate sequential", () => {
  const b = analyzeGateBattery(
    plan([
      { id: "build", executor: "agent" },
      { id: "readiness", executor: "agent", deps: ["build"] },
      { id: "arm", executor: "human", deps: ["readiness"] },
    ]),
  );
  assert.deepEqual(b.sequentialGates.map((t) => t.id), ["arm"]);
});

test("a gate depending only on other human gates is still front-loadable", () => {
  const b = analyzeGateBattery(
    plan([
      { id: "gcp", executor: "human" },
      { id: "repo", executor: "human", deps: ["gcp"] },
    ]),
  );
  assert.deepEqual(b.battery.map((t) => t.id), ["gcp", "repo"]);
});

test("unattended count excludes agent tasks that wait on a sequential gate", () => {
  const b = analyzeGateBattery(
    plan([
      { id: "build", executor: "agent" }, // unattended
      { id: "arm", executor: "human", deps: ["build"] }, // sequential gate
      { id: "post", executor: "agent", deps: ["arm"] }, // waits on sequential gate
    ]),
  );
  assert.equal(b.totalAgentCount, 2);
  assert.equal(b.unattendedAgentCount, 1); // only "build"
});

test("gatedPhase (launch gate) tasks are not counted as unattended", () => {
  const b = analyzeGateBattery(
    plan(
      [
        { id: "build", phase: "2", executor: "agent" },
        { id: "golive", phase: "7", executor: "agent" },
      ],
      "7",
    ),
  );
  assert.equal(b.unattendedAgentCount, 1); // "golive" is held behind the launch gate
});

test("lateGates: a front-loadable gate authored after the first agent task is flagged", () => {
  const b = analyzeGateBattery(
    plan([
      { id: "build", executor: "agent" },
      { id: "readonly-creds", executor: "human" }, // no deps → front-loadable, but placed late
    ]),
  );
  assert.deepEqual(b.battery.map((t) => t.id), ["readonly-creds"]);
  assert.deepEqual(b.lateGates.map((t) => t.id), ["readonly-creds"]);
});

test("no lateGates when the front-loadable gate precedes all agent tasks", () => {
  const b = analyzeGateBattery(
    plan([
      { id: "creds", executor: "human" },
      { id: "build", executor: "agent", deps: ["creds"] },
    ]),
  );
  assert.deepEqual(b.lateGates, []);
});

test("a plan with no gates yields empty battery and sequential lists", () => {
  const b = analyzeGateBattery(plan([{ id: "a", executor: "agent" }]));
  assert.equal(b.battery.length, 0);
  assert.equal(b.sequentialGates.length, 0);
  assert.equal(b.unattendedAgentCount, 1);
});
