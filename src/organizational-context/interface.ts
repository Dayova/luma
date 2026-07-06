import type {
  ExternalReference,
  MeetingId,
  PersonId,
  WorkspaceId
} from "../domain/model.js";

export type ContextPermissionScope =
  | {
      type: "shared-meeting";
      participantIds: PersonId[];
    }
  | {
      type: "private-user";
      participantId: PersonId;
    };

export type OrganizationalContextRequest = {
  workspaceId: WorkspaceId;
  meetingId: MeetingId;
  purpose:
    | "understand-discussion"
    | "answer-question"
    | "detect-conflict"
    | "prepare-conclusion"
    | "prepare-follow-up";
  concepts: string[];
  participantIds: PersonId[];
  permissionScope: ContextPermissionScope;
  limit: number;
};

export type OrganizationalContextSource = {
  id: string;
  kind: "knowledge-document" | "work-item" | "code-change" | "previous-meeting-item";
  title: string;
  content: string;
  language: "de" | "en" | "mixed" | "unknown";
  updatedAt: string;
  externalReference: ExternalReference;
  access: {
    authorizedForCurrentRequest: boolean;
  };
};

export type OrganizationalContextBundle = {
  sources: OrganizationalContextSource[];
  retrieval: {
    complete: boolean;
    warnings: string[];
  };
};

export interface OrganizationalContext {
  retrieve(request: OrganizationalContextRequest): Promise<OrganizationalContextBundle>;
}
