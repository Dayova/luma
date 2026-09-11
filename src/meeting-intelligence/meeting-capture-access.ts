import type { ExternalReference } from "../domain/model.js";
import type {
  LogicalMeetings,
  MeetingCaptureMaterial,
  LogicalMeetingCaptureRef
} from "../logical-meetings/interface.js";
import type { ContextAudience } from "../organizational-context/interface.js";

export type CurrentMeetingCaptureMaterial = {
  descriptor: MeetingCaptureMaterial;
  text: string;
};

/** Owned capability: verifies original and current recipients, exact archive bytes and live source. */
export interface MeetingCaptureAccess {
  readCurrent(input: {
    workspaceId: string;
    capture: LogicalMeetingCaptureRef;
    audience: ContextAudience;
  }): Promise<{
    /** Stable across content revisions, changes when the consenting account/connection grant changes. */
    authorizationScopeId: string;
    materials: CurrentMeetingCaptureMaterial[];
    /** A provider-attested existing canonical meeting page, never inferred from its URL. */
    canonicalAnchorRef: ExternalReference | null;
  }>;
}

export type CaptureSynthesisConfiguration = {
  logicalMeetings: Pick<LogicalMeetings, "get">;
  access: MeetingCaptureAccess;
  audience(workspaceId: string): Promise<ContextAudience | null>;
};
