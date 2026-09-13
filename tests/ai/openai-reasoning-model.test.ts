import { describe, expect, it } from "vitest";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createAiUsageBudget } from "../../src/ai/ai-usage-budget.js";
import type { CaptureSynthesisProposal } from "../../src/ai/capture-synthesis-proposal.js";
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
  it("uses the shared durable budget for capture synthesis and validates its cited Evidence", async () => {
    const database = await createPgliteDatabase();
    const budget = createAiUsageBudget({ database, monthlyLimitUsd: 30 });
    const requests: OpenAIResponseRequest[] = [];
    let unknownCitation = false;
    const model = createOpenAIReasoningModel({
      budget,
      model: "gpt-5.6-luna",
      client: {
        create: (request) => {
          requests.push(request);
          const value: CaptureSynthesisProposal = {
            claims: [
              {
                key: "release",
                kind: "question",
                text: "Start remains open.",
                evidenceIds: [unknownCitation ? "invented" : "capture-1"],
                quotations: [],
                conflictingKeys: [],
                confidence: "medium"
              }
            ]
          };
          return Promise.resolve({
            outputText: JSON.stringify(value),
            model: "gpt-5.6-luna",
            serviceTier: "default",
            status: "completed",
            usage: {
              inputTokens: 100,
              cachedInputTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 20,
              reasoningTokens: 0
            }
          });
        }
      }
    });
    const request = {
      workspaceId: "workspace_dayova",
      meetingId: "logical-meeting-1",
      purpose: "understand-discussion" as const,
      promptVersion: "capture-synthesis-v1",
      schemaName: "CaptureSynthesisProposal",
      evidence: [
        {
          evidenceId: "capture-1",
          source: "knowledge" as const,
          sourceObjectId: "capture-1",
          excerpt: "We could start."
        }
      ],
      context: [],
      input: {}
    };
    try {
      expect(
        (await model.generateStructured<CaptureSynthesisProposal>(request)).value
          .claims[0]?.evidenceIds
      ).toEqual(["capture-1"]);
      expect(requests[0]).toMatchObject({
        strict: true,
        schemaName: "CaptureSynthesisProposal"
      });
      const status = await budget.getStatus(request.workspaceId);
      expect(status).toMatchObject({
        monthlyLimitUsd: 30,
        requestCount: 1,
        unknownUsd: 0,
        reservedUsd: 0,
        byCapability: [{ capability: "meeting-capture-synthesis", requestCount: 1 }]
      });
      expect(status.spentUsd).toBeGreaterThan(0);
      unknownCitation = true;
      await expect(
        model.generateStructured<CaptureSynthesisProposal>(request)
      ).rejects.toThrow("unknown evidence ID");
    } finally {
      await database.close();
    }
  });
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
