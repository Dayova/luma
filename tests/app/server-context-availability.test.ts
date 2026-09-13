import { expect, it } from "vitest";
import { startServer } from "../../src/app/server.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createAiUsageBudget } from "../../src/ai/ai-usage-budget.js";
import type { DiscordJsTransport } from "../../src/discord/discord-js-adapter.js";

it("answers founder thread mentions without an API key, before capture or paid work", async () => {
  const database = await createPgliteDatabase();
  const budget = createAiUsageBudget({ database, monthlyLimitUsd: 1 });
  const parent = "1507049196006408352";
  const thread = "1550000000000000001";
  const founder = "779381502311137301";
  let ask: Parameters<DiscordJsTransport["connect"]>[1];
  let captures = 0;
  const transport: DiscordJsTransport = {
    connect: (_command, handler) => {
      ask = handler;
      return Promise.resolve();
    },
    disconnect: () => Promise.resolve(),
    resolveChannel: ({ channelId }) =>
      Promise.resolve(
        channelId === thread
          ? {
              id: thread,
              guildId: "guild",
              kind: "public-thread",
              parentChannelId: parent
            }
          : channelId === parent
            ? {
                id: parent,
                guildId: "guild",
                kind: "text-channel",
                parentChannelId: null
              }
            : null
      ),
    createThread: () => Promise.reject(new Error("Not expected")),
    sendMessage: () => Promise.reject(new Error("Not expected")),
    capture: () => {
      captures++;
      return Promise.reject(new Error("No source capture needed to report missing key"));
    }
  };
  const app = await startServer(
    {
      DISCORD_TOKEN: "test",
      DISCORD_CLIENT_ID: "test",
      DISCORD_GUILD_ID: "guild",
      LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: parent,
      LUMA_DISCORD_CONTEXT_ASK_ENABLED: "1",
      LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS: parent,
      LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS: founder
    },
    {
      createDatabase: () => Promise.resolve(database),
      aiUsageBudget: budget,
      createDiscordTransport: () => transport,
      createOpenAIContextAnswerer: () => {
        throw new Error("Must not create an AI adapter without credentials");
      }
    }
  );
  try {
    if (!ask) throw new Error("Missing mention handler");
    const mention = {
      messageId: "1550000000000000002",
      guildId: "guild",
      channelId: thread,
      parentChannelId: parent,
      actorDiscordUserId: founder,
      question: "Reflektiert das Linear Issue Philipps Angaben?",
      occurredAt: "2026-09-13T15:05:00Z"
    };
    const reply = await ask(mention);
    expect(reply?.content).toContain("API key");
    expect(reply?.content).toContain("No AI call");
    expect(
      await ask({
        ...mention,
        messageId: "1550000000000000003",
        actorDiscordUserId: "999999999999999999"
      })
    ).toBeNull();
    expect(
      await ask({
        ...mention,
        messageId: "1550000000000000004",
        parentChannelId: "1550000000000000005"
      })
    ).toBeNull();
    const usage = await ask({
      ...mention,
      messageId: "1550000000000000006",
      question: "usage"
    });
    expect(usage?.content).toContain("Requests tracked: 0");
    expect(captures).toBe(0);
    expect((await budget.getStatus("workspace_dayova")).requestCount).toBe(0);
  } finally {
    await app.stop();
  }
});
