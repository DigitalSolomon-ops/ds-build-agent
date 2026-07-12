import { query } from "@anthropic-ai/claude-agent-sdk";
import type { BuildPlan, Task, TaskResult } from "./types.js";

/** Tools each build agent is allowed to use without prompting. */
const BUILD_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];

/** Default model alias for build tasks (plans/tasks may override). */
const DEFAULT_MODEL = "sonnet";

/**
 * Compose the standing context handed to every agent: what app is being
 * built, the approved stack, and the house conventions. This keeps builds
 * consistent regardless of which task an agent picks up.
 */
function sharedContext(plan: BuildPlan): string {
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
  return lines.join("\n");
}

/** Build the concrete instruction for a single task. */
function taskPrompt(task: Task): string {
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

/**
 * Run one task to completion in the target repo, headlessly.
 * Streams the agent's messages to `onMessage` (for live logging) and
 * resolves to a structured result.
 */
/** Optional integration hookups injected by the runtime (cloud-job). */
export interface AgentIntegrations {
  /** MCP servers handed to every agent (e.g. GHL scoped to one sub-account). */
  mcpServers?: Record<string, { type: "http"; url: string; headers?: Record<string, string> }>;
  /** Extra allowed tool patterns (e.g. "mcp__ghl__*"). */
  extraAllowedTools?: string[];
}

export async function runTask(
  task: Task,
  plan: BuildPlan,
  repoPath: string,
  onMessage?: (text: string) => void,
  integrations?: AgentIntegrations,
): Promise<TaskResult> {
  const start = Date.now();
  const model = task.model ?? plan.model ?? DEFAULT_MODEL;

  try {
    let finalSummary = "";
    for await (const message of query({
      prompt: taskPrompt(task),
      options: {
        cwd: repoPath,
        model,
        systemPrompt: { type: "preset", preset: "claude_code", append: sharedContext(plan) },
        allowedTools: [...BUILD_TOOLS, ...(integrations?.extraAllowedTools ?? [])],
        permissionMode: "acceptEdits",
        maxTurns: 60,
        ...(integrations?.mcpServers ? { mcpServers: integrations.mcpServers } : {}),
      },
    })) {
      // Surface the assistant's streamed text for live logs.
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && onMessage) onMessage(block.text);
        }
      }
      // The terminal `result` message carries the final outcome.
      if (message.type === "result") {
        if (message.subtype === "success") {
          finalSummary = message.result ?? "";
        } else {
          return {
            taskId: task.id,
            status: "failed",
            error: `Agent ended with subtype "${message.subtype}".`,
            durationMs: Date.now() - start,
          };
        }
      }
    }

    return {
      taskId: task.id,
      status: "success",
      summary: finalSummary,
      durationMs: Date.now() - start,
    };
  } catch (e) {
    return {
      taskId: task.id,
      status: "failed",
      error: (e as Error).message,
      durationMs: Date.now() - start,
    };
  }
}
