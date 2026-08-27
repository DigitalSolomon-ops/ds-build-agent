/**
 * Dashboard renderer unit tests. Drives the COMPILED dist/dashboard.js, matching
 * the self-locating style of checks/parser.test.mjs (no absolute paths, imports
 * dist/ — so `npm test` builds first).
 *
 * Proves the three things the feature promises:
 *   1. A static plan dashboard is valid, self-contained HTML carrying the
 *      HUMAN GATES section and the 6->7 launch-gate marker.
 *   2. A simulated run-state overlays per-task statuses + live counts.
 *   3. The shipped examples/plan-template.yaml renders with no error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const DIST = new URL("../dist/", import.meta.url);
const { loadPlan, validatePlan } = await import(new URL("parser.js", DIST).href);
const { renderDashboard } = await import(new URL("dashboard.js", DIST).href);

const templatePath = new URL("../examples/plan-template.yaml", import.meta.url);
const template = () => loadPlan(templatePath, { quiet: true });

test("static plan dashboard is valid, self-contained HTML", () => {
  const html = renderDashboard(template());
  assert.ok(html.startsWith("<!doctype html>"), "starts with doctype");
  assert.ok(html.trimEnd().endsWith("</html>"), "ends with </html>");
  assert.ok(html.includes("<style>"), "inlines CSS");
  assert.ok(html.includes("<script>"), "inlines JS");
  // Self-contained: no external stylesheet/script/img fetches.
  assert.ok(!/<link[^>]+href=["']https?:/i.test(html), "no external stylesheet");
  assert.ok(!/<script[^>]+src=["']https?:/i.test(html), "no external script");
  assert.ok(!/<img[^>]+src=["']https?:/i.test(html), "no external image");
});

test("plan dashboard renders the HUMAN GATES section", () => {
  const html = renderDashboard(template());
  assert.ok(html.includes("Human gates"), "has the human gates heading");
  assert.ok(html.includes("<!-- human-gates -->"), "has the human-gates marker");
  // The template's two non-agent tasks (ghl crm-fields, human dns-cutover) appear
  // as gates with their brief rendered as the instruction and acceptance as done-when.
  assert.ok(
    html.includes("GATE: point the domain at the service"),
    "the human gate's title is shown",
  );
  assert.ok(html.includes("Create CRM custom fields"), "the ghl gate's title is shown");
  assert.ok(html.includes("Done when:"), "gate acceptance is rendered as 'Done when:'");
  assert.ok(
    html.includes("Route production traffic and point the domain"),
    "the gate brief is rendered as the instruction",
  );
});

test("plan dashboard carries the 6->7 launch-gate marker", () => {
  const html = renderDashboard(template());
  assert.ok(html.includes("<!-- launch-gate:6->7 -->"), "byte-stable gate marker present");
  assert.ok(html.includes("GATE<br>HELD"), "phase rail shows the held-gate marker");
  assert.ok(html.includes("P6&#8594;P7"), "launch-gate summary tile shows P6->P7");
});

test("plan-only view has no live status badges and no auto-refresh", () => {
  const html = renderDashboard(template());
  assert.equal(
    html.split('class="sbadge').length - 1,
    0,
    "no status badges are emitted without run state",
  );
  assert.ok(!html.includes('http-equiv="refresh"'), "plan-only never auto-refreshes");
});

test("simulated run-state yields per-task statuses and live counts", () => {
  const plan = template();
  // Assign a distinct state to exercise all six of the dashboard's task states.
  const runState = {
    run: { status: "running" },
    tasks: [
      { id: "validate-plan", state: "built" },
      { id: "scaffold", state: "running" },
      { id: "landing-page", state: "pending" },
      { id: "backend-proxy", state: "failed", error: "boom" },
      { id: "qa-sweep", state: "skipped" },
      { id: "crm-fields", state: "deferred", doc: "GHL-SETUP.md" },
      { id: "dns-cutover", state: "deferred", doc: "BLOCKERS.md" },
    ],
  };
  const html = renderDashboard(plan, runState);
  for (const s of ["built", "running", "pending", "failed", "skipped", "deferred"]) {
    assert.ok(
      html.includes(`class="sbadge s-${s}"`),
      `a task badge for state "${s}" is rendered`,
    );
  }
  // Live tiles + banner only appear with run state.
  assert.ok(html.includes(">Status<"), "live Status tile is shown");
  assert.ok(html.includes(">Built<") && html.includes(">Failed<"), "live count tiles are shown");
  // A running snapshot auto-refreshes so the open tab re-reads the autosave.
  assert.ok(html.includes('http-equiv="refresh"'), "a running run auto-refreshes");
});

test("a completed run stops auto-refreshing", () => {
  const html = renderDashboard(template(), {
    run: { status: "complete" },
    tasks: [{ id: "validate-plan", state: "built" }],
  });
  assert.ok(!html.includes('http-equiv="refresh"'), "complete run does not auto-refresh");
});

test("a plan with no launch gate omits the gate marker", () => {
  const plan = validatePlan(
    {
      project: { name: "no-gate-app" },
      tasks: [
        { id: "a", executor: "agent", title: "A", prompt: "build A" },
        { id: "b", executor: "agent", title: "B", prompt: "build B", deps: ["a"] },
      ],
    },
    { quiet: true },
  );
  const html = renderDashboard(plan);
  assert.ok(!html.includes("launch-gate:"), "no gate marker without a launch gate");
  assert.ok(html.includes("No human gates in this plan"), "all-agent plan notes zero gates");
});

test("shipped plan-template.yaml renders without error", () => {
  assert.doesNotThrow(() => {
    const html = renderDashboard(template());
    assert.ok(html.length > 1000, "produces a non-trivial document");
  });
});
