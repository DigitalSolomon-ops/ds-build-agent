#!/usr/bin/env node
import { resolve, join } from "node:path";
import { mkdirSync } from "node:fs";
import { loadPlan, PlanError } from "./parser.js";
import { orchestrate } from "./orchestrator.js";
import type { TaskResult } from "./types.js";

interface Cli {
  planPath: string;
  repoPath: string;
  concurrency: number;
  dryRun: boolean;
  only?: string[];
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
      "Usage: ds-build <plan.yaml> [--out <dir>] [--concurrency <n>] [--dry-run]",
    );
  }
  const out = get("--out") ?? join(process.cwd(), "builds");
  const concurrency = Number(get("--concurrency") ?? "3");
  const onlyRaw = get("--only");
  return {
    planPath: resolve(planPath),
    repoPath: resolve(out),
    concurrency: Number.isFinite(concurrency) ? concurrency : 3,
    dryRun: has("--dry-run"),
    only: onlyRaw ? onlyRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
  };
}

function truncate(s: string, n = 180): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

async function main() {
  const cli = parseArgs(process.argv);
  const plan = loadPlan(cli.planPath);

  // --only: scope to specific task ids, pruning deps outside the kept set.
  if (cli.only) {
    const keep = new Set(cli.only);
    const missing = cli.only.filter((id) => !plan.tasks.some((t) => t.id === id));
    if (missing.length) throw new Error(`--only references unknown task(s): ${missing.join(", ")}`);
    plan.tasks = plan.tasks
      .filter((t) => keep.has(t.id))
      .map((t) => ({ ...t, deps: (t.deps ?? []).filter((d) => keep.has(d)) }));
  }

  if (!cli.dryRun && !process.env.ANTHROPIC_API_KEY) {
    console.error("✗ ANTHROPIC_API_KEY is not set. The Agent SDK needs it to run.");
    console.error("  (Use --dry-run to preview the execution plan without a key.)");
    process.exit(1);
  }

  const repoPath = join(cli.repoPath, plan.name.replace(/[^\w.-]+/g, "-"));
  if (!cli.dryRun) mkdirSync(repoPath, { recursive: true });

  const agentCount = plan.tasks.filter((t) => t.executor === "agent" && t.auto).length;
  console.log(`▸ Plan:        ${plan.name} (${plan.tasks.length} tasks, ${agentCount} agent-built)`);
  console.log(`▸ Building in: ${repoPath}`);
  console.log(`▸ Concurrency: ${cli.concurrency}${cli.dryRun ? "   [DRY RUN — no agents, no writes]" : ""}\n`);

  const started = Date.now();
  const results = await orchestrate(plan, {
    repoPath,
    concurrency: cli.concurrency,
    dryRun: cli.dryRun,
    onEvent: (e) => {
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

  report(results, Date.now() - started, cli.dryRun);
  const failed = results.filter((r) => r.status === "failed").length;
  process.exit(failed > 0 ? 1 : 0);
}

function report(results: TaskResult[], totalMs: number, dryRun: boolean): void {
  const count = (s: TaskResult["status"]) => results.filter((r) => r.status === s).length;
  console.log(`\n─── ${dryRun ? "Dry run" : "Build"} complete in ${Math.round(totalMs / 1000)}s ───`);
  console.log(
    `   ${dryRun ? "would build" : "built"}: ${count("success")}   ` +
      `deferred (human/ghl): ${count("deferred")}   ` +
      `skipped: ${count("skipped")}   failed: ${count("failed")}`,
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
