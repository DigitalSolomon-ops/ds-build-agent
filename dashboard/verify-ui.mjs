// End-to-end UI check: drives the dashboard in system Edge through a DRY run
// against the real FastIG plan and asserts the visualization updates.
// Never triggers a real (paid) run.
import { chromium } from "playwright";

const BASE = process.env.DASH_URL || "http://127.0.0.1:4317";
const PLAN = "C:\\Users\\marcu\\Downloads\\fastig-plan.yaml";

const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.log("  ✓ " + msg);
};

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

try {
  await page.goto(BASE, { waitUntil: "networkidle" });

  // Load the plan.
  await page.fill("#planPath", PLAN);
  await page.click("button.primary");
  await page.waitForSelector(".task", { timeout: 8000 });

  const taskCount = await page.locator(".task").count();
  assert(taskCount === 47, `47 task cards rendered (got ${taskCount})`);

  const phaseCount = await page.locator(".phase").count();
  assert(phaseCount === 8, `8 phases rendered (got ${phaseCount})`);

  const agentBadges = await page.locator(".task .exec-badge.exec-agent").count();
  const humanBadges = await page.locator(".task .exec-badge.exec-human").count();
  const ghlBadges = await page.locator(".task .exec-badge.exec-ghl").count();
  assert(agentBadges === 24 && humanBadges === 15 && ghlBadges === 8,
    `executor badges agent/human/ghl = ${agentBadges}/${humanBadges}/${ghlBadges}`);

  const graphNodes = await page.locator(".depgraph .node").count();
  assert(graphNodes === 47, `dependency graph has 47 nodes (got ${graphNodes})`);

  // Gate panel before run.
  const gateStatus = (await page.locator(".gate-status").textContent()).trim();
  assert(gateStatus === "BLOCKED", `gate shows BLOCKED (got "${gateStatus}")`);

  // The panel must name the human sign-off task that holds the gate closed.
  const gateBody = await page.locator("#gatePanel").textContent();
  assert(/human sign-off/i.test(gateBody) && /p6-consent-verify/.test(gateBody),
    "gate panel names p6-consent-verify as the human sign-off holding the gate");

  // Kick a DRY run (checkbox is checked by default).
  const dryChecked = await page.isChecked("#dryRun");
  assert(dryChecked, "dry-run toggle is ON by default");
  await page.click("#dryBtn");

  // Wait for the run to finish (log status becomes succeeded).
  await page.waitForFunction(
    () => document.querySelector("#logStatus")?.textContent?.includes("succeeded"),
    { timeout: 20000 });
  console.log("  ✓ dry run reached 'succeeded'");

  // Assert per-state task counts match the harness tally (22/21/4).
  const counts = await page.evaluate(() => {
    const by = (s) => document.querySelectorAll(`.task[data-state="${s}"]`).length;
    return { built: by("built"), deferred: by("deferred"), skipped: by("skipped"), failed: by("failed") };
  });
  assert(counts.built === 22, `22 tasks show 'built' (got ${counts.built})`);
  assert(counts.deferred === 21, `21 tasks show 'deferred' (got ${counts.deferred})`);
  assert(counts.skipped === 4, `4 tasks show 'skipped' (got ${counts.skipped})`);
  assert(counts.failed === 0, `0 tasks show 'failed' (got ${counts.failed})`);

  // Progress tally reflects the same.
  const builtTally = (await page.locator(".tally.t-built .n").textContent()).trim();
  assert(builtTally === "22", `progress 'built' tally = 22 (got ${builtTally})`);

  const overall = await page.evaluate(() => document.querySelector(".bar-fill.overall").style.width);
  assert(overall === "100%", `overall progress bar 100% (got ${overall})`);

  // A skipped phase-7 task carries the gate reason.
  const p7 = await page.locator('.task[data-task-id="p7-ab-test"]').getAttribute("data-state");
  assert(p7 === "skipped", `p7-ab-test skipped by gate (got ${p7})`);

  // Log captured harness output.
  const logText = await page.locator("#log").textContent();
  assert(/Dry run complete/.test(logText), "live log captured the harness result line");

  // Files panel populated.
  await page.waitForSelector(".file-item", { timeout: 5000 });
  const fileCount = await page.locator(".file-item").count();
  assert(fileCount >= 1, `files panel lists build docs (got ${fileCount})`);

  // Real-run confirm guardrail: modal opens, warns about cost, Cancel starts nothing.
  await page.click("#realBtn");
  await page.waitForSelector(".modal-backdrop", { timeout: 4000 });
  const warnText = await page.locator(".warn-box").textContent();
  assert(/cost money/i.test(warnText), "confirm modal warns that agent tasks cost money");
  const agentLine = await page.locator(".confirm-list").textContent();
  assert(/24 agent task/.test(agentLine), "confirm modal counts the 24 agent tasks that will call the API");
  await page.click(".modal .btn:not(.danger)"); // Cancel
  await page.waitForSelector(".modal-backdrop", { state: "detached", timeout: 4000 });
  const runsAfter = await (await fetch(BASE + "/api/runs")).json();
  const realRuns = runsAfter.runs.filter((r) => !r.dryRun);
  assert(realRuns.length === 0, "cancelling the confirm modal started no real run");

  // Backend guardrail: a malformed run request is a client error (400), not 500.
  const badReq = await fetch(BASE + "/api/runs", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{ not json",
  });
  assert(badReq.status === 400, `malformed run body returns 400 (got ${badReq.status})`);

  assert(errors.length === 0, `no page/console errors (got ${errors.length}: ${errors.slice(0,2).join(" | ")})`);

  await page.screenshot({ path: "dashboard/verify-screenshot.png", fullPage: true });
  console.log("\nALL UI CHECKS PASSED — screenshot at dashboard/verify-screenshot.png");
} finally {
  await browser.close();
}
