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
    ],
  };
  assert.deepEqual(collectPlanWarnings(plan), []);
  assert.doesNotThrow(() => validatePlan(plan, { quiet: true }));
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
