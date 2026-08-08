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
