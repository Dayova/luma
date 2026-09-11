import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DecisionRecordContent } from "../domain/decision-records.js";
import { decisionRecordContentSchema } from "../domain/decision-record-schemas.js";

const START = "`luma-decision-record:start:v1`";
const END = "`luma-decision-record:end:v1`";
const MAX_BYTES = 180_000;
const revisionSchema = z
  .object({
    operationId: z.string().min(1).max(512),
    stageDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    content: decisionRecordContentSchema
  })
  .strict();
const archiveSchema = z
  .object({
    format: z.literal(1),
    workspaceId: z.string().min(1).max(512),
    dataSourceId: z.string().uuid(),
    revisions: z.array(revisionSchema).min(1).max(100)
  })
  .strict();
export type DecisionRecordArchive = z.infer<typeof archiveSchema>;

/** Evidence/history is folded away; the current decision remains readable without it. */
export function renderNotionDecisionRecord(
  archive: DecisionRecordArchive,
  signingKey: string
): string {
  const validated = archiveSchema.parse(archive);
  const payload = canonicalDecisionJson(validated);
  const signature = createHmac("sha256", signingKey).update(payload).digest("hex");
  const current = validated.revisions.at(-1)!.content;
  const text = [
    START,
    ...renderCurrent(current),
    "",
    "<details>",
    "<summary>Evidence and revision history</summary>",
    "",
    "\t```json",
    // Literal backticks in evidence must not masquerade as our region markers.
    `\t${JSON.stringify({ archive: validated, signature }).replace(/`/gu, "\\u0060")}`,
    "\t```",
    "</details>",
    END
  ].join("\n");
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES)
    throw new Error(
      "Decision history exceeds the bounded record size; no history was removed."
    );
  return text;
}

export function parseNotionDecisionRecord(input: {
  markdown: string;
  signingKey: string;
  workspaceId: string;
  dataSourceId: string;
}): { section: string; archive: DecisionRecordArchive } {
  if (Buffer.byteLength(input.markdown, "utf8") > 500_000)
    throw new Error("Decision page exceeds the read bound");
  const start = input.markdown.indexOf(START);
  const end = input.markdown.indexOf(END);
  if (
    start < 0 ||
    end < start ||
    input.markdown.indexOf(START, start + 1) !== -1 ||
    input.markdown.indexOf(END, end + 1) !== -1
  )
    throw new Error("Decision page has no unique complete owned record");
  const section = input.markdown.slice(start, end + END.length);
  const wire =
    /<summary>Evidence and revision history<\/summary>\n(?:\n)*\t```json\n\t([^\n]+)\n\t```\s*<\/details>/u.exec(
      section
    )?.[1];
  if (!wire) throw new Error("Decision evidence/history is unavailable");
  const parsed = z
    .object({ archive: archiveSchema, signature: z.string().regex(/^[0-9a-f]{64}$/u) })
    .strict()
    .parse(JSON.parse(wire) as unknown);
  const expected = createHmac("sha256", input.signingKey)
    .update(canonicalDecisionJson(parsed.archive))
    .digest();
  if (
    !timingSafeEqual(Buffer.from(parsed.signature, "hex"), expected) ||
    parsed.archive.workspaceId !== input.workspaceId ||
    parsed.archive.dataSourceId !== input.dataSourceId
  )
    throw new Error("Decision record is not owned by this configured workspace");
  const recordIds = new Set(
    parsed.archive.revisions.map((revision) => revision.content.id)
  );
  const operationIds = new Set(
    parsed.archive.revisions.map((revision) => revision.operationId)
  );
  if (
    recordIds.size !== 1 ||
    operationIds.size !== parsed.archive.revisions.length ||
    normalizeEmptyLines(section) !==
      normalizeEmptyLines(renderNotionDecisionRecord(parsed.archive, input.signingKey))
  )
    throw new Error(
      "Decision record content or history was changed outside its approved operation"
    );
  return { section, archive: parsed.archive };
}

function renderCurrent(record: DecisionRecordContent): string[] {
  const candidate = record.candidate;
  const lines = [
    "",
    "## Decision",
    "",
    plain(candidate.statement.text),
    "",
    `Status: ${record.status}`,
    `Disposition: ${candidate.disposition}`,
    `Recorded: ${record.recordedAt}`
  ];
  if (candidate.effectiveAt) lines.push(`Effective: ${candidate.effectiveAt}`);
  if (candidate.context) lines.push("", "### Context", "", plain(candidate.context.text));
  for (const [heading, claims] of [
    ["Rationale", candidate.rationale],
    ["Alternatives", candidate.alternatives],
    ["Consequences", candidate.consequences],
    ["Objections", candidate.objections]
  ] as const) {
    if (claims.length)
      lines.push(
        "",
        `### ${heading}`,
        "",
        ...claims.map((claim) => `- ${plain(claim.text)}`)
      );
  }
  if (candidate.unresolved.length)
    lines.push(
      "",
      "### Unresolved",
      "",
      ...candidate.unresolved.map((text) => `- ${plain(text)}`)
    );
  const links = [
    ...record.source.evidence.flatMap((evidence) =>
      evidence.reference.externalReference ? [evidence.reference.externalReference] : []
    ),
    ...candidate.relatedWork,
    ...candidate.implementationEvidence
  ];
  if (links.length)
    lines.push(
      "",
      "### Sources and related context",
      "",
      ...[...new Set(links.map((link) => link.url))].map((url) => `- ${safeUrl(url)}`)
    );
  if (record.supersedes.length)
    lines.push(
      "",
      "Supersedes:",
      ...record.supersedes.map((ref) => `- ${safeUrl(ref.url)}`)
    );
  if (record.supersededBy)
    lines.push("", `Superseded by: ${safeUrl(record.supersededBy.url)}`);
  return lines;
}
function plain(text: string): string {
  return text
    .replace(/[\r\n]+/gu, " ")
    .replace(/[\\`*_[\]{}()#!|~$^<>]/gu, "\\$&")
    .replace(/^( {0,3})([-+])(?=\s)/u, "$1\\$2")
    .replace(/^( {0,3})(\d+)\.(?=\s)/u, "$1$2\\.");
}
/** Notion strips plain empty lines. Code payload is one nonempty literal JSON line. */
function normalizeEmptyLines(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => line !== "")
    .join("\n");
}
function safeUrl(text: string): string {
  const url = new URL(text);
  if (url.protocol !== "https:" || url.username || url.password || /[\s<>]/u.test(text))
    throw new Error("Decision source URL is not safe");
  return text;
}
export function decisionDigest(value: unknown): string {
  return createHash("sha256").update(canonicalDecisionJson(value)).digest("hex");
}
export function canonicalDecisionJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("Unsupported decision value");
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalDecisionJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalDecisionJson(nested)}`)
    .join(",")}}`;
}
