import type {
  DecisionRecordCatalog,
  DecisionRecordHistoricalRevision
} from "../knowledge/decision-record-catalog.js";
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
  /** Background candidates are discovery only; every returned source is still read live. */
  candidates?: {
    search(request: Parameters<ContextCatalog["search"]>[0]): Promise<{
      references: Array<{ reference: ExternalReference; revisionId?: string }>;
      complete: boolean;
      warnings: string[];
    }>;
  };
  readTimeoutMs?: number;
  signal?: AbortSignal;
}): ContextCatalog {
  if (!input.id.trim())
    throw new Error("A unique Decision context catalog ID is required");
  const { records } = input;
  const readTimeoutMs = input.readTimeoutMs ?? 4_500;
  if (
    !Number.isSafeInteger(readTimeoutMs) ||
    readTimeoutMs < 100 ||
    readTimeoutMs > 4_500
  )
    throw new Error("Decision context reads must fit the context deadline");
  return Object.freeze({
    id: input.id,
    async search(request) {
      if (input.candidates) {
        const found = await input.candidates.search(request);
        const ids = found.references.map((item) =>
          item.revisionId
            ? historicalSourceId(item.reference, item.revisionId)
            : sourceId(item.reference)
        );
        if (new Set(ids).size !== ids.length || ids.length > request.limit)
          throw new Error("Decision candidate discovery is ambiguous or unbounded");
        return { sourceIds: ids, complete: found.complete, warnings: found.warnings };
      }
      if (request.time?.mode === "history" && records.history) {
        const found = await records.history.discover({
          audience: request.audience,
          limit: request.limit,
          historyLimit: 1000
        });
        if (!found.current.complete)
          return {
            sourceIds: [],
            complete: false,
            warnings: ["Canonical Decision history could not be verified completely."]
          };
        let revisions = found.revisions
          .filter((item) => historicalAt(item.recordedAt, request.time))
          .sort((a, b) => b.ordinal - a.ordinal);
        if (request.time.asOf) {
          const pages = new Set<string>();
          revisions = revisions.filter((item) => {
            const id = sourceId(item.record.reference);
            if (pages.has(id)) return false;
            pages.add(id);
            return !found.revisions.some(
              (later) =>
                sourceId(later.record.reference) === id &&
                later.ordinal > item.ordinal &&
                later.recordedAt === null
            );
          });
        }
        revisions.sort(
          (a, b) =>
            Date.parse(b.recordedAt ?? "1970-01-01T00:00:00Z") -
              Date.parse(a.recordedAt ?? "1970-01-01T00:00:00Z") || b.ordinal - a.ordinal
        );
        const warnings = [];
        if (!found.complete || revisions.length > request.limit)
          warnings.push("Canonical Decision history exceeded its bounded revision scan.");
        if (found.revisions.some((item) => item.recordedAt === null))
          warnings.push(
            "Legacy Decision revisions lack recorded revision time; as-of ordering may be unavailable."
          );
        return {
          sourceIds: revisions
            .slice(0, request.limit)
            .map((item) => historicalSourceId(item.record.reference, item.revisionId)),
          complete: warnings.length === 0,
          warnings
        };
      }
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
    async read({ audience, sourceId: id, time }) {
      if (input.signal?.aborted) return null;
      const historical = historicalReference(id);
      if (historical && (time?.mode !== "history" || !records.history)) return null;
      if (!historical && time?.mode === "history" && records.history) return null;
      const reference = historical?.reference ?? sourceReference(id);
      if (!reference || reference.providerId !== records.providerId) return null;
      const controller = new AbortController();
      const abort = () => controller.abort();
      input.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, readTimeoutMs);
      const timeout = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () =>
            reject(
              new Error("Decision context read was cancelled or exceeded its bound")
            ),
          { once: true }
        );
      });
      const raw = await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted)
            throw new Error("Decision context read was cancelled");
          return historical
            ? records
                .history!.readReference({
                  audience,
                  reference,
                  revisionId: historical.revisionId,
                  ...(time?.mode === "history" && time.asOf ? { asOf: time.asOf } : {}),
                  signal: controller.signal
                })
                .then((revision) =>
                  revision?.revisionId === historical.revisionId
                    ? { record: revision.record, recordedAt: revision.recordedAt }
                    : null
                )
            : records
                .readReference({ audience, reference, signal: controller.signal })
                .then((record) => (record ? { record, recordedAt: null } : null));
        }),
        timeout
      ]).finally(() => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        controller.abort();
      });
      if (!raw) return null;
      const record = canonicalDecisionRecordSchema.parse(raw.record);
      if (
        (historical
          ? historicalSourceId(record.reference, historical.revisionId)
          : sourceId(record.reference)) !== id ||
        !hasRecordedHumanAcceptance(record) ||
        (historical && !historicalAt(raw.recordedAt, time))
      )
        return null;
      return project(record, id, historical ? { recordedAt: raw.recordedAt } : undefined);
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
    !authority.grantIds.length ||
    (authority.humanReviews ?? []).some(
      (review) =>
        JSON.stringify(review.subject) !== JSON.stringify(source.subject) ||
        review.sourceContentHash !== source.contentHash ||
        review.sourceAuthorizationHash !== source.authorizationHash ||
        review.audience.workspaceId !== source.audience.workspaceId ||
        !same(review.audience.personIds, source.audience.personIds)
    )
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
      [
        ...source.evidence,
        ...(authority.humanReviews ?? []).map((review) => review.evidence)
      ].some(
        (evidence) =>
          evidence.id === id &&
          evidence.origin === "human" &&
          evidence.purpose !== "capture-synthesis-review" &&
          evidence.authorPersonId === owner
      )
    )
  );
}
function project(
  record: CanonicalDecisionRecord,
  id: string,
  historical?: Pick<DecisionRecordHistoricalRevision, "recordedAt">
): ContextSource {
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
    `Effective at: ${candidate.effectiveAt ?? "not explicitly recorded"}.`,
    ...(historical
      ? [
          `Revision recorded at: ${historical.recordedAt ?? "unknown in this legacy signed archive; as-of timing is unavailable"}.`
        ]
      : []),
    ...(historical
      ? [
          "Historical signed revision: this is an archived state, not current organizational policy. Revision recording time describes knowledge history; effective time describes explicitly evidenced applicability."
        ]
      : []),
    ...(candidate.context ? [`Context: ${candidate.context.text}`] : []),
    ...candidate.rationale.map((claim) => `Rationale: ${claim.text}`),
    ...candidate.alternatives.map((claim) => `Alternative considered: ${claim.text}`),
    ...candidate.consequences.map((claim) => `Consequence: ${claim.text}`),
    ...candidate.objections.map((claim) => `Objection retained: ${claim.text}`),
    `Responsibility evidence: ${authority.snapshot.source.url}`,
    ...[
      ...new Set(
        [
          ...record.content.source.evidence,
          ...(authority.humanReviews ?? []).map((review) => review.evidence)
        ].flatMap((evidence) =>
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
    updatedAt: historical?.recordedAt ?? record.content.recordedAt,
    externalReference: record.reference,
    standing: historical
      ? "historical"
      : status === "active"
        ? "current"
        : status === "pending"
          ? "proposed"
          : "superseded",
    authority: "human-confirmed",
    decisionKey: record.content.id,
    ...(candidate.effectiveAt && !historical
      ? { effectiveAt: candidate.effectiveAt }
      : {}),
    supersedes: record.content.supersedes.map(sourceId)
  };
}

function historicalSourceId(reference: ExternalReference, revisionId: string): string {
  return `decision-history:${revisionId}:${sourceId(reference).slice(9)}`;
}
function historicalReference(
  id: string
): { reference: ExternalReference; revisionId: string } | null {
  const match = /^decision-history:([a-f0-9]{64}):(.+)$/u.exec(id);
  if (!match) return null;
  const reference = sourceReference(`decision:${match[2]!}`);
  return reference ? { reference, revisionId: match[1]! } : null;
}
function historicalAt(
  recordedAt: string | null,
  time: Parameters<ContextCatalog["search"]>[0]["time"]
): boolean {
  return (
    time?.mode !== "history" ||
    !time.asOf ||
    (recordedAt !== null && Date.parse(recordedAt) <= Date.parse(time.asOf))
  );
}
