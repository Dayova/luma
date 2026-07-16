import type {
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../ai/reasoning-model.js";
import { createOpenAIReasoningModelFromEnv } from "../ai/openai-reasoning-model.js";
import { createDiscordJsTransportFromEnv } from "../discord/discord-js-adapter.js";
import { createDiscordMeetingBot } from "../discord/discord-meeting-bot.js";
import { createFollowUpExecution } from "../follow-up-execution/follow-up-execution.js";
import { createIdentityDirectoryFromEnv } from "../identity/static-identity-directory.js";
import { createNotionKnowledgeProviderFromEnv } from "../knowledge/notion-knowledge-provider.js";
import { createMeetingIntelligence } from "../meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase } from "../persistence/db.js";
import { createLinearWorkProviderFromEnv } from "../work/linear-work-provider.js";
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
  const identityDirectory = createIdentityDirectoryFromEnv(env);
  const meetingIntelligence = createMeetingIntelligence({
    database,
    reasoningModel: reasoningModelFromEnv(env)
  });
  const workProvider = optionalLinearWorkProvider(env);
  const knowledgeProvider = optionalNotionKnowledgeProvider(env);
  const followUpExecution = createFollowUpExecution({
    database,
    meetingIntelligence,
    identityDirectory,
    ...(workProvider ? { workProvider } : {}),
    ...(knowledgeProvider ? { knowledgeProvider } : {})
  });
  const bot = createDiscordMeetingBot({
    database,
    meetingIntelligence,
    followUpExecution,
    identityDirectory,
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
      new Error("The production ReasoningModel Adapter is not configured")
    );
  }
};

function reasoningModelFromEnv(env: NodeJS.ProcessEnv): ReasoningModel {
  const provider = env["LUMA_REASONING_MODEL_PROVIDER"]?.trim() || "openai";

  if (provider === "disabled" || !hasAnyEnv(env, ["OPENAI_API_KEY"])) {
    return unavailableReasoningModel;
  }

  if (provider !== "openai") {
    throw new Error(`Unsupported LUMA_REASONING_MODEL_PROVIDER: ${provider}`);
  }

  return createOpenAIReasoningModelFromEnv(env);
}

function optionalLinearWorkProvider(env: NodeJS.ProcessEnv) {
  if (!hasAnyEnv(env, ["LINEAR_API_KEY", "LINEAR_TEAM_ID"])) {
    return undefined;
  }

  return createLinearWorkProviderFromEnv(env);
}

function optionalNotionKnowledgeProvider(env: NodeJS.ProcessEnv) {
  if (!hasAnyEnv(env, ["NOTION_API_TOKEN", "NOTION_MEETINGS_DATA_SOURCE_ID"])) {
    return undefined;
  }

  return createNotionKnowledgeProviderFromEnv(env);
}

function hasAnyEnv(env: NodeJS.ProcessEnv, keys: string[]): boolean {
  return keys.some((key) => {
    const value = env[key];
    return Boolean(value && value.trim().length > 0);
  });
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];

  if (!value || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }

  return value;
}
