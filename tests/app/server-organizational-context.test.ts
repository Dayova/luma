import { describe, expect, it, vi } from "vitest";
import { startServer } from "../../src/app/server.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import type { DiscordJsTransport } from "../../src/discord/discord-js-adapter.js";
import type {
  ContextCatalog,
  ContextSource
} from "../../src/organizational-context/interface.js";
import type { ContextAnswerRequest } from "../../src/context-intelligence/context-answerer.js";
import type { StructuredReasoningRequest } from "../../src/ai/reasoning-model.js";
import type { RawConversationSnapshot } from "../../src/knowledge/observed-source-ledger.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";

const parent = "100000000000000002";
const thread = "100000000000000003";
const message = "100000000000000004";
const actor = "779381502311137301";
const time = "2026-09-10T10:00:00.000Z";
const env: NodeJS.ProcessEnv = {
  DISCORD_TOKEN: "test-only",
  DISCORD_CLIENT_ID: "client_context",
  DISCORD_GUILD_ID: "guild_context",
  OPENAI_API_KEY: "test-only",
  LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: parent,
  LUMA_DISCORD_CONTEXT_ASK_ENABLED: "1",
  LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS: parent,
  LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS: actor,
  LUMA_ORGANIZATIONAL_CONTEXT_ENABLED: "1",
  LUMA_CONTEXT_SHARING_POLICY_PATH: "/test/context-sharing.json",
  LUMA_CONTEXT_NOTION_READONLY_API_TOKEN: "test-only-reader",
  LUMA_CONTEXT_NOTION_CREDENTIAL_SCOPE_ID: "test-notion",
  LUMA_CONTEXT_NOTION_PAGE_IDS: "00000000-0000-0000-0000-000000000001"
};

describe("production organizational context composition", () => {
  it("rejects invalid or unreadable context configuration before opening persistence", async () => {
    const createDatabase = vi.fn(() => Promise.reject(new Error("must not open")));
    await expect(
      startServer(
        { ...env, LUMA_CONTEXT_SHARING_POLICY_PATH: "relative" },
        { createDatabase }
      )
    ).rejects.toThrow("absolute sharing-policy");
    await expect(startServer(env, { createDatabase })).rejects.toThrow();
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it("grounds actual Meeting and Discord Ask requests for all four founders and fences delivery after revocation", async () => {
    const database = await createPgliteDatabase();
    let command: Parameters<DiscordJsTransport["connect"]>[0] | undefined;
    let ask: Parameters<DiscordJsTransport["connect"]>[1];
    let readable = true;
    const audiences: string[][] = [];
    const source: ContextSource = {
      id: "ownership",
      kind: "knowledge-document",
      title: "Luma ownership",
      content: "Jakob owns Luma.",
      version: "1",
      updatedAt: time,
      standing: "current",
      authority: "human-confirmed",
      externalReference: {
        providerId: "notion",
        objectType: "document",
        externalId: "ownership",
        url: "https://www.notion.so/ownership"
      }
    };
    const catalog: ContextCatalog = {
      id: "reviewed-notion",
      search: ({ audience }) => {
        audiences.push([...audience.personIds]);
        return Promise.resolve({ sourceIds: [source.id], complete: true, warnings: [] });
      },
      read: ({ audience }) => {
        audiences.push([...audience.personIds]);
        return Promise.resolve(readable ? structuredClone(source) : null);
      }
    };
    const snapshot: RawConversationSnapshot = {
      schemaVersion: 1,
      conversation: {
        conversationObjectId: thread,
        parentConversationObjectId: parent,
        title: "Luma",
        url: `https://discord.com/channels/guild_context/${thread}`
      },
      boundary: {
        mode: "thread",
        anchorMessageId: message,
        firstMessageId: message,
        lastMessageId: message,
        messageIds: [message]
      },
      messages: [
        {
          id: message,
          ordinal: 0,
          author: {
            providerUserId: actor,
            displayName: "Jakob",
            personId: "person_jakob"
          },
          createdAt: time,
          editedAt: null,
          replyToMessageId: null,
          url: `https://discord.com/channels/guild_context/${thread}/${message}`,
          state: "available",
          text: "Who owns Luma?"
        }
      ],
      completeness: { state: "complete" }
    };
    const transport: DiscordJsTransport = {
      connect: (handler, contextHandler) => {
        command = handler;
        ask = contextHandler;
        return Promise.resolve();
      },
      disconnect: () => Promise.resolve(),
      resolveChannel: ({ channelId }) =>
        Promise.resolve({
          id: channelId,
          guildId: "guild_context",
          kind: channelId === parent ? "text-channel" : "public-thread",
          parentChannelId: channelId === parent ? null : parent
        }),
      createThread: () => Promise.resolve({ id: thread, url: snapshot.conversation.url }),
      sendMessage: () => Promise.resolve(),
      capture: () =>
        Promise.resolve({
          source: {
            providerId: "discord",
            sourceKind: "conversation",
            sourceObjectId: message,
            parentObjectId: thread,
            url: snapshot.messages[0]!.url
          },
          providerVersion: null,
          snapshot: structuredClone(snapshot),
          observedAt: time
        })
    };
    const meetingRequests: StructuredReasoningRequest<unknown>[] = [];
    const askRequests: ContextAnswerRequest[] = [];
    const app = await startServer(env, {
      createDatabase: () => Promise.resolve(database),
      createDiscordTransport: () => transport,
      createContextCatalogs: () => Promise.resolve([catalog]),
      createOpenAIReasoningModel: () => ({
        generateStructured<T>(request: StructuredReasoningRequest<T>) {
          meetingRequests.push(request);
          return Promise.resolve({
            value: {
              actionItems: [],
              decisions: [],
              openQuestions: [],
              risks: [],
              followUpIntentions: []
            } as T,
            metadata: {
              provider: "programmable",
              model: "synthetic",
              promptVersion: request.promptVersion
            }
          });
        }
      }),
      createOpenAIContextAnswerer: () => ({
        answer: (request) => {
          askRequests.push(request);
          const evidence = request.organizationalEvidence?.[0];
          if (!evidence) throw new Error("Actual organizational evidence is required");
          return Promise.resolve({
            answer: { text: "Jakob owns Luma.", evidenceIds: [evidence.evidenceId] },
            facts: [],
            inferences: [],
            unresolved: [],
            metadata: {
              provider: "programmable",
              model: "synthetic",
              promptVersion: request.promptVersion
            }
          });
        }
      })
    });
    try {
      if (!command || !ask) throw new Error("Both Discord entrypoints must be connected");
      const base = {
        guildId: "guild_context",
        channelId: parent,
        actorDiscordUserId: actor,
        occurredAt: time
      };
      await command({
        ...base,
        interactionId: "start",
        type: "start",
        title: "Luma ownership",
        languageMode: "en"
      });
      await command({
        ...base,
        channelId: thread,
        interactionId: "note",
        type: "note",
        language: "en",
        text: "We should discuss Luma ownership."
      });
      expect(meetingRequests).toHaveLength(1);
      expect(meetingRequests[0]?.context.join(" ")).toContain("Jakob owns Luma.");
      expect(
        meetingRequests[0]?.evidence.some((item) => item.source === "knowledge")
      ).toBe(true);
      const response = await ask({
        ...base,
        channelId: thread,
        parentChannelId: parent,
        messageId: message,
        question: "Who owns Luma?"
      });
      expect(askRequests).toHaveLength(1);
      expect(response?.content).toContain("Jakob owns Luma.");
      expect(response?.content).toContain("notion.so/ownership");
      expect(audiences.length).toBeGreaterThan(0);
      expect(
        audiences.every(
          (ids) =>
            JSON.stringify([...ids].sort()) ===
            JSON.stringify([...dayovaFounderPersonIds].sort())
        )
      ).toBe(true);
      expect(response?.requireCurrent).toBeDefined();
      await response!.requireCurrent!();
      readable = false;
      await expect(response!.requireCurrent!()).rejects.toThrow();
      expect(askRequests).toHaveLength(1);
    } finally {
      await app.stop();
    }
  });
});
