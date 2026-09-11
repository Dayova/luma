import type { ExternalReference, PersonId, Provenance } from "../domain/model.js";
import type { ConversationPoll } from "../domain/conversation-poll.js";
import type { ConversationEvidenceProof } from "../context-intelligence/conversation-evidence-source.js";

export type ConsultationSourceProof = ConversationEvidenceProof & {
  /** Stable instruction/discussion identity; poll outcomes are observed separately. */
  authorizationHash: string;
};

/** Immutable advisory communication, separate from a confirmed Decision or work. */
export type AdvisoryConsultation = {
  id: string;
  choice:
    | { type: "conversation-evidence"; messageIds: string[]; pollMessageIds: string[] }
    | {
        type: "meeting-item";
        meetingId: string;
        itemId: string;
        pollMessageIds: string[];
      };
  purpose: string;
  question: string;
  options: string[];
  durationHours: number;
  allowsMultiple: boolean;
  /** Null means ownership has not been established; a title is not authority. */
  owner: { personId: PersonId; authorityEvidenceId: string } | null;
  recipientPersonIds: PersonId[];
  recipientGroupId: string;
  source: ConsultationSourceProof;
  authorization: {
    basis: "explicit-instruction" | "standing-policy";
    evidenceId: string;
    authorizedBy: PersonId;
  };
  provenance: Provenance;
  /** Changing a poll retains the previous operation and requires a new authorization. */
  replacesConsultationId: string | null;
};

export type ConsultationReceipt = {
  reference: ExternalReference;
  origin: "luma" | "human";
  disposition: "published" | "reused";
  observedAt: string;
  poll: ConversationPoll;
  /** Native delivery evidence; an incomplete mention never permits another send. */
  mention: "verified-role" | "incomplete" | "not-requested" | "unknown";
};

/** A proof of no mutation, including admission, input, or provider refusal. */
export class ConsultationNotPublishedError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ConsultationNotPublishedError";
  }
}

/** Every call freshly proves its source, destination and exact group recipients. */
export interface ConsultationProvider {
  readonly providerId: string;
  publish(input: {
    consultation: AdvisoryConsultation;
    operationId: string;
  }): Promise<ConsultationReceipt>;
  /** Positive-only probe. Null never permits another send after uncertainty. */
  findPublished(input: {
    consultation: AdvisoryConsultation;
    operationId: string;
  }): Promise<ConsultationReceipt | null>;
  read(input: {
    consultation: AdvisoryConsultation;
    reference: ExternalReference;
  }): Promise<ConsultationReceipt | null>;
  /** Only the same application's poll may be closed; never vote or edit. */
  close(input: {
    consultation: AdvisoryConsultation;
    reference: ExternalReference;
  }): Promise<ConsultationReceipt>;
}
