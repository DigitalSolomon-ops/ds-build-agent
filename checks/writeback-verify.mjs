/**
 * Task 4 — operator write-back verification (unit-level, no cloud, no paid run).
 *
 * Drives the COMPILED harness modules to prove:
 *  - answers materialise into BLOCKERS.md / GHL-SETUP.md in the SAME blockquote
 *    format the retired local endpoint used, routed to the right doc;
 *  - the assembled operator-context carries both answers and attachment names;
 *  - that context actually reaches an agent via sharedContext() — the whole
 *    point of Task 4 ("an answer must reach agent context, not just a file").
 */
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Self-locating: dist/ is one level up from this checks/ directory.
const DIST = new URL("../dist/", import.meta.url);
const { humanUpdateBlock, writeOperatorAnswers, buildOperatorContext } =
  await import(new URL("operator-writeback.js", DIST).href);
const { sharedContext } = await import(new URL("prompt.js", DIST).href);

const checks = [];
const check = (name, ok) => checks.push([name, !!ok]);

const iso = "2026-07-31T12:00:00.000Z";

// ── format parity with the local POST /api/handoff-note ──────────────────────
// server.ts local: `\n> **Human update — ${ts}**\n>\n> ${quoted}` where
// quoted = note with each \n replaced by "\n> ".
const expected = `\n> **Human update — ${iso}**\n>\n> hello\n> world\n`;
check("humanUpdateBlock matches the local blockquote format exactly",
  humanUpdateBlock("hello\nworld", iso) === expected);

// ── materialisation into the two docs, routed by source ──────────────────────
const dir = mkdtempSync(join(tmpdir(), "ds-wb-"));
const answers = [
  { title: "GHL sandbox PIT", source: "BLOCKERS.md", answer: "Use the sandbox PIT already in the Vault slot.", answeredBy: "marcus@digitalsolomon.com" },
  { title: "Brand colours", source: "GHL-SETUP.md", answer: "Primary #C6972F.\nSecondary #1B2130." },
];
const counts = writeOperatorAnswers(dir, answers, iso);
const blockers = existsSync(join(dir, "BLOCKERS.md")) ? readFileSync(join(dir, "BLOCKERS.md"), "utf8") : "";
const ghl = existsSync(join(dir, "GHL-SETUP.md")) ? readFileSync(join(dir, "GHL-SETUP.md"), "utf8") : "";

check("counts: 1 to BLOCKERS.md, 1 to GHL-SETUP.md", counts["BLOCKERS.md"] === 1 && counts["GHL-SETUP.md"] === 1);
check("BLOCKERS.md carries its answer", blockers.includes("Use the sandbox PIT already in the Vault slot."));
check("BLOCKERS.md carries the IAP byline", blockers.includes("(marcus@digitalsolomon.com)"));
check("BLOCKERS.md uses the Human update header", blockers.includes(`> **Human update — ${iso}**`));
check("GHL answer routed to GHL-SETUP.md only",
  ghl.includes("Primary #C6972F.") && !blockers.includes("Primary #C6972F."));
check("multi-line answer is blockquoted (\\n -> \\n> )", ghl.includes("> Primary #C6972F.\n> Secondary #1B2130."));

// ── context assembly ─────────────────────────────────────────────────────────
const attachments = ["brand-guide.pdf", "logo.png"];
const ctx = buildOperatorContext(answers, attachments);
check("context names both answers", ctx.includes("Use the sandbox PIT already in the Vault slot.") && ctx.includes("Primary #C6972F"));
check("context lists both attachments", ctx.includes("brand-guide.pdf") && ctx.includes("logo.png"));
check("context is undefined when there is nothing", buildOperatorContext([], []) === undefined);

// ── the answer reaches an AGENT's context (the crux) ─────────────────────────
const planWith = { name: "demo", policy: { commitAfterEachTask: false }, tasks: [], operatorContext: ctx };
const planWithout = { name: "demo", policy: { commitAfterEachTask: false }, tasks: [] };
const scWith = sharedContext(planWith);
const scWithout = sharedContext(planWithout);
check("sharedContext threads the operator answer to the agent", scWith.includes("Use the sandbox PIT already in the Vault slot."));
check("sharedContext threads the attachment name to the agent", scWith.includes("brand-guide.pdf"));
check("sharedContext is a no-op when operatorContext is absent (CLI path)",
  !scWithout.includes("Operator write-back") && scWithout.length < scWith.length);

// ── report ───────────────────────────────────────────────────────────────────
console.log("\n=== BLOCKERS.md (materialised) ===\n" + blockers);
console.log("=== operator context threaded into every agent ===\n" + ctx + "\n");
console.log("=== checks ===");
let pass = 0;
for (const [name, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`); if (ok) pass++; }
console.log(`\n${pass}/${checks.length} checks passed`);
process.exit(pass === checks.length ? 0 : 1);
