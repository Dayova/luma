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

/**
 * A bounded reread requested by an event signal. The provider Adapter must
 * re-establish that the page belongs to its canonical Meeting Notes source;
 * a caller cannot turn a webhook page ID into a workspace-wide read.
 */
export type RefreshMeetingNotePageInput = {
  workspaceId: string;
  pageId: string;
};

export type MeetingNotesPageRefresh = {
  /** The page was not an accessible canonical Meeting Note and yielded no Evidence. */
  status: "ignored" | "refreshed";
  records: ObservedSourceRevision[];
  completeness: "complete" | "partial";
  partialReasons: MeetingNotesScanPartialReason[];
};

/**
 * Provider-neutral wake-up capability. It owns canonical-source membership
 * validation and the observed-source ledger write; callers only provide the
 * opaque page reference carried by a signed provider signal.
 */
export interface MeetingNotesPageRefresher {
  refreshPage(input: RefreshMeetingNotePageInput): Promise<MeetingNotesPageRefresh>;
}
