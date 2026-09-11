import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MeetingSynthesisPublication } from "./meeting-synthesis-writer.js";

const START = "`luma-synthesis:start:v1`";
const END = "`luma-synthesis:end:v1`";
const SUMMARY = "<summary>Capture sources and synthesis provenance</summary>";
export function synthesisDigest(value: unknown): string {
  return createHash("sha256").update(canonicalSynthesisJson(value)).digest("hex");
}
export function canonicalSynthesisJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("Unsupported synthesis value");
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSynthesisJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalSynthesisJson(nested)}`)
    .join(",")}}`;
}
export function synthesisRecordKey(workspaceId: string, meetingId: string): string {
  return `luma-imported-meeting:${synthesisDigest([workspaceId, meetingId])}`;
}
export function renderMeetingSynthesisSection(
  publication: MeetingSynthesisPublication,
  signingKey: string
): string {
  const synthesis = publication.synthesis;
  const signature = createHmac("sha256", signingKey)
    .update(`meeting-synthesis-v1:${canonicalSynthesisJson(publication)}`)
    .digest("hex");
  const lines = [
    START,
    "## Luma Synthesis",
    `Revision: ${synthesis.revision} · Coverage: ${synthesis.coverage}`,
    "Derived understanding; source captures remain separate. Publication does not confirm a canonical decision or execute work."
  ];
  for (const claim of synthesis.claims) {
    lines.push(`### ${plain(claim.kind)} · ${plain(claim.authority)}`, plain(claim.text));
    if (claim.actionReview)
      lines.push(
        `Human action details: ${plain(claim.actionReview.modality)} · Owner: ${plain(claim.actionReview.ownerPersonId ?? "intentionally unassigned")} · Due: ${plain(claim.actionReview.dueDate ?? "explicitly none")} · Reviewed by: ${plain(claim.actionReview.participantId)}`
      );
    if (claim.conflictingClaimIds.length)
      lines.push(
        `Unresolved conflicting claims: ${claim.conflictingClaimIds.map(plain).join(", ")}`
      );
    for (const quote of claim.quotations) lines.push(`> ${plain(quote.text)}`);
    for (const citation of claim.citations)
      lines.push(
        `Source: ${safeUrl(citation.externalReference.url)} · revision ${citation.sourceRevision}`
      );
  }
  lines.push(
    "<details>",
    SUMMARY,
    "\t```json",
    `\t${JSON.stringify({ publication, signature }).replace(/`/gu, "\\u0060")}`,
    "\t```",
    "</details>",
    END
  );
  const markdown = lines.join("\n");
  if (Buffer.byteLength(markdown, "utf8") > 300_000)
    throw new Error("Synthesis publication exceeds the bounded size");
  return markdown;
}
export function parseMeetingSynthesisSection(
  markdown: string,
  signingKey: string
): { section: string; publication: MeetingSynthesisPublication } | null {
  if (Buffer.byteLength(markdown, "utf8") > 1_000_000)
    throw new Error("Synthesis page exceeds the read bound");
  const start = markdown.indexOf(START),
    end = markdown.indexOf(END);
  if (start === -1 && end === -1) return null;
  if (
    start < 0 ||
    end < start ||
    markdown.indexOf(START, start + 1) !== -1 ||
    markdown.indexOf(END, end + 1) !== -1
  )
    throw new Error("Synthesis region is incomplete or duplicated");
  const section = markdown.slice(start, end + END.length);
  const wire =
    /<summary>Capture sources and synthesis provenance<\/summary>\n(?:\n)*\t```json\n\t([^\n]+)\n\t```\s*<\/details>/u.exec(
      section
    )?.[1];
  if (!wire) throw new Error("Synthesis provenance is unavailable");
  const parsed = JSON.parse(wire) as {
    publication: MeetingSynthesisPublication;
    signature: string;
  };
  if (
    !parsed ||
    typeof parsed.signature !== "string" ||
    !/^[a-f0-9]{64}$/u.test(parsed.signature)
  )
    throw new Error("Synthesis provenance signature is invalid");
  const expected = createHmac("sha256", signingKey)
    .update(`meeting-synthesis-v1:${canonicalSynthesisJson(parsed.publication)}`)
    .digest();
  if (
    !timingSafeEqual(expected, Buffer.from(parsed.signature, "hex")) ||
    normalized(section) !==
      normalized(renderMeetingSynthesisSection(parsed.publication, signingKey))
  )
    throw new Error("Synthesis content was changed outside its approved operation");
  return { section, publication: parsed.publication };
}
function normalized(text: string): string {
  return text
    .split("\n")
    .filter((line) => line !== "")
    .join("\n");
}
function plain(text: string): string {
  return text
    .replace(/[\r\n]+/gu, " ")
    .replace(/[\\`*_[\]{}()#!|~$^<>]/gu, "\\$&")
    .replace(/^( {0,3})([-+])(?=\s)/u, "$1\\$2")
    .replace(/^( {0,3})(\d+)\.(?=\s)/u, "$1$2\\.");
}
function safeUrl(text: string): string {
  const url = new URL(text);
  if (url.protocol !== "https:" || url.username || url.password || /[\s<>`]/u.test(text))
    throw new Error("Synthesis source URL is invalid");
  return text;
}
