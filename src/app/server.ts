import { importedSourceAnalysisFromEnv } from "./imported-source-analysis-runtime.js";
import {
  organizationalContextRuntimeConfig,
  organizationalContextCatalogsFromEnv
} from "./organizational-context-runtime.js";
import {
  createOrganizationalContext,
  createExternalContextReceiptVerifier
} from "../organizational-context/organizational-context.js";
import {
  createImportedMeetingContextCatalog,
  importedMeetingContextCatalogId
} from "../meeting-intelligence/imported-meeting-context-catalog.js";
import { createMeetingContextGuard } from "../meeting-intelligence/context-guard.js";
import { discordAllowedParentChannelIdsFromEnv } from "../discord/discord-channel-scope.js";
import type {
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../ai/reasoning-model.js";
import { createOpenAIReasoningModel } from "../ai/openai-reasoning-model.js";
import { openAIReasoningModelNameFromEnv } from "../ai/openai-model-config.js";
import {
  aiUsageBudgetSettingsFromEnv,
  createAiUsageBudget,
  isAiModelPriced,
  type AiUsageBudget
} from "../ai/ai-usage-budget.js";
import { aiRequestLimitsFromEnv } from "../ai/ai-request.js";
import { AiServiceError } from "../ai/ai-service-error.js";
import { createDiscordJsTransportFromEnv } from "../discord/discord-js-adapter.js";
import { createDiscordMeetingBot } from "../discord/discord-meeting-bot.js";
import { createDiscordImportedMeetingAccess } from "../discord/discord-imported-meeting-access.js";
import { discordContextAskConfigFromEnv } from "../discord/discord-context-ask-runtime.js";
import { createOpenAIContextAnswerer } from "../context-intelligence/openai-context-answerer.js";
import { createContextIntelligence } from "../context-intelligence/context-intelligence.js";
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
import { dayovaFounderPersonIds } from "./founder-access.js";
import { createWorkspaceAccessPolicy } from "../access/workspace-access-policy.js";

export type RunningLumaApp = {
  stop(): Promise<void>;
  gatewayConnected(): boolean;
};

/** Deliberate startup cancellation after all acquired resources were released. */
export class LumaStartupCancelledError extends Error {
  constructor() {
    super("Luma startup was cancelled and its resources were released");
    this.name = "LumaStartupCancelledError";
  }
}

/**
 * Production adapter factories vary at the application-composition seam.
 * Keeping them injectable lets this wiring be verified without provider calls.
 */
type StartServerDependencies = {
  createDatabase?: typeof createPgliteDatabase;
  createDiscordTransport?: typeof createDiscordJsTransportFromEnv;
  createOpenAIReasoningModel?: typeof createOpenAIReasoningModel;
  createOpenAIContextAnswerer?: typeof createOpenAIContextAnswerer;
  createContextCatalogs?: typeof organizationalContextCatalogsFromEnv;
};

const legacyMeetingNotesSourceEnvironment = [
  "NOTION_API_TOKEN",
  "NOTION_MEETINGS_DATA_SOURCE_ID"
] as const;

const notionObservationTopologyEnvironment = [
  "LUMA_OBSERVATION_WORKSPACE_ID",
  "LUMA_NOTION_OBSERVATION_READONLY_API_TOKEN",
  "LUMA_NOTION_OBSERVATION_MEETINGS_DATA_SOURCE_ID",
  "LUMA_NOTION_OBSERVATION_WORKSPACE_ID",
  "LUMA_NOTION_OBSERVATION_SUBSCRIPTION_ID",
  "LUMA_NOTION_OBSERVATION_INTEGRATION_ID",
  "LUMA_NOTION_OBSERVATION_WEBHOOK_VERIFICATION_TOKEN",
  "LUMA_NOTION_OBSERVATION_PGLITE_DATA_DIR"
] as const;

export async function startServer(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: StartServerDependencies = {},
  startupSignal?: AbortSignal
): Promise<RunningLumaApp> {
  const createDatabase = dependencies.createDatabase ?? createPgliteDatabase;
  const createDiscordTransport =
    dependencies.createDiscordTransport ?? createDiscordJsTransportFromEnv;
  const createReasoningModel =
    dependencies.createOpenAIReasoningModel ?? createOpenAIReasoningModel;
  const createContextAnswerer =
    dependencies.createOpenAIContextAnswerer ?? createOpenAIContextAnswerer;
  const config = loadAppConfigFromEnv(env);
  rejectConflictingNotionMeetingNotesTopology(env);
  const guildId = requireEnv(env, "DISCORD_GUILD_ID");
  const allowedParentChannelIds = discordAllowedParentChannelIdsFromEnv(env);
  const discordContextAskConfig = discordContextAskConfigFromEnv(env);
  if (
    discordContextAskConfig?.parentChannelIds.some(
      (id) => !allowedParentChannelIds.includes(id)
    )
  ) {
    throw new Error(
      "Discord Context Ask parent channels must be within LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS"
    );
  }
  const openAIReasoningModelName = openAIReasoningModelNameFromEnv(env);
  // Validate operating limits before acquiring database or transport resources.
  const aiBudgetSettings = aiUsageBudgetSettingsFromEnv(env);
  const aiRequestLimits = aiRequestLimitsFromEnv(env);
  const contextConfig = organizationalContextRuntimeConfig(env);

  if (discordContextAskConfig && !hasAnyEnv(env, ["OPENAI_API_KEY"])) {
    throw new Error("OPENAI_API_KEY is required when Discord Context Ask is enabled");
  }

  const identityDirectory = createIdentityDirectoryFromEnv(env);
  const workspaceId = env["LUMA_WORKSPACE_ID"] ?? "workspace_dayova";
  const accessPolicy = createWorkspaceAccessPolicy({
    workspaceId,
    identityDirectory,
    authorizedPersonIds: dayovaFounderPersonIds
  });
  for (const providerUserId of discordContextAskConfig?.allowedDiscordUserIds ?? []) {
    if (
      !(await accessPolicy.authorize({
        workspaceId,
        providerId: "discord",
        providerUserId
      }))
    ) {
      throw new Error(
        "Context Ask users must each uniquely map to an authorized Luma founder"
      );
    }
  }

  const externalContextCatalogs = contextConfig
    ? await (dependencies.createContextCatalogs ?? organizationalContextCatalogsFromEnv)({
        workspaceId,
        env
      })
    : undefined;
  if (startupSignal?.aborted) throw new LumaStartupCancelledError();
  const database = await createDatabase(env["LUMA_PGLITE_DATA_DIR"] ?? ".luma/pglite");
  const startupCleanup: Array<() => Promise<void>> = [() => database.close()];
  try {
    // A database initialization already in flight must finish before we can
    // close its owned resources; never race away from an unreturned handle.
    startupSignal?.throwIfAborted();
    const aiUsage = createAiUsageBudget({
      ...aiBudgetSettings,
      database,
      configured:
        isAiModelPriced(openAIReasoningModelName) &&
        hasAnyEnv(env, ["OPENAI_API_KEY"]) &&
        (env["LUMA_REASONING_MODEL_PROVIDER"]?.trim() !== "disabled" ||
          discordContextAskConfig !== undefined)
    });
    const contextAudience = (requestedWorkspaceId: string) =>
      Promise.resolve(
        requestedWorkspaceId === workspaceId
          ? { workspaceId, personIds: [...dayovaFounderPersonIds] }
          : null
      );
    const workProvider = optionalLinearWorkProvider(env);
    const observedSourceLedger = createObservedSourceLedger({ database });
    const operationalOutcomeMarkerVerifier = createOperationalOutcomeMarkerVerifier({
      database
    });
    const importedSourceAnalysis = importedSourceAnalysisFromEnv({
      workspaceId,
      env,
      ledger: observedSourceLedger,
      operationalOutcomeMarkerVerifier
    });
    const contextCatalogs = [...(externalContextCatalogs ?? [])];
    if (importedSourceAnalysis) {
      contextCatalogs.push(
        createImportedMeetingContextCatalog({
          database,
          sourceAccess: importedSourceAnalysis.access,
          externalContext: createExternalContextReceiptVerifier({
            database,
            catalogs: externalContextCatalogs ?? [],
            ignoredEmptyCatalogIds: [importedMeetingContextCatalogId]
          })
        })
      );
    }
    const organizationalContext =
      externalContextCatalogs || contextCatalogs.length
        ? createOrganizationalContext({ database, catalogs: contextCatalogs })
        : undefined;
    const workItemProviderId = workProvider?.providerId ?? "linear";
    const discordTransport = createDiscordTransport(env, discordContextAskConfig);
    startupCleanup.push(() => discordTransport.disconnect());
    const workspace = {
      workspaceId,
      timezone: config.defaultWorkspaceTimezone,
      outputLanguagePolicy: config.outputLanguagePolicy,
      publishingPolicy: config.publishingPolicy
    };
    const meetingIntelligence = createMeetingIntelligence({
      database,
      ...(organizationalContext ? { organizationalContext, contextAudience } : {}),
      ...(importedSourceAnalysis ? { importedSourceAnalysis } : {}),
      reasoningModel: reasoningModelFromEnv(
        env,
        openAIReasoningModelName,
        createReasoningModel,
        aiUsage,
        aiRequestLimits
      ),
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
    if (meetingNotesSync) {
      startupCleanup.push(() => meetingNotesSync.stop());
    }
    const followUpExecution = createFollowUpExecution({
      database,
      organizationalContextGuard: createMeetingContextGuard({
        database,
        ...(organizationalContext ? { organizationalContext, contextAudience } : {}),
        ...(importedSourceAnalysis ? { importedSourceAnalysis } : {})
      }),
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
    const contextIntelligence = discordContextAskConfig
      ? createContextIntelligence({
          database,
          ...(organizationalContext ? { organizationalContext } : {}),
          ledger: observedSourceLedger,
          conversationEvidenceSource: discordTransport,
          answerer: createContextAnswerer({
            apiKey: requireEnv(env, "OPENAI_API_KEY"),
            model: openAIReasoningModelName,
            budget: aiUsage,
            limits: aiRequestLimits
          })
        })
      : undefined;
    const bot = createDiscordMeetingBot({
      database,
      meetingIntelligence,
      followUpExecution,
      identityDirectory,
      authorizedPersonIds: dayovaFounderPersonIds,
      transport: discordTransport,
      workspace,
      guildId,
      allowedParentChannelIds,
      aiUsage,
      ...(meetingNotesSource && importedSourceAnalysis
        ? {
            importedMeetingAccess: createDiscordImportedMeetingAccess({
              workspace,
              authorizedPersonIds: dayovaFounderPersonIds,
              ledger: observedSourceLedger,
              sourceAccess: importedSourceAnalysis.access,
              providerId: env["LUMA_NOTION_PROVIDER_ID"]?.trim() || "notion",
              workItemProviderId
            })
          }
        : {}),
      ...(discordContextAskConfig && contextIntelligence
        ? {
            contextAsk: {
              contextIntelligence,
              config: discordContextAskConfig
            }
          }
        : {})
    });

    await bot.start(startupSignal);
    startupSignal?.throwIfAborted();
    meetingNotesSync?.start();
    console.log(`Luma Discord bot connected in ${config.nodeEnv} mode`);

    let stopping: Promise<void> | undefined;
    return {
      gatewayConnected: () => discordTransport.gatewayConnected?.() ?? false,
      stop() {
        stopping ??= (async () => {
          // Stop admission and scheduled ingestion immediately, then drain both.
          // A failed/timed-out drain never closes the store later in a detached
          // continuation: its lease must survive process termination for recovery.
          await drainBeforeClose(Promise.all([bot.stop(), meetingNotesSync?.stop()]));
          await database.close();
        })();
        return stopping;
      }
    };
  } catch (error) {
    // A rejected startup cannot return stop() to its caller. Release every
    // acquired resource in reverse order and preserve the original failure.
    let cleanupFailed = false;
    for (const cleanup of startupCleanup.reverse()) {
      try {
        await cleanup();
      } catch {
        cleanupFailed = true;
        // Continue releasing the remaining resources before rethrowing.
      }
    }
    if (
      !cleanupFailed &&
      startupSignal?.aborted &&
      error instanceof Error &&
      error.name === "AbortError"
    ) {
      throw new LumaStartupCancelledError();
    }
    throw error;
  }
}

async function drainBeforeClose(operation: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        // Leave time for the entrypoint to report an unclean stop before
        // systemd's 120-second hard-stop deadline.
        timer = setTimeout(
          () => reject(new Error("Luma shutdown did not drain admitted work")),
          90_000
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const unavailableReasoningModel: ReasoningModel = {
  generateStructured<T>(
    _request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    void _request;
    return Promise.reject(
      new AiServiceError("not-configured", "Meeting analysis is not configured", {
        requestDispatched: false
      })
    );
  }
};

function reasoningModelFromEnv(
  env: NodeJS.ProcessEnv,
  model: string,
  createReasoningModel: typeof createOpenAIReasoningModel,
  budget: AiUsageBudget,
  limits: ReturnType<typeof aiRequestLimitsFromEnv>
): ReasoningModel {
  const provider = env["LUMA_REASONING_MODEL_PROVIDER"]?.trim() || "openai";

  if (provider === "disabled" || !hasAnyEnv(env, ["OPENAI_API_KEY"])) {
    return unavailableReasoningModel;
  }

  if (provider !== "openai") {
    throw new Error(`Unsupported LUMA_REASONING_MODEL_PROVIDER: ${provider}`);
  }

  return createReasoningModel({
    apiKey: requireEnv(env, "OPENAI_API_KEY"),
    model,
    budget,
    limits
  });
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

function hasAllEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  return keys.every((key) => {
    const value = env[key];
    return Boolean(value && value.trim().length > 0);
  });
}

/**
 * The legacy Discord process and the dedicated observer create independent
 * observed-source ledgers and marker verifiers. They cannot observe the same
 * canonical Meeting Notes source from one environment or PGlite ownership
 * would split. A deployed observer must be the sole source owner instead.
 */
function rejectConflictingNotionMeetingNotesTopology(env: NodeJS.ProcessEnv): void {
  if (
    hasAllEnv(env, legacyMeetingNotesSourceEnvironment) &&
    hasAllEnv(env, notionObservationTopologyEnvironment)
  ) {
    throw new Error(
      "Legacy Notion Meeting Notes sync and the Notion observation server cannot share one process environment"
    );
  }
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];

  if (!value || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }

  return value;
}
