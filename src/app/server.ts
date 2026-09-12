import {
  nativeNotionReviewConfig,
  createNativeNotionReviewResources
} from "./native-notion-review-config.js";
import { createImportedSourceAnalysisRouter } from "./imported-source-analysis-router.js";
import type { DecisionRecallStatus } from "../organizational-context/decision-recall-runtime.js";
import {
  createAutomaticDecisionProcessing,
  type AutomaticDecisionProcessingStatus
} from "./automatic-decision-processing.js";
import { createMeetingCaptureRuntime } from "./meeting-capture-runtime.js";
import {
  meetingCaptureRuntimeConfig,
  createMeetingSynthesisRuntime
} from "./meeting-capture-config.js";
import {
  granolaOAuthRuntimeConfig,
  granolaOAuthConnectionsFromEnv
} from "./granola-oauth-runtime.js";
import { createGranolaOAuthCallbackHost } from "./granola-oauth-callback-host.js";
import { createDiscordCaptureReviewRuntime } from "../discord/discord-capture-review-runtime.js";
import { createDiscordGranolaRuntime } from "../discord/discord-granola-runtime.js";
import { discordDecisionRecordConfigFromEnv } from "../discord/discord-decision-record-runtime.js";
import { createDecisionRuntime, decisionRuntimeConfig } from "./decision-runtime.js";
import { createLogicalMeetingDecisionEvidenceSource } from "../decision-intelligence/logical-meeting-evidence-source.js";
import { createDiscordDecisionPermissionSourceAccess } from "../discord/discord-decision-standing-runtime.js";
import { createNotionCanonicalKnowledgePatchWriter } from "../knowledge/notion-canonical-knowledge-patch-writer.js";
import { discordConsultationConfigFromEnv } from "../discord/discord-consultation-runtime.js";
import { createConversationConsultations } from "../context-intelligence/conversation-consultations.js";
import {
  createNotionWebhookRuntime,
  notionWebhookRuntimeConfig
} from "./notion-webhook-runtime.js";
import type { createNotionWebhookHttpServer } from "./notion-webhook-http-server.js";
import type { NotionMeetingNotesObservationHostStatus } from "./notion-meeting-notes-observation-host.js";
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
import {
  createStructuredWorkRuntime,
  structuredWorkRuntimeConfig,
  validateStructuredWorkFounderScope
} from "./structured-work-runtime.js";
import { toWorkCatalog } from "../work/interface.js";
import { loadAppConfigFromEnv } from "./env.js";
import { dayovaFounderPersonIds } from "./founder-access.js";
import { createWorkspaceAccessPolicy } from "../access/workspace-access-policy.js";
import type { RuntimeCapabilityProblem } from "./runtime-health.js";

export type RunningLumaApp = {
  capabilityProblems?(): Promise<RuntimeCapabilityProblem[]>;
  automaticDecisionStatus?(): Promise<AutomaticDecisionProcessingStatus | null>;
  stop(): Promise<void>;
  gatewayConnected(): boolean;
  decisionRecallStatus?(): Promise<DecisionRecallStatus | null>;
  notionObservationStatus?(): NotionMeetingNotesObservationHostStatus | null;
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
  aiUsageBudget?: AiUsageBudget;
  createNativeNotionReviewResources?: typeof createNativeNotionReviewResources;
  createStructuredWorkRuntime?: typeof createStructuredWorkRuntime;
  createWorkProvider?: typeof createLinearWorkProviderFromEnv;
  createGranolaConnections?: typeof granolaOAuthConnectionsFromEnv;
  createGranolaCallbackHost?: typeof createGranolaOAuthCallbackHost;
  createMeetingSynthesisWriter?: typeof createMeetingSynthesisRuntime;
  createDatabase?: typeof createPgliteDatabase;
  createDiscordTransport?: typeof createDiscordJsTransportFromEnv;
  createOpenAIReasoningModel?: typeof createOpenAIReasoningModel;
  createOpenAIContextAnswerer?: typeof createOpenAIContextAnswerer;
  createContextCatalogs?: typeof organizationalContextCatalogsFromEnv;
  createNotionWebhookHttpServer?: typeof createNotionWebhookHttpServer;
  createDecisionRuntime?: typeof createDecisionRuntime;
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
  const consultationConfig = discordConsultationConfigFromEnv(env);
  const decisionRecordConfig = discordDecisionRecordConfigFromEnv(env);
  if (
    decisionRecordConfig?.parentChannelIds.some(
      (id) => !allowedParentChannelIds.includes(id)
    )
  )
    throw new Error(
      "Decision Record parent channels must be within the common Discord scope"
    );
  if (decisionRecordConfig && !hasAnyEnv(env, ["OPENAI_API_KEY"]))
    throw new Error(
      "OPENAI_API_KEY is required when Discord Decision Records are enabled"
    );
  if (
    consultationConfig?.capture.parentChannelIds.some(
      (id) => !allowedParentChannelIds.includes(id)
    )
  )
    throw new Error(
      "Consultation parent channels must be within the common Discord scope"
    );
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
  const decisionConfig = decisionRuntimeConfig(env, decisionRecordConfig !== undefined);
  const structuredWorkConfig = structuredWorkRuntimeConfig(env);
  const nativeReviewConfig = nativeNotionReviewConfig(env);
  const captureConfig = meetingCaptureRuntimeConfig(env);
  const granolaConfig = granolaOAuthRuntimeConfig(env);
  if (granolaConfig && !captureConfig?.granolaEnabled)
    throw new Error(
      "Granola onboarding requires the configured capture synthesis runtime"
    );

  if (discordContextAskConfig && !hasAnyEnv(env, ["OPENAI_API_KEY"])) {
    throw new Error("OPENAI_API_KEY is required when Discord Context Ask is enabled");
  }

  const identityDirectory = createIdentityDirectoryFromEnv(env);
  const workspaceId = env["LUMA_WORKSPACE_ID"] ?? "workspace_dayova";
  const webhookConfig = notionWebhookRuntimeConfig(env, workspaceId);
  const accessPolicy = createWorkspaceAccessPolicy({
    workspaceId,
    identityDirectory,
    authorizedPersonIds: dayovaFounderPersonIds
  });
  if (structuredWorkConfig)
    await validateStructuredWorkFounderScope({
      config: structuredWorkConfig,
      workspaceId,
      identityDirectory,
      accessPolicy
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

  const resolveConsultationRecipients = async (
    personIds: readonly string[]
  ): Promise<string[] | null> => {
    const ids: string[] = [];
    for (const personId of personIds) {
      const person = await identityDirectory.getPerson({ workspaceId, personId });
      if (!person?.discordUserId) return null;
      const authorized = await accessPolicy.authorize({
        workspaceId,
        providerId: "discord",
        providerUserId: person.discordUserId
      });
      if (authorized?.personId !== personId) return null;
      ids.push(person.discordUserId);
    }
    return new Set(ids).size === ids.length ? ids : null;
  };
  if (consultationConfig) {
    const recipients = await resolveConsultationRecipients(dayovaFounderPersonIds);
    if (
      !recipients ||
      JSON.stringify([...recipients].sort()) !==
        JSON.stringify([...consultationConfig.capture.allowedDiscordUserIds].sort())
    )
      throw new Error(
        "Consultations require the exact four uniquely mapped founder Discord users"
      );
  }
  if (decisionRecordConfig) {
    const recipients = await resolveConsultationRecipients(dayovaFounderPersonIds);
    if (
      !recipients ||
      JSON.stringify([...recipients].sort()) !==
        JSON.stringify([...decisionRecordConfig.allowedDiscordUserIds].sort())
    )
      throw new Error(
        "Decision Records require the exact four uniquely mapped founder Discord users"
      );
  }
  const externalContextCatalogs = contextConfig
    ? await (dependencies.createContextCatalogs ?? organizationalContextCatalogsFromEnv)({
        workspaceId,
        env
      })
    : undefined;
  if (startupSignal?.aborted) throw new LumaStartupCancelledError();
  const database = await createDatabase(env["LUMA_PGLITE_DATA_DIR"] ?? ".luma/pglite");
  const startupCleanup: Array<() => Promise<void>> = [];
  const startupAdmissionStops: Array<() => Promise<void>> = [];
  try {
    // A database initialization already in flight must finish before we can
    // close its owned resources; never race away from an unreturned handle.
    startupSignal?.throwIfAborted();
    const aiUsage =
      dependencies.aiUsageBudget ??
      createAiUsageBudget({
        ...aiBudgetSettings,
        database,
        configured:
          isAiModelPriced(openAIReasoningModelName) &&
          hasAnyEnv(env, ["OPENAI_API_KEY"]) &&
          (env["LUMA_REASONING_MODEL_PROVIDER"]?.trim() !== "disabled" ||
            discordContextAskConfig !== undefined ||
            decisionRecordConfig !== undefined ||
            structuredWorkConfig !== undefined)
      });
    const contextAudience = (requestedWorkspaceId: string) =>
      Promise.resolve(
        requestedWorkspaceId === workspaceId
          ? { workspaceId, personIds: [...dayovaFounderPersonIds] }
          : null
      );
    const workProvider = dependencies.createWorkProvider
      ? dependencies.createWorkProvider(env)
      : env["LINEAR_READONLY_API_KEY"]?.trim() && !env["LINEAR_API_KEY"]?.trim()
        ? undefined
        : optionalLinearWorkProvider(env);
    const observedSourceLedger = createObservedSourceLedger({ database });
    const operationalOutcomeMarkerVerifier = createOperationalOutcomeMarkerVerifier({
      database
    });
    const genericImportedSourceAnalysis = importedSourceAnalysisFromEnv({
      workspaceId,
      env,
      ledger: observedSourceLedger,
      operationalOutcomeMarkerVerifier
    });
    const workItemProviderId =
      workProvider?.providerId ?? nativeReviewConfig?.workItemProviderId ?? "linear";
    const discordTransport = createDiscordTransport(env, discordContextAskConfig);
    let transportOwnedByBot = false;
    startupCleanup.push(() =>
      transportOwnedByBot ? Promise.resolve() : discordTransport.disconnect()
    );
    const workspace = {
      workspaceId,
      timezone: config.defaultWorkspaceTimezone,
      outputLanguagePolicy: config.outputLanguagePolicy,
      publishingPolicy: config.publishingPolicy
    };
    const nativeReviewResources = nativeReviewConfig
      ? (
          dependencies.createNativeNotionReviewResources ??
          createNativeNotionReviewResources
        )({
          config: nativeReviewConfig,
          database,
          workspace,
          ledger: observedSourceLedger,
          identityDirectory,
          accessPolicy,
          operationalOutcomeMarkerVerifier
        })
      : undefined;
    if (nativeReviewResources) startupCleanup.push(() => nativeReviewResources.stop());
    await nativeReviewResources?.validate();
    const importedSourceRouter = createImportedSourceAnalysisRouter({
      database,
      workspaceId,
      audience: contextAudience,
      ...(genericImportedSourceAnalysis
        ? { generic: genericImportedSourceAnalysis }
        : {}),
      ...(nativeReviewResources ? { native: nativeReviewResources } : {})
    });
    startupCleanup.push(() => importedSourceRouter.stop());
    const importedSourceAnalysis = importedSourceRouter.configuration;
    const granolaConnections = granolaConfig
      ? await (dependencies.createGranolaConnections ?? granolaOAuthConnectionsFromEnv)({
          database,
          workspaceId,
          env,
          authorizeOwner: async (actor) =>
            (await accessPolicy.authorize({ workspaceId, ...actor }))?.personId ?? null
        })
      : null;
    if (granolaConfig && !granolaConnections)
      throw new Error("The configured Granola connection manager is unavailable");
    if (granolaConnections) startupCleanup.push(() => granolaConnections.stop());
    if (captureConfig?.notion && !importedSourceAnalysis)
      throw new Error("Notion capture requires current imported-source access");
    const captureRuntime = captureConfig
      ? await createMeetingCaptureRuntime({
          database,
          workspace,
          ledger: observedSourceLedger,
          workItemProviderId,
          ...(captureConfig.notion && importedSourceAnalysis
            ? {
                notion: {
                  ...captureConfig.notion,
                  sourceAccess: importedSourceAnalysis.access
                }
              }
            : {}),
          ...(granolaConnections
            ? {
                granola: {
                  policy: granolaConnections.policy,
                  connections: await granolaConnections.connections()
                }
              }
            : {})
        })
      : undefined;
    if (captureRuntime) {
      startupAdmissionStops.push(() => captureRuntime.pauseIntake());
      startupCleanup.push(() => captureRuntime.stop());
    }
    const refreshGranolaConnections = async () => {
      if (!granolaConnections || !captureRuntime)
        throw new Error("Granola capture is unavailable");
      await captureRuntime.replaceGranolaConnections(
        await granolaConnections.connections()
      );
    };
    const granolaCallback =
      granolaConfig && granolaConnections
        ? await (
            dependencies.createGranolaCallbackHost ?? createGranolaOAuthCallbackHost
          )({
            database,
            workspaceId,
            connections: granolaConnections,
            redirectUri: granolaConfig.redirectUri,
            hostname: granolaConfig.hostname,
            port: granolaConfig.port,
            afterConnectionsChanged: refreshGranolaConnections
          })
        : undefined;
    if (granolaCallback) {
      startupAdmissionStops.push(() => granolaCallback.stop());
      startupCleanup.push(() => granolaCallback.stop());
    }
    const meetingSynthesisWriter = captureConfig
      ? await (
          dependencies.createMeetingSynthesisWriter ?? createMeetingSynthesisRuntime
        )({ workspaceId, config: captureConfig, env })
      : undefined;
    const logicalDecisionEvidence = captureRuntime
      ? createLogicalMeetingDecisionEvidenceSource({
          database,
          configuration: captureRuntime.configuration
        })
      : undefined;
    const decisionIntelligence = decisionConfig
      ? await (dependencies.createDecisionRuntime ?? createDecisionRuntime)({
          config: decisionConfig,
          env,
          workspaceId,
          database,
          ledger: observedSourceLedger,
          conversationEvidenceSource: discordTransport,
          ...(logicalDecisionEvidence
            ? { logicalMeetingEvidenceSource: logicalDecisionEvidence }
            : {}),
          ...(decisionConfig.automatic && decisionRecordConfig
            ? {
                standingPermissionSourceAccess:
                  createDiscordDecisionPermissionSourceAccess({
                    workspaceId,
                    guildId: env["DISCORD_GUILD_ID"]!,
                    parentChannelIds: decisionRecordConfig.parentChannelIds,
                    founderPersonIds: dayovaFounderPersonIds,
                    identityDirectory,
                    accessPolicy,
                    resolveChannel: (request) => discordTransport.resolveChannel(request)
                  })
              }
            : {}),
          ...(importedSourceAnalysis
            ? { importedSourceAccess: importedSourceAnalysis.access }
            : {}),
          accessPolicy,
          budget: aiUsage,
          limits: aiRequestLimits,
          model: openAIReasoningModelName
        })
      : undefined;
    if (decisionIntelligence) {
      if (decisionIntelligence.standingPolicy)
        startupCleanup.push(() => decisionIntelligence.standingPolicy!.stop());
      startupAdmissionStops.push(() => decisionIntelligence.recall.stop());
      startupCleanup.push(() => decisionIntelligence.recall.stop());
    }
    const structuredWorkRuntime =
      structuredWorkConfig && workProvider
        ? await (dependencies.createStructuredWorkRuntime ?? createStructuredWorkRuntime)(
            {
              config: structuredWorkConfig,
              env,
              workspaceId,
              database,
              ledger: observedSourceLedger,
              conversationEvidenceSource: discordTransport,
              ...(importedSourceAnalysis
                ? { importedSourceAccess: importedSourceAnalysis.access }
                : {}),
              identityDirectory,
              accessPolicy,
              work: workProvider,
              budget: aiUsage,
              limits: aiRequestLimits,
              model: openAIReasoningModelName
            }
          )
        : undefined;
    if (structuredWorkConfig && !structuredWorkRuntime)
      throw new Error("Structured work requires the shared Linear WorkProvider");
    if (structuredWorkRuntime) startupCleanup.push(() => structuredWorkRuntime.stop());
    const providerContextCatalogs = [
      ...(externalContextCatalogs ?? []),
      ...(decisionIntelligence ? [decisionIntelligence.recall.catalog] : [])
    ];
    const contextCatalogs = [...providerContextCatalogs];
    if (importedSourceAnalysis) {
      contextCatalogs.push(
        createImportedMeetingContextCatalog({
          database,
          sourceAccess: importedSourceAnalysis.access,
          externalContext: createExternalContextReceiptVerifier({
            database,
            catalogs: providerContextCatalogs,
            ignoredEmptyCatalogIds: [importedMeetingContextCatalogId]
          })
        })
      );
    }
    const organizationalContext =
      externalContextCatalogs || contextCatalogs.length
        ? createOrganizationalContext({ database, catalogs: contextCatalogs })
        : undefined;
    const meetingDependencies = {
      database,
      ...(structuredWorkRuntime
        ? { structuredWork: structuredWorkRuntime.configuration }
        : {}),
      ...(captureRuntime ? { captureSynthesis: captureRuntime.configuration } : {}),
      ...(organizationalContext ? { organizationalContext, contextAudience } : {}),
      ...(importedSourceAnalysis ? { importedSourceAnalysis } : {}),
      reasoningModel: reasoningModelFromEnv(
        env,
        openAIReasoningModelName,
        createReasoningModel,
        aiUsage,
        aiRequestLimits
      ),
      ...(nativeReviewResources
        ? { workCatalogs: [nativeReviewResources.workCatalog] }
        : workProvider
          ? { workCatalogs: [toWorkCatalog(workProvider)] }
          : {}),
      ...(nativeReviewConfig ||
      hasAnyEnv(env, ["NOTION_API_TOKEN", "NOTION_MEETINGS_DATA_SOURCE_ID"])
        ? {
            importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
              ledger: observedSourceLedger,
              workItemProviderId
            })
          }
        : {})
    };
    const scopedMeetingIntelligence = decisionIntelligence
      ? createMeetingIntelligence({ ...meetingDependencies, decisionIntelligence })
      : structuredWorkRuntime
        ? createMeetingIntelligence({
            ...meetingDependencies,
            structuredWork: structuredWorkRuntime.configuration
          })
        : undefined;
    const meetingIntelligence =
      scopedMeetingIntelligence ?? createMeetingIntelligence(meetingDependencies);
    const nativeReview = nativeReviewResources?.createRuntime({ meetingIntelligence });
    if (nativeReview) {
      startupAdmissionStops.push(() => nativeReview.stop());
      startupCleanup.push(() => nativeReview.stop());
    }
    const decisionMeetingIntelligence = decisionIntelligence
      ? scopedMeetingIntelligence
      : undefined;
    const automaticDecisions =
      decisionIntelligence?.automatic && decisionMeetingIntelligence
        ? await createAutomaticDecisionProcessing({
            database,
            workspace,
            meetingIntelligence: decisionMeetingIntelligence
          })
        : undefined;
    if (automaticDecisions) {
      startupAdmissionStops.push(() => automaticDecisions.pause());
      startupCleanup.push(() => automaticDecisions.stop());
      captureRuntime?.connectProcessedSource(automaticDecisions.meeting);
    }
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
    const baseMeetingNotesIngestion = createMeetingNotesIngestion({
      meetingIntelligence,
      ...(automaticDecisions && !captureRuntime
        ? { onProcessedSource: automaticDecisions.meeting }
        : {}),
      workItemProviderId
    });
    const meetingNotesIngestion = captureRuntime
      ? captureRuntime.connect(meetingIntelligence, baseMeetingNotesIngestion)
      : baseMeetingNotesIngestion;
    const meetingNotesSync = meetingNotesSource
      ? createMeetingNotesSync({
          workspace,
          source: meetingNotesSource,
          ingestion: meetingNotesIngestion,
          ...(meetingNotesSyncIntervalMs !== undefined
            ? { intervalMs: meetingNotesSyncIntervalMs }
            : {})
        })
      : undefined;
    if (meetingNotesSync) {
      startupAdmissionStops.push(() => meetingNotesSync.stop());
      startupCleanup.push(() => meetingNotesSync.stop());
    }
    const conversationConsultations = consultationConfig
      ? createConversationConsultations({
          database,
          ledger: observedSourceLedger,
          evidenceSource: discordTransport,
          accessPolicy,
          workspaceId,
          recipientPersonIds: dayovaFounderPersonIds,
          recipientGroupId: consultationConfig.teamRoleId
        })
      : undefined;
    const consultationProvider = consultationConfig
      ? discordTransport.createConsultationProvider?.({
          resolveRecipients: resolveConsultationRecipients
        })
      : undefined;
    if (consultationConfig && !consultationProvider)
      throw new Error(
        "The shared Discord transport must supply the configured consultation capability"
      );
    if (
      webhookConfig &&
      (!meetingNotesSource || !meetingNotesSync || !importedSourceAnalysis)
    )
      throw new Error(
        "Notion webhook intake requires the canonical Meeting Notes source and granted imported-source analysis configuration"
      );
    const notionWebhook =
      webhookConfig && meetingNotesSource && meetingNotesSync
        ? createNotionWebhookRuntime({
            config: webhookConfig,
            workspace,
            source: meetingNotesSource,
            ingestion: meetingNotesIngestion,
            canonicalReconciliation: meetingNotesSync,
            ...(dependencies.createNotionWebhookHttpServer
              ? { createHttpServer: dependencies.createNotionWebhookHttpServer }
              : {})
          })
        : undefined;
    if (notionWebhook) {
      startupAdmissionStops.push(() => notionWebhook.stop());
      startupCleanup.push(() => notionWebhook.stop());
    }
    const followUpExecution = createFollowUpExecution({
      database,
      ...(meetingSynthesisWriter ? { meetingSynthesisWriter } : {}),
      ...(conversationConsultations && consultationProvider
        ? { conversationConsultations, consultationProvider }
        : {}),
      organizationalContextGuard: createMeetingContextGuard({
        database,
        ...(organizationalContext ? { organizationalContext, contextAudience } : {}),
        ...(importedSourceAnalysis ? { importedSourceAnalysis } : {})
      }),
      meetingIntelligence,
      identityDirectory,
      ...(workProvider ? { workProvider } : {}),
      ...(knowledgeProvider ? { knowledgeProvider } : {}),
      ...(operationalOutcomeWriter
        ? {
            operationalOutcomeWriter,
            canonicalKnowledgePatchWriter: createNotionCanonicalKnowledgePatchWriter({
              token: requireEnv(env, "NOTION_API_TOKEN"),
              providerId: operationalOutcomeWriter.providerId
            })
          }
        : {}),
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
          ...(automaticDecisions
            ? { onProcessedSource: automaticDecisions.conversation }
            : {}),
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
      ...(structuredWorkRuntime && scopedMeetingIntelligence
        ? {
            structuredWork: structuredWorkRuntime.discord({
              meetingIntelligence: scopedMeetingIntelligence,
              execution: followUpExecution
            })
          }
        : {}),
      ...(granolaConnections && granolaCallback
        ? {
            granola: await createDiscordGranolaRuntime({
              database,
              workspaceId,
              connections: granolaConnections,
              begin: (request) => granolaCallback.begin(request),
              afterConnectionsChanged: refreshGranolaConnections,
              sourceStatus: (connectionId) =>
                Promise.resolve(captureRuntime?.granolaSourceStatus(connectionId) ?? null)
            })
          }
        : {}),
      ...(captureRuntime
        ? {
            captureReview: createDiscordCaptureReviewRuntime({
              database,
              workspace,
              logicalMeetings: captureRuntime.logicalMeetings,
              captureAccess: captureRuntime.configuration.access,
              meetingIntelligence,
              followUpExecution,
              founderPersonIds: dayovaFounderPersonIds
            })
          }
        : {}),
      ...(decisionRecordConfig && decisionMeetingIntelligence
        ? {
            decisionRecords: {
              ...(logicalDecisionEvidence && decisionIntelligence
                ? {
                    logicalMeetings: {
                      resolveMeeting: (
                        request: Parameters<
                          typeof logicalDecisionEvidence.resolveMeeting
                        >[0]
                      ) => logicalDecisionEvidence.resolveMeeting(request),
                      currentAudience: (requestedWorkspaceId: string) =>
                        decisionIntelligence.audience(requestedWorkspaceId)
                    }
                  }
                : {}),
              ...(decisionIntelligence?.standingPolicy
                ? { standingPolicy: decisionIntelligence.standingPolicy }
                : {}),
              ...(automaticDecisions ? { automatic: automaticDecisions } : {}),
              meetingIntelligence: decisionMeetingIntelligence,
              execution: followUpExecution,
              config: decisionRecordConfig
            }
          }
        : {}),
      ...(conversationConsultations
        ? {
            consultations: {
              context: conversationConsultations,
              execution: followUpExecution
            }
          }
        : {}),
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

    transportOwnedByBot = true;
    startupAdmissionStops.push(() => bot.stop());
    startupCleanup.push(() => bot.stop());
    if (nativeReview) await nativeReview.start();
    if (granolaCallback) await granolaCallback.start();
    await bot.start(startupSignal);
    startupSignal?.throwIfAborted();
    if (notionWebhook) await notionWebhook.start();
    else meetingNotesSync?.start();
    decisionIntelligence?.recall.start();
    captureRuntime?.start();
    automaticDecisions?.start();
    startupSignal?.throwIfAborted();
    console.log(`Luma Discord bot connected in ${config.nodeEnv} mode`);

    let stopping: Promise<void> | undefined;
    let healthClosed = false;
    const healthReads = new Set<Promise<RuntimeCapabilityProblem[]>>();
    return {
      capabilityProblems() {
        if (healthClosed) return Promise.resolve(["capability-status-unavailable"]);
        const pending = (async (): Promise<RuntimeCapabilityProblem[]> => {
          const results = await Promise.allSettled([
            aiUsage.getStatus(workspaceId),
            decisionIntelligence?.recall.status(),
            automaticDecisions?.status()
          ]);
          const [usageResult, recallResult, automaticResult] = results;
          if (
            usageResult.status !== "fulfilled" ||
            recallResult.status !== "fulfilled" ||
            automaticResult.status !== "fulfilled"
          )
            throw new Error("Processing capability status is unavailable");
          const usage = usageResult.value,
            recall = recallResult.value,
            automatic = automaticResult.value;
          const problems: RuntimeCapabilityProblem[] = [];
          if (usage.accountingBlocked || usage.status === "not-configured")
            problems.push("ai-unavailable");
          else if (usage.status === "exhausted") problems.push("ai-budget-exhausted");
          else if (usage.status === "warning" || usage.status === "critical")
            problems.push("ai-budget-near-limit");
          if (
            recall &&
            ["stale", "partial", "unavailable", "stopped"].includes(recall.state)
          )
            problems.push("decision-recall-degraded");
          if (automatic && (!automatic.active || automatic.needsAttention > 0))
            problems.push("automatic-decisions-need-attention");
          const granola = captureRuntime?.status();
          const notion = notionWebhook?.status();
          const sync = notion?.canonicalRecovery ?? meetingNotesSync?.status();
          if (
            granola?.lastFailure ||
            granola?.lastResult?.failures.length ||
            notion?.runtime.lastFailure ||
            sync?.lastOutcome === "failed"
          )
            problems.push("source-ingestion-degraded");
          return problems;
        })().finally(() => healthReads.delete(pending));
        healthReads.add(pending);
        return pending;
      },
      automaticDecisionStatus: () =>
        automaticDecisions?.status() ?? Promise.resolve(null),
      gatewayConnected: () => discordTransport.gatewayConnected?.() ?? false,
      notionObservationStatus: () => notionWebhook?.status() ?? null,
      decisionRecallStatus: () =>
        decisionIntelligence?.recall.status() ?? Promise.resolve(null),
      stop() {
        healthClosed = true;
        stopping ??= (async () => {
          // Stop admission and scheduled ingestion immediately, then drain both.
          // A failed/timed-out drain never closes the store later in a detached
          // continuation: its lease must survive process termination for recovery.
          await drainBeforeClose(
            (async () => {
              const drains = await Promise.allSettled([
                bot.stop(),
                nativeReview?.stop(),
                granolaCallback?.stop(),
                captureRuntime?.pauseIntake(),
                automaticDecisions?.pause(),
                notionWebhook ? notionWebhook.stop() : meetingNotesSync?.stop(),
                decisionIntelligence?.recall.stop()
              ]);
              const failure = drains.find((result) => result.status === "rejected");
              if (failure?.status === "rejected") throw failure.reason;
              // Foreground Decision work may have entered a retained proof after
              // background cancellation; all command admission has now settled.
              await decisionIntelligence?.recall.stop();
              await structuredWorkRuntime?.stop();
              await Promise.allSettled([...healthReads]);
              await captureRuntime?.stop();
              await automaticDecisions?.stop();
              await decisionIntelligence?.standingPolicy?.stop();
              await granolaConnections?.stop();
              await importedSourceRouter.stop();
              await nativeReviewResources?.stop();
            })()
          );
          await database.close();
        })();
        return stopping;
      }
    };
  } catch (error) {
    // A rejected startup cannot return stop() to its caller. Stop every ingress
    // immediately, then drain owned dependencies before closing persistence.
    // A failed or timed-out drain must retain the unclean store lease.
    let cleanupFailed = false;
    try {
      await drainBeforeClose(
        (async () => {
          const drains = await Promise.allSettled(
            startupAdmissionStops.map((stop) => Promise.resolve().then(stop))
          );
          const failure = drains.find((result) => result.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
          for (const cleanup of startupCleanup.reverse()) await cleanup();
        })()
      );
      await database.close();
    } catch {
      cleanupFailed = true;
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
