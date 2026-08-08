import { describe, expect, it } from "vitest";
import type {
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../../src/ai/reasoning-model.js";
import type { ExternalReference, WorkspaceConfig } from "../../src/domain/model.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import { createLedgerBackedImportedSourceVerifier } from "../../src/knowledge/ledger-backed-imported-source-verifier.js";
import { createMeetingNotesIngestion } from "../../src/knowledge/meeting-notes-ingestion.js";
import {
  createObservedSourceLedger,
  type RawMeetingNoteSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import type {
  ConditionalUpdateWorkItemInput,
  CreateWorkItemInput,
  UpdateWorkItemInput,
  WorkItem,
  WorkProvider,
  WorkQuery
} from "../../src/work/interface.js";

const workspace: WorkspaceConfig = {
  workspaceId: "workspace_dayova",
  timezone: "Europe/Berlin"
};

const sourceIdentity = {
  providerId: "notion",
  sourceKind: "meeting-note" as const,
  sourceObjectId: "notion-source-deletion-root",
  parentObjectId: "notion-page-source-deletion",
  url: "https://notion.so/source-deletion"
};

const sourceSnapshot: RawMeetingNoteSnapshot = {
  schemaVersion: 1,
  title: "Source deletion safety",
  lifecycle: "ready",
  calendar: {
    startAt: "2026-08-06T23:30:00.000Z",
    endAt: "2026-08-07T00:00:00.000Z",
    attendeeProviderUserIds: []
  },
  recording: null,
  sections: {
    summary: {
      state: "available",
      sourceBlockId: "summary-block",
      text: "The source-derived action needs a canonical review.",
      blocks: []
    },
    actionItemsAndNotes: {
      state: "available",
      sourceBlockId: "action-items-block",
      text: "Jakob will finish LUM-3 by Friday.",
      blocks: [
        {
          id: "source-action",
          type: "to-do",
          text: "Jakob will finish LUM-3 by Friday.",
          checked: false,
          children: []
        }
      ]
    },
    transcript: {
      state: "available",
      sourceBlockId: "transcript-block",
      text: "Jakob committed to this work item change.",
      blocks: []
    }
  },
  markdown: {
    content: "# Source deletion safety",
    truncated: false,
    unknownBlockIds: []
  },
  completeness: { state: "complete" }
};

class NoAnalysisReasoningModel implements ReasoningModel {
  generateStructured<T>(
    _request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    void _request;
    return Promise.reject(new Error("source imports must not invoke model analysis"));
  }
}

class SourceDeletionWorkProvider implements WorkProvider {
  readonly providerId = "linear";
  readonly supportsConditionalUpdates = true;
  readonly updateCalls: Array<{
    id: string;
    input: ConditionalUpdateWorkItemInput;
  }> = [];
  readonly item: WorkItem = {
    id: "linear-issue-lum-3",
    providerId: "linear",
    externalId: "LUM-3",
    title: "Finish LUM-3",
    description: "Existing work item before the Meeting source proposal.",
    status: "active",
    assignees: [],
    dueDate: null,
    labels: [],
    projectId: null,
    parentId: null,
    url: "https://linear.app/dayova/issue/LUM-3",
    updatedAt: "2026-08-07T08:00:00.000Z"
  };

  searchWorkItems(_query: WorkQuery): Promise<WorkItem[]> {
    void _query;
    return Promise.resolve([this.item]);
  }

  getWorkItem(id: string): Promise<WorkItem> {
    return id === this.item.id
      ? Promise.resolve(this.item)
      : Promise.reject(new Error(`unexpected work item ${id}`));
  }

  createWorkItem(_input: CreateWorkItemInput): Promise<ExternalReference> {
    void _input;
    return Promise.reject(new Error("not needed"));
  }

  updateWorkItem(_id: string, _input: UpdateWorkItemInput): Promise<ExternalReference> {
    void _id;
    void _input;
    return Promise.reject(new Error("reconciliation must use a conditional update"));
  }

  updateWorkItemIfCurrent(
    id: string,
    input: ConditionalUpdateWorkItemInput
  ): Promise<ExternalReference | null> {
    this.updateCalls.push({ id, input });
    return Promise.resolve({
      providerId: this.providerId,
      objectType: "work-item",
      externalId: this.item.externalId,
      url: this.item.url,
      version: this.item.updatedAt
    });
  }

  addComment(_id: string, _body: string): Promise<void> {
    void _id;
    void _body;
    return Promise.resolve();
  }
}

async function createReviewedSource() {
  const database = await createPgliteDatabase();
  const ledger = createObservedSourceLedger({ database });
  const workProvider = new SourceDeletionWorkProvider();
  const recorded = await ledger.record({
    workspaceId: workspace.workspaceId,
    source: sourceIdentity,
    providerVersion: "2026-08-07T09:00:00.000Z",
    snapshot: sourceSnapshot,
    observedAt: "2026-08-07T09:05:00.000Z"
  });
  const meetingIntelligence = createMeetingIntelligence({
    database,
    reasoningModel: new NoAnalysisReasoningModel(),
    workCatalogs: [workProvider],
    importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
      ledger,
      workItemProviderId: workProvider.providerId
    }),
    now: () => new Date("2026-08-07T09:10:00.000Z")
  });
  const ingestion = createMeetingNotesIngestion({
    meetingIntelligence,
    workItemProviderId: workProvider.providerId
  });
  const imported = await ingestion.ingest({ workspace, source: recorded });
  const meetingId = imported.meetingId;
  const reviews = await meetingIntelligence.query({
    workspaceId: workspace.workspaceId,
    meetingId,
    query: { type: "action-item-reconciliation-review" }
  });

  if (reviews.type !== "action-item-reconciliation-review") {
    throw new Error("expected a reconciliation review");
  }

  const review = reviews.reviews[0]?.proposal;

  if (!review || review.outcome.type !== "update-existing") {
    throw new Error("expected a conditional source-derived work update proposal");
  }

  const resolution = await meetingIntelligence.observe({
    workspace,
    observations: [
      {
        type: "human-judgment-recorded",
        observationId: "human:source-deletion:resolve",
        workspaceId: workspace.workspaceId,
        meetingId,
        occurredAt: "2026-08-07T09:11:00.000Z",
        observedAt: "2026-08-07T09:11:00.000Z",
        participantId: "person:jakob",
        judgment: {
          kind: "resolve-action-item-reconciliation",
          reviewId: review.id,
          resolution: { type: "accept-proposal" }
        }
      }
    ]
  });

  if (resolution.errors.length > 0) {
    throw new Error(
      `failed to resolve source reconciliation: ${resolution.errors[0]?.code}`
    );
  }

  const snapshot = await meetingIntelligence.query({
    workspaceId: workspace.workspaceId,
    meetingId,
    query: { type: "snapshot" }
  });

  if (snapshot.type !== "snapshot") {
    throw new Error("expected a Meeting snapshot");
  }

  const intent = snapshot.state.followUpIntentions.find(
    (candidate) => candidate.type === "update-work-item"
  );

  if (!intent) {
    throw new Error("expected a suggested source-derived work update Intent");
  }

  return {
    database,
    ledger,
    recorded,
    workProvider,
    meetingIntelligence,
    ingestion,
    meetingId,
    intent
  };
}

async function ingestTombstone(input: Awaited<ReturnType<typeof createReviewedSource>>) {
  const [current] = await input.ledger.listCurrent({
    workspaceId: workspace.workspaceId,
    providerId: sourceIdentity.providerId,
    sourceKind: sourceIdentity.sourceKind
  });

  if (!current) {
    throw new Error("expected a source head before removal");
  }

  const tombstone = await input.ledger.recordTombstone({
    workspaceId: workspace.workspaceId,
    previous: current,
    observedAt: "2026-08-07T09:20:00.000Z"
  });

  if (!tombstone) {
    throw new Error("expected a tombstone revision");
  }

  const update = await input.ingestion.ingest({ workspace, source: tombstone });

  expect(update.errors).toEqual([]);
  return tombstone;
}

describe("source deletion safety", () => {
  it("invalidates a suggested reconciliation Intent when its ledger-backed root is removed", async () => {
    const setup = await createReviewedSource();

    try {
      await ingestTombstone(setup);
      const snapshot = await setup.meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: setup.meetingId,
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected a Meeting snapshot");
      }

      expect(snapshot.state.currentImportedActionItemCandidateIds).toEqual([]);
      expect(
        snapshot.state.followUpIntentions.find(
          (candidate) => candidate.id === setup.intent.id
        )
      ).toMatchObject({ status: "invalidated" });
    } finally {
      await setup.database.close();
    }
  });

  it("records a stale-source receipt without writing to Linear when an approved Intent loses its root", async () => {
    const setup = await createReviewedSource();

    try {
      const approval = await setup.meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "follow-up-intent-approved",
            observationId: "approval:source-deletion:before-removal",
            workspaceId: workspace.workspaceId,
            meetingId: setup.meetingId,
            occurredAt: "2026-08-07T09:15:00.000Z",
            observedAt: "2026-08-07T09:15:00.000Z",
            intentId: setup.intent.id,
            approvedBy: "person:jakob"
          }
        ]
      });

      expect(approval.errors).toEqual([]);
      await ingestTombstone(setup);

      const execution = createFollowUpExecution({
        database: setup.database,
        meetingIntelligence: setup.meetingIntelligence,
        workProvider: setup.workProvider,
        now: () => new Date("2026-08-07T09:25:00.000Z")
      });
      const result = await execution.execute({
        workspace,
        meetingId: setup.meetingId,
        intentId: setup.intent.id
      });

      expect(result.observation.outcome).toMatchObject({
        status: "failed",
        errorCode: "source-superseded-before-execution",
        retryable: false
      });
      expect(setup.workProvider.updateCalls).toEqual([]);
    } finally {
      await setup.database.close();
    }
  });
});
