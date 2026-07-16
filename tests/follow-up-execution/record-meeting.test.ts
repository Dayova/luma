import { describe, expect, it } from "vitest";
import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../../src/ai/reasoning-model.js";
import type { ExternalReference } from "../../src/domain/model.js";
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
import { createPgliteDatabase } from "../../src/persistence/db.js";

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

describe("Follow-up execution meeting records", () => {
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
      intent
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
});
