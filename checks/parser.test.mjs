/**
 * Parser warning-pass unit tests. Drives the COMPILED dist/parser.js, matching
 * the self-locating style of the other checks/ drivers (no absolute paths).
 *
 * Run with:  node --test checks/parser.test.mjs   (the `npm test` script builds
 * dist/ first). Asserts that a warning fires for each of the three trap shapes
 * that used to fail SILENTLY, and that the canonical template produces zero.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// dist/ is one level up from checks/; the template lives in ../examples/.
const DIST = new URL("../dist/", import.meta.url);
const { collectPlanWarnings, validatePlan, PlanError } = await import(
  new URL("parser.js", DIST).href
);

const validTask = (over = {}) => ({ id: "t1", prompt: "do the thing", ...over });

test("clean plan produces zero warnings and validates", () => {
  const plan = {
    project: { name: "clean-app", description: "a clean plan" },
    model: "sonnet",
    deploy_policy: {
      launch_gate: true,
      max_run_usd: 40,
      worker_defaults: { commit_after_each_task: true },
    },
    tasks: [
      {
        id: "a",
        phase: "1-build",
        executor: "agent",
        title: "A",
        prompt: "build A",
        deps: [],
        outputs: [],
        acceptance: [],
      },
      // launch_gate is declared above, so a clean plan must actually have the
      // gate phase (an agent task in "6") and the gated phase ("7"); otherwise
      // the gate protects nothing and the integrity check fires.
      { id: "qa", phase: "6-qa", executor: "agent", prompt: "qa sweep", deps: ["a"] },
      { id: "go", phase: "7-production", executor: "human", prompt: "cutover", deps: ["qa"] },
    ],
  };
  assert.deepEqual(collectPlanWarnings(plan), []);
  assert.doesNotThrow(() => validatePlan(plan, { quiet: true }));
});

test("TRAP 4: `launch_gate` with no phase-6/7 tasks warns (gate protects nothing)", () => {
  const plan = {
    project: { name: "x" },
    deploy_policy: { launch_gate: true },
    tasks: [{ id: "a", phase: "1-build", prompt: "build A" }],
  };
  const warnings = collectPlanWarnings(plan);
  assert.equal(warnings.length, 2, `expected two warnings, got: ${JSON.stringify(warnings)}`);
  assert.ok(
    warnings.some((w) => /launch_gate/.test(w) && /gate nothing/.test(w)),
    "missing gate phase (6) must warn",
  );
  assert.ok(
    warnings.some((w) => /launch_gate/.test(w) && /behind the launch gate/.test(w)),
    "missing gated phase (7) must warn",
  );
});

test("launch_gate with a phase-6 HUMAN task but no agent task still warns", () => {
  // The gate waits on AGENT tasks in phase 6; a human-only phase 6 opens instantly.
  const plan = {
    project: { name: "x" },
    deploy_policy: { launch_gate: true },
    tasks: [
      { id: "review", phase: "6-qa", executor: "human", prompt: "eyeball it" },
      { id: "go", phase: "7-production", executor: "human", prompt: "cutover" },
    ],
  };
  const warnings = collectPlanWarnings(plan);
  assert.equal(warnings.length, 1, `expected one warning, got: ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /gate nothing/);
});

test("TRAP 1: a scalar `project:` warns and still hard-fails to load", () => {
  const plan = { project: "my-app", tasks: [validTask()] };
  const warnings = collectPlanWarnings(plan);
  assert.equal(warnings.length, 1, `expected exactly one warning, got: ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /project.*scalar/i);
  // Existing behavior is unchanged: a scalar project has no name, so it throws.
  assert.throws(() => validatePlan(plan, { quiet: true }), PlanError);
});

test("TRAP 2: per-task `depends_on:` warns (did you mean `deps`?)", () => {
  const plan = {
    project: { name: "x" },
    tasks: [
      { id: "a", prompt: "build A" },
      { id: "b", prompt: "build B", depends_on: ["a"] },
    ],
  };
  const warnings = collectPlanWarnings(plan);
  assert.equal(warnings.length, 1, `expected exactly one warning, got: ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /depends_on/);
  assert.match(warnings[0], /deps/);
});

test("TRAP 3: top-level `deploy_policy.commit_after_each_task` warns", () => {
  const plan = {
    project: { name: "x" },
    tasks: [validTask()],
    deploy_policy: { commit_after_each_task: true },
  };
  const warnings = collectPlanWarnings(plan);
  assert.equal(warnings.length, 1, `expected exactly one warning, got: ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /worker_defaults/);
});

test("sensitivity: scalar and list both normalize to a lowercased string[], zero warnings", () => {
  const scalar = { project: { name: "x" }, tasks: [{ id: "a", prompt: "do", sensitivity: "Compliance" }] };
  const list = { project: { name: "x" }, tasks: [{ id: "a", prompt: "do", sensitivity: ["compliance"] }] };
  assert.deepEqual(collectPlanWarnings(scalar), []);
  assert.deepEqual(collectPlanWarnings(list), []);
  assert.deepEqual(validatePlan(scalar, { quiet: true }).tasks[0].sensitivity, ["compliance"]);
  assert.deepEqual(validatePlan(list, { quiet: true }).tasks[0].sensitivity, ["compliance"]);
});

test("sensitivity: an unrecognized tag value warns once (and still loads)", () => {
  const plan = { project: { name: "x" }, tasks: [{ id: "a", prompt: "do", sensitivity: "complaince" }] };
  const w = collectPlanWarnings(plan);
  assert.equal(w.length, 1, `expected one warning, got: ${JSON.stringify(w)}`);
  assert.match(w[0], /complaince/); // names the bad value
  assert.match(w[0], /compliance/); // lists the recognized tags
  assert.doesNotThrow(() => validatePlan(plan, { quiet: true }));
});

test("canonical template loads clean with zero warnings", () => {
  const templatePath = new URL("../examples/plan-template.yaml", import.meta.url);
  const raw = parseYaml(readFileSync(templatePath, "utf8"));
  assert.deepEqual(
    collectPlanWarnings(raw),
    [],
    "the shipped template must be a zero-warning reference",
  );
  const plan = validatePlan(raw, { quiet: true });
  // Prove the two silent-drop keys are actually wired through, not just present.
  assert.equal(plan.policy.commitAfterEachTask, true, "worker_defaults.commit_after_each_task read");
  assert.ok(
    plan.tasks.some((t) => (t.deps ?? []).length > 0),
    "at least one task's `deps` edge survived parsing",
  );
});
