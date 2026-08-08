import { createHash } from "node:crypto";
import type {
  ActionItemOwnershipAttribution,
  ExternalReference
} from "../domain/model.js";
import type {
  OperationalOutcome,
  OperationalOutcomeEntry
} from "./operational-outcome-writer.js";

export const OPERATIONAL_OUTCOME_HEADING = "## Luma — Operational Outcome";
const START_MARKER = "`luma-operational-outcome:start:v1`";
const END_MARKER = "`luma-operational-outcome:end:v1`";
const CONTENT_DIGEST_PREFIX = "`luma-operational-outcome:content:sha256:";
const OPERATION_DIGEST_PREFIX = "`luma-operational-outcome:operation:sha256:";
const PAYLOAD_DIGEST_PREFIX = "`luma-operational-outcome:payload:sha256:";

export type RenderedOperationalOutcome = {
  section: string;
  payloadDigest: string;
  contentDigest: string;
  operationDigest: string;
};

export type ParsedOperationalOutcomeSection =
  | { status: "none" }
  | {
      status: "valid";
      section: string;
      startIndex: number;
      endIndex: number;
      payloadDigest: string;
      contentDigest: string;
      operationDigest: string;
    }
  | { status: "invalid"; message: string };

/**
 * Renders Luma-owned content from structured facts. The section has three
 * independent checksums: content integrity for scan stripping, immutable
 * operation identity for recovery, and canonical payload integrity.
 */
export function renderOperationalOutcomeMarkdown(input: {
  outcome: OperationalOutcome;
  idempotencyKey: string;
}): RenderedOperationalOutcome {
  const outcome = normalizedOperationalOutcome(input.outcome);
  const payloadDigest = sha256(canonicalJson(outcome));
  const operationDigest = sha256(
    canonicalJson({
      formatVersion: outcome.formatVersion,
      scope: outcome.scope,
      operationToken: outcome.operationToken,
      entryPayloads: outcome.entries.map((entry) => ({
        settlementIntentId: entry.settlementIntentId,
        source: entry.source
      })),
      payloadDigest
    })
  );
  const body = renderOperationalOutcomeBody(outcome);
  const contentDigest = sha256(body);
  const section = [
    OPERATIONAL_OUTCOME_HEADING,
    "",
    START_MARKER,
    "",
    body,
    "",
    `${CONTENT_DIGEST_PREFIX}${contentDigest}\``,
    `${OPERATION_DIGEST_PREFIX}${operationDigest}\``,
    `${PAYLOAD_DIGEST_PREFIX}${payloadDigest}\``,
    END_MARKER
  ].join("\n");

  return { section, payloadDigest, contentDigest, operationDigest };
}

/**
 * Finds exactly one complete, checksum-valid Luma-owned section. Invalid or
 * duplicate markers are deliberately not interpreted as source content.
 */
export function parseOperationalOutcomeSection(
  markdown: string
): ParsedOperationalOutcomeSection {
  const headingIndexes = allIndexes(markdown, OPERATIONAL_OUTCOME_HEADING);
  const startIndexes = allIndexes(markdown, START_MARKER);
  const endIndexes = allIndexes(markdown, END_MARKER);

  if (
    headingIndexes.length === 0 &&
    startIndexes.length === 0 &&
    endIndexes.length === 0
  ) {
    return { status: "none" };
  }

  if (
    headingIndexes.length !== 1 ||
    startIndexes.length !== 1 ||
    endIndexes.length !== 1
  ) {
    return {
      status: "invalid",
      message: "Luma Operational Outcome markers are duplicate or incomplete"
    };
  }

  const headingIndex = headingIndexes[0];
  const startMarkerIndex = startIndexes[0];
  const endMarkerIndex = endIndexes[0];

  if (
    headingIndex === undefined ||
    startMarkerIndex === undefined ||
    endMarkerIndex === undefined ||
    headingIndex > startMarkerIndex ||
    startMarkerIndex > endMarkerIndex
  ) {
    return {
      status: "invalid",
      message: "Luma Operational Outcome markers are not in their expected order"
    };
  }

  const lineBeforeStart = markdown.slice(headingIndex, startMarkerIndex);

  if (lineBeforeStart !== `${OPERATIONAL_OUTCOME_HEADING}\n\n`) {
    return {
      status: "invalid",
      message: "Luma Operational Outcome heading does not own its marker block"
    };
  }

  const endIndex = endMarkerIndex + END_MARKER.length;
  const sectionStart =
    headingIndex >= 2 && markdown.slice(headingIndex - 2, headingIndex) === "\n\n"
      ? headingIndex - 2
      : headingIndex;
  const section = markdown.slice(sectionStart, endIndex);
  const canonicalSection = markdown.slice(headingIndex, endIndex);
  const markerLines = canonicalSection.split("\n");

  if (markerLines.at(-1) !== END_MARKER) {
    return {
      status: "invalid",
      message: "Luma Operational Outcome end marker is invalid"
    };
  }

  const contentLine = markerLines.at(-4);
  const operationLine = markerLines.at(-3);
  const payloadLine = markerLines.at(-2);

  if (!contentLine || !operationLine || !payloadLine) {
    return {
      status: "invalid",
      message: "Luma Operational Outcome checksum markers are missing"
    };
  }

  const contentDigest = digestFromLine(contentLine, CONTENT_DIGEST_PREFIX);
  const operationDigest = digestFromLine(operationLine, OPERATION_DIGEST_PREFIX);
  const payloadDigest = digestFromLine(payloadLine, PAYLOAD_DIGEST_PREFIX);

  if (!contentDigest || !operationDigest || !payloadDigest) {
    return {
      status: "invalid",
      message: "Luma Operational Outcome checksum markers are malformed"
    };
  }

  const body = markerLines.slice(4, -5).join("\n");

  if (sha256(body) !== contentDigest) {
    return {
      status: "invalid",
      message: "Luma Operational Outcome content checksum is invalid"
    };
  }

  return {
    status: "valid",
    section,
    startIndex: sectionStart,
    endIndex,
    payloadDigest,
    contentDigest,
    operationDigest
  };
}

/**
 * Source ingestion removes only a valid Luma-owned section. Every raw byte
 * outside the section stays intact, which keeps Luma's own writeback from
 * minting a new Meeting Notes source revision.
 */
export function stripOperationalOutcomeSection(markdown: string): {
  markdown: string;
  status: "none" | "stripped" | "invalid";
  message?: string;
} {
  const parsed = parseOperationalOutcomeSection(markdown);

  if (parsed.status === "none") {
    return { markdown, status: "none" };
  }

  if (parsed.status === "invalid") {
    return { markdown, status: "invalid", message: parsed.message };
  }

  return {
    markdown: `${markdown.slice(0, parsed.startIndex)}${markdown.slice(parsed.endIndex)}`,
    status: "stripped"
  };
}

function renderOperationalOutcomeBody(outcome: OperationalOutcome): string {
  return outcome.entries
    .flatMap((entry, index) => [
      ...(index === 0 ? [] : [""]),
      ...renderOperationalOutcomeEntry(entry)
    ])
    .join("\n");
}

function renderOperationalOutcomeEntry(entry: OperationalOutcomeEntry): string[] {
  const resolution = entry.resolution;
  const lines = [
    `### ${renderInlineCode(entry.settlementIntentId)}`,
    "",
    "#### Resolution",
    `- **${renderInlineText(resolution.type)}**: ${renderInlineText(resolution.rationale)}`,
    "",
    "#### Ownership",
    ...renderOwnership(entry.ownership),
    "",
    "#### Work"
  ];

  lines.push(...renderReferences(entry.workReferences));
  lines.push("", "#### Knowledge");
  lines.push(...renderReferences(entry.knowledgeReferences));
  lines.push("", "#### GitHub");
  lines.push(...renderReferences(entry.githubReferences));
  lines.push("", "#### Unresolved");
  lines.push(
    ...(entry.unresolved.length === 0
      ? ["- None"]
      : [...entry.unresolved]
          .sort(compareBytewise)
          .map((message) => `- ${renderInlineText(message)}`))
  );
  lines.push("", "#### Provenance");
  lines.push(`- Source root: ${renderInlineCode(entry.source.sourceObjectId)}`);
  lines.push(`- Source revision: ${entry.source.sourceRevision}`);
  lines.push(`- Settlement Intent: ${renderInlineCode(entry.settlementIntentId)}`);

  return lines;
}

function renderOwnership(ownership: ActionItemOwnershipAttribution): string[] {
  switch (ownership.status) {
    case "confirmed":
      return [
        `- Confirmed: ${renderInlineCode(ownership.ownerPersonId)} (${renderInlineText(ownership.basis)}, ${renderInlineText(ownership.confidence)})`
      ];
    case "proposed":
      return [
        `- Proposed: ${
          ownership.proposedOwnerPersonId
            ? renderInlineCode(ownership.proposedOwnerPersonId)
            : "no canonical Person"
        } (${renderInlineText(ownership.basis)}, ${renderInlineText(ownership.confidence)})`
      ];
    case "intentionally-unassigned":
      return [`- Intentionally unassigned (${renderInlineText(ownership.basis)})`];
    case "unresolved":
      return [
        `- Unresolved: ${renderInlineText(ownership.reason)}${
          ownership.likelyOwnerPersonId
            ? ` (${renderInlineCode(ownership.likelyOwnerPersonId)})`
            : ""
        }`
      ];
  }
}

function renderReferences(references: ExternalReference[]): string[] {
  const sorted = [...references].sort(referenceOrder);

  return sorted.length === 0
    ? ["- None"]
    : sorted.map((reference) => {
        const url = safeUrl(reference.url);
        const label = renderInlineCode(`${reference.providerId}:${reference.externalId}`);

        return url ? `- ${label} — <${url}>` : `- ${label} — URL unavailable`;
      });
}

function referenceOrder(left: ExternalReference, right: ExternalReference): number {
  return compareBytewise(
    [left.providerId, left.objectType, left.externalId, left.url].join("\u0000"),
    [right.providerId, right.objectType, right.externalId, right.url].join("\u0000")
  );
}

function digestFromLine(line: string, prefix: string): string | null {
  if (!line.startsWith(prefix) || !line.endsWith("`")) {
    return null;
  }

  const digest = line.slice(prefix.length, -1);
  return /^[a-f0-9]{64}$/.test(digest) ? digest : null;
}

function allIndexes(value: string, needle: string): number[] {
  const indexes: number[] = [];
  let index = value.indexOf(needle);

  while (index >= 0) {
    indexes.push(index);
    index = value.indexOf(needle, index + needle.length);
  }

  return indexes;
}

/**
 * Writes arbitrary source data in a single Markdown inline context. HTML
 * entities keep literal angle brackets and backticks out of the serialized
 * Markdown, so source data cannot mint parser markers or HTML/code spans.
 */
function renderInlineText(value: string): string {
  return normalizedInlineText(value)
    .replace(/[\\*_{}[\]()#+.!|~/:@?-]/g, "\\$&")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("`", "&#96;");
}

/**
 * Keeps ordinary identifiers compact while falling back to escaped inline
 * text for backticks or a protected section heading. Backslash escaping is
 * not meaningful inside a Markdown code span, and source text must not
 * duplicate a parser-owned marker before Markdown is even rendered.
 */
function renderInlineCode(value: string): string {
  const normalized = normalizedInlineText(value);

  return normalized.includes("`") || normalized.includes(OPERATIONAL_OUTCOME_HEADING)
    ? renderInlineText(normalized)
    : `\`${normalized}\``;
}

function normalizedInlineText(value: string): string {
  return value.replace(/[\p{Cc}\u2028\u2029]+/gu, " ");
}

function safeUrl(value: string): string | null {
  try {
    const parsed = new URL(value);

    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }

    const serialized = parsed.toString().replaceAll("`", "%60");
    return /[\p{Cc}\s<>\\\\]/u.test(serialized) ? null : serialized;
  } catch {
    return null;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => compareBytewise(left, right)
    );
    return `{${entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }

  throw new Error("Operational Outcome contains an unsupported canonical value");
}

function normalizedOperationalOutcome(outcome: OperationalOutcome): OperationalOutcome {
  const entries = [...outcome.entries]
    .map((entry) => ({
      ...entry,
      workReferences: [...entry.workReferences].sort(referenceOrder),
      knowledgeReferences: [...entry.knowledgeReferences].sort(referenceOrder),
      githubReferences: [...entry.githubReferences].sort(referenceOrder),
      unresolved: [...entry.unresolved].sort(compareBytewise)
    }))
    .sort((left, right) =>
      compareBytewise(left.settlementIntentId, right.settlementIntentId)
    );

  if (entries.length === 0) {
    throw new Error("Operational Outcome must contain at least one settlement entry");
  }

  if (
    entries.some(
      (entry, index) =>
        index > 0 && entry.settlementIntentId === entries[index - 1]?.settlementIntentId
    )
  ) {
    throw new Error("Operational Outcome cannot contain duplicate settlement entries");
  }

  if (outcome.operationToken.trim().length === 0) {
    throw new Error("Operational Outcome operation token must be non-empty");
  }

  return {
    formatVersion: 1,
    operationToken: outcome.operationToken,
    scope: { ...outcome.scope },
    entries
  };
}

function compareBytewise(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
