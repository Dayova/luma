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
    | "source-record-incomplete"
    /** A source-bound Luma execution is still settling this immutable root. */
    | "source-execution-fenced";
  message: string;
  pageId?: string;
  sourceObjectId?: string;
  retryable: boolean;
};

/**
 * A completed scan may discover a late source-execution fence while it is
 * reconciling roots absent from its manifest. It may still return safe
 * tombstones for other roots, but the overall scan has only partial coverage.
 */
export type MeetingNotesAbsentReconciliation = {
  tombstones: ObservedSourceRevision[];
  partialReasons: MeetingNotesScanPartialReason[];
};

export interface MeetingNotesCompleteScan {
  /** Appends replayable tombstones for roots absent from this exact scan. */
  reconcileAbsent(): Promise<MeetingNotesAbsentReconciliation>;
}

export interface MeetingNotesSource {
  scan(input: ScanMeetingNotesInput): Promise<MeetingNotesScan>;
}
