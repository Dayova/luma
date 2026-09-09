import { describe, expect, it } from "vitest";
import type { WorkspaceConfig } from "../../src/domain/model.js";
import {
  createMeetingNotesSync,
  type MeetingNotesSyncLogger
} from "../../src/knowledge/meeting-notes-sync.js";
import type { MeetingNotesIngestion } from "../../src/knowledge/meeting-notes-ingestion.js";
import type { MeetingNotesSource } from "../../src/knowledge/meeting-notes-source.js";
import type { ObservedSourceRevision } from "../../src/knowledge/observed-source-ledger.js";

const workspace: WorkspaceConfig = {
  workspaceId: "workspace_dayova",
  timezone: "Europe/Berlin"
};

function sourceRevision(
  sourceObjectId: string,
  change: ObservedSourceRevision["change"]
): ObservedSourceRevision {
  return {
    change,
    source: {
      providerId: "notion",
      sourceKind: "meeting-note",
      sourceObjectId,
      parentObjectId: `page-${sourceObjectId}`,
      url: `https://notion.so/${sourceObjectId}`
    },
    revision: 1,
    contentHash: `sha256:${sourceObjectId}`,
    providerVersion: null,
    capturedAt: "2026-08-08T10:00:00.000Z",
    snapshot: {
      schemaVersion: 1,
      title: "Product sync",
      lifecycle: "ready",
      calendar: null,
      recording: null,
      sections: {
        summary: {
          state: "unavailable",
          sourceBlockId: null,
          reasons: []
        },
        actionItemsAndNotes: {
          state: "unavailable",
          sourceBlockId: null,
          reasons: []
        },
        transcript: {
          state: "unavailable",
          sourceBlockId: null,
          reasons: []
        }
      },
      markdown: {
        content: "",
        truncated: false,
        unknownBlockIds: []
      },
      completeness: { state: "complete" }
    }
  };
}

function tombstoneRevision(
  sourceObjectId: string,
  change: ObservedSourceRevision["change"]
): ObservedSourceRevision {
  const base = sourceRevision(sourceObjectId, change);

  return {
    ...base,
    snapshot: {
      ...base.snapshot,
      lifecycle: "removed",
      completeness: {
        state: "removed",
        message: "The root was absent from a complete scan."
      }
    }
  };
}

function incompleteSourceRevision(sourceObjectId: string): ObservedSourceRevision {
  const base = sourceRevision(sourceObjectId, "revised");

  return {
    ...base,
    snapshot: {
      ...base.snapshot,
      completeness: {
        state: "partial",
        reasons: [
          {
            code: "unreadable-section",
            message: "A source section was unreadable."
          }
        ]
      }
    }
  };
}

class RecordingIngestion implements MeetingNotesIngestion {
  readonly records: ObservedSourceRevision[] = [];

  ingest(input: { workspace: WorkspaceConfig; source: ObservedSourceRevision }) {
    expect(input.workspace).toEqual(workspace);
    this.records.push(input.source);
    return Promise.resolve({
      workspaceId: workspace.workspaceId,
      meetingId: `meeting:${input.source.source.sourceObjectId}`,
      revision: 1,
      acceptedObservationIds: [],
      duplicateObservationIds: [],
      analysisStatus: "not-needed" as const,
      interventions: [],
      events: [],
      errors: []
    });
  }
}

const quietLogger: MeetingNotesSyncLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

describe("Meeting Notes sync", () => {
  it("exposes content-free completion status for the canonical recovery owner", async () => {
    const sync = createMeetingNotesSync({
      workspace,
      source: {
        scan: () =>
          Promise.resolve({
            records: [],
            nextCursor: null,
            completeness: "complete" as const,
            partialReasons: []
          })
      },
      ingestion: new RecordingIngestion(),
      logger: quietLogger
    });

    expect(sync.status()).toEqual({
      active: false,
      scheduled: false,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastOutcome: null
    });

    await sync.syncOnce();

    const status = sync.status();
    expect(status.active).toBe(false);
    expect(status.scheduled).toBe(false);
    expect(typeof status.lastStartedAt).toBe("string");
    expect(typeof status.lastFinishedAt).toBe("string");
    expect(status.lastOutcome).toBe("complete");
  });

  it("drains every source cursor and replays unchanged records safely after ledger capture", async () => {
    const calls: Array<string | undefined> = [];
    const source: MeetingNotesSource = {
      scan: (input) => {
        calls.push(input.cursor);

        if (!input.cursor) {
          return Promise.resolve({
            records: [
              sourceRevision("note-new", "new"),
              sourceRevision("note-unchanged", "unchanged")
            ],
            nextCursor: "cursor-2",
            completeness: "partial" as const,
            partialReasons: [
              {
                code: "pagination-pending" as const,
                message: "One more page remains",
                retryable: false
              }
            ]
          });
        }

        return Promise.resolve({
          records: [sourceRevision("note-revised", "revised")],
          nextCursor: null,
          completeness: "complete" as const,
          partialReasons: []
        });
      }
    };
    const ingestion = new RecordingIngestion();
    const sync = createMeetingNotesSync({
      workspace,
      source,
      ingestion,
      logger: quietLogger
    });

    const result = await sync.syncOnce();

    expect(calls).toEqual([undefined, "cursor-2"]);
    expect(ingestion.records.map((record) => record.source.sourceObjectId)).toEqual([
      "note-new",
      "note-unchanged",
      "note-revised"
    ]);
    expect(result).toMatchObject({
      scannedRecords: 3,
      ingestedRecords: 3,
      unchangedRecords: 1,
      completeness: "complete",
      partialReasons: []
    });
  });

  it("reconciles absent roots only after a full readable scan and replays a tombstone after a crash", async () => {
    let reconciliationRuns = 0;
    const source: MeetingNotesSource = {
      scan: (input) =>
        Promise.resolve(
          input.cursor
            ? {
                records: [],
                nextCursor: null,
                completeness: "complete" as const,
                partialReasons: [],
                completeScan: {
                  reconcileAbsent: () => {
                    reconciliationRuns += 1;
                    return Promise.resolve({
                      tombstones: [
                        tombstoneRevision(
                          "absent-root",
                          reconciliationRuns === 1 ? "revised" : "unchanged"
                        )
                      ],
                      partialReasons: []
                    });
                  }
                }
              }
            : {
                records: [sourceRevision("still-present", "new")],
                nextCursor: "second-page",
                completeness: "partial" as const,
                partialReasons: [
                  {
                    code: "pagination-pending" as const,
                    message: "The final page is still pending.",
                    retryable: false
                  }
                ]
              }
        )
    };
    const ingestion = new RecordingIngestion();
    const sync = createMeetingNotesSync({
      workspace,
      source,
      ingestion,
      logger: quietLogger
    });

    const first = await sync.syncOnce();
    const second = await sync.syncOnce();

    expect(reconciliationRuns).toBe(2);
    expect(ingestion.records.map((record) => record.source.sourceObjectId)).toEqual([
      "still-present",
      "absent-root",
      "still-present",
      "absent-root"
    ]);
    expect(first).toMatchObject({
      scannedRecords: 1,
      tombstonedRecords: 1,
      ingestedRecords: 2,
      completeness: "complete"
    });
    expect(second).toMatchObject({
      scannedRecords: 1,
      tombstonedRecords: 1,
      unchangedRecords: 1,
      ingestedRecords: 2,
      completeness: "complete"
    });
  });

  it("never infers absence after a partial or unreadable source scan", async () => {
    let reconcileCalls = 0;
    const sync = createMeetingNotesSync({
      workspace,
      source: {
        scan: () =>
          Promise.resolve({
            records: [],
            nextCursor: null,
            completeness: "partial" as const,
            partialReasons: [
              {
                code: "unreadable-meeting-note" as const,
                message: "Notion denied access to a source root.",
                sourceObjectId: "might-still-exist",
                retryable: true
              }
            ],
            completeScan: {
              reconcileAbsent: () => {
                reconcileCalls += 1;
                return Promise.resolve({ tombstones: [], partialReasons: [] });
              }
            }
          })
      },
      ingestion: new RecordingIngestion(),
      logger: quietLogger
    });

    const result = await sync.syncOnce();

    expect(reconcileCalls).toBe(0);
    expect(result).toMatchObject({
      tombstonedRecords: 0,
      completeness: "partial",
      partialReasons: [expect.objectContaining({ code: "unreadable-meeting-note" })]
    });
  });

  it("reports partial coverage when a late execution fence blocks absence reconciliation", async () => {
    const sync = createMeetingNotesSync({
      workspace,
      source: {
        scan: () =>
          Promise.resolve({
            records: [],
            nextCursor: null,
            completeness: "complete" as const,
            partialReasons: [],
            completeScan: {
              reconcileAbsent: () =>
                Promise.resolve({
                  tombstones: [],
                  partialReasons: [
                    {
                      code: "source-execution-fenced" as const,
                      message:
                        "A source-bound Luma execution still owns the absent root.",
                      sourceObjectId: "fenced-absent-root",
                      retryable: true
                    }
                  ]
                })
            }
          })
      },
      ingestion: new RecordingIngestion(),
      logger: quietLogger
    });

    const result = await sync.syncOnce();

    expect(result).toMatchObject({
      tombstonedRecords: 0,
      completeness: "partial",
      partialReasons: [
        expect.objectContaining({
          code: "source-execution-fenced",
          sourceObjectId: "fenced-absent-root",
          retryable: true
        })
      ]
    });
  });

  it("reports unexplained partial coverage and never grants it absence authority", async () => {
    let reconcileCalls = 0;
    const sync = createMeetingNotesSync({
      workspace,
      source: {
        scan: () =>
          Promise.resolve({
            records: [],
            nextCursor: null,
            completeness: "partial" as const,
            partialReasons: [],
            completeScan: {
              reconcileAbsent: () => {
                reconcileCalls += 1;
                return Promise.resolve({ tombstones: [], partialReasons: [] });
              }
            }
          })
      },
      ingestion: new RecordingIngestion(),
      logger: quietLogger
    });

    const result = await sync.syncOnce();

    expect(reconcileCalls).toBe(0);
    expect(result.partialReasons).toEqual([
      expect.objectContaining({ code: "source-enumeration-incomplete" })
    ]);
  });

  it("does not reconcile absence when an earlier paginated page contains an incomplete source record", async () => {
    let reconcileCalls = 0;
    const sync = createMeetingNotesSync({
      workspace,
      source: {
        scan: (input) =>
          Promise.resolve(
            input.cursor
              ? {
                  records: [],
                  nextCursor: null,
                  completeness: "complete" as const,
                  partialReasons: [],
                  completeScan: {
                    reconcileAbsent: () => {
                      reconcileCalls += 1;
                      return Promise.resolve({ tombstones: [], partialReasons: [] });
                    }
                  }
                }
              : {
                  records: [incompleteSourceRevision("partially-readable-root")],
                  nextCursor: "final-page",
                  completeness: "partial" as const,
                  partialReasons: [
                    {
                      code: "pagination-pending" as const,
                      message: "A final page remains.",
                      retryable: false
                    },
                    {
                      code: "source-record-incomplete" as const,
                      message: "The source itself reported a partial root.",
                      sourceObjectId: "partially-readable-root",
                      retryable: true
                    }
                  ]
                }
          )
      },
      ingestion: new RecordingIngestion(),
      logger: quietLogger
    });

    const result = await sync.syncOnce();

    expect(reconcileCalls).toBe(0);
    expect(result).toMatchObject({
      completeness: "partial",
      tombstonedRecords: 0,
      partialReasons: [
        expect.objectContaining({
          code: "source-record-incomplete",
          sourceObjectId: "partially-readable-root"
        })
      ]
    });
    expect(
      result.partialReasons.filter((reason) => reason.code === "source-record-incomplete")
    ).toHaveLength(1);
  });

  it("coalesces overlapping runs and does not schedule work after stop", async () => {
    let releaseScan: () => void = () => {
      throw new Error("scan release is not ready");
    };
    let scanCalls = 0;
    let scheduled: () => void = () => {
      throw new Error("scheduled sync is not ready");
    };
    let cancelled = false;
    const scanReleased = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const source: MeetingNotesSource = {
      async scan() {
        scanCalls += 1;
        await scanReleased;
        return {
          records: [],
          nextCursor: null,
          completeness: "complete",
          partialReasons: []
        };
      }
    };
    const sync = createMeetingNotesSync({
      workspace,
      source,
      ingestion: new RecordingIngestion(),
      logger: quietLogger,
      scheduleRecurring: (run) => {
        scheduled = run;
        return () => {
          cancelled = true;
        };
      }
    });

    const first = sync.syncOnce();
    const second = sync.syncOnce();

    expect(second).toBe(first);
    expect(scanCalls).toBe(1);

    releaseScan();
    await first;

    sync.start();
    await Promise.resolve();
    expect(scanCalls).toBe(2);

    releaseScan();
    await sync.stop();
    expect(cancelled).toBe(true);

    scheduled();
    await Promise.resolve();
    expect(scanCalls).toBe(2);
  });

  it("continues past a rejected delivery and replays that immutable ledger revision later", async () => {
    let attempts = 0;
    const source: MeetingNotesSource = {
      scan: () =>
        Promise.resolve({
          records: [sourceRevision("retryable-note", "unchanged")],
          nextCursor: null,
          completeness: "complete" as const,
          partialReasons: []
        })
    };
    const ingestion: MeetingNotesIngestion = {
      ingest: (input) => {
        attempts += 1;
        return Promise.resolve({
          workspaceId: input.workspace.workspaceId,
          meetingId: "meeting:retryable-note",
          revision: 1,
          acceptedObservationIds: attempts === 1 ? [] : ["source-observation"],
          duplicateObservationIds: [],
          analysisStatus: "not-needed",
          interventions: [],
          events: [],
          errors:
            attempts === 1
              ? [
                  {
                    code: "invalid-observation" as const,
                    observationId: "source-observation",
                    message: "ledger verifier unavailable",
                    retryable: false
                  }
                ]
              : []
        });
      }
    };
    const sync = createMeetingNotesSync({
      workspace,
      source,
      ingestion,
      logger: quietLogger
    });

    const first = await sync.syncOnce();
    const second = await sync.syncOnce();

    expect(first).toMatchObject({
      ingestedRecords: 0,
      unchangedRecords: 1,
      completeness: "partial",
      deliveryFailures: [expect.objectContaining({ sourceObjectId: "retryable-note" })]
    });
    expect(second).toMatchObject({
      ingestedRecords: 1,
      unchangedRecords: 1,
      completeness: "complete",
      deliveryFailures: []
    });
    expect(attempts).toBe(2);
  });

  it("does not block application shutdown when an active source scan fails", async () => {
    let scheduled: () => void = () => {
      throw new Error("scheduled sync is not ready");
    };
    const errors: string[] = [];
    const sync = createMeetingNotesSync({
      workspace,
      source: {
        scan: () => Promise.reject(new Error("Notion is unavailable"))
      },
      ingestion: new RecordingIngestion(),
      logger: {
        ...quietLogger,
        error: (message) => errors.push(message)
      },
      scheduleRecurring: (run) => {
        scheduled = run;
        return () => undefined;
      }
    });

    sync.start();
    await Promise.resolve();
    await sync.stop();

    expect(errors).toEqual(
      expect.arrayContaining([expect.stringContaining("Notion is unavailable")])
    );
    scheduled();
    await Promise.resolve();
  });
});
