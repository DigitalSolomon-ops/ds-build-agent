// Unit tests for the repo-bridge build-path resolution (--repo), against dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { resolveBuildPath } from "../dist/paths.js";

test("no --repo: greenfield default is <out>/<safeName>", () => {
  const out = resolve("/tmp/builds");
  assert.equal(resolveBuildPath(undefined, out, "my-app"), join(out, "my-app"));
});

test("--repo: builds in the existing repo verbatim, no safeName suffix", () => {
  const repo = resolve("/work/robinhood/agent");
  assert.equal(resolveBuildPath(repo, resolve("/tmp/builds"), "robinhood-stock-lane"), repo);
});

test("--repo is resolved to absolute", () => {
  // A relative repo path resolves against cwd, exactly like resolve() would.
  assert.equal(resolveBuildPath("some/rel/repo", resolve("/tmp/builds"), "x"), resolve("some/rel/repo"));
});

test("--repo ignores out and safeName entirely", () => {
  const repo = resolve("/existing/repo");
  const a = resolveBuildPath(repo, resolve("/out/one"), "name-a");
  const b = resolveBuildPath(repo, resolve("/out/two"), "name-b");
  assert.equal(a, b); // out/safeName don't affect an in-place build
});
