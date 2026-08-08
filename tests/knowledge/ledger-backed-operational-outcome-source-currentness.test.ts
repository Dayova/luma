import { describe, expect, it } from "vitest";
import {
  createLedgerBackedOperationalOutcomeSourceCurrentnessVerifier,
  type OperationalOutcomeSourceCurrentnessVerifier
} from "../../src/knowledge/ledger-backed-operational-outcome-source-currentness.js";
import type { OperationalOutcomeTarget } from "../../src/knowledge/operational-outcome-writer.js";
import {
  createObservedSourceLedger,
  type GetObservedSourceRevisionInput,
  type RawMeetingNoteSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";

const workspaceId = "workspace_dayova";

const source = {
  providerId: "notion",
  sourceKind: "meeting-note" as const,
  sourceObjectId: "meeting-notes-root-product-sync",
  parentObjectId: "notion-page-product-sync",
  url: "https://notion.so/product-sync"
};

function snapshot(transcript: string): RawMeetingNoteSnapshot {
  return {
    schemaVersion: 1,
    title: "Product sync",
    lifecycle: "ready",
    calendar: {
      startAt: "2026-08-07T09:00:00.000Z",
      endAt: "2026-08-07T09:30:00.000Z",
      attendeeProviderUserIds: []
    },
    recording: null,
    sections: {
      summary: {
        state: "available",
        sourceBlockId: "summary-block",
        text: "Review the Operational Outcome.",
        blocks: []
      },
      actionItemsAndNotes: {
        state: "available",
        sourceBlockId: "action-items-block",
        text: "Jakob will verify the source.",
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
      content: `# Product sync\n\n${transcript}`,
      truncated: false,
      unknownBlockIds: []
    },
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

describe("ledger-backed Operational Outcome source currentness", () => {
  it("accepts the same current ledger head and looks it up in the target workspace", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });

    try {
      const recorded = await ledger.record({
        workspaceId,
        source,
        providerVersion: "2026-08-07T09:31:00.000Z",
        snapshot: snapshot("The source remains current."),
        observedAt: "2026-08-07T09:32:00.000Z"
      });
      const reads: GetObservedSourceRevisionInput[] = [];
      const verifier = createLedgerBackedOperationalOutcomeSourceCurrentnessVerifier({
        ledger: {
          get: async (input) => {
            reads.push(input);
            return ledger.get(input);
          }
        }
      });

      await expect(verifier.verifyCurrent(target(recorded))).resolves.toEqual({
        status: "current"
      });
      expect(reads).toEqual([
        {
          workspaceId,
          source: {
            providerId: source.providerId,
            sourceKind: "meeting-note",
            sourceObjectId: source.sourceObjectId
          }
        }
      ]);

      const mismatchedHead =
        createLedgerBackedOperationalOutcomeSourceCurrentnessVerifier({
          ledger: {
            get: () =>
              Promise.resolve({
                ...recorded,
                source: { ...recorded.source, sourceObjectId: "different-root" }
              })
          }
        });

      await expect(mismatchedHead.verifyCurrent(target(recorded))).resolves.toEqual(
        expect.objectContaining({ status: "superseded" })
      );
    } finally {
      await database.close();
    }
  });

  it("rejects a target when a newer source revision is the current ledger head", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });

    try {
      const original = await ledger.record({
        workspaceId,
        source,
        providerVersion: "2026-08-07T09:31:00.000Z",
        snapshot: snapshot("Original meeting evidence."),
        observedAt: "2026-08-07T09:32:00.000Z"
      });
      const revised = await ledger.record({
        workspaceId,
        source,
        providerVersion: "2026-08-07T09:33:00.000Z",
        snapshot: snapshot("Revised meeting evidence."),
        observedAt: "2026-08-07T09:34:00.000Z"
      });
      const verifier = createLedgerBackedOperationalOutcomeSourceCurrentnessVerifier({
        ledger
      });

      expect(revised.revision).toBeGreaterThan(original.revision);
      await expect(verifier.verifyCurrent(target(original))).resolves.toEqual(
        expect.objectContaining({ status: "superseded" })
      );
    } finally {
      await database.close();
    }
  });

  it("treats an unchanged source root moved from parent page A to B as superseded", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const sourceOnPageA = {
      providerId: "notion",
      sourceKind: "meeting-note" as const,
      sourceObjectId: "meeting-notes-parent-move-currentness",
      parentObjectId: "notion-page-a",
      url: "https://notion.so/page-a"
    };
    const sourceOnPageB = {
      ...sourceOnPageA,
      parentObjectId: "notion-page-b",
      url: "https://notion.so/page-b"
    };
    const unchangedSnapshot = snapshot(
      "The exact same source body survived a Notion parent-page move."
    );

    try {
      const first = await ledger.record({
        workspaceId,
        source: sourceOnPageA,
        providerVersion: "2026-08-08T09:00:00.000Z",
        snapshot: unchangedSnapshot,
        observedAt: "2026-08-08T09:01:00.000Z"
      });
      const moved = await ledger.record({
        workspaceId,
        source: sourceOnPageB,
        providerVersion: "2026-08-08T09:02:00.000Z",
        snapshot: unchangedSnapshot,
        observedAt: "2026-08-08T09:03:00.000Z"
      });
      const oldTarget: OperationalOutcomeTarget = {
        workspaceId,
        providerId: sourceOnPageA.providerId,
        page: {
          providerId: sourceOnPageA.providerId,
          objectType: "document",
          externalId: sourceOnPageA.parentObjectId,
          url: sourceOnPageA.url
        },
        sourceObjectId: sourceOnPageA.sourceObjectId,
        sourceRevision: first.revision,
        sourceContentHash: first.contentHash
      };
      const verifier = createLedgerBackedOperationalOutcomeSourceCurrentnessVerifier({
        ledger
      });

      expect(moved).toMatchObject({
        change: "revised",
        revision: first.revision + 1,
        contentHash: first.contentHash,
        source: sourceOnPageB
      });
      await expect(verifier.verifyCurrent(oldTarget)).resolves.toEqual(
        expect.objectContaining({ status: "superseded" })
      );
    } finally {
      await database.close();
    }
  });

  it("rejects a target when its current ledger head is a tombstone", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });

    try {
      const recorded = await ledger.record({
        workspaceId,
        source,
        providerVersion: "2026-08-07T09:31:00.000Z",
        snapshot: snapshot("The source will be removed."),
        observedAt: "2026-08-07T09:32:00.000Z"
      });
      const [head] = await ledger.listCurrent({
        workspaceId,
        providerId: source.providerId,
        sourceKind: "meeting-note"
      });

      if (!head) {
        throw new Error("expected a current observed-source head");
      }

      await ledger.recordTombstone({
        workspaceId,
        previous: head,
        observedAt: "2026-08-07T09:33:00.000Z"
      });
      const verifier = createLedgerBackedOperationalOutcomeSourceCurrentnessVerifier({
        ledger
      });

      await expect(verifier.verifyCurrent(target(recorded))).resolves.toEqual(
        expect.objectContaining({ status: "superseded" })
      );
    } finally {
      await database.close();
    }
  });

  it("fails closed when the ledger has no current head for the target", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const verifier = createLedgerBackedOperationalOutcomeSourceCurrentnessVerifier({
      ledger
    });

    try {
      await expect(
        verifier.verifyCurrent(
          target({ revision: 1, contentHash: "sha256:missing-source" })
        )
      ).resolves.toEqual(expect.objectContaining({ status: "unavailable" }));
    } finally {
      await database.close();
    }
  });

  it("fails closed when the observed-source ledger cannot be read", async () => {
    const verifier: OperationalOutcomeSourceCurrentnessVerifier =
      createLedgerBackedOperationalOutcomeSourceCurrentnessVerifier({
        ledger: {
          get: () => Promise.reject(new Error("ledger connection interrupted"))
        }
      });

    const currentness = await verifier.verifyCurrent(
      target({ revision: 1, contentHash: "sha256:source" })
    );

    expect(currentness.status).toBe("unavailable");
    if (currentness.status === "unavailable") {
      expect(currentness.message).toContain("ledger connection interrupted");
    }
  });
});
