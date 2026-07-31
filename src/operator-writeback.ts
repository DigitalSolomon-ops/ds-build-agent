/**
 * Operator write-back materialisation — the cloud counterpart to the retired
 * local dashboard's "Provide to agents" panel.
 *
 * The cloud runner's `/workspace` is recreated empty on every execution, so an
 * answer written straight to a file there would evaporate. The durable state
 * lives elsewhere — answers on the humanTasks Firestore doc, attachments in
 * Cloud Storage — and THIS module materialises it into the fresh workspace at
 * the start of a run: it appends each answer to its BLOCKERS.md / GHL-SETUP.md
 * in the exact blockquote format the local endpoint used, and assembles the
 * operator-context string that cloud-job threads into every agent (so an answer
 * reaches agent context, not just a file).
 *
 * These functions are pure of any cloud dependency (files + strings only) so
 * the materialisation is verifiable without Firestore, Storage, or a paid run.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

/** One operator answer, read off a humanTasks doc. */
export interface OperatorAnswer {
  /** The blocker's title (shown to the agent for context). */
  title: string;
  /** Which handoff doc this blocker was routed to. */
  source: "BLOCKERS.md" | "GHL-SETUP.md";
  /** The operator's written answer. */
  answer: string;
  /** IAP identity that wrote it, if known. */
  answeredBy?: string;
}

/**
 * The timestamped, blockquoted "Human update" block — byte-for-byte the format
 * the local dashboard's POST /api/handoff-note appended, so the record reads
 * identically whether it was written locally or materialised in the cloud.
 */
export function humanUpdateBlock(note: string, iso: string): string {
  const quoted = note.replace(/\r\n/g, "\n").replace(/\n/g, "\n> ");
  return `\n> **Human update — ${iso}**\n>\n> ${quoted}\n`;
}

/**
 * Append each answer to its source doc under `repoPath`. Additive: appendFileSync
 * creates the file if the fresh workspace does not have it yet, and never
 * rewrites content an agent later adds. Returns how many landed in each doc.
 */
export function writeOperatorAnswers(
  repoPath: string,
  answers: OperatorAnswer[],
  iso: string,
): { "BLOCKERS.md": number; "GHL-SETUP.md": number } {
  const counts = { "BLOCKERS.md": 0, "GHL-SETUP.md": 0 };
  for (const a of answers) {
    if (!a.answer?.trim()) continue;
    const byline = a.answeredBy ? ` (${a.answeredBy})` : "";
    const note = `Re: ${a.title}${byline}\n\n${a.answer}`;
    appendFileSync(join(repoPath, a.source), humanUpdateBlock(note, iso));
    counts[a.source]++;
  }
  return counts;
}

/**
 * Assemble the operator context threaded into every agent's shared prompt.
 * Returns `undefined` when there is nothing to say — so BuildPlan.operatorContext
 * stays absent and sharedContext appends nothing, rather than an empty heading.
 */
export function buildOperatorContext(
  answers: OperatorAnswer[],
  attachmentNames: string[],
): string | undefined {
  const withAnswers = answers.filter((a) => a.answer?.trim());
  if (!withAnswers.length && !attachmentNames.length) return undefined;

  const lines: string[] = [
    `Operator write-back — the operator has already answered these open questions`,
    `and attached these documents. Treat them as authoritative; do not re-ask.`,
  ];
  if (withAnswers.length) {
    lines.push(``, `Answers to prior blockers:`);
    for (const a of withAnswers) {
      const answer = a.answer.trim().replace(/\s*\n\s*/g, " ");
      lines.push(`  - [${a.title}] ${answer}`);
    }
  }
  if (attachmentNames.length) {
    lines.push(``, `Documents provided (in ./inputs/ — read any that are relevant):`);
    for (const n of attachmentNames) lines.push(`  - ${n}`);
  }
  return lines.join("\n");
}
