import { z } from "zod";
import type { EvidenceReference, ExternalReference } from "./model.js";
import type {
  CanonicalDecisionRecord,
  DecisionAuthorityProof,
  DecisionAuthoritySnapshot,
  DecisionCandidate,
  DecisionInterpretation,
  DecisionRecordContent,
  DecisionSource,
  DecisionWriteStage
} from "./decision-records.js";

const id = z.string().min(1).max(512);
const prose = z.string().min(1).max(8_000);
const instant = z.string().datetime({ offset: true });
const ids = z.array(id).max(100);
const people = z.array(id).max(100);
export const decisionExternalReferenceSchema = z
  .object({
    providerId: id,
    objectType: z.enum([
      "document",
      "work-item",
      "pull-request",
      "commit",
      "comment",
      "project",
      "other"
    ]),
    externalId: id,
    url: z
      .string()
      .url()
      .max(2_000)
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      }),
    version: id.optional()
  })
  .strict()
  .transform((value): ExternalReference => ({
    providerId: value.providerId,
    objectType: value.objectType,
    externalId: value.externalId,
    url: value.url,
    ...(value.version !== undefined ? { version: value.version } : {})
  }));
export const decisionEvidenceReferenceSchema = z
  .object({
    evidenceId: id,
    source: z.enum([
      "transcript",
      "human-judgment",
      "knowledge",
      "work",
      "code",
      "previous-meeting",
      "external-activity"
    ]),
    sourceObjectId: id,
    participantId: id.optional(),
    sourceVersion: id.optional(),
    excerpt: z.string().max(32_000).optional(),
    startedAtMs: z.number().finite().nonnegative().optional(),
    endedAtMs: z.number().finite().nonnegative().optional(),
    externalReference: decisionExternalReferenceSchema.optional()
  })
  .strict()
  .refine(
    (value) =>
      value.startedAtMs === undefined ||
      value.endedAtMs === undefined ||
      value.startedAtMs <= value.endedAtMs
  )
  .transform((value): EvidenceReference => ({
    evidenceId: value.evidenceId,
    source: value.source,
    sourceObjectId: value.sourceObjectId,
    ...(value.participantId !== undefined ? { participantId: value.participantId } : {}),
    ...(value.sourceVersion !== undefined ? { sourceVersion: value.sourceVersion } : {}),
    ...(value.excerpt !== undefined ? { excerpt: value.excerpt } : {}),
    ...(value.startedAtMs !== undefined ? { startedAtMs: value.startedAtMs } : {}),
    ...(value.endedAtMs !== undefined ? { endedAtMs: value.endedAtMs } : {}),
    ...(value.externalReference !== undefined
      ? { externalReference: value.externalReference }
      : {})
  }));
export const decisionSubjectSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("conversation-thread"),
      providerId: id,
      conversationObjectId: id,
      anchorMessageId: id
    })
    .strict(),
  z.object({ type: z.literal("meeting"), meetingId: id }).strict()
]);
export const decisionAudienceSchema = z
  .object({ workspaceId: id, personIds: people.min(1) })
  .strict()
  .refine((value) => new Set(value.personIds).size === value.personIds.length);
export const decisionSourceSchema: z.ZodType<DecisionSource, z.ZodTypeDef, unknown> = z
  .object({
    subject: decisionSubjectSchema,
    revision: id,
    contentHash: id,
    authorizationHash: id,
    audience: decisionAudienceSchema,
    evidence: z
      .array(
        z
          .object({
            id,
            reference: decisionEvidenceReferenceSchema,
            text: z.string().max(32_000),
            authorPersonId: id.nullable(),
            origin: z.enum(["human", "provider-derived", "poll"])
          })
          .strict()
      )
      .min(1)
      .max(100),
    capturedAt: instant
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.evidence.map((item) => item.id)).size === value.evidence.length
  );
const claim = z.object({ text: prose, evidenceIds: ids.min(1) }).strict();
export const decisionCandidateSchema: z.ZodType<
  DecisionCandidate,
  z.ZodTypeDef,
  unknown
> = z
  .object({
    statement: claim,
    modality: z.enum([
      "final-decision",
      "accepted-proposal",
      "proposal",
      "preference",
      "open-question",
      "historical",
      "reversal",
      "unknown"
    ]),
    scopeId: id.nullable(),
    decisionMakerPersonIds: people,
    acceptanceEvidenceIds: ids,
    context: claim.nullable(),
    rationale: z.array(claim).max(30),
    alternatives: z.array(claim).max(30),
    consequences: z.array(claim).max(30),
    effectiveAt: z.union([instant, z.string().date()]).nullable(),
    disposition: z.enum(["adopt", "pause", "discard", "unknown"]),
    objections: z.array(claim).max(30),
    unresolved: z.array(prose).max(30),
    relatedWork: z.array(decisionExternalReferenceSchema).max(30),
    implementationEvidence: z.array(decisionExternalReferenceSchema).max(30)
  })
  .strict();
export const decisionAuthoritySnapshotSchema: z.ZodType<
  DecisionAuthoritySnapshot,
  z.ZodTypeDef,
  unknown
> = z
  .object({
    id,
    revision: id,
    source: decisionExternalReferenceSchema,
    contentHash: id,
    grants: z
      .array(
        z
          .object({
            id,
            personId: id,
            scopeId: id,
            kind: z.enum([
              "project-ownership",
              "delegation",
              "confirmed-scope",
              "provisional-role"
            ]),
            standing: z.enum(["current", "provisional", "superseded"]),
            evidence: z.array(decisionEvidenceReferenceSchema).min(1).max(30),
            delegatedBy: id.nullable(),
            consultedPersonIds: people
          })
          .strict()
      )
      .max(100)
  })
  .strict()
  .refine(
    (value) => new Set(value.grants.map((grant) => grant.id)).size === value.grants.length
  );
export const decisionAuthorityProofSchema: z.ZodType<
  DecisionAuthorityProof,
  z.ZodTypeDef,
  unknown
> = z
  .object({
    snapshot: decisionAuthoritySnapshotSchema,
    grantIds: ids,
    decisionMakerPersonIds: people,
    acceptanceEvidenceIds: ids
  })
  .strict();
export const decisionRecordContentSchema: z.ZodType<
  DecisionRecordContent,
  z.ZodTypeDef,
  unknown
> = z
  .object({
    id,
    candidate: decisionCandidateSchema,
    authority: decisionAuthorityProofSchema,
    source: decisionSourceSchema,
    status: z.enum(["pending", "active", "superseded", "reversed"]),
    recordedAt: instant,
    supersedes: z.array(decisionExternalReferenceSchema).max(30),
    supersededBy: decisionExternalReferenceSchema.nullable()
  })
  .strict();
export const canonicalDecisionRecordSchema: z.ZodType<
  CanonicalDecisionRecord,
  z.ZodTypeDef,
  unknown
> = z
  .object({
    content: decisionRecordContentSchema,
    reference: decisionExternalReferenceSchema,
    version: id
  })
  .strict();
export const decisionWriteStageSchema: z.ZodType<
  DecisionWriteStage,
  z.ZodTypeDef,
  unknown
> = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("create-record"), record: decisionRecordContentSchema })
    .strict(),
  z
    .object({
      type: z.literal("amend-record"),
      target: canonicalDecisionRecordSchema,
      record: decisionRecordContentSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("retire-record"),
      target: canonicalDecisionRecordSchema,
      status: z.enum(["superseded", "reversed"]),
      successor: decisionExternalReferenceSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("activate-record"),
      target: canonicalDecisionRecordSchema
    })
    .strict()
]);
export const decisionInterpretationSchema: z.ZodType<
  DecisionInterpretation,
  z.ZodTypeDef,
  unknown
> = z
  .object({
    candidate: decisionCandidateSchema.nullable(),
    reconciliation: z.discriminatedUnion("action", [
      z.object({ action: z.literal("create") }).strict(),
      z.object({ action: z.literal("link"), targetRecordId: id }).strict(),
      z.object({ action: z.literal("amend"), targetRecordId: id }).strict(),
      z.object({ action: z.literal("supersede"), targetRecordId: id }).strict(),
      z.object({ action: z.literal("reverse"), targetRecordId: id }).strict(),
      z.object({ action: z.literal("reject"), reason: prose }).strict(),
      z.object({ action: z.literal("clarify"), reason: prose }).strict()
    ])
  })
  .strict();
