import type { WorkspaceConfig } from "../domain/model.js";
import type { MeetingNotesIngestion } from "./meeting-notes-ingestion.js";
import type {
  MeetingNotesScan,
  MeetingNotesScanPartialReason,
  MeetingNotesSource
} from "./meeting-notes-source.js";

export type MeetingNotesSyncResult = {
  scannedRecords: number;
  /** Immutable removal revisions inferred only after a complete readable scan. */
  tombstonedRecords: number;
  ingestedRecords: number;
  unchangedRecords: number;
  deliveryFailures: Array<{
    sourceObjectId: string;
    message: string;
  }>;
  completeness: "complete" | "partial";
  partialReasons: MeetingNotesScanPartialReason[];
};

export type MeetingNotesSyncLogger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export type MeetingNotesSyncScheduler = (
  run: () => void,
  intervalMs: number
) => () => void;

export type CreateMeetingNotesSyncInput = {
  workspace: WorkspaceConfig;
  source: MeetingNotesSource;
  ingestion: MeetingNotesIngestion;
  intervalMs?: number;
  pageLimit?: number;
  logger?: MeetingNotesSyncLogger;
  scheduleRecurring?: MeetingNotesSyncScheduler;
};

export interface MeetingNotesSync {
  /** Drains the complete cursor sequence once, without overlapping another run. */
  syncOnce(): Promise<MeetingNotesSyncResult>;
  /** Starts an immediate best-effort run and schedules later runs. */
  start(): void;
  /** Cancels future runs and waits for an active one before persistence closes. */
  stop(): Promise<void>;
}

const DEFAULT_SYNC_INTERVAL_MS = 60_000;

const consoleLogger: MeetingNotesSyncLogger = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message)
};

const defaultScheduleRecurring: MeetingNotesSyncScheduler = (run, intervalMs) => {
  const timer = setInterval(run, intervalMs);
  return () => clearInterval(timer);
};

export function createMeetingNotesSync(
  input: CreateMeetingNotesSyncInput
): MeetingNotesSync {
  const intervalMs = input.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  const pageLimit = input.pageLimit;
  const logger = input.logger ?? consoleLogger;
  const scheduleRecurring = input.scheduleRecurring ?? defaultScheduleRecurring;
  let activeRun: Promise<MeetingNotesSyncResult> | null = null;
  let cancelSchedule: (() => void) | null = null;
  let stopped = false;

  const syncOnce = (): Promise<MeetingNotesSyncResult> => {
    if (activeRun) {
      return activeRun;
    }

    const run = drainSource(input, pageLimit, logger);
    activeRun = run.finally(() => {
      activeRun = null;
    });
    return activeRun;
  };

  const runScheduled = (): void => {
    if (stopped) {
      return;
    }

    void syncOnce().catch((error: unknown) => {
      logger.error(`Luma Meeting Notes sync failed: ${errorMessage(error)}`);
    });
  };

  return {
    syncOnce,
    start() {
      if (cancelSchedule) {
        return;
      }

      stopped = false;
      runScheduled();
      cancelSchedule = scheduleRecurring(runScheduled, intervalMs);
      logger.info(
        `Luma Meeting Notes sync started for workspace ${input.workspace.workspaceId}`
      );
    },
    async stop() {
      stopped = true;
      cancelSchedule?.();
      cancelSchedule = null;
      const active = activeRun;

      if (!active) {
        return;
      }

      try {
        await active;
      } catch (error) {
        // A failed source scan has already been made observable to the
        // scheduled runner. Shutdown still must release the Discord transport
        // and persistence rather than stranding the process behind the worker.
        logger.error(
          `Luma Meeting Notes sync stopped after failure: ${errorMessage(error)}`
        );
      }
    }
  };
}

async function drainSource(
  input: CreateMeetingNotesSyncInput,
  pageLimit: number | undefined,
  logger: MeetingNotesSyncLogger
): Promise<MeetingNotesSyncResult> {
  let cursor: string | undefined;
  const visitedCursors = new Set<string>();
  let completeScan: MeetingNotesScan["completeScan"];
  let scannedRecords = 0;
  let tombstonedRecords = 0;
  let ingestedRecords = 0;
  let unchangedRecords = 0;
  const deliveryFailures: MeetingNotesSyncResult["deliveryFailures"] = [];
  let completeness: MeetingNotesSyncResult["completeness"] = "complete";
  const partialReasons: MeetingNotesScanPartialReason[] = [];
  let fullyReadableScan = true;

  const deliver = async (record: MeetingNotesScan["records"][number]): Promise<void> => {
    if (record.change === "unchanged") {
      unchangedRecords += 1;
    }

    // The ledger is upstream of Meeting Intelligence. A process can crash
    // after recording a revision but before MI accepts it, so an unchanged
    // record is deliberately replayed; MI's immutable observation ID makes
    // an already-delivered revision a harmless duplicate.
    try {
      const update = await input.ingestion.ingest({
        workspace: input.workspace,
        source: record
      });

      if (update.errors.length > 0) {
        const message = update.errors
          .map((error) => ("message" in error ? error.message : error.code))
          .join("; ");
        deliveryFailures.push({
          sourceObjectId: record.source.sourceObjectId,
          message
        });
        completeness = "partial";
        logger.warn(
          `Luma Meeting Notes source ${record.source.sourceObjectId} was not accepted: ${message}`
        );
        return;
      }

      ingestedRecords += 1;
    } catch (error) {
      const message = errorMessage(error);
      deliveryFailures.push({
        sourceObjectId: record.source.sourceObjectId,
        message
      });
      completeness = "partial";
      logger.warn(
        `Luma Meeting Notes source ${record.source.sourceObjectId} could not be delivered: ${message}`
      );
    }
  };

  do {
    if (cursor) {
      if (visitedCursors.has(cursor)) {
        throw new Error("Meeting Notes source returned a repeated pagination cursor");
      }

      visitedCursors.add(cursor);
    }

    const page = await input.source.scan({
      workspaceId: input.workspace.workspaceId,
      ...(cursor ? { cursor } : {}),
      ...(pageLimit ? { limit: pageLimit } : {})
    });
    scannedRecords += page.records.length;

    const unresolvedPartialReasons = page.nextCursor
      ? page.partialReasons.filter((reason) => reason.code !== "pagination-pending")
      : page.partialReasons;
    const incompleteRecords = page.records.filter(
      (record) => record.snapshot.completeness.state !== "complete"
    );
    const sourceObjectIdsWithReportedIncompleteness = new Set(
      page.partialReasons.flatMap((reason) =>
        reason.code === "source-record-incomplete" && reason.sourceObjectId
          ? [reason.sourceObjectId]
          : []
      )
    );
    const incompleteRecordReasons: MeetingNotesScanPartialReason[] = incompleteRecords
      .filter(
        (record) =>
          !sourceObjectIdsWithReportedIncompleteness.has(record.source.sourceObjectId)
      )
      .map((record) => ({
        code: "source-record-incomplete",
        message:
          "A Meeting Notes source root was not fully readable; source absence cannot be inferred.",
        sourceObjectId: record.source.sourceObjectId,
        retryable: true
      }));
    const unexplainedPartialReasons: MeetingNotesScanPartialReason[] =
      page.completeness === "partial" &&
      page.partialReasons.length === 0 &&
      incompleteRecords.length === 0
        ? [
            {
              code: "source-enumeration-incomplete",
              message: "Meeting Notes source reported partial coverage without a reason.",
              retryable: true
            }
          ]
        : [];

    const pageIsNotFullyReadable =
      unresolvedPartialReasons.length > 0 ||
      incompleteRecords.length > 0 ||
      unexplainedPartialReasons.length > 0;

    if (pageIsNotFullyReadable) {
      completeness = "partial";
      fullyReadableScan = false;
      partialReasons.push(
        ...unresolvedPartialReasons,
        ...incompleteRecordReasons,
        ...unexplainedPartialReasons
      );
    }

    for (const record of page.records) {
      await deliver(record);
    }

    if (!page.nextCursor && page.completeScan) {
      completeScan = page.completeScan;
    }

    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  if (fullyReadableScan && completeScan) {
    const tombstones = await completeScan.reconcileAbsent();
    tombstonedRecords = tombstones.length;

    for (const tombstone of tombstones) {
      await deliver(tombstone);
    }
  }

  if (partialReasons.length > 0) {
    logger.warn(
      `Luma Meeting Notes sync completed partially: ${partialReasons
        .map((reason) => reason.code)
        .join(", ")}`
    );
  }

  return {
    scannedRecords,
    tombstonedRecords,
    ingestedRecords,
    unchangedRecords,
    deliveryFailures,
    completeness,
    partialReasons
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
