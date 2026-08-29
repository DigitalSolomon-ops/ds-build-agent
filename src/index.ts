#!/usr/bin/env node
import { resolve, join, dirname } from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { loadPlan, PlanError } from "./parser.js";
import { resolveBuildPath } from "./paths.js";
import { orchestrate } from "./orchestrator.js";
import { createStateWriter } from "./state-writer.js";
import { renderDashboard } from "./dashboard.js";
import { renderStatus } from "./status.js";
import { analyzeGateBattery } from "./gate-battery.js";
import type { TaskResult } from "./types.js";
import { isBuildExecutor } from "./types.js";

interface Cli {
  planPath: string;
  repoPath: string;
  concurrency: number;
  dryRun: boolean;
  /** Treat any plan warning (unknown/ignored key) as fatal — non-zero exit. */
  strict: boolean;
  only?: string[];
  /**
   * Opt-in run-state emitter. `undefined` = disabled (default, byte-for-byte
   * identical behavior). Empty string = enabled with the default location.
   * A path = enabled, writing state there.
   */
  state?: string;
  /**
   * Opt-in local dashboard. `undefined` = not requested. Empty string = enabled
   * at the default path (`builds/<name>/dashboard.html`). A path = enabled there.
   * Same optional-arg shape as `--state`.
   */
  dashboard?: string;
  /**
   * Opt-in Markdown STATUS.md resume doc. Same optional-arg shape as
   * `--dashboard`. Empty string = enabled at the default path (the STATE dir, not
   * the build repo). A path = enabled there.
   */
  status?: string;
  /**
   * In-place build: an EXISTING repo to build INTO (extend), instead of a fresh
   * `<out>/<name>/` folder. When set, agents run with that repo's real code in
   * view, and harness telemetry (state/dashboard/STATUS) stays outside it.
   */
  repo?: string;
}

function parseArgs(argv: string[]): Cli {
  const args = argv.slice(2);
  const planPath = args.find((a) => !a.startsWith("--"));
  const has = (flag: string) => args.includes(flag);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (!planPath) {
    throw new Error(
      "Usage: ds-build <plan.yaml> [--out <dir>] [--concurrency <n>] [--dry-run] [--strict] " +
        "[--state [dir]] [--dashboard [path]] [--status [path]] [--repo <existing-repo>]",
    );
  }
  const out = get("--out") ?? join(process.cwd(), "builds");
  const repo = get("--repo");
  const concurrency = Number(get("--concurrency") ?? "3");
  const onlyRaw = get("--only");
  // `--state` takes an optional directory. Bare `--state` (or followed by
  // another flag) enables it at the default location, signalled by "".
  let state: string | undefined;
  const stateIdx = args.indexOf("--state");
  if (stateIdx >= 0) {
    const next = args[stateIdx + 1];
    state = next && !next.startsWith("--") ? next : "";
  }
  // `--dashboard` mirrors `--state`: bare enables at the default path, else a path.
  let dashboard: string | undefined;
  const dashIdx = args.indexOf("--dashboard");
  if (dashIdx >= 0) {
    const next = args[dashIdx + 1];
    dashboard = next && !next.startsWith("--") ? next : "";
  }
  // `--status` mirrors `--dashboard`: bare enables at the default path, else a path.
  let status: string | undefined;
  const statusIdx = args.indexOf("--status");
  if (statusIdx >= 0) {
    const next = args[statusIdx + 1];
    status = next && !next.startsWith("--") ? next : "";
  }
  return {
    planPath: resolve(planPath),
    repoPath: resolve(out),
    concurrency: Number.isFinite(concurrency) ? concurrency : 3,
    dryRun: has("--dry-run"),
    strict: has("--strict"),
    only: onlyRaw ? onlyRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    state,
    dashboard,
    status,
    repo,
  };
}

function truncate(s: string, n = 180): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

async function main() {
  const cli = parseArgs(process.argv);
  // loadPlan prints each warning to stderr as it loads; we also capture the list
  // so the summary can show a count and --strict can turn any warning into a
  // non-zero exit. A scalar `project:` still hard-fails inside loadPlan — but its
  // warning is printed first, so the operator sees the fix, not just the failure.
  let planWarnings: string[] = [];
  const plan = loadPlan(cli.planPath, { onWarnings: (w) => (planWarnings = w) });

  // --only: scope to specific task ids, pruning deps outside the kept set.
  if (cli.only) {
    const keep = new Set(cli.only);
    const missing = cli.only.filter((id) => !plan.tasks.some((t) => t.id === id));
    if (missing.length) throw new Error(`--only references unknown task(s): ${missing.join(", ")}`);
    plan.tasks = plan.tasks
      .filter((t) => keep.has(t.id))
      .map((t) => ({ ...t, deps: (t.deps ?? []).filter((d) => keep.has(d)) }));
  }

  const safeName = plan.name.replace(/[^\w.-]+/g, "-");
  // Build target: an existing repo in-place (--repo) or the greenfield default.
  const repoPath = resolveBuildPath(cli.repo, cli.repoPath, safeName);
  // The state dir lives OUTSIDE the build repo (next to builds/<name>/), so
  // commit_after_each_task never captures harness telemetry. Hoisted (exact
  // expression) so both the state writer and STATUS.md's default can reference it.
  const stateDir = cli.state ? resolve(cli.state) : join(cli.repoPath, ".ds-runs", safeName);

  // ONE dashboard file, shared by the immediate static write and the state
  // writer's autosave. Requested explicitly via --dashboard, or implicitly
  // whenever --state is on (state-on auto-emits the dashboard — the documented
  // default). Default location matches the flag's contract: builds/<name>/.
  const dashboardRequested = cli.dashboard !== undefined || cli.state !== undefined;
  const dashboardPath = dashboardRequested
    ? cli.dashboard
      ? resolve(cli.dashboard)
      : join(cli.repo ? stateDir : repoPath, "dashboard.html")
    : undefined;

  // STATUS.md resume doc. Requested via --status or implicitly with --state.
  // UNLIKE the dashboard, it defaults to the STATE dir, never the build repo, so
  // it is never swept into a commit_after_each_task commit.
  const statusRequested = cli.status !== undefined || cli.state !== undefined;
  const statusPath = statusRequested
    ? cli.status
      ? resolve(cli.status)
      : join(stateDir, "STATUS.md")
    : undefined;

  // --dashboard: write the plan-only view immediately — before the API-key check,
  // so it works with or without an actual run and needs no key.
  if (cli.dashboard !== undefined && dashboardPath) {
    mkdirSync(dirname(dashboardPath), { recursive: true });
    writeFileSync(dashboardPath, renderDashboard(plan));
    console.log(`▸ Dashboard:   ${dashboardPath}   [plan view]`);
  }
  // --status: same immediate plan-only write.
  if (cli.status !== undefined && statusPath) {
    mkdirSync(dirname(statusPath), { recursive: true });
    writeFileSync(statusPath, renderStatus(plan));
    console.log(`▸ STATUS:      ${statusPath}   [plan view]`);
  }

  if (!cli.dryRun && !process.env.ANTHROPIC_API_KEY) {
    console.error("✗ ANTHROPIC_API_KEY is not set. The Agent SDK needs it to run.");
    console.error("  (Use --dry-run to preview the execution plan without a key.)");
    process.exit(1);
  }

  if (!cli.dryRun) {
    // --repo builds into an EXISTING repo; a missing path is an operator typo,
    // not a cue to create a fresh one (that is what the default --out path is for).
    if (cli.repo && !existsSync(repoPath)) {
      console.error(`✗ --repo path does not exist: ${repoPath}`);
      console.error("  Point --repo at an existing repo, or omit it to build fresh under --out.");
      process.exit(1);
    }
    mkdirSync(repoPath, { recursive: true });
  }

  const agentCount = plan.tasks.filter((t) => isBuildExecutor(t.executor) && t.auto).length;
  const codexCount = plan.tasks.filter((t) => t.executor === "codex" && t.auto).length;
  const browserCount = plan.tasks.filter((t) => t.browser).length;
  const mix =
    (codexCount ? `, ${codexCount} via codex` : "") +
    (browserCount ? `, ${browserCount} with browser` : "");
  console.log(`▸ Plan:        ${plan.name} (${plan.tasks.length} tasks, ${agentCount} agent-built${mix})`);
  console.log(`▸ ${cli.repo ? "Repo (in-place)" : "Building in"}: ${repoPath}`);
  console.log(`▸ Concurrency: ${cli.concurrency}${cli.dryRun ? "   [DRY RUN — no agents, no writes]" : ""}\n`);

  // Gate battery (whetstone W1): how much of the build the operator can unlock
  // by clearing gates up front, and which gates legitimately wait for the build.
  printGateBattery(plan);

  const started = Date.now();

  // Opt-in run-state emitter (behind --state). When disabled this stays null
  // and nothing below changes the harness's default behavior or output.
  const stateWriter =
    cli.state !== undefined
      ? createStateWriter({
          plan,
          planPath: cli.planPath,
          repoPath,
          stateDir,
          concurrency: cli.concurrency,
          dryRun: cli.dryRun,
          startedAt: started,
          // Autosave the dashboard + STATUS.md off the same event stream.
          dashboardPath,
          statusPath,
        })
      : null;
  if (stateWriter) {
    console.log(`▸ State:       ${stateWriter.paths.runStatePath}`);
    if (stateWriter.paths.dashboardPath)
      console.log(`▸ Dashboard:   ${stateWriter.paths.dashboardPath}   [live autosave]`);
    if (stateWriter.paths.statusPath)
      console.log(`▸ STATUS:      ${stateWriter.paths.statusPath}   [live autosave]`);
    console.log("");
  }

  const results = await orchestrate(plan, {
    repoPath,
    concurrency: cli.concurrency,
    dryRun: cli.dryRun,
    onEvent: (e) => {
      stateWriter?.handleEvent(e);
      switch (e.type) {
        case "task-start":
          console.log(`  ⏵ ${e.task.id} — ${e.task.title}`);
          break;
        case "task-log":
          console.log(`      · ${truncate(e.text)}`);
          break;
        case "task-done":
          console.log(
            `  ${e.result.status === "success" ? "✓" : "✗"} ${e.task.id}` +
              (cli.dryRun ? "" : ` (${Math.round(e.result.durationMs / 1000)}s)`) +
              (e.result.error ? ` — ${e.result.error}` : ""),
          );
          break;
        case "task-deferred":
          console.log(`  ⏸ ${e.task.id} — ${e.task.executor} → ${e.doc}`);
          break;
        case "task-skipped":
          console.log(`  ⊘ ${e.task.id} — ${e.reason}`);
          break;
      }
    },
  });

  stateWriter?.finalize(results);
  report(results, Date.now() - started, cli.dryRun, planWarnings.length, cli.strict);
  const failed = results.filter((r) => r.status === "failed").length;
  // --strict promotes any plan warning to a failure; without it warnings are
  // informational and never change the exit code.
  const strictFail = cli.strict && planWarnings.length > 0;
  process.exit(failed > 0 || strictFail ? 1 : 0);
}

/**
 * Print the gate-battery readout: the front-loadable gates the operator clears
 * up front, how many agent tasks then build unattended, and the sequential
 * gates that legitimately wait for the build. Silent when a plan has no gates.
 */
function printGateBattery(plan: import("./types.js").BuildPlan): void {
  const b = analyzeGateBattery(plan);
  if (b.battery.length === 0 && b.sequentialGates.length === 0) return;
  console.log(
    `▸ Gate battery: ${b.battery.length} upfront → ` +
      `${b.unattendedAgentCount}/${b.totalAgentCount} agent tasks then build unattended; ` +
      `${b.sequentialGates.length} sequential (after the build).`,
  );
  if (b.battery.length) console.log(`   ⏹ clear first: ${b.battery.map((t) => t.id).join(", ")}`);
  if (b.sequentialGates.length)
    console.log(`   ⏳ after build: ${b.sequentialGates.map((t) => t.id).join(", ")}`);
  if (b.lateGates.length)
    console.log(
      `   ⚠ could be front-loaded (need nothing built): ${b.lateGates.map((t) => t.id).join(", ")}`,
    );
  console.log("");
}

function report(
  results: TaskResult[],
  totalMs: number,
  dryRun: boolean,
  warnings: number,
  strict: boolean,
): void {
  const count = (s: TaskResult["status"]) => results.filter((r) => r.status === s).length;
  console.log(`\n─── ${dryRun ? "Dry run" : "Build"} complete in ${Math.round(totalMs / 1000)}s ───`);
  const strictNote = strict && warnings > 0 ? "  [--strict → exit 1]" : "";
  console.log(
    `   ${dryRun ? "would build" : "built"}: ${count("success")}   ` +
      `deferred (human/ghl): ${count("deferred")}   ` +
      `skipped: ${count("skipped")}   failed: ${count("failed")}   ` +
      `warnings: ${warnings}${strictNote}`,
  );
  for (const r of results.filter((x) => x.status === "failed" || x.status === "skipped")) {
    console.log(`   ${r.status === "failed" ? "✗" : "⊘"} ${r.taskId}: ${r.error ?? "unknown"}`);
  }
}

main().catch((e) => {
  if (e instanceof PlanError) console.error(`✗ Invalid plan: ${e.message}`);
  else console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
