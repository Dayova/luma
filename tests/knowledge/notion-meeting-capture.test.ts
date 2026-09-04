import { describe, expect, it } from "vitest";
import { createLedgerBackedNotionCaptureRevisionVerifier } from "../../src/knowledge/ledger-backed-notion-capture-revision-verifier.js";
import { createLogicalMeetings } from "../../src/logical-meetings/logical-meetings.js";
import { observedNotionMeetingCapture } from "../../src/knowledge/notion-meeting-capture.js";
import {
  createObservedSourceLedger,
  type RawMeetingNoteSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";

const workspaceId = "workspace_dayova";
const sourceIdentity = {
  providerId: "notion",
  sourceKind: "meeting-note" as const,
  sourceObjectId: "notion-meeting-notes-root",
  parentObjectId: "notion-page-product-sync",
  url: "https://notion.so/product-sync"
};

const completeSnapshot: RawMeetingNoteSnapshot = {
  schemaVersion: 1,
  title: "Product Sync",
  lifecycle: "ready",
  calendar: {
    startAt: "2026-08-07T09:00:00.000Z",
    endAt: "2026-08-07T09:30:00.000Z",
    attendeeProviderUserIds: ["notion-user-jakob", "notion-user-anna"]
  },
  recording: {
    startAt: "2026-08-07T09:00:00.000Z",
    endAt: "2026-08-07T09:30:00.000Z"
  },
  sections: {
    summary: {
      state: "available",
      sourceBlockId: "summary-block",
      text: "The raw summary must remain in the LUM-2 ledger.",
      blocks: []
    },
    actionItemsAndNotes: {
      state: "available",
      sourceBlockId: "action-items-block",
      text: "Jakob will review the source boundary.",
      blocks: []
    },
    transcript: {
      state: "available",
      sourceBlockId: "transcript-block",
      text: "Anna: Die Quelle bleibt unverändert.",
      blocks: []
    }
  },
  markdown: {
    content: "# Product Sync",
    truncated: false,
    unknownBlockIds: []
  },
  completeness: { state: "complete" }
};

describe("Notion Meeting capture projection", () => {
  it("projects ledger-backed facts and material provenance without retaining raw text", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });

    try {
      const source = await ledger.record({
        workspaceId,
        source: sourceIdentity,
        providerVersion: "2026-08-07T09:31:00.000Z",
        snapshot: completeSnapshot,
        observedAt: "2026-08-07T09:32:00.000Z"
      });
      const capture = observedNotionMeetingCapture({
        source,
        canonicalSourceScopeId: "notion-canonical-source",
        attendeePersonIds: ["person-jakob", "person-anna", "person-jakob"]
      });

      expect(capture.address).toEqual({
        providerId: "notion",
        providerConnectionId: "notion-canonical-source",
        externalCaptureId: "notion-meeting-notes-root",
        sourceKind: "meeting-note"
      });
      expect(capture.availability).toBe("complete");
      expect(capture.capabilities).toEqual({
        enhancedNotes: "available",
        rawTranscript: "available",
        speakerIdentity: "unavailable",
        attendees: "available",
        revisionMetadata: "available"
      });
      expect(capture.identityFacts).toMatchObject({
        calendarEventKeys: [],
        conferenceKeys: [],
        interval: {
          startedAt: "2026-08-07T09:00:00.000Z",
          endedAt: "2026-08-07T09:30:00.000Z"
        },
        attendeePersonIds: ["person-anna", "person-jakob"],
        contextKeys: []
      });
      expect(capture.identityFacts.titleFingerprint).toMatch(/^title:v1:sha256:/u);
      expect(
        capture.materials.map((material) => [material.kind, material.provenance])
      ).toEqual([
        ["provider-summary", "provider-derived"],
        ["provider-action-items", "provider-derived"],
        ["verbatim-transcript", "original-speech"],
        ["calendar-metadata", "provider-metadata"],
        ["attendees", "provider-metadata"]
      ]);
      expect(JSON.stringify(capture)).not.toContain("Die Quelle bleibt unverändert.");
      expect(JSON.stringify(capture)).not.toContain(
        "The raw summary must remain in the LUM-2 ledger."
      );
    } finally {
      await database.close();
    }
  });

  it("keeps not-ready notes out of reusable capture material", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });

    try {
      const source = await ledger.record({
        workspaceId,
        source: sourceIdentity,
        providerVersion: "2026-08-07T09:01:00.000Z",
        snapshot: {
          ...completeSnapshot,
          lifecycle: "not-ready",
          sections: {
            summary: {
              state: "unavailable",
              sourceBlockId: null,
              reasons: [
                {
                  code: "meeting-notes-not-ready",
                  message: "Notion is still preparing Meeting Notes"
                }
              ]
            },
            actionItemsAndNotes: {
              state: "unavailable",
              sourceBlockId: null,
              reasons: [
                {
                  code: "meeting-notes-not-ready",
                  message: "Notion is still preparing Meeting Notes"
                }
              ]
            },
            transcript: {
              state: "unavailable",
              sourceBlockId: null,
              reasons: [
                {
                  code: "meeting-notes-not-ready",
                  message: "Notion is still preparing Meeting Notes"
                }
              ]
            }
          },
          completeness: { state: "not-ready", providerStatus: "processing" }
        },
        observedAt: "2026-08-07T09:01:30.000Z"
      });
      const capture = observedNotionMeetingCapture({
        source,
        canonicalSourceScopeId: "notion-canonical-source"
      });

      expect(capture.availability).toBe("not-ready");
      expect(capture.capabilities.enhancedNotes).toBe("unknown");
      expect(capture.capabilities.rawTranscript).toBe("unknown");
      expect(capture.materials).toEqual([]);
    } finally {
      await database.close();
    }
  });
});

describe("ledger-backed Notion capture revision verification", () => {
  it("preserves locale-independent attendee ordering through projection, storage, and replay", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });

    try {
      const source = await ledger.record({
        workspaceId,
        source: sourceIdentity,
        providerVersion: "2026-08-07T09:31:00.000Z",
        snapshot: completeSnapshot,
        observedAt: "2026-08-07T09:32:00.000Z"
      });
      const attendeePersonIds = [
        "person:ä",
        "person:a",
        " person:Z ",
        "person:A",
        "person:a"
      ];
      const expectedIds = ["person:A", "person:Z", "person:a", "person:ä"];
      const capture = observedNotionMeetingCapture({
        source,
        canonicalSourceScopeId: "notion-canonical-source",
        attendeePersonIds
      });
      expect(capture.identityFacts.attendeePersonIds).toEqual(expectedIds);
      const verifier = createLedgerBackedNotionCaptureRevisionVerifier({
        ledger,
        canonicalSourceScopeId: "notion-canonical-source",
        attendeePersonIdsForLedgerSource: () => attendeePersonIds
      });
      const logicalMeetings = createLogicalMeetings({
        database,
        captureRevisionVerifier: verifier
      });
      const result = await logicalMeetings.resolveCapture({
        workspaceId,
        revision: capture
      });
      expect(result.status).toBe("accepted");
      if (result.status !== "accepted") {
        throw new Error("Expected the verified capture to be admitted");
      }
      const stored = result.decision.logicalMeeting.captureRefs[0]?.latestRevision;
      expect(stored?.identityFacts.attendeePersonIds).toEqual(expectedIds);
      if (!stored) {
        throw new Error("Expected the admitted capture revision to be persisted");
      }
      await expect(verifier.verify({ workspaceId, revision: stored })).resolves.toEqual({
        status: "verified"
      });
      await expect(
        logicalMeetings.resolveCapture({ workspaceId, revision: stored })
      ).resolves.toMatchObject({
        status: "accepted",
        decision: { effect: "unchanged", captureId: result.decision.captureId }
      });
    } finally {
      await database.close();
    }
  });

  it("accepts only the exact immutable ledger projection", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });

    try {
      const source = await ledger.record({
        workspaceId,
        source: sourceIdentity,
        providerVersion: "2026-08-07T09:31:00.000Z",
        snapshot: completeSnapshot,
        observedAt: "2026-08-07T09:32:00.000Z"
      });
      const capture = observedNotionMeetingCapture({
        source,
        canonicalSourceScopeId: "notion-canonical-source"
      });
      const verifier = createLedgerBackedNotionCaptureRevisionVerifier({
        ledger,
        canonicalSourceScopeId: "notion-canonical-source"
      });

      await expect(verifier.verify({ workspaceId, revision: capture })).resolves.toEqual({
        status: "verified"
      });
      await expect(
        verifier.verify({
          workspaceId,
          revision: {
            ...capture,
            address: {
              ...capture.address,
              providerConnectionId: "another-notion-connection"
            }
          }
        })
      ).resolves.toMatchObject({ status: "rejected" });
      await expect(
        verifier.verify({
          workspaceId,
          revision: { ...capture, contentHash: "sha256:forged" }
        })
      ).resolves.toMatchObject({ status: "rejected" });
      await expect(
        verifier.verify({
          workspaceId,
          revision: {
            ...capture,
            identityFacts: {
              ...capture.identityFacts,
              calendarEventKeys: ["forged-calendar-event"]
            }
          }
        })
      ).resolves.toMatchObject({ status: "rejected" });
    } finally {
      await database.close();
    }
  });

  it("lets LogicalMeetings accept only the verified ledger-backed projection", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });

    try {
      const source = await ledger.record({
        workspaceId,
        source: sourceIdentity,
        providerVersion: "2026-08-07T09:31:00.000Z",
        snapshot: completeSnapshot,
        observedAt: "2026-08-07T09:32:00.000Z"
      });
      const capture = observedNotionMeetingCapture({
        source,
        canonicalSourceScopeId: "notion-canonical-source"
      });
      const logicalMeetings = createLogicalMeetings({
        database,
        captureRevisionVerifier: createLedgerBackedNotionCaptureRevisionVerifier({
          ledger,
          canonicalSourceScopeId: "notion-canonical-source"
        })
      });
      const accepted = await logicalMeetings.resolveCapture({
        workspaceId,
        revision: capture
      });
      const forged = await logicalMeetings.resolveCapture({
        workspaceId,
        revision: {
          ...capture,
          identityFacts: {
            ...capture.identityFacts,
            contextKeys: ["forged-context"]
          }
        }
      });

      expect(accepted).toMatchObject({
        status: "accepted",
        decision: { state: "separate" }
      });
      expect(forged).toMatchObject({
        status: "rejected",
        code: "capture-revision-unverified"
      });
    } finally {
      await database.close();
    }
  });
});
