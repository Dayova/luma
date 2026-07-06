import type {
  FollowUpExecutionRecorded,
  FollowUpIntent,
  MeetingId,
  MeetingIntelligenceEvent,
  WorkspaceConfig
} from "../domain/model.js";

export type ExecuteFollowUpInput = {
  workspace: WorkspaceConfig;
  meetingId: MeetingId;
  intent: FollowUpIntent;
};

export type ExecuteFollowUpResult = {
  observation: FollowUpExecutionRecorded;
  events: MeetingIntelligenceEvent[];
  idempotencyKey: string;
};

export interface FollowUpExecution {
  execute(input: ExecuteFollowUpInput): Promise<ExecuteFollowUpResult>;
}
