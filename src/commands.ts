/**
 * Subcommands beside the main `ds-build <plan>` run:
 *
 *   ds-build sync <project> [--plan <file>] [--dry-run]   queue a project in Local Builds
 *   ds-build airspace list                                 live claims + held launches
 *   ds-build airspace check <plan.yaml>                    would this plan be held right now?
 *   ds-build airspace draft <plan.yaml>                    draft an airspace block for review
 *   ds-build local-runner [--once]                         run cockpit-launched Local Builds plans
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadPlan } from "./parser.js";
import { claimResources, draftAirspaceYaml, findConflicts, formatHeld } from "./airspace.js";
import { openAirspaceRegistry } from "./airspace-launch.js";
import { creatorSyncBackend, findProjectsRoot, syncProject } from "./sync.js";
import { creatorRunnerBackend, runLaunch, runnerPass } from "./local-runner.js";

export const SUBCOMMANDS = new Set(["sync", "airspace", "local-runner"]);

const harnessRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const left = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};

/** Returns the process exit code. */
export async function runSubcommand(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  const root = findProjectsRoot(harnessRoot) ?? findProjectsRoot(process.cwd());

  if (cmd === "sync") {
    const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--plan");
    if (!target) {
      console.error("Usage: ds-build sync <project-dir | project-key> [--plan <file>] [--dry-run]");
      return 2;
    }
    if (!root) {
      console.error("✗ Could not find the Projects root (the folder holding studio.yaml).");
      return 1;
    }
    const dryRun = args.includes("--dry-run");
    const backend = dryRun
      ? { getProject: async () => undefined, putProject: async () => {}, uploadPlan: async () => "gs://preview" }
      : await creatorSyncBackend();
    const r = await syncProject({ projectArg: target, root, backend, planArg: flag(args, "--plan"), dryRun });
    console.log(`${r.action === "refused" ? "✗" : "▸"} ${r.message}`);
    if (r.planPath) console.log(`  plan: ${r.planPath}`);
    if (r.draft) {
      const out = join(harnessRoot, "builds", "sync", `${r.projectId}.${r.syncState === "review" ? "plan" : "airspace"}.yaml`);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, r.draft);
      console.log(`  draft for review: ${out}`);
    }
    return r.action === "refused" ? 1 : 0;
  }

  if (cmd === "airspace") {
    const sub = args[0];
    if (sub === "draft") {
      const file = args[1];
      if (!file) return (console.error("Usage: ds-build airspace draft <plan.yaml>"), 2);
      const raw = parseYaml(readFileSync(file, "utf8")) as Record<string, unknown> | null;
      if (raw && raw.airspace !== undefined) console.log("# This plan already has an airspace block; a fresh draft follows.");
      // The project folder: the nearest ancestor holding project.yaml (else the plan's folder).
      let projDir = dirname(resolve(file));
      for (let d = projDir; dirname(d) !== d; d = dirname(d)) {
        if (existsSync(join(d, "project.yaml"))) { projDir = d; break; }
      }
      console.log(draftAirspaceYaml({ projectPath: root ? relative(root, projDir).replace(/\\/g, "/") : undefined }));
      return 0;
    }
    const registry = openAirspaceRegistry();
    if (sub === "check") {
      const file = args[1];
      if (!file) return (console.error("Usage: ds-build airspace check <plan.yaml>"), 2);
      const plan = loadPlan(resolve(file), { quiet: true });
      const conflicts = findConflicts(claimResources(plan.name, plan.airspace), await registry.listActive(), "", Date.now());
      console.log(conflicts.length ? `✗ would be ${formatHeld(conflicts)}` : `▸ clear: ${plan.name} could launch now`);
      return conflicts.length ? 3 : 0;
    }
    if (sub === "list" || sub === undefined) {
      const now = Date.now();
      const active = await registry.listActive();
      const held = await registry.listHeld();
      console.log(`Active claims (${active.length})`);
      for (const c of active) {
        console.log(`  ${c.plan_name}  [${c.lane}]  run ${c.run_id}  lease ${left(c.lease_expires_at - now)}`);
        for (const r of c.resources) console.log(`      ${r}`);
      }
      console.log(`Held launches, last 24h (${held.length})`);
      for (const h of held) console.log(`  ${h.plan_name}  [${h.lane}]  ${h.message}`);
      return 0;
    }
    console.error("Usage: ds-build airspace <list | check <plan.yaml> | draft <plan.yaml>>");
    return 2;
  }

  if (cmd === "local-runner") {
    if (!root) {
      console.error("✗ Could not find the Projects root (the folder holding studio.yaml).");
      return 1;
    }
    const backend = await creatorRunnerBackend();
    const maxPlans = Number(process.env.LOCAL_RUNNER_MAX_PLANS) > 0 ? Number(process.env.LOCAL_RUNNER_MAX_PLANS) : 2;
    if (args.includes("--once")) {
      const ids = await runnerPass({ backend, projectsRoot: root, maxPlans });
      console.log(ids.length ? `▸ ran ${ids.join(", ")}` : "▸ nothing requested");
      return 0;
    }
    console.log(`▸ local-runner on ${hostname()}: polling for Local Builds launches (max ${maxPlans} plans at once)`);
    const inFlight = new Map<string, Promise<unknown>>();
    for (;;) {
      try {
        while (inFlight.size < maxPlans) {
          const rec = await backend.claimNext(hostname(), Date.now());
          if (!rec) break;
          console.log(`  ⏵ ${rec.projectId} (run ${rec.localLaunch.runId})`);
          const p = runLaunch(rec, { backend, projectsRoot: root }).then((state) => {
            console.log(`  ${state === "done" ? "✓" : "✗"} ${rec.projectId} -> ${state}`);
            inFlight.delete(rec.projectId);
          });
          inFlight.set(rec.projectId, p);
        }
        await backend.beat({ host: hostname(), beatAt: Date.now(), running: [...inFlight.keys()] });
      } catch (e) {
        console.warn(`  ⚠ poll failed (retrying): ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  return 2;
}
