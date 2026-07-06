import type {
  MeetingConclusion,
  MeetingId,
  MeetingIntelligenceError,
  MeetingIntelligenceEvent,
  MeetingIntervention,
  MeetingObservation,
  MeetingState,
  ParticipantBrief,
  PersonId,
  WorkspaceConfig,
  WorkspaceId
} from "../domain/model.js";

export type ObserveMeeting = {
  workspace: WorkspaceConfig;
  observations: MeetingObservation[];
};

export type MeetingUpdate = {
  workspaceId: WorkspaceId;
  meetingId: MeetingId;
  revision: number;
  acceptedObservationIds: string[];
  duplicateObservationIds: string[];
  analysisStatus: "completed" | "deferred" | "not-needed";
  interventions: MeetingIntervention[];
  events: MeetingIntelligenceEvent[];
  errors: MeetingIntelligenceError[];
};

export type MeetingQuery =
  | {
      type: "snapshot";
    }
  | {
      type: "catch-up";
      since:
        | {
            type: "time";
            value: string;
          }
        | {
            type: "revision";
            value: number;
          };
    }
  | {
      type: "freeform";
      text: string;
      participantId?: PersonId;
    }
  | {
      type: "decision-history";
      topic: string;
    }
  | {
      type: "participant-brief";
      participantId: PersonId;
    };

export type QueryMeeting = {
  workspaceId: WorkspaceId;
  meetingId: MeetingId;
  query: MeetingQuery;
};

export type GroundedAnswer = {
  text: string;
  evidence: MeetingState["actionItems"][number]["provenance"]["evidence"];
  uncertainty: "none" | "partial" | "insufficient-evidence";
};

export type MeetingQueryResult =
  | {
      type: "snapshot";
      state: MeetingState;
    }
  | {
      type: "catch-up";
      answer: GroundedAnswer;
    }
  | {
      type: "freeform";
      answer: GroundedAnswer;
    }
  | {
      type: "decision-history";
      answer: GroundedAnswer;
    }
  | {
      type: "participant-brief";
      brief: ParticipantBrief;
    };

export type ConcludeMeeting = {
  workspaceId: WorkspaceId;
  meetingId: MeetingId;
  outputLanguage?: "de" | "en";
};

export interface MeetingIntelligence {
  observe(input: ObserveMeeting): Promise<MeetingUpdate>;
  query(input: QueryMeeting): Promise<MeetingQueryResult>;
  conclude(input: ConcludeMeeting): Promise<MeetingConclusion>;
}
