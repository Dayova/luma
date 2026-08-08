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
  /**
   * A source-issued, one-use capability that exists only after it observed a
   * complete readable cursor sequence. It owns the observed-root manifest, so
   * a caller cannot substitute an arbitrary absence set.
   */
  completeScan?: MeetingNotesCompleteScan;
};

export type MeetingNotesScanPartialReason = {
  code:
    | "source-enumeration-incomplete"
    | "pagination-pending"
    | "unreadable-page"
    | "unreadable-meeting-note"
    | "source-record-incomplete";
  message: string;
  pageId?: string;
  sourceObjectId?: string;
  retryable: boolean;
};

export interface MeetingNotesCompleteScan {
  /** Appends replayable tombstones for roots absent from this exact scan. */
  reconcileAbsent(): Promise<ObservedSourceRevision[]>;
}

export interface MeetingNotesSource {
  scan(input: ScanMeetingNotesInput): Promise<MeetingNotesScan>;
}
