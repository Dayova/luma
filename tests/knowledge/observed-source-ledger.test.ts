import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createObservedSourceLedger,
  ObservedSourceExecutionFenceConflictError,
  releaseObservedSourceExecutionFencesForExecution,
  releaseObservedSourceExecutionFencesForSettlement,
  type ObservedSourceExecutionFenceSource,
  type ObservedSourceHead,
  type ObservedSourceIdentity,
  type RecordObservedSourceTombstoneInput,
  type RawConversationSnapshot,
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

function conversationSnapshot(
  input: {
    conversationObjectId?: string;
    firstText?: string;
    secondState?: "available" | "deleted";
    reverseOrder?: boolean;
  } = {}
): RawConversationSnapshot {
  const first = {
    id: "message-1",
    ordinal: 0,
    author: {
      providerUserId: "discord-user-jakob",
      displayName: "Jakob",
      personId: "person-jakob"
    },
    createdAt: "2026-08-08T09:00:00.000Z",
    editedAt: null,
    replyToMessageId: null,
    url: "https://discord.com/channels/guild-1/thread-1/message-1",
    state: "available" as const,
    text: input.firstText ?? "Wir behalten die Evidence."
  };
  const second =
    input.secondState === "deleted"
      ? {
          id: "message-2",
          ordinal: 1,
          author: {
            providerUserId: "discord-user-fabius",
            displayName: "Fabius",
            personId: "person-fabius"
          },
          createdAt: "2026-08-08T09:01:00.000Z",
          editedAt: "2026-08-08T09:02:00.000Z",
          replyToMessageId: "message-1",
          url: "https://discord.com/channels/guild-1/thread-1/message-2",
          state: "deleted" as const,
          text: null
        }
      : {
          id: "message-2",
          ordinal: 1,
          author: {
            providerUserId: "discord-user-fabius",
            displayName: "Fabius",
            personId: "person-fabius"
          },
          createdAt: "2026-08-08T09:01:00.000Z",
          editedAt: null,
          replyToMessageId: "message-1",
          url: "https://discord.com/channels/guild-1/thread-1/message-2",
          state: "available" as const,
          text: "We might ship after review."
        };
  const messages = (input.reverseOrder ? [second, first] : [first, second]).map(
    (message, ordinal) => ({ ...message, ordinal })
  );
  const firstMessage = messages[0];
  const lastMessage = messages.at(-1);

  if (!firstMessage || !lastMessage) {
    throw new Error("expected a bounded conversation snapshot");
  }

  return {
    schemaVersion: 1,
    conversation: {
      conversationObjectId: input.conversationObjectId ?? "thread-1",
      parentConversationObjectId: "channel-1",
      title: "Luma evidence review",
      url: "https://discord.com/channels/guild-1/thread-1"
    },
    boundary: {
      mode: "thread",
      anchorMessageId: "message-1",
      firstMessageId: firstMessage.id,
      lastMessageId: lastMessage.id,
      messageIds: messages.map((message) => message.id)
    },
    messages,
    completeness: { state: "complete" }
  };
}

function conversationSource(parentObjectId = "thread-1") {
  return {
    providerId: "discord",
    sourceKind: "conversation" as const,
    sourceObjectId: "message-1",
    parentObjectId,
    url: `https://discord.com/channels/guild-1/${parentObjectId}/message-1`
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

  it("records bounded conversation evidence as immutable revisions and lists its current head", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const source = conversationSource();
    const firstSnapshot = conversationSnapshot();

    try {
      const first = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: "2026-08-08T09:03:00.000Z",
        snapshot: firstSnapshot,
        observedAt: "2026-08-08T09:03:30.000Z"
      });
      const reread = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: "2026-08-08T09:04:00.000Z",
        snapshot: firstSnapshot,
        observedAt: "2026-08-08T09:04:30.000Z"
      });
      const edited = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: "2026-08-08T09:05:00.000Z",
        snapshot: conversationSnapshot({
          firstText: "Wir behalten die unveränderte Evidence."
        }),
        observedAt: "2026-08-08T09:05:30.000Z"
      });
      const deleted = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: "2026-08-08T09:06:00.000Z",
        snapshot: conversationSnapshot({ secondState: "deleted" }),
        observedAt: "2026-08-08T09:06:30.000Z"
      });
      const reordered = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: "2026-08-08T09:07:00.000Z",
        snapshot: conversationSnapshot({ reverseOrder: true }),
        observedAt: "2026-08-08T09:07:30.000Z"
      });

      expect(first).toMatchObject({
        change: "new",
        revision: 1,
        source,
        snapshot: firstSnapshot
      });
      expect(reread).toMatchObject({
        change: "unchanged",
        revision: first.revision,
        contentHash: first.contentHash,
        source
      });
      expect(edited).toMatchObject({ change: "revised", revision: 2 });
      expect(deleted).toMatchObject({
        change: "revised",
        revision: 3,
        snapshot: {
          messages: [
            expect.objectContaining({ id: "message-1", state: "available" }),
            expect.objectContaining({ id: "message-2", state: "deleted", text: null })
          ]
        }
      });
      expect(reordered).toMatchObject({
        change: "revised",
        revision: 4,
        snapshot: {
          boundary: {
            firstMessageId: "message-2",
            lastMessageId: "message-1",
            messageIds: ["message-2", "message-1"]
          }
        }
      });

      await expect(
        ledger.get({
          workspaceId: "workspace_dayova",
          source,
          revision: first.revision
        })
      ).resolves.toMatchObject({
        source,
        revision: first.revision,
        snapshot: firstSnapshot
      });

      await expect(
        ledger.listCurrent({
          workspaceId: "workspace_dayova",
          providerId: "discord",
          sourceKind: "conversation"
        })
      ).resolves.toMatchObject([
        {
          source,
          revision: reordered.revision,
          snapshot: reordered.snapshot,
          observationGeneration: 5
        }
      ]);
    } finally {
      await database.close();
    }
  });

  it("mints a conversation revision when its anchor moves to another conversation", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const originalSource = conversationSource("thread-a");
    const movedSource = conversationSource("thread-b");

    try {
      const first = await ledger.record({
        workspaceId: "workspace_dayova",
        source: originalSource,
        providerVersion: null,
        snapshot: conversationSnapshot({ conversationObjectId: "thread-a" }),
        observedAt: "2026-08-08T09:00:00.000Z"
      });
      const moved = await ledger.record({
        workspaceId: "workspace_dayova",
        source: movedSource,
        providerVersion: null,
        snapshot: conversationSnapshot({ conversationObjectId: "thread-b" }),
        observedAt: "2026-08-08T09:01:00.000Z"
      });

      expect(moved).toMatchObject({
        change: "revised",
        revision: first.revision + 1,
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

  it("replays a conversation with omitted optional metadata under the same canonical hash", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const source = conversationSource();
    const captured = conversationSnapshot();
    const firstMessage = captured.messages[0];

    if (!firstMessage) {
      throw new Error("expected a captured conversation message");
    }

    // Provider adapters commonly represent an unmapped identity as undefined;
    // JSON persistence omits it. Its replay must still verify the same hash.
    delete firstMessage.author.personId;

    try {
      const recorded = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: null,
        snapshot: captured,
        observedAt: "2026-08-08T09:00:00.000Z"
      });

      const replayed = await ledger.get({
        workspaceId: "workspace_dayova",
        source,
        revision: recorded.revision
      });
      const replayedFirstMessage = replayed?.snapshot.messages[0];

      if (!replayedFirstMessage) {
        throw new Error("expected the persisted conversation message");
      }

      expect(replayed.contentHash).toBe(recorded.contentHash);
      expect(replayedFirstMessage.author).not.toHaveProperty("personId");
    } finally {
      await database.close();
    }
  });

  it("replays JSON-normalized sparse meeting-note metadata under the same canonical hash", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const source = {
      providerId: "notion",
      sourceKind: "meeting-note" as const,
      sourceObjectId: "meeting-notes-block-1",
      parentObjectId: "notion-page-1",
      url: "https://notion.so/notion-page-1"
    };
    const captured = snapshot("Sparse metadata remains durable.");

    // JSON.stringify preserves a sparse array position as null. The canonical
    // hash must use that same representation even for legacy meeting snapshots.
    captured.markdown.unknownBlockIds = new Array<string>(1);

    try {
      const recorded = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: null,
        snapshot: captured,
        observedAt: "2026-08-08T09:00:00.000Z"
      });
      const replayed = await ledger.get({
        workspaceId: "workspace_dayova",
        source,
        revision: recorded.revision
      });

      expect(replayed?.contentHash).toBe(recorded.contentHash);
      expect(replayed?.snapshot.markdown.unknownBlockIds).toEqual([null]);
    } finally {
      await database.close();
    }
  });

  it("rejects malformed conversation records and fails closed for malformed stored payloads", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const source = conversationSource();

    try {
      const untypedLedger = ledger as unknown as {
        record(input: {
          workspaceId: string;
          source: {
            providerId: string;
            sourceKind: string;
            sourceObjectId: string;
            parentObjectId: string;
            url: string;
          };
          providerVersion: string | null;
          snapshot: RawConversationSnapshot;
          observedAt: string;
        }): Promise<unknown>;
      };

      await expect(
        untypedLedger.record({
          workspaceId: "workspace_dayova",
          source: { ...source, sourceKind: "other" },
          providerVersion: null,
          snapshot: conversationSnapshot(),
          observedAt: "2026-08-08T08:59:00.000Z"
        })
      ).rejects.toThrow("source kind is unsupported");

      await expect(
        untypedLedger.record({
          workspaceId: "workspace_dayova",
          source: {
            ...source,
            sourceKind: "meeting-note",
            parentObjectId: "notion-page-1"
          },
          providerVersion: null,
          snapshot: conversationSnapshot(),
          observedAt: "2026-08-08T08:59:15.000Z"
        })
      ).rejects.toThrow("Observed Meeting Notes snapshot has an invalid shape");

      const sparsePartialReasons = new Array<{
        code: "history-truncated";
        message: string;
      }>(1);
      const sparseCompleteness = {
        ...conversationSnapshot(),
        completeness: { state: "partial" as const, reasons: sparsePartialReasons }
      } satisfies RawConversationSnapshot;

      await expect(
        ledger.record({
          workspaceId: "workspace_dayova",
          source,
          providerVersion: null,
          snapshot: sparseCompleteness,
          observedAt: "2026-08-08T08:59:30.000Z"
        })
      ).rejects.toThrow("invalid shape");

      const malformed = {
        ...conversationSnapshot(),
        boundary: {
          ...conversationSnapshot().boundary,
          anchorMessageId: "unobserved-anchor"
        }
      } as RawConversationSnapshot;

      await expect(
        ledger.record({
          workspaceId: "workspace_dayova",
          source,
          providerVersion: null,
          snapshot: malformed,
          observedAt: "2026-08-08T09:00:00.000Z"
        })
      ).rejects.toThrow("anchor message");

      const recorded = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: null,
        snapshot: conversationSnapshot(),
        observedAt: "2026-08-08T09:01:00.000Z"
      });

      await database.query(
        `UPDATE observed_source_snapshots
            SET raw_payload_json = $5
          WHERE workspace_id = $1
            AND provider_id = $2
            AND source_kind = $3
            AND source_object_id = $4`,
        [
          "workspace_dayova",
          source.providerId,
          source.sourceKind,
          source.sourceObjectId,
          JSON.stringify({ schemaVersion: 1 })
        ]
      );

      await expect(
        ledger.get({
          workspaceId: "workspace_dayova",
          source,
          revision: recorded.revision
        })
      ).rejects.toThrow("invalid stored shape");

      await database.query(
        `UPDATE observed_source_snapshots
            SET raw_payload_json = $5
          WHERE workspace_id = $1
            AND provider_id = $2
            AND source_kind = $3
            AND source_object_id = $4`,
        [
          "workspace_dayova",
          source.providerId,
          source.sourceKind,
          source.sourceObjectId,
          JSON.stringify(
            conversationSnapshot({
              firstText: "Tampered evidence must not retain its old hash."
            })
          )
        ]
      );

      await expect(
        ledger.get({
          workspaceId: "workspace_dayova",
          source,
          revision: recorded.revision
        })
      ).rejects.toThrow("content hash does not match");

      await database.query(
        `UPDATE observed_source_snapshots
            SET raw_payload_json = $5,
                source_reference_json = $6
          WHERE workspace_id = $1
            AND provider_id = $2
            AND source_kind = $3
            AND source_object_id = $4`,
        [
          "workspace_dayova",
          source.providerId,
          source.sourceKind,
          source.sourceObjectId,
          JSON.stringify(conversationSnapshot()),
          JSON.stringify({
            ...source,
            sourceKind: "meeting-note",
            parentObjectId: null
          })
        ]
      );

      await expect(
        ledger.get({
          workspaceId: "workspace_dayova",
          source,
          revision: recorded.revision
        })
      ).rejects.toThrow("does not match");
    } finally {
      await database.close();
    }
  });

  it("does not let a stale execution fence block read-only conversation capture", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const source = conversationSource();

    try {
      const first = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: null,
        snapshot: conversationSnapshot(),
        observedAt: "2026-08-08T09:00:00.000Z"
      });

      await database.query(
        `INSERT INTO observed_source_execution_fences (
           workspace_id, provider_id, source_kind, source_object_id,
           source_revision, source_content_hash,
           meeting_id, intent_id, execution_lease_id, acquired_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          "workspace_dayova",
          source.providerId,
          source.sourceKind,
          source.sourceObjectId,
          first.revision,
          first.contentHash,
          "meeting-not-applicable",
          "intent-not-applicable",
          "lease-not-applicable",
          "2026-08-08T09:00:30.000Z"
        ]
      );

      await expect(
        ledger.record({
          workspaceId: "workspace_dayova",
          source,
          providerVersion: null,
          snapshot: conversationSnapshot({
            firstText: "Die Conversation bleibt read-only."
          }),
          observedAt: "2026-08-08T09:01:00.000Z"
        })
      ).resolves.toMatchObject({ change: "revised", revision: 2 });
    } finally {
      await database.close();
    }
  });

  it("fails closed when an untyped caller sends a conversation root to mutation APIs", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const source = conversationSource();
    const owner = {
      meetingId: "meeting-not-applicable",
      intentId: "intent-not-applicable",
      executionLeaseId: "lease-not-applicable"
    };

    try {
      const first = await ledger.record({
        workspaceId: "workspace_dayova",
        source,
        providerVersion: null,
        snapshot: conversationSnapshot(),
        observedAt: "2026-08-08T09:00:00.000Z"
      });
      const [head] = await ledger.listCurrent({
        workspaceId: "workspace_dayova",
        providerId: source.providerId,
        sourceKind: source.sourceKind
      });

      if (!head) {
        throw new Error("expected a recorded conversation head");
      }

      const untypedLedger = ledger as unknown as {
        acquireExecutionFence(input: {
          workspaceId: string;
          source: typeof source;
          expected: { revision: number; contentHash: string };
          owner: typeof owner;
          now: Date;
        }): Promise<unknown>;
        verifyExecutionFenceHeldCurrent(input: {
          workspaceId: string;
          source: typeof source;
          expected: { revision: number; contentHash: string };
          owner: typeof owner;
        }): Promise<unknown>;
        releaseExecutionFence(input: {
          workspaceId: string;
          source: typeof source;
          owner: typeof owner;
        }): Promise<void>;
        recordTombstone(input: {
          workspaceId: string;
          previous: typeof head;
          observedAt: string;
        }): Promise<unknown>;
      };

      const expected = {
        revision: first.revision,
        contentHash: first.contentHash
      };

      await expect(
        untypedLedger.acquireExecutionFence({
          workspaceId: "workspace_dayova",
          source,
          expected,
          owner,
          now: new Date("2026-08-08T09:00:30.000Z")
        })
      ).rejects.toThrow("only valid meeting-note roots");
      await expect(
        untypedLedger.verifyExecutionFenceHeldCurrent({
          workspaceId: "workspace_dayova",
          source,
          expected,
          owner
        })
      ).rejects.toThrow("only valid meeting-note roots");
      await expect(
        untypedLedger.releaseExecutionFence({
          workspaceId: "workspace_dayova",
          source,
          owner
        })
      ).rejects.toThrow("only valid meeting-note roots");
      await expect(
        untypedLedger.recordTombstone({
          workspaceId: "workspace_dayova",
          previous: head,
          observedAt: "2026-08-08T09:01:00.000Z"
        })
      ).rejects.toThrow("only valid meeting-note roots");

      await database.query(
        `INSERT INTO observed_source_execution_fences (
           workspace_id, provider_id, source_kind, source_object_id,
           source_revision, source_content_hash,
           meeting_id, intent_id, execution_lease_id, acquired_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          "workspace_dayova",
          source.providerId,
          source.sourceKind,
          source.sourceObjectId,
          first.revision,
          first.contentHash,
          owner.meetingId,
          owner.intentId,
          owner.executionLeaseId,
          "2026-08-08T09:00:30.000Z"
        ]
      );

      await releaseObservedSourceExecutionFencesForExecution({
        database,
        workspaceId: "workspace_dayova",
        owner
      });
      await releaseObservedSourceExecutionFencesForSettlement({
        database,
        workspaceId: "workspace_dayova",
        meetingId: owner.meetingId,
        intentId: owner.intentId
      });

      await expect(
        database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM observed_source_execution_fences
            WHERE workspace_id = $1
              AND provider_id = $2
              AND source_kind = $3
              AND source_object_id = $4`,
          [
            "workspace_dayova",
            source.providerId,
            source.sourceKind,
            source.sourceObjectId
          ]
        )
      ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    } finally {
      await database.close();
    }
  });

  it("keeps conversation roots out of tombstone and execution-fence APIs", () => {
    type ConversationCanBeFenced =
      ObservedSourceIdentity<"conversation"> extends ObservedSourceExecutionFenceSource
        ? true
        : false;
    type ConversationCanBeTombstoned =
      ObservedSourceHead<"conversation"> extends RecordObservedSourceTombstoneInput["previous"]
        ? true
        : false;

    const conversationCanBeFenced: ConversationCanBeFenced = false;
    const conversationCanBeTombstoned: ConversationCanBeTombstoned = false;

    expect(conversationCanBeFenced).toBe(false);
    expect(conversationCanBeTombstoned).toBe(false);
  });
});
