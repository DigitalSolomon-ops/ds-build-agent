/**
 * Integration hookups handed to a build agent — MCP servers + the extra tool
 * allow-patterns that unlock them. SDK-FREE on purpose so the checks/ drivers
 * and codex.ts can import it without dragging in the Agent SDK.
 *
 * Two server transports are supported:
 *  - http:  a remote MCP endpoint (e.g. GHL scoped to one sub-account), the
 *           shape cloud-job.ts already constructs.
 *  - stdio: a local MCP server spawned as a child process (e.g. Playwright,
 *           which drives a real headless Chromium). This is the transport that
 *           gives the fleet genuine browser clicking in an unattended run.
 */

/** One MCP server the agent may call, by transport. */
export type McpServerConfig =
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> };

/** Optional integration hookups injected by the runtime (cloud-job / CLI). */
export interface AgentIntegrations {
  /** MCP servers handed to every agent (keyed by the name used in `mcp__<key>__*`). */
  mcpServers?: Record<string, McpServerConfig>;
  /** Extra allowed tool patterns (e.g. "mcp__ghl__*", "mcp__playwright__*"). */
  extraAllowedTools?: string[];
}

/** The MCP server key the browser rides in under; tools are `mcp__playwright__*`. */
export const BROWSER_MCP_KEY = "playwright";
/** Allow-pattern that unlocks every Playwright MCP tool for a browser task. */
export const BROWSER_TOOL_PATTERN = `mcp__${BROWSER_MCP_KEY}__*`;

/** Overridable knobs for the Playwright MCP launch (env-driven by default). */
export interface BrowserOptions {
  /** Executable that starts the MCP server. Default: `npx`. */
  command?: string;
  /** Args after the command. Default: the pinned @playwright/mcp headless launch. */
  args?: string[];
  /** Extra env for the child. Merged over a minimal default. */
  env?: Record<string, string>;
}

/**
 * The Playwright MCP server config. Runs headless + isolated (a throwaway
 * profile per run) so it is safe in an unattended container and leaks no
 * logged-in state between builds. Command/args are overridable via
 * PLAYWRIGHT_MCP_COMMAND / PLAYWRIGHT_MCP_ARGS (space-split) for pinned or
 * pre-installed deployments, or via the `opts` argument (tests pass this).
 */
export function browserIntegration(opts: BrowserOptions = {}): AgentIntegrations {
  const envCmd = process.env.PLAYWRIGHT_MCP_COMMAND?.trim();
  const envArgs = process.env.PLAYWRIGHT_MCP_ARGS?.trim();
  const command = opts.command ?? (envCmd || "npx");
  const args =
    opts.args ??
    (envArgs
      ? envArgs.split(/\s+/)
      : ["-y", "@playwright/mcp@latest", "--headless", "--isolated"]);
  const server: McpServerConfig = { type: "stdio", command, args };
  if (opts.env && Object.keys(opts.env).length) server.env = { ...opts.env };
  return {
    mcpServers: { [BROWSER_MCP_KEY]: server },
    extraAllowedTools: [BROWSER_TOOL_PATTERN],
  };
}

/**
 * Merge two integration sets: servers union (right wins on key collision),
 * allowed-tool patterns concatenated and de-duped. Pure — returns a fresh
 * object and never mutates its inputs. Either side may be undefined.
 */
export function mergeIntegrations(
  a: AgentIntegrations | undefined,
  b: AgentIntegrations | undefined,
): AgentIntegrations | undefined {
  if (!a) return b;
  if (!b) return a;
  const mcpServers = { ...(a.mcpServers ?? {}), ...(b.mcpServers ?? {}) };
  const tools = [...(a.extraAllowedTools ?? []), ...(b.extraAllowedTools ?? [])];
  const extraAllowedTools = [...new Set(tools)];
  const out: AgentIntegrations = {};
  if (Object.keys(mcpServers).length) out.mcpServers = mcpServers;
  if (extraAllowedTools.length) out.extraAllowedTools = extraAllowedTools;
  return out;
}

/**
 * Resolve the effective integrations for one task: the run-level base plus the
 * browser hookup when the task opts in (`task.browser`). This is the single
 * seam both build runners (Claude + Codex) call, so browser enablement is
 * decided in exactly one place. Non-browser tasks get `base` back unchanged.
 */
export function composeAgentIntegrations(
  base: AgentIntegrations | undefined,
  task: { browser?: boolean },
  opts: BrowserOptions = {},
): AgentIntegrations | undefined {
  if (!task.browser) return base;
  return mergeIntegrations(base, browserIntegration(opts));
}
