import { createHash } from "node:crypto";
import { z } from "zod";
import type { ContextInquiry, ConversationContextSubject } from "./interface.js";
import type { DecisionAudience } from "../domain/decision-records.js";
import { decisionAudienceSchema } from "../domain/decision-record-schemas.js";
import type { LumaDatabase } from "../persistence/db.js";
import type {
  ObservedSourceLedger,
  ObservedSourceSnapshot
} from "../knowledge/observed-source-ledger.js";

/** An original source admission, independent of generated Ask answers and retrieved text. */
export type ProcessedConversationAdmission = {
  id: string;
  inquiryId: string;
  subject: ConversationContextSubject;
  audience: DecisionAudience;
  sourceRevision: number;
  contentHash: string;
  question: string;
};
const nonblank = z.string().min(1).max(512);
const schema = z
  .object({
    id: nonblank,
    inquiryId: nonblank,
    subject: z
      .object({
        type: z.literal("conversation-thread"),
        providerId: nonblank,
        conversationObjectId: nonblank,
        anchorMessageId: nonblank
      })
      .strict(),
    audience: decisionAudienceSchema,
    sourceRevision: z.number().int().positive(),
    contentHash: nonblank,
    question: z.string().min(1).max(8000)
  })
  .strict();
export type ProcessedConversationSourceEvent = {
  admissionId: string;
  workspaceId: string;
  subject: ConversationContextSubject;
  sourceRevision: number;
  contentHash: string;
};
export interface ProcessedConversationSources {
  read(input: {
    workspaceId: string;
    subject: ConversationContextSubject;
    audience: DecisionAudience;
    admissionId?: string;
  }): Promise<{
    admission: ProcessedConversationAdmission;
    original: ObservedSourceSnapshot<"conversation">;
  }>;
}
function digest(value: unknown): string {
  const canonical = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(canonical)
      : entry && typeof entry === "object"
        ? Object.fromEntries(
            Object.entries(entry)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, canonical(child)])
          )
        : entry;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
/** Called only after Context Intelligence admits its exact original ledger revision. */
export async function retainProcessedConversationAdmission(input: {
  database: LumaDatabase;
  inquiry: ContextInquiry;
  recorded: Pick<
    ObservedSourceSnapshot<"conversation">,
    "revision" | "contentHash" | "snapshot"
  >;
}): Promise<ProcessedConversationSourceEvent | null> {
  if (
    !input.inquiry.audience ||
    input.recorded.snapshot.completeness.state !== "complete"
  )
    return null;
  const original = {
    inquiryId: input.inquiry.inquiryId,
    subject: structuredClone(input.inquiry.subject),
    audience: {
      ...input.inquiry.audience,
      personIds: [...input.inquiry.audience.personIds].sort()
    },
    sourceRevision: input.recorded.revision,
    contentHash: input.recorded.contentHash,
    question: input.inquiry.question
  };
  const admission = schema.parse({ id: admissionId(original), ...original });
  await input.database.query(
    `INSERT INTO processed_conversation_admissions(workspace_id,admission_id,provider_id,conversation_id,anchor_id,source_revision,payload_json,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,admission_id) DO NOTHING`,
    [
      input.inquiry.workspaceId,
      admission.id,
      admission.subject.providerId,
      admission.subject.conversationObjectId,
      admission.subject.anchorMessageId,
      admission.sourceRevision,
      JSON.stringify(admission),
      digest(admission)
    ]
  );
  return {
    admissionId: admission.id,
    workspaceId: input.inquiry.workspaceId,
    subject: structuredClone(admission.subject),
    sourceRevision: admission.sourceRevision,
    contentHash: admission.contentHash
  };
}
function admissionId(value: Omit<ProcessedConversationAdmission, "id">): string {
  return digest({
    subject: value.subject,
    audience: value.audience,
    sourceRevision: value.sourceRevision,
    contentHash: value.contentHash
  });
}
export function createProcessedConversationSources(input: {
  database: LumaDatabase;
  ledger: ObservedSourceLedger;
}): ProcessedConversationSources {
  return {
    async read(request) {
      const rows = await input.database.query<{
        payload_json: string;
        payload_hash: string;
      }>(
        `SELECT payload_json,payload_hash FROM processed_conversation_admissions WHERE workspace_id=$1 AND provider_id=$2 AND conversation_id=$3 AND anchor_id=$4 ${request.admissionId ? "AND admission_id=$5" : ""} ORDER BY source_revision DESC,admission_id LIMIT 100`,
        [
          request.workspaceId,
          request.subject.providerId,
          request.subject.conversationObjectId,
          request.subject.anchorMessageId,
          ...(request.admissionId ? [request.admissionId] : [])
        ]
      );
      for (const row of rows.rows) {
        const parsed: unknown = JSON.parse(row.payload_json);
        if (digest(parsed) !== row.payload_hash)
          throw new Error("Processed Conversation admission integrity failed");
        const admission = schema.parse(parsed);
        const { id, ...originalBinding } = admission;
        if (
          id !== admissionId(originalBinding) ||
          admission.audience.workspaceId !== request.workspaceId ||
          request.audience.workspaceId !== request.workspaceId ||
          digest(admission.subject) !== digest(request.subject)
        )
          throw new Error("Processed Conversation admission binding changed");
        if (
          !request.audience.personIds.length ||
          new Set(request.audience.personIds).size !==
            request.audience.personIds.length ||
          request.audience.personIds.some(
            (person) => !admission.audience.personIds.includes(person)
          )
        )
          continue;
        const original = await input.ledger.get({
          workspaceId: request.workspaceId,
          source: {
            providerId: request.subject.providerId,
            sourceKind: "conversation",
            sourceObjectId: request.subject.anchorMessageId
          },
          revision: admission.sourceRevision
        });
        if (
          !original ||
          original.contentHash !== admission.contentHash ||
          original.source.parentObjectId !== request.subject.conversationObjectId ||
          original.snapshot.completeness.state !== "complete"
        )
          throw new Error("Processed Conversation original source is unavailable");
        return { admission, original };
      }
      throw new Error(
        "No complete processed Conversation admission proves this original audience"
      );
    }
  };
}
