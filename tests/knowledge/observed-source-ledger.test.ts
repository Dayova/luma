import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createObservedSourceLedger,
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
