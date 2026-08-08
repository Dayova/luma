import type {
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../ai/reasoning-model.js";
import { createOpenAIReasoningModelFromEnv } from "../ai/openai-reasoning-model.js";
import { createDiscordJsTransportFromEnv } from "../discord/discord-js-adapter.js";
import { createDiscordMeetingBot } from "../discord/discord-meeting-bot.js";
import { createFollowUpExecution } from "../follow-up-execution/follow-up-execution.js";
import { createOperationalOutcomeMarkerVerifier } from "../follow-up-execution/operational-outcome-marker-verifier.js";
import { createIdentityDirectoryFromEnv } from "../identity/static-identity-directory.js";
import { createMeetingNotesIngestion } from "../knowledge/meeting-notes-ingestion.js";
import { createMeetingNotesSync } from "../knowledge/meeting-notes-sync.js";
import { createLedgerBackedImportedSourceVerifier } from "../knowledge/ledger-backed-imported-source-verifier.js";
import { createLedgerBackedOperationalOutcomeSourceCurrentnessVerifier } from "../knowledge/ledger-backed-operational-outcome-source-currentness.js";
import { createLedgerBackedOperationalOutcomeSourceExecutionFence } from "../knowledge/ledger-backed-operational-outcome-source-execution-fence.js";
import { createNotionKnowledgeProviderFromEnv } from "../knowledge/notion-knowledge-provider.js";
import { createNotionMeetingNotesSourceFromEnv } from "../knowledge/notion-meeting-notes-source.js";
import { createNotionOperationalOutcomeWriter } from "../knowledge/notion-operational-outcome-writer.js";
import { createObservedSourceLedger } from "../knowledge/observed-source-ledger.js";
import { createMeetingIntelligence } from "../meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase } from "../persistence/db.js";
import { createLinearWorkProviderFromEnv } from "../work/linear-work-provider.js";
import { toWorkCatalog } from "../work/interface.js";
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
  const workProvider = optionalLinearWorkProvider(env);
  const observedSourceLedger = createObservedSourceLedger({ database });
  const operationalOutcomeMarkerVerifier = createOperationalOutcomeMarkerVerifier({
    database
  });
  const workItemProviderId = workProvider?.providerId ?? "linear";
  const workspace = {
    workspaceId: env["LUMA_WORKSPACE_ID"] ?? "workspace_dayova",
    timezone: config.defaultWorkspaceTimezone,
    outputLanguagePolicy: config.outputLanguagePolicy,
    publishingPolicy: config.publishingPolicy
  };
  const meetingIntelligence = createMeetingIntelligence({
    database,
    reasoningModel: reasoningModelFromEnv(env),
    ...(workProvider ? { workCatalogs: [toWorkCatalog(workProvider)] } : {}),
    ...(hasAnyEnv(env, ["NOTION_API_TOKEN", "NOTION_MEETINGS_DATA_SOURCE_ID"])
      ? {
          importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
            ledger: observedSourceLedger,
            workItemProviderId
          })
        }
      : {})
  });
  const knowledgeProvider = optionalNotionKnowledgeProvider(env);
  const meetingNotesSource = optionalNotionMeetingNotesSource(
    env,
    observedSourceLedger,
    operationalOutcomeMarkerVerifier
  );
  const operationalOutcomeWriter = optionalNotionOperationalOutcomeWriter(
    env,
    operationalOutcomeMarkerVerifier
  );
  const meetingNotesSyncIntervalMs = meetingNotesSyncIntervalFromEnv(env);
  const meetingNotesSync = meetingNotesSource
    ? createMeetingNotesSync({
        workspace,
        source: meetingNotesSource,
        ingestion: createMeetingNotesIngestion({
          meetingIntelligence,
          workItemProviderId
        }),
        ...(meetingNotesSyncIntervalMs !== undefined
          ? { intervalMs: meetingNotesSyncIntervalMs }
          : {})
      })
    : undefined;
  const followUpExecution = createFollowUpExecution({
    database,
    meetingIntelligence,
    identityDirectory,
    ...(workProvider ? { workProvider } : {}),
    ...(knowledgeProvider ? { knowledgeProvider } : {}),
    ...(operationalOutcomeWriter ? { operationalOutcomeWriter } : {}),
    ...(meetingNotesSource
      ? {
          operationalOutcomeSourceExecutionFence:
            createLedgerBackedOperationalOutcomeSourceExecutionFence({
              ledger: observedSourceLedger
            })
        }
      : {}),
    ...(meetingNotesSource
      ? {
          operationalOutcomeSourceCurrentnessVerifier:
            createLedgerBackedOperationalOutcomeSourceCurrentnessVerifier({
              ledger: observedSourceLedger
            })
        }
      : {})
  });
  const bot = createDiscordMeetingBot({
    database,
    meetingIntelligence,
    followUpExecution,
    identityDirectory,
    transport: createDiscordJsTransportFromEnv(env),
    workspace,
    guildId
  });

  await bot.start();
  meetingNotesSync?.start();
  console.log(`Luma Discord bot connected in ${config.nodeEnv} mode`);

  return {
    async stop() {
      try {
        await meetingNotesSync?.stop();
      } finally {
        try {
          await bot.stop();
        } finally {
          await database.close();
        }
      }
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

function optionalNotionMeetingNotesSource(
  env: NodeJS.ProcessEnv,
  ledger: ReturnType<typeof createObservedSourceLedger>,
  operationalOutcomeMarkerVerifier: ReturnType<
    typeof createOperationalOutcomeMarkerVerifier
  >
) {
  if (!hasAnyEnv(env, ["NOTION_API_TOKEN", "NOTION_MEETINGS_DATA_SOURCE_ID"])) {
    return undefined;
  }

  return createNotionMeetingNotesSourceFromEnv({
    env,
    ledger,
    operationalOutcomeMarkerVerifier
  });
}

function optionalNotionOperationalOutcomeWriter(
  env: NodeJS.ProcessEnv,
  markerVerifier: ReturnType<typeof createOperationalOutcomeMarkerVerifier>
) {
  const token = env["NOTION_API_TOKEN"]?.trim();

  if (!token) {
    return undefined;
  }

  const providerId = env["LUMA_NOTION_PROVIDER_ID"]?.trim();

  return createNotionOperationalOutcomeWriter({
    token,
    ...(providerId ? { providerId } : {}),
    markerVerifier
  });
}

function meetingNotesSyncIntervalFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const configured = env["LUMA_NOTION_MEETING_SYNC_INTERVAL_MS"]?.trim();

  if (!configured) {
    return undefined;
  }

  const intervalMs = Number(configured);

  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("LUMA_NOTION_MEETING_SYNC_INTERVAL_MS must be a positive integer");
  }

  return intervalMs;
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
