/**
 * Unit tests for the headless-browser integration seam (dist/integrations.js) +
 * the parser's `browser` opt-in. Pure functions — no browser is launched.
 * `npm test` builds dist/ first. Run alone: node --test checks/browser.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const DIST = new URL("../dist/", import.meta.url);
const {
  browserIntegration,
  mergeIntegrations,
  composeAgentIntegrations,
  BROWSER_MCP_KEY,
  BROWSER_TOOL_PATTERN,
} = await import(new URL("integrations.js", DIST).href);
const { validatePlan } = await import(new URL("parser.js", DIST).href);

test("browserIntegration: default is a headless, isolated Playwright stdio server", () => {
  const it = browserIntegration({}); // {} → ignore ambient env in this process
  const srv = it.mcpServers[BROWSER_MCP_KEY];
  assert.equal(srv.type, "stdio");
  assert.equal(srv.command, "npx");
  assert.ok(srv.args.includes("@playwright/mcp@latest"));
  assert.ok(srv.args.includes("--headless"), "unattended container → headless");
  assert.ok(srv.args.includes("--isolated"), "throwaway profile, no cross-build state");
  assert.deepEqual(it.extraAllowedTools, [BROWSER_TOOL_PATTERN]);
  assert.equal(BROWSER_TOOL_PATTERN, "mcp__playwright__*");
});

test("browserIntegration: explicit opts override command/args", () => {
  const it = browserIntegration({ command: "node", args: ["server.js"], env: { X: "1" } });
  const srv = it.mcpServers[BROWSER_MCP_KEY];
  assert.equal(srv.command, "node");
  assert.deepEqual(srv.args, ["server.js"]);
  assert.deepEqual(srv.env, { X: "1" });
});

test("mergeIntegrations: unions servers and de-dupes tool patterns", () => {
  const ghl = {
    mcpServers: { ghl: { type: "http", url: "https://x/mcp/", headers: { Authorization: "Bearer y" } } },
    extraAllowedTools: ["mcp__ghl__*"],
  };
  const merged = mergeIntegrations(ghl, browserIntegration({}));
  assert.ok(merged.mcpServers.ghl, "http server preserved");
  assert.ok(merged.mcpServers.playwright, "browser server added");
  assert.deepEqual(merged.extraAllowedTools, ["mcp__ghl__*", "mcp__playwright__*"]);
  // A repeated pattern is collapsed.
  const dup = mergeIntegrations(
    { extraAllowedTools: ["mcp__playwright__*"] },
    browserIntegration({}),
  );
  assert.deepEqual(dup.extraAllowedTools, ["mcp__playwright__*"]);
});

test("mergeIntegrations: undefined sides pass through", () => {
  const b = browserIntegration({});
  assert.equal(mergeIntegrations(undefined, undefined), undefined);
  assert.deepEqual(mergeIntegrations(undefined, b), b);
  assert.deepEqual(mergeIntegrations(b, undefined), b);
});

test("composeAgentIntegrations: a non-browser task gets base back unchanged", () => {
  const base = { extraAllowedTools: ["mcp__ghl__*"] };
  assert.equal(composeAgentIntegrations(base, { browser: false }), base);
  assert.equal(composeAgentIntegrations(base, {}), base);
  assert.equal(composeAgentIntegrations(undefined, {}), undefined);
});

test("composeAgentIntegrations: a browser task folds in Playwright + keeps base", () => {
  const base = {
    mcpServers: { ghl: { type: "http", url: "https://x/mcp/" } },
    extraAllowedTools: ["mcp__ghl__*"],
  };
  const eff = composeAgentIntegrations(base, { browser: true }, {});
  assert.ok(eff.mcpServers.ghl && eff.mcpServers.playwright, "both servers present");
  assert.ok(eff.extraAllowedTools.includes("mcp__ghl__*"));
  assert.ok(eff.extraAllowedTools.includes("mcp__playwright__*"));
  // base must not be mutated.
  assert.equal(base.mcpServers.playwright, undefined);
});

test("parser: task `browser: true` is parsed; anything else is off", () => {
  const p = validatePlan(
    {
      name: "P",
      tasks: [
        { id: "a", prompt: "x", browser: true },
        { id: "b", prompt: "y", browser: false },
        { id: "c", prompt: "z" },
        { id: "d", prompt: "w", browser: "yes" },
      ],
    },
    { quiet: true },
  );
  assert.equal(p.tasks[0].browser, true);
  assert.equal(p.tasks[1].browser, undefined);
  assert.equal(p.tasks[2].browser, undefined);
  assert.equal(p.tasks[3].browser, undefined, "non-boolean is not an opt-in");
});
