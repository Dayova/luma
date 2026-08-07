import type { ObservedSourceRevision } from "./observed-source-ledger.js";

export type ScanMeetingNotesInput = {
  workspaceId: string;
  cursor?: string;
  limit?: number;
};

export type MeetingNotesScan = {
  records: ObservedSourceRevision[];
  nextCursor: string | null;
  completeness: "complete" | "partial";
  partialReasons: MeetingNotesScanPartialReason[];
};

export type MeetingNotesScanPartialReason = {
  code:
    | "source-enumeration-incomplete"
    | "pagination-pending"
    | "unreadable-page"
    | "unreadable-meeting-note";
  message: string;
  pageId?: string;
  sourceObjectId?: string;
  retryable: boolean;
};

export interface MeetingNotesSource {
  scan(input: ScanMeetingNotesInput): Promise<MeetingNotesScan>;
}
