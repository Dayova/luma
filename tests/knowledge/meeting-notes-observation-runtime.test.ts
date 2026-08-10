import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../../src/ai/reasoning-model.js";
import type { WorkspaceConfig } from "../../src/domain/model.js";
import {
  createMeetingNotesIngestion,
  type MeetingNotesIngestion
} from "../../src/knowledge/meeting-notes-ingestion.js";
import {
  createMeetingNotesObservationRuntime,
  type MeetingNotesCanonicalReconciliation,
  type MeetingNotesPageRefresher
} from "../../src/knowledge/meeting-notes-observation-runtime.js";
import type { MeetingNotesSyncResult } from "../../src/knowledge/meeting-notes-sync.js";
import { createNotionWebhookWakeUpIngress } from "../../src/knowledge/notion-webhook-wake-up.js";
import type { ObservedSourceRevision } from "../../src/knowledge/observed-source-ledger.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";

const workspace: WorkspaceConfig = {
  workspaceId: "workspace_dayova",
  timezone: "Europe/Berlin"
};
const notionPageId = "11111111-2222-3333-4444-555555555555";

function sourceRevision(
  sourceObjectId: string,
  change: ObservedSourceRevision["change"] = "new",
  completeness: ObservedSourceRevision["snapshot"]["completeness"] = {
    state: "complete"
  }
): ObservedSourceRevision {
  return {
    change,
    source: {
      providerId: "notion",
      sourceKind: "meeting-note",
      sourceObjectId,
      parentObjectId: "meeting-page-1",
      url: "https://notion.so/meeting-page-1"
    },
    revision: 1,
    contentHash: `sha256:${sourceObjectId}`,
    providerVersion: "2026-08-10T10:00:00.000Z",
    capturedAt: "2026-08-10T10:01:00.000Z",
    snapshot: {
      schemaVersion: 1,
      title: "Product sync",
      lifecycle: "ready",
      calendar: null,
      recording: null,
      sections: {
        summary: { state: "unavailable", sourceBlockId: null, reasons: [] },
        actionItemsAndNotes: { state: "unavailable", sourceBlockId: null, reasons: [] },
        transcript: { state: "unavailable", sourceBlockId: null, reasons: [] }
      },
      markdown: { content: "# Product sync", truncated: false, unknownBlockIds: [] },
      completeness
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

class RecordingPageRefresher implements MeetingNotesPageRefresher {
  readonly pageIds: string[] = [];
  nextRecords: ObservedSourceRevision[] = [sourceRevision("meeting-notes-root")];

  refreshPage(input: { workspaceId: string; pageId: string }) {
    expect(input.workspaceId).toBe(workspace.workspaceId);
    this.pageIds.push(input.pageId);
    return Promise.resolve({
      status: "refreshed" as const,
      records: this.nextRecords,
      completeness: "complete" as const,
      partialReasons: []
    });
  }
}

class RecordingCanonicalReconciliation implements MeetingNotesCanonicalReconciliation {
  syncCalls = 0;
  startCalls = 0;
  stopCalls = 0;
  nextResult: MeetingNotesSyncResult = {
    scannedRecords: 1,
    tombstonedRecords: 0,
    ingestedRecords: 1,
    unchangedRecords: 0,
    deliveryFailures: [],
    completeness: "complete",
    partialReasons: []
  };

  syncOnce() {
    this.syncCalls += 1;
    return Promise.resolve(this.nextResult);
  }

  start() {
    this.startCalls += 1;
  }

  stop() {
    this.stopCalls += 1;
    return Promise.resolve();
  }
}

class NoAnalysisReasoningModel implements ReasoningModel {
  generateStructured<T>(
    _request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    void _request;
    return Promise.reject(
      new Error("observation-only refresh must not invoke model analysis")
    );
  }
}

describe("Meeting Notes observation runtime", () => {
  it("coalesces duplicate and out-of-order page signals into one authoritative bounded refresh", async () => {
    const refresher = new RecordingPageRefresher();
    const ingestion = new RecordingIngestion();
    const reconciliation = new RecordingCanonicalReconciliation();
    const runtime = createMeetingNotesObservationRuntime({
      workspace,
      refresher,
      ingestion,
      canonicalReconciliation: reconciliation,
      now: () => new Date("2026-08-10T11:45:00.000Z")
    });

    expect(
      runtime.enqueue({
        kind: "page",
        deliveryId: "delivery-newer",
        pageId: "meeting-page-1",
        occurredAt: "2026-08-10T11:44:00.000Z",
        receivedAt: "2026-08-10T11:44:10.000Z"
      })
    ).toEqual({ status: "queued" });
    expect(
      runtime.enqueue({
        kind: "page",
        deliveryId: "delivery-older",
        pageId: "meeting-page-1",
        occurredAt: "2026-08-10T11:40:00.000Z",
        receivedAt: "2026-08-10T11:44:20.000Z"
      })
    ).toEqual({ status: "coalesced" });
    expect(
      runtime.enqueue({
        kind: "page",
        deliveryId: "delivery-newer",
        pageId: "meeting-page-1",
        occurredAt: "2026-08-10T11:44:00.000Z",
        receivedAt: "2026-08-10T11:44:30.000Z"
      })
    ).toEqual({ status: "coalesced" });

    const result = await runtime.drain();

    expect(refresher.pageIds).toEqual(["meeting-page-1"]);
    expect(ingestion.records.map((record) => record.source.sourceObjectId)).toEqual([
      "meeting-notes-root"
    ]);
    expect(reconciliation.syncCalls).toBe(0);
    expect(result).toMatchObject({
      pageRefreshes: [
        {
          pageId: "meeting-page-1",
          refreshStatus: "refreshed",
          ingestedRecords: 1
        }
      ],
      canonicalReconciliation: null
    });
    expect(runtime.status()).toMatchObject({
      pendingPageCount: 0,
      canonicalReconciliationPending: false,
      lastWebhookReceivedAt: "2026-08-10T11:44:30.000Z",
      lastWakeUpAt: "2026-08-10T11:45:00.000Z"
    });
  });

  it("makes a canonical data-source signal supersede pending page work and retains scheduled recovery", async () => {
    const refresher = new RecordingPageRefresher();
    const ingestion = new RecordingIngestion();
    const reconciliation = new RecordingCanonicalReconciliation();
    const runtime = createMeetingNotesObservationRuntime({
      workspace,
      refresher,
      ingestion,
      canonicalReconciliation: reconciliation
    });

    runtime.enqueue({
      kind: "page",
      deliveryId: "page-before-scan",
      pageId: "meeting-page-1",
      occurredAt: "2026-08-10T12:00:00.000Z",
      receivedAt: "2026-08-10T12:00:01.000Z"
    });
    runtime.enqueue({
      kind: "canonical-reconciliation",
      deliveryId: "canonical-scan",
      occurredAt: "2026-08-10T12:00:02.000Z",
      receivedAt: "2026-08-10T12:00:03.000Z"
    });
    expect(
      runtime.enqueue({
        kind: "page",
        deliveryId: "page-after-scan",
        pageId: "meeting-page-2",
        occurredAt: "2026-08-10T12:00:04.000Z",
        receivedAt: "2026-08-10T12:00:05.000Z"
      })
    ).toEqual({ status: "coalesced" });

    const result = await runtime.drain();
    runtime.startCanonicalRecovery();
    await runtime.stopCanonicalRecovery();

    expect(refresher.pageIds).toEqual([]);
    expect(reconciliation.syncCalls).toBe(1);
    expect(reconciliation.startCalls).toBe(1);
    expect(reconciliation.stopCalls).toBe(1);
    expect(result.canonicalReconciliation).toMatchObject({
      completeness: "complete",
      ingestedRecords: 1
    });
    expect(runtime.status().lastSuccessfulCanonicalReconciliationAt).toEqual(
      expect.stringMatching(/.+/u)
    );
    expect(runtime.status().lastFailure).toBeNull();
  });

  it("bounds distinct page wake-ups by promoting overflow into one canonical reconciliation", async () => {
    const refresher = new RecordingPageRefresher();
    const ingestion = new RecordingIngestion();
    const reconciliation = new RecordingCanonicalReconciliation();
    const runtime = createMeetingNotesObservationRuntime({
      workspace,
      refresher,
      ingestion,
      canonicalReconciliation: reconciliation,
      maxPendingPages: 2,
      now: () => new Date("2026-08-10T12:15:00.000Z")
    });

    for (const pageId of ["meeting-page-1", "meeting-page-2"]) {
      expect(
        runtime.enqueue({
          kind: "page",
          deliveryId: `delivery-${pageId}`,
          pageId,
          occurredAt: "2026-08-10T12:14:00.000Z",
          receivedAt: "2026-08-10T12:14:01.000Z"
        })
      ).toEqual({ status: "queued" });
    }

    expect(
      runtime.enqueue({
        kind: "page",
        deliveryId: "delivery-overflow",
        pageId: "meeting-page-3",
        occurredAt: "2026-08-10T12:14:02.000Z",
        receivedAt: "2026-08-10T12:14:03.000Z"
      })
    ).toEqual({ status: "coalesced" });
    expect(runtime.status()).toMatchObject({
      pendingPageCount: 0,
      canonicalReconciliationPending: true,
      pageWakeUpOverflowCount: 1,
      lastPageWakeUpOverflowAt: "2026-08-10T12:14:03.000Z"
    });

    await runtime.drain();

    expect(refresher.pageIds).toEqual([]);
    expect(reconciliation.syncCalls).toBe(1);
  });

  it("keeps a partial canonical reconciliation observable without treating it as successful", async () => {
    const refresher = new RecordingPageRefresher();
    const ingestion = new RecordingIngestion();
    const reconciliation = new RecordingCanonicalReconciliation();
    reconciliation.nextResult = {
      ...reconciliation.nextResult,
      completeness: "partial",
      deliveryFailures: [
        { sourceObjectId: "meeting-notes-root", message: "source delivery failed" }
      ],
      partialReasons: [
        {
          code: "unreadable-page",
          message: "Notion returned a partial page",
          pageId: "meeting-page-1",
          retryable: true
        }
      ]
    };
    const runtime = createMeetingNotesObservationRuntime({
      workspace,
      refresher,
      ingestion,
      canonicalReconciliation: reconciliation
    });

    runtime.enqueue({
      kind: "canonical-reconciliation",
      deliveryId: "partial-canonical-scan",
      occurredAt: "2026-08-10T12:20:00.000Z",
      receivedAt: "2026-08-10T12:20:01.000Z"
    });

    await runtime.drain();

    expect(runtime.status().lastSuccessfulCanonicalReconciliationAt).toBeNull();
    expect(runtime.status().lastFailure?.scope).toBe("canonical-reconciliation");
    expect(runtime.status().lastFailure?.message).toContain("partial");
    expect(runtime.status().canonicalReconciliationPending).toBe(false);
  });

  it("records a page-refresh failure for recovery instead of escalating it into external execution", async () => {
    const ingestion = new RecordingIngestion();
    const reconciliation = new RecordingCanonicalReconciliation();
    const refresher: MeetingNotesPageRefresher = {
      refreshPage: () => Promise.reject(new Error("Notion is temporarily unavailable"))
    };
    const runtime = createMeetingNotesObservationRuntime({
      workspace,
      refresher,
      ingestion,
      canonicalReconciliation: reconciliation
    });

    runtime.enqueue({
      kind: "page",
      deliveryId: "transient-page-refresh",
      pageId: "meeting-page-1",
      occurredAt: "2026-08-10T12:30:00.000Z",
      receivedAt: "2026-08-10T12:30:01.000Z"
    });

    const result = await runtime.drain();

    expect(result.pageRefreshes).toEqual([
      expect.objectContaining({
        pageId: "meeting-page-1",
        status: "failed",
        message: "Notion is temporarily unavailable"
      })
    ]);
    expect(ingestion.records).toEqual([]);
    expect(runtime.status()).toMatchObject({
      pendingPageCount: 1,
      lastFailure: {
        scope: "page-refresh",
        pageId: "meeting-page-1",
        message: "Notion is temporarily unavailable"
      }
    });
  });

  it("does not requeue a deletion-race refresh that deliberately returns ignored partial coverage", async () => {
    const ingestion = new RecordingIngestion();
    const reconciliation = new RecordingCanonicalReconciliation();
    const refresher: MeetingNotesPageRefresher = {
      refreshPage: () =>
        Promise.resolve({
          status: "ignored",
          records: [],
          completeness: "partial",
          partialReasons: [
            {
              code: "unreadable-page",
              message: "The exact page was deleted before it could be read",
              pageId: "meeting-page-1",
              retryable: false
            }
          ]
        })
    };
    const runtime = createMeetingNotesObservationRuntime({
      workspace,
      refresher,
      ingestion,
      canonicalReconciliation: reconciliation
    });

    runtime.enqueue({
      kind: "page",
      deliveryId: "deleted-before-refresh",
      pageId: "meeting-page-1",
      occurredAt: "2026-08-10T12:40:00.000Z",
      receivedAt: "2026-08-10T12:40:01.000Z"
    });

    await expect(runtime.drain()).resolves.toMatchObject({
      pageRefreshes: [
        { pageId: "meeting-page-1", status: "completed", refreshStatus: "ignored" }
      ]
    });
    expect(runtime.status().pendingPageCount).toBe(0);
    expect(ingestion.records).toEqual([]);
  });

  it("records source Observation receipts without creating a Follow-up execution", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel(),
      importedSourceObservationVerifier: {
        verify: () => Promise.resolve({ status: "verified" })
      }
    });
    const refresher = new RecordingPageRefresher();
    const runtime = createMeetingNotesObservationRuntime({
      workspace,
      refresher,
      ingestion: createMeetingNotesIngestion({ meetingIntelligence }),
      canonicalReconciliation: new RecordingCanonicalReconciliation()
    });

    try {
      const rawBody = Buffer.from(
        JSON.stringify({
          id: "observation-only-delivery",
          timestamp: "2026-08-10T13:00:00.000Z",
          workspace_id: workspace.workspaceId,
          subscription_id: "subscription-dayova-meetings",
          integration_id: "integration-luma",
          api_version: "2026-03-11",
          attempt_number: 1,
          type: "page.content_updated",
          entity: { id: notionPageId, type: "page" }
        }),
        "utf8"
      );
      const verificationToken = "secret_luma_observation_only";
      const ingress = createNotionWebhookWakeUpIngress({
        workspaceId: workspace.workspaceId,
        canonicalMeetingsDataSourceId: "dayova-meetings",
        verificationToken,
        queue: runtime,
        now: () => new Date("2026-08-10T13:00:01.000Z")
      });

      expect(
        ingress.receive({
          rawBody,
          headers: {
            "x-notion-signature": `sha256=${createHmac("sha256", verificationToken)
              .update(rawBody)
              .digest("hex")}`
          }
        })
      ).toMatchObject({ status: "queued", wakeUp: { kind: "page" } });

      const receipt = await runtime.drain();

      expect(receipt.pageRefreshes).toMatchObject([
        { pageId: notionPageId, status: "completed", ingestedRecords: 1 }
      ]);
      await expect(
        database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM follow_up_executions
            WHERE workspace_id = $1`,
          [workspace.workspaceId]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await database.close();
    }
  });
});
