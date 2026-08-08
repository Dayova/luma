import { describe, expect, it } from "vitest";
import {
  createOpenAIContextAnswerer,
  type OpenAIContextAnswererResponseClient,
  type OpenAIContextAnswererResponseRequest
} from "../../src/context-intelligence/openai-context-answerer.js";
import type { ContextAnswerRequest } from "../../src/context-intelligence/context-answerer.js";

class FakeOpenAIContextAnswererResponseClient implements OpenAIContextAnswererResponseClient {
  readonly requests: OpenAIContextAnswererResponseRequest[] = [];

  constructor(private readonly outputText: string) {}

  create(request: OpenAIContextAnswererResponseRequest): Promise<{ outputText: string }> {
    this.requests.push(request);
    return Promise.resolve({ outputText: this.outputText });
  }
}

describe("OpenAI ContextAnswerer", () => {
  it("uses a strict, read-only context schema without a Meeting identifier", async () => {
    const client = new FakeOpenAIContextAnswererResponseClient(
      JSON.stringify(validAnswer())
    );
    const answerer = createOpenAIContextAnswerer({
      client,
      model: "gpt-5.6-luna"
    });

    const result = await answerer.answer(contextAnswerRequest());

    expect(result).toMatchObject({
      answer: {
        text: "Fabius said the release checklist might be ready on Monday.",
        evidenceIds: ["conversation:discord:mention-42:revision-1:message-100"]
      },
      metadata: {
        provider: "openai",
        model: "gpt-5.6-luna",
        promptVersion: "context-ask-v1"
      }
    });

    const [outbound] = client.requests;

    if (!outbound) {
      throw new Error("expected one OpenAI request");
    }

    expect(outbound).toMatchObject({
      model: "gpt-5.6-luna",
      schemaName: "ContextAskAnswer",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false
      }
    });
    expect(outbound.schema).toMatchObject({
      properties: {
        answer: { type: "object", additionalProperties: false },
        facts: { type: "array" },
        inferences: { type: "array" },
        unresolved: { type: "array" }
      }
    });
    expect(outbound.schema).not.toHaveProperty("properties.followUpIntentions");

    const payload = JSON.parse(outbound.input) as Record<string, unknown>;

    expect(payload).toEqual({
      workspaceId: "workspace_dayova",
      inquiryId: "discord-message-100",
      question: "When might the release checklist be ready?",
      source: {
        providerId: "discord",
        conversationObjectId: "thread-42",
        anchorMessageId: "mention-42",
        snapshotRevision: 1,
        contentHash: "sha256:thread-snapshot",
        boundary: {
          mode: "thread",
          firstMessageId: "message-100",
          lastMessageId: "message-101",
          messageIds: ["message-100", "message-101"]
        }
      },
      evidence: contextAnswerRequest().evidence
    });
    expect(payload).not.toHaveProperty("meetingId");
    expect(outbound.instructions).toContain("read-only");
    expect(outbound.instructions).toContain("Follow-up");
  });

  it("rejects an answer that cites evidence outside the captured context", async () => {
    const client = new FakeOpenAIContextAnswererResponseClient(
      JSON.stringify({
        ...validAnswer(),
        facts: [
          {
            text: "The release date is confirmed.",
            evidenceIds: ["conversation:discord:invented"]
          }
        ]
      })
    );
    const answerer = createOpenAIContextAnswerer({ client });

    await expect(answerer.answer(contextAnswerRequest())).rejects.toMatchObject({
      code: "openai-context-answer-evidence-invalid"
    });
  });

  it("rejects mutation-shaped output outside the strict Context Ask schema", async () => {
    const client = new FakeOpenAIContextAnswererResponseClient(
      JSON.stringify({
        ...validAnswer(),
        followUpIntentions: []
      })
    );
    const answerer = createOpenAIContextAnswerer({ client });

    await expect(answerer.answer(contextAnswerRequest())).rejects.toMatchObject({
      code: "openai-context-answer-schema-invalid"
    });
  });

  it("rejects an empty structured response", async () => {
    const answerer = createOpenAIContextAnswerer({
      client: new FakeOpenAIContextAnswererResponseClient("")
    });

    await expect(answerer.answer(contextAnswerRequest())).rejects.toMatchObject({
      code: "openai-context-answer-empty"
    });
  });

  it("rejects malformed JSON without treating it as an answer", async () => {
    const answerer = createOpenAIContextAnswerer({
      client: new FakeOpenAIContextAnswererResponseClient("not JSON")
    });

    await expect(answerer.answer(contextAnswerRequest())).rejects.toMatchObject({
      code: "openai-context-answer-json-invalid"
    });
  });
});

function contextAnswerRequest(): ContextAnswerRequest {
  return {
    workspaceId: "workspace_dayova",
    inquiryId: "discord-message-100",
    question: "When might the release checklist be ready?",
    source: {
      providerId: "discord",
      conversationObjectId: "thread-42",
      anchorMessageId: "mention-42",
      snapshotRevision: 1,
      contentHash: "sha256:thread-snapshot",
      boundary: {
        mode: "thread",
        firstMessageId: "message-100",
        lastMessageId: "message-101",
        messageIds: ["message-100", "message-101"]
      }
    },
    evidence: [
      {
        evidenceId: "conversation:discord:mention-42:revision-1:message-100",
        providerId: "discord",
        conversationObjectId: "thread-42",
        anchorMessageId: "mention-42",
        sourceRevision: 1,
        messageId: "message-100",
        ordinal: 1,
        author: {
          providerUserId: "discord-fabius",
          displayName: "Fabius",
          personId: "person_fabius"
        },
        createdAt: "2026-08-08T09:00:00.000Z",
        editedAt: null,
        replyToMessageId: null,
        url: "https://discord.com/channels/guild/thread-42/message-100",
        state: "available",
        text: "Die Release-Checkliste könnte bis Montag fertig sein."
      },
      {
        evidenceId: "conversation:discord:mention-42:revision-1:message-101",
        providerId: "discord",
        conversationObjectId: "thread-42",
        anchorMessageId: "mention-42",
        sourceRevision: 1,
        messageId: "message-101",
        ordinal: 2,
        author: {
          providerUserId: "discord-jakob",
          displayName: "Jakob",
          personId: "person_jakob"
        },
        createdAt: "2026-08-08T09:01:00.000Z",
        editedAt: null,
        replyToMessageId: "message-100",
        url: "https://discord.com/channels/guild/thread-42/message-101",
        state: "available",
        text: "Danke — please keep the repository name Luma unchanged."
      }
    ],
    promptVersion: "context-ask-v1"
  };
}

function validAnswer() {
  return {
    answer: {
      text: "Fabius said the release checklist might be ready on Monday.",
      evidenceIds: ["conversation:discord:mention-42:revision-1:message-100"]
    },
    facts: [
      {
        text: "Fabius used conditional language about Monday.",
        evidenceIds: ["conversation:discord:mention-42:revision-1:message-100"]
      }
    ],
    inferences: [
      {
        text: "The date is not yet a confirmed commitment.",
        evidenceIds: ["conversation:discord:mention-42:revision-1:message-100"],
        confidence: "high"
      }
    ],
    unresolved: ["Whether the checklist is ultimately completed remains unresolved."]
  };
}
