import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENAI_REASONING_MODEL,
  openAIReasoningModelNameFromEnv
} from "../../src/ai/openai-model-config.js";
import {
  createOpenAIReasoningModel,
  type OpenAIResponseRequest
} from "../../src/ai/openai-reasoning-model.js";
import {
  createOpenAIContextAnswerer,
  type OpenAIContextAnswererResponseRequest
} from "../../src/context-intelligence/openai-context-answerer.js";

describe("OpenAI model configuration", () => {
  it("resolves one explicit override for Meeting analysis and Context Ask", async () => {
    await expectBothCapabilitiesUse(
      {
        LUMA_REASONING_MODEL_NAME: "gpt-5.6-custom"
      },
      "gpt-5.6-custom"
    );
  });

  it("uses the shared default when the override is absent or blank", async () => {
    await expectBothCapabilitiesUse({}, DEFAULT_OPENAI_REASONING_MODEL);
    await expectBothCapabilitiesUse(
      { LUMA_REASONING_MODEL_NAME: "   " },
      DEFAULT_OPENAI_REASONING_MODEL
    );
  });
});

async function expectBothCapabilitiesUse(
  env: NodeJS.ProcessEnv,
  expectedModel: string
): Promise<void> {
  const model = openAIReasoningModelNameFromEnv(env);
  const meetingRequests: OpenAIResponseRequest[] = [];
  const contextRequests: OpenAIContextAnswererResponseRequest[] = [];

  const meeting = createOpenAIReasoningModel({
    model,
    client: {
      create(request) {
        meetingRequests.push(request);
        return Promise.resolve({
          outputText: JSON.stringify({
            actionItems: [],
            decisions: [],
            openQuestions: [],
            risks: [],
            followUpIntentions: []
          })
        });
      }
    }
  });
  const context = createOpenAIContextAnswerer({
    model,
    client: {
      create(request) {
        contextRequests.push(request);
        return Promise.resolve({
          outputText: JSON.stringify({
            answer: {
              text: "The release might be ready on Monday.",
              evidenceIds: ["conversation:discord:anchor:revision-1:message-1"]
            },
            facts: [],
            inferences: [],
            unresolved: []
          })
        });
      }
    }
  });

  await meeting.generateStructured({
    workspaceId: "workspace_dayova",
    meetingId: "meeting_product",
    purpose: "understand-discussion",
    promptVersion: "meeting-intelligence-v2",
    schemaName: "MeetingAnalysisProposalBatch",
    evidence: [
      {
        evidenceId: "meeting-evidence",
        source: "transcript",
        sourceObjectId: "utterance-1"
      }
    ],
    context: [],
    input: {}
  });
  const contextResult = await context.answer({
    workspaceId: "workspace_dayova",
    inquiryId: "discord-anchor",
    question: "When might the release be ready?",
    source: {
      providerId: "discord",
      conversationObjectId: "thread-1",
      anchorMessageId: "anchor",
      snapshotRevision: 1,
      contentHash: "sha256:conversation",
      boundary: {
        mode: "thread",
        firstMessageId: "message-1",
        lastMessageId: "anchor",
        messageIds: ["message-1", "anchor"]
      }
    },
    evidence: [
      {
        evidenceId: "conversation:discord:anchor:revision-1:message-1",
        providerId: "discord",
        conversationObjectId: "thread-1",
        anchorMessageId: "anchor",
        sourceRevision: 1,
        messageId: "message-1",
        ordinal: 1,
        author: {
          providerUserId: "discord-user",
          displayName: "Fabius",
          personId: null
        },
        createdAt: "2026-08-09T10:00:00.000Z",
        editedAt: null,
        replyToMessageId: null,
        url: "https://discord.com/channels/guild/thread-1/message-1",
        state: "available",
        text: "The release might be ready on Monday."
      }
    ],
    promptVersion: "context-ask-v1"
  });

  expect(model).toBe(expectedModel);
  expect(meetingRequests[0]?.model).toBe(expectedModel);
  expect(contextRequests[0]?.model).toBe(expectedModel);
  expect(contextResult.metadata.model).toBe(expectedModel);
}
