import { describe, expect, it } from "vitest";
import { startServer } from "../../src/app/server.js";
import type { ReasoningModel } from "../../src/ai/reasoning-model.js";
import type { ContextAnswerer } from "../../src/context-intelligence/context-answerer.js";
import type { DiscordJsTransport } from "../../src/discord/discord-js-adapter.js";
import type { LumaDatabase } from "../../src/persistence/db.js";

type StartServerDependencies = NonNullable<Parameters<typeof startServer>[1]>;

const scenarios = [
  {
    name: "a custom override",
    configuredModel: "gpt-5.6-custom",
    expectedModel: "gpt-5.6-custom"
  },
  {
    name: "an absent override",
    configuredModel: undefined,
    expectedModel: "gpt-5.6-luna"
  },
  {
    name: "a whitespace override",
    configuredModel: "   ",
    expectedModel: "gpt-5.6-luna"
  }
] as const;

describe("startServer OpenAI model composition", () => {
  for (const scenario of scenarios) {
    it(`forwards ${scenario.name} to Meeting analysis and Context Ask`, async () => {
      const harness = createServerHarness();
      const app = await startServer(
        serverEnv(scenario.configuredModel),
        harness.dependencies
      );

      try {
        expect(harness.meetingModels).toEqual([scenario.expectedModel]);
        expect(harness.contextAskModels).toEqual([scenario.expectedModel]);
      } finally {
        await app.stop();
      }
    });
  }
});

function createServerHarness(): {
  dependencies: StartServerDependencies;
  meetingModels: string[];
  contextAskModels: string[];
} {
  const meetingModels: string[] = [];
  const contextAskModels: string[] = [];
  const database = {
    close: () => Promise.resolve()
  } as unknown as LumaDatabase;
  const transport: DiscordJsTransport = {
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    createThread: () =>
      Promise.resolve({
        id: "thread_test",
        url: "https://discord.com/channels/guild_test/thread_test"
      }),
    sendMessage: () => Promise.resolve(),
    capture: () =>
      Promise.reject(new Error("Context Ask was not invoked during composition"))
  };
  const unavailableReasoningModel: ReasoningModel = {
    generateStructured: () =>
      Promise.reject(new Error("Meeting analysis was not invoked during composition"))
  };
  const unavailableContextAnswerer: ContextAnswerer = {
    answer: () =>
      Promise.reject(new Error("Context Ask was not invoked during composition"))
  };

  return {
    dependencies: {
      createDatabase: () => Promise.resolve(database),
      createDiscordTransport: () => transport,
      createOpenAIReasoningModel: (config) => {
        if (!config.model) {
          throw new Error("expected startServer to resolve a Meeting analysis model");
        }

        meetingModels.push(config.model);
        return unavailableReasoningModel;
      },
      createOpenAIContextAnswerer: (config) => {
        if (!config.model) {
          throw new Error("expected startServer to resolve a Context Ask model");
        }

        contextAskModels.push(config.model);
        return unavailableContextAnswerer;
      }
    },
    meetingModels,
    contextAskModels
  };
}

function serverEnv(configuredModel: string | undefined): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: "discord-test-token",
    DISCORD_CLIENT_ID: "discord-test-client",
    DISCORD_GUILD_ID: "guild_test",
    OPENAI_API_KEY: "openai-test-key",
    LUMA_DISCORD_CONTEXT_ASK_ENABLED: "1",
    LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS: "channel_test",
    LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS: "user_test",
    ...(configuredModel === undefined
      ? {}
      : { LUMA_REASONING_MODEL_NAME: configuredModel })
  };
}
