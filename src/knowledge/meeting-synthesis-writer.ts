import type { LumaSynthesis } from "../domain/meeting-capture-synthesis.js";
import type { ExternalReference } from "../domain/model.js";
import type { ContextAudience } from "../organizational-context/interface.js";

/** Immutable plan retained before crossing any provider mutation boundary. */
export type MeetingSynthesisPublication = {
  workspaceId: string;
  logicalMeetingId: string;
  intentId: string;
  operationToken: string;
  audience: ContextAudience;
  synthesis: LumaSynthesis;
  /** Verified native anchor, or the previously positively written imported record. */
  anchor: ExternalReference | null;
};
export type MeetingSynthesisPublicationReceipt = {
  externalReference: ExternalReference;
  operationToken: string;
  synthesisRevision: number;
  sourceSetDigest: string;
};
export class MeetingSynthesisWriteNotAppliedError extends Error {
  constructor() {
    super("Meeting synthesis publication did not reach the provider.");
  }
}

/** A bounded canonical publication capability; never replaces raw source material. */
export interface MeetingSynthesisWriter {
  readonly providerId: string;
  publish(input: {
    publication: MeetingSynthesisPublication;
    /** Fresh MI proof at every actual provider substage. */
    requireCurrent: () => Promise<void>;
    /** Executor owns the shared physical-page lease before an existing-page mutation. */
    beforeWrite: (reference: ExternalReference | null) => Promise<void>;
    /** Persist positive provider evidence before any later local check can fail. */
    recordApplied: (receipt: MeetingSynthesisPublicationReceipt) => Promise<void>;
  }): Promise<MeetingSynthesisPublicationReceipt>;
  /** Positive-only recovery. Null never authorizes another uncertain write. */
  findPublished(input: {
    publication: MeetingSynthesisPublication;
    requireCurrent: () => Promise<void>;
  }): Promise<MeetingSynthesisPublicationReceipt | null>;
}
