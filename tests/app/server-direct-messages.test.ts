import { describe, expect, it } from "vitest";
import { z } from "zod";
import { startServer } from "../../src/app/server.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createAiUsageBudget } from "../../src/ai/ai-usage-budget.js";
import { createOpenAIContextAnswerer } from "../../src/context-intelligence/openai-context-answerer.js";
import type {
  DirectMessageEvent,
  DiscordDirectMessageTransport
} from "../../src/discord/discord-direct-messages.js";

const user = "779381502311137301";
const channel = "1550000000000000001";
const messageId = "1550000000000000100";
describe("application DM composition", () => {
  it.each([false, true])(
    "supports DMs independently of channel access (AI configured: %s)",
    async (ai) => {
      const database = await createPgliteDatabase();
      const accounting = await createPgliteDatabase();
      const budget = createAiUsageBudget({ database: accounting, monthlyLimitUsd: 1 });
      let handler: ((event: DirectMessageEvent) => Promise<void>) | undefined;
      const sent: { content: string }[] = [];
      let requests = 0;
      const dm: DiscordDirectMessageTransport = {
        onMessage: (callback) => {
          handler = callback;
        },
        botId: () => "1526147284822392952",
        recipient: () => Promise.resolve(user),
        read: () =>
          Promise.resolve({
            id: messageId,
            channelId: channel,
            authorId: user,
            bot: false,
            text: "I will test Luma tomorrow. What will I do?",
            createdAt: "2026-09-13T07:00:00Z",
            editedAt: null,
            unsupported: false
          }),
        before: () => Promise.resolve([]),
        send: (reply) => {
          const message = { content: reply.content };
          sent.push(message);
          return Promise.resolve({
            edit: (content: string) => {
              message.content = content;
              return Promise.resolve();
            },
            remove: () => {
              sent.splice(sent.indexOf(message), 1);
              return Promise.resolve();
            }
          });
        }
      };
      const app = await startServer(
        {
          DISCORD_TOKEN: "test",
          DISCORD_CLIENT_ID: "test",
          DISCORD_GUILD_ID: "test",
          LUMA_DISCORD_DM_ENABLED: "1",
          LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: "",
          ...(ai ? { OPENAI_API_KEY: "test" } : {})
        },
        {
          createDatabase: () => Promise.resolve(database),
          aiUsageBudget: budget,
          createDiscordTransport: () => ({
            directMessages: dm,
            connect: () => Promise.resolve(),
            disconnect: () => Promise.resolve(),
            resolveChannel: () => Promise.resolve(null),
            createThread: () => Promise.reject(new Error("No channels")),
            sendMessage: () => Promise.reject(new Error("No channel sends")),
            capture: () => Promise.reject(new Error("No channel capture"))
          }),
          createOpenAIContextAnswerer: (config) =>
            createOpenAIContextAnswerer({
              ...config,
              client: {
                create: (request) => {
                  requests++;
                  const evidence = z
                    .object({ evidence: z.array(z.object({ evidenceId: z.string() })) })
                    .parse(JSON.parse(request.input)).evidence;
                  return Promise.resolve({
                    outputText: JSON.stringify({
                      answer: {
                        text: "You will test Luma tomorrow.",
                        evidenceIds: [evidence[0]!.evidenceId]
                      },
                      facts: [],
                      inferences: [],
                      unresolved: []
                    }),
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
            })
        }
      );
      try {
        if (!handler) throw new Error("DM handler missing");
        await handler({ channelId: channel, messageId, authorId: user });
        expect(sent).toHaveLength(1);
        expect(sent[0]?.content).toContain(ai ? "test Luma" : "AI setup or access");
        expect(requests).toBe(ai ? 1 : 0);
        const usage = await budget.getStatus("workspace_dayova");
        expect(usage.requestCount).toBe(ai ? 1 : 0);
        if (ai) expect(usage.spentUsd).toBeGreaterThan(0);
      } finally {
        await app.stop();
        await accounting.close();
      }
    }
  );
});
