import type { DecisionRecordCatalog } from "../knowledge/decision-record-catalog.js";
import type { CanonicalDecisionRecord } from "../domain/decision-records.js";
import type { ExternalReference } from "../domain/model.js";
import {
  canonicalDecisionRecordSchema,
  decisionExternalReferenceSchema
} from "../domain/decision-record-schemas.js";
import type { ContextCatalog, ContextSource } from "./interface.js";

/** Canonical decisions enter retrieval through a read-only, source-governed capability. */
export function createDecisionContextCatalog(input: {
  id: string;
  records: DecisionRecordCatalog;
}): ContextCatalog {
  if (!input.id.trim())
    throw new Error("A unique Decision context catalog ID is required");
  const { records } = input;
  return Object.freeze({
    id: input.id,
    async search(request) {
      const result = await records.discover({
        audience: request.audience,
        limit: request.limit
      });
      if (!result.complete)
        return {
          sourceIds: [],
          complete: false,
          warnings: [
            "Canonical Decision Records could not be verified completely for these recipients."
          ]
        };
      const ids = result.records.map((record) => sourceId(record.reference));
      if (new Set(ids).size !== ids.length || ids.length > request.limit)
        throw new Error("Canonical Decision discovery is ambiguous or unbounded");
      return { sourceIds: ids.sort(), complete: true, warnings: [] };
    },
    async read({ audience, sourceId: id }) {
      const reference = sourceReference(id);
      if (!reference || reference.providerId !== records.providerId) return null;
      const raw = await records.readReference({ audience, reference });
      if (!raw) return null;
      const record = canonicalDecisionRecordSchema.parse(raw);
      if (sourceId(record.reference) !== id || !hasRecordedHumanAcceptance(record))
        return null;
      return project(record, id);
    }
  } satisfies ContextCatalog);
}

// Encode only stable provider identity and citation. A content revision changes the
// ContextSource version, preserving the source's persisted retrieval history.
function sourceId(reference: ExternalReference): string {
  const { providerId, objectType, externalId, url } =
    decisionExternalReferenceSchema.parse(reference);
  return `decision:${Buffer.from(JSON.stringify({ providerId, objectType, externalId, url })).toString("base64url")}`;
}
function sourceReference(id: string): ExternalReference | null {
  try {
    if (!id.startsWith("decision:") || id.length > 8_000) return null;
    const reference = decisionExternalReferenceSchema.parse(
      JSON.parse(Buffer.from(id.slice(9), "base64url").toString("utf8"))
    );
    return sourceId(reference) === id ? reference : null;
  } catch {
    return null;
  }
}
function hasRecordedHumanAcceptance({ content }: CanonicalDecisionRecord): boolean {
  const { candidate, authority, source } = content;
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length &&
    [...a].sort().every((value, index) => value === [...b].sort()[index]);
  if (
    !candidate.scopeId ||
    candidate.unresolved.length ||
    !["final-decision", "accepted-proposal", "reversal"].includes(candidate.modality) ||
    candidate.decisionMakerPersonIds.length !== 1 ||
    !candidate.acceptanceEvidenceIds.length ||
    !same(candidate.decisionMakerPersonIds, authority.decisionMakerPersonIds) ||
    !same(candidate.acceptanceEvidenceIds, authority.acceptanceEvidenceIds) ||
    !authority.grantIds.length
  )
    return false;
  const owner = candidate.decisionMakerPersonIds[0];
  return (
    authority.grantIds.every((id) =>
      authority.snapshot.grants.some(
        (grant) =>
          grant.id === id &&
          grant.personId === owner &&
          grant.scopeId === candidate.scopeId &&
          grant.standing === "current" &&
          grant.kind !== "provisional-role" &&
          grant.evidence.length > 0
      )
    ) &&
    candidate.acceptanceEvidenceIds.every((id) =>
      source.evidence.some(
        (evidence) =>
          evidence.id === id &&
          evidence.origin === "human" &&
          evidence.authorPersonId === owner
      )
    )
  );
}
function project(record: CanonicalDecisionRecord, id: string): ContextSource {
  const { candidate, authority, status } = record.content;
  const lines = [
    `Decision: ${candidate.statement.text}`,
    `Record state: ${status}. Disposition: ${candidate.disposition}.`,
    ...(status === "pending"
      ? [
          "Successor settlement is pending; this record is not active organizational policy."
        ]
      : []),
    `Accountable decision-maker: ${authority.decisionMakerPersonIds.join(", ")}.`,
    `Recorded at: ${record.content.recordedAt}.`,
    ...(candidate.context ? [`Context: ${candidate.context.text}`] : []),
    ...candidate.rationale.map((claim) => `Rationale: ${claim.text}`),
    ...candidate.alternatives.map((claim) => `Alternative considered: ${claim.text}`),
    ...candidate.consequences.map((claim) => `Consequence: ${claim.text}`),
    ...candidate.objections.map((claim) => `Objection retained: ${claim.text}`),
    `Responsibility evidence: ${authority.snapshot.source.url}`,
    ...[
      ...new Set(
        record.content.source.evidence.flatMap((evidence) =>
          evidence.reference.externalReference
            ? [evidence.reference.externalReference.url]
            : []
        )
      )
    ]
      .slice(0, 12)
      .map((url) => `Original source: ${url}`),
    ...candidate.relatedWork.map((reference) => `Related work: ${reference.url}`),
    ...candidate.implementationEvidence.map(
      (reference) => `Implementation evidence: ${reference.url}`
    ),
    ...(record.content.supersededBy
      ? [`Replaced by: ${record.content.supersededBy.url}`]
      : [])
  ];
  return {
    id,
    kind: "knowledge-document",
    title: candidate.statement.text.slice(0, 300),
    content: lines.join("\n"),
    version: record.version,
    updatedAt: record.content.recordedAt,
    externalReference: record.reference,
    standing:
      status === "active" ? "current" : status === "pending" ? "proposed" : "superseded",
    authority: "human-confirmed",
    decisionKey: record.content.id,
    ...(candidate.effectiveAt ? { effectiveAt: candidate.effectiveAt } : {}),
    supersedes: record.content.supersedes.map(sourceId)
  };
}
