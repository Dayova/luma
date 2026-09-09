import { describe, expect, it } from "vitest";
import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../../src/ai/reasoning-model.js";
import type { ExternalReference, FollowUpIntent } from "../../src/domain/model.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import type {
  ChangePage,
  CreateDocumentInput,
  KnowledgeDocument,
  KnowledgeProvider,
  KnowledgeQuery,
  KnowledgeResult
} from "../../src/knowledge/interface.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";

class GenericKnowledgeUpdateReasoningModel implements ReasoningModel {
  generateStructured<T>(
    request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    const evidence = request.evidence[0];

    if (!evidence) {
      return Promise.reject(new Error("expected utterance Evidence"));
    }

    const value: MeetingAnalysisProposalBatch = {
      actionItems: [],
      decisions: [],
      openQuestions: [],
      risks: [],
      followUpIntentions: [
        {
          id: "intent:legacy-generic-knowledge",
          type: "update-knowledge",
          title: "Customer policy",
          bodyMarkdown: "## Customer policy\n\nRemember this.",
          relatedMeetingItemIds: [],
          evidenceIds: [evidence.evidenceId],
          confidence: "high"
        },
        {
          id: "intent:record-meeting",
          type: "record-meeting",
          title: "Product meeting",
          relatedMeetingItemIds: [],
          evidenceIds: [evidence.evidenceId],
          confidence: "high"
        }
      ]
    };

    return Promise.resolve({
      value: value as T,
      metadata: {
        provider: "test",
        model: "legacy-generic-knowledge-update",
        promptVersion: request.promptVersion
      }
    });
  }
}

class RecordingKnowledgeProvider implements KnowledgeProvider {
  readonly providerId = "notion-meetings";
  readonly createCalls: CreateDocumentInput[] = [];
  readonly markerLookups: string[] = [];
  marker: ExternalReference | null = null;

  search(_query: KnowledgeQuery): Promise<KnowledgeResult[]> {
    void _query;
    return Promise.resolve([]);
  }

  getDocument(_id: string): Promise<KnowledgeDocument> {
    void _id;
    return Promise.reject(new Error("not needed"));
  }

  createDocument(input: CreateDocumentInput): Promise<ExternalReference> {
    this.createCalls.push(input);
    return Promise.reject(new Error("generic knowledge updates must not write"));
  }

  findCreatedDocumentByIdempotencyKey(
    idempotencyKey: string
  ): Promise<ExternalReference | null> {
    this.markerLookups.push(idempotencyKey);
    return Promise.resolve(this.marker);
  }

  listChanges(_cursor?: string): Promise<ChangePage> {
    void _cursor;
    return Promise.resolve({ changes: [], nextCursor: null });
  }
}

async function createLegacyProposalContext() {
  const database = await createPgliteDatabase();
  const workspace = {
    workspaceId: "workspace_legacy_generic_knowledge",
    timezone: "Europe/Berlin"
  };
  const meetingId = "meeting_legacy_generic_knowledge";
  const meetingIntelligence = createMeetingIntelligence({
    database,
    reasoningModel: new GenericKnowledgeUpdateReasoningModel(),
    now: () => new Date("2026-08-09T11:00:00.000Z")
  });

  await meetingIntelligence.observe({
    workspace,
    observations: [
      {
        type: "utterance-committed",
        observationId: "legacy-generic-knowledge:utterance",
        workspaceId: workspace.workspaceId,
        meetingId,
        occurredAt: "2026-08-09T10:59:00.000Z",
        observedAt: "2026-08-09T10:59:01.000Z",
        utteranceId: "legacy-generic-knowledge:utterance",
        version: 1,
        speaker: {
          status: "attributed",
          personId: "person_jakob",
          confidence: "deterministic",
          basis: "provider-identity"
        },
        startedAt: "2026-08-09T10:58:58.000Z",
        endedAt: "2026-08-09T10:59:00.000Z",
        originalText: "Wir sollten die Customer Policy festhalten.",
        language: "de"
      }
    ]
  });

  return { database, workspace, meetingId, meetingIntelligence };
}

async function snapshotFor(
  context: Awaited<ReturnType<typeof createLegacyProposalContext>>
) {
  const snapshot = await context.meetingIntelligence.query({
    workspaceId: context.workspace.workspaceId,
    meetingId: context.meetingId,
    query: { type: "snapshot" }
  });

  if (snapshot.type !== "snapshot") {
    throw new Error("expected Meeting snapshot");
  }

  return snapshot.state;
}

async function seedHistoricGenericKnowledgeIntent(
  context: Awaited<ReturnType<typeof createLegacyProposalContext>>,
  status: FollowUpIntent["status"]
): Promise<Extract<FollowUpIntent, { type: "update-knowledge" }>> {
  const state = await snapshotFor(context);
  const intent = state.followUpIntentions.find(
    (candidate): candidate is Extract<FollowUpIntent, { type: "update-knowledge" }> =>
      candidate.type === "update-knowledge"
  );

  if (!intent) {
    throw new Error("expected generic knowledge update Intent");
  }

  // The containment policy makes these legacy suggested/approved states
  // unreachable through observe, so this fixture writes only its canonical
  // historical state directly.
  await context.database.query(
    `UPDATE meetings
        SET state_json = $3
      WHERE workspace_id = $1 AND meeting_id = $2`,
    [
      context.workspace.workspaceId,
      context.meetingId,
      JSON.stringify({
        ...state,
        followUpIntentions: state.followUpIntentions.map((candidate) =>
          candidate.id === intent.id ? { ...candidate, status } : candidate
        )
      })
    ]
  );

  return { ...intent, status };
}

async function seedHistoricIndeterminateGenericKnowledgeExecution(
  context: Awaited<ReturnType<typeof createLegacyProposalContext>>
): Promise<{
  intent: Extract<FollowUpIntent, { type: "update-knowledge" }>;
  idempotencyKey: string;
}> {
  const intent = await seedHistoricGenericKnowledgeIntent(
    context,
    "requires-manual-recovery"
  );
  const idempotencyKey = JSON.stringify([
    context.workspace.workspaceId,
    context.meetingId,
    intent.id,
    "execute"
  ]);
  const executionLeaseId = "historic-generic-knowledge-execution";
  const occurredAt = "2026-08-09T11:03:00.000Z";

  await context.database.query(
    `INSERT INTO follow_up_executions (
       workspace_id, meeting_id, intent_id, operation, idempotency_key,
       status, attempts, result_json, execution_lease_id, created_at, updated_at
     ) VALUES ($1, $2, $3, 'execute', $4, 'completed', 1, $5, $6, $7, $7)`,
    [
      context.workspace.workspaceId,
      context.meetingId,
      intent.id,
      idempotencyKey,
      JSON.stringify({
        observation: {
          type: "follow-up-execution-recorded",
          observationId: "historic-generic-knowledge:indeterminate",
          workspaceId: context.workspace.workspaceId,
          meetingId: context.meetingId,
          occurredAt,
          observedAt: occurredAt,
          intentId: intent.id,
          executionLeaseId,
          outcome: {
            status: "failed",
            errorCode: "provider-outcome-unknown",
            message: "The historic provider response could not be proven.",
            retryable: false
          }
        },
        events: [],
        idempotencyKey
      }),
      executionLeaseId,
      occurredAt
    ]
  );

  return { intent, idempotencyKey };
}

async function seedHistoricExecutingGenericKnowledgeExecution(
  context: Awaited<ReturnType<typeof createLegacyProposalContext>>
): Promise<{
  intent: Extract<FollowUpIntent, { type: "update-knowledge" }>;
  idempotencyKey: string;
}> {
  const intent = await seedHistoricGenericKnowledgeIntent(context, "approved");
  const idempotencyKey = JSON.stringify([
    context.workspace.workspaceId,
    context.meetingId,
    intent.id,
    "execute"
  ]);
  const executionLeaseId = "historic-generic-knowledge-executing";
  const occurredAt = "2026-08-09T11:03:00.000Z";

  await context.database.query(
    `INSERT INTO follow_up_executions (
       workspace_id, meeting_id, intent_id, operation, idempotency_key,
       status, attempts, result_json, execution_lease_id, created_at, updated_at
     ) VALUES ($1, $2, $3, 'execute', $4, 'executing', 1, NULL, $5, $6, $6)`,
    [
      context.workspace.workspaceId,
      context.meetingId,
      intent.id,
      idempotencyKey,
      executionLeaseId,
      occurredAt
    ]
  );

  return { intent, idempotencyKey };
}

describe("legacy generic update-knowledge containment", () => {
  it("records a model-proposed generic knowledge update as a non-approvable audit record", async () => {
    const context = await createLegacyProposalContext();

    try {
      const state = await snapshotFor(context);

      expect(state.followUpIntentions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "intent:legacy-generic-knowledge",
            type: "update-knowledge",
            status: "rejected"
          }),
          expect.objectContaining({
            id: "intent:record-meeting",
            type: "record-meeting",
            status: "suggested"
          })
        ])
      );
      expect(
        state.followUpIntentions.filter((intent) => intent.status === "suggested")
      ).toEqual([expect.objectContaining({ id: "intent:record-meeting" })]);
    } finally {
      await context.database.close();
    }
  });

  it("does not approve a historic suggested generic knowledge update", async () => {
    const context = await createLegacyProposalContext();

    try {
      const intent = await seedHistoricGenericKnowledgeIntent(context, "suggested");
      const approval = await context.meetingIntelligence.observe({
        workspace: context.workspace,
        observations: [
          {
            type: "follow-up-intent-approved",
            observationId: "legacy-generic-knowledge:approval",
            workspaceId: context.workspace.workspaceId,
            meetingId: context.meetingId,
            occurredAt: "2026-08-09T11:01:00.000Z",
            observedAt: "2026-08-09T11:01:01.000Z",
            intentId: intent.id,
            approvedBy: "person_jakob"
          }
        ]
      });

      expect(approval.acceptedObservationIds).toEqual([]);
      const approvalError = approval.errors[0];
      if (!approvalError || approvalError.code !== "invalid-observation") {
        throw new Error("expected generic knowledge approval to be rejected");
      }

      expect(approvalError.message).toContain("generic update-knowledge");
      expect(
        (await snapshotFor(context)).followUpIntentions.find(
          (candidate) => candidate.id === intent.id
        )
      ).toMatchObject({ status: "suggested" });
    } finally {
      await context.database.close();
    }
  });

  it("records a nonretryable receipt without probing or writing for an approved legacy generic update", async () => {
    const context = await createLegacyProposalContext();
    const knowledgeProvider = new RecordingKnowledgeProvider();

    try {
      const intent = await seedHistoricGenericKnowledgeIntent(context, "approved");
      const result = await createFollowUpExecution({
        database: context.database,
        meetingIntelligence: context.meetingIntelligence,
        knowledgeProvider,
        now: () => new Date("2026-08-09T11:02:00.000Z")
      }).execute({
        workspace: context.workspace,
        meetingId: context.meetingId,
        intentId: intent.id
      });

      expect(result.observation.outcome).toMatchObject({
        status: "failed",
        errorCode: "legacy-generic-knowledge-update-disabled",
        retryable: false
      });
      expect(knowledgeProvider.markerLookups).toEqual([]);
      expect(knowledgeProvider.createCalls).toEqual([]);
      expect(
        (await snapshotFor(context)).followUpIntentions.find(
          (candidate) => candidate.id === intent.id
        )
      ).toMatchObject({ status: "failed" });
    } finally {
      await context.database.close();
    }
  });

  it("recovers a historic indeterminate generic create only from its exact positive marker", async () => {
    const context = await createLegacyProposalContext();
    const knowledgeProvider = new RecordingKnowledgeProvider();

    try {
      const { intent, idempotencyKey } =
        await seedHistoricIndeterminateGenericKnowledgeExecution(context);
      knowledgeProvider.marker = {
        providerId: knowledgeProvider.providerId,
        objectType: "document",
        externalId: "notion-historic-generic-document",
        url: "https://notion.so/historic-generic-document"
      };

      const result = await createFollowUpExecution({
        database: context.database,
        meetingIntelligence: context.meetingIntelligence,
        knowledgeProvider,
        now: () => new Date("2026-08-09T11:04:00.000Z")
      }).recover({
        workspace: context.workspace,
        meetingId: context.meetingId,
        intentId: intent.id
      });

      expect(result.observation.outcome.status).toBe("succeeded");
      if (result.observation.outcome.status !== "succeeded") {
        throw new Error("expected positive historic marker recovery");
      }
      expect(result.observation.outcome.externalReferences).toEqual([
        expect.objectContaining({ externalId: "notion-historic-generic-document" })
      ]);
      expect(result.observation.outcome.summary).toContain("Recovered historic");
      expect(knowledgeProvider.markerLookups).toEqual([idempotencyKey]);
      expect(knowledgeProvider.createCalls).toEqual([]);
      expect(
        (await snapshotFor(context)).followUpIntentions.find(
          (candidate) => candidate.id === intent.id
        )
      ).toMatchObject({ status: "succeeded" });
    } finally {
      await context.database.close();
    }
  });

  it("keeps a historic generic create manual when no exact provider marker exists", async () => {
    const context = await createLegacyProposalContext();
    const knowledgeProvider = new RecordingKnowledgeProvider();

    try {
      const { intent, idempotencyKey } =
        await seedHistoricIndeterminateGenericKnowledgeExecution(context);
      const result = await createFollowUpExecution({
        database: context.database,
        meetingIntelligence: context.meetingIntelligence,
        knowledgeProvider,
        now: () => new Date("2026-08-09T11:04:00.000Z")
      }).recover({
        workspace: context.workspace,
        meetingId: context.meetingId,
        intentId: intent.id
      });

      expect(result.observation.outcome).toMatchObject({
        status: "failed",
        errorCode: "provider-outcome-unknown",
        retryable: false,
        requiresManualRecovery: true
      });
      if (result.observation.outcome.status !== "failed") {
        throw new Error("expected indeterminate historic generic create");
      }
      expect(result.observation.outcome.message).toContain("will not create or update");
      expect(knowledgeProvider.markerLookups).toEqual([idempotencyKey]);
      expect(knowledgeProvider.createCalls).toEqual([]);
      expect(
        (await snapshotFor(context)).followUpIntentions.find(
          (candidate) => candidate.id === intent.id
        )
      ).toMatchObject({ status: "requires-manual-recovery" });

      knowledgeProvider.marker = {
        providerId: knowledgeProvider.providerId,
        objectType: "document",
        externalId: "notion-historic-generic-document-after-recovery",
        url: "https://notion.so/historic-generic-document-after-recovery"
      };
      const recovered = await createFollowUpExecution({
        database: context.database,
        meetingIntelligence: context.meetingIntelligence,
        knowledgeProvider,
        now: () => new Date("2026-08-09T11:05:00.000Z")
      }).recover({
        workspace: context.workspace,
        meetingId: context.meetingId,
        intentId: intent.id
      });

      expect(recovered.observation.outcome.status).toBe("succeeded");
      if (recovered.observation.outcome.status !== "succeeded") {
        throw new Error("expected positive historic marker recovery after retry");
      }
      expect(recovered.observation.outcome.externalReferences).toEqual([
        expect.objectContaining({
          externalId: "notion-historic-generic-document-after-recovery"
        })
      ]);
      expect(recovered.observation.outcome.summary).toContain("Recovered historic");
      expect(knowledgeProvider.markerLookups).toEqual([idempotencyKey, idempotencyKey]);
      expect(knowledgeProvider.createCalls).toEqual([]);
    } finally {
      await context.database.close();
    }
  });

  it("recovers an interrupted historic generic create with the no-new-write receipt", async () => {
    const context = await createLegacyProposalContext();
    const knowledgeProvider = new RecordingKnowledgeProvider();

    try {
      const { intent, idempotencyKey } =
        await seedHistoricExecutingGenericKnowledgeExecution(context);
      knowledgeProvider.marker = {
        providerId: knowledgeProvider.providerId,
        objectType: "document",
        externalId: "notion-historic-in-flight-document",
        url: "https://notion.so/historic-in-flight-document"
      };

      const result = await createFollowUpExecution({
        database: context.database,
        meetingIntelligence: context.meetingIntelligence,
        knowledgeProvider,
        now: () => new Date("2026-08-09T11:04:00.000Z")
      }).recover({
        workspace: context.workspace,
        meetingId: context.meetingId,
        intentId: intent.id
      });

      expect(result.observation.outcome.status).toBe("succeeded");
      if (result.observation.outcome.status !== "succeeded") {
        throw new Error("expected positive interrupted historic marker recovery");
      }
      expect(result.observation.outcome.externalReferences).toEqual([
        expect.objectContaining({ externalId: "notion-historic-in-flight-document" })
      ]);
      expect(result.observation.outcome.summary).toContain("Recovered historic");
      expect(knowledgeProvider.markerLookups).toEqual([idempotencyKey]);
      expect(knowledgeProvider.createCalls).toEqual([]);
      expect(
        (await snapshotFor(context)).followUpIntentions.find(
          (candidate) => candidate.id === intent.id
        )
      ).toMatchObject({ status: "succeeded" });
    } finally {
      await context.database.close();
    }
  });
});
