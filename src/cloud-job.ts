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
import { writeOperatorAnswers, buildOperatorContext, type OperatorAnswer } from "./operator-writeback.js";
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

  // Structured stdout for Cloud Logging (B3): one JSON object per line carrying
  // `severity` + `message` (+ runId, and taskId where relevant) so entries parse
  // into queryable fields instead of opaque text. This is stdout ONLY —
  // events.ndjson and run-state.json are the audit trail and stay untouched.
  const log = (severity: "INFO" | "WARNING" | "ERROR", message: string, extra: Record<string, unknown> = {}) =>
    process.stdout.write(JSON.stringify({ severity, message, runId, ...extra }) + "\n");

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

  // Per-run cost brake (B2). A plan may override the runner default; the default
  // is the MAX_RUN_USD env set on the Job, or a built-in floor. NEVER "no cap".
  // `spentUsd` is an in-process accumulator summed from task-done usage as it
  // lands — it is DELIBERATELY never written to runs/{id}.costUsd mid-run (that
  // rollup stays end-of-run and non-incremental; see §4c).
  const DEFAULT_RUN_CAP_USD = 25;
  const envCap = Number(process.env.MAX_RUN_USD);
  const runCapUsd = plan.policy.maxRunUsd
    ?? (Number.isFinite(envCap) && envCap > 0 ? envCap : DEFAULT_RUN_CAP_USD);
  let spentUsd = 0;
  let cappedOut = false;

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
    log("INFO", `resume: ${satisfied.size} human task(s) already done -> satisfied`);
  }

  const runDoc = db.collection("runs").doc(runId);
  const projectDoc = db.collection("projects").doc(projectDocId);
  const stamp = () => Date.now();

  // merge: keep estCostUsd + executionName the launcher (creator-solomon)
  // already stamped for guardrails accounting + the kill switch.
  await runDoc.set({
    runId, projectId: projectDocId, planUri, dryRun,
    modelOverride: override, status: "running", startedAt: stamp(), tasks: {},
  }, { merge: true });
  await projectDoc.update({ state: "running", updatedAt: stamp() });

  const repoPath = join("/workspace", plan.name.replace(/[^\w.-]+/g, "-"));
  mkdirSync(repoPath, { recursive: true });

  // 2d) OPERATOR WRITE-BACK materialisation. Answers live on humanTasks docs and
  //     attachments in Cloud Storage — both OUTSIDE this ephemeral container.
  //     Materialise them into the fresh workspace and into every agent's shared
  //     context BEFORE the first task dispatches (below), so a resume run sees the
  //     operator's answers without being told to look in BLOCKERS.md. Best-effort:
  //     a failure here must not turn a runnable plan into a stuck run.
  try {
    const ansSnap = await db.collection("humanTasks").where("projectId", "==", projectDocId).get();
    const answers: OperatorAnswer[] = ansSnap.docs
      .map((d) => d.data())
      .filter((t) => typeof t.answer === "string" && (t.answer as string).trim())
      .map((t) => ({
        title: String(t.title ?? t.blocksTaskId ?? "blocker"),
        source: t.source === "GHL-SETUP.md" ? "GHL-SETUP.md" : "BLOCKERS.md",
        answer: String(t.answer),
        answeredBy: t.answeredBy ? String(t.answeredBy) : undefined,
      }));
    if (answers.length) writeOperatorAnswers(repoPath, answers, new Date().toISOString());

    // Attachments: own try so a missing bucket cannot lose the answers above.
    const attachmentNames: string[] = [];
    try {
      const inBucket = process.env.CREATOR_BUCKET ?? `${env("GCP_PROJECT_ID")}-creator`;
      const prefix = `project-inputs/${projectDocId}/`;
      const [files] = await storage.bucket(inBucket).getFiles({ prefix });
      const inputsDir = join(repoPath, "inputs");
      for (const f of files) {
        const leaf = f.name.slice(prefix.length);
        if (!leaf || f.name.endsWith("/")) continue;
        mkdirSync(inputsDir, { recursive: true });
        await f.download({ destination: join(inputsDir, leaf) });
        attachmentNames.push(leaf);
      }
    } catch (e) {
      log("WARNING", "operator attachment download failed (non-fatal)", { error: String(e) });
    }

    // Thread both into every agent's context. Extending BuildPlan (rather than
    // threading a new parameter through orchestrate -> runTask) keeps the whole
    // change to cloud-job + one guarded append in agent.ts's sharedContext:
    // cloud-job already owns and mutates `plan` (it sets plan.model on override),
    // and the CLI path never sets operatorContext, so it stays a no-op there.
    const ctx = buildOperatorContext(answers, attachmentNames);
    if (ctx) plan.operatorContext = ctx;
    log("INFO", `operator write-back: ${answers.length} answer(s), ${attachmentNames.length} attachment(s)`);
  } catch (e) {
    log("WARNING", "operator write-back materialisation failed (non-fatal)", { error: String(e) });
  }

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
  log("INFO",
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
    // B2: stop dispatching once accumulated reported cost reaches the cap.
    capReached: () => {
      const over = spentUsd >= runCapUsd;
      if (over) cappedOut = true;
      return over;
    },
    onEvent: (e) => {
      // Accumulate reported cost as it lands (tasks with no usage add nothing).
      if (e.type === "task-done" && e.result.usage) spentUsd += e.result.usage.costUsd;
      switch (e.type) {
        case "task-start":
          setTask(e.task.id, { status: "running", executor: e.task.executor, model: e.task.model ?? plan.model ?? "sonnet", startedAt: stamp() });
          log("INFO", `task start: ${e.task.id}`, { taskId: e.task.id });
          break;
        case "task-log":
          setTask(e.task.id, { lastLog: e.text.slice(0, 500), logAt: stamp() });
          break;
        case "task-done":
          // usage is undefined for anything no agent ran; Firestore is
          // constructed with ignoreUndefinedProperties so those keys simply
          // do not appear, which is what the cockpit reads as "unknown".
          setTask(e.task.id, {
            status: e.result.status,
            summary: e.result.summary?.slice(0, 1000),
            error: e.result.error,
            durationMs: e.result.durationMs,
            costUsd: e.result.usage?.costUsd,
            tokensIn: e.result.usage?.inputTokens,
            tokensOut: e.result.usage?.outputTokens,
            turns: e.result.usage?.turns,
          });
          log(e.result.status === "failed" ? "WARNING" : "INFO",
            `task done: ${e.task.id} -> ${e.result.status}`,
            { taskId: e.task.id, status: e.result.status, costUsd: e.result.usage?.costUsd, spentUsd });
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
          log("WARNING", `task skipped: ${e.task.id} — ${e.reason}`, { taskId: e.task.id });
          break;
      }
    },
  });

  // 4) Final lifecycle state — the operator's vocabulary.
  const failed = results.filter((r) => r.status === "failed").length;
  const deferred = results.filter((r) => r.status === "deferred").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  // A cost-cap termination is "stuck" (needs the operator), never "waiting" —
  // even though the halted tasks come back as skipped.
  const state = cappedOut || failed > 0 ? "stuck" : deferred + skipped > 0 ? "waiting" : "complete";

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
      log("INFO", `workspace preserved: gs://${bucket}/${artifact}`);
    } catch (e) {
      log("WARNING", "workspace preservation failed (non-fatal)", { error: String(e) });
    }
  }

  // 4c) Roll up what the run actually cost, so Status stops accounting the
  // daily cap against the launch-time forecast.
  //
  // Only written when at least one task reported usage. A run with no
  // telemetry must leave costUsd ABSENT, not 0 — spendToday() prefers an
  // actual over the estimate, so a confident zero here would silently erase
  // the run from the spend cap. Absent means unknown; zero means free.
  const reported = results.filter((r) => r.usage);
  const usageRollup = reported.length
    ? {
        costUsd: Math.round(reported.reduce((s, r) => s + r.usage!.costUsd, 0) * 1e4) / 1e4,
        tokensIn: reported.reduce((s, r) => s + r.usage!.inputTokens, 0),
        tokensOut: reported.reduce((s, r) => s + r.usage!.outputTokens, 0),
        tasksReportingUsage: reported.length,
      }
    : {};

  // On a cap termination, record a clear reason plus the run cap and the actual
  // in-process spend under a DISTINCT field name — never overwriting costUsd,
  // which the §4c rollup owns. runSpendUsd is the accumulator's final value.
  const capFields = cappedOut
    ? { terminatedReason: "cost-cap", runCapUsd, runSpendUsd: Math.round(spentUsd * 1e4) / 1e4 }
    : {};
  await runDoc.set(
    { status: "finished", finishedAt: stamp(), failed, deferred, skipped, ...usageRollup, ...capFields },
    { merge: true },
  );
  await projectDoc.update({ state: dryRun ? "drafted" : state, updatedAt: stamp() });
  const built = results.filter((r) => r.status === "success").length;
  log(cappedOut || failed > 0 ? "WARNING" : "INFO",
    `run ${state}: built ${built}, deferred ${deferred}, skipped ${skipped}, failed ${failed}` +
    (cappedOut ? ` — TERMINATED on cost cap ($${Math.round(spentUsd * 1e4) / 1e4} >= $${runCapUsd})` : "") +
    (reported.length ? ` — cost $${usageRollup.costUsd} over ${reported.length} task(s)` : " — cost not reported"),
    { state, built, deferred, skipped, failed, cappedOut, runCapUsd, spentUsd: Math.round(spentUsd * 1e4) / 1e4 });
  process.exit(cappedOut || failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  process.stdout.write(JSON.stringify({
    severity: "ERROR", message: "cloud-job fatal", error: String(e), runId: process.env.RUN_ID,
  }) + "\n");
  try {
    await db.collection("runs").doc(env("RUN_ID")).set({ status: "finished", error: String(e), finishedAt: Date.now() }, { merge: true });
    await db.collection("projects").doc(env("PROJECT_DOC_ID")).update({ state: "stuck", updatedAt: Date.now() });
  } catch { /* best effort */ }
  process.exit(1);
});
