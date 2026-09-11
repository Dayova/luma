import type { WorkspaceId } from "../domain/model.js";
import type {
  ObservedSourceIdentity,
  RawConversationSnapshot
} from "../knowledge/observed-source-ledger.js";
import type { ConversationContextSubject } from "./interface.js";
import { conversationSnapshotContentHash } from "../knowledge/observed-source-ledger.js";

export type CaptureConversationEvidenceInput = {
  workspaceId: WorkspaceId;
  subject: ConversationContextSubject;
  /** When supplied, the current anchor must still ask this exact question. */
  question?: string;
  purpose?: "consultation" | "decision-record";
};

export type ConversationEvidenceProof = {
  workspaceId: WorkspaceId;
  subject: ConversationContextSubject;
  question: string;
  contentHash: string;
  capturePurpose?: "consultation" | "decision-record";
};

export type CapturedConversationEvidence = {
  source: ObservedSourceIdentity<"conversation">;
  providerVersion: string | null;
  snapshot: RawConversationSnapshot;
  observedAt: string;
};

/**
 * Provider adapters capture a bounded conversation as original evidence. The
 * Context Intelligence module, not the caller, decides when to persist and
 * reason over that capture.
 */
export interface ConversationEvidenceSource {
  capture(input: CaptureConversationEvidenceInput): Promise<CapturedConversationEvidence>;
}

/** Read-only revalidation; it never mutates retained evidence or runs an Answerer. */
export async function requireCurrentConversationEvidence(
  source: ConversationEvidenceSource,
  proof: ConversationEvidenceProof
): Promise<void> {
  const current = await source.capture({
    workspaceId: proof.workspaceId,
    subject: { ...proof.subject },
    question: proof.question,
    ...(proof.capturePurpose ? { purpose: proof.capturePurpose } : {})
  });
  if (
    current.source.sourceKind !== "conversation" ||
    current.source.providerId !== proof.subject.providerId ||
    current.source.sourceObjectId !== proof.subject.anchorMessageId ||
    current.source.parentObjectId !== proof.subject.conversationObjectId ||
    current.snapshot.conversation.conversationObjectId !==
      proof.subject.conversationObjectId ||
    current.snapshot.boundary.anchorMessageId !== proof.subject.anchorMessageId ||
    conversationSnapshotContentHash(current.snapshot) !== proof.contentHash
  ) {
    throw new Error("The captured conversation changed or is no longer available");
  }
}
