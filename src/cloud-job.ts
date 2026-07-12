/**
 * Cloud Run Job entrypoint — runs one build plan for The Creator's 007 Agent.
 *
 * Env contract (set per-execution by creator-solomon):
 *   PLAN_URI        gs:// URI of the plan YAML (written by Architect)
 *   PROJECT_DOC_ID  Firestore projects/{id} to update through the lifecycle
 *   RUN_ID          Firestore runs/{id} to stream per-task state into
 *   MODEL_OVERRIDE  plan | haiku | sonnet | opus   (default: plan)
 *   DRY_RUN         "true" to route without building
 *   GCP_PROJECT_ID  Firestore/Storage project
 *   ANTHROPIC_API_KEY  injected from Secret Manager by the job definition
 *
 * Status lifecycle written to projects/{PROJECT_DOC_ID}.state:
 *   running -> waiting (human tasks / launch gate) | stuck (task failed)
 *           -> complete (everything resolved)
 */
import { Firestore } from "@google-cloud/firestore";
import { Storage } from "@google-cloud/storage";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { validatePlan } from "./parser.js";
import { orchestrate } from "./orchestrator.js";
import type { TaskResult } from "./types.js";

const env = (k: string, fallback?: string): string => {
  const v = process.env[k] ?? fallback;
  if (v === undefined) throw new Error(`Missing env: ${k}`);
  return v;
};

const db = new Firestore({ projectId: env("GCP_PROJECT_ID"), ignoreUndefinedProperties: true });
const storage = new Storage({ projectId: env("GCP_PROJECT_ID") });

async function main() {
  const planUri = env("PLAN_URI");
  const projectDocId = env("PROJECT_DOC_ID");
  const runId = env("RUN_ID");
  const override = env("MODEL_OVERRIDE", "plan");
  const dryRun = env("DRY_RUN", "false") === "true";

  // 1) Fetch + validate the plan.
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(planUri);
  if (!m) throw new Error(`PLAN_URI is not a gs:// URI: ${planUri}`);
  const [buf] = await storage.bucket(m[1]).file(m[2]).download();
  const plan = validatePlan(parseYaml(buf.toString("utf8")));

  // 2) Run-level model override (the cockpit's toggle).
  if (override !== "plan") {
    plan.model = override;
    for (const t of plan.tasks) t.model = undefined; // override beats per-task routing
  }

  // 2b) RESUME SEMANTICS: human/ghl tasks the operator already checked off in
  // Status are SATISFIED — remove them from the plan (and from deps) so they
  // don't re-defer, and so a done phase-6 sign-off lets the launch gate open.
  const doneSnap = await db.collection("humanTasks")
    .where("projectId", "==", projectDocId).where("done", "==", true).get();
  const satisfied = new Set(
    doneSnap.docs.map((d) => d.data().blocksTaskId as string | undefined).filter(Boolean),
  );
  if (satisfied.size) {
    plan.tasks = plan.tasks
      .filter((t) => !(satisfied.has(t.id) && t.executor !== "agent"))
      .map((t) => ({ ...t, deps: (t.deps ?? []).filter((d) => !satisfied.has(d)) }));
    console.log(`resume: ${satisfied.size} human task(s) already done -> satisfied`);
  }

  const runDoc = db.collection("runs").doc(runId);
  const projectDoc = db.collection("projects").doc(projectDocId);
  const stamp = () => Date.now();

  await runDoc.set({
    runId, projectId: projectDocId, planUri, dryRun,
    modelOverride: override, status: "running", startedAt: stamp(), tasks: {},
  });
  await projectDoc.update({ state: "running", updatedAt: stamp() });

  const repoPath = join("/workspace", plan.name.replace(/[^\w.-]+/g, "-"));
  mkdirSync(repoPath, { recursive: true });

  // 2c) INTEGRATIONS — the swarm's hands, credentialed from the Vault.
  //     GHL rides in as an MCP server scoped to ONE sub-account (PIT +
  //     Location ID); n8n/Vapi/GitHub keys land in the agents' environment.
  //     All lookups are best-effort: a missing slot just means that hand
  //     stays in the pocket for this run.
  const { SecretManagerServiceClient } = await import("@google-cloud/secret-manager");
  const sm = new SecretManagerServiceClient();
  const secretVal = async (slotDocId: string): Promise<string | undefined> => {
    try {
      const meta = await db.collection("credentialRefs").doc(slotDocId).get();
      if (!meta.exists || !meta.data()!.set) return undefined;
      const [v] = await sm.accessSecretVersion({ name: `${meta.data()!.ref}/versions/latest` });
      return v.payload?.data?.toString();
    } catch { return undefined; }
  };
  const slotId = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, "-");

  const [ghlPit, ghlLocation, n8nKey, vapiKey, githubPat] = await Promise.all([
    secretVal(slotId(`${projectDocId}/ghl-pit`)),
    secretVal(slotId(`${projectDocId}/ghl-location`)),
    secretVal("global-n8n"),
    secretVal("global-vapi"),
    secretVal("global-github"),
  ]);
  if (n8nKey) { process.env.N8N_API_KEY = n8nKey; process.env.N8N_BASE_URL = "https://automation.digitalsolomon.com"; }
  if (vapiKey) process.env.VAPI_API_KEY = vapiKey;
  if (githubPat) process.env.GITHUB_TOKEN = githubPat;

  const integrations = ghlPit && ghlLocation
    ? {
        mcpServers: {
          ghl: {
            type: "http" as const,
            url: "https://services.leadconnectorhq.com/mcp/",
            headers: { Authorization: `Bearer ${ghlPit}`, locationId: ghlLocation },
          },
        },
        extraAllowedTools: ["mcp__ghl__*"],
      }
    : undefined;
  console.log(
    `integrations: ghl-mcp=${integrations ? "on (one sub-account)" : "off"}, ` +
    `n8n=${n8nKey ? "on" : "off"}, vapi=${vapiKey ? "on" : "off"}, github=${githubPat ? "on" : "off"}`,
  );

  // 3) Execute, streaming every task transition into the run doc.
  const setTask = (id: string, patch: Record<string, unknown>) =>
    runDoc.set({ tasks: { [id]: patch } }, { merge: true }).catch(() => {});

  const results: TaskResult[] = await orchestrate(plan, {
    repoPath,
    concurrency: Number(process.env.CONCURRENCY ?? 2),
    dryRun,
    integrations,
    onEvent: (e) => {
      switch (e.type) {
        case "task-start":
          setTask(e.task.id, { status: "running", executor: e.task.executor, model: e.task.model ?? plan.model ?? "sonnet", startedAt: stamp() });
          break;
        case "task-log":
          setTask(e.task.id, { lastLog: e.text.slice(0, 500), logAt: stamp() });
          break;
        case "task-done":
          setTask(e.task.id, { status: e.result.status, summary: e.result.summary?.slice(0, 1000), error: e.result.error, durationMs: e.result.durationMs });
          break;
        case "task-deferred": {
          setTask(e.task.id, { status: "deferred", executor: e.task.executor, doc: e.doc });
          // Human task -> Status surface's checkoff list.
          db.collection("humanTasks").doc(`${runId}-${e.task.id}`).set({
            taskId: `${runId}-${e.task.id}`,
            projectId: projectDocId,
            runId,
            blocksTaskId: e.task.id,
            source: e.doc,
            title: e.task.title,
            detail: e.task.brief.slice(0, 1500),
            done: false,
            createdAt: stamp(),
          }).catch(() => {});
          break;
        }
        case "task-skipped":
          setTask(e.task.id, { status: "skipped", error: e.reason });
          break;
      }
    },
  });

  // 4) Final lifecycle state — the operator's vocabulary.
  const failed = results.filter((r) => r.status === "failed").length;
  const deferred = results.filter((r) => r.status === "deferred").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const state = failed > 0 ? "stuck" : deferred + skipped > 0 ? "waiting" : "complete";

  // 4b) Preserve the build: tar the workspace to GCS so Delivered has real
  // artifacts (the job container is ephemeral). Best effort — a failed upload
  // must not turn a finished run into a stuck one.
  if (!dryRun && results.some((r) => r.status === "success")) {
    try {
      const { execFileSync } = await import("node:child_process");
      const tarPath = `/tmp/${runId}.tar.gz`;
      execFileSync("tar", ["-czf", tarPath, "-C", repoPath, "."]);
      const artifact = `deliverables/${projectDocId}/${runId}-workspace.tar.gz`;
      const bucket = process.env.CREATOR_BUCKET ?? `${env("GCP_PROJECT_ID")}-creator`;
      await storage.bucket(bucket).upload(tarPath, { destination: artifact });
      await db.collection("deliverables").doc(projectDocId).set({
        projectId: projectDocId,
        completedAt: stamp(),
        artifactUris: [`gs://${bucket}/${artifact}`],
      }, { merge: true });
      console.log(`workspace preserved: gs://${bucket}/${artifact}`);
    } catch (e) {
      console.error("workspace preservation failed (non-fatal):", e);
    }
  }

  await runDoc.set({ status: "finished", finishedAt: stamp(), failed, deferred, skipped }, { merge: true });
  await projectDoc.update({ state: dryRun ? "drafted" : state, updatedAt: stamp() });
  console.log(`run ${runId}: ${state} (built ${results.filter((r) => r.status === "success").length}, deferred ${deferred}, skipped ${skipped}, failed ${failed})`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("cloud-job fatal:", e);
  try {
    await db.collection("runs").doc(env("RUN_ID")).set({ status: "finished", error: String(e), finishedAt: Date.now() }, { merge: true });
    await db.collection("projects").doc(env("PROJECT_DOC_ID")).update({ state: "stuck", updatedAt: Date.now() });
  } catch { /* best effort */ }
  process.exit(1);
});
