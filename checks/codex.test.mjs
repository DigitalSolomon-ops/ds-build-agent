/**
 * Unit tests for the Codex build runner's pure core (dist/codex.js) + the
 * parser's acceptance of `executor: codex`. SDK-FREE and process-free: only the
 * deterministic helpers (buildCodexArgs, codexModel, parseCodexResult) are
 * exercised — never a real `codex` spawn. `npm test` builds dist/ first.
 * Run alone: node --test checks/codex.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const DIST = new URL("../dist/", import.meta.url);
const { buildCodexArgs, codexModel, parseCodexResult, codexPrompt } = await import(
  new URL("codex.js", DIST).href
);
const { validatePlan } = await import(new URL("parser.js", DIST).href);

const plan = { name: "Demo", policy: { commitAfterEachTask: false } };
const task = (over = {}) => ({
  id: "t1",
  title: "T1",
  brief: "do the thing",
  executor: "codex",
  auto: true,
  ...over,
});

test("buildCodexArgs: baseline exec invocation with the repo bound", () => {
  const args = buildCodexArgs(task(), plan, "/work/demo", {});
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--json"), "streams JSONL");
  assert.ok(args.includes("--skip-git-repo-check"), "fresh workspace may not be a repo yet");
  const si = args.indexOf("--sandbox");
  assert.equal(args[si + 1], "workspace-write", "default sandbox lets it edit files");
  const ci = args.indexOf("-C");
  assert.equal(args[ci + 1], "/work/demo", "bound to the build folder");
  assert.equal(args[args.length - 1], codexPrompt(task(), plan), "prompt is the final positional arg");
});

test("buildCodexArgs: CODEX_SANDBOX overrides the sandbox mode", () => {
  const args = buildCodexArgs(task(), plan, "/w", { CODEX_SANDBOX: "read-only" });
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
});

test("codexModel: a Claude tier is NOT sent to Codex", () => {
  assert.equal(codexModel({ model: "opus" }, {}), undefined);
  assert.equal(codexModel({ model: "sonnet" }, {}), undefined);
  assert.equal(codexModel({ model: "claude-opus-4-8" }, {}), undefined);
});

test("codexModel: a non-Claude task model passes through; else CODEX_MODEL", () => {
  assert.equal(codexModel({ model: "gpt-5-codex" }, {}), "gpt-5-codex");
  assert.equal(codexModel({}, { CODEX_MODEL: "o4-mini" }), "o4-mini");
  assert.equal(codexModel({}, {}), undefined);
});

test("buildCodexArgs: forwards -m only for a real Codex model", () => {
  assert.ok(!buildCodexArgs(task({ model: "opus" }), plan, "/w", {}).includes("-m"));
  const a = buildCodexArgs(task({ model: "gpt-5-codex" }), plan, "/w", {});
  assert.equal(a[a.indexOf("-m") + 1], "gpt-5-codex");
});

test("parseCodexResult: last agent message becomes the summary; text is streamed", () => {
  const seen = [];
  const parsed = parseCodexResult(
    [
      JSON.stringify({ type: "agent_message", text: "working…" }),
      JSON.stringify({ type: "item.completed", item: { last_agent_message: "all done" } }),
    ],
    (t) => seen.push(t),
  );
  assert.equal(parsed.summary, "all done");
  assert.deepEqual(seen, ["working…", "all done"]);
  assert.equal(parsed.events, 2);
});

test("parseCodexResult: token usage is captured, cost stays 0 (CLI does not price)", () => {
  const parsed = parseCodexResult([
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1200, output_tokens: 340 } }),
  ]);
  assert.ok(parsed.usage, "usage present when tokens are reported");
  assert.equal(parsed.usage.inputTokens, 1200);
  assert.equal(parsed.usage.outputTokens, 340);
  assert.equal(parsed.usage.costUsd, 0, "codex USD cost is unknown → 0");
});

test("parseCodexResult: a non-JSON line is treated as prose, not dropped", () => {
  const parsed = parseCodexResult(["plain text output"]);
  assert.equal(parsed.summary, "plain text output");
});

test("parseCodexResult: empty stream ⇒ no summary, no usage", () => {
  const parsed = parseCodexResult([]);
  assert.equal(parsed.summary, "");
  assert.equal(parsed.usage, undefined);
  assert.equal(parsed.events, 0);
});

test("parser: executor 'codex' is a valid BUILD task (auto true by default)", () => {
  const p = validatePlan(
    { name: "P", tasks: [{ id: "a", prompt: "x", executor: "codex" }] },
    { quiet: true },
  );
  assert.equal(p.tasks[0].executor, "codex");
  assert.equal(p.tasks[0].auto, true, "codex defaults to auto like agent");
});

test("parser: an unknown executor still hard-fails", () => {
  assert.throws(
    () => validatePlan({ name: "P", tasks: [{ id: "a", prompt: "x", executor: "gpt" }] }, { quiet: true }),
    /invalid executor/,
  );
});
