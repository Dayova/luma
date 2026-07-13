import type {
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../ai/reasoning-model.js";
import { createDiscordJsTransportFromEnv } from "../discord/discord-js-adapter.js";
import { createDiscordMeetingBot } from "../discord/discord-meeting-bot.js";
import { createIdentityDirectoryFromEnv } from "../identity/static-identity-directory.js";
import { createMeetingIntelligence } from "../meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase } from "../persistence/db.js";
import { loadAppConfigFromEnv } from "./env.js";

export type RunningLumaApp = {
  stop(): Promise<void>;
};

export async function startServer(
  env: NodeJS.ProcessEnv = process.env
): Promise<RunningLumaApp> {
  const config = loadAppConfigFromEnv(env);
  const guildId = requireEnv(env, "DISCORD_GUILD_ID");
  const database = await createPgliteDatabase(
    env["LUMA_PGLITE_DATA_DIR"] ?? ".luma/pglite"
  );
  const meetingIntelligence = createMeetingIntelligence({
    database,
    reasoningModel: unavailableReasoningModel
  });
  const bot = createDiscordMeetingBot({
    database,
    meetingIntelligence,
    identityDirectory: createIdentityDirectoryFromEnv(env),
    transport: createDiscordJsTransportFromEnv(env),
    workspace: {
      workspaceId: env["LUMA_WORKSPACE_ID"] ?? "workspace_dayova",
      timezone: config.defaultWorkspaceTimezone,
      outputLanguagePolicy: config.outputLanguagePolicy,
      publishingPolicy: config.publishingPolicy
    },
    guildId
  });

  await bot.start();
  console.log(`Luma Discord bot connected in ${config.nodeEnv} mode`);

  return {
    async stop() {
      await bot.stop();
      await database.close();
    }
  };
}

const unavailableReasoningModel: ReasoningModel = {
  generateStructured<T>(
    _request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    void _request;
    return Promise.reject(
      new Error("The production ReasoningModel Adapter is not configured yet")
    );
  }
};

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];

  if (!value || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }

  return value;
}
