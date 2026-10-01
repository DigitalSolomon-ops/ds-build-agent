/**
 * How build agents authenticate to Claude.
 *
 *   subscription  The Claude Code subscription login on this machine
 *                 (~/.claude/.credentials.json, or CLAUDE_CODE_OAUTH_TOKEN).
 *                 No API spend: usage counts against the plan's limits.
 *   api           ANTHROPIC_API_KEY, billed per token.
 *
 * Claude Code prefers an API key whenever one is in its environment, so
 * subscription mode works by REMOVING the key from the agents' environment,
 * not by adding anything.
 *
 * Default: subscription for local runs, api inside Cloud Run (the cloud runner
 * has no subscription login and gets its key from Secret Manager). Override
 * with --subscription / --api, or DS_BUILD_AUTH=subscription|api.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AuthMode = "subscription" | "api";

/** Env vars that make Claude Code bill the API instead of the subscription. */
export const API_AUTH_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

type Env = Record<string, string | undefined>;

/** Cloud Run services set K_SERVICE; Cloud Run jobs set CLOUD_RUN_JOB. */
export const inCloud = (env: Env = process.env): boolean => !!(env.CLOUD_RUN_JOB || env.K_SERVICE);

export function resolveAuthMode(
  flags: { subscription?: boolean; api?: boolean },
  env: Env = process.env,
): AuthMode {
  if (flags.subscription && flags.api) throw new Error("Pass --subscription or --api, not both.");
  if (flags.api) return "api";
  if (flags.subscription) return "subscription";
  const fromEnv = env.DS_BUILD_AUTH?.trim().toLowerCase();
  if (fromEnv === "api" || fromEnv === "subscription") return fromEnv;
  if (fromEnv) throw new Error(`DS_BUILD_AUTH must be "subscription" or "api", not "${env.DS_BUILD_AUTH}".`);
  return inCloud(env) ? "api" : "subscription";
}

/** The mode every agent in this process uses. index.ts pins it via DS_BUILD_AUTH. */
export const currentAuthMode = (env: Env = process.env): AuthMode => resolveAuthMode({}, env);

/** The agents' environment for a mode: subscription strips every API credential. */
export function agentAuthEnv(mode: AuthMode, base: Env): Env {
  if (mode === "api") return { ...base };
  const out: Env = { ...base };
  for (const k of API_AUTH_VARS) delete out[k];
  return out;
}

/** Where Claude Code keeps the subscription login (respects CLAUDE_CONFIG_DIR). */
export function subscriptionLoginPath(env: Env = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json");
}

/**
 * Is a subscription login available? Either a stored login file or an
 * explicit CLAUDE_CODE_OAUTH_TOKEN. Returns a reason string when it is not.
 */
export function subscriptionLoginProblem(env: Env = process.env, exists = existsSync): string | undefined {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return undefined;
  const p = subscriptionLoginPath(env);
  if (exists(p)) return undefined;
  return `No Claude subscription login found at ${p}. Sign in once with Claude Code (run \`claude\` and use /login), or pass --api to bill ANTHROPIC_API_KEY instead.`;
}
