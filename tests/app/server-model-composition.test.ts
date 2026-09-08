import { describe, expect, it } from "vitest";
import { startServer } from "../../src/app/server.js";
import type { ReasoningModel } from "../../src/ai/reasoning-model.js";
import type { ContextAnswerer } from "../../src/context-intelligence/context-answerer.js";
import type { DiscordJsTransport } from "../../src/discord/discord-js-adapter.js";
import type { LumaDatabase } from "../../src/persistence/db.js";
import type { OpenAIReasoningModelConfig } from "../../src/ai/openai-reasoning-model.js";
import type { OpenAIContextAnswererConfig } from "../../src/context-intelligence/openai-context-answerer.js";

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
  it("shares one budget and bounded request policy across both model capabilities", async () => {
    const harness = createServerHarness();
    const app = await startServer(serverEnv(undefined), harness.dependencies);
    try {
      const meeting = harness.meetingConfigs[0];
      const context = harness.contextConfigs[0];
      expect(meeting?.budget).toBeDefined();
      expect(meeting?.budget).toBe(context?.budget);
      expect(meeting?.limits).toEqual({
        maxInputTokens: 100_000,
        maxOutputTokens: 8_192,
        timeoutMs: 60_000
      });
      expect(meeting?.limits).toBe(context?.limits);
    } finally {
      await app.stop();
    }
  });

  it.each(["-1", "NaN", "30 dollars"])(
    "rejects invalid monthly budget %s before allocating resources",
    async (value) => {
      const harness = createServerHarness();
      let opened = false;
      await expect(
        startServer(
          { ...serverEnv(undefined), LUMA_AI_MONTHLY_LIMIT_USD: value },
          {
            ...harness.dependencies,
            createDatabase: () => {
              opened = true;
              return Promise.reject(new Error("resource allocation reached"));
            }
          }
        )
      ).rejects.toThrow();
      expect(opened).toBe(false);
    }
  );

  it.each([
    "779381502311137301",
    "726409024894926869",
    "1492911575806251219",
    "1376219174723911841"
  ])(
    "admits founder account %s to the production Context Ask configuration",
    async (providerUserId) => {
      const harness = createServerHarness();
      const app = await startServer(
        {
          ...serverEnv(undefined),
          LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS: providerUserId
        },
        harness.dependencies
      );
      await app.stop();
    }
  );

  it("rejects nonfounder Context Ask configuration before allocating resources", async () => {
    const harness = createServerHarness();
    let databaseOpened = false;
    await expect(
      startServer(
        {
          ...serverEnv(undefined),
          LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS: "unmapped_user"
        },
        {
          ...harness.dependencies,
          createDatabase: () => {
            databaseOpened = true;
            return Promise.reject(new Error("resource allocation reached"));
          }
        }
      )
    ).rejects.toThrow(
      "Context Ask users must each uniquely map to an authorized Luma founder"
    );
    expect(databaseOpened).toBe(false);
  });

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
  meetingConfigs: OpenAIReasoningModelConfig[];
  contextConfigs: OpenAIContextAnswererConfig[];
} {
  const meetingModels: string[] = [];
  const contextAskModels: string[] = [];
  const meetingConfigs: OpenAIReasoningModelConfig[] = [];
  const contextConfigs: OpenAIContextAnswererConfig[] = [];
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
        meetingConfigs.push(config);
        if (!config.model) {
          throw new Error("expected startServer to resolve a Meeting analysis model");
        }

        meetingModels.push(config.model);
        return unavailableReasoningModel;
      },
      createOpenAIContextAnswerer: (config) => {
        contextConfigs.push(config);
        if (!config.model) {
          throw new Error("expected startServer to resolve a Context Ask model");
        }

        contextAskModels.push(config.model);
        return unavailableContextAnswerer;
      }
    },
    meetingModels,
    contextAskModels,
    meetingConfigs,
    contextConfigs
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
    LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS: "779381502311137301",
    ...(configuredModel === undefined
      ? {}
      : { LUMA_REASONING_MODEL_NAME: configuredModel })
  };
}
