#!/usr/bin/env node
import { resolve, join, dirname } from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { loadPlan, PlanError } from "./parser.js";
import { resolveBuildPath } from "./paths.js";
import { resolveRunCapUsd, CostAccumulator } from "./cost.js";
import { orchestrate } from "./orchestrator.js";
import { createStateWriter } from "./state-writer.js";
import { renderDashboard } from "./dashboard.js";
import { renderStatus } from "./status.js";
import { analyzeGateBattery } from "./gate-battery.js";
import type { TaskResult } from "./types.js";
import { isBuildExecutor } from "./types.js";
import { resolveAuthMode, subscriptionLoginProblem, type AuthMode } from "./auth.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AirspaceError, type AirspaceRegistry } from "./airspace.js";
import {
  checkBuildTarget,
  claimAirspaceForRun,
  deriveRepoKeys,
  leaseSettings,
  newRunId,
  openAirspaceRegistry,
  type RunClaim,
} from "./airspace-launch.js";
import { killAllTrees } from "./proc-tree.js";
import { findProjectsRoot } from "./sync.js";
import type { OrchestratorOptions } from "./orchestrator.js";
import { runSubcommand, SUBCOMMANDS } from "./commands.js";

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
  /** Per-run cost cap in USD (`--max-usd`); overrides the plan's max_run_usd and MAX_RUN_USD env. */
  maxUsd?: string;
  /** How agents authenticate: the Claude subscription (local default) or ANTHROPIC_API_KEY. */
  auth: AuthMode;
}

/**
 * What main() runs with. Production passes nothing; the checks inject a memory
 * registry and a fake task runner so the real entry point runs in-process with no
 * agent. There is deliberately no env var or flag that selects a backend.
 */
export interface CliDeps {
  registry?: AirspaceRegistry;
  taskRunner?: OrchestratorOptions["taskRunner"];
  /** The Projects root (the folder holding studio.yaml); found by walking up when absent. */
  projectsRoot?: string;
}

/** Every flag the CLI knows. Anything else is refused (a typo must not silently change a run). */
const KNOWN_FLAGS = new Set([
  "--out", "--repo", "--max-usd", "--concurrency", "--only", "--dry-run", "--strict",
  "--state", "--dashboard", "--status", "--subscription", "--api",
]);

function parseArgs(argv: string[]): Cli {
  const args = argv.slice(2);
  // Flags that take a value; their values are not the plan path.
  const VALUED = new Set(["--out", "--repo", "--max-usd", "--concurrency", "--only"]);
  const unknown = args.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.has(a));
  if (unknown.length) throw new Error(`Unknown flag(s): ${unknown.join(", ")}`);
  const planPath = args.find((a, i) => !a.startsWith("--") && !VALUED.has(args[i - 1] ?? ""));
  const has = (flag: string) => args.includes(flag);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (!planPath) {
    throw new Error(
      "Usage: ds-build <plan.yaml> [--out <dir>] [--concurrency <n>] [--dry-run] [--strict] " +
        "[--state [dir]] [--dashboard [path]] [--status [path]] [--repo <existing-repo>] [--subscription | --api]\n" +
        "       ds-build sync <project-dir> [--plan <file>] [--dry-run]\n" +
        "       ds-build airspace <list | draft <plan.yaml> | check <plan.yaml>>",
    );
  }
  const out = get("--out") ?? join(process.cwd(), "builds");
  const repo = get("--repo");
  const maxUsd = get("--max-usd");
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
    maxUsd,
    auth: resolveAuthMode({ subscription: has("--subscription"), api: has("--api") }),
  };
}

function truncate(s: string, n = 180): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

/** The running claim, so shutdown() and every exit path can stop the work and free it. */
let current: { release: () => Promise<void>; abandon: () => void; abort: (reason: string) => void } | undefined;

/**
 * Stop the run: abort in-flight agents, kill every child process tree the
 * harness started (and wait until they are confirmed gone), THEN release the
 * airspace claim. Called by the SIGINT/SIGTERM handlers; exported for the checks.
 * `watch` lists extra pids (e.g. known grandchildren) that must be gone too.
 */
export async function shutdown(reason: string, opts: { watch?: number[] } = {}): Promise<void> {
  current?.abort(reason);
  await endRun(opts.watch);
}

/**
 * The one way a run's claim ends: kill every child tree the harness started and
 * CONFIRM them gone, then release. If they cannot be confirmed dead, the claim is
 * NOT released — the heartbeat stops and the lease frees it — so nothing is ever
 * still writing on airspace someone else has been granted.
 */
async function endRun(watch?: number[]): Promise<void> {
  const c = current;
  current = undefined;
  if (!c) return;
  if (await killAllTrees({ watch })) {
    await c.release();
  } else {
    c.abandon();
    console.error("✗ airspace: child processes could not be confirmed dead; the claim is left to expire with its lease");
  }
}

/** Returns the process exit code: 0 ok, 1 failed, 3 held, 4 airspace lost mid-run, 5 airspace refused. */
export async function main(argv: string[] = process.argv, deps: CliDeps = {}): Promise<number> {
  try {
    return await run(argv, deps);
  } catch (e) {
    await endRun();
    if (e instanceof PlanError) console.error(`✗ Invalid plan: ${e.message}`);
    else console.error(`✗ ${(e as Error).message}`);
    return e instanceof AirspaceError ? 5 : 1;
  }
}

async function run(argv: string[], deps: CliDeps): Promise<number> {
  if (SUBCOMMANDS.has(argv[2] ?? "")) {
    return await runSubcommand(argv.slice(2));
  }
  const cli = parseArgs(argv);
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

  // Pin the auth mode for every agent this process spawns (agent.ts reads it).
  process.env.DS_BUILD_AUTH = cli.auth;
  if (!cli.dryRun) {
    if (cli.auth === "api" && !process.env.ANTHROPIC_API_KEY) {
      console.error("✗ --api needs ANTHROPIC_API_KEY. Drop --api to run on your Claude subscription.");
      console.error("  (Use --dry-run to preview the execution plan without any login.)");
      return 1;
    }
    if (cli.auth === "subscription") {
      const problem = subscriptionLoginProblem();
      if (problem) {
        console.error(`✗ ${problem}`);
        return 1;
      }
    }
  }

  if (!cli.dryRun) {
    // --repo builds into an EXISTING repo; a missing path is an operator typo,
    // not a cue to create a fresh one (that is what the default --out path is for).
    if (cli.repo && !existsSync(repoPath)) {
      console.error(`✗ --repo path does not exist: ${repoPath}`);
      console.error("  Point --repo at an existing repo, or omit it to build fresh under --out.");
      return 1;
    }
  }

  // AIRSPACE (hard block). Claim every declared resource — plus the repo: of every
  // claimed git folder — in one transaction before anything dispatches or writes.
  // Held -> exit 3 naming the holder. Refused (unclaimed build target, lease
  // settings, clock, wrong registry) or unreachable -> exit 5: never launch
  // unchecked. No override, no flag, no env var.
  let claim: RunClaim | undefined;
  const runController = new AbortController();
  if (!cli.dryRun) {
    const runId = newRunId("local");
    const root =
      deps.projectsRoot ?? findProjectsRoot(repoPath) ?? findProjectsRoot(cli.planPath) ?? findProjectsRoot(process.cwd());
    try {
      const { leaseMs, heartbeatMs } = leaseSettings();
      checkBuildTarget(repoPath, plan.airspace, root);
      claim = await claimAirspaceForRun({
        registry: deps.registry ?? openAirspaceRegistry(),
        plan,
        runId,
        lane: "local",
        derived: deriveRepoKeys(plan.airspace, root),
        leaseMs,
        heartbeatMs,
        log: (_lvl, msg) => console.warn(`  ⚠ ${msg}`),
      });
    } catch (e) {
      const msg = (e as Error).message;
      console.error(
        e instanceof AirspaceError
          ? `✗ ${msg}`
          : `✗ airspace: registry unreachable, so nothing was launched: ${msg}`,
      );
      return 5;
    }
    if (!claim.granted) {
      console.error(`✗ ${claim.message}`);
      console.error("  Launch blocked. It can launch once that run finishes or its lease expires.");
      return 3;
    }
    current = { release: claim.release, abandon: claim.abandon, abort: (reason) => runController.abort(reason) };
    console.log(`▸ Claimed:     run ${runId} (${claim.resources.length} resources)\n`);
  }

  if (!cli.dryRun) mkdirSync(repoPath, { recursive: true });

  const agentCount = plan.tasks.filter((t) => isBuildExecutor(t.executor) && t.auto).length;
  const codexCount = plan.tasks.filter((t) => t.executor === "codex" && t.auto).length;
  const browserCount = plan.tasks.filter((t) => t.browser).length;
  const mix =
    (codexCount ? `, ${codexCount} via codex` : "") +
    (browserCount ? `, ${browserCount} with browser` : "");
  console.log(`▸ Plan:        ${plan.name} (${plan.tasks.length} tasks, ${agentCount} agent-built${mix})`);
  console.log(`▸ ${cli.repo ? "Repo (in-place)" : "Building in"}: ${repoPath}`);
  console.log(`▸ Concurrency: ${cli.concurrency}${cli.dryRun ? "   [DRY RUN — no agents, no writes]" : ""}`);
  console.log(
    `▸ Auth:        ${cli.auth === "subscription"
      ? "Claude subscription (API key stripped from agents; no API billing)"
      : "ANTHROPIC_API_KEY (billed per token)"}\n`,
  );

  console.log(`▸ Airspace:    ${plan.airspace.join(", ")}`);

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

  // Per-run cost cap — parity with the cloud runner (B2). The LOCAL CLI had none,
  // so a `--repo` build ran to completion regardless of spend. Stop dispatching once
  // accumulated reported cost (build + adversarial-verify passes) reaches the cap.
  const runCapUsd = resolveRunCapUsd(plan.policy.maxRunUsd, process.env.MAX_RUN_USD, cli.maxUsd);
  const cost = new CostAccumulator();
  if (!cli.dryRun)
    console.log(
      `▸ Cost cap:    $${runCapUsd.toFixed(2)}   (halts dispatch when reached` +
        (cli.auth === "subscription"
          ? "; API-equivalent cost, nothing is billed: it limits how much of your plan's usage one run takes)\n"
          : ")\n"),
    );

  const results = await orchestrate(plan, {
    repoPath,
    concurrency: cli.concurrency,
    dryRun: cli.dryRun,
    capReached: () => cost.reached(runCapUsd),
    halt: claim?.granted ? claim.halt : undefined,
    signal: claim?.granted ? AbortSignal.any([claim.signal, runController.signal]) : undefined,
    beforeCommit: claim?.granted ? claim.confirm : undefined,
    taskRunner: deps.taskRunner,
    onEvent: (e) => {
      if (e.type === "task-done") cost.add(e.result.usage?.costUsd, e.result.verify?.usage?.costUsd);
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

  const lostReason = claim?.granted ? claim.halt() : undefined;
  await endRun();
  stateWriter?.finalize(results);
  report(results, Date.now() - started, cli.dryRun, planWarnings.length, cli.strict);
  if (!cli.dryRun) {
    const capped = cost.reached(runCapUsd);
    console.log(
      `   spent: $${cost.total.toFixed(4)} of $${runCapUsd.toFixed(2)} cap` +
        (capped ? "  ⚠ CAP REACHED — remaining tasks were skipped" : ""),
    );
  }
  const failed = results.filter((r) => r.status === "failed").length;
  // --strict promotes any plan warning to a failure; without it warnings are
  // informational and never change the exit code.
  const strictFail = cli.strict && planWarnings.length > 0;
  if (lostReason) {
    console.error(`✗ ${lostReason}`);
    return 4;
  }
  return failed > 0 || strictFail ? 1 : 0;
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

/** True when this file is the process entry (the ds-build bin), not an import from the checks. */
function isEntry(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  // Signals stop the work, kill child trees, confirm them gone, THEN release.
  const onSignal = (code: number, name: string) => () => {
    void shutdown(`${name} received`).finally(() => process.exit(code));
  };
  process.once("SIGINT", onSignal(130, "SIGINT"));
  process.once("SIGTERM", onSignal(143, "SIGTERM"));
  // A crash anywhere still stops the children before the claim can be released.
  const onCrash = (what: string) => (e: unknown) => {
    console.error(`✗ ${what}: ${(e as Error)?.stack ?? e}`);
    void shutdown(what).finally(() => process.exit(1));
  };
  process.once("uncaughtException", onCrash("uncaught exception"));
  process.once("unhandledRejection", onCrash("unhandled rejection"));
  main(process.argv).then((code) => process.exit(code));
}
