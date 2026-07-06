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
  speakerId: PersonId;
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
  | "executing"
  | "succeeded"
  | "partially-succeeded"
  | "failed";

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

export type CreateWorkItemIntent = {
  id: FollowUpIntentId;
  type: "create-work-item";
  title: string;
  description: string;
  assigneeId: PersonId | null;
  mentionPersonIds?: PersonId[];
  dueDate: string | null;
  relatedMeetingItemIds: MeetingItemId[];
  status: FollowUpIntentStatus;
  provenance: Provenance;
};

export type UpdateWorkItemIntent = {
  id: FollowUpIntentId;
  type: "update-work-item";
  externalReference: ExternalReference;
  description: string;
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
  | CreateWorkItemIntent
  | UpdateWorkItemIntent
  | CommentOnCodeChangeIntent;

export type MeetingState = {
  workspaceId: WorkspaceId;
  meetingId: MeetingId;
  revision: number;
  lifecycle: "scheduled" | "live" | "ended";
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
  followUpIntentions: FollowUpIntent[];
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
