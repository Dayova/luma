import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  OrganizationalContextRequest,
  OrganizationalContextBundle
} from "../organizational-context/interface.js";
import type {
  ContextInquiry,
  ContextRetrieval,
  ContextInquiryWarning
} from "./interface.js";

const nonblank = z.string().trim().min(1);
const externalReference = z.object({
  providerId: nonblank,
  objectType: z.enum([
    "document",
    "work-item",
    "pull-request",
    "commit",
    "comment",
    "project",
    "other"
  ]),
  externalId: nonblank,
  url: z.string().url(),
  version: z.string().optional()
});
export const organizationalEvidenceSchema = z.object({
  evidenceId: nonblank,
  id: nonblank,
  kind: z.enum([
    "knowledge-document",
    "work-item",
    "code-change",
    "previous-meeting-item"
  ]),
  title: nonblank,
  content: z.string(),
  version: nonblank,
  updatedAt: nonblank,
  externalReference,
  standing: z.enum(["current", "proposed", "disputed", "superseded", "historical"]),
  authority: z.enum(["human-confirmed", "source", "ai-inference"]),
  effectiveAt: z.string().optional(),
  decisionKey: z.string().optional(),
  supersedes: z.array(z.string()).optional(),
  catalogId: nonblank,
  snapshotId: nonblank,
  excerptTruncated: z.boolean(),
  duplicates: z.array(
    z.object({ catalogId: nonblank, sourceId: nonblank, externalReference })
  )
});
const requestSchema = z.object({
  audience: z.object({ workspaceId: nonblank, personIds: z.array(nonblank).min(1) }),
  subject: z.object({ type: z.enum(["meeting", "conversation"]), id: nonblank }),
  purpose: z.enum(["understand-discussion", "answer-question", "prepare-conclusion"]),
  concepts: z.array(nonblank),
  time: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("current") }),
    z.object({ mode: z.literal("history"), asOf: z.string().optional() })
  ]),
  limit: z.number().int().positive(),
  maxCharacters: z.number().int().positive()
});
const retrievalSchema = z.object({
  request: requestSchema,
  receiptId: nonblank,
  evidence: z.array(organizationalEvidenceSchema),
  coverage: z.object({
    complete: z.boolean(),
    warnings: z.array(z.string()),
    considered: z.number().int().nonnegative(),
    selected: z.number().int().nonnegative(),
    characters: z.number().int().nonnegative()
  })
});

export function isContextRetrieval(value: unknown): value is ContextRetrieval {
  return retrievalSchema.safeParse(value).success;
}

export function contextRetrievalRequest(
  inquiry: ContextInquiry,
  limits?: { limit: number; maxCharacters: number }
): OrganizationalContextRequest {
  if (!inquiry.audience)
    throw new Error("Organizational retrieval requires actual response recipients");
  return {
    audience: {
      workspaceId: inquiry.workspaceId,
      personIds: [...inquiry.audience.personIds].sort()
    },
    subject: { type: "conversation", id: inquiry.subject.conversationObjectId },
    purpose: "answer-question",
    concepts: [inquiry.question],
    time: inquiry.contextTime ?? { mode: "current" },
    limit: limits?.limit ?? 8,
    maxCharacters: limits?.maxCharacters ?? 8_000
  };
}

export function contextRetrievalFor(
  request: OrganizationalContextRequest,
  bundle: OrganizationalContextBundle
): ContextRetrieval {
  return {
    request: structuredClone(request),
    receiptId: bundle.receiptId,
    evidence: bundle.sources.map((source) => ({
      ...structuredClone(source),
      evidenceId: `organizational:${createHash("sha256")
        .update(JSON.stringify([source.catalogId, source.id, source.snapshotId]))
        .digest("hex")}`
    })),
    coverage: structuredClone(bundle.retrieval)
  };
}

export function contextBindingHash(context: ContextRetrieval): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(context)).digest("hex")}`;
}

export function retrievalWarnings(context?: ContextRetrieval): ContextInquiryWarning[] {
  return context && !context.coverage.complete
    ? [
        {
          code: "organizational-context-partial",
          message: `Organizational context coverage is partial (${context.coverage.selected} selected sources). ${context.coverage.warnings.join(" ")}`
        }
      ]
    : [];
}
