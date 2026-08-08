import { describe, expect, it } from "vitest";
import type {
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../../src/ai/reasoning-model.js";
import type {
  MeetingImportedFromSource,
  WorkspaceConfig
} from "../../src/domain/model.js";
import { createLedgerBackedImportedSourceVerifier } from "../../src/knowledge/ledger-backed-imported-source-verifier.js";
import { observedMeetingNoteToObservation } from "../../src/knowledge/meeting-notes-ingestion.js";
import {
  createObservedSourceLedger,
  type RawMeetingNoteSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";

const workspace: WorkspaceConfig = {
  workspaceId: "workspace_dayova",
  timezone: "Europe/Berlin"
};

const sourceIdentity = {
  providerId: "notion",
  sourceKind: "meeting-note" as const,
  sourceObjectId: "notion-meeting-notes-root",
  parentObjectId: "notion-page-product-sync",
  url: "https://notion.so/product-sync"
};

const snapshot: RawMeetingNoteSnapshot = {
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
      text: "Luma source integrity",
      blocks: []
    },
    actionItemsAndNotes: {
      state: "available",
      sourceBlockId: "action-items-block",
      text: "Action Items",
      blocks: [
        {
          id: "action-block",
          type: "to-do",
          text: "Jakob will verify the Luma source by Friday.",
          checked: false,
          children: []
        }
      ]
    },
    transcript: {
      state: "available",
      sourceBlockId: "transcript-block",
      text: "Jakob committed to source verification.",
      blocks: []
    }
  },
  markdown: {
    content: "# Product sync",
    truncated: false,
    unknownBlockIds: []
  },
  completeness: { state: "complete" }
};

const noAnalysisReasoningModel: ReasoningModel = {
  generateStructured<T>(
    _request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    void _request;
    return Promise.reject(new Error("source imports do not invoke model analysis"));
  }
};

describe("ledger-backed imported source verification", () => {
  it("accepts only the exact immutable-ledger projection", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });

    try {
      const recorded = await ledger.record({
        workspaceId: workspace.workspaceId,
        source: sourceIdentity,
        providerVersion: "2026-08-07T09:31:00.000Z",
        snapshot,
        observedAt: "2026-08-07T09:32:00.000Z"
      });
      const observation = observedMeetingNoteToObservation(
        { workspace, source: recorded },
        "linear"
      );
      const meetingIntelligence = createMeetingIntelligence({
        database,
        reasoningModel: noAnalysisReasoningModel,
        importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
          ledger,
          workItemProviderId: "linear"
        })
      });

      const accepted = await meetingIntelligence.observe({
        workspace,
        observations: [observation]
      });

      expect(accepted.acceptedObservationIds).toEqual([observation.observationId]);

      const forged = selfConsistentForgedTitle(observation);
      const rejected = await meetingIntelligence.observe({
        workspace,
        observations: [forged]
      });

      expect(rejected.acceptedObservationIds).toEqual([]);
      expect(rejected.errors[0]?.code).toBe("invalid-observation");
      expect(rejected.errors[0]).toHaveProperty(
        "message",
        expect.stringContaining("does not match the immutable ledger")
      );
    } finally {
      await database.close();
    }
  });

  it("fails closed when no verifier is configured or no matching ledger revision exists", async () => {
    const database = await createPgliteDatabase();
    const emptyDatabase = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const emptyLedger = createObservedSourceLedger({ database: emptyDatabase });

    try {
      const recorded = await ledger.record({
        workspaceId: workspace.workspaceId,
        source: sourceIdentity,
        providerVersion: null,
        snapshot,
        observedAt: "2026-08-07T09:32:00.000Z"
      });
      const observation = observedMeetingNoteToObservation(
        { workspace, source: recorded },
        "linear"
      );
      const unconfigured = createMeetingIntelligence({
        database,
        reasoningModel: noAnalysisReasoningModel
      });

      const unverified = await unconfigured.observe({
        workspace,
        observations: [observation]
      });
      expect(unverified.errors).toEqual([
        expect.objectContaining({ code: "invalid-observation" })
      ]);

      const verifiedAgainstAnEmptyLedger = createMeetingIntelligence({
        database,
        reasoningModel: noAnalysisReasoningModel,
        importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
          ledger: emptyLedger,
          workItemProviderId: "linear"
        })
      });
      const absent = await verifiedAgainstAnEmptyLedger.observe({
        workspace,
        observations: [observation]
      });
      expect(absent.errors[0]?.code).toBe("invalid-observation");
      expect(absent.errors[0]).toHaveProperty(
        "message",
        expect.stringContaining("absent from the observed-source ledger")
      );
    } finally {
      await database.close();
      await emptyDatabase.close();
    }
  });
});

function selfConsistentForgedTitle(
  observation: MeetingImportedFromSource
): MeetingImportedFromSource {
  const source = {
    ...observation.source,
    title: "Fabricated source title"
  };

  return {
    ...observation,
    source,
    candidates: observation.candidates.map((candidate) => ({
      ...candidate,
      source: {
        ...candidate.source,
        source
      }
    }))
  };
}
