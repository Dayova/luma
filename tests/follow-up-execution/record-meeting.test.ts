import { describe, expect, it } from "vitest";
import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../../src/ai/reasoning-model.js";
import type { ExternalReference, FollowUpIntent } from "../../src/domain/model.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import { createLumaTeamIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import type {
  ChangePage,
  CreateDocumentInput,
  KnowledgeDocument,
  KnowledgeProvider,
  KnowledgeQuery,
  KnowledgeResult,
  UpdateDocumentInput
} from "../../src/knowledge/interface.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import type { MeetingIntelligence } from "../../src/meeting-intelligence/interface.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import type {
  CreateWorkItemInput,
  UpdateWorkItemInput,
  WorkItem,
  WorkProvider,
  WorkQuery
} from "../../src/work/interface.js";

class MeetingRecordReasoningModel implements ReasoningModel {
  generateStructured<T>(
    request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    const evidence = request.evidence[0];

    if (!evidence) {
      throw new Error("expected evidence");
    }

    const value: MeetingAnalysisProposalBatch = {
      actionItems: [
        {
          stableKey: "release-checklist",
          description: "Prepare the release checklist",
          ownerId: "person_jakob",
          dueDate: {
            originalPhrase: "bis Montag",
            normalizedDate: "2026-07-20",
            confidence: "normalized",
            timezone: "Europe/Berlin"
          },
          status: "confirmed",
          relatedDecisionIds: [],
          evidenceIds: [evidence.evidenceId],
          confidence: "high"
        }
      ],
      decisions: [],
      openQuestions: [],
      risks: [],
      followUpIntentions: [
        {
          id: "intent_record_product_meeting",
          type: "record-meeting",
          title: "Product Meeting - 2026-07-16",
          relatedMeetingItemIds: ["action:release-checklist"],
          evidenceIds: [evidence.evidenceId],
          confidence: "high"
        }
      ]
    };

    return Promise.resolve({
      value: value as T,
      metadata: {
        provider: "test",
        model: "meeting-record",
        promptVersion: request.promptVersion
      }
    });
  }
}

class IntentByMeetingReasoningModel implements ReasoningModel {
  constructor(private readonly intentIds: ReadonlyMap<string, string>) {}

  generateStructured<T>(
    request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    const intentId = this.intentIds.get(request.meetingId);

    if (!intentId) {
      return Promise.reject(new Error(`unexpected Meeting ${request.meetingId}`));
    }

    return Promise.resolve({
      value: {
        actionItems: [],
        decisions: [],
        openQuestions: [],
        risks: [],
        followUpIntentions: [
          {
            id: intentId,
            type: "record-meeting",
            title: `Record ${request.meetingId}`,
            relatedMeetingItemIds: [],
            evidenceIds: [request.evidence[0]?.evidenceId ?? "missing-evidence"],
            confidence: "high"
          }
        ]
      } as T,
      metadata: {
        provider: "test",
        model: "intent-by-meeting",
        promptVersion: request.promptVersion
      }
    });
  }
}

class NotionKnowledgeProvider implements KnowledgeProvider {
  readonly providerId = "notion-meetings";
  readonly identityProviderId = "notion";
  readonly createCalls: CreateDocumentInput[] = [];

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
    return Promise.resolve({
      providerId: this.providerId,
      objectType: "document",
      externalId: "notion-page-product-meeting",
      url: "https://notion.so/product-meeting"
    });
  }

  updateDocument(_id: string, _input: UpdateDocumentInput): Promise<ExternalReference> {
    void _id;
    void _input;
    return Promise.reject(new Error("not needed"));
  }

  listChanges(_cursor?: string): Promise<ChangePage> {
    void _cursor;
    return Promise.resolve({ changes: [], nextCursor: null });
  }
}

class UpdateWorkProvider implements WorkProvider {
  readonly providerId = "linear";
  readonly updateCalls: Array<{ id: string; input: UpdateWorkItemInput }> = [];

  searchWorkItems(_query: WorkQuery): Promise<WorkItem[]> {
    void _query;
    return Promise.resolve([]);
  }

  getWorkItem(_id: string): Promise<WorkItem> {
    void _id;
    return Promise.reject(new Error("not needed"));
  }

  createWorkItem(_input: CreateWorkItemInput): Promise<ExternalReference> {
    void _input;
    return Promise.reject(new Error("not needed"));
  }

  updateWorkItem(id: string, input: UpdateWorkItemInput): Promise<ExternalReference> {
    this.updateCalls.push({ id, input });
    return Promise.resolve({
      providerId: this.providerId,
      objectType: "work-item",
      externalId: id,
      url: `https://linear.app/dayova/issue/${id}`
    });
  }

  addComment(_id: string, _body: string): Promise<void> {
    void _id;
    void _body;
    return Promise.resolve();
  }
}

class DeferredKnowledgeProvider extends NotionKnowledgeProvider {
  private releaseCreate: (() => void) | null = null;
  private signalCreateStarted: (() => void) | null = null;
  private readonly createReleased = new Promise<void>((resolve) => {
    this.releaseCreate = resolve;
  });
  private readonly createStarted = new Promise<void>((resolve) => {
    this.signalCreateStarted = resolve;
  });

  override async createDocument(input: CreateDocumentInput): Promise<ExternalReference> {
    this.createCalls.push(input);
    this.signalCreateStarted?.();
    this.signalCreateStarted = null;
    await this.createReleased;
    return {
      providerId: this.providerId,
      objectType: "document",
      externalId: "notion-page-deferred-product-meeting",
      url: "https://notion.so/deferred-product-meeting"
    };
  }

  waitForCreate(): Promise<void> {
    return this.createStarted;
  }

  release(): void {
    this.releaseCreate?.();
    this.releaseCreate = null;
  }
}

class FailingKnowledgeProvider extends NotionKnowledgeProvider {
  override createDocument(input: CreateDocumentInput): Promise<ExternalReference> {
    this.createCalls.push(input);
    return Promise.reject(new Error("temporary Notion failure"));
  }
}

class IncompleteMarkerProbeKnowledgeProvider extends NotionKnowledgeProvider {
  findCreatedDocumentByIdempotencyKey(
    _idempotencyKey: string
  ): Promise<ExternalReference | null> {
    void _idempotencyKey;
    return Promise.reject(new Error("Notion Markdown was truncated"));
  }
}

class CreateThenThrowKnowledgeProvider extends NotionKnowledgeProvider {
  private marker: ExternalReference | null = null;

  override createDocument(input: CreateDocumentInput): Promise<ExternalReference> {
    this.createCalls.push(input);
    this.marker = {
      providerId: this.providerId,
      objectType: "document",
      externalId: "notion-page-created-before-timeout",
      url: "https://notion.so/created-before-timeout"
    };
    return Promise.reject(new Error("response timed out after provider write"));
  }

  findCreatedDocumentByIdempotencyKey(
    _idempotencyKey: string
  ): Promise<ExternalReference | null> {
    void _idempotencyKey;
    return Promise.resolve(this.marker);
  }
}

class RecoveryMarkerKnowledgeProvider extends NotionKnowledgeProvider {
  readonly recoveryKeys: string[] = [];

  findCreatedDocumentByIdempotencyKey(
    idempotencyKey: string
  ): Promise<ExternalReference | null> {
    this.recoveryKeys.push(idempotencyKey);
    return Promise.resolve(
      idempotencyKey.includes(":")
        ? {
            providerId: this.providerId,
            objectType: "document",
            externalId: "notion-page-recovered",
            url: "https://notion.so/recovered"
          }
        : null
    );
  }
}

class LegacyCollisionMarkerKnowledgeProvider extends NotionKnowledgeProvider {
  readonly markerLookups: string[] = [];

  constructor(private readonly legacyKey: string) {
    super();
  }

  findCreatedDocumentByIdempotencyKey(
    idempotencyKey: string
  ): Promise<ExternalReference | null> {
    this.markerLookups.push(idempotencyKey);
    return Promise.resolve(
      idempotencyKey === this.legacyKey
        ? {
            providerId: this.providerId,
            objectType: "document",
            externalId: "notion-page-from-another-legacy-tuple",
            url: "https://notion.so/another-legacy-tuple"
          }
        : null
    );
  }
}

async function createApprovedMeetingRecordIntent(input: {
  meetingIntelligence: MeetingIntelligence;
  workspace: { workspaceId: string; timezone: string };
  meetingId: string;
}): Promise<FollowUpIntent> {
  await input.meetingIntelligence.observe({
    workspace: input.workspace,
    observations: [
      {
        type: "meeting-started",
        observationId: `${input.meetingId}:started`,
        workspaceId: input.workspace.workspaceId,
        meetingId: input.meetingId,
        occurredAt: "2026-07-16T09:00:00.000Z",
        observedAt: "2026-07-16T09:00:01.000Z",
        title: "Product Meeting",
        startedAt: "2026-07-16T09:00:00.000Z",
        languageMode: "multilingual",
        participantIds: ["person_jakob"]
      }
    ]
  });
  await input.meetingIntelligence.observe({
    workspace: input.workspace,
    observations: [
      {
        type: "utterance-committed",
        observationId: `${input.meetingId}:note`,
        workspaceId: input.workspace.workspaceId,
        meetingId: input.meetingId,
        occurredAt: "2026-07-16T09:05:00.000Z",
        observedAt: "2026-07-16T09:05:01.000Z",
        utteranceId: `${input.meetingId}:utterance`,
        version: 1,
        speakerId: "person_jakob",
        startedAt: "2026-07-16T09:04:58.000Z",
        endedAt: "2026-07-16T09:05:02.000Z",
        originalText: "Ich bereite die release checklist bis Montag vor.",
        language: "mixed"
      }
    ]
  });
  const snapshot = await input.meetingIntelligence.query({
    workspaceId: input.workspace.workspaceId,
    meetingId: input.meetingId,
    query: { type: "snapshot" }
  });

  if (snapshot.type !== "snapshot") {
    throw new Error("expected Meeting snapshot");
  }

  const intent = snapshot.state.followUpIntentions.find(
    (candidate) => candidate.type === "record-meeting"
  );

  if (!intent) {
    throw new Error("expected Meeting record Intent");
  }

  await input.meetingIntelligence.observe({
    workspace: input.workspace,
    observations: [
      {
        type: "follow-up-intent-approved",
        observationId: `${input.meetingId}:approved`,
        workspaceId: input.workspace.workspaceId,
        meetingId: input.meetingId,
        occurredAt: "2026-07-16T09:07:00.000Z",
        observedAt: "2026-07-16T09:07:01.000Z",
        intentId: intent.id,
        approvedBy: "person_jakob"
      }
    ]
  });

  return intent;
}

describe("Follow-up execution meeting records", () => {
  it("keeps opaque workspace, Meeting, and Intent identities distinct in durable execution reservations", async () => {
    const database = await createPgliteDatabase();
    const workspace = {
      workspaceId: "workspace",
      timezone: "Europe/Berlin"
    };
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new IntentByMeetingReasoningModel(
        new Map([
          ["a:b", "c"],
          ["a", "b:c"]
        ])
      ),
      now: () => new Date("2026-07-16T09:10:00.000Z")
    });
    const knowledgeProvider = new NotionKnowledgeProvider();
    const execution = createFollowUpExecution({
      database,
      meetingIntelligence,
      knowledgeProvider,
      now: () => new Date("2026-07-16T09:10:00.000Z")
    });

    try {
      const first = await createApprovedMeetingRecordIntent({
        meetingIntelligence,
        workspace,
        meetingId: "a:b"
      });
      const second = await createApprovedMeetingRecordIntent({
        meetingIntelligence,
        workspace,
        meetingId: "a"
      });

      const [firstResult, secondResult] = await Promise.all([
        execution.execute({
          workspace,
          meetingId: "a:b",
          intentId: first.id
        }),
        execution.execute({
          workspace,
          meetingId: "a",
          intentId: second.id
        })
      ]);

      expect(firstResult.idempotencyKey).not.toBe(secondResult.idempotencyKey);
      expect(knowledgeProvider.createCalls).toHaveLength(2);
      const reservations = await database.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count
           FROM follow_up_executions
          WHERE workspace_id = $1`,
        [workspace.workspaceId]
      );
      expect(reservations.rows[0]?.count).toBe("2");
    } finally {
      await database.close();
    }
  });

  it("does not honor a colliding legacy execution key from another opaque tuple", async () => {
    const database = await createPgliteDatabase();
    const workspace = {
      workspaceId: "workspace",
      timezone: "Europe/Berlin"
    };
    const legacyKey = "workspace:a:b:c:execute";
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new IntentByMeetingReasoningModel(
        new Map([
          ["a:b", "c"],
          ["a", "b:c"]
        ])
      ),
      now: () => new Date("2026-07-16T09:10:00.000Z")
    });
    const knowledgeProvider = new LegacyCollisionMarkerKnowledgeProvider(legacyKey);
    const execution = createFollowUpExecution({
      database,
      meetingIntelligence,
      knowledgeProvider,
      now: () => new Date("2026-07-16T09:10:00.000Z")
    });

    try {
      const oldIntent = await createApprovedMeetingRecordIntent({
        meetingIntelligence,
        workspace,
        meetingId: "a:b"
      });
      const targetIntent = await createApprovedMeetingRecordIntent({
        meetingIntelligence,
        workspace,
        meetingId: "a"
      });

      await database.query(
        `INSERT INTO follow_up_executions (
           workspace_id, meeting_id, intent_id, operation, idempotency_key,
           status, attempts, result_json, execution_lease_id, created_at, updated_at
         ) VALUES ($1, $2, $3, 'execute', $4, 'completed', 1, $5, NULL, $6, $6)`,
        [
          workspace.workspaceId,
          "a:b",
          oldIntent.id,
          legacyKey,
          JSON.stringify({
            observation: {
              type: "follow-up-execution-recorded",
              observationId: "legacy:completed",
              workspaceId: workspace.workspaceId,
              meetingId: "a:b",
              occurredAt: "2026-07-16T09:10:00.000Z",
              observedAt: "2026-07-16T09:10:00.000Z",
              intentId: oldIntent.id,
              executionLeaseId: "legacy-lease",
              outcome: {
                status: "succeeded",
                externalReferences: [],
                summary: "legacy success"
              }
            },
            events: [],
            idempotencyKey: legacyKey
          }),
          "2026-07-16T09:10:00.000Z"
        ]
      );

      const result = await execution.execute({
        workspace,
        meetingId: "a",
        intentId: targetIntent.id
      });

      expect(result.idempotencyKey).toBe(
        JSON.stringify([workspace.workspaceId, "a", targetIntent.id, "execute"])
      );
      expect(knowledgeProvider.createCalls).toHaveLength(1);
      expect(knowledgeProvider.createCalls[0]?.idempotencyKey).toBe(
        result.idempotencyKey
      );
      expect(knowledgeProvider.markerLookups).toEqual([result.idempotencyKey]);
    } finally {
      await database.close();
    }
  });

  it("writes an approved Meeting record to Notion with mapped attendees", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new MeetingRecordReasoningModel(),
      now: () => new Date("2026-07-16T09:10:00.000Z")
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };

    await meetingIntelligence.observe({
      workspace,
      observations: [
        {
          type: "meeting-started",
          observationId: "obs_product_start",
          workspaceId: workspace.workspaceId,
          meetingId: "meeting_product",
          occurredAt: "2026-07-16T09:00:00.000Z",
          observedAt: "2026-07-16T09:00:01.000Z",
          title: "Product Meeting",
          startedAt: "2026-07-16T09:00:00.000Z",
          languageMode: "multilingual",
          participantIds: ["person_jakob"]
        }
      ]
    });
    await meetingIntelligence.observe({
      workspace,
      observations: [
        {
          type: "utterance-committed",
          observationId: "obs_product_note",
          workspaceId: workspace.workspaceId,
          meetingId: "meeting_product",
          occurredAt: "2026-07-16T09:05:00.000Z",
          observedAt: "2026-07-16T09:05:01.000Z",
          utteranceId: "utt_product_note",
          version: 1,
          speakerId: "person_jakob",
          startedAt: "2026-07-16T09:04:58.000Z",
          endedAt: "2026-07-16T09:05:02.000Z",
          originalText: "Ich bereite die release checklist bis Montag vor.",
          language: "mixed"
        }
      ]
    });
    await meetingIntelligence.observe({
      workspace,
      observations: [
        {
          type: "follow-up-intent-approved",
          observationId: "obs_approve_record",
          workspaceId: workspace.workspaceId,
          meetingId: "meeting_product",
          occurredAt: "2026-07-16T09:07:00.000Z",
          observedAt: "2026-07-16T09:07:01.000Z",
          intentId: "intent_record_product_meeting",
          approvedBy: "person_jakob"
        }
      ]
    });

    const snapshot = await meetingIntelligence.query({
      workspaceId: workspace.workspaceId,
      meetingId: "meeting_product",
      query: { type: "snapshot" }
    });

    if (snapshot.type !== "snapshot") {
      throw new Error("expected snapshot");
    }

    const intent = snapshot.state.followUpIntentions[0];

    if (!intent) {
      throw new Error("expected follow-up intent");
    }

    const knowledgeProvider = new NotionKnowledgeProvider();
    const result = await createFollowUpExecution({
      database,
      meetingIntelligence,
      identityDirectory: createLumaTeamIdentityDirectory(),
      knowledgeProvider,
      now: () => new Date("2026-07-16T09:10:00.000Z")
    }).execute({
      workspace,
      meetingId: "meeting_product",
      intentId: intent.id
    });

    expect(result.observation.outcome.status).toBe("succeeded");
    expect(knowledgeProvider.createCalls).toEqual([
      expect.objectContaining({
        title: "Product Meeting - 2026-07-16",
        participantProviderUserIds: ["612665e1-6fad-4c71-a856-a41a0fb1f32e"]
      })
    ]);
    expect(knowledgeProvider.createCalls[0]?.contentMarkdown).toContain(
      "# Product Meeting - 2026-07-16"
    );
    expect(knowledgeProvider.createCalls[0]?.contentMarkdown).toContain(
      "## Action Items"
    );
    expect(knowledgeProvider.createCalls[0]?.contentMarkdown).toContain(
      "Prepare the release checklist"
    );
  });

  it("refuses a caller-supplied approved work update that is absent from canonical Meeting state", async () => {
    const database = await createPgliteDatabase();
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new MeetingRecordReasoningModel(),
      now: () => new Date("2026-08-07T09:10:00.000Z")
    });
    const workProvider = new UpdateWorkProvider();

    try {
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "meeting-started",
            observationId: "obs_reconciliation_start",
            workspaceId: workspace.workspaceId,
            meetingId: "meeting_reconciliation",
            occurredAt: "2026-08-07T09:00:00.000Z",
            observedAt: "2026-08-07T09:00:00.000Z",
            title: "Reconciliation",
            startedAt: "2026-08-07T09:00:00.000Z",
            languageMode: "en",
            participantIds: []
          }
        ]
      });
      const intent = {
        id: "intent_reconcile_lum_3_due_date",
        type: "update-work-item",
        externalReference: {
          providerId: "linear",
          objectType: "work-item",
          externalId: "LUM-3",
          url: "https://linear.app/dayova/issue/LUM-3"
        },
        description: "Jakob will finish the Luma reconciliation brief by Friday.",
        dueDate: "2026-08-07",
        relatedMeetingItemIds: [],
        status: "approved",
        provenance: {
          evidence: [],
          confidence: "high",
          producedAtRevision: 1,
          analysisVersion: "human-reconciliation-v1"
        }
      } satisfies FollowUpIntent;

      const execution = createFollowUpExecution({
        database,
        meetingIntelligence,
        workProvider,
        now: () => new Date("2026-08-07T09:10:00.000Z")
      });

      await expect(
        execution.execute({
          workspace,
          meetingId: "meeting_reconciliation",
          intentId: intent.id
        })
      ).rejects.toThrow("must be canonically approved");
      expect(workProvider.updateCalls).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("allows only one executor to mutate an approved canonical Intent", async () => {
    const database = await createPgliteDatabase();
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new MeetingRecordReasoningModel(),
      now: () => new Date("2026-07-16T09:10:00.000Z")
    });
    const knowledgeProvider = new DeferredKnowledgeProvider();

    try {
      const intent = await createApprovedMeetingRecordIntent({
        meetingIntelligence,
        workspace,
        meetingId: "meeting_execution_claim"
      });
      const firstExecutor = createFollowUpExecution({
        database,
        meetingIntelligence,
        knowledgeProvider,
        now: () => new Date("2026-07-16T09:10:00.000Z")
      });
      const secondExecutor = createFollowUpExecution({
        database,
        meetingIntelligence,
        knowledgeProvider,
        now: () => new Date("2026-07-16T09:10:00.000Z")
      });

      const first = firstExecutor.execute({
        workspace,
        meetingId: "meeting_execution_claim",
        intentId: intent.id
      });
      await knowledgeProvider.waitForCreate();

      await expect(
        secondExecutor.execute({
          workspace,
          meetingId: "meeting_execution_claim",
          intentId: intent.id
        })
      ).rejects.toThrow("already has an execution in progress");
      expect(knowledgeProvider.createCalls).toHaveLength(1);

      knowledgeProvider.release();
      await expect(first).resolves.toMatchObject({
        observation: { outcome: { status: "succeeded" } }
      });
      expect(knowledgeProvider.createCalls).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it("records an indeterminate provider write as manual recovery and never automatically retries it", async () => {
    const database = await createPgliteDatabase();
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_failed_execution_attempts";
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new MeetingRecordReasoningModel(),
      now: () => new Date("2026-07-16T09:10:00.000Z")
    });
    const knowledgeProvider = new FailingKnowledgeProvider();
    const execution = createFollowUpExecution({
      database,
      meetingIntelligence,
      knowledgeProvider,
      now: () => new Date("2026-07-16T09:10:00.000Z")
    });

    try {
      const intent = await createApprovedMeetingRecordIntent({
        meetingIntelligence,
        workspace,
        meetingId
      });
      const first = await execution.execute({
        workspace,
        meetingId,
        intentId: intent.id
      });

      expect(first.observation.outcome).toMatchObject({
        status: "failed",
        errorCode: "provider-outcome-unknown",
        retryable: false
      });

      const reapproval = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "follow-up-intent-approved",
            observationId: "meeting_failed_execution_attempts:reapproved",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-07-16T09:11:00.000Z",
            observedAt: "2026-07-16T09:11:00.000Z",
            intentId: intent.id,
            approvedBy: "person_jakob"
          }
        ]
      });

      expect(reapproval.acceptedObservationIds).toEqual([]);
      const reapprovalError = reapproval.errors[0];
      if (!reapprovalError || reapprovalError.code !== "invalid-observation") {
        throw new Error("expected the indeterminate execution to reject re-approval");
      }
      expect(reapprovalError.message).toContain("suggested or failed");
      expect(knowledgeProvider.createCalls).toHaveLength(1);
      await expect(
        execution.execute({ workspace, meetingId, intentId: intent.id })
      ).rejects.toThrow("must be canonically approved");

      const receipts = await database.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count
           FROM meeting_observations
          WHERE workspace_id = $1
            AND meeting_id = $2
            AND type = 'follow-up-execution-recorded'`,
        [workspace.workspaceId, meetingId]
      );
      expect(receipts.rows[0]?.count).toBe("1");
    } finally {
      await database.close();
    }
  });

  it("fails closed to manual recovery when the pre-create marker probe is incomplete", async () => {
    const database = await createPgliteDatabase();
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_incomplete_marker_probe";
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new MeetingRecordReasoningModel(),
      now: () => new Date("2026-07-16T09:10:00.000Z")
    });
    const knowledgeProvider = new IncompleteMarkerProbeKnowledgeProvider();
    const execution = createFollowUpExecution({
      database,
      meetingIntelligence,
      knowledgeProvider,
      now: () => new Date("2026-07-16T09:10:00.000Z")
    });

    try {
      const intent = await createApprovedMeetingRecordIntent({
        meetingIntelligence,
        workspace,
        meetingId
      });
      const result = await execution.execute({
        workspace,
        meetingId,
        intentId: intent.id
      });

      expect(result.observation.outcome).toMatchObject({
        status: "failed",
        errorCode: "provider-outcome-unknown",
        retryable: false
      });
      expect(knowledgeProvider.createCalls).toEqual([]);
      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "snapshot" }
      });

      expect(
        snapshot.type === "snapshot"
          ? snapshot.state.followUpIntentions.find(
              (candidate) => candidate.id === intent.id
            )
          : null
      ).toMatchObject({ status: "requires-manual-recovery" });
    } finally {
      await database.close();
    }
  });

  it("uses a positive provider marker after a response failure instead of duplicating a create", async () => {
    const database = await createPgliteDatabase();
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_marker_recovery";
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new MeetingRecordReasoningModel(),
      now: () => new Date("2026-07-16T09:10:00.000Z")
    });
    const knowledgeProvider = new CreateThenThrowKnowledgeProvider();
    const execution = createFollowUpExecution({
      database,
      meetingIntelligence,
      knowledgeProvider,
      now: () => new Date("2026-07-16T09:10:00.000Z")
    });

    try {
      const intent = await createApprovedMeetingRecordIntent({
        meetingIntelligence,
        workspace,
        meetingId
      });
      const result = await execution.execute({
        workspace,
        meetingId,
        intentId: intent.id
      });

      expect(result.observation.outcome).toMatchObject({
        status: "succeeded",
        externalReferences: [
          expect.objectContaining({ externalId: "notion-page-created-before-timeout" })
        ]
      });
      expect(knowledgeProvider.createCalls).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it("recovers a stranded legacy execution only from a positive provider marker", async () => {
    const database = await createPgliteDatabase();
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_legacy_recovery";
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new MeetingRecordReasoningModel(),
      now: () => new Date("2026-07-16T09:10:00.000Z")
    });
    const knowledgeProvider = new RecoveryMarkerKnowledgeProvider();
    const execution = createFollowUpExecution({
      database,
      meetingIntelligence,
      knowledgeProvider,
      now: () => new Date("2026-07-16T09:10:00.000Z")
    });

    try {
      const intent = await createApprovedMeetingRecordIntent({
        meetingIntelligence,
        workspace,
        meetingId
      });
      const legacyKey = `${workspace.workspaceId}:${meetingId}:${intent.id}:execute`;
      await database.query(
        `INSERT INTO follow_up_executions (
           workspace_id, meeting_id, intent_id, operation, idempotency_key,
           status, attempts, result_json, execution_lease_id, created_at, updated_at
         ) VALUES ($1, $2, $3, 'execute', $4, 'executing', 1, NULL, $5, $6, $6)`,
        [
          workspace.workspaceId,
          meetingId,
          intent.id,
          legacyKey,
          "legacy-execution-lease",
          "2026-07-16T09:10:00.000Z"
        ]
      );

      const result = await execution.recover({
        workspace,
        meetingId,
        intentId: intent.id
      });

      expect(result.idempotencyKey).toBe(legacyKey);
      expect(result.observation.outcome).toMatchObject({
        status: "succeeded",
        externalReferences: [
          expect.objectContaining({ externalId: "notion-page-recovered" })
        ]
      });
      expect(knowledgeProvider.createCalls).toEqual([]);
      expect(knowledgeProvider.recoveryKeys).toContain(legacyKey);
    } finally {
      await database.close();
    }
  });

  it("releases a stranded execution as manual recovery when no provider marker proves its outcome", async () => {
    const database = await createPgliteDatabase();
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_unknown_recovery";
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new MeetingRecordReasoningModel(),
      now: () => new Date("2026-07-16T09:10:00.000Z")
    });
    const knowledgeProvider = new NotionKnowledgeProvider();
    const execution = createFollowUpExecution({
      database,
      meetingIntelligence,
      knowledgeProvider,
      now: () => new Date("2026-07-16T09:10:00.000Z")
    });

    try {
      const intent = await createApprovedMeetingRecordIntent({
        meetingIntelligence,
        workspace,
        meetingId
      });
      const currentKey = JSON.stringify([
        workspace.workspaceId,
        meetingId,
        intent.id,
        "execute"
      ]);
      await database.query(
        `INSERT INTO follow_up_executions (
           workspace_id, meeting_id, intent_id, operation, idempotency_key,
           status, attempts, result_json, execution_lease_id, created_at, updated_at
         ) VALUES ($1, $2, $3, 'execute', $4, 'executing', 1, NULL, $5, $6, $6)`,
        [
          workspace.workspaceId,
          meetingId,
          intent.id,
          currentKey,
          "unknown-execution-lease",
          "2026-07-16T09:10:00.000Z"
        ]
      );

      const result = await execution.recover({
        workspace,
        meetingId,
        intentId: intent.id
      });

      expect(result.observation.outcome).toMatchObject({
        status: "failed",
        errorCode: "provider-outcome-unknown",
        retryable: false
      });
      expect(knowledgeProvider.createCalls).toEqual([]);
      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "snapshot" }
      });
      if (snapshot.type !== "snapshot") {
        throw new Error("expected a Meeting snapshot");
      }
      expect(
        snapshot.state.followUpIntentions.find((candidate) => candidate.id === intent.id)
      ).toMatchObject({ status: "requires-manual-recovery" });
    } finally {
      await database.close();
    }
  });
});
