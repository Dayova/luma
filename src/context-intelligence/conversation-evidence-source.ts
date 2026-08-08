import type { WorkspaceId } from "../domain/model.js";
import type {
  ObservedSourceIdentity,
  RawConversationSnapshot
} from "../knowledge/observed-source-ledger.js";
import type { ConversationContextSubject } from "./interface.js";

export type CaptureConversationEvidenceInput = {
  workspaceId: WorkspaceId;
  subject: ConversationContextSubject;
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
