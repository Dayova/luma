import { describe, expect, it } from "vitest";
import type { CaptureSynthesisProposal } from "../../src/ai/capture-synthesis-proposal.js";
import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel,
  StructuredReasoningRequest
} from "../../src/ai/reasoning-model.js";
import type { MeetingCaptureRevision } from "../../src/logical-meetings/interface.js";
import type { MeetingImportedFromSource } from "../../src/domain/model.js";
import { createLogicalMeetings } from "../../src/logical-meetings/logical-meetings.js";
import {
  createObservedSourceLedger,
  type RawMeetingNoteSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { observedMeetingNoteToObservation } from "../../src/knowledge/meeting-notes-ingestion.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createMeetingContextGuard } from "../../src/meeting-intelligence/context-guard.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";

const workspace = { workspaceId: "workspace_dayova", timezone: "Europe/Berlin" };
const at = "2026-09-11T09:00:00.000Z";
function revision(
  provider: string,
  captureId = provider,
  sourceRevision = 1,
  calendar = "weekly"
): MeetingCaptureRevision {
  const verbatim = provider === "notion";
  const externalReference = {
    providerId: provider,
    externalId: captureId,
    objectType: "document" as const,
    url: `https://example.test/${captureId}`
  };
  return {
    address: {
      providerId: provider,
      providerConnectionId: `${provider}-connection`,
      externalCaptureId: captureId,
      sourceKind: "meeting-capture"
    },
    sourceRevision,
    contentHash: `hash:${captureId}:${sourceRevision}`,
    capturedAt: at,
    providerVersion: `v${sourceRevision}`,
    eligibility: { state: "eligible" },
    availability: "complete",
    capabilities: {
      rawTranscript: verbatim ? "available" : "unavailable",
      enhancedNotes: "available",
      speakerIdentity: "unavailable",
      attendees: "unavailable",
      revisionMetadata: "available"
    },
    identityFacts: {
      calendarEventKeys: calendar ? [calendar] : [],
      conferenceKeys: [],
      interval: null,
      attendeePersonIds: [],
      titleFingerprint: "same-title",
      contextKeys: []
    },
    materials: [
      {
        kind: verbatim ? "verbatim-transcript" : "derived-notes",
        provenance: verbatim ? "original-speech" : "provider-derived",
        sourceObjectId: `material:${captureId}`,
        sourceVersion: `${sourceRevision}`,
        externalReference
      }
    ],
    externalReference
  };
}
const raw: RawMeetingNoteSnapshot = {
  schemaVersion: 1,
  title: "Private release discussion",
  lifecycle: "ready",
  calendar: {
    startAt: at,
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
  const revisions = new Map<string, MeetingCaptureRevision>();
  let sourceAllowed = true;
  let imported: MeetingImportedFromSource | undefined;
  let calls = 0;
  const logicalMeetings = createLogicalMeetings({
    database,
    captureRevisionVerifier: {
      verify: ({ revision: value }) =>
        Promise.resolve(
          revisions.get(value.address.externalCaptureId)?.contentHash ===
            value.contentHash
            ? { status: "verified" }
            : { status: "rejected", message: "Unknown capture" }
        )
    }
  });
  const reasoningModel: ReasoningModel = {
    generateStructured<T>(request: StructuredReasoningRequest<T>) {
      calls++;
      const original =
        request.evidence.find((item) => item.source === "transcript") ??
        request.evidence[0]!;
      const value: CaptureSynthesisProposal | MeetingAnalysisProposalBatch =
        request.promptVersion === "capture-synthesis-v1"
          ? {
              claims: [
                {
                  key: "action",
                  kind: "action-item",
                  text: "Prepare the source-bound export review.",
                  confidence: "medium",
                  evidenceIds: [request.evidence[0]!.evidenceId],
                  quotations: [],
                  conflictingKeys: []
                }
              ]
            }
          : {
              decisions: [
                {
                  stableKey: "launch",
                  statement: "Pause the launch until export review.",
                  status: "candidate",
                  rationale: [],
                  supportingParticipantIds: [],
                  objectingParticipantIds: [],
                  relatedTopicIds: [],
                  evidenceIds: [original.evidenceId],
                  confidence: "high"
                }
              ],
              actionItems: [],
              openQuestions: [],
              risks: [],
              followUpIntentions: []
            };
      return Promise.resolve({
        value: value as T,
        metadata: {
          provider: "fixture",
          model: "fixture",
          promptVersion: request.promptVersion
        }
      });
    }
  };
  const importedSourceAnalysis = {
    audience: () =>
      Promise.resolve({
        workspaceId: workspace.workspaceId,
        personIds: ["person_jakob", "person_fabius"]
      }),
    access: {
      requireCurrent: () =>
        sourceAllowed ? Promise.resolve() : Promise.reject(new Error("Revoked import"))
    }
  };
  const createMI = () =>
    createMeetingIntelligence({
      database,
      reasoningModel,
      importedSourceAnalysis,
      importedSourceObservationVerifier: {
        verify: ({ observation }) =>
          Promise.resolve(
            JSON.stringify(observation) === JSON.stringify(imported)
              ? { status: "verified" }
              : {
                  status: "rejected",
                  retryable: false,
                  message: "Not the admitted fixture source"
                }
          )
      },
      workCatalogs: [
        {
          providerId: "linear",
          searchWorkItems: () => Promise.resolve([]),
          getWorkItem: () => Promise.reject(new Error("No referenced work item"))
        }
      ],
      captureSynthesis: {
        logicalMeetings,
        audience: importedSourceAnalysis.audience,
        access: {
          readCurrent: ({ capture }) => {
            if (
              !sourceAllowed ||
              revisions.get(capture.address.externalCaptureId)?.contentHash !==
                capture.latestRevision.contentHash
            )
              throw new Error("Revoked capture");
            return Promise.resolve({
              authorizationScopeId: "original-founder-grant",
              canonicalAnchorRef: null,
              materials: capture.latestRevision.materials.map((descriptor) => ({
                descriptor,
                text: "We could prepare the source-bound export review."
              }))
            });
          }
        }
      }
    });
  const mi = createMI();
  const capture = revision("granola");
  revisions.set("granola", capture);
  const resolved = await logicalMeetings.resolveCapture({
    workspaceId: workspace.workspaceId,
    revision: capture
  });
  if (resolved.status !== "accepted")
    throw new Error("Expected positive logical binding");
  const meetingId = resolved.decision.logicalMeeting.id;
  const scope = { workspaceId: workspace.workspaceId, meetingId };
  let seq = 0;
  return {
    database,
    mi,
    scope,
    importedSourceAnalysis,
    calls: () => calls,
    revoke() {
      sourceAllowed = false;
    },
    async importNote() {
      const ledger = createObservedSourceLedger({ database });
      const record = await ledger.record({
        workspaceId: workspace.workspaceId,
        source: {
          providerId: "notion",
          sourceKind: "meeting-note",
          sourceObjectId: "meeting-root",
          parentObjectId: "meeting-page",
          url: "https://notion.so/meeting-page"
        },
        providerVersion: at,
        snapshot: raw,
        observedAt: at
      });
      imported = {
        ...observedMeetingNoteToObservation({ workspace, source: record }, "linear"),
        meetingId
      };
      const result = await mi.observe({ workspace, observations: [imported] });
      expect(result.acceptedObservationIds).toEqual([imported.observationId]);
      return imported;
    },
    async synthesize(nextRevision = 1) {
      const value = revision("granola", "granola", nextRevision);
      revisions.set("granola", value);
      const next = await logicalMeetings.resolveCapture({
        workspaceId: workspace.workspaceId,
        revision: value
      });
      if (next.status !== "accepted") throw new Error("Expected current logical binding");
      const result = await mi.observe({
        workspace,
        observations: [
          {
            type: "meeting-capture-set-observed",
            observationId: `capture-${++seq}`,
            ...scope,
            occurredAt: at,
            observedAt: at,
            captures: next.decision.logicalMeeting.captureRefs.map((c) => ({
              captureId: c.id,
              sourceRevision: c.latestRevision.sourceRevision,
              contentHash: c.latestRevision.contentHash
            }))
          }
        ]
      });
      expect(result.acceptedObservationIds).toHaveLength(1);
      expect(result.analysisStatus).toBe("completed");
      return result;
    },
    async snapshot() {
      const result = await mi.query({ ...scope, query: { type: "snapshot" } });
      if (result.type !== "snapshot") throw new Error("Expected snapshot");
      return result.state;
    }
  };
}

describe("Mixed original and synthesis source projection", () => {
  it("retains authorized imported candidates, reviews and original decisions across capture-set revisions", async () => {
    const f = await fixture();
    try {
      const imported = await f.importNote();
      await f.synthesize();
      const first = await f.snapshot();
      const originalId = imported.candidates[0]!.id;
      expect(
        first.importedActionItemCandidates.map((item) => item.source.source.sourceKind)
      ).toEqual(["meeting-note", "capture-synthesis"]);
      expect(first.currentImportedActionItemCandidateIds).toContain(originalId);
      expect(
        first.actionItemReconciliationReviews.some(
          (item) => item.candidateId === originalId
        )
      ).toBe(true);
      const oldSynthesisId = first.importedActionItemCandidates.find(
        (item) => item.source.source.sourceKind === "capture-synthesis"
      )!.id;
      await f.synthesize(2);
      const next = await f.snapshot();
      expect(next.importedActionItemCandidates.map((item) => item.id)).toContain(
        originalId
      );
      expect(next.currentImportedActionItemCandidateIds).toContain(originalId);
      expect(next.importedActionItemCandidates.map((item) => item.id)).not.toContain(
        oldSynthesisId
      );
      const calls = f.calls();
      for (const query of [
        { type: "freeform", text: "Show decision history" },
        { type: "decision-history", topic: "launch" }
      ] as const) {
        const result = await f.mi.query({ ...f.scope, query });
        if (result.type !== "freeform" && result.type !== "decision-history")
          throw new Error("Expected grounded answer");
        expect(result.answer.text).toContain("Pause the launch");
        expect(result.answer.evidence.some((item) => item.source === "transcript")).toBe(
          true
        );
      }
      expect(f.calls()).toBe(calls);
    } finally {
      await f.database.close();
    }
  });

  it("shared projection withholds synthesis candidates and reconciliation without an owned current proof", async () => {
    const f = await fixture();
    try {
      const imported = await f.importNote();
      await f.synthesize();
      const stored = await f.snapshot();
      const guard = createMeetingContextGuard({
        database: f.database,
        importedSourceAnalysis: f.importedSourceAnalysis
      });
      const projected = await guard.project(stored);
      expect(projected.importedActionItemCandidates.map((item) => item.id)).toEqual(
        imported.candidates.map((item) => item.id)
      );
      expect(
        projected.actionItemReconciliationReviews.every((item) =>
          imported.candidates.some((candidate) => candidate.id === item.candidateId)
        )
      ).toBe(true);
      expect(projected.currentImportedActionItemCandidateIds).toEqual(
        imported.candidates.map((item) => item.id)
      );
      expect((await f.snapshot()).importedActionItemCandidates).toHaveLength(2);
    } finally {
      await f.database.close();
    }
  });

  it("withholds only derived actions when their current synthesis head is unavailable", async () => {
    const f = await fixture();
    try {
      const original = await f.importNote();
      await f.synthesize();
      const stored = await f.snapshot();
      // Simulate an unavailable current projection while retaining canonical
      // Meeting Evidence/history; a retained digest cannot recreate authority.
      await f.database.query(
        "DELETE FROM meeting_capture_synthesis WHERE workspace_id=$1 AND meeting_id=$2",
        [f.scope.workspaceId, f.scope.meetingId]
      );
      const result = await f.snapshot();
      expect(result.importedActionItemCandidates.map((item) => item.id)).toEqual(
        original.candidates.map((item) => item.id)
      );
      expect(
        result.actionItemReconciliationReviews.every((item) =>
          original.candidates.some((candidate) => candidate.id === item.candidateId)
        )
      ).toBe(true);
      expect(result.contextAvailability).toMatchObject({
        status: "partial",
        withheldItemCount: 1
      });
      const answer = await f.mi.query({
        ...f.scope,
        query: { type: "decision-history", topic: "launch" }
      });
      if (answer.type !== "decision-history")
        throw new Error("Expected decision history");
      expect(answer.answer.text).toContain("Pause the launch");
      expect(answer.answer.evidence.some((item) => item.source === "transcript")).toBe(
        true
      );
      const retained = await f.database.query<{ state_json: string }>(
        "SELECT state_json FROM meetings WHERE workspace_id=$1 AND meeting_id=$2",
        [f.scope.workspaceId, f.scope.meetingId]
      );
      expect(JSON.parse(retained.rows[0]!.state_json)).toMatchObject({
        importedActionItemCandidates: stored.importedActionItemCandidates
      });
    } finally {
      await f.database.close();
    }
  });

  it("current grant revocation denies public snapshot, catch-up and reconciliation without erasing originals", async () => {
    const f = await fixture();
    try {
      await f.importNote();
      await f.synthesize();
      const before = await f.database.query<{ state_json: string }>(
        "SELECT state_json FROM meetings WHERE workspace_id=$1 AND meeting_id=$2",
        [f.scope.workspaceId, f.scope.meetingId]
      );
      f.revoke();
      const calls = f.calls();
      for (const query of [
        { type: "snapshot" },
        { type: "catch-up", since: { type: "revision", value: 0 } },
        { type: "action-item-reconciliation-review" },
        { type: "action-item-reconciliation-history" }
      ] as const) {
        await expect(f.mi.query({ ...f.scope, query })).rejects.toThrow();
      }
      await expect(f.mi.conclude(f.scope)).rejects.toThrow();
      expect(f.calls()).toBe(calls);
      const retained = await f.database.query<{ state_json: string }>(
        "SELECT state_json FROM meetings WHERE workspace_id=$1 AND meeting_id=$2",
        [f.scope.workspaceId, f.scope.meetingId]
      );
      expect(retained.rows).toEqual(before.rows);
    } finally {
      await f.database.close();
    }
  });
});
