import type {
  EvidenceReference,
  ExternalReference,
  PersonId,
  WorkspaceConfig
} from "./model.js";

export type DecisionSubject =
  | {
      type: "conversation-thread";
      providerId: string;
      conversationObjectId: string;
      anchorMessageId: string;
    }
  | { type: "meeting"; meetingId: string };
export type DecisionActor = { providerId: string; providerUserId: string };
export type DecisionAudience = { workspaceId: string; personIds: PersonId[] };
export type DecisionEvidence = {
  id: string;
  reference: EvidenceReference;
  text: string;
  authorPersonId: PersonId | null;
  origin: "human" | "provider-derived" | "poll";
};
export type DecisionSource = {
  subject: DecisionSubject;
  revision: string;
  contentHash: string;
  /** Source access, boundary and wording; dynamic advisory counts never supply authority. */
  authorizationHash: string;
  audience: DecisionAudience;
  evidence: DecisionEvidence[];
  capturedAt: string;
};
export type DecisionClaim = { text: string; evidenceIds: string[] };
export type DecisionCandidate = {
  statement: DecisionClaim;
  modality:
    | "final-decision"
    | "accepted-proposal"
    | "proposal"
    | "preference"
    | "open-question"
    | "historical"
    | "reversal"
    | "unknown";
  scopeId: string | null;
  decisionMakerPersonIds: PersonId[];
  acceptanceEvidenceIds: string[];
  context: DecisionClaim | null;
  rationale: DecisionClaim[];
  alternatives: DecisionClaim[];
  consequences: DecisionClaim[];
  effectiveAt: string | null;
  /** An idea's disposition is separate from its record's lifecycle. */
  disposition: "adopt" | "pause" | "discard" | "unknown";
  objections: DecisionClaim[];
  unresolved: string[];
  relatedWork: ExternalReference[];
  implementationEvidence: ExternalReference[];
};
export type DecisionAuthorityGrant = {
  id: string;
  personId: PersonId;
  scopeId: string;
  kind: "project-ownership" | "delegation" | "confirmed-scope" | "provisional-role";
  standing: "current" | "provisional" | "superseded";
  evidence: EvidenceReference[];
  delegatedBy: PersonId | null;
  /** Actual affected stakeholders required for consequential scope, never a quorum. */
  consultedPersonIds: PersonId[];
};
export type DecisionAuthoritySnapshot = {
  id: string;
  revision: string;
  source: ExternalReference;
  contentHash: string;
  grants: DecisionAuthorityGrant[];
};
export type DecisionAuthorityProof = {
  snapshot: DecisionAuthoritySnapshot;
  grantIds: string[];
  decisionMakerPersonIds: PersonId[];
  acceptanceEvidenceIds: string[];
  /** Original authenticated Human review, separate from imported speech and provider summaries. */
  humanReviews?: DecisionHumanReview[];
};
export type DecisionHumanReview = {
  id: string;
  requestId: string;
  observationId: string;
  subject: DecisionSubject;
  actor: DecisionActor;
  personId: PersonId;
  audience: DecisionAudience;
  sourceContentHash: string;
  sourceAuthorizationHash: string;
  /** Null for an original recording instruction; later acceptance pins an exact review. */
  reviewToken: string | null;
  /** Exact accepted candidate content, excluding the new acceptance Evidence ID. */
  acceptedCandidateHash: string | null;
  evidence: DecisionEvidence;
  observedAt: string;
};
export type DecisionRecordContent = {
  id: string;
  candidate: DecisionCandidate;
  authority: DecisionAuthorityProof;
  source: DecisionSource;
  status: "pending" | "active" | "superseded" | "reversed";
  recordedAt: string;
  supersedes: ExternalReference[];
  supersededBy: ExternalReference | null;
};
export type CanonicalDecisionRecord = {
  content: DecisionRecordContent;
  reference: ExternalReference;
  version: string;
};
export type DecisionCatalogSnapshot = {
  id: string;
  revision: string;
  complete: boolean;
  records: CanonicalDecisionRecord[];
};
export type DecisionReconciliation =
  | { action: "create" }
  | { action: "link" | "amend" | "supersede" | "reverse"; targetRecordId: string }
  | { action: "reject" | "clarify"; reason: string };
export type DecisionInterpretation = {
  candidate: DecisionCandidate | null;
  reconciliation: DecisionReconciliation;
};
export type DecisionWriteStage =
  | { type: "create-record"; record: DecisionRecordContent }
  | {
      type: "amend-record";
      target: CanonicalDecisionRecord;
      record: DecisionRecordContent;
    }
  | {
      type: "retire-record";
      target: CanonicalDecisionRecord;
      status: "superseded" | "reversed";
      successor: ExternalReference;
    }
  | { type: "activate-record"; target: CanonicalDecisionRecord };
export type DecisionWriteReceipt = {
  record: CanonicalDecisionRecord;
  operationId: string;
  observedAt: string;
};
export type DecisionFollowUpIntent = {
  id: string;
  type: "record-decision";
  status: "approved";
  requestId: string;
  operationId: string;
  interpretation: DecisionInterpretation & { candidate: DecisionCandidate };
  source: DecisionSource;
  authority: DecisionAuthorityProof;
  catalog: DecisionCatalogSnapshot;
  record: DecisionRecordContent;
  target: CanonicalDecisionRecord | null;
  authorization: {
    basis: "explicit-instruction";
    authorizedBy: PersonId;
    instruction: string;
    evidenceId: string;
  };
};
export type DecisionRequestObservation = {
  type: "decision-record-requested";
  observationId: string;
  actor: DecisionActor;
  instruction: string;
  targetRecordId?: string;
};
export type DecisionCorrectionObservation = {
  type: "decision-candidate-corrected";
  observationId: string;
  requestId: string;
  actor: DecisionActor;
  /** Explicit Human correction of the retained interpretation, not source rewriting. */
  candidate: DecisionCandidate;
  reason: string;
};
export type DecisionExecutionRecord = {
  type: "follow-up-execution-recorded";
  recordId: string;
  workspaceId: string;
  subject: DecisionSubject;
  requestId: string;
  intentId: string;
  operationId: string;
  recordedAt: string;
  outcome:
    | { status: "succeeded"; references: ExternalReference[] }
    | {
        status: "failed";
        errorCode: string;
        message: string;
        requiresManualRecovery: boolean;
        references: ExternalReference[];
      };
};
export type DecisionRequestState = {
  requestId: string;
  subject: DecisionSubject;
  state:
    | "candidate"
    | "confirmed"
    | "recorded"
    | "rejected"
    | "needs-clarification"
    | "unknown";
  message: string;
  candidate: DecisionCandidate | null;
  approvedIntentId: string | null;
  execution: DecisionExecutionRecord | null;
  source: DecisionSource;
  /** Pins the complete candidate and its source/recording plan for explicit Human review. */
  reviewToken?: string;
};
export type ObserveDecision = {
  workspace: WorkspaceConfig;
  subject: DecisionSubject;
  observations: [DecisionRequestObservation | DecisionCorrectionObservation];
};
export type DecisionUpdate = DecisionRequestState & { duplicate: boolean };
export type QueryDecision = {
  workspaceId: string;
  subject: DecisionSubject;
  query: { type: "decision-request"; requestId: string };
};
export type ConcludeDecision = {
  workspaceId: string;
  subject: DecisionSubject;
  requestId: string;
};
export type DecisionConclusion = { request: DecisionRequestState; summary: string };
