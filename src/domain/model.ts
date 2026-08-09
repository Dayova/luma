export type WorkspaceId = string;
export type MeetingId = string;
export type ObservationId = string;
export type PersonId = string;
export type UtteranceId = string;
export type EvidenceId = string;
export type MeetingItemId = string;
export type DecisionId = string;
export type ActionItemId = string;
export type OpenQuestionId = string;
export type RiskId = string;
export type FollowUpIntentId = string;
export type TopicId = string;

export type MeetingLanguageMode = "auto" | "de" | "en" | "multilingual";
export type UtteranceLanguage = "de" | "en" | "mixed" | "unknown";
export type Confidence = "low" | "medium" | "high";
export type ActionItemStatus =
  | "candidate"
  | "confirmed"
  | "planned"
  | "in-progress"
  | "blocked"
  | "completed"
  | "cancelled";
export type DecisionStatus = "candidate" | "confirmed" | "rejected" | "superseded";
export type DueDateConfidence = "exact" | "normalized" | "ambiguous" | "unknown";

export type WorkspaceConfig = {
  workspaceId: WorkspaceId;
  timezone: string;
  outputLanguagePolicy?: OutputLanguagePolicy;
  publishingPolicy?: MeetingPublishingPolicy;
};

export type OutputLanguagePolicy =
  | "meeting-majority"
  | "german"
  | "english"
  | "bilingual"
  | "request-language"
  | "participant-preference"
  | "destination-policy";

export type MeetingPublishingPolicy = {
  publishMeetingNotes: boolean;
  publishCleanedTranscript: boolean;
  publishRawTranscript: boolean;
  publishTranslatedTranscript: boolean;
  transcriptPlacement: "inline" | "attachment" | "linked-storage";
  defaultKnowledgeDestination: "confluence" | "notion";
  requireHumanApprovalBeforePublishing: boolean;
};

export type ExternalReference = {
  providerId: string;
  objectType:
    | "document"
    | "work-item"
    | "pull-request"
    | "commit"
    | "comment"
    | "project"
    | "other";
  externalId: string;
  url: string;
  version?: string;
};

export type ExternalUser = {
  id: string;
  displayName: string;
  username?: string;
};

export type ImportedMeetingSourceCompleteness =
  | "complete"
  | "partial"
  | "not-ready"
  | "failed"
  /** A fully readable canonical source scan confirmed this source root is gone. */
  | "removed";

export type ImportedMeetingSourceCompletenessReason = {
  code: string;
  message: string;
  sourceBlockId?: string;
};

export type ImportedMeetingSource = {
  providerId: string;
  sourceKind: "meeting-note";
  sourceObjectId: string;
  parentObjectId: string | null;
  sourceRevision: number;
  contentHash: string;
  providerVersion: string | null;
  title: string | null;
  externalReference: ExternalReference;
  /** Provider whose opaque work-item identifiers are meaningful in this source. */
  workItemProviderId: string;
  /** Provider namespace for exact GitHub implementation locators in this source. */
  implementationReferenceProviderId: string;
  completeness: ImportedMeetingSourceCompleteness;
  completenessReasons: ImportedMeetingSourceCompletenessReason[];
  actionItemsAvailability: "available" | "unavailable" | "unknown";
  /**
   * Immutable offset-bearing instant used for relative Action Item deadlines.
   * Null means the source could preserve a phrase but could not normalize it.
   */
  deadlineReferenceAt: string | null;
  capturedAt: string;
};

export type ImportedMeetingSourceSection = {
  section: "summary" | "action-items-and-notes" | "transcript";
  sourceBlockId: string;
  excerpt: string;
};

/**
 * Immutable source material for one actionable block. Candidates may only
 * describe a block declared by the same source Observation.
 */
export type ImportedActionItemSourceBlock = {
  sourceBlockId: string;
  excerpt: string;
  completion: "open" | "completed";
};

export type ImportedActionItemModality = {
  kind:
    | "commitment"
    | "request"
    | "proposal"
    | "suggestion"
    | "conditional"
    | "question"
    | "completed-work"
    | "unknown";
  sourceForm: string | null;
};

/**
 * Exact owner-like wording from an imported source. This is not an identity
 * and must never be used directly as a canonical work assignee.
 */
export type ImportedActionItemSourceOwner =
  | {
      state: "unmapped";
      sourceText: string;
    }
  | {
      state: "unspecified";
      sourceText: null;
    }
  | {
      state: "ambiguous";
      sourceText: string;
    };

/**
 * Luma's effective responsibility assessment. It is deliberately distinct
 * from source wording: a named person, speaker label, attendee, or model
 * proposal is never a confirmed owner on its own.
 */
export type ActionItemOwnershipAttribution =
  | {
      status: "confirmed";
      ownerPersonId: PersonId;
      confidence: "deterministic" | "high";
      basis:
        | "self-commitment"
        | "explicit-assignment"
        | "assignment-accepted"
        | "human-confirmation";
    }
  | {
      status: "proposed";
      proposedOwnerPersonId: PersonId | null;
      confidence: "medium" | "low";
      basis: "proposed-assignment" | "inferred-assignment";
    }
  | {
      status: "intentionally-unassigned";
      basis: "team-decision" | "human-confirmation";
    }
  | {
      status: "unresolved";
      reason:
        | "missing-speaker"
        | "conflicting-speaker"
        | "no-owner-stated"
        | "insufficient-acceptance"
        | "unsupported-semantics";
      likelyOwnerPersonId: PersonId | null;
    };

export type ImportedWorkItemReference = {
  providerId: string;
  objectType: "work-item";
  externalId: string;
};

/**
 * An exact GitHub implementation locator present in immutable source wording.
 * It records a source claim only; it does not assert that the referenced code
 * implements the Action Item or that GitHub currently resolves the locator.
 */
export type ImportedImplementationReference = {
  providerId: string;
  objectType: "pull-request" | "commit";
  externalId: string;
  url: string;
};

export type ImportedActionItemCandidate = {
  id: string;
  lineageKey: string;
  originalText: string;
  description: string;
  language: UtteranceLanguage;
  modality: ImportedActionItemModality;
  completion: "open" | "completed";
  /** Immutable source wording; use `ownership` for a responsibility decision. */
  sourceOwner: ImportedActionItemSourceOwner;
  /** Source-derived initial state. Only Human Judgment may confirm/unassign it. */
  ownership: ActionItemOwnershipAttribution;
  deadline: {
    originalPhrase: string | null;
    normalizedDate: string | null;
    confidence: DueDateConfidence;
    timezone: string;
  };
  mentionedWorkItemReferences: ImportedWorkItemReference[];
  /** Exact GitHub PR/commit URLs found in this immutable source block. */
  sourceBoundImplementationReferences: ImportedImplementationReference[];
  projectHints: string[];
  componentHints: string[];
  source: {
    source: ImportedMeetingSource;
    sourceBlockId: string;
    sourceSection: "action-items-and-notes";
    sourceExcerpt: string;
  };
  evidence: EvidenceReference[];
};

export type ReconciliationWorkItemSnapshot = {
  providerId: string;
  /** Opaque provider lookup identity; distinct from a human-facing external ID. */
  lookupId: string;
  externalId: string;
  title: string;
  description: string;
  status: "backlog" | "planned" | "active" | "blocked" | "completed" | "cancelled";
  assignees: ExternalUser[];
  dueDate: string | null;
  labels: string[];
  projectId: string | null;
  parentId: string | null;
  url: string;
  updatedAt: string;
};

export type ActionItemReconciliationMatchSignal = {
  kind:
    | "exact-id"
    | "semantic"
    | "project"
    | "component"
    | "ownership"
    | "activity"
    | "prior-mapping";
  score: number;
  detail: string;
  workItem?: {
    providerId: string;
    externalId: string;
  };
};

export type ActionItemReconciliationSearchReceipt = {
  providerId: string;
  query: string;
  status: "completed" | "failed" | "not-configured";
  workItems: ReconciliationWorkItemSnapshot[];
  failure: string | null;
};

export type ActionItemReconciliationOutcome =
  | {
      type: "link-existing";
      workItem: ReconciliationWorkItemSnapshot;
      rationale: string;
    }
  | {
      type: "update-existing";
      workItem: ReconciliationWorkItemSnapshot;
      rationale: string;
    }
  | {
      type: "create-new";
      rationale: string;
    }
  | {
      type: "reject-not-work";
      rationale: string;
    }
  | {
      type: "needs-clarification";
      rationale: string;
    };

export type ActionItemReconciliationResolution =
  | {
      type: "accept-proposal";
    }
  | {
      type: "reject-proposal";
      reason?: string;
    }
  | {
      type: "select-existing";
      providerId: string;
      externalId: string;
      action: "link-existing" | "update-existing";
    }
  | {
      type: "select-create-new";
    }
  | {
      /** Preserve a reviewable source outcome without inventing Linear work. */
      type: "select-needs-clarification";
      reason?: string;
    };

/**
 * An immutable, evidence-backed proposal. It never performs a WorkProvider
 * mutation; an approved Follow-up Intent owns any later write.
 */
export type ActionItemReconciliationReview = {
  id: string;
  policyVersion: string;
  attempt: number;
  trigger:
    | "initial-source-import"
    | "catalog-retry"
    | "human-refresh"
    | "human-ownership-resolution";
  /** A retry is safe only when the catalog was unavailable or failed to read. */
  retryable: boolean;
  /**
   * The earliest time an automatic retry may re-read a failed Work Catalog.
   * Human-triggered refreshes deliberately bypass this schedule. `null` means
   * the review did not fail while reading a configured catalog.
   */
  automaticRetryNotBefore: string | null;
  catalogProviderId: string;
  candidateId: string;
  candidateLineageKey: string;
  candidate: ImportedActionItemCandidate;
  /** Immutable effective ownership snapshot used for this exact review. */
  ownership: ActionItemOwnershipAttribution;
  /** Source and hydrated canonical-work Evidence that grounds this proposal. */
  evidence: EvidenceReference[];
  searches: ActionItemReconciliationSearchReceipt[];
  matchSignals: ActionItemReconciliationMatchSignal[];
  outcome: ActionItemReconciliationOutcome;
  reviewStatus: "proposed";
  reviewedAt: string;
};

/** An immutable Human Judgment that resolves one immutable review proposal. */
export type ActionItemReconciliationHumanResolution = {
  id: string;
  reviewId: string;
  candidateId: string;
  participantId: PersonId;
  resolution: ActionItemReconciliationResolution;
  outcome: ActionItemReconciliationOutcome;
  evidence: EvidenceReference;
  resolvedAt: string;
};

/**
 * An append-only Human correction over the immutable candidate ownership
 * claim. Later corrections supersede earlier ones; they never rewrite source
 * text or turn a speaker/name guess into source fact.
 */
export type ActionItemOwnershipHumanResolution = {
  id: string;
  claimId: string;
  candidateId: string;
  candidateLineageKey: string;
  participantId: PersonId;
  ownership: ActionItemOwnershipAttribution;
  evidence: EvidenceReference;
  resolvedAt: string;
};

/** Immutable receipt linking a successful new work item to its source lineage. */
export type ActionItemReconciliationCreatedWorkMapping = {
  id: string;
  reviewId: string;
  candidateId: string;
  candidateLineageKey: string;
  externalReference: ExternalReference;
  recordedAt: string;
};

/** The reconciliation query's current projection; it never mutates its proposal. */
export type CurrentActionItemReconciliationReview = {
  proposal: ActionItemReconciliationReview;
  /** Stable immutable source claim a caller may resolve through Human Judgment. */
  ownershipClaimId: string;
  ownership: ActionItemOwnershipAttribution;
  effectiveOutcome: ActionItemReconciliationOutcome;
  status: "proposed" | "blocked-by-conflict" | "human-resolved";
  conflictingCandidateIds: string[];
  humanResolution: ActionItemReconciliationHumanResolution | null;
};

export type SpeakerAttributionConfidence =
  "deterministic" | "high" | "medium" | "low" | "unknown";

/**
 * Evidence-backed identity for an utterance speaker. It is intentionally
 * independent from responsibility for a resulting Action Item.
 */
export type SpeakerAttribution =
  | {
      status: "attributed";
      personId: PersonId;
      confidence: "deterministic" | "high";
      /** Only identity proof or durable Human Judgment may establish a speaker. */
      basis: "provider-identity" | "human-confirmation";
    }
  | {
      status: "unresolved";
      candidatePersonId: PersonId | null;
      confidence: "medium" | "low" | "unknown";
      basis:
        | "provider-speaker-label"
        | "calendar-context"
        | "audio-diarization"
        | "contextual-inference"
        | "human-confirmation"
        | "legacy-unverified";
    };

/** Immutable Human correction over a versioned utterance speaker claim. */
export type SpeakerAttributionHumanResolution = {
  id: string;
  utteranceId: UtteranceId;
  version: number;
  participantId: PersonId;
  speaker: SpeakerAttribution;
  evidence: EvidenceReference;
  resolvedAt: string;
};

export type ObservationBase = {
  observationId: ObservationId;
  workspaceId: WorkspaceId;
  meetingId: MeetingId;
  occurredAt: string;
  observedAt: string;
};

export type MeetingStarted = ObservationBase & {
  type: "meeting-started";
  title: string;
  startedAt: string;
  languageMode: MeetingLanguageMode;
  participantIds: PersonId[];
};

export type MeetingEnded = ObservationBase & {
  type: "meeting-ended";
  endedAt: string;
};

export type UtteranceCommitted = ObservationBase & {
  type: "utterance-committed";
  utteranceId: UtteranceId;
  version: number;
  /** Speaker attribution is not Action Item ownership. */
  speaker: SpeakerAttribution;
  startedAt: string;
  endedAt: string;
  originalText: string;
  language: UtteranceLanguage;
};

export type UtteranceRevised = ObservationBase & {
  type: "utterance-revised";
  utteranceId: UtteranceId;
  replacesVersion: number;
  version: number;
  originalText: string;
  language: UtteranceLanguage;
};

export type ParticipantJoined = ObservationBase & {
  type: "participant-joined";
  participantId: PersonId;
};

export type ParticipantLeft = ObservationBase & {
  type: "participant-left";
  participantId: PersonId;
};

export type AgendaChanged = ObservationBase & {
  type: "agenda-changed";
  agenda: AgendaItem[];
};

export type MeetingImportedFromSource = ObservationBase & {
  type: "meeting-imported-from-source";
  source: ImportedMeetingSource;
  sourceSections: ImportedMeetingSourceSection[];
  actionItemBlocks: ImportedActionItemSourceBlock[];
  evidence: EvidenceReference[];
  candidates: ImportedActionItemCandidate[];
};

export type MeetingItemCorrection = {
  statement?: string;
  ownerId?: PersonId | null;
  dueDate?: string | null;
  status?: ActionItemStatus | DecisionStatus;
};

export type MeetingItemDraft = {
  kind: MeetingItemKind;
  statement: string;
  evidence: EvidenceReference[];
};

export type HumanJudgment =
  | {
      kind: "confirm";
      meetingItemId: MeetingItemId;
    }
  | {
      kind: "reject";
      meetingItemId: MeetingItemId;
      reason?: string;
    }
  | {
      kind: "correct";
      meetingItemId: MeetingItemId;
      correction: MeetingItemCorrection;
    }
  | {
      kind: "merge";
      meetingItemIds: MeetingItemId[];
    }
  | {
      kind: "split";
      meetingItemId: MeetingItemId;
      replacements: MeetingItemDraft[];
    }
  | {
      kind: "resolve-action-item-reconciliation";
      reviewId: string;
      resolution: ActionItemReconciliationResolution;
    }
  | {
      /** Resolve the immutable ownership claim for one current source candidate. */
      kind: "resolve-action-item-ownership";
      claimId: string;
      resolution:
        | { type: "confirm-owner"; ownerPersonId: PersonId }
        | { type: "intentionally-unassigned" }
        | {
            type: "keep-unresolved";
            reason?: Extract<
              ActionItemOwnershipAttribution,
              { status: "unresolved" }
            >["reason"];
          };
    }
  | {
      /** Correct a speaker claim without rewriting the original utterance. */
      kind: "resolve-speaker-attribution";
      utteranceId: UtteranceId;
      version: number;
      personId: PersonId | null;
    }
  | {
      /** Ask Luma to re-read canonical work after a Human-reviewed stale target. */
      kind: "refresh-action-item-reconciliation";
      reviewId: string;
    };

export type HumanJudgmentRecorded = ObservationBase & {
  type: "human-judgment-recorded";
  judgment: HumanJudgment;
  participantId: PersonId;
};

export type FollowUpIntentApproved = ObservationBase & {
  type: "follow-up-intent-approved";
  intentId: FollowUpIntentId;
  approvedBy: PersonId;
};

export type FollowUpIntentRejected = ObservationBase & {
  type: "follow-up-intent-rejected";
  intentId: FollowUpIntentId;
  rejectedBy: PersonId;
  reason?: string;
};

export type FollowUpExecutionRecorded = ObservationBase & {
  type: "follow-up-execution-recorded";
  intentId: FollowUpIntentId;
  /** Opaque one-time capability issued by Follow-up Execution's DB claim. */
  executionLeaseId: string;
  outcome:
    | {
        status: "succeeded";
        externalReferences: ExternalReference[];
        summary?: string;
      }
    | {
        status: "partially-succeeded";
        externalReferences: ExternalReference[];
        errorCode: string;
        message: string;
      }
    | {
        status: "failed";
        errorCode: string;
        message: string;
        retryable: boolean;
        /**
         * The executor could not safely release or verify an external
         * capability. This is intentionally distinct from a normal failed
         * mutation so callers must surface manual recovery rather than retry.
         */
        requiresManualRecovery?: boolean;
        /**
         * A safely established earlier stage (for example Linear create) may
         * still be auditable even when a later stage requires manual recovery.
         */
        externalReferences?: ExternalReference[];
      };
};

export type ExternalActivityObserved = ObservationBase & {
  type: "external-activity-observed";
  activity: ExternalActivity;
};

export type MeetingObservation =
  | MeetingStarted
  | MeetingEnded
  | UtteranceCommitted
  | UtteranceRevised
  | ParticipantJoined
  | ParticipantLeft
  | AgendaChanged
  | MeetingImportedFromSource
  | HumanJudgmentRecorded
  | FollowUpIntentApproved
  | FollowUpIntentRejected
  | FollowUpExecutionRecorded
  | ExternalActivityObserved;

export type EvidenceReference = {
  evidenceId: EvidenceId;
  source:
    | "transcript"
    | "human-judgment"
    | "knowledge"
    | "work"
    | "code"
    | "previous-meeting"
    | "external-activity";
  sourceObjectId: string;
  participantId?: PersonId;
  sourceVersion?: string;
  excerpt?: string;
  startedAtMs?: number;
  endedAtMs?: number;
  externalReference?: ExternalReference;
};

export type Provenance = {
  evidence: EvidenceReference[];
  confidence: Confidence;
  producedAtRevision: number;
  analysisVersion: string;
  modelMetadata?: {
    provider: string;
    model: string;
    promptVersion: string;
  };
};

export type MeetingParticipant = {
  personId: PersonId;
  joinedAt: string | null;
  leftAt: string | null;
};

export type AgendaItem = {
  id: string;
  title: string;
  status: "planned" | "active" | "done";
};

export type Topic = {
  id: TopicId;
  title: string;
  provenance: Provenance;
};

export type Proposal = {
  id: MeetingItemId;
  statement: string;
  provenance: Provenance;
};

export type Decision = {
  id: DecisionId;
  statement: string;
  rationale: string[];
  status: DecisionStatus;
  supersedesDecisionId: DecisionId | null;
  supersededByDecisionId: DecisionId | null;
  supportingParticipantIds: PersonId[];
  objectingParticipantIds: PersonId[];
  relatedTopicIds: TopicId[];
  provenance: Provenance;
};

export type ActionItem = {
  id: ActionItemId;
  description: string;
  /**
   * Effective responsibility state. A legacy/raw model `ownerId` is never a
   * confirmation on its own; `ownerId` below is only the confirmed projection
   * retained for existing caller compatibility.
   */
  ownership?: ActionItemOwnershipAttribution;
  ownerId: PersonId | null;
  dueDate: string | null;
  dueDateConfidence: DueDateConfidence;
  status: ActionItemStatus;
  relatedDecisionIds: DecisionId[];
  externalReferences: ExternalReference[];
  provenance: Provenance;
};

export type OpenQuestion = {
  id: OpenQuestionId;
  question: string;
  raisedBy: PersonId | null;
  status: "open" | "answered" | "cancelled";
  possibleAnswers: string[];
  provenance: Provenance;
};

export type Risk = {
  id: RiskId;
  statement: string;
  severity: "low" | "medium" | "high" | "unknown";
  mitigation: string | null;
  provenance: Provenance;
};

export type MeetingItemKind =
  "topic" | "proposal" | "decision" | "action-item" | "open-question" | "risk";

export type FollowUpIntentStatus =
  | "suggested"
  | "approved"
  | "rejected"
  /** The source proposal was superseded before this intent could execute. */
  | "invalidated"
  | "executing"
  | "succeeded"
  | "partially-succeeded"
  | "failed"
  /** A provider write may have happened but Luma could not prove its outcome. */
  | "requires-manual-recovery";

export type RecordMeetingIntent = {
  id: FollowUpIntentId;
  type: "record-meeting";
  title: string;
  relatedMeetingItemIds: MeetingItemId[];
  status: FollowUpIntentStatus;
  provenance: Provenance;
};

export type UpdateKnowledgeIntent = {
  id: FollowUpIntentId;
  type: "update-knowledge";
  title: string;
  bodyMarkdown: string;
  relatedMeetingItemIds: MeetingItemId[];
  status: FollowUpIntentStatus;
  provenance: Provenance;
};

/** Links a follow-up intent to the Human-resolved source proposal it owns. */
export type ActionItemReconciliationIntentBinding = {
  reviewId: string;
  candidateId: string;
  candidateLineageKey: string;
};

/**
 * Authorizes settlement of one Human-resolved source reconciliation. Provider
 * targets, source pages, and rendered Markdown are deliberately absent: the
 * executor derives them from canonical Meeting state immediately before use.
 */
export type SettleOperationalOutcomeIntent = {
  id: FollowUpIntentId;
  type: "settle-operational-outcome";
  reconciliation: ActionItemReconciliationIntentBinding;
  relatedMeetingItemIds: MeetingItemId[];
  status: FollowUpIntentStatus;
  provenance: Provenance;
};

export type CreateWorkItemIntent = {
  id: FollowUpIntentId;
  type: "create-work-item";
  title: string;
  description: string;
  assigneeId: PersonId | null;
  mentionPersonIds?: PersonId[];
  dueDate: string | null;
  /** Optional for legacy/general intents; reconciliation supplies an opaque provider ID. */
  providerId?: string;
  reconciliation?: ActionItemReconciliationIntentBinding;
  relatedMeetingItemIds: MeetingItemId[];
  status: FollowUpIntentStatus;
  provenance: Provenance;
};

export type UpdateWorkItemIntent = {
  id: FollowUpIntentId;
  type: "update-work-item";
  externalReference: ExternalReference;
  /** Optional for generic intents; reconciliation preserves the hydrated provider lookup ID. */
  providerObjectId?: string;
  /** Omitted means preserve the canonical work item's existing description. */
  description?: string;
  /** Omitted means leave the provider due date unchanged. */
  dueDate?: string | null;
  reconciliation?: ActionItemReconciliationIntentBinding;
  relatedMeetingItemIds: MeetingItemId[];
  status: FollowUpIntentStatus;
  provenance: Provenance;
};

export type CommentOnCodeChangeIntent = {
  id: FollowUpIntentId;
  type: "comment-on-code-change";
  externalReference: ExternalReference;
  bodyMarkdown: string;
  relatedMeetingItemIds: MeetingItemId[];
  status: FollowUpIntentStatus;
  provenance: Provenance;
};

export type FollowUpIntent =
  | RecordMeetingIntent
  | UpdateKnowledgeIntent
  | SettleOperationalOutcomeIntent
  | CreateWorkItemIntent
  | UpdateWorkItemIntent
  | CommentOnCodeChangeIntent;

export type MeetingState = {
  workspaceId: WorkspaceId;
  meetingId: MeetingId;
  revision: number;
  lifecycle: "scheduled" | "live" | "ended" | "imported";
  title: string;
  participants: MeetingParticipant[];
  agenda: AgendaItem[];
  currentTopicId: TopicId | null;
  topics: Topic[];
  proposals: Proposal[];
  decisions: Decision[];
  actionItems: ActionItem[];
  openQuestions: OpenQuestion[];
  risks: Risk[];
  /**
   * Stable Meeting item identities whose current representation was confirmed,
   * rejected, or corrected by a Human. Future AI proposals may not overwrite
   * these items; a later Human Judgment remains the authoritative change path.
   */
  humanJudgmentItemIds: MeetingItemId[];
  followUpIntentions: FollowUpIntent[];
  importedSources: ImportedMeetingSource[];
  importedActionItemCandidates: ImportedActionItemCandidate[];
  currentImportedActionItemCandidateIds: string[];
  actionItemReconciliationReviews: ActionItemReconciliationReview[];
  actionItemReconciliationHumanResolutions: ActionItemReconciliationHumanResolution[];
  actionItemOwnershipHumanResolutions: ActionItemOwnershipHumanResolution[];
  speakerAttributionHumanResolutions: SpeakerAttributionHumanResolution[];
  /**
   * Participants whose current presence was derived only from a trusted
   * transcript speaker attribution. Direct attendance observations remain
   * independent of this projection and must survive a later correction.
   *
   * Optional while existing persisted Meeting State is upgraded lazily.
   */
  speakerInferredParticipantIds?: PersonId[];
  actionItemReconciliationCreatedWorkMappings: ActionItemReconciliationCreatedWorkMapping[];
  lastObservationAt: string;
  lastAnalyzedAt: string | null;
};

export type ExternalActivity = {
  providerId: string;
  externalReference: ExternalReference;
  kind:
    | "work-started"
    | "work-blocked"
    | "work-completed"
    | "pull-request-opened"
    | "pull-request-merged"
    | "knowledge-updated";
  occurredAt: string;
  relatedMeetingItemIds: MeetingItemId[];
};

export type MeetingIntervention =
  | {
      type: "missing-action-owner";
      actionItemId: ActionItemId;
    }
  | {
      type: "missing-action-deadline";
      actionItemId: ActionItemId;
    }
  | {
      type: "decision-confirmation-needed";
      decisionId: DecisionId;
    }
  | {
      type: "possible-decision-conflict";
      currentDecisionId: DecisionId;
      previousDecisionId: DecisionId;
      evidence: EvidenceReference[];
    }
  | {
      type: "possible-agenda-drift";
      topicId: TopicId;
    }
  | {
      type: "possible-repeated-discussion";
      relatedMeetingItemIds: MeetingItemId[];
    };

export type MeetingIntelligenceEvent =
  | {
      type: "follow-up-awaiting-approval";
      intentIds: FollowUpIntentId[];
    }
  | {
      type: "follow-up-execution-started";
      intentId: FollowUpIntentId;
    }
  | {
      type: "follow-up-execution-succeeded";
      intentId: FollowUpIntentId;
      externalReferences: ExternalReference[];
      summary: string;
    }
  | {
      type: "follow-up-execution-partially-succeeded";
      intentId: FollowUpIntentId;
      externalReferences: ExternalReference[];
      message: string;
    }
  | {
      type: "follow-up-execution-failed";
      intentId: FollowUpIntentId;
      message: string;
      retryable: boolean;
    }
  | {
      type: "action-item-status-changed";
      actionItemId: ActionItemId;
      previousStatus: ActionItemStatus;
      currentStatus: ActionItemStatus;
      externalReferences: ExternalReference[];
    }
  | {
      type: "meeting-follow-up-completed";
      meetingId: MeetingId;
      completedIntentIds: FollowUpIntentId[];
      outstandingIntentIds: FollowUpIntentId[];
    };

export type ParticipantBrief = {
  participantId: PersonId;
  commitments: ActionItem[];
  decisionsAffectingWork: Decision[];
  unresolvedQuestions: OpenQuestion[];
  outputLanguage: "de" | "en";
};

export type MeetingConclusion = {
  workspaceId: WorkspaceId;
  meetingId: MeetingId;
  revision: number;
  summary: {
    brief: string;
    detailed: string;
  };
  topics: Topic[];
  decisions: Decision[];
  actionItems: ActionItem[];
  openQuestions: OpenQuestion[];
  risks: Risk[];
  followUpIntentions: FollowUpIntent[];
  participantBriefs: ParticipantBrief[];
  outputLanguage: "de" | "en";
  provenance: Provenance;
  createdAt: string;
};

export type MeetingIntelligenceError =
  | {
      code: "meeting-not-found";
      retryable: false;
    }
  | {
      code: "invalid-observation";
      observationId: ObservationId;
      message: string;
      retryable: false;
    }
  | {
      code: "analysis-temporarily-unavailable";
      retryable: true;
    }
  | {
      code: "source-verification-unavailable";
      observationId: ObservationId;
      message: string;
      retryable: true;
    }
  | {
      code: "context-unavailable";
      retryable: true;
      partialResultAvailable: boolean;
    }
  | {
      code: "concurrent-update";
      retryable: true;
    }
  | {
      code: "permission-denied";
      retryable: false;
    };
