import type { ConversationContextSubject } from "../context-intelligence/interface.js";
import type { ConversationConsultationExecutionRecord } from "../context-intelligence/conversation-consultations.js";
import type { ConsultationReceipt } from "../consultation/interface.js";
import type {
  DecisionExecutionRecord,
  DecisionSubject
} from "../domain/decision-records.js";
import type {
  FollowUpExecutionRecorded,
  FollowUpIntentId,
  MeetingId,
  MeetingIntelligenceEvent,
  WorkspaceConfig
} from "../domain/model.js";

export type ExecuteFollowUpInput = {
  workspace: WorkspaceConfig;
  meetingId: MeetingId;
  /** The executor loads the canonical approved intent by this ID. */
  intentId: FollowUpIntentId;
};

export type ExecuteFollowUpResult = {
  observation: FollowUpExecutionRecorded;
  events: MeetingIntelligenceEvent[];
  idempotencyKey: string;
};

export interface FollowUpExecution {
  execute(input: ExecuteFollowUpInput): Promise<ExecuteFollowUpResult>;
  /**
   * An explicit operator-only recovery for a stranded execution lease. It
   * performs read-only positive probes and records an indeterminate result if
   * the provider cannot prove the original mutation's outcome.
   */
  recover(input: ExecuteFollowUpInput): Promise<ExecuteFollowUpResult>;
}

/** An explicit Conversation subject is never represented as a synthetic Meeting. */
export type ExecuteConversationFollowUpInput = {
  workspace: WorkspaceConfig;
  subject: ConversationContextSubject;
  intentId: FollowUpIntentId;
};
export type ExecuteConversationFollowUpResult = {
  observation: ConversationConsultationExecutionRecord;
  events: Array<{
    type: "consultation-execution-recorded";
    record: ConversationConsultationExecutionRecord;
  }>;
  idempotencyKey: string;
};
export interface ConversationFollowUpExecution {
  execute(
    input: ExecuteConversationFollowUpInput
  ): Promise<ExecuteConversationFollowUpResult>;
  recover(
    input: ExecuteConversationFollowUpInput
  ): Promise<ExecuteConversationFollowUpResult>;
  readConsultation(input: ExecuteConversationFollowUpInput): Promise<ConsultationReceipt>;
}
export type ExecuteDecisionFollowUpInput = {
  workspace: WorkspaceConfig;
  subject: DecisionSubject;
  decisionRequestId: string;
  /** Only the canonical approved intent is executable. */
  intentId: string;
};
export type ExecuteDecisionFollowUpResult = {
  record: DecisionExecutionRecord;
  idempotencyKey: string;
};
export interface DecisionFollowUpExecution {
  execute(input: ExecuteDecisionFollowUpInput): Promise<ExecuteDecisionFollowUpResult>;
  recover(input: ExecuteDecisionFollowUpInput): Promise<ExecuteDecisionFollowUpResult>;
}
/** Overloaded execution preserves existing Meeting callers and admits typed Conversations. */
export type ScopedFollowUpExecution = FollowUpExecution &
  ConversationFollowUpExecution &
  DecisionFollowUpExecution;
