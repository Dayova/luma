import type { MeetingPublishingPolicy, OutputLanguagePolicy } from "../domain/model.js";

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  defaultWorkspaceTimezone: string;
  outputLanguagePolicy: OutputLanguagePolicy;
  publishingPolicy: MeetingPublishingPolicy;
};

export const defaultAppConfig: AppConfig = {
  nodeEnv: "development",
  defaultWorkspaceTimezone: "Europe/Berlin",
  outputLanguagePolicy: "meeting-majority",
  publishingPolicy: {
    publishMeetingNotes: true,
    publishCleanedTranscript: true,
    publishRawTranscript: false,
    publishTranslatedTranscript: false,
    transcriptPlacement: "attachment",
    defaultKnowledgeDestination: "notion",
    requireHumanApprovalBeforePublishing: true
  }
};
