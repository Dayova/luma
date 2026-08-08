import { describe, expect, it } from "vitest";
import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../../src/ai/reasoning-model.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import type {
  CreateWorkItemInput,
  UpdateWorkItemInput,
  WorkItem,
  WorkProvider,
  WorkQuery
} from "../../src/work/interface.js";

class GenericCreateReasoningModel implements ReasoningModel {
  constructor(private readonly assigneeId: string | null) {}

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
          id: "intent:generic-create-work",
          type: "create-work-item",
          title: "Prepare the release checklist",
          description: "Prepare the release checklist.",
          assigneeId: this.assigneeId,
          mentionPersonIds: [],
          dueDate: null,
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
        model: "generic-create-owner-gate",
        promptVersion: request.promptVersion
      }
    });
  }
}

class RecordingWorkProvider implements WorkProvider {
  readonly providerId = "linear";
  readonly createCalls: CreateWorkItemInput[] = [];

  searchWorkItems(_query: WorkQuery): Promise<WorkItem[]> {
    void _query;
    return Promise.resolve([]);
  }

  getWorkItem(_id: string): Promise<WorkItem> {
    void _id;
    return Promise.reject(new Error("not needed"));
  }

  createWorkItem(input: CreateWorkItemInput): Promise<never> {
    this.createCalls.push(input);
    return Promise.reject(new Error("must not create work"));
  }

  updateWorkItem(_id: string, _input: UpdateWorkItemInput): Promise<never> {
    void _id;
    void _input;
    return Promise.reject(new Error("not needed"));
  }

  addComment(_id: string, _body: string): Promise<void> {
    void _id;
    void _body;
    return Promise.resolve();
  }
}

async function approvedGenericCreateIntent(assigneeId: string | null) {
  const database = await createPgliteDatabase();
  const workspace = {
    workspaceId: "workspace_generic_create_owner_gate",
    timezone: "Europe/Berlin"
  };
  const meetingId = "meeting_generic_create_owner_gate";
  const meetingIntelligence = createMeetingIntelligence({
    database,
    reasoningModel: new GenericCreateReasoningModel(assigneeId),
    now: () => new Date("2026-08-08T10:00:00.000Z")
  });

  await meetingIntelligence.observe({
    workspace,
    observations: [
      {
        type: "utterance-committed",
        observationId: "generic-owner-gate:utterance",
        workspaceId: workspace.workspaceId,
        meetingId,
        occurredAt: "2026-08-08T09:59:00.000Z",
        observedAt: "2026-08-08T09:59:01.000Z",
        utteranceId: "generic-owner-gate:utterance",
        version: 1,
        speaker: {
          status: "attributed",
          personId: "person_jakob",
          confidence: "deterministic",
          basis: "provider-identity"
        },
        startedAt: "2026-08-08T09:58:58.000Z",
        endedAt: "2026-08-08T09:59:00.000Z",
        originalText: "Wir sollten eine Release-Checkliste vorbereiten.",
        language: "de"
      }
    ]
  });
  await meetingIntelligence.observe({
    workspace,
    observations: [
      {
        type: "follow-up-intent-approved",
        observationId: "generic-owner-gate:approval",
        workspaceId: workspace.workspaceId,
        meetingId,
        occurredAt: "2026-08-08T10:01:00.000Z",
        observedAt: "2026-08-08T10:01:01.000Z",
        intentId: "intent:generic-create-work",
        approvedBy: "person_jakob"
      }
    ]
  });

  return { database, workspace, meetingId, meetingIntelligence };
}

describe("generic create-work-item ownership gate", () => {
  it("does not turn an approved missing owner into a silently unassigned Linear create", async () => {
    const { database, workspace, meetingId, meetingIntelligence } =
      await approvedGenericCreateIntent(null);
    const workProvider = new RecordingWorkProvider();

    try {
      const result = await createFollowUpExecution({
        database,
        meetingIntelligence,
        workProvider,
        now: () => new Date("2026-08-08T10:02:00.000Z")
      }).execute({
        workspace,
        meetingId,
        intentId: "intent:generic-create-work"
      });

      expect(result.observation.outcome).toMatchObject({
        status: "failed",
        errorCode: "action-item-ownership-not-executable",
        retryable: false
      });
      expect(workProvider.createCalls).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("does not treat a model-supplied mapped Person as Human ownership confirmation", async () => {
    const { database, workspace, meetingId, meetingIntelligence } =
      await approvedGenericCreateIntent("person_missing_linear_identity");
    const workProvider = new RecordingWorkProvider();

    try {
      const result = await createFollowUpExecution({
        database,
        meetingIntelligence,
        workProvider,
        now: () => new Date("2026-08-08T10:02:00.000Z")
      }).execute({
        workspace,
        meetingId,
        intentId: "intent:generic-create-work"
      });

      expect(result.observation.outcome).toMatchObject({
        status: "failed",
        errorCode: "action-item-ownership-not-executable",
        retryable: false
      });
      expect(workProvider.createCalls).toEqual([]);
    } finally {
      await database.close();
    }
  });
});
