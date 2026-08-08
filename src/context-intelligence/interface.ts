import type { Confidence, WorkspaceId } from "../domain/model.js";

/**
 * A bounded, provider-neutral conversation subject. The caller selects a
 * conversation and an explicit anchor; Context Intelligence owns capture,
 * persistence, evidence construction, and answer generation beneath this
 * one read-only operation.
 */
export type ConversationContextSubject = {
  type: "conversation-thread";
  providerId: string;
  conversationObjectId: string;
  anchorMessageId: string;
};

export type ContextInquiry = {
  type: "ask";
  workspaceId: WorkspaceId;
  /** Stable interaction/run identity. Repeating it replays the first answer. */
  inquiryId: string;
  question: string;
  subject: ConversationContextSubject;
};

export type ContextEvidence = {
  evidenceId: string;
  providerId: string;
  conversationObjectId: string;
  anchorMessageId: string;
  sourceRevision: number;
  messageId: string;
  ordinal: number;
  author: {
    providerUserId: string;
    displayName: string;
    /** The identity mapping known when Luma captured this immutable evidence. */
    personId: string | null;
  };
  createdAt: string;
  editedAt: string | null;
  replyToMessageId: string | null;
  url: string;
  state: "available" | "deleted";
  /** Original provider text. It is null only after explicit deletion evidence. */
  text: string | null;
};

export type ContextEvidenceClaim = {
  text: string;
  evidence: ContextEvidence[];
};

export type ContextInference = ContextEvidenceClaim & {
  confidence: Confidence;
};

export type ContextBoundary = {
  mode: "thread";
  anchorMessageId: string;
  firstMessageId: string;
  lastMessageId: string;
  messageIds: string[];
  sourceRevision: number;
  contentHash: string;
  completeness: "complete" | "partial";
};

export type ContextInquiryWarning = {
  code:
    | "conversation-boundary-incomplete"
    | "conversation-evidence-deleted"
    | "context-answer-unavailable";
  message: string;
};

export type ContextInquiryResult = {
  type: "answer";
  inquiryId: string;
  question: string;
  subject: ConversationContextSubject;
  boundary: ContextBoundary;
  answer: ContextEvidenceClaim;
  facts: ContextEvidenceClaim[];
  inferences: ContextInference[];
  unresolved: string[];
  evidence: ContextEvidence[];
  uncertainty: "none" | "partial" | "insufficient-evidence";
  warnings: ContextInquiryWarning[];
  modelMetadata?: {
    provider: string;
    model: string;
    promptVersion: string;
  };
};

export interface ContextIntelligence {
  inquire(input: ContextInquiry): Promise<ContextInquiryResult>;
}
