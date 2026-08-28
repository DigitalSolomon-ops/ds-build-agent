/**
 * Prompt composition — the standing context and the per-task instruction handed
 * to a build agent. SDK-FREE on purpose (like model.ts / parser.ts): both the
 * Claude runner (agent.ts) and the Codex runner (codex.ts) import these, and
 * neither the checks/ drivers nor codex.ts should drag in the Agent SDK.
 */
import type { BuildPlan, Task } from "./types.js";

/**
 * Compose the standing context handed to every agent: what app is being
 * built, the approved stack, and the house conventions. This keeps builds
 * consistent regardless of which task an agent picks up — or which coding
 * brain (Claude or Codex) executes it.
 */
export function sharedContext(plan: BuildPlan): string {
  const lines: string[] = [
    `You are building the application "${plan.name}".`,
  ];
  if (plan.description) lines.push(`\nApp description:\n${plan.description}`);
  if (plan.stack?.length) {
    lines.push(`\nApproved technology stack (use these unless the task says otherwise):`);
    for (const s of plan.stack) lines.push(`  - ${s}`);
  }
  if (plan.conventions?.length) {
    lines.push(`\nConventions every task must follow:`);
    for (const c of plan.conventions) lines.push(`  - ${c}`);
  }
  lines.push(
    `\nHard rules:`,
    `  - Never write API keys, tokens, or credentials into source. Use a .env`,
    `    file (git-ignored) and documented placeholders (e.g. GHL Custom Values).`,
    `  - When a real URL/id/credential is not yet available, use a clearly-named`,
    `    placeholder and note it, rather than inventing a value.`,
  );
  // Operator write-back: answers to prior blockers + attached documents. The
  // cloud runner assembles this from Firestore/Storage so an agent reads the
  // operator's answer here rather than being told to open BLOCKERS.md.
  if (plan.operatorContext) {
    lines.push(`\n${plan.operatorContext}`);
  }
  return lines.join("\n");
}

/** Build the concrete instruction for a single task. */
export function taskPrompt(task: Task): string {
  const lines: string[] = [
    `# Task: ${task.title}`,
    ``,
    task.brief,
  ];
  if (task.outputs?.length) {
    lines.push(``, `Expected outputs: ${task.outputs.join(", ")}`);
  }
  if (task.acceptance?.length) {
    lines.push(``, `Acceptance criteria — verify each before you finish:`);
    for (const a of task.acceptance) lines.push(`  - [ ] ${a}`);
  }
  lines.push(
    ``,
    `When done, end with a short summary of what you changed and confirm the`,
    `acceptance criteria are met. If you could not meet a criterion, say so explicitly.`,
  );
  return lines.join("\n");
}
