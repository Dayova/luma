import { createContextIntelligence } from "../../src/context-intelligence/context-intelligence.js";
import { createObservedSourceLedger } from "../../src/knowledge/observed-source-ledger.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { describe, expect, it } from "vitest";
import { discordPollEvidence } from "../../src/discord/discord-poll-evidence.js";
import type { ContextAnswerRequest } from "../../src/context-intelligence/context-answerer.js";
import {
  createDiscordConversationEvidenceSource,
  type DiscordConversationMessage,
  type DiscordConversationMessagePage,
  type DiscordConversationReader,
  type DiscordConversationThread
} from "../../src/discord/discord-conversation-evidence-source.js";
import type { DiscordContextAskConfig } from "../../src/discord/discord-context-ask-runtime.js";

const contextAskConfig: DiscordContextAskConfig = {
  parentChannelIds: ["channel_context"],
  allowedDiscordUserIds: ["user_jakob"],
  maxMessages: 10,
  maxEvidenceChars: 2_000,
  minIntervalMs: 60_000
};

class ProgrammableDiscordConversationReader implements DiscordConversationReader {
  thread: DiscordConversationThread | null = thread();
  anchor: DiscordConversationMessage | null = humanMessage({
    id: "message_ask",
    content: "<@bot_luma> What did we decide?",
    createdAt: "2026-08-08T10:00:00.000Z"
  });
  pages = new Map<string, DiscordConversationMessagePage>();
  pageError: Error | null = null;
  readThreadInputs: Array<{ conversationObjectId: string }> = [];
  readMessageInputs: Array<{ conversationObjectId: string; messageId: string }> = [];
  pageInputs: Array<{
    conversationObjectId: string;
    beforeMessageId: string;
    limit: number;
  }> = [];

  readThread(input: {
    conversationObjectId: string;
  }): Promise<DiscordConversationThread | null> {
    this.readThreadInputs.push(input);
    return Promise.resolve(this.thread);
  }

  readMessage(input: {
    conversationObjectId: string;
    messageId: string;
  }): Promise<DiscordConversationMessage | null> {
    this.readMessageInputs.push(input);
    return Promise.resolve(this.anchor);
  }

  listMessagesBefore(input: {
    conversationObjectId: string;
    beforeMessageId: string;
    limit: number;
  }): Promise<DiscordConversationMessagePage> {
    this.pageInputs.push(input);

    if (this.pageError) {
      return Promise.reject(this.pageError);
    }

    return Promise.resolve(this.pages.get(input.beforeMessageId) ?? emptyPage());
  }
}

describe("DiscordConversationEvidenceSource", () => {
  it("captures an ordinary founder anchor only for explicit consultation purpose, preserving the Ask mention contract", async () => {
    const reader = new ProgrammableDiscordConversationReader();
    reader.anchor = humanMessage({
      id: "message_ask",
      content: "We could defer this launch.",
      createdAt: "2026-08-08T10:00:00.000Z"
    });
    reader.anchor.mentionedDiscordUserIds = [];
    const source = createSource(reader);
    await expect(source.capture(captureInput())).rejects.toMatchObject({
      code: "discord-conversation-anchor-unavailable"
    });
    const captured = await source.capture({
      ...captureInput(),
      purpose: "consultation",
      question: "We could defer this launch."
    });
    expect(captured.snapshot.messages.at(-1)).toMatchObject({
      text: "We could defer this launch."
    });
    reader.anchor.content = "We will launch.";
    await expect(
      source.capture({
        ...captureInput(),
        purpose: "consultation",
        question: "We could defer this launch."
      })
    ).rejects.toMatchObject({ code: "discord-conversation-anchor-unavailable" });
    reader.anchor.author.providerUserId = "guest";
    await expect(
      source.capture({ ...captureInput(), purpose: "consultation" })
    ).rejects.toMatchObject({ code: "discord-conversation-anchor-unavailable" });
  });
  it("refuses an anchor whose poll and original text exceed the evidence budget before scanning history", async () => {
    const reader = new ProgrammableDiscordConversationReader();
    const poll = discordPollEvidence(
      {
        question: { text: "P".repeat(300) },
        answers: Array.from({ length: 10 }, (_, index) => ({
          answer_id: index + 1,
          poll_media: { text: "O".repeat(55) }
        })),
        expiry: null,
        allow_multiselect: false,
        layout_type: 1
      },
      "human"
    )!;
    reader.anchor = {
      ...reader.anchor!,
      content: `<@bot_luma> ${"Q".repeat(1000)}`,
      poll
    };
    await expect(
      createSource(reader).capture({ ...captureInput(), question: "Q".repeat(1000) })
    ).rejects.toThrow("evidence limit");
    expect(reader.pageInputs).toHaveLength(0);
  });
  it.each(["human", "luma-generated"] as const)(
    "uses %s polls as advisory Evidence with discussion, and invalidates changed results on replay",
    async (origin) => {
      const database = await createPgliteDatabase();
      try {
        const reader = new ProgrammableDiscordConversationReader();
        const poll = discordPollEvidence(
          {
            question: { text: "Adopt the idea?" },
            answers: [
              { answer_id: 2, poll_media: { text: "Adopt" } },
              { answer_id: 6, poll_media: { text: "Pause" } }
            ],
            expiry: "2026-08-09T12:00:00Z",
            allow_multiselect: true,
            layout_type: 1,
            results: {
              is_finalized: false,
              answer_counts: [
                { id: 2, count: 3 },
                { id: 6, count: 1 }
              ]
            }
          },
          origin
        )!;
        const pollMessage: DiscordConversationMessage = {
          ...humanMessage({
            id: "poll",
            content: "",
            createdAt: "2026-08-08T08:00:00.000Z"
          }),
          poll,
          authorKind: origin === "human" ? "human" : "bot",
          author: {
            providerUserId: origin === "human" ? "user_jakob" : "bot_luma",
            displayName: origin === "human" ? "Jakob" : "Luma"
          }
        };
        reader.pages.set("message_ask", {
          hasMore: false,
          messages: [
            humanMessage({
              id: "objection",
              content: "Philipp objects: the cost is too high.",
              createdAt: "2026-08-08T09:00:00.000Z"
            }),
            pollMessage
          ]
        });
        const requests: ContextAnswerRequest[] = [];
        const dependencies = {
          database,
          ledger: createObservedSourceLedger({ database }),
          conversationEvidenceSource: createSource(reader),
          answerer: {
            answer: (request: ContextAnswerRequest) => {
              requests.push(request);
              const cited = request.evidence.filter(
                (item) => item.poll || item.messageId === "objection"
              );
              return Promise.resolve({
                answer: {
                  text: "Adopt leads the provisional multi-select poll; Philipp objects. This is not a confirmed decision.",
                  evidenceIds: cited.map((item) => item.evidenceId)
                },
                facts: [],
                inferences: [],
                unresolved: [
                  "Counts do not establish who participated or decision authority."
                ],
                metadata: {
                  provider: "synthetic",
                  model: "programmable",
                  promptVersion: request.promptVersion
                }
              });
            }
          }
        };
        const inquiry = {
          type: "ask" as const,
          inquiryId: "poll-ask",
          question: "What did we decide?",
          ...captureInput()
        };
        const first = await createContextIntelligence(dependencies).inquire(inquiry);
        expect(first.boundary.completeness).toBe("complete");
        expect(first.answer.evidence.map((item) => item.messageId)).toEqual([
          "poll",
          "objection"
        ]);
        expect(requests[0]?.evidence.find((item) => item.poll)?.poll).toEqual(poll);
        expect(requests[0]?.evidence.find((item) => item.poll)?.text).toBe("");
        expect(await createContextIntelligence(dependencies).inquire(inquiry)).toEqual(
          first
        );
        expect(requests).toHaveLength(1);
        pollMessage.poll = {
          ...poll,
          results: {
            status: "finalized",
            counts: [
              { optionId: "2", votes: 3 },
              { optionId: "6", votes: 2 }
            ]
          }
        };
        await expect(
          createContextIntelligence(dependencies).inquire(inquiry)
        ).rejects.toThrow();
        expect(requests).toHaveLength(1);
        const rows = await database.query<{ raw_payload_json: string }>(
          "SELECT raw_payload_json FROM observed_source_snapshots"
        );
        expect(JSON.stringify(rows.rows)).toContain("provisional");
      } finally {
        await database.close();
      }
    }
  );
  it("answers repeated questions in one thread while retaining only Human Evidence and explicit Luma exclusions", async () => {
    const database = await createPgliteDatabase();
    try {
      const reader = new ProgrammableDiscordConversationReader();
      const original = humanMessage({
        id: "message_original",
        content: "We might release on Friday.",
        createdAt: "2026-08-08T09:00:00.000Z"
      });
      const history: DiscordConversationMessage[] = [original];
      let modelCalls = 0;
      const context = createContextIntelligence({
        database,
        ledger: createObservedSourceLedger({ database }),
        conversationEvidenceSource: createSource(reader),
        answerer: {
          answer: (request) => {
            modelCalls += 1;
            expect(
              request.evidence.every((item) => item.author.providerUserId !== "bot_luma")
            ).toBe(true);
            expect(
              request.evidence.some((item) =>
                item.text?.includes("AI-generated certainty")
              )
            ).toBe(false);
            return Promise.resolve({
              answer: {
                text: "Friday is tentative.",
                evidenceIds: [request.evidence[0]!.evidenceId]
              },
              facts: [],
              inferences: [],
              unresolved: [],
              metadata: {
                provider: "test",
                model: "programmable",
                promptVersion: request.promptVersion
              }
            });
          }
        }
      });
      for (const questionNumber of [1, 2, 3]) {
        const anchor = humanMessage({
          id: `message_ask_${questionNumber}`,
          content: "<@bot_luma> What did we decide?",
          createdAt: `2026-08-08T1${questionNumber}:00:00.000Z`
        });
        reader.anchor = anchor;
        reader.pages.set(anchor.id, { messages: [...history].reverse(), hasMore: false });
        const result = await context.inquire({
          type: "ask",
          workspaceId: "workspace_dayova",
          inquiryId: anchor.id,
          question: "What did we decide?",
          subject: { ...captureInput().subject, anchorMessageId: anchor.id }
        });
        if (questionNumber === 2) {
          const replay = await context.inquire({
            type: "ask",
            workspaceId: "workspace_dayova",
            inquiryId: anchor.id,
            question: "What did we decide?",
            subject: { ...captureInput().subject, anchorMessageId: anchor.id }
          });
          expect(replay).toEqual(result);
        }
        expect(result.answer.text).toBe("Friday is tentative.");
        expect(result.boundary.completeness).toBe("complete");
        expect(
          result.evidence.every((item) => item.author.providerUserId !== "bot_luma")
        ).toBe(true);
        if (questionNumber > 1)
          expect(result.warnings).toContainEqual({
            code: "conversation-assistant-output-excluded",
            message: `${questionNumber - 1} prior Luma text message(s) were excluded from Human Evidence.`
          });
        history.push(anchor, {
          ...humanMessage({
            id: `message_luma_${questionNumber}`,
            content: "AI-generated certainty",
            createdAt: `2026-08-08T1${questionNumber}:01:00.000Z`
          }),
          authorKind: "bot",
          author: { providerUserId: "bot_luma", displayName: "Luma" }
        });
      }
      expect(modelCalls).toBe(3);
    } finally {
      await database.close();
    }
  });

  it.each(["other-bot", "webhook", "poll"])(
    "does not silently exclude %s as verified Luma text output",
    async (kind) => {
      const reader = new ProgrammableDiscordConversationReader();
      reader.pages.set("message_ask", {
        messages: [
          {
            ...humanMessage({
              id: "message_generated",
              content: "Unverified output",
              createdAt: "2026-08-08T09:00:00.000Z"
            }),
            authorKind: kind === "webhook" ? "webhook" : "bot",
            author: {
              providerUserId: kind === "other-bot" ? "another_bot" : "bot_luma",
              displayName: "Luma"
            },
            hasUnsupportedContent: kind === "poll"
          }
        ],
        hasMore: false
      });
      const captured = await createSource(reader).capture(captureInput());
      expect(captured.snapshot.completeness.state).toBe("partial");
      expect(captured.snapshot.excludedMessages).toBeUndefined();
    }
  );

  it("keeps excluded Luma output inside the bounded scan limit", async () => {
    const reader = new ProgrammableDiscordConversationReader();
    reader.pages.set("message_ask", {
      messages: [
        {
          ...humanMessage({
            id: "message_luma",
            content: "A prior reply",
            createdAt: "2026-08-08T09:30:00.000Z"
          }),
          authorKind: "bot",
          author: { providerUserId: "bot_luma", displayName: "Luma" }
        },
        humanMessage({
          id: "message_original",
          content: "Older Human Evidence",
          createdAt: "2026-08-08T09:00:00.000Z"
        })
      ],
      hasMore: false
    });
    const captured = await createSource(reader, {
      ...contextAskConfig,
      maxMessages: 2
    }).capture(captureInput());
    expect(captured.snapshot.excludedMessages).toEqual([
      {
        messageId: "message_luma",
        providerUserId: "bot_luma",
        reason: "assistant-output"
      }
    ]);
    expect(captured.snapshot.completeness).toMatchObject({
      state: "partial",
      reasons: [{ code: "history-truncated" }]
    });
  });

  it("rejects an anchor whose current question differs from the original trigger", async () => {
    const reader = new ProgrammableDiscordConversationReader();
    await expect(
      createSource(reader).capture({
        ...captureInput(),
        question: "A different question"
      })
    ).rejects.toMatchObject({ code: "discord-conversation-anchor-unavailable" });
  });

  it("captures only chronological thread history through the mention anchor", async () => {
    const reader = new ProgrammableDiscordConversationReader();
    reader.pages.set("message_ask", {
      messages: [
        humanMessage({
          id: "message_2",
          content: "We might ship on Friday.",
          createdAt: "2026-08-08T09:30:00.000Z"
        }),
        humanMessage({
          id: "message_1",
          content: "The release candidate is ready.",
          createdAt: "2026-08-08T09:00:00.000Z"
        })
      ],
      hasMore: false
    });
    const source = createSource(reader);

    const captured = await source.capture(captureInput());

    expect(captured.source).toEqual({
      providerId: "discord",
      sourceKind: "conversation",
      sourceObjectId: "message_ask",
      parentObjectId: "thread_context",
      url: "https://discord.com/channels/guild_dayova/thread_context/message_ask"
    });
    expect(captured.snapshot.boundary).toEqual({
      mode: "thread",
      anchorMessageId: "message_ask",
      firstMessageId: "message_1",
      lastMessageId: "message_ask",
      messageIds: ["message_1", "message_2", "message_ask"]
    });
    expect(captured.snapshot.messages).toMatchObject([
      { id: "message_1", ordinal: 0, text: "The release candidate is ready." },
      { id: "message_2", ordinal: 1, text: "We might ship on Friday." },
      { id: "message_ask", ordinal: 2, text: "<@bot_luma> What did we decide?" }
    ]);
    expect(captured.snapshot.completeness).toEqual({ state: "complete" });
    expect(reader.pageInputs).toEqual([
      {
        conversationObjectId: "thread_context",
        beforeMessageId: "message_ask",
        limit: 10
      }
    ]);
  });

  it("fails closed with a partial boundary when a message cap excludes history", async () => {
    const reader = new ProgrammableDiscordConversationReader();
    reader.pages.set("message_ask", {
      messages: [
        humanMessage({
          id: "message_2",
          content: "A".repeat(1_990),
          createdAt: "2026-08-08T09:30:00.000Z"
        })
      ],
      hasMore: false
    });
    const source = createSource(reader, {
      ...contextAskConfig,
      maxMessages: 1
    });

    const captured = await source.capture(captureInput());

    expect(captured.snapshot.messages).toHaveLength(1);
    expect(captured.snapshot.completeness).toMatchObject({
      state: "partial",
      reasons: [
        {
          code: "history-truncated"
        }
      ]
    });
  });

  it("fails closed with a partial boundary when an evidence character cap excludes history", async () => {
    const reader = new ProgrammableDiscordConversationReader();
    reader.pages.set("message_ask", {
      messages: [
        humanMessage({
          id: "message_2",
          content: "A".repeat(1_990),
          createdAt: "2026-08-08T09:30:00.000Z"
        })
      ],
      hasMore: false
    });
    const source = createSource(reader, {
      ...contextAskConfig,
      maxMessages: 10,
      maxEvidenceChars: 2_000
    });

    const captured = await source.capture(captureInput());

    expect(captured.snapshot.messages.map((message) => message.id)).toEqual([
      "message_ask"
    ]);
    expect(captured.snapshot.completeness).toMatchObject({
      state: "partial",
      reasons: [{ code: "history-truncated" }]
    });
  });

  it("marks non-human or non-text historical evidence incomplete instead of treating it as original speech", async () => {
    const reader = new ProgrammableDiscordConversationReader();
    reader.pages.set("message_ask", {
      messages: [
        {
          ...humanMessage({
            id: "message_bot",
            content: "A prior bot response",
            createdAt: "2026-08-08T09:30:00.000Z"
          }),
          authorKind: "bot"
        },
        humanMessage({
          id: "message_attachment",
          content: "",
          createdAt: "2026-08-08T09:00:00.000Z"
        })
      ],
      hasMore: false
    });

    const captured = await createSource(reader).capture(captureInput());

    expect(captured.snapshot.completeness).toMatchObject({
      state: "partial",
      reasons: [
        { code: "unknown-provider-shape", messageId: "message_bot" },
        { code: "message-content-unavailable", messageId: "message_attachment" }
      ]
    });
    expect(captured.snapshot.messages.map((message) => message.id)).toEqual([
      "message_ask"
    ]);
  });

  it("marks text with unsupported Discord content partial without discarding its original text", async () => {
    const reader = new ProgrammableDiscordConversationReader();
    reader.pages.set("message_ask", {
      messages: [
        {
          ...humanMessage({
            id: "message_attachment",
            content: "The attached spreadsheet contains the numbers.",
            createdAt: "2026-08-08T09:00:00.000Z"
          }),
          hasUnsupportedContent: true
        }
      ],
      hasMore: false
    });

    const captured = await createSource(reader).capture(captureInput());

    expect(captured.snapshot.completeness).toMatchObject({
      state: "partial",
      reasons: [{ code: "message-content-unavailable", messageId: "message_attachment" }]
    });
    expect(captured.snapshot.messages).toContainEqual(
      expect.objectContaining({
        id: "message_attachment",
        text: "The attached spreadsheet contains the numbers."
      })
    );
  });

  it("persists the known anchor as partial when Discord history cannot be completed", async () => {
    const reader = new ProgrammableDiscordConversationReader();
    reader.pageError = new Error("Discord history request failed");

    const captured = await createSource(reader).capture(captureInput());

    expect(captured.snapshot.completeness).toMatchObject({
      state: "partial",
      reasons: [{ code: "pagination-incomplete" }]
    });
    expect(captured.snapshot.messages.map((message) => message.id)).toEqual([
      "message_ask"
    ]);
  });

  it("persists the known prefix as partial when Discord pagination is malformed", async () => {
    const reader = new ProgrammableDiscordConversationReader();
    reader.pages.set("message_ask", {
      messages: [],
      hasMore: true
    });

    const captured = await createSource(reader).capture(captureInput());

    expect(captured.snapshot.completeness).toMatchObject({
      state: "partial",
      reasons: [{ code: "pagination-incomplete" }]
    });
    expect(captured.snapshot.messages.map((message) => message.id)).toEqual([
      "message_ask"
    ]);
  });

  it("ignores Discord's structural public-thread starter without treating it as missing evidence", async () => {
    const reader = new ProgrammableDiscordConversationReader();
    reader.pages.set("message_ask", {
      messages: [
        {
          ...humanMessage({
            id: "thread_starter",
            content: "",
            createdAt: "2026-08-08T09:30:00.000Z"
          }),
          kind: "thread-starter",
          authorKind: "system"
        },
        humanMessage({
          id: "message_1",
          content: "The release candidate is ready.",
          createdAt: "2026-08-08T09:00:00.000Z"
        })
      ],
      hasMore: false
    });

    const captured = await createSource(reader, {
      ...contextAskConfig,
      maxMessages: 2
    }).capture(captureInput());

    expect(captured.snapshot.completeness).toEqual({ state: "complete" });
    expect(captured.snapshot.messages.map((message) => message.id)).toEqual([
      "message_1",
      "message_ask"
    ]);
  });

  it("rechecks the allowlisted public thread and exact human anchor before capture", async () => {
    const reader = new ProgrammableDiscordConversationReader();
    reader.thread = {
      ...thread(),
      visibility: "private"
    };

    await expect(createSource(reader).capture(captureInput())).rejects.toMatchObject({
      code: "discord-conversation-thread-not-allowed"
    });
    expect(reader.readMessageInputs).toEqual([]);

    reader.thread = thread();
    reader.anchor = {
      ...humanMessage({
        id: "message_ask",
        content: "<@bot_luma> What did we decide?",
        createdAt: "2026-08-08T10:00:00.000Z"
      }),
      author: {
        providerUserId: "user_unknown",
        displayName: "Unknown"
      }
    };

    await expect(createSource(reader).capture(captureInput())).rejects.toMatchObject({
      code: "discord-conversation-anchor-unavailable"
    });
    expect(reader.pageInputs).toEqual([]);
  });
});

function createSource(
  reader: DiscordConversationReader,
  config: DiscordContextAskConfig = contextAskConfig
) {
  return createDiscordConversationEvidenceSource({
    reader,
    guildId: "guild_dayova",
    config,
    botUserId: () => "bot_luma",
    now: () => new Date("2026-08-08T10:01:00.000Z")
  });
}

function captureInput() {
  return {
    workspaceId: "workspace_dayova",
    subject: {
      type: "conversation-thread" as const,
      providerId: "discord",
      conversationObjectId: "thread_context",
      anchorMessageId: "message_ask"
    }
  };
}

function thread(): DiscordConversationThread {
  return {
    id: "thread_context",
    guildId: "guild_dayova",
    parentChannelId: "channel_context",
    visibility: "public",
    title: "Context thread",
    url: "https://discord.com/channels/guild_dayova/thread_context"
  };
}

function emptyPage(): DiscordConversationMessagePage {
  return { messages: [], hasMore: false };
}

function humanMessage(input: {
  id: string;
  content: string;
  createdAt: string;
}): DiscordConversationMessage {
  return {
    id: input.id,
    channelId: "thread_context",
    kind: "message",
    hasUnsupportedContent: false,
    author: {
      providerUserId: "user_jakob",
      displayName: "Jakob"
    },
    authorKind: "human",
    mentionedDiscordUserIds: ["bot_luma"],
    content: input.content,
    createdAt: input.createdAt,
    editedAt: null,
    replyToMessageId: null,
    url: `https://discord.com/channels/guild_dayova/thread_context/${input.id}`
  };
}
