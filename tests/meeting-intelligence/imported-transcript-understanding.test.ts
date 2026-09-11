import { describe, expect, it } from "vitest";
import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel,
  StructuredReasoningRequest
} from "../../src/ai/reasoning-model.js";
import { AiServiceError } from "../../src/ai/ai-service-error.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import {
  createObservedSourceLedger,
  type RawMeetingNoteSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createGrantedImportedSourceAnalysisAccess } from "../../src/knowledge/granted-imported-source-analysis-access.js";
import { createLedgerBackedImportedSourceVerifier } from "../../src/knowledge/ledger-backed-imported-source-verifier.js";
import { observedMeetingNoteToObservation } from "../../src/knowledge/meeting-notes-ingestion.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createMeetingContextGuard } from "../../src/meeting-intelligence/context-guard.js";

const workspace = { workspaceId: "dayova", timezone: "Europe/Berlin" };
const time = "2026-09-11T09:00:00.000Z";
const identity = {
  providerId: "notion",
  sourceKind: "meeting-note" as const,
  sourceObjectId: "meeting-root",
  parentObjectId: "meeting-page",
  url: "https://notion.so/meeting-page"
};
const raw: RawMeetingNoteSnapshot = {
  schemaVersion: 1,
  title: "Private release discussion",
  lifecycle: "ready",
  calendar: {
    startAt: time,
    endAt: "2026-09-11T10:00:00.000Z",
    attendeeProviderUserIds: []
  },
  recording: null,
  sections: {
    summary: {
      state: "available",
      sourceBlockId: "summary",
      text: "Provider summary: ship everything.",
      blocks: []
    },
    actionItemsAndNotes: {
      state: "available",
      sourceBlockId: "notes",
      text: "Jakob könnte den Export prüfen.",
      blocks: [
        {
          id: "todo",
          type: "to-do",
          text: "Jakob könnte den Export prüfen.",
          checked: false,
          children: []
        }
      ]
    },
    transcript: {
      state: "available",
      sourceBlockId: "transcript",
      text: "Wir pausieren den Launch. Ich könnte den Export prüfen, aber das ist noch keine Zusage.",
      blocks: []
    }
  },
  markdown: {
    content: "# Private release discussion",
    truncated: false,
    unknownBlockIds: []
  },
  completeness: { state: "complete" }
};

async function fixture() {
  const database = await createPgliteDatabase();
  const ledger = createObservedSourceLedger({ database });
  let live = structuredClone(raw);
  let allowed = true;
  const recipients = ["jakob", "fabius", "julius", "philipp"];
  const requests: StructuredReasoningRequest<unknown>[] = [];
  let duringCapture: (() => Promise<void>) | undefined;
  let duringAnalysis: (() => Promise<void>) | undefined;
  let failAnalysis = false;
  let preDispatchFailure = false;
  let configured = true;
  const reasoningModel: ReasoningModel = {
    async generateStructured<T>(request: StructuredReasoningRequest<T>) {
      requests.push(request);
      if (duringAnalysis) await duringAnalysis();
      if (preDispatchFailure)
        throw new AiServiceError("budget-exhausted", "monthly limit", {
          requestDispatched: false
        });
      if (failAnalysis)
        throw new AiServiceError("provider-quota", "private provider diagnostic");
      const transcript = request.evidence.find((item) => item.source === "transcript")!;
      const value: MeetingAnalysisProposalBatch = {
        decisions: [
          {
            stableKey: "launch",
            statement: transcript.excerpt!,
            rationale: [],
            status: "candidate",
            supportingParticipantIds: [],
            objectingParticipantIds: [],
            relatedTopicIds: [],
            evidenceIds: [transcript.evidenceId],
            confidence: "high"
          }
        ],
        actionItems: [
          {
            stableKey: "export",
            description: "Export prüfen (Vorschlag)",
            ownerId: "jakob",
            dueDate: {
              originalPhrase: null,
              normalizedDate: null,
              confidence: "unknown",
              timezone: "Europe/Berlin"
            },
            status: "candidate",
            relatedDecisionIds: [],
            evidenceIds: [transcript.evidenceId],
            confidence: "low"
          }
        ],
        openQuestions: [
          {
            stableKey: "launch-date",
            question: "Wann starten wir?",
            raisedBy: null,
            evidenceIds: [transcript.evidenceId],
            confidence: "high"
          }
        ],
        risks: [
          {
            stableKey: "delay",
            statement: "Unklarer Launchtermin",
            severity: "medium",
            mitigation: null,
            evidenceIds: [transcript.evidenceId],
            confidence: "high"
          }
        ],
        followUpIntentions: [
          {
            type: "record-meeting",
            id: "record-imported",
            title: "Meeting result",
            relatedMeetingItemIds: ["decision:launch"],
            evidenceIds: [transcript.evidenceId],
            confidence: "high"
          }
        ]
      };
      return {
        value: value as T,
        metadata: {
          provider: "test",
          model: "programmable",
          promptVersion: request.promptVersion
        }
      };
    }
  };
  const access = createGrantedImportedSourceAnalysisAccess({
    ledger,
    authorize: () => Promise.resolve(allowed),
    evidenceSource: () => ({
      capture: async () => {
        const snapshot = structuredClone(live);
        if (duringCapture) await duringCapture();
        return {
          status: "captured",
          evidence: {
            source: identity,
            providerVersion: time,
            observedAt: time,
            snapshot
          }
        };
      }
    })
  });
  const importedSourceAnalysis = {
    access,
    audience: () =>
      Promise.resolve({ workspaceId: workspace.workspaceId, personIds: [...recipients] })
  };
  const create = () =>
    createMeetingIntelligence({
      database,
      reasoningModel,
      ...(configured ? { importedSourceAnalysis } : {}),
      importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
        ledger
      })
    });
  let mi = create();
  let observation = observedMeetingNoteToObservation(
    {
      workspace,
      source: await ledger.record({
        workspaceId: workspace.workspaceId,
        source: identity,
        providerVersion: time,
        snapshot: live,
        observedAt: time
      })
    },
    "linear"
  );
  return {
    database,
    ledger,
    requests,
    access,
    importedSourceAnalysis,
    current: () => mi,
    observation: () => observation,
    ingest: () => mi.observe({ workspace, observations: [observation] }),
    restart: () => {
      mi = create();
    },
    revoke: () => {
      allowed = false;
    },
    allow: () => {
      allowed = true;
    },
    configure: (value: boolean) => {
      configured = value;
      mi = create();
    },
    preDispatch: (value: boolean) => {
      preDispatchFailure = value;
    },
    widen: () => {
      recipients.push("guest");
    },
    fail: () => {
      failAnalysis = true;
    },
    duringCapture: (operation: () => Promise<void>) => {
      duringCapture = operation;
    },
    during: (operation: () => Promise<void>) => {
      duringAnalysis = operation;
    },
    changeLive: () => {
      live.sections.transcript = {
        state: "unavailable",
        sourceBlockId: "transcript",
        reasons: [{ code: "transcript-unavailable", message: "private" }]
      };
    },
    revise: async () => {
      live = structuredClone(raw);
      live.sections.transcript = {
        state: "available",
        sourceBlockId: "transcript",
        text: "Wir starten jetzt. Die alte Aussage ist überholt.",
        blocks: []
      };
      observation = observedMeetingNoteToObservation(
        {
          workspace,
          source: await ledger.record({
            workspaceId: workspace.workspaceId,
            source: identity,
            providerVersion: "v2",
            snapshot: live,
            observedAt: "2026-09-11T11:00:00.000Z"
          })
        },
        "linear"
      );
    },
    snapshot: async () => {
      const result = await mi.query({
        workspaceId: workspace.workspaceId,
        meetingId: observation.meetingId,
        query: { type: "snapshot" }
      });
      if (result.type !== "snapshot") throw new Error("wrong query");
      return result.state;
    },
    conclude: () =>
      mi.conclude({
        workspaceId: workspace.workspaceId,
        meetingId: observation.meetingId
      })
  };
}

describe("governed imported transcript understanding", () => {
  it("analyzes accepted original speech into grounded Meeting understanding exactly once and keeps provider notes distinct", async () => {
    const f = await fixture();
    try {
      expect((await f.ingest()).analysisStatus).toBe("completed");
      const state = await f.snapshot();
      expect(state.decisions[0]?.statement).toBe(
        raw.sections.transcript.state === "available" ? raw.sections.transcript.text : ""
      );
      expect(state.actionItems[0]?.ownerId).toBeNull();
      expect(state.actionItems[0]?.ownership?.status).toBe("proposed");
      expect(state.openQuestions).toHaveLength(1);
      expect(state.risks).toHaveLength(1);
      expect(state.followUpIntentions[0]?.status).toBe("suggested");
      expect(state.decisions[0]?.provenance.evidence[0]).toMatchObject({
        source: "transcript",
        sourceObjectId: "transcript"
      });
      expect(
        f.requests[0]?.evidence.find((item) => item.sourceObjectId === "summary")?.source
      ).toBe("knowledge");
      expect(
        f.requests[0]?.evidence.find((item) => item.source === "transcript")
          ?.participantId
      ).toBeUndefined();
      f.restart();
      expect((await f.ingest()).duplicateObservationIds).toEqual([
        f.observation().observationId
      ]);
      expect(f.requests).toHaveLength(1);
      expect((await f.conclude()).decisions).toHaveLength(1);
    } finally {
      await f.database.close();
    }
  });

  it.each(["revoke", "changeLive", "widen"] as const)(
    "withholds derived and raw imported material after %s, including cached conclusions and execution",
    async (mode) => {
      const f = await fixture();
      try {
        await f.ingest();
        await f.conclude();
        f[mode]();
        f.restart();
        const state = await f.snapshot();
        expect(state.decisions).toEqual([]);
        expect(state.importedActionItemCandidates).toEqual([]);
        expect(state.importedSources).toEqual([]);
        expect(JSON.stringify(state)).not.toContain("Wir pausieren");
        expect(JSON.stringify(await f.conclude())).not.toContain("Wir pausieren");
        const query = await f.current().query({
          workspaceId: workspace.workspaceId,
          meetingId: f.observation().meetingId,
          query: { type: "freeform", text: "What did we decide?" }
        });
        expect(JSON.stringify(query)).not.toContain("Wir pausieren");
        const guard = createMeetingContextGuard({
          database: f.database,
          importedSourceAnalysis: f.importedSourceAnalysis
        });
        await expect(
          guard.requireIntentCurrent({
            workspaceId: workspace.workspaceId,
            meetingId: f.observation().meetingId,
            intentId: "record-imported"
          })
        ).rejects.toThrow();
        const retained = await f.ledger.get({
          workspaceId: workspace.workspaceId,
          source: identity,
          revision: 1
        });
        expect(retained?.snapshot).toEqual(raw);
      } finally {
        await f.database.close();
      }
    }
  );

  it("retains unauthorized Evidence and analyzes an already accepted import once a fresh explicit grant permits its first analysis", async () => {
    const f = await fixture();
    try {
      f.revoke();
      const result = await f.ingest();
      expect(result.acceptedObservationIds).toHaveLength(1);
      expect(result.analysisStatus).toBe("deferred");
      expect(result.errors).toContainEqual({
        code: "context-unavailable",
        retryable: true,
        partialResultAvailable: true
      });
      expect(f.requests).toHaveLength(0);
      expect((await f.snapshot()).importedSources).toEqual([]);
      f.allow();
      const replay = await f.ingest();
      expect(replay.duplicateObservationIds).toHaveLength(1);
      expect(replay.analysisStatus).toBe("completed");
      expect(f.requests).toHaveLength(1);
      await f.ingest();
      expect(f.requests).toHaveLength(1);
    } finally {
      await f.database.close();
    }
  });

  it.each(["revoke", "supersede"] as const)(
    "requires sharing and ledger head to remain valid across the live source read: %s",
    async (mode) => {
      const f = await fixture();
      try {
        f.duringCapture(async () => {
          if (mode === "revoke") f.revoke();
          else await f.revise();
        });
        expect((await f.ingest()).analysisStatus).toBe("deferred");
        expect(f.requests).toHaveLength(0);
      } finally {
        await f.database.close();
      }
    }
  );

  it("does not dispatch the same accepted import concurrently", async () => {
    const f = await fixture();
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      f.during(async () => {
        entered!();
        await pending;
      });
      const first = f.ingest();
      await running;
      const second = f.ingest();
      expect(f.requests).toHaveLength(1);
      release!();
      expect((await first).analysisStatus).toBe("completed");
      expect((await second).duplicateObservationIds).toHaveLength(1);
    } finally {
      release?.();
      await f.database.close();
    }
  });

  it("analyzes an existing source-only import after enabling granted analysis without reimporting its Evidence", async () => {
    const f = await fixture();
    try {
      f.configure(false);
      expect((await f.ingest()).analysisStatus).toBe("not-needed");
      f.configure(true);
      expect((await f.ingest()).analysisStatus).toBe("completed");
      expect(f.requests).toHaveLength(1);
      expect((await f.snapshot()).importedSources).toHaveLength(1);
    } finally {
      await f.database.close();
    }
  });

  it("withholds legacy reconciliation provenance until its original source grant is admitted", async () => {
    const f = await fixture();
    try {
      f.configure(false);
      await f.ingest();
      const before = await f.snapshot();
      const review = before.actionItemReconciliationReviews[0]!;
      await f.current().observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "legacy-review",
            workspaceId: workspace.workspaceId,
            meetingId: f.observation().meetingId,
            observedAt: time,
            occurredAt: time,
            participantId: "jakob",
            judgment: {
              kind: "resolve-action-item-reconciliation",
              reviewId: review.id,
              resolution: {
                type: "select-needs-clarification",
                reason: "Discuss source candidate"
              }
            }
          }
        ]
      });
      const legacy = await f.snapshot();
      expect(legacy.followUpIntentions).toHaveLength(1);
      expect(legacy.followUpIntentions[0]?.provenance.contextReceiptIds).toBeUndefined();
      f.configure(true);
      expect((await f.snapshot()).followUpIntentions).toEqual([]);
      const guard = createMeetingContextGuard({
        database: f.database,
        importedSourceAnalysis: f.importedSourceAnalysis
      });
      await expect(
        guard.requireIntentCurrent({
          workspaceId: workspace.workspaceId,
          meetingId: f.observation().meetingId,
          intentId: legacy.followUpIntentions[0]!.id
        })
      ).rejects.toThrow();
    } finally {
      await f.database.close();
    }
  });

  it("retries an admitted import only after a proved pre-dispatch refusal", async () => {
    const f = await fixture();
    try {
      f.preDispatch(true);
      expect((await f.ingest()).analysisStatus).toBe("deferred");
      f.preDispatch(false);
      f.restart();
      expect((await f.ingest()).analysisStatus).toBe("completed");
      expect(f.requests).toHaveLength(2);
      await f.ingest();
      expect(f.requests).toHaveLength(2);
    } finally {
      await f.database.close();
    }
  });

  it("rejects a model result when a source changes during the call", async () => {
    const f = await fixture();
    try {
      f.during(() => {
        f.changeLive();
        return Promise.resolve();
      });
      expect((await f.ingest()).analysisStatus).toBe("deferred");
      expect((await f.snapshot()).decisions).toEqual([]);
      await f.ingest();
      expect(f.requests).toHaveLength(1);
    } finally {
      await f.database.close();
    }
  });

  it("analyzes one later source revision without reviving stale claims or overriding an independent Human correction", async () => {
    const f = await fixture();
    try {
      await f.ingest();
      await f.current().observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "human-decision",
            workspaceId: workspace.workspaceId,
            meetingId: f.observation().meetingId,
            observedAt: time,
            occurredAt: time,
            participantId: "jakob",
            judgment: {
              kind: "correct",
              meetingItemId: "decision:launch",
              correction: {
                statement: "Jakob decides to wait for the founder meeting.",
                status: "confirmed"
              }
            }
          }
        ]
      });
      await f.revise();
      expect((await f.ingest()).analysisStatus).toBe("completed");
      const state = await f.snapshot();
      expect(state.decisions[0]?.statement).toBe(
        "Jakob decides to wait for the founder meeting."
      );
      expect(
        state.decisions[0]?.provenance.evidence.every(
          (item) => item.source === "human-judgment"
        )
      ).toBe(true);
      expect(state.importedSources.map((source) => source.sourceRevision)).toEqual([2]);
      expect(JSON.stringify(state)).not.toContain("Wir pausieren");
      await f.ingest();
      expect(f.requests).toHaveLength(2);
    } finally {
      await f.database.close();
    }
  });

  it("exposes model-budget failures and preserves import idempotency across restart", async () => {
    const f = await fixture();
    try {
      f.fail();
      const result = await f.ingest();
      expect(result.analysisStatus).toBe("deferred");
      expect(result.errors).toContainEqual({
        code: "analysis-provider-quota",
        retryable: false
      });
      expect(JSON.stringify(result)).not.toContain("private provider diagnostic");
      f.restart();
      await f.ingest();
      expect(f.requests).toHaveLength(1);
      expect((await f.snapshot()).importedSources).toHaveLength(1);
    } finally {
      await f.database.close();
    }
  });
});
