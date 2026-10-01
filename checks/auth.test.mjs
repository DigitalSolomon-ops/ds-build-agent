// Unit tests for agent auth: subscription (local default) vs API key.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAuthMode, agentAuthEnv, subscriptionLoginProblem, subscriptionLoginPath, inCloud, API_AUTH_VARS,
} from "../dist/auth.js";

test("local default is the subscription", () => {
  assert.equal(resolveAuthMode({}, {}), "subscription");
});

test("cloud default is the API key (Cloud Run job or service)", () => {
  assert.equal(resolveAuthMode({}, { CLOUD_RUN_JOB: "solomon-runner" }), "api");
  assert.equal(resolveAuthMode({}, { K_SERVICE: "creator-solomon" }), "api");
  assert.equal(inCloud({}), false);
});

test("flags beat env, env beats the default", () => {
  assert.equal(resolveAuthMode({ api: true }, { DS_BUILD_AUTH: "subscription" }), "api");
  assert.equal(resolveAuthMode({ subscription: true }, { CLOUD_RUN_JOB: "x" }), "subscription");
  assert.equal(resolveAuthMode({}, { DS_BUILD_AUTH: "API" }), "api");
  assert.equal(resolveAuthMode({}, { DS_BUILD_AUTH: "subscription", CLOUD_RUN_JOB: "x" }), "subscription");
});

test("an API key in the environment does NOT switch a local run to API billing", () => {
  assert.equal(resolveAuthMode({}, { ANTHROPIC_API_KEY: "sk-ant-fixture" }), "subscription");
});

test("contradictions and typos are refused, not guessed", () => {
  assert.throws(() => resolveAuthMode({ api: true, subscription: true }, {}), /not both/);
  assert.throws(() => resolveAuthMode({}, { DS_BUILD_AUTH: "subscriptoin" }), /must be/);
});

test("subscription mode strips every API credential from the agents' env", () => {
  const base = { ANTHROPIC_API_KEY: "sk-ant-fixture", ANTHROPIC_AUTH_TOKEN: "tok", PATH: "/bin", OTHER: "1" };
  const env = agentAuthEnv("subscription", base);
  for (const k of API_AUTH_VARS) assert.equal(k in env, false, `${k} leaked into a subscription agent`);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.OTHER, "1");
  assert.equal(base.ANTHROPIC_API_KEY, "sk-ant-fixture", "the parent env must not be mutated");
});

test("api mode passes the key through untouched", () => {
  const env = agentAuthEnv("api", { ANTHROPIC_API_KEY: "sk-ant-fixture" });
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-fixture");
});

test("login check: stored login file, OAuth token env, or a clear reason", () => {
  assert.equal(subscriptionLoginProblem({ CLAUDE_CONFIG_DIR: "/cfg" }, () => true), undefined);
  assert.equal(subscriptionLoginProblem({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, () => false), undefined);
  const why = subscriptionLoginProblem({ CLAUDE_CONFIG_DIR: "/cfg" }, () => false);
  assert.match(why, /No Claude subscription login/);
  assert.match(why, /--api/);
  assert.match(subscriptionLoginPath({ CLAUDE_CONFIG_DIR: "/cfg" }), /cfg.\.credentials\.json$/);
});
