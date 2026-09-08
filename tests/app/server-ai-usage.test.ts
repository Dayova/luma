import { describe, expect, it } from "vitest";
import { startServer } from "../../src/app/server.js";
import { createOpenAIReasoningModel } from "../../src/ai/openai-reasoning-model.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import type {
  DiscordCommand,
  DiscordCommandResponse
} from "../../src/discord/discord-meeting-bot.js";
import type { DiscordChannelSurface } from "../../src/discord/discord-channel-scope.js";
import type { DiscordJsTransport } from "../../src/discord/discord-js-adapter.js";

describe("production AI usage composition", () => {
  it("serves usage and saves notes at a zero cap without dispatching a model request", async () => {
    const database = await createPgliteDatabase();
    let dispatches = 0;
    let handler:
      ((command: DiscordCommand) => Promise<DiscordCommandResponse>) | undefined;
    const channels = new Map<string, DiscordChannelSurface>([
      [
        "100000000000000002",
        {
          id: "100000000000000002",
          guildId: "guild_budget",
          kind: "text-channel",
          parentChannelId: null
        }
      ]
    ]);
    const transport: DiscordJsTransport = {
      connect: (commandHandler) => {
        handler = commandHandler;
        return Promise.resolve();
      },
      disconnect: () => Promise.resolve(),
      resolveChannel: ({ channelId }) => Promise.resolve(channels.get(channelId) ?? null),
      createThread: ({ parentChannelId }) => {
        channels.set("thread_budget", {
          id: "thread_budget",
          guildId: "guild_budget",
          kind: "public-thread",
          parentChannelId
        });
        return Promise.resolve({
          id: "thread_budget",
          url: "https://discord.com/channels/guild_budget/thread_budget"
        });
      },
      sendMessage: () => Promise.resolve(),
      capture: () => Promise.reject(new Error("No capture expected for this command"))
    };
    const app = await startServer(
      {
        DISCORD_TOKEN: "test-only",
        DISCORD_CLIENT_ID: "client_budget",
        DISCORD_GUILD_ID: "guild_budget",
        OPENAI_API_KEY: "test-only",
        LUMA_AI_MONTHLY_LIMIT_USD: "0",
        LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: "100000000000000002"
      },
      {
        createDatabase: () => Promise.resolve(database),
        createDiscordTransport: () => transport,
        createOpenAIReasoningModel: (config) =>
          createOpenAIReasoningModel({
            ...config,
            client: {
              create: () => {
                dispatches += 1;
                return Promise.reject(
                  new Error("Paid dispatch must be blocked before this seam")
                );
              }
            }
          })
      }
    );
    const base = {
      guildId: "guild_budget",
      channelId: "100000000000000002",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-09-08T19:00:00.000Z"
    };

    try {
      if (!handler) throw new Error("Command handler was not connected");
      const usage = await handler({ ...base, interactionId: "usage", type: "usage" });
      expect(usage.content).toContain("$0.00");
      expect(usage.content).toContain("No AI call");
      expect(usage.content).toContain("paused");
      const outsider = await handler({
        ...base,
        actorDiscordUserId: "unmapped",
        interactionId: "denied",
        type: "usage"
      });
      expect(outsider.content).not.toContain("$0.00");

      await handler({
        ...base,
        interactionId: "start",
        type: "start",
        title: "Budget exploration",
        languageMode: "de"
      });
      const note = await handler({
        ...base,
        channelId: "thread_budget",
        interactionId: "note",
        type: "note",
        language: "de",
        text: "Wir könnten nächste Woche die Kosten prüfen."
      });
      expect(note.content).toContain("Note saved");
      expect(note.content).toContain("budget");
      expect(note.content).toContain("no new AI call");
      expect(dispatches).toBe(0);
      const evidence = await database.query<{ excerpt: string }>(
        "SELECT excerpt FROM evidence WHERE workspace_id = $1",
        ["workspace_dayova"]
      );
      expect(evidence.rows.map((row) => row.excerpt)).toContain(
        "Wir könnten nächste Woche die Kosten prüfen."
      );
    } finally {
      await app.stop();
    }
  });
});
