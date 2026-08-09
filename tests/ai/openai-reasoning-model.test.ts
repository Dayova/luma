import { describe, expect, it } from "vitest";
import {
  createOpenAIReasoningModel,
  type OpenAIResponseClient,
  type OpenAIResponseRequest
} from "../../src/ai/openai-reasoning-model.js";
import type { MeetingAnalysisProposalBatch } from "../../src/ai/reasoning-model.js";

class FakeOpenAIResponseClient implements OpenAIResponseClient {
  readonly requests: OpenAIResponseRequest[] = [];

  create(request: OpenAIResponseRequest): Promise<{ outputText: string }> {
    this.requests.push(request);
    return Promise.resolve({
      outputText: JSON.stringify({
        actionItems: [],
        decisions: [],
        openQuestions: [],
        risks: [],
        followUpIntentions: [
          {
            id: "intent_release",
            type: "create-work-item",
            title: "Prepare the release checklist",
            description: "Prepare the release checklist.",
            assigneeId: "person_jakob",
            mentionPersonIds: ["person_fabius"],
            dueDate: "2026-07-20",
            relatedMeetingItemIds: [],
            evidenceIds: ["evidence:transcript:utt_release:v1"],
            confidence: "high"
          }
        ]
      })
    });
  }
}

describe("OpenAI ReasoningModel", () => {
  it("uses strict structured output and validates Meeting analysis before returning it", async () => {
    const client = new FakeOpenAIResponseClient();
    const model = createOpenAIReasoningModel({
      client,
      model: "gpt-5.6-luna"
    });

    const result = await model.generateStructured<MeetingAnalysisProposalBatch>({
      workspaceId: "workspace_dayova",
      meetingId: "meeting_product",
      purpose: "understand-discussion",
      promptVersion: "meeting-intelligence-v1",
      schemaName: "MeetingAnalysisProposalBatch",
      evidence: [
        {
          evidenceId: "evidence:transcript:utt_release:v1",
          source: "transcript",
          sourceObjectId: "utt_release",
          sourceVersion: "1",
          participantId: "person_jakob",
          excerpt: "Ich übernehme die release checklist bis Montag."
        }
      ],
      context: [],
      input: {
        timezone: "Europe/Berlin",
        languagePolicy: "meeting-majority"
      }
    });

    expect(result.value.followUpIntentions[0]).toMatchObject({
      id: "intent_release",
      type: "create-work-item",
      assigneeId: "person_jakob",
      evidenceIds: ["evidence:transcript:utt_release:v1"]
    });
    expect(result.metadata).toEqual({
      provider: "openai",
      model: "gpt-5.6-luna",
      promptVersion: "meeting-intelligence-v1"
    });
    expect(client.requests[0]).toMatchObject({
      model: "gpt-5.6-luna",
      schemaName: "MeetingAnalysisProposalBatch",
      strict: true
    });
    expect(JSON.stringify(client.requests[0]?.schema)).not.toContain("update-knowledge");
  });

  it("rejects output that cites an unknown evidence ID", async () => {
    const client: OpenAIResponseClient = {
      create: () =>
        Promise.resolve({
          outputText: JSON.stringify({
            actionItems: [
              {
                stableKey: "release",
                description: "Prepare release",
                ownerId: "person_jakob",
                dueDate: {
                  originalPhrase: null,
                  normalizedDate: null,
                  confidence: "unknown",
                  timezone: "Europe/Berlin"
                },
                status: "confirmed",
                relatedDecisionIds: [],
                evidenceIds: ["invented-evidence"],
                confidence: "high"
              }
            ],
            decisions: [],
            openQuestions: [],
            risks: [],
            followUpIntentions: []
          })
        })
    };
    const model = createOpenAIReasoningModel({ client, model: "gpt-5.6-luna" });

    await expect(
      model.generateStructured({
        workspaceId: "workspace_dayova",
        meetingId: "meeting_product",
        purpose: "understand-discussion",
        promptVersion: "meeting-intelligence-v1",
        schemaName: "MeetingAnalysisProposalBatch",
        evidence: [
          {
            evidenceId: "real-evidence",
            source: "transcript",
            sourceObjectId: "utt_release"
          }
        ],
        context: [],
        input: {}
      })
    ).rejects.toThrow("unknown evidence ID");
  });

  it("rejects a legacy generic knowledge proposal from a nonconforming model", async () => {
    const client: OpenAIResponseClient = {
      create: () =>
        Promise.resolve({
          outputText: JSON.stringify({
            actionItems: [],
            decisions: [],
            openQuestions: [],
            risks: [],
            followUpIntentions: [
              {
                id: "intent_legacy_knowledge",
                type: "update-knowledge",
                title: "Customer policy",
                bodyMarkdown: "## Customer policy",
                relatedMeetingItemIds: [],
                evidenceIds: ["real-evidence"],
                confidence: "high"
              }
            ]
          })
        })
    };
    const model = createOpenAIReasoningModel({ client, model: "gpt-5.6-luna" });

    await expect(
      model.generateStructured({
        workspaceId: "workspace_dayova",
        meetingId: "meeting_product",
        purpose: "understand-discussion",
        promptVersion: "meeting-intelligence-v2",
        schemaName: "MeetingAnalysisProposalBatch",
        evidence: [
          {
            evidenceId: "real-evidence",
            source: "transcript",
            sourceObjectId: "utt_release"
          }
        ],
        context: [],
        input: {}
      })
    ).rejects.toThrow();
  });
});
