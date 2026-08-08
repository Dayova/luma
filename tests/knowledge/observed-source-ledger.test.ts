import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createObservedSourceLedger,
  ObservedSourceExecutionFenceConflictError,
  type RawMeetingNoteSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";

function snapshot(transcript: string): RawMeetingNoteSnapshot {
  return {
    schemaVersion: 1,
    title: "Team Sync",
    lifecycle: "ready",
    calendar: {
      startAt: "2026-08-07T08:00:00.000Z",
      endAt: "2026-08-07T08:30:00.000Z",
      attendeeProviderUserIds: ["notion-user-jakob"]
    },
    recording: null,
    sections: {
      summary: {
        state: "available",
        sourceBlockId: "summary-block",
        text: "We will ship the reconciliation proof.",
        blocks: []
      },
      actionItemsAndNotes: {
        state: "available",
        sourceBlockId: "notes-block",
        text: "- [ ] Prove the Notion source",
        blocks: []
      },
      transcript: {
        state: "available",
        sourceBlockId: "transcript-block",
        text: transcript,
        blocks: []
      }
    },
    markdown: {
      content: `# Team Sync\n\n${transcript}`,
      truncated: false,
      unknownBlockIds: []
    },
    completeness: { state: "complete" }
  };
}

describe("Observed source ledger", () => {
  it("keeps a stable source revision when only provider edit metadata changes", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const source = {
      providerId: "notion",
      sourceKind: "meeting-note" as const,
      sourceObjectId: "meeting-notes-block-1",
      parentObjectId: "notion-page-1",
      url: "https://notion.so/notion-page-1"
    };

    try {
      const first = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: "2026-08-07T08:35:00.000Z",
        snapshot: snapshot("Wir prüfen die Quelle before we create work."),
        observedAt: "2026-08-07T08:36:00.000Z"
      });
      const second = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: "2026-08-07T08:37:00.000Z",
        snapshot: snapshot("Wir prüfen die Quelle before we create work."),
        observedAt: "2026-08-07T08:38:00.000Z"
      });

      expect(first).toMatchObject({
        change: "new",
        revision: 1,
        snapshot: snapshot("Wir prüfen die Quelle before we create work.")
      });
      expect(second).toMatchObject({
        change: "unchanged",
        revision: 1,
        contentHash: first.contentHash
      });
      expect(second.contentHash).toMatch(/^sha256:/);
    } finally {
      await database.close();
    }
  });

  it("replays the immutable source identity when URL metadata changes without content", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const originalSource = {
      providerId: "notion",
      sourceKind: "meeting-note" as const,
      sourceObjectId: "meeting-notes-block-identity",
      parentObjectId: "notion-page-original",
      url: "https://notion.so/notion-page-original"
    };

    try {
      const first = await ledger.record({
        workspaceId: "workspace_dayova",
        source: originalSource,
        providerVersion: "2026-08-07T08:35:00.000Z",
        snapshot: snapshot("The source body is unchanged."),
        observedAt: "2026-08-07T08:36:00.000Z"
      });
      const replayed = await ledger.record({
        workspaceId: "workspace_dayova",
        source: {
          ...originalSource,
          url: "https://notion.so/notion-page-original?view=updated"
        },
        providerVersion: "2026-08-07T08:37:00.000Z",
        snapshot: snapshot("The source body is unchanged."),
        observedAt: "2026-08-07T08:38:00.000Z"
      });

      expect(replayed).toMatchObject({
        change: "unchanged",
        revision: first.revision,
        contentHash: first.contentHash,
        source: originalSource
      });
    } finally {
      await database.close();
    }
  });

  it("mints a new immutable revision when an unchanged source root moves to another parent page", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const originalSource = {
      providerId: "notion",
      sourceKind: "meeting-note" as const,
      sourceObjectId: "meeting-notes-block-parent-move",
      parentObjectId: "notion-page-a",
      url: "https://notion.so/notion-page-a"
    };
    const movedSource = {
      ...originalSource,
      parentObjectId: "notion-page-b",
      url: "https://notion.so/notion-page-b"
    };

    try {
      const first = await ledger.record({
        workspaceId: "workspace_dayova",
        source: originalSource,
        providerVersion: "2026-08-07T08:35:00.000Z",
        snapshot: snapshot("The source body is unchanged across a page move."),
        observedAt: "2026-08-07T08:36:00.000Z"
      });
      const moved = await ledger.record({
        workspaceId: "workspace_dayova",
        source: movedSource,
        providerVersion: "2026-08-07T08:37:00.000Z",
        snapshot: snapshot("The source body is unchanged across a page move."),
        observedAt: "2026-08-07T08:38:00.000Z"
      });

      expect(moved).toMatchObject({
        change: "revised",
        revision: first.revision + 1,
        contentHash: first.contentHash,
        source: movedSource
      });
      await expect(
        ledger.get({ workspaceId: "workspace_dayova", source: originalSource })
      ).resolves.toMatchObject({
        revision: moved.revision,
        contentHash: first.contentHash,
        source: movedSource
      });
      await expect(
        ledger.get({
          workspaceId: "workspace_dayova",
          source: originalSource,
          revision: first.revision
        })
      ).resolves.toMatchObject({ source: originalSource });
    } finally {
      await database.close();
    }
  });

  it("repairs a legacy mutable parent move as a new immutable revision", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const originalSource = {
      providerId: "notion",
      sourceKind: "meeting-note" as const,
      sourceObjectId: "meeting-notes-block-legacy-parent-move",
      parentObjectId: "notion-page-a",
      url: "https://notion.so/notion-page-a"
    };
    const movedSource = {
      ...originalSource,
      parentObjectId: "notion-page-b",
      url: "https://notion.so/notion-page-b"
    };
    const unchangedSnapshot = snapshot("A legacy source body that did not change.");

    try {
      const first = await ledger.record({
        workspaceId: "workspace_dayova",
        source: originalSource,
        providerVersion: null,
        snapshot: unchangedSnapshot,
        observedAt: "2026-08-07T08:36:00.000Z"
      });

      // Prior ledger versions refreshed this mutable head metadata without
      // minting a revision. Model that persisted state to prove the next scan
      // repairs its immutable Operational Outcome target binding.
      await database.query(
        `UPDATE observed_sources
            SET parent_object_id = $5,
                source_reference_json = $6
          WHERE workspace_id = $1
            AND provider_id = $2
            AND source_kind = $3
            AND source_object_id = $4`,
        [
          "workspace_dayova",
          originalSource.providerId,
          originalSource.sourceKind,
          originalSource.sourceObjectId,
          movedSource.parentObjectId,
          JSON.stringify(movedSource)
        ]
      );

      const repaired = await ledger.record({
        workspaceId: "workspace_dayova",
        source: movedSource,
        providerVersion: null,
        snapshot: unchangedSnapshot,
        observedAt: "2026-08-07T08:38:00.000Z"
      });

      expect(repaired).toMatchObject({
        change: "revised",
        revision: first.revision + 1,
        contentHash: first.contentHash,
        source: movedSource
      });
    } finally {
      await database.close();
    }
  });

  it("keeps chronological revisions when source content changes and later reverts", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const source = {
      providerId: "notion",
      sourceKind: "meeting-note" as const,
      sourceObjectId: "meeting-notes-block-1",
      parentObjectId: "notion-page-1",
      url: "https://notion.so/notion-page-1"
    };

    try {
      const first = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: null,
        snapshot: snapshot("Original transcript."),
        observedAt: "2026-08-07T08:36:00.000Z"
      });
      const revised = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: null,
        snapshot: snapshot("Corrected transcript."),
        observedAt: "2026-08-07T08:37:00.000Z"
      });
      const reverted = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: null,
        snapshot: snapshot("Original transcript."),
        observedAt: "2026-08-07T08:38:00.000Z"
      });

      expect([first.change, revised.change, reverted.change]).toEqual([
        "new",
        "revised",
        "revised"
      ]);
      expect([first.revision, revised.revision, reverted.revision]).toEqual([1, 2, 3]);
      expect(reverted.contentHash).toBe(first.contentHash);
    } finally {
      await database.close();
    }
  });

  it("retrieves an immutable snapshot after the durable database is reopened", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "luma-observed-source-"));
    const dataDir = join(temporaryRoot, "pglite");
    const source = {
      providerId: "notion",
      sourceKind: "meeting-note" as const,
      sourceObjectId: "meeting-notes-block-1",
      parentObjectId: "notion-page-1",
      url: "https://notion.so/notion-page-1"
    };

    try {
      const firstDatabase = await createPgliteDatabase(dataDir);
      const firstLedger = createObservedSourceLedger({ database: firstDatabase });
      const recorded = await firstLedger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: "2026-08-07T08:35:00.000Z",
        snapshot: snapshot("Die Evidence bleibt original."),
        observedAt: "2026-08-07T08:36:00.000Z"
      });
      await firstDatabase.close();

      const reopenedDatabase = await createPgliteDatabase(dataDir);
      const reopenedLedger = createObservedSourceLedger({ database: reopenedDatabase });

      try {
        await expect(
          reopenedLedger.get({
            workspaceId: "workspace_dayova",
            source,
            revision: recorded.revision
          })
        ).resolves.toMatchObject({
          revision: 1,
          contentHash: recorded.contentHash,
          snapshot: snapshot("Die Evidence bleibt original.")
        });
      } finally {
        await reopenedDatabase.close();
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it("serializes concurrent retries into one new revision and unchanged rereads", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const source = {
      providerId: "notion",
      sourceKind: "meeting-note" as const,
      sourceObjectId: "meeting-notes-block-1",
      parentObjectId: "notion-page-1",
      url: "https://notion.so/notion-page-1"
    };

    try {
      const results = await Promise.all(
        [
          "2026-08-07T08:36:00.000Z",
          "2026-08-07T08:37:00.000Z",
          "2026-08-07T08:38:00.000Z"
        ].map((observedAt) =>
          ledger.record({
            workspaceId: "workspace_dayova",
            source,
            providerVersion: null,
            snapshot: snapshot("One canonical source state."),
            observedAt
          })
        )
      );

      expect(results.map((result) => result.revision)).toEqual([1, 1, 1]);
      expect(results.filter((result) => result.change === "new")).toHaveLength(1);
      expect(results.filter((result) => result.change === "unchanged")).toHaveLength(2);
    } finally {
      await database.close();
    }
  });

  it("blocks source revisions and tombstones behind an active execution fence, then permits a later revision after release", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const source = {
      providerId: "notion",
      sourceKind: "meeting-note" as const,
      sourceObjectId: "meeting-notes-block-fenced",
      parentObjectId: "notion-page-fenced",
      url: "https://notion.so/notion-page-fenced"
    };
    const owner = {
      meetingId: "meeting-fenced",
      intentId: "settlement-fenced",
      executionLeaseId: "lease-fenced"
    };

    try {
      const recorded = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: "2026-08-07T08:35:00.000Z",
        snapshot: snapshot("The approved source must not move during settlement."),
        observedAt: "2026-08-07T08:36:00.000Z"
      });
      const [head] = await ledger.listCurrent({
        workspaceId: "workspace_dayova",
        providerId: source.providerId,
        sourceKind: source.sourceKind
      });

      if (!head) {
        throw new Error("expected a source head before fencing");
      }

      await expect(
        ledger.acquireExecutionFence({
          workspaceId: "workspace_dayova",
          source,
          expected: {
            revision: recorded.revision,
            contentHash: recorded.contentHash
          },
          owner,
          now: new Date("2026-08-07T08:37:00.000Z")
        })
      ).resolves.toEqual({ status: "acquired" });
      await expect(
        ledger.acquireExecutionFence({
          workspaceId: "workspace_dayova",
          source,
          expected: {
            revision: recorded.revision,
            contentHash: recorded.contentHash
          },
          owner: { ...owner, executionLeaseId: "lease-competing" },
          now: new Date("2026-08-07T08:37:30.000Z")
        })
      ).resolves.toEqual({ status: "busy", owner });

      await expect(
        ledger.record({
          workspaceId: "workspace_dayova",
          source,
          providerVersion: "2026-08-07T08:38:00.000Z",
          snapshot: snapshot("A concurrent scan saw a newer transcript."),
          observedAt: "2026-08-07T08:38:00.000Z"
        })
      ).rejects.toBeInstanceOf(ObservedSourceExecutionFenceConflictError);
      await expect(
        ledger.recordTombstone({
          workspaceId: "workspace_dayova",
          previous: head,
          observedAt: "2026-08-07T08:39:00.000Z"
        })
      ).rejects.toBeInstanceOf(ObservedSourceExecutionFenceConflictError);
      await expect(
        ledger.get({ workspaceId: "workspace_dayova", source })
      ).resolves.toMatchObject({
        revision: recorded.revision,
        contentHash: recorded.contentHash
      });

      await ledger.releaseExecutionFence({
        workspaceId: "workspace_dayova",
        source,
        owner
      });

      const resumed = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: "2026-08-07T08:40:00.000Z",
        snapshot: snapshot("The settlement receipt is canonical; scanning can resume."),
        observedAt: "2026-08-07T08:40:00.000Z"
      });

      expect(resumed).toMatchObject({ change: "revised", revision: 2 });
      await expect(
        ledger.acquireExecutionFence({
          workspaceId: "workspace_dayova",
          source,
          expected: {
            revision: recorded.revision,
            contentHash: recorded.contentHash
          },
          owner: { ...owner, executionLeaseId: "lease-stale" },
          now: new Date("2026-08-07T08:41:00.000Z")
        })
      ).resolves.toEqual({
        status: "superseded",
        current: { revision: resumed.revision, contentHash: resumed.contentHash }
      });
    } finally {
      await database.close();
    }
  });

  it("durably invalidates the exact held fence when a complete scan observes its source root removed", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const source = {
      providerId: "notion",
      sourceKind: "meeting-note" as const,
      sourceObjectId: "meeting-notes-block-fenced-removal",
      parentObjectId: "notion-page-fenced-removal",
      url: "https://notion.so/notion-page-fenced-removal"
    };
    const owner = {
      meetingId: "meeting-fenced-removal",
      intentId: "settlement-fenced-removal",
      executionLeaseId: "lease-fenced-removal"
    };

    try {
      const recorded = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: null,
        snapshot: snapshot("The root will disappear during settlement."),
        observedAt: "2026-08-07T08:36:00.000Z"
      });
      const [head] = await ledger.listCurrent({
        workspaceId: "workspace_dayova",
        providerId: source.providerId,
        sourceKind: source.sourceKind
      });

      if (!head) {
        throw new Error("expected a source head before fencing");
      }

      await ledger.acquireExecutionFence({
        workspaceId: "workspace_dayova",
        source,
        expected: {
          revision: recorded.revision,
          contentHash: recorded.contentHash
        },
        owner,
        now: new Date("2026-08-07T08:37:00.000Z")
      });
      await expect(
        ledger.recordTombstone({
          workspaceId: "workspace_dayova",
          previous: head,
          observedAt: "2026-08-07T08:38:00.000Z"
        })
      ).rejects.toBeInstanceOf(ObservedSourceExecutionFenceConflictError);

      await expect(
        ledger.verifyExecutionFenceHeldCurrent({
          workspaceId: "workspace_dayova",
          source,
          expected: {
            revision: recorded.revision,
            contentHash: recorded.contentHash
          },
          owner
        })
      ).resolves.toEqual({
        status: "superseded",
        supersession: {
          kind: "removed",
          observedAt: "2026-08-07T08:38:00.000Z"
        }
      });
      await expect(
        ledger.get({ workspaceId: "workspace_dayova", source })
      ).resolves.toMatchObject({
        revision: recorded.revision,
        contentHash: recorded.contentHash,
        snapshot: { lifecycle: "ready" }
      });
    } finally {
      await database.close();
    }
  });

  it("records a CAS-protected immutable tombstone and replays it without erasing history", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const source = {
      providerId: "notion",
      sourceKind: "meeting-note" as const,
      sourceObjectId: "meeting-notes-block-removed",
      parentObjectId: "notion-page-removed",
      url: "https://notion.so/notion-page-removed"
    };

    try {
      const first = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: "2026-08-07T08:35:00.000Z",
        snapshot: snapshot("This Action Item must not outlive its source."),
        observedAt: "2026-08-07T08:36:00.000Z"
      });
      const [initialHead] = await ledger.listCurrent({
        workspaceId: "workspace_dayova",
        providerId: "notion",
        sourceKind: "meeting-note"
      });

      if (!initialHead) {
        throw new Error("expected the source head");
      }

      // A rediscovery with identical bytes must still invalidate an earlier
      // absence conclusion. Revision/hash alone cannot distinguish it.
      const unchangedRediscovery = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: "2026-08-07T08:50:00.000Z",
        snapshot: snapshot("This Action Item must not outlive its source."),
        observedAt: "2026-08-07T08:50:00.000Z"
      });

      expect(unchangedRediscovery).toMatchObject({
        change: "unchanged",
        revision: first.revision,
        contentHash: first.contentHash
      });
      await expect(
        ledger.recordTombstone({
          workspaceId: "workspace_dayova",
          previous: initialHead,
          observedAt: "2026-08-07T09:00:00.000Z"
        })
      ).resolves.toBeNull();

      const [currentHead] = await ledger.listCurrent({
        workspaceId: "workspace_dayova",
        providerId: "notion",
        sourceKind: "meeting-note"
      });

      if (!currentHead) {
        throw new Error("expected the rediscovered source head");
      }

      const removed = await ledger.recordTombstone({
        workspaceId: "workspace_dayova",
        previous: currentHead,
        observedAt: "2026-08-07T09:00:00.000Z"
      });

      expect(removed).toMatchObject({
        change: "revised",
        revision: 2,
        providerVersion: null,
        snapshot: {
          title: null,
          lifecycle: "removed",
          calendar: null,
          recording: null,
          sections: {
            actionItemsAndNotes: { state: "unavailable" }
          },
          completeness: { state: "removed" }
        }
      });
      await expect(
        ledger.get({ workspaceId: "workspace_dayova", source, revision: first.revision })
      ).resolves.toMatchObject({
        snapshot: snapshot("This Action Item must not outlive its source.")
      });

      const [removedHead] = await ledger.listCurrent({
        workspaceId: "workspace_dayova",
        providerId: "notion",
        sourceKind: "meeting-note"
      });

      if (!removed || !removedHead) {
        throw new Error("expected a tombstone revision");
      }

      await expect(
        ledger.recordTombstone({
          workspaceId: "workspace_dayova",
          previous: removedHead,
          observedAt: "2026-08-07T09:01:00.000Z"
        })
      ).resolves.toMatchObject({ change: "unchanged", revision: 2 });

      const [replayedTombstoneHead] = await ledger.listCurrent({
        workspaceId: "workspace_dayova",
        providerId: "notion",
        sourceKind: "meeting-note"
      });

      expect(replayedTombstoneHead?.observationGeneration).toBe(
        removedHead.observationGeneration
      );

      const rediscovered = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: "2026-08-07T09:05:00.000Z",
        snapshot: snapshot("The source root returned."),
        observedAt: "2026-08-07T09:05:00.000Z"
      });

      await expect(
        ledger.recordTombstone({
          workspaceId: "workspace_dayova",
          previous: initialHead,
          observedAt: "2026-08-07T09:06:00.000Z"
        })
      ).resolves.toBeNull();
      expect(rediscovered.revision).toBe(3);
    } finally {
      await database.close();
    }
  });

  it("rejects a non-positive revision lookup instead of returning the current snapshot", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const source = {
      providerId: "notion",
      sourceKind: "meeting-note" as const,
      sourceObjectId: "meeting-notes-block-1",
      parentObjectId: "notion-page-1",
      url: "https://notion.so/notion-page-1"
    };

    try {
      await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: null,
        snapshot: snapshot("One canonical source state."),
        observedAt: "2026-08-07T08:36:00.000Z"
      });

      await expect(
        ledger.get({ workspaceId: "workspace_dayova", source, revision: 0 })
      ).rejects.toThrow("positive integer");
    } finally {
      await database.close();
    }
  });
});
