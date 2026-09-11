import {
  retainProcessedConversationAdmission,
  type ProcessedConversationSourceEvent
} from "./processed-conversation-source.js";
import type { OrganizationalContext } from "../organizational-context/interface.js";
import { conversationPollSchema } from "../domain/conversation-poll.js";
import { retrievalConcepts } from "../organizational-context/retrieval-concepts.js";
import {
  contextRetrievalRequest,
  contextRetrievalFor,
  contextBindingHash,
  isContextRetrieval,
  organizationalEvidenceSchema,
  retrievalWarnings
} from "./retrieved-evidence.js";
import { AiServiceError } from "../ai/ai-service-error.js";
import { createHash } from "node:crypto";
import type { LumaDatabase } from "../persistence/db.js";
import type {
  ObservedSourceLedger,
  ObservedSourceSnapshot,
  RawConversationSnapshot
} from "../knowledge/observed-source-ledger.js";
import type { ContextAnswerer, ContextAnswerResult } from "./context-answerer.js";
import type {
  CapturedConversationEvidence,
  ConversationEvidenceSource
} from "./conversation-evidence-source.js";
import { requireCurrentConversationEvidence } from "./conversation-evidence-source.js";
import type {
  ContextRetrieval,
  OrganizationalContextEvidence,
  ContextBoundary,
  ContextEvidence,
  ContextEvidenceClaim,
  ContextInference,
  ContextInquiry,
  ContextInquiryResult,
  ContextInquiryWarning,
  ContextIntelligence,
  ConversationContextSubject
} from "./interface.js";

const CONTEXT_ASK_PROMPT_VERSION = "context-ask-v3";

export type CreateContextIntelligenceInput = {
  database: LumaDatabase;
  ledger: ObservedSourceLedger;
  conversationEvidenceSource: ConversationEvidenceSource;
  answerer: ContextAnswerer;
  /** Accepted original source notification; runtime may durably queue MI processing. It grants no recording permission. */
  onProcessedSource?(event: ProcessedConversationSourceEvent): Promise<void>;
  organizationalContext?: OrganizationalContext;
  organizationalContextLimits?: { limit: number; maxCharacters: number };
  now?: () => Date;
};

type ContextInquiryRow = {
  request_hash: string;
  source_provider_id: string;
  source_object_id: string;
  source_revision: number;
  source_content_hash: string;
  result_json: string;
  result_content_hash: string | null;
  context_request_json: string | null;
  context_receipt_id: string | null;
  context_binding_hash: string | null;
  result_is_deliverable: boolean;
};

type ConversationEvidenceRevision = Pick<
  ObservedSourceSnapshot<"conversation">,
  "source" | "revision" | "contentHash" | "snapshot"
>;

type PersistContextInquiryResult =
  | { status: "persisted"; result: ContextInquiryResult }
  | { status: "existing"; row: ContextInquiryRow };

export class ContextIntelligenceError extends Error {
  constructor(
    readonly code:
      | "context-inquiry-invalid"
      | "context-inquiry-id-conflict"
      | "context-inquiry-corrupt"
      | "context-inquiry-replay-unavailable"
      | "context-inquiry-source-changed"
      | "context-inquiry-context-changed"
      | "conversation-capture-invalid"
      | "conversation-capture-unavailable"
      | "context-answer-invalid"
      | "context-answer-already-attempted"
      | "context-answer-unavailable",
    readonly retryable: boolean,
    message: string
  ) {
    super(message);
    this.name = "ContextIntelligenceError";
  }
}

/**
 * One public read-only operation for bounded conversation questions. It owns
 * source capture, immutable persistence, citation validation, and durable
 * idempotent replay. Callers never orchestrate those stages themselves.
 */
export function createContextIntelligence(
  input: CreateContextIntelligenceInput
): ContextIntelligence {
  const now = input.now ?? (() => new Date());
  const locks = contextInquiryLocksFor(input.database);

  return {
    async inquire(inquiry) {
      validateInquiry(inquiry);
      requireRetrievalAudience(input, inquiry);
      const immutableInquiry = cloneContextInquiry(inquiry);
      const key = JSON.stringify([
        immutableInquiry.workspaceId,
        immutableInquiry.inquiryId
      ]);
      return withContextInquiryLock(locks, key, () =>
        inquire(input, immutableInquiry, now)
      );
    },
    async requireCurrent(inquiry) {
      validateInquiry(inquiry);
      requireRetrievalAudience(input, inquiry);
      const immutable = cloneContextInquiry(inquiry);
      const row = await readContextInquiry(input.database, immutable);
      if (!row)
        throw new ContextIntelligenceError(
          "context-inquiry-replay-unavailable",
          false,
          "No persisted answer exists for delivery"
        );
      const result = await existingContextInquiryResult({
        ledger: input.ledger,
        inquiry: immutable,
        row,
        requestHash: contextInquiryRequestHash(immutable)
      });
      if (
        input.organizationalContext &&
        result.modelMetadata &&
        !result.organizationalContext
      )
        throw contextChanged();
      await requireCurrentRetrieval(
        input.organizationalContext,
        result.organizationalContext
      );
      if (!row.result_is_deliverable) throw contextChanged();
      await requireCurrentResult(input.conversationEvidenceSource, immutable, result);
    }
  };
}

async function inquire(
  input: CreateContextIntelligenceInput,
  inquiry: ContextInquiry,
  now: () => Date
): Promise<ContextInquiryResult> {
  validateInquiry(inquiry);
  const immutableInquiry = cloneContextInquiry(inquiry);
  const requestHash = contextInquiryRequestHash(immutableInquiry);
  const existing = await readContextInquiry(input.database, immutableInquiry);

  if (existing) {
    const result = await existingContextInquiryResult({
      ledger: input.ledger,
      inquiry: immutableInquiry,
      row: existing,
      requestHash
    });
    if (
      input.organizationalContext &&
      result.modelMetadata &&
      !result.organizationalContext
    )
      throw contextChanged();
    await requireCurrentRetrieval(
      input.organizationalContext,
      result.organizationalContext
    );
    if (!existing.result_is_deliverable) throw contextChanged();
    await requireCurrentResult(
      input.conversationEvidenceSource,
      immutableInquiry,
      result
    );
    return result;
  }

  await rejectExistingAnswerAttempt(input.database, immutableInquiry, requestHash);
  const captured = await captureConversationEvidence(
    input.conversationEvidenceSource,
    immutableInquiry
  );
  validateCapturedConversation(immutableInquiry, captured);

  let recorded: ConversationEvidenceRevision;

  try {
    recorded = await input.ledger.record({
      workspaceId: immutableInquiry.workspaceId,
      ...cloneCapturedConversation(captured)
    });
  } catch (error: unknown) {
    if (error instanceof ContextIntelligenceError || error instanceof AiServiceError) {
      throw error;
    }

    throw new ContextIntelligenceError(
      "conversation-capture-unavailable",
      true,
      "Conversation evidence could not be durably recorded"
    );
  }
  const immutableRecorded = await immutableConversationRevision({
    ledger: input.ledger,
    inquiry: immutableInquiry,
    revision: recorded.revision,
    contentHash: recorded.contentHash,
    failureCode: "conversation-capture-invalid",
    failureMessage: "Captured conversation does not match its immutable ledger revision"
  });
  const processedSource = await retainProcessedConversationAdmission({
    database: input.database,
    inquiry: immutableInquiry,
    recorded: immutableRecorded
  });
  if (processedSource) await input.onProcessedSource?.(processedSource);
  let retrieval: ContextRetrieval | undefined;
  if (
    input.organizationalContext &&
    immutableRecorded.snapshot.completeness.state === "complete" &&
    immutableRecorded.snapshot.messages.some((message) => message.state === "available")
  ) {
    const request = contextRetrievalRequest(
      immutableInquiry,
      input.organizationalContextLimits
    );
    retrieval = contextRetrievalFor(
      request,
      await input.organizationalContext.retrieve(structuredClone(request))
    );
    await requireCurrentRetrieval(input.organizationalContext, retrieval);
    await requireCurrentResult(input.conversationEvidenceSource, immutableInquiry, {
      boundary: contextBoundaryFor(immutableRecorded.snapshot, immutableRecorded)
    });
  }
  const result = await answerInquiry(
    input.answerer,
    immutableInquiry,
    immutableRecorded,
    retrieval,
    (operation) =>
      withDurableAnswerAttempt(
        input.database,
        immutableInquiry,
        requestHash,
        now,
        operation
      )
  );
  result.warnings.push(...assistantOutputWarning(immutableRecorded.snapshot));

  let deliverable = true;
  try {
    await requireCurrentRetrieval(input.organizationalContext, retrieval);
  } catch {
    deliverable = false;
  }
  const persisted = await persistContextInquiry({
    database: input.database,
    inquiry: immutableInquiry,
    requestHash,
    recorded: immutableRecorded,
    result,
    createdAt: now().toISOString(),
    deliverable
  });

  const finalResult =
    persisted.status === "persisted"
      ? persisted.result
      : await existingContextInquiryResult({
          ledger: input.ledger,
          inquiry: immutableInquiry,
          row: persisted.row,
          requestHash
        });
  await requireCurrentRetrieval(
    input.organizationalContext,
    finalResult.organizationalContext
  );
  if (
    !deliverable ||
    (persisted.status === "existing" && !persisted.row.result_is_deliverable)
  )
    throw contextChanged();
  // Persist completed model work before checking freshness: a duplicate must
  // never make another paid request just because its source changed mid-answer.
  await requireCurrentResult(
    input.conversationEvidenceSource,
    immutableInquiry,
    finalResult
  );
  return finalResult;
}

async function requireCurrentResult(
  source: ConversationEvidenceSource,
  inquiry: ContextInquiry,
  result: Pick<ContextInquiryResult, "boundary">
): Promise<void> {
  try {
    await requireCurrentConversationEvidence(source, {
      workspaceId: inquiry.workspaceId,
      subject: { ...inquiry.subject },
      question: inquiry.question,
      contentHash: result.boundary.contentHash
    });
  } catch {
    throw new ContextIntelligenceError(
      "context-inquiry-source-changed",
      false,
      "The captured conversation changed or is unreadable. Post a new question to use its current state."
    );
  }
}

async function captureConversationEvidence(
  source: ConversationEvidenceSource,
  inquiry: ContextInquiry
): Promise<CapturedConversationEvidence> {
  try {
    return await source.capture({
      workspaceId: inquiry.workspaceId,
      subject: { ...inquiry.subject },
      question: inquiry.question
    });
  } catch (error: unknown) {
    if (error instanceof ContextIntelligenceError || error instanceof AiServiceError) {
      throw error;
    }

    throw new ContextIntelligenceError(
      "conversation-capture-unavailable",
      true,
      "Conversation evidence is temporarily unavailable"
    );
  }
}

function contextChanged(): ContextIntelligenceError {
  return new ContextIntelligenceError(
    "context-inquiry-context-changed",
    false,
    "Organizational context changed or is no longer readable by every recipient. Post a new question to use its current state."
  );
}

async function requireCurrentRetrieval(
  context: OrganizationalContext | undefined,
  retrieval: ContextRetrieval | undefined
): Promise<void> {
  if (!retrieval) return;
  if (!context) throw contextChanged();
  try {
    await context.requireCurrent(structuredClone(retrieval.request), retrieval.receiptId);
  } catch {
    throw contextChanged();
  }
}

function requireRetrievalAudience(
  input: CreateContextIntelligenceInput,
  inquiry: ContextInquiry
): void {
  const audience = inquiry.audience;
  if (
    (input.organizationalContext && (!audience || inquiry.question.length > 2_000)) ||
    (audience &&
      (audience.workspaceId !== inquiry.workspaceId ||
        !Array.isArray(audience.personIds) ||
        audience.personIds.length === 0 ||
        audience.personIds.some((id) => !isNonBlankString(id)) ||
        new Set(audience.personIds).size !== audience.personIds.length))
  ) {
    throw new ContextIntelligenceError(
      "context-inquiry-invalid",
      false,
      "Organizational retrieval requires a bounded question and the actual recipients in this workspace"
    );
  }
}

function cloneContextInquiry(inquiry: ContextInquiry): ContextInquiry {
  return {
    type: inquiry.type,
    workspaceId: inquiry.workspaceId,
    inquiryId: inquiry.inquiryId,
    question: inquiry.question,
    subject: { ...inquiry.subject },
    ...(inquiry.audience
      ? {
          audience: {
            workspaceId: inquiry.audience.workspaceId,
            personIds: [...inquiry.audience.personIds].sort()
          }
        }
      : {}),
    ...(inquiry.contextTime ? { contextTime: { ...inquiry.contextTime } } : {})
  };
}

function cloneCapturedConversation(
  captured: CapturedConversationEvidence
): Omit<CapturedConversationEvidence, "workspaceId"> {
  try {
    return {
      source: { ...captured.source },
      providerVersion: captured.providerVersion,
      snapshot: structuredClone(captured.snapshot),
      observedAt: captured.observedAt
    };
  } catch {
    throw new ContextIntelligenceError(
      "conversation-capture-invalid",
      false,
      "Conversation capture cannot be copied as immutable evidence"
    );
  }
}

async function answerInquiry(
  answerer: ContextAnswerer,
  inquiry: ContextInquiry,
  recorded: ConversationEvidenceRevision,
  retrieval: ContextRetrieval | undefined,
  attempt: (
    operation: () => Promise<ContextInquiryResult>
  ) => Promise<ContextInquiryResult>
): Promise<ContextInquiryResult> {
  const evidence = contextEvidenceFor(recorded);
  const boundary = contextBoundaryFor(recorded.snapshot, recorded);
  const answerableEvidence = evidence.filter(
    (candidate) => candidate.state === "available"
  );

  if (recorded.snapshot.completeness.state !== "complete") {
    return incompleteBoundaryResult(inquiry, boundary, evidence, recorded.snapshot);
  }

  if (answerableEvidence.length === 0) {
    return insufficientEvidenceResult(
      inquiry,
      boundary,
      evidence,
      "The captured thread has no currently available message text, so Luma cannot answer reliably."
    );
  }

  const promptVersion = CONTEXT_ASK_PROMPT_VERSION;
  return attempt(async () => {
    let answer: ContextAnswerResult;

    try {
      answer = await answerer.answer({
        workspaceId: inquiry.workspaceId,
        inquiryId: inquiry.inquiryId,
        question: inquiry.question,
        source: {
          providerId: inquiry.subject.providerId,
          conversationObjectId: inquiry.subject.conversationObjectId,
          anchorMessageId: inquiry.subject.anchorMessageId,
          snapshotRevision: recorded.revision,
          contentHash: recorded.contentHash,
          boundary: {
            mode: boundary.mode,
            firstMessageId: boundary.firstMessageId,
            lastMessageId: boundary.lastMessageId,
            messageIds: [...boundary.messageIds]
          }
        },
        evidence: answerableEvidence.map(copyContextEvidence),
        ...(retrieval
          ? {
              organizationalEvidence: structuredClone(retrieval.evidence),
              retrievalCoverage: structuredClone(retrieval.coverage)
            }
          : {}),
        promptVersion
      });
      validateContextAnswerResult(answer, promptVersion);
    } catch (error: unknown) {
      if (error instanceof ContextIntelligenceError || error instanceof AiServiceError) {
        throw error;
      }

      throw new ContextIntelligenceError(
        "context-answer-unavailable",
        false,
        "Context Answer did not produce a deliverable result. This inquiry will not repeat possible paid work."
      );
    }

    return contextInquiryResultFromAnswer(inquiry, boundary, evidence, answer, retrieval);
  });
}

async function withDurableAnswerAttempt(
  database: LumaDatabase,
  inquiry: ContextInquiry,
  requestHash: string,
  now: () => Date,
  operation: () => Promise<ContextInquiryResult>
): Promise<ContextInquiryResult> {
  const claimed = await database.query<{ inquiry_id: string }>(
    `INSERT INTO context_answer_attempts (workspace_id,inquiry_id,request_hash,started_at)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING inquiry_id`,
    [inquiry.workspaceId, inquiry.inquiryId, requestHash, now().toISOString()]
  );
  if (!claimed.rows[0]) {
    await rejectExistingAnswerAttempt(database, inquiry, requestHash);
    throw new ContextIntelligenceError(
      "context-answer-already-attempted",
      false,
      "This question already reached the answer attempt boundary. Luma will not repeat its possible paid work. Post a new question for a new attempt."
    );
  }
  try {
    return await operation();
  } catch (error) {
    // Only an explicit adapter proof that no provider call occurred permits reuse.
    // Unknown outcomes, invalid completed output and later persistence failures retain the fence.
    if (error instanceof AiServiceError && error.requestDispatched === false)
      await database.query(
        `DELETE FROM context_answer_attempts WHERE workspace_id=$1 AND inquiry_id=$2 AND request_hash=$3`,
        [inquiry.workspaceId, inquiry.inquiryId, requestHash]
      );
    throw error;
  }
}

async function rejectExistingAnswerAttempt(
  database: LumaDatabase,
  inquiry: ContextInquiry,
  requestHash: string
): Promise<void> {
  const rows = await database.query<{ request_hash: string }>(
    `SELECT request_hash FROM context_answer_attempts WHERE workspace_id=$1 AND inquiry_id=$2`,
    [inquiry.workspaceId, inquiry.inquiryId]
  );
  const row = rows.rows[0];
  if (!row) return;
  if (row.request_hash !== requestHash)
    throw new ContextIntelligenceError(
      "context-inquiry-id-conflict",
      false,
      "A Context inquiry ID may only be reused for the exact original request"
    );
  throw new ContextIntelligenceError(
    "context-answer-already-attempted",
    false,
    "This question already reached the answer attempt boundary. Luma will not repeat its possible paid work. Post a new question for a new attempt."
  );
}

async function persistContextInquiry(input: {
  database: LumaDatabase;
  inquiry: ContextInquiry;
  requestHash: string;
  recorded: ConversationEvidenceRevision;
  result: ContextInquiryResult;
  createdAt: string;
  deliverable: boolean;
}): Promise<PersistContextInquiryResult> {
  return input.database.transaction(async (transaction) => {
    const existing = await readContextInquiry(transaction, input.inquiry);

    if (existing) {
      return { status: "existing", row: existing };
    }

    const resultJson = JSON.stringify(input.result);
    const resultContentHash = contextInquiryResultHash(resultJson);
    const inserted = await transaction.query<{ inquiry_id: string }>(
      `INSERT INTO context_inquiries (
         workspace_id,
         inquiry_id,
         request_hash,
         source_provider_id,
         source_object_id,
         source_revision,
         source_content_hash,
         result_json,
         result_content_hash,
         created_at, context_request_json, context_receipt_id, context_binding_hash, result_is_deliverable
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (workspace_id, inquiry_id) DO NOTHING
       RETURNING inquiry_id`,
      [
        input.inquiry.workspaceId,
        input.inquiry.inquiryId,
        input.requestHash,
        input.recorded.source.providerId,
        input.recorded.source.sourceObjectId,
        input.recorded.revision,
        input.recorded.contentHash,
        resultJson,
        resultContentHash,
        input.createdAt,
        input.result.organizationalContext
          ? JSON.stringify(input.result.organizationalContext.request)
          : null,
        input.result.organizationalContext?.receiptId ?? null,
        input.result.organizationalContext
          ? contextBindingHash(input.result.organizationalContext)
          : null,
        input.deliverable
      ]
    );

    if (inserted.rows[0]) {
      return { status: "persisted", result: input.result };
    }

    const concurrent = await readContextInquiry(transaction, input.inquiry);

    if (!concurrent) {
      throw new Error(
        "Context inquiry insert did not persist or reveal a conflicting row"
      );
    }

    return { status: "existing", row: concurrent };
  });
}

async function readContextInquiry(
  database: Pick<LumaDatabase, "query">,
  inquiry: Pick<ContextInquiry, "workspaceId" | "inquiryId">
): Promise<ContextInquiryRow | null> {
  const result = await database.query<ContextInquiryRow>(
    `SELECT request_hash,
            source_provider_id,
            source_object_id,
            source_revision,
            source_content_hash,
            result_json,
            result_content_hash, context_request_json, context_receipt_id, context_binding_hash, result_is_deliverable
       FROM context_inquiries
      WHERE workspace_id = $1 AND inquiry_id = $2`,
    [inquiry.workspaceId, inquiry.inquiryId]
  );

  return result.rows[0] ?? null;
}

async function existingContextInquiryResult(input: {
  ledger: ObservedSourceLedger;
  inquiry: ContextInquiry;
  row: ContextInquiryRow;
  requestHash: string;
}): Promise<ContextInquiryResult> {
  if (input.row.request_hash !== input.requestHash) {
    throw new ContextIntelligenceError(
      "context-inquiry-id-conflict",
      false,
      "A Context inquiry ID may only be reused for the exact original request"
    );
  }

  if (
    input.row.result_content_hash === null ||
    input.row.result_content_hash !== contextInquiryResultHash(input.row.result_json)
  ) {
    throw new ContextIntelligenceError(
      "context-inquiry-corrupt",
      false,
      "Stored Context inquiry result does not match its recorded content hash"
    );
  }

  const stored = parseStoredContextInquiryResult(input.row.result_json);
  const recorded = await recordedContextInquirySource(input);
  const context = stored.organizationalContext;
  if (
    context
      ? input.row.context_request_json !== JSON.stringify(context.request) ||
        input.row.context_receipt_id !== context.receiptId ||
        input.row.context_binding_hash !== contextBindingHash(context) ||
        context.request.audience.workspaceId !== input.inquiry.workspaceId ||
        JSON.stringify(context.request.audience) !==
          JSON.stringify(input.inquiry.audience) ||
        context.request.subject.type !== "conversation" ||
        context.request.subject.id !== input.inquiry.subject.conversationObjectId ||
        context.request.purpose !== "answer-question" ||
        JSON.stringify(context.request.concepts) !==
          JSON.stringify(retrievalConcepts([input.inquiry.question])) ||
        JSON.stringify(context.request.time) !==
          JSON.stringify(input.inquiry.contextTime ?? { mode: "current" })
      : input.row.context_request_json !== null ||
        input.row.context_receipt_id !== null ||
        input.row.context_binding_hash !== null
  ) {
    throw new ContextIntelligenceError(
      "context-inquiry-corrupt",
      false,
      "Stored organizational context does not match its request and receipt binding"
    );
  }

  if (!storedContextInquiryMatches(input.inquiry, input.row, recorded, stored)) {
    throw new ContextIntelligenceError(
      "context-inquiry-corrupt",
      false,
      "Stored Context inquiry does not match its immutable conversation evidence"
    );
  }

  return stored;
}

async function recordedContextInquirySource(input: {
  ledger: ObservedSourceLedger;
  inquiry: ContextInquiry;
  row: ContextInquiryRow;
}): Promise<ConversationEvidenceRevision> {
  if (
    input.row.source_provider_id !== input.inquiry.subject.providerId ||
    input.row.source_object_id !== input.inquiry.subject.anchorMessageId
  ) {
    throw new ContextIntelligenceError(
      "context-inquiry-corrupt",
      false,
      "Stored Context inquiry names a different conversation source"
    );
  }

  return immutableConversationRevision({
    ledger: input.ledger,
    inquiry: input.inquiry,
    revision: input.row.source_revision,
    contentHash: input.row.source_content_hash,
    failureCode: "context-inquiry-corrupt",
    failureMessage:
      "Stored Context inquiry does not name its immutable conversation evidence"
  });
}

async function immutableConversationRevision(input: {
  ledger: ObservedSourceLedger;
  inquiry: ContextInquiry;
  revision: number;
  contentHash: string;
  failureCode: "conversation-capture-invalid" | "context-inquiry-corrupt";
  failureMessage: string;
}): Promise<ConversationEvidenceRevision> {
  let recorded: ObservedSourceSnapshot<"conversation"> | null;

  try {
    recorded = await input.ledger.get({
      workspaceId: input.inquiry.workspaceId,
      source: {
        providerId: input.inquiry.subject.providerId,
        sourceKind: "conversation",
        sourceObjectId: input.inquiry.subject.anchorMessageId
      },
      revision: input.revision
    });
  } catch {
    throw new ContextIntelligenceError(
      "context-inquiry-replay-unavailable",
      true,
      "Immutable conversation evidence is temporarily unavailable"
    );
  }

  if (
    !recorded ||
    recorded.contentHash !== input.contentHash ||
    recorded.source.parentObjectId !== input.inquiry.subject.conversationObjectId ||
    recorded.snapshot.conversation.conversationObjectId !==
      input.inquiry.subject.conversationObjectId ||
    recorded.snapshot.boundary.anchorMessageId !== input.inquiry.subject.anchorMessageId
  ) {
    throw new ContextIntelligenceError(input.failureCode, false, input.failureMessage);
  }

  return recorded;
}

function storedContextInquiryMatches(
  inquiry: ContextInquiry,
  row: ContextInquiryRow,
  recorded: ConversationEvidenceRevision,
  result: ContextInquiryResult
): boolean {
  const expectedBoundary = contextBoundaryFor(recorded.snapshot, recorded);
  const expectedEvidence = contextEvidenceFor(recorded);

  const evidenceMatches =
    result.inquiryId === inquiry.inquiryId &&
    result.question === inquiry.question &&
    sameConversationSubject(result.subject, inquiry.subject) &&
    row.source_provider_id === recorded.source.providerId &&
    row.source_object_id === recorded.source.sourceObjectId &&
    row.source_revision === recorded.revision &&
    row.source_content_hash === recorded.contentHash &&
    sameContextBoundary(result.boundary, expectedBoundary) &&
    result.evidence.length === expectedEvidence.length &&
    result.evidence.every((evidence, index) => {
      const expected = expectedEvidence[index];
      return expected !== undefined && sameContextEvidence(evidence, expected);
    });

  if (!evidenceMatches) {
    return false;
  }

  if (recorded.snapshot.completeness.state !== "complete") {
    return sameCanonicalNoAnswerResult(
      result,
      incompleteBoundaryResult(
        inquiry,
        expectedBoundary,
        expectedEvidence,
        recorded.snapshot
      ),
      assistantOutputWarning(recorded.snapshot)
    );
  }

  if (expectedEvidence.every((evidence) => evidence.state !== "available")) {
    return sameCanonicalNoAnswerResult(
      result,
      insufficientEvidenceResult(
        inquiry,
        expectedBoundary,
        expectedEvidence,
        "The captured thread has no currently available message text, so Luma cannot answer reliably."
      ),
      assistantOutputWarning(recorded.snapshot)
    );
  }

  return (
    result.uncertainty ===
      (result.inferences.length > 0 ||
      expectedEvidence.some((evidence) => evidence.state === "deleted") ||
      result.organizationalContext?.coverage.complete === false
        ? "partial"
        : "none") &&
    sameContextWarnings(result.warnings, [
      ...deletedEvidenceWarning(expectedEvidence),
      ...retrievalWarnings(result.organizationalContext),
      ...assistantOutputWarning(recorded.snapshot)
    ]) &&
    result.modelMetadata !== undefined
  );
}

function sameCanonicalNoAnswerResult(
  actual: ContextInquiryResult,
  expected: ContextInquiryResult,
  extraWarnings: ContextInquiryWarning[]
): boolean {
  return (
    actual.answer.text === expected.answer.text &&
    actual.answer.evidence.length === 0 &&
    (actual.answer.organizationalEvidence?.length ?? 0) === 0 &&
    actual.organizationalContext === undefined &&
    actual.facts.length === 0 &&
    actual.inferences.length === 0 &&
    sameStringArray(actual.unresolved, expected.unresolved) &&
    actual.uncertainty === expected.uncertainty &&
    sameContextWarnings(actual.warnings, [...expected.warnings, ...extraWarnings]) &&
    actual.modelMetadata === undefined
  );
}

function sameContextWarnings(
  left: ContextInquiryWarning[],
  right: ContextInquiryWarning[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (warning, index) =>
        warning.code === right[index]?.code && warning.message === right[index]?.message
    )
  );
}

function sameStringArray(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

function sameConversationSubject(
  left: ConversationContextSubject,
  right: ConversationContextSubject
): boolean {
  return (
    left.type === right.type &&
    left.providerId === right.providerId &&
    left.conversationObjectId === right.conversationObjectId &&
    left.anchorMessageId === right.anchorMessageId
  );
}

function sameContextBoundary(left: ContextBoundary, right: ContextBoundary): boolean {
  return (
    left.mode === right.mode &&
    left.anchorMessageId === right.anchorMessageId &&
    left.firstMessageId === right.firstMessageId &&
    left.lastMessageId === right.lastMessageId &&
    left.sourceRevision === right.sourceRevision &&
    left.contentHash === right.contentHash &&
    left.completeness === right.completeness &&
    left.messageIds.length === right.messageIds.length &&
    left.messageIds.every((messageId, index) => messageId === right.messageIds[index])
  );
}

function parseStoredContextInquiryResult(resultJson: string): ContextInquiryResult {
  try {
    const result: unknown = JSON.parse(resultJson);

    if (!isContextInquiryResult(result)) {
      throw new Error("stored result has an invalid shape");
    }

    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown parse failure";
    throw new ContextIntelligenceError(
      "context-inquiry-corrupt",
      false,
      `Stored Context inquiry cannot be read safely: ${message}`
    );
  }
}

function contextInquiryResultFromAnswer(
  inquiry: ContextInquiry,
  boundary: ContextBoundary,
  evidence: ContextEvidence[],
  answer: ContextAnswerResult,
  retrieval?: ContextRetrieval
): ContextInquiryResult {
  const byId = new Map(evidence.map((candidate) => [candidate.evidenceId, candidate]));
  const organizationalById = new Map(
    retrieval?.evidence.map((candidate) => [candidate.evidenceId, candidate]) ?? []
  );
  const result = {
    type: "answer" as const,
    inquiryId: inquiry.inquiryId,
    question: inquiry.question,
    subject: inquiry.subject,
    boundary,
    answer: contextEvidenceClaimFromAnswer(
      answer.answer,
      byId,
      "answer",
      organizationalById
    ),
    facts: answer.facts.map((fact) =>
      contextEvidenceClaimFromAnswer(fact, byId, "fact", organizationalById)
    ),
    inferences: answer.inferences.map((inference) => ({
      ...contextEvidenceClaimFromAnswer(inference, byId, "inference", organizationalById),
      confidence: inference.confidence
    })),
    unresolved: validateUnresolved(answer.unresolved),
    evidence,
    uncertainty:
      answer.inferences.length > 0 ||
      evidence.some((candidate) => candidate.state === "deleted") ||
      retrieval?.coverage.complete === false
        ? ("partial" as const)
        : ("none" as const),
    warnings: [...deletedEvidenceWarning(evidence), ...retrievalWarnings(retrieval)],
    ...(retrieval ? { organizationalContext: structuredClone(retrieval) } : {}),
    modelMetadata: { ...answer.metadata }
  } satisfies ContextInquiryResult;

  return result;
}

function validateContextAnswerResult(
  answer: ContextAnswerResult,
  promptVersion: string
): void {
  if (!isContextAnswerResult(answer) || answer.metadata.promptVersion !== promptVersion) {
    throw new ContextIntelligenceError(
      "context-answer-invalid",
      false,
      "Context Answerer returned an invalid answer shape"
    );
  }
}

function isContextAnswerResult(value: unknown): value is ContextAnswerResult {
  return (
    isRecord(value) &&
    isContextAnswerClaimInput(value["answer"]) &&
    isArrayOf(value["facts"], isContextAnswerClaimInput) &&
    isArrayOf(value["inferences"], isContextAnswerInferenceInput) &&
    isArrayOf(value["unresolved"], isNonBlankString) &&
    isModelMetadata(value["metadata"])
  );
}

function isContextAnswerClaimInput(
  value: unknown
): value is ContextAnswerResult["answer"] {
  return (
    isRecord(value) &&
    isNonBlankString(value["text"]) &&
    isArrayOf(value["evidenceIds"], isNonBlankString) &&
    value["evidenceIds"].length > 0
  );
}

function isContextAnswerInferenceInput(
  value: unknown
): value is ContextAnswerResult["inferences"][number] {
  return isContextAnswerClaimInput(value) && hasContextAnswerConfidence(value);
}

function hasContextAnswerConfidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value["confidence"] === "low" ||
      value["confidence"] === "medium" ||
      value["confidence"] === "high")
  );
}

function contextEvidenceClaimFromAnswer(
  claim: { text: string; evidenceIds: string[] },
  byId: ReadonlyMap<string, ContextEvidence>,
  kind: "answer" | "fact" | "inference",
  organizationalById: ReadonlyMap<string, OrganizationalContextEvidence>
): ContextEvidenceClaim {
  if (claim.text.trim().length === 0) {
    throw new ContextIntelligenceError(
      "context-answer-invalid",
      false,
      `Context ${kind} text must not be blank`
    );
  }

  if (claim.evidenceIds.length === 0) {
    throw new ContextIntelligenceError(
      "context-answer-invalid",
      false,
      `Context ${kind} must cite at least one captured evidence item`
    );
  }

  const organizationalEvidence: OrganizationalContextEvidence[] = [];
  const cited = claim.evidenceIds.flatMap((evidenceId) => {
    const contextEvidence = organizationalById.get(evidenceId);
    if (contextEvidence) {
      organizationalEvidence.push(contextEvidence);
      return [];
    }
    const evidence = byId.get(evidenceId);

    if (!evidence) {
      throw new ContextIntelligenceError(
        "context-answer-invalid",
        false,
        `Context ${kind} cited unknown evidence: ${evidenceId}`
      );
    }

    if (evidence.state !== "available") {
      throw new ContextIntelligenceError(
        "context-answer-invalid",
        false,
        `Context ${kind} cited deleted evidence: ${evidenceId}`
      );
    }

    return [evidence];
  });

  if (new Set(claim.evidenceIds).size !== claim.evidenceIds.length) {
    throw new ContextIntelligenceError(
      "context-answer-invalid",
      false,
      `Context ${kind} cited one evidence item more than once`
    );
  }

  return {
    text: claim.text,
    evidence: cited,
    ...(organizationalEvidence.length ? { organizationalEvidence } : {})
  };
}

function copyContextEvidence(evidence: ContextEvidence): ContextEvidence {
  return {
    ...evidence,
    author: { ...evidence.author }
  };
}

function validateUnresolved(unresolved: string[]): string[] {
  const invalid = unresolved.find((item) => item.trim().length === 0);

  if (invalid !== undefined) {
    throw new ContextIntelligenceError(
      "context-answer-invalid",
      false,
      "Context unresolved items must not be blank"
    );
  }

  return [...unresolved];
}

function incompleteBoundaryResult(
  inquiry: ContextInquiry,
  boundary: ContextBoundary,
  evidence: ContextEvidence[],
  snapshot: RawConversationSnapshot
): ContextInquiryResult {
  const reasons =
    snapshot.completeness.state === "partial"
      ? snapshot.completeness.reasons.map((reason) => reason.message)
      : [];
  const warning: ContextInquiryWarning = {
    code: "conversation-boundary-incomplete",
    message:
      reasons.length > 0
        ? `Luma did not answer because the thread boundary is incomplete: ${reasons.join("; ")}`
        : "Luma did not answer because the thread boundary is incomplete."
  };

  return {
    type: "answer",
    inquiryId: inquiry.inquiryId,
    question: inquiry.question,
    subject: inquiry.subject,
    boundary,
    answer: {
      text: "I cannot answer reliably from an incomplete thread boundary.",
      evidence: []
    },
    facts: [],
    inferences: [],
    unresolved: ["Capture a complete thread boundary before asking again."],
    evidence,
    uncertainty: "insufficient-evidence",
    warnings: [warning, ...deletedEvidenceWarning(evidence)]
  };
}

function insufficientEvidenceResult(
  inquiry: ContextInquiry,
  boundary: ContextBoundary,
  evidence: ContextEvidence[],
  message: string
): ContextInquiryResult {
  return {
    type: "answer",
    inquiryId: inquiry.inquiryId,
    question: inquiry.question,
    subject: inquiry.subject,
    boundary,
    answer: { text: message, evidence: [] },
    facts: [],
    inferences: [],
    unresolved: ["No original message text is currently available in this boundary."],
    evidence,
    uncertainty: "insufficient-evidence",
    warnings: [
      ...deletedEvidenceWarning(evidence),
      {
        code: "context-answer-unavailable",
        message: "The thread has no available original message text."
      }
    ]
  };
}

function assistantOutputWarning(
  snapshot: RawConversationSnapshot
): ContextInquiryWarning[] {
  const count = snapshot.excludedMessages?.length ?? 0;
  return count === 0
    ? []
    : [
        {
          code: "conversation-assistant-output-excluded",
          message: `${count} prior Luma text message(s) were excluded from Human Evidence.`
        }
      ];
}

function deletedEvidenceWarning(evidence: ContextEvidence[]): ContextInquiryWarning[] {
  const deletedCount = evidence.filter(
    (candidate) => candidate.state === "deleted"
  ).length;

  return deletedCount === 0
    ? []
    : [
        {
          code: "conversation-evidence-deleted",
          message:
            deletedCount === 1
              ? "One captured message was explicitly deleted and cannot support claims."
              : `${deletedCount} captured messages were explicitly deleted and cannot support claims.`
        }
      ];
}

function contextEvidenceFor(recorded: ConversationEvidenceRevision): ContextEvidence[] {
  const snapshot = recorded.snapshot;

  return snapshot.messages.map((message) => ({
    evidenceId: conversationEvidenceId(recorded, message.id),
    providerId: recorded.source.providerId,
    conversationObjectId: snapshot.conversation.conversationObjectId,
    anchorMessageId: snapshot.boundary.anchorMessageId,
    sourceRevision: recorded.revision,
    messageId: message.id,
    ordinal: message.ordinal,
    author: {
      providerUserId: message.author.providerUserId,
      displayName: message.author.displayName,
      personId: message.author.personId ?? null
    },
    createdAt: message.createdAt,
    editedAt: message.editedAt,
    replyToMessageId: message.replyToMessageId,
    url: message.url,
    state: message.state,
    text: message.text,
    ...(message.state === "available" && message.poll
      ? { poll: structuredClone(message.poll) }
      : {})
  }));
}

function conversationEvidenceId(
  recorded: ConversationEvidenceRevision,
  messageId: string
): string {
  return [
    "conversation",
    recorded.source.providerId,
    recorded.source.sourceObjectId,
    `revision-${recorded.revision}`,
    `message-${messageId}`
  ].join(":");
}

function contextBoundaryFor(
  snapshot: RawConversationSnapshot,
  recorded: ConversationEvidenceRevision
): ContextBoundary {
  return {
    mode: snapshot.boundary.mode,
    anchorMessageId: snapshot.boundary.anchorMessageId,
    firstMessageId: snapshot.boundary.firstMessageId,
    lastMessageId: snapshot.boundary.lastMessageId,
    messageIds: [...snapshot.boundary.messageIds],
    sourceRevision: recorded.revision,
    contentHash: recorded.contentHash,
    completeness: snapshot.completeness.state === "complete" ? "complete" : "partial"
  };
}

function validateInquiry(inquiry: ContextInquiry): void {
  if (
    !isRecord(inquiry) ||
    inquiry.type !== "ask" ||
    !isConversationSubject(inquiry.subject)
  ) {
    throw new ContextIntelligenceError(
      "context-inquiry-invalid",
      false,
      "Context Intelligence supports only valid conversation-thread ask inquiries"
    );
  }

  const values = [
    inquiry.workspaceId,
    inquiry.inquiryId,
    inquiry.question,
    inquiry.subject.providerId,
    inquiry.subject.conversationObjectId,
    inquiry.subject.anchorMessageId
  ];

  if (values.some((value) => !isNonBlankString(value))) {
    throw new ContextIntelligenceError(
      "context-inquiry-invalid",
      false,
      "Context inquiry fields must not be blank"
    );
  }
}

function validateCapturedConversation(
  inquiry: ContextInquiry,
  captured: Awaited<ReturnType<ConversationEvidenceSource["capture"]>>
): void {
  if (
    !isRecord(captured) ||
    !isRecord(captured.source) ||
    !isRecord(captured.snapshot) ||
    !isRecord(captured.snapshot.conversation) ||
    !isRecord(captured.snapshot.boundary)
  ) {
    throw new ContextIntelligenceError(
      "conversation-capture-invalid",
      false,
      "Conversation capture has an invalid shape"
    );
  }

  const source = captured.source;
  const snapshot = captured.snapshot;

  if (
    source.sourceKind !== "conversation" ||
    source.providerId !== inquiry.subject.providerId ||
    source.sourceObjectId !== inquiry.subject.anchorMessageId ||
    source.parentObjectId !== inquiry.subject.conversationObjectId ||
    snapshot.conversation.conversationObjectId !== inquiry.subject.conversationObjectId ||
    snapshot.boundary.mode !== "thread" ||
    snapshot.boundary.anchorMessageId !== inquiry.subject.anchorMessageId
  ) {
    throw new ContextIntelligenceError(
      "conversation-capture-invalid",
      false,
      "Conversation capture does not match the requested bounded thread"
    );
  }
}

function contextInquiryRequestHash(inquiry: ContextInquiry): string {
  const canonical = JSON.stringify({
    type: inquiry.type,
    question: inquiry.question,
    ...(inquiry.audience ? { audience: inquiry.audience } : {}),
    ...(inquiry.contextTime ? { contextTime: inquiry.contextTime } : {}),
    subject: {
      type: inquiry.subject.type,
      providerId: inquiry.subject.providerId,
      conversationObjectId: inquiry.subject.conversationObjectId,
      anchorMessageId: inquiry.subject.anchorMessageId
    }
  });

  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function contextInquiryResultHash(resultJson: string): string {
  return `sha256:${createHash("sha256").update(resultJson).digest("hex")}`;
}

const inquiryLocks = new WeakMap<LumaDatabase, Map<string, Promise<void>>>();

function contextInquiryLocksFor(database: LumaDatabase): Map<string, Promise<void>> {
  let locks = inquiryLocks.get(database);

  if (!locks) {
    locks = new Map();
    inquiryLocks.set(database, locks);
  }

  return locks;
}

async function withContextInquiryLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  locks.set(key, tail);
  await previous;

  try {
    return await operation();
  } finally {
    release();

    if (locks.get(key) === tail) {
      locks.delete(key);
    }
  }
}

function isContextInquiryResult(value: unknown): value is ContextInquiryResult {
  if (!isRecord(value) || value["type"] !== "answer") {
    return false;
  }

  const subject = value["subject"];
  const boundary = value["boundary"];
  const answer = value["answer"];
  const facts = value["facts"];
  const inferences = value["inferences"];
  const unresolved = value["unresolved"];
  const evidence = value["evidence"];
  const warnings = value["warnings"];
  const uncertainty = value["uncertainty"];
  const modelMetadata = value["modelMetadata"];

  if (
    !isNonBlankString(value["inquiryId"]) ||
    typeof value["question"] !== "string" ||
    !isConversationSubject(subject) ||
    !isContextBoundary(boundary) ||
    !isContextEvidenceClaim(answer) ||
    !isArrayOf(facts, isContextEvidenceClaim) ||
    !isArrayOf(inferences, isContextInference) ||
    !isArrayOf(unresolved, isNonBlankString) ||
    !isArrayOf(evidence, isContextEvidence) ||
    (uncertainty !== "none" &&
      uncertainty !== "partial" &&
      uncertainty !== "insufficient-evidence") ||
    !isArrayOf(warnings, isContextInquiryWarning) ||
    (modelMetadata !== undefined && !isModelMetadata(modelMetadata)) ||
    (value["organizationalContext"] !== undefined &&
      !isContextRetrieval(value["organizationalContext"]))
  ) {
    return false;
  }

  return storedContextEvidenceIsConsistent({
    subject,
    boundary,
    answer,
    facts,
    inferences,
    evidence,
    uncertainty,
    organizationalContext: value["organizationalContext"]
  });
}

function storedContextEvidenceIsConsistent(input: {
  subject: ConversationContextSubject;
  boundary: ContextBoundary;
  answer: ContextEvidenceClaim;
  facts: ContextEvidenceClaim[];
  inferences: ContextInference[];
  evidence: ContextEvidence[];
  uncertainty: "none" | "partial" | "insufficient-evidence";
  organizationalContext: ContextRetrieval | undefined;
}): boolean {
  if (
    input.evidence.length !== input.boundary.messageIds.length ||
    input.boundary.firstMessageId !== input.boundary.messageIds[0] ||
    input.boundary.lastMessageId !== input.boundary.messageIds.at(-1) ||
    !input.boundary.messageIds.includes(input.boundary.anchorMessageId)
  ) {
    return false;
  }

  const evidenceById = new Map<string, ContextEvidence>();

  for (const [index, evidence] of input.evidence.entries()) {
    if (
      evidence.ordinal !== index ||
      evidence.messageId !== input.boundary.messageIds[index] ||
      evidence.providerId !== input.subject.providerId ||
      evidence.conversationObjectId !== input.subject.conversationObjectId ||
      evidence.anchorMessageId !== input.subject.anchorMessageId ||
      evidence.sourceRevision !== input.boundary.sourceRevision ||
      evidenceById.has(evidence.evidenceId)
    ) {
      return false;
    }

    evidenceById.set(evidence.evidenceId, evidence);
  }

  const claims = [input.answer, ...input.facts, ...input.inferences];

  if (
    input.uncertainty !== "insufficient-evidence" &&
    input.answer.evidence.length + (input.answer.organizationalEvidence?.length ?? 0) ===
      0
  ) {
    return false;
  }

  return claims.every((claim, index) => {
    if (
      index > 0 &&
      claim.evidence.length + (claim.organizationalEvidence?.length ?? 0) === 0
    ) {
      return false;
    }

    const generic = claim.organizationalEvidence ?? [];
    if (
      new Set([...claim.evidence, ...generic].map((citation) => citation.evidenceId))
        .size !==
        claim.evidence.length + generic.length ||
      !generic.every((citation) =>
        input.organizationalContext?.evidence.some(
          (source) => JSON.stringify(source) === JSON.stringify(citation)
        )
      )
    )
      return false;
    return claim.evidence.every((citation) => {
      const stored = evidenceById.get(citation.evidenceId);
      return stored?.state === "available" && sameContextEvidence(stored, citation);
    });
  });
}

function sameContextEvidence(left: ContextEvidence, right: ContextEvidence): boolean {
  return (
    left.evidenceId === right.evidenceId &&
    left.providerId === right.providerId &&
    left.conversationObjectId === right.conversationObjectId &&
    left.anchorMessageId === right.anchorMessageId &&
    left.sourceRevision === right.sourceRevision &&
    left.messageId === right.messageId &&
    left.ordinal === right.ordinal &&
    left.author.providerUserId === right.author.providerUserId &&
    left.author.displayName === right.author.displayName &&
    left.author.personId === right.author.personId &&
    left.createdAt === right.createdAt &&
    left.editedAt === right.editedAt &&
    left.replyToMessageId === right.replyToMessageId &&
    left.url === right.url &&
    left.state === right.state &&
    left.text === right.text
  );
}

function isConversationSubject(value: unknown): value is ConversationContextSubject {
  return (
    isRecord(value) &&
    value["type"] === "conversation-thread" &&
    isNonBlankString(value["providerId"]) &&
    isNonBlankString(value["conversationObjectId"]) &&
    isNonBlankString(value["anchorMessageId"])
  );
}

function isContextBoundary(value: unknown): value is ContextBoundary {
  return (
    isRecord(value) &&
    value["mode"] === "thread" &&
    isNonBlankString(value["anchorMessageId"]) &&
    isNonBlankString(value["firstMessageId"]) &&
    isNonBlankString(value["lastMessageId"]) &&
    isArrayOf(value["messageIds"], isNonBlankString) &&
    typeof value["sourceRevision"] === "number" &&
    Number.isInteger(value["sourceRevision"]) &&
    value["sourceRevision"] > 0 &&
    isNonBlankString(value["contentHash"]) &&
    (value["completeness"] === "complete" || value["completeness"] === "partial")
  );
}

function isContextEvidenceClaim(value: unknown): value is ContextEvidenceClaim {
  return (
    isRecord(value) &&
    isNonBlankString(value["text"]) &&
    isArrayOf(value["evidence"], isContextEvidence) &&
    (value["organizationalEvidence"] === undefined ||
      isArrayOf(
        value["organizationalEvidence"],
        (candidate): candidate is OrganizationalContextEvidence =>
          organizationalEvidenceSchema.safeParse(candidate).success
      ))
  );
}

function isContextInference(value: unknown): value is ContextInference {
  if (!isRecord(value) || !isNonBlankString(value["text"])) {
    return false;
  }

  return isContextEvidenceClaim(value) && hasContextAnswerConfidence(value);
}

function isContextEvidence(value: unknown): value is ContextEvidence {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonBlankString(value["evidenceId"]) &&
    isNonBlankString(value["providerId"]) &&
    isNonBlankString(value["conversationObjectId"]) &&
    isNonBlankString(value["anchorMessageId"]) &&
    isPositiveInteger(value["sourceRevision"]) &&
    isNonBlankString(value["messageId"]) &&
    isNonNegativeInteger(value["ordinal"]) &&
    isConversationAuthor(value["author"]) &&
    isNonBlankString(value["createdAt"]) &&
    (value["editedAt"] === null || isNonBlankString(value["editedAt"])) &&
    (value["replyToMessageId"] === null || isNonBlankString(value["replyToMessageId"])) &&
    isNonBlankString(value["url"]) &&
    ((value["state"] === "available" &&
      typeof value["text"] === "string" &&
      (value["poll"] === undefined ||
        conversationPollSchema.safeParse(value["poll"]).success)) ||
      (value["state"] === "deleted" &&
        value["text"] === null &&
        value["poll"] === undefined))
  );
}

function isConversationAuthor(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonBlankString(value["providerUserId"]) &&
    isNonBlankString(value["displayName"]) &&
    (value["personId"] === null || isNonBlankString(value["personId"]))
  );
}

function isContextInquiryWarning(value: unknown): value is ContextInquiryWarning {
  return (
    isRecord(value) &&
    (value["code"] === "conversation-boundary-incomplete" ||
      value["code"] === "conversation-evidence-deleted" ||
      value["code"] === "conversation-assistant-output-excluded" ||
      value["code"] === "context-answer-unavailable" ||
      value["code"] === "organizational-context-partial") &&
    isNonBlankString(value["message"])
  );
}

function isModelMetadata(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonBlankString(value["provider"]) &&
    isNonBlankString(value["model"]) &&
    isNonBlankString(value["promptVersion"])
  );
}

function isArrayOf<T>(
  value: unknown,
  predicate: (item: unknown) => item is T
): value is T[] {
  return Array.isArray(value) && Array.from(value).every(predicate);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
