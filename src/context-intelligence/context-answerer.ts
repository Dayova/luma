import type { Confidence, WorkspaceId } from "../domain/model.js";
import type { ContextEvidence } from "./interface.js";

export type ContextAnswerRequest = {
  workspaceId: WorkspaceId;
  inquiryId: string;
  question: string;
  source: {
    providerId: string;
    conversationObjectId: string;
    anchorMessageId: string;
    snapshotRevision: number;
    contentHash: string;
    boundary: {
      mode: "thread";
      firstMessageId: string;
      lastMessageId: string;
      messageIds: string[];
    };
  };
  evidence: ContextEvidence[];
  promptVersion: string;
};

export type ContextAnswerClaim = {
  text: string;
  evidenceIds: string[];
};

export type ContextAnswerInference = ContextAnswerClaim & {
  confidence: Confidence;
};

export type ContextAnswerResult = {
  answer: ContextAnswerClaim;
  facts: ContextAnswerClaim[];
  inferences: ContextAnswerInference[];
  unresolved: string[];
  metadata: {
    provider: string;
    model: string;
    promptVersion: string;
  };
};

/**
 * Owned read-only reasoning seam for conversation Ask. It intentionally has
 * no Meeting, provider-write, or Follow-up concepts.
 */
export interface ContextAnswerer {
  answer(input: ContextAnswerRequest): Promise<ContextAnswerResult>;
}
