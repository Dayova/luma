import { describe, expect, it } from "vitest";
import {
  createLedgerBackedOperationalOutcomeSourceExecutionFence,
  type OperationalOutcomeSourceExecutionFence
} from "../../src/knowledge/ledger-backed-operational-outcome-source-execution-fence.js";
import type { OperationalOutcomeTarget } from "../../src/knowledge/operational-outcome-writer.js";
import {
  createObservedSourceLedger,
  type RawMeetingNoteSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";

const workspaceId = "workspace_dayova";
const source = {
  providerId: "notion",
  sourceKind: "meeting-note" as const,
  sourceObjectId: "meeting-notes-source-fence",
  parentObjectId: "notion-page-source-fence",
  url: "https://notion.so/source-fence"
};

const owner = {
  meetingId: "meeting-source-fence",
  intentId: "settlement-source-fence",
  executionLeaseId: "orphaned-outer-lease"
};

function snapshot(text: string): RawMeetingNoteSnapshot {
  return {
    schemaVersion: 1,
    title: "Source fence",
    lifecycle: "ready",
    calendar: null,
    recording: null,
    sections: {
      summary: { state: "unavailable", sourceBlockId: null, reasons: [] },
      actionItemsAndNotes: { state: "unavailable", sourceBlockId: null, reasons: [] },
      transcript: { state: "unavailable", sourceBlockId: null, reasons: [] }
    },
    markdown: { content: text, truncated: false, unknownBlockIds: [] },
    completeness: { state: "complete" }
  };
}

function target(recorded: {
  revision: number;
  contentHash: string;
}): OperationalOutcomeTarget {
  return {
    workspaceId,
    providerId: source.providerId,
    page: {
      providerId: source.providerId,
      objectType: "document",
      externalId: source.parentObjectId,
      url: source.url
    },
    sourceObjectId: source.sourceObjectId,
    sourceRevision: recorded.revision,
    sourceContentHash: recorded.contentHash
  };
}

describe("ledger-backed Operational Outcome source execution fence", () => {
  it("acquires against the immutable target and releases an orphaned prior lease after a terminal receipt", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const fence: OperationalOutcomeSourceExecutionFence =
      createLedgerBackedOperationalOutcomeSourceExecutionFence({ ledger });

    try {
      const recorded = await ledger.record({
        workspaceId,
        source,
        providerVersion: null,
        snapshot: snapshot("The approved source revision."),
        observedAt: "2026-08-08T10:00:00.000Z"
      });

      await expect(
        fence.acquire({
          target: target(recorded),
          owner,
          now: new Date("2026-08-08T10:01:00.000Z")
        })
      ).resolves.toEqual({ status: "acquired" });

      const supersedingSnapshot = snapshot(
        "A source scan observed a newer canonical source revision."
      );
      await expect(
        ledger.record({
          workspaceId,
          source,
          providerVersion: null,
          snapshot: supersedingSnapshot,
          observedAt: "2026-08-08T10:01:30.000Z"
        })
      ).rejects.toThrow("is fenced by active execution");

      await expect(
        fence.verifyHeldCurrent({ target: target(recorded), owner })
      ).resolves.toMatchObject({ status: "superseded" });
      await expect(
        fence.acquire({
          target: target(recorded),
          owner,
          now: new Date("2026-08-08T10:01:45.000Z")
        })
      ).resolves.toEqual({
        status: "superseded",
        current: { revision: recorded.revision, contentHash: recorded.contentHash }
      });
      await expect(ledger.get({ workspaceId, source })).resolves.toMatchObject({
        revision: recorded.revision,
        contentHash: recorded.contentHash
      });

      // The terminal receipt may be recorded by a later manual-recovery
      // lease. Settlement-level cleanup must therefore remove the old fence.
      await fence.releaseAfterReceipt({
        database,
        workspaceId,
        meetingId: owner.meetingId,
        intentId: owner.intentId
      });

      await expect(
        ledger.record({
          workspaceId,
          source,
          providerVersion: null,
          snapshot: supersedingSnapshot,
          observedAt: "2026-08-08T10:02:00.000Z"
        })
      ).resolves.toMatchObject({ change: "revised", revision: 2 });
    } finally {
      await database.close();
    }
  });
});
