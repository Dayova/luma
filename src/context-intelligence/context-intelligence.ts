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
import type {
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

const CONTEXT_ASK_PROMPT_VERSION = "context-ask-v1";

export type CreateContextIntelligenceInput = {
  database: LumaDatabase;
  ledger: ObservedSourceLedger;
  conversationEvidenceSource: ConversationEvidenceSource;
  answerer: ContextAnswerer;
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
      | "conversation-capture-invalid"
      | "conversation-capture-unavailable"
      | "context-answer-invalid"
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
      const immutableInquiry = cloneContextInquiry(inquiry);
      const key = JSON.stringify([
        immutableInquiry.workspaceId,
        immutableInquiry.inquiryId
      ]);
      return withContextInquiryLock(locks, key, () =>
        inquire(input, immutableInquiry, now)
      );
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
    return existingContextInquiryResult({
      ledger: input.ledger,
      inquiry: immutableInquiry,
      row: existing,
      requestHash
    });
  }

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
    if (error instanceof ContextIntelligenceError) {
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
  const result = await answerInquiry(input.answerer, immutableInquiry, immutableRecorded);

  const persisted = await persistContextInquiry({
    database: input.database,
    inquiry: immutableInquiry,
    requestHash,
    recorded: immutableRecorded,
    result,
    createdAt: now().toISOString()
  });

  return persisted.status === "persisted"
    ? persisted.result
    : existingContextInquiryResult({
        ledger: input.ledger,
        inquiry: immutableInquiry,
        row: persisted.row,
        requestHash
      });
}

async function captureConversationEvidence(
  source: ConversationEvidenceSource,
  inquiry: ContextInquiry
): Promise<CapturedConversationEvidence> {
  try {
    return await source.capture({
      workspaceId: inquiry.workspaceId,
      subject: { ...inquiry.subject }
    });
  } catch (error: unknown) {
    if (error instanceof ContextIntelligenceError) {
      throw error;
    }

    throw new ContextIntelligenceError(
      "conversation-capture-unavailable",
      true,
      "Conversation evidence is temporarily unavailable"
    );
  }
}

function cloneContextInquiry(inquiry: ContextInquiry): ContextInquiry {
  return {
    type: inquiry.type,
    workspaceId: inquiry.workspaceId,
    inquiryId: inquiry.inquiryId,
    question: inquiry.question,
    subject: { ...inquiry.subject }
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
  recorded: ConversationEvidenceRevision
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
      promptVersion: CONTEXT_ASK_PROMPT_VERSION
    });
    validateContextAnswerResult(answer, CONTEXT_ASK_PROMPT_VERSION);
  } catch (error: unknown) {
    if (error instanceof ContextIntelligenceError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "unknown answerer failure";
    throw new ContextIntelligenceError(
      "context-answer-unavailable",
      true,
      `Context Answer is temporarily unavailable: ${message}`
    );
  }

  return contextInquiryResultFromAnswer(inquiry, boundary, evidence, answer);
}

async function persistContextInquiry(input: {
  database: LumaDatabase;
  inquiry: ContextInquiry;
  requestHash: string;
  recorded: ConversationEvidenceRevision;
  result: ContextInquiryResult;
  createdAt: string;
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
         created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
        input.createdAt
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
            result_content_hash
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
      )
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
      )
    );
  }

  return (
    result.uncertainty ===
      (result.inferences.length > 0 ||
      expectedEvidence.some((evidence) => evidence.state === "deleted")
        ? "partial"
        : "none") &&
    sameContextWarnings(result.warnings, deletedEvidenceWarning(expectedEvidence)) &&
    result.modelMetadata !== undefined
  );
}

function sameCanonicalNoAnswerResult(
  actual: ContextInquiryResult,
  expected: ContextInquiryResult
): boolean {
  return (
    actual.answer.text === expected.answer.text &&
    actual.answer.evidence.length === 0 &&
    actual.facts.length === 0 &&
    actual.inferences.length === 0 &&
    sameStringArray(actual.unresolved, expected.unresolved) &&
    actual.uncertainty === expected.uncertainty &&
    sameContextWarnings(actual.warnings, expected.warnings) &&
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
  answer: ContextAnswerResult
): ContextInquiryResult {
  const byId = new Map(evidence.map((candidate) => [candidate.evidenceId, candidate]));
  const result = {
    type: "answer" as const,
    inquiryId: inquiry.inquiryId,
    question: inquiry.question,
    subject: inquiry.subject,
    boundary,
    answer: contextEvidenceClaimFromAnswer(answer.answer, byId, "answer"),
    facts: answer.facts.map((fact) => contextEvidenceClaimFromAnswer(fact, byId, "fact")),
    inferences: answer.inferences.map((inference) => ({
      ...contextEvidenceClaimFromAnswer(inference, byId, "inference"),
      confidence: inference.confidence
    })),
    unresolved: validateUnresolved(answer.unresolved),
    evidence,
    uncertainty:
      answer.inferences.length > 0 ||
      evidence.some((candidate) => candidate.state === "deleted")
        ? ("partial" as const)
        : ("none" as const),
    warnings: deletedEvidenceWarning(evidence),
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
  kind: "answer" | "fact" | "inference"
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

  const cited = claim.evidenceIds.map((evidenceId) => {
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

    return evidence;
  });

  if (new Set(claim.evidenceIds).size !== claim.evidenceIds.length) {
    throw new ContextIntelligenceError(
      "context-answer-invalid",
      false,
      `Context ${kind} cited one evidence item more than once`
    );
  }

  return { text: claim.text, evidence: cited };
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
    text: message.text
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
    (modelMetadata !== undefined && !isModelMetadata(modelMetadata))
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
    uncertainty
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
    input.answer.evidence.length === 0
  ) {
    return false;
  }

  return claims.every((claim, index) => {
    if (index > 0 && claim.evidence.length === 0) {
      return false;
    }

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
    isArrayOf(value["evidence"], isContextEvidence)
  );
}

function isContextInference(value: unknown): value is ContextInference {
  if (!isRecord(value) || !isNonBlankString(value["text"])) {
    return false;
  }

  return (
    isArrayOf(value["evidence"], isContextEvidence) &&
    (value["confidence"] === "low" ||
      value["confidence"] === "medium" ||
      value["confidence"] === "high")
  );
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
    ((value["state"] === "available" && typeof value["text"] === "string") ||
      (value["state"] === "deleted" && value["text"] === null))
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
      value["code"] === "context-answer-unavailable") &&
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
