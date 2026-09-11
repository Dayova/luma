import type { Confidence, WorkspaceId } from "../domain/model.js";
import type { ConversationPoll } from "../domain/conversation-poll.js";
import type {
  ContextAudience,
  OrganizationalContextBundle,
  OrganizationalContextRequest,
  RetrievedContextSource
} from "../organizational-context/interface.js";

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
  /** Repeats reuse the first answer only while its exact source remains eligible. */
  inquiryId: string;
  question: string;
  subject: ConversationContextSubject;
  /** Actual readers of the response; required when organizational retrieval is configured. */
  audience?: ContextAudience;
  contextTime?: OrganizationalContextRequest["time"];
};

/** A genuine organizational source, never disguised as a Discord message. */
export type OrganizationalContextEvidence = RetrievedContextSource & {
  evidenceId: string;
};
export type ContextRetrieval = {
  request: OrganizationalContextRequest;
  receiptId: string;
  evidence: OrganizationalContextEvidence[];
  coverage: OrganizationalContextBundle["retrieval"];
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
  poll?: ConversationPoll;
};

export type ContextEvidenceClaim = {
  text: string;
  evidence: ContextEvidence[];
  organizationalEvidence?: OrganizationalContextEvidence[];
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
    | "conversation-assistant-output-excluded"
    | "organizational-context-partial"
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
  organizationalContext?: ContextRetrieval;
  modelMetadata?: {
    provider: string;
    model: string;
    promptVersion: string;
  };
};

export interface ContextIntelligence {
  inquire(input: ContextInquiry): Promise<ContextInquiryResult>;
  /** Revalidate a persisted answer at delivery without capture or paid reasoning. */
  requireCurrent?(input: ContextInquiry): Promise<void>;
}
