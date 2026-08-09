import type {
  ActionItemStatus,
  Confidence,
  DecisionStatus,
  DueDateConfidence,
  EvidenceId,
  EvidenceReference,
  ExternalReference,
  MeetingId,
  PersonId,
  WorkspaceId
} from "../domain/model.js";

export type StructuredReasoningRequest<T> = {
  workspaceId: WorkspaceId;
  meetingId: MeetingId;
  purpose:
    | "understand-discussion"
    | "answer-question"
    | "prepare-conclusion"
    | "prepare-follow-up";
  promptVersion: string;
  schemaName: string;
  evidence: EvidenceReference[];
  context: string[];
  input: Record<string, unknown>;
  expectedType?: T;
};

export type StructuredReasoningResult<T> = {
  value: T;
  metadata: {
    provider: string;
    model: string;
    promptVersion: string;
  };
};

export interface ReasoningModel {
  generateStructured<T>(
    request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>>;
}

export type ProposedDueDate = {
  originalPhrase: string | null;
  normalizedDate: string | null;
  confidence: DueDateConfidence;
  timezone: string;
};

export type ActionItemProposal = {
  stableKey: string;
  description: string;
  /**
   * A model-suggested Person only. Meeting Intelligence turns this into an
   * explicit proposed/unresolved Ownership Attribution; it is never a
   * confirmed assignee on its own.
   */
  ownerId: PersonId | null;
  dueDate: ProposedDueDate;
  status: ActionItemStatus;
  relatedDecisionIds: string[];
  evidenceIds: EvidenceId[];
  confidence: Confidence;
};

export type DecisionProposal = {
  stableKey: string;
  statement: string;
  rationale: string[];
  status: DecisionStatus;
  supportingParticipantIds: PersonId[];
  objectingParticipantIds: PersonId[];
  relatedTopicIds: string[];
  evidenceIds: EvidenceId[];
  confidence: Confidence;
};

export type OpenQuestionProposal = {
  stableKey: string;
  question: string;
  raisedBy: PersonId | null;
  evidenceIds: EvidenceId[];
  confidence: Confidence;
};

export type RiskProposal = {
  stableKey: string;
  statement: string;
  severity: "low" | "medium" | "high" | "unknown";
  mitigation: string | null;
  evidenceIds: EvidenceId[];
  confidence: Confidence;
};

type FollowUpIntentProposalBase = {
  id: string;
  relatedMeetingItemIds: string[];
  evidenceIds: EvidenceId[];
  confidence: Confidence;
};

export type FollowUpIntentProposal =
  | (FollowUpIntentProposalBase & {
      type: "record-meeting";
      title: string;
    })
  // Retained at the port boundary so Meeting Intelligence can preserve an
  // explicit policy-rejected audit record if a legacy or non-OpenAI model
  // emits it. The OpenAI schema no longer permits this proposal.
  | (FollowUpIntentProposalBase & {
      type: "update-knowledge";
      title: string;
      bodyMarkdown: string;
    })
  | (FollowUpIntentProposalBase & {
      type: "create-work-item";
      title: string;
      description: string;
      assigneeId: PersonId | null;
      mentionPersonIds: PersonId[];
      dueDate: string | null;
    })
  | (FollowUpIntentProposalBase & {
      type: "update-work-item";
      externalReference: ExternalReference;
      description: string;
    })
  | (FollowUpIntentProposalBase & {
      type: "comment-on-code-change";
      externalReference: ExternalReference;
      bodyMarkdown: string;
    });

export type MeetingAnalysisProposalBatch = {
  actionItems: ActionItemProposal[];
  decisions: DecisionProposal[];
  openQuestions: OpenQuestionProposal[];
  risks: RiskProposal[];
  followUpIntentions: FollowUpIntentProposal[];
};
