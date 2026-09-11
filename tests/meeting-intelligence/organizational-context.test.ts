import { describe, expect, it } from "vitest";
import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel,
  StructuredReasoningRequest
} from "../../src/ai/reasoning-model.js";
import type { MeetingObservation, MeetingState } from "../../src/domain/model.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createMeetingContextGuard } from "../../src/meeting-intelligence/context-guard.js";
import type { MeetingIntelligence } from "../../src/meeting-intelligence/interface.js";
import type {
  ContextAudience,
  OrganizationalContext,
  OrganizationalContextBundle,
  OrganizationalContextRequest
} from "../../src/organizational-context/interface.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";

const workspace = { workspaceId: "dayova", timezone: "Europe/Berlin" };
const meetingId = "context-meeting";
const time = "2026-09-10T10:00:00.000Z";
const founders: ContextAudience = {
  workspaceId: workspace.workspaceId,
  personIds: ["jakob", "fabius", "julius", "philipp"]
};

describe("Meeting Intelligence organizational context", () => {
  it("supplies configured founder context, citations and bounded prior Human state to actual analysis", async () => {
    const db = await createPgliteDatabase();
    try {
      const local = model((request) => proposal(request, "independent", "Local work"));
      const legacy = createMeetingIntelligence({
        database: db,
        reasoningModel: local.port
      });
      await begin(legacy);
      await observe(legacy, "local", "I will prepare the release checklist.");
      await correct(legacy, "action:independent", "Prepare the Human checklist");
      const org = organizational();
      const reasoning = model((request) =>
        proposal(request, "derived", "Use the documented retention policy", true)
      );
      const mi = createMeetingIntelligence({
        database: db,
        reasoningModel: reasoning.port,
        organizationalContext: org.port,
        contextAudience: () => Promise.resolve(founders)
      });
      const update = await observe(
        mi,
        "with-context",
        "We should apply the retention policy."
      );
      expect(update.analysisStatus).toBe("completed");
      expect(update.errors).toEqual([]);
      expect(update.acceptedObservationIds).toEqual(["with-context"]);
      expect(org.requests[0]?.audience).toEqual(founders);
      expect(org.requests[0]?.audience.personIds).not.toContain("guest-attendee");
      expect(org.requests[0]?.concepts).toContain("retention");
      const request = reasoning.requests[0]!;
      const prior = JSON.parse(request.context[0]!) as {
        currentItems: Array<{ id: string; humanConfirmed: boolean }>;
      };
      expect(prior.currentItems).toContainEqual(
        expect.objectContaining({ id: "action:independent", humanConfirmed: true })
      );
      const external = JSON.parse(request.context[1]!) as {
        sources: Array<{
          version: string;
          standing: string;
          externalReference: { url: string };
        }>;
        retrieval: { complete: boolean };
      };
      expect(external.sources[0]).toMatchObject({
        version: "v1",
        standing: "proposed",
        externalReference: { url: "https://example.test/policy" }
      });
      expect(external.retrieval.complete).toBe(false);
      const state = await snapshot(mi);
      const provenance = state.actionItems.find(
        (item) => item.id === "action:derived"
      )?.provenance;
      expect(provenance?.contextReceiptIds).toEqual(["receipt-1"]);
      expect(provenance?.contextCoverage).toEqual({ complete: false });
      expect(state.contextAvailability).toMatchObject({
        status: "partial",
        withheldItemCount: 0
      });
      expect(
        provenance?.evidence.some(
          (item) => item.source === "knowledge" && item.sourceVersion === "v1"
        )
      ).toBe(true);
      await observe(
        mi,
        "second-question",
        "We should discuss the retention implementation."
      );
      expect(reasoning.requests).toHaveLength(2);
      expect(reasoning.requests[1]?.context[0]).toContain("action:derived");
    } finally {
      await db.close();
    }
  });

  it("withholds revoked derived views and cached conclusions while retaining original observations and independent items", async () => {
    const db = await createPgliteDatabase();
    try {
      const legacy = createMeetingIntelligence({
        database: db,
        reasoningModel: model((request) =>
          proposal(request, "local", "Independent local task")
        ).port
      });
      await begin(legacy);
      await observe(legacy, "local", "I will do an independent local task.");
      const org = organizational();
      const mi = createMeetingIntelligence({
        database: db,
        reasoningModel: model((request) =>
          proposal(request, "secret", "Private organizational plan", true, true)
        ).port,
        organizationalContext: org.port,
        contextAudience: () => Promise.resolve(founders)
      });
      await observe(mi, "derived", "We should apply the retention policy.");
      const before = await mi.conclude({ workspaceId: workspace.workspaceId, meetingId });
      expect(JSON.stringify(before)).toContain("Private organizational plan");
      org.invalid.add("receipt-1");
      const current = await snapshot(mi);
      expect(current.actionItems.map((item) => item.id)).toEqual(["action:local"]);
      expect(current.contextAvailability).toMatchObject({
        status: "partial",
        withheldItemCount: 2
      });
      const query = await mi.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "freeform", text: "What are our action items?" }
      });
      expect(JSON.stringify(query)).not.toContain("Private organizational plan");
      expect(query).toMatchObject({ answer: { uncertainty: "partial" } });
      const after = await mi.conclude({ workspaceId: workspace.workspaceId, meetingId });
      expect(JSON.stringify(after)).not.toContain("Private organizational plan");
      expect(after.actionItems[0]?.description).toBe("Independent local task");
      expect(after.summary.brief).toContain("unavailable");
      const guard = createMeetingContextGuard({
        database: db,
        organizationalContext: org.port,
        contextAudience: () => Promise.resolve(founders)
      });
      await expect(
        guard.requireIntentCurrent({
          workspaceId: workspace.workspaceId,
          meetingId,
          intentId: "record-secret"
        })
      ).rejects.toThrow("unavailable");
      const rows = await db.query<{ count: number }>(
        "SELECT COUNT(*)::integer AS count FROM meeting_observations"
      );
      expect(rows.rows[0]?.count).toBe(3);
      const retained = await db.query<{ state_json: string }>(
        "SELECT state_json FROM meetings"
      );
      expect(retained.rows[0]?.state_json).toContain("Private organizational plan");
    } finally {
      await db.close();
    }
  });

  it("preserves an explicit Human replacement independently without inherited private rationale, fields or excerpts", async () => {
    const db = await createPgliteDatabase();
    try {
      const org = organizational();
      const mi = createMeetingIntelligence({
        database: db,
        organizationalContext: org.port,
        contextAudience: () => Promise.resolve(founders),
        reasoningModel: model((request) =>
          proposal(request, "replace", "Private AI task", true)
        ).port
      });
      await begin(mi);
      await observe(mi, "source", "We should apply the retention policy.");
      await mi.observe({
        workspace,
        observations: [
          {
            ...base("confirm"),
            type: "human-judgment-recorded",
            participantId: "jakob",
            judgment: { kind: "confirm", meetingItemId: "action:replace" }
          }
        ]
      });
      org.invalid.add("receipt-1");
      expect((await snapshot(mi)).actionItems).toEqual([]);
      await correct(mi, "action:replace", "Jakob's independently corrected task");
      const corrected = (await snapshot(mi)).actionItems[0]!;
      expect(corrected.description).toBe("Jakob's independently corrected task");
      expect(corrected.provenance.contextReceiptIds).toBeUndefined();
      expect(
        corrected.provenance.evidence.every((item) => item.source === "human-judgment")
      ).toBe(true);
      expect(corrected.ownerId).toBeNull();
      expect(corrected.dueDate).toBeNull();
      expect(JSON.stringify(corrected)).not.toContain("PRIVATE SOURCE CONTENT");
      await observe(mi, "again", "Revisit the retention policy.");
      expect((await snapshot(mi)).actionItems[0]?.description).toBe(
        "Jakob's independently corrected task"
      );
    } finally {
      await db.close();
    }
  });

  it("discards one paid result if its source changes during analysis and allows a fresh later observation", async () => {
    const db = await createPgliteDatabase();
    try {
      const org = organizational();
      const started = deferred();
      const release = deferred();
      const reasoning = model(async (request) => {
        if (reasoning.requests.length === 1) {
          started.resolve();
          await release.promise;
        }
        return proposal(request, "delayed", "Grounded current task", true);
      });
      const mi = createMeetingIntelligence({
        database: db,
        reasoningModel: reasoning.port,
        organizationalContext: org.port,
        contextAudience: () => Promise.resolve(founders)
      });
      await begin(mi);
      const inFlight = observe(mi, "first", "Apply the retention policy.");
      await started.promise;
      org.invalid.add("receipt-1");
      release.resolve();
      const first = await inFlight;
      expect(first.analysisStatus).toBe("deferred");
      expect(first.errors).toContainEqual(
        expect.objectContaining({ code: "context-unavailable" })
      );
      expect(reasoning.requests).toHaveLength(1);
      expect((await snapshot(mi)).actionItems).toEqual([]);
      const second = await observe(mi, "second", "Recheck the retention policy.");
      expect(second.analysisStatus).toBe("completed");
      expect(reasoning.requests).toHaveLength(2);
      expect((await snapshot(mi)).actionItems[0]?.provenance.contextReceiptIds).toEqual([
        "receipt-2"
      ]);
      const retained = await db.query<{ count: number }>(
        "SELECT COUNT(*)::integer AS count FROM utterance_versions"
      );
      expect(retained.rows[0]?.count).toBe(2);
    } finally {
      await db.close();
    }
  });

  it("checks source eligibility before paid use and bounds inherited context across later questions", async () => {
    const db = await createPgliteDatabase();
    try {
      const org = organizational();
      org.invalid.add("receipt-1");
      const reasoning = model((request) =>
        proposal(request, "rolling", "Current retention task", true)
      );
      const mi = createMeetingIntelligence({
        database: db,
        reasoningModel: reasoning.port,
        organizationalContext: org.port,
        contextAudience: () => Promise.resolve(founders)
      });
      await begin(mi);
      expect((await observe(mi, "prepaid", "Discuss retention.")).analysisStatus).toBe(
        "deferred"
      );
      expect(reasoning.requests).toHaveLength(0);
      for (let index = 0; index < 12; index += 1) {
        expect(
          (await observe(mi, `rolling-${index}`, "Discuss retention implementation."))
            .analysisStatus
        ).toBe("completed");
      }
      expect(reasoning.requests).toHaveLength(12);
      expect(
        (await snapshot(mi)).actionItems[0]?.provenance.contextReceiptIds!.length
      ).toBeLessThanOrEqual(9);
      expect(
        reasoning.requests.some((request) => {
          const prior = JSON.parse(request.context[0]!) as {
            coverage: { complete: boolean };
          };
          return !prior.coverage.complete;
        })
      ).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("does not turn a source-only statement into a Meeting commitment and checks current audience on replay", async () => {
    const db = await createPgliteDatabase();
    try {
      const org = organizational();
      let activeAudience: ContextAudience | null = founders;
      let sourceOnly = true;
      const reasoning = model((request) => {
        const result = proposal(request, "boundary", "Policy action", true);
        if (sourceOnly)
          result.actionItems[0]!.evidenceIds = request.evidence
            .filter((item) => item.source === "knowledge")
            .map((item) => item.evidenceId);
        return result;
      });
      const mi = createMeetingIntelligence({
        database: db,
        reasoningModel: reasoning.port,
        organizationalContext: org.port,
        contextAudience: () => Promise.resolve(activeAudience)
      });
      await begin(mi);
      expect(
        (await observe(mi, "source-only", "Discuss the policy.")).analysisStatus
      ).toBe("deferred");
      expect((await snapshot(mi)).actionItems).toEqual([]);
      sourceOnly = false;
      await observe(mi, "grounded", "Apply the policy.");
      expect((await snapshot(mi)).actionItems).toHaveLength(1);
      activeAudience = { ...founders, personIds: [...founders.personIds, "guest"] };
      expect((await snapshot(mi)).actionItems).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("keys conclusion reuse by the actual eligible view when equal numbers of items are withheld", async () => {
    const db = await createPgliteDatabase();
    try {
      const org = organizational();
      let identity = "one";
      const mi = createMeetingIntelligence({
        database: db,
        reasoningModel: model((request) =>
          proposal(request, identity, `Private ${identity}`, true)
        ).port,
        organizationalContext: org.port,
        contextAudience: () => Promise.resolve(founders)
      });
      await begin(mi);
      await observe(mi, "first", "Discuss the policy.");
      org.invalid.add("receipt-1");
      identity = "two";
      await observe(mi, "second", "Revisit the policy.");
      const two = await mi.conclude({ workspaceId: workspace.workspaceId, meetingId });
      expect(two.actionItems.map((item) => item.description)).toEqual(["Private two"]);
      org.invalid.delete("receipt-1");
      org.invalid.add("receipt-2");
      const one = await mi.conclude({ workspaceId: workspace.workspaceId, meetingId });
      expect(one.actionItems.map((item) => item.description)).toEqual(["Private one"]);
      expect(JSON.stringify(one)).not.toContain("Private two");
    } finally {
      await db.close();
    }
  });

  it("does not release cached conclusions or question text when a source is revoked immediately after its entry check", async () => {
    const db = await createPgliteDatabase();
    try {
      const org = organizational();
      const mi = createMeetingIntelligence({
        database: db,
        reasoningModel: model((request) =>
          proposal(request, "late", "PRIVATE LATE RESULT", true)
        ).port,
        organizationalContext: org.port,
        contextAudience: () => Promise.resolve(founders)
      });
      await begin(mi);
      await observe(mi, "first", "Discuss the retention policy.");
      expect(
        JSON.stringify(
          await mi.conclude({ workspaceId: workspace.workspaceId, meetingId })
        )
      ).toContain("PRIVATE LATE RESULT");
      org.onNextCurrent(() => org.invalid.add("receipt-1"));
      const revokedCache = await mi.conclude({
        workspaceId: workspace.workspaceId,
        meetingId
      });
      expect(JSON.stringify(revokedCache)).not.toContain("PRIVATE LATE RESULT");
      expect(revokedCache.contextAvailability?.status).toBe("unavailable");
      org.invalid.delete("receipt-1");
      org.onNextCurrent(() => org.invalid.add("receipt-1"));
      const revokedQuery = await mi.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "freeform", text: "What are our action items?" }
      });
      expect(JSON.stringify(revokedQuery)).not.toContain("PRIVATE LATE RESULT");
    } finally {
      await db.close();
    }
  });

  it("checks canonical related-item dependencies transitively even when a legacy intent has no direct receipt", async () => {
    const db = await createPgliteDatabase();
    try {
      const org = organizational();
      const withContext = createMeetingIntelligence({
        database: db,
        organizationalContext: org.port,
        contextAudience: () => Promise.resolve(founders),
        reasoningModel: model((request) => {
          const result = proposal(request, "unused", "unused", true);
          return {
            ...result,
            actionItems: [],
            decisions: [
              {
                stableKey: "policy",
                statement: "Private policy decision",
                rationale: [],
                status: "candidate",
                supportingParticipantIds: [],
                objectingParticipantIds: [],
                relatedTopicIds: [],
                evidenceIds: result.actionItems[0]!.evidenceIds,
                confidence: "high"
              }
            ]
          };
        }).port
      });
      await begin(withContext);
      await observe(withContext, "decision", "Discuss the retention decision.");
      const local = createMeetingIntelligence({
        database: db,
        reasoningModel: model((request) => {
          const result = proposal(
            request,
            "dependent",
            "Task linked to policy",
            false,
            true
          );
          result.actionItems[0]!.relatedDecisionIds = ["decision:policy"];
          result.followUpIntentions = [
            {
              id: "linked-intent",
              type: "create-work-item",
              title: "Task linked to policy",
              description: "Task linked to policy",
              assigneeId: null,
              mentionPersonIds: [],
              dueDate: null,
              relatedMeetingItemIds: ["action:dependent"],
              evidenceIds: result.actionItems[0]!.evidenceIds,
              confidence: "high"
            }
          ];
          return result;
        }).port
      });
      await observe(local, "link", "We need a task linked to decision policy.");
      const guard = createMeetingContextGuard({
        database: db,
        organizationalContext: org.port,
        contextAudience: () => Promise.resolve(founders)
      });
      await expect(
        guard.requireIntentCurrent({
          workspaceId: workspace.workspaceId,
          meetingId,
          intentId: "linked-intent"
        })
      ).resolves.toBeUndefined();
      org.invalid.add("receipt-1");
      await expect(
        guard.requireIntentCurrent({
          workspaceId: workspace.workspaceId,
          meetingId,
          intentId: "linked-intent"
        })
      ).rejects.toThrow("unavailable");
      expect((await snapshot(withContext)).followUpIntentions).toEqual([]);
      expect((await snapshot(withContext)).actionItems).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

function model(
  handler: (
    request: StructuredReasoningRequest<MeetingAnalysisProposalBatch>
  ) => MeetingAnalysisProposalBatch | Promise<MeetingAnalysisProposalBatch>
) {
  const requests: StructuredReasoningRequest<MeetingAnalysisProposalBatch>[] = [];
  const port: ReasoningModel = {
    generateStructured<T>(request: StructuredReasoningRequest<T>) {
      const typed = request as StructuredReasoningRequest<MeetingAnalysisProposalBatch>;
      requests.push(typed);
      return Promise.resolve(handler(typed)).then((value) => ({
        value: value as T,
        metadata: {
          provider: "test",
          model: "deterministic",
          promptVersion: request.promptVersion
        }
      }));
    }
  };
  return { port, requests };
}
function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function proposal(
  request: StructuredReasoningRequest<MeetingAnalysisProposalBatch>,
  key: string,
  description: string,
  includeExternal = false,
  record = false
): MeetingAnalysisProposalBatch {
  const local = request.evidence.find((item) => item.source === "transcript")!;
  const ids = [
    local.evidenceId,
    ...(includeExternal
      ? request.evidence
          .filter((item) => item.source === "knowledge")
          .map((item) => item.evidenceId)
      : [])
  ];
  return {
    actionItems: [
      {
        stableKey: key,
        description,
        ownerId: "jakob",
        dueDate: {
          originalPhrase: null,
          normalizedDate: "2026-09-11",
          confidence: "exact",
          timezone: "Europe/Berlin"
        },
        status: "candidate",
        relatedDecisionIds: [],
        evidenceIds: ids,
        confidence: "high"
      }
    ],
    decisions: [],
    openQuestions: [],
    risks: [],
    followUpIntentions: record
      ? [
          {
            id: `record-${key}`,
            type: "record-meeting",
            title: description,
            relatedMeetingItemIds: [`action:${key}`],
            evidenceIds: ids,
            confidence: "high"
          }
        ]
      : []
  };
}
function organizational() {
  const invalid = new Set<string>();
  const requests: OrganizationalContextRequest[] = [];
  let nextCurrent: (() => void) | undefined;
  const port: OrganizationalContext = {
    retrieve(request): Promise<OrganizationalContextBundle> {
      requests.push(request);
      const index = requests.length;
      return Promise.resolve({
        receiptId: `receipt-${index}`,
        sources: [
          {
            id: "policy",
            kind: "knowledge-document",
            title: "Retention policy",
            content: "PRIVATE SOURCE CONTENT: preserve history",
            version: `v${index}`,
            updatedAt: time,
            externalReference: {
              providerId: "knowledge-reader",
              objectType: "document",
              externalId: "policy",
              url: "https://example.test/policy",
              version: `v${index}`
            },
            standing: "proposed",
            authority: "source",
            catalogId: "explicit-catalog",
            snapshotId: `snapshot-${index}`,
            excerptTruncated: false,
            duplicates: []
          }
        ],
        retrieval: {
          complete: false,
          warnings: ["Some sources are not indexed."],
          considered: 1,
          selected: 1,
          characters: 47
        }
      });
    },
    requireCurrent(_request, receiptId) {
      const after = nextCurrent;
      nextCurrent = undefined;
      if (after) queueMicrotask(after);
      return invalid.has(receiptId)
        ? Promise.reject(new Error("source changed"))
        : Promise.resolve();
    }
  };
  return {
    port,
    invalid,
    requests,
    onNextCurrent: (callback: () => void) => {
      nextCurrent = callback;
    }
  };
}
function base(id: string) {
  return {
    observationId: id,
    workspaceId: workspace.workspaceId,
    meetingId,
    occurredAt: time,
    observedAt: time
  };
}
async function begin(mi: MeetingIntelligence) {
  await mi.observe({
    workspace,
    observations: [
      {
        ...base("start"),
        type: "meeting-started",
        title: "Retention policy",
        startedAt: time,
        languageMode: "en",
        participantIds: ["guest-attendee"]
      }
    ]
  });
}
async function observe(mi: MeetingIntelligence, id: string, text: string) {
  return mi.observe({
    workspace,
    observations: [
      {
        ...base(id),
        type: "utterance-committed",
        utteranceId: id,
        version: 1,
        speaker: {
          status: "unresolved",
          candidatePersonId: null,
          confidence: "unknown",
          basis: "provider-speaker-label"
        },
        startedAt: time,
        endedAt: time,
        originalText: text,
        language: "en"
      } satisfies MeetingObservation
    ]
  });
}
async function correct(mi: MeetingIntelligence, itemId: string, statement: string) {
  await mi.observe({
    workspace,
    observations: [
      {
        ...base(`correct-${itemId}`),
        type: "human-judgment-recorded",
        participantId: "jakob",
        judgment: { kind: "correct", meetingItemId: itemId, correction: { statement } }
      }
    ]
  });
}
async function snapshot(mi: MeetingIntelligence): Promise<MeetingState> {
  const result = await mi.query({
    workspaceId: workspace.workspaceId,
    meetingId,
    query: { type: "snapshot" }
  });
  if (result.type !== "snapshot") throw new Error("wrong result");
  return result.state;
}
