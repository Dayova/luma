import type {
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../ai/reasoning-model.js";
import { createOpenAIReasoningModel } from "../ai/openai-reasoning-model.js";
import { openAIReasoningModelNameFromEnv } from "../ai/openai-model-config.js";
import { createOperationalOutcomeMarkerVerifier } from "../follow-up-execution/operational-outcome-marker-verifier.js";
import { createMeetingNotesIngestion } from "../knowledge/meeting-notes-ingestion.js";
import { createLedgerBackedImportedSourceVerifier } from "../knowledge/ledger-backed-imported-source-verifier.js";
import {
  createNotionMeetingNotesSource,
  type NotionMeetingNotesSource,
  type NotionMeetingNotesSourceConfig
} from "../knowledge/notion-meeting-notes-source.js";
import { canonicalNotionObjectId } from "../knowledge/notion-object-id.js";
import { createObservedSourceLedger } from "../knowledge/observed-source-ledger.js";
import {
  createMeetingNotesSync,
  type MeetingNotesSyncLogger
} from "../knowledge/meeting-notes-sync.js";
import { createMeetingIntelligence } from "../meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase } from "../persistence/db.js";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  createLinearReadOnlyWorkCatalog,
  isIssuedLinearReadOnlyWorkCatalog,
  type LinearReadOnlyWorkCatalog,
  type LinearReadOnlyWorkCatalogConfig
} from "../work/linear-read-only-work-catalog.js";
import { loadAppConfigFromEnv } from "./env.js";
import {
  createNotionMeetingNotesObservationHost,
  type NotionMeetingNotesObservationHostStatus
} from "./notion-meeting-notes-observation-host.js";
import {
  createNotionWebhookHttpServer,
  type NotionWebhookHttpServer,
  type NotionWebhookHttpServerAddress
} from "./notion-webhook-http-server.js";
import { createWorkspaceBoundWorkCatalog } from "./workspace-bound-work-catalog.js";

const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 3001;
const DEFAULT_HTTP_PATH = "/notion/webhook";
const DEFAULT_SYNC_INTERVAL_MS = 60_000;
const incompatibleObservationCredentialVariables = [
  "NOTION_API_TOKEN",
  "LINEAR_API_KEY",
  "LUMA_NATIVE_NOTION_READONLY_API_TOKEN",
  "DISCORD_TOKEN"
] as const;

export type RunningNotionMeetingNotesObservationServer = {
  readonly address: NotionWebhookHttpServerAddress;
  status(): NotionMeetingNotesObservationHostStatus;
  stop(): Promise<void>;
};

type StartNotionMeetingNotesObservationServerDependencies = {
  createDatabase?: typeof createPgliteDatabase;
  createMeetingNotesSource?: (
    config: NotionMeetingNotesSourceConfig
  ) => NotionMeetingNotesSource;
  createReadOnlyWorkCatalog?: (
    config: LinearReadOnlyWorkCatalogConfig
  ) => LinearReadOnlyWorkCatalog;
  createReasoningModel?: typeof createOpenAIReasoningModel;
  createHttpServer?: typeof createNotionWebhookHttpServer;
};

type ObservationServerConfig = {
  lumaWorkspaceId: string;
  notionWorkspaceId: string;
  canonicalMeetingsDataSourceId: string;
  notionReadOnlyApiToken: string;
  linearReadOnlyApiKey: string;
  linearTeamId: string;
  linearProviderId: string | null;
  linearApiUrl: string | null;
  subscriptionId: string;
  integrationId: string;
  webhookVerificationToken: string;
  dataDir: string;
  hostname: string;
  port: number;
  path: string;
  syncIntervalMs: number;
};

export class NotionMeetingNotesObservationServerError extends Error {
  constructor(
    readonly code:
      | "notion-observation-config-invalid"
      | "notion-observation-read-only-catalog-invalid",
    message: string
  ) {
    super(message);
    this.name = "NotionMeetingNotesObservationServerError";
  }
}

/**
 * Starts the Notion-only automatic observation service. It deliberately does
 * not compose Discord, a WorkProvider, Follow-up Execution, a Notion writer,
 * a native-review reader, or `startServer`. Signed deliveries only wake the
 * existing canonical Meeting Notes source/ledger/reconciliation path.
 */
export async function startNotionMeetingNotesObservationServer(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: StartNotionMeetingNotesObservationServerDependencies = {}
): Promise<RunningNotionMeetingNotesObservationServer> {
  const config = observationServerConfigFromEnv(env);
  const appConfig = loadAppConfigFromEnv(env);
  const createDatabase = dependencies.createDatabase ?? createPgliteDatabase;
  const createSource =
    dependencies.createMeetingNotesSource ?? createNotionMeetingNotesSource;
  const createReadOnlyWorkCatalog =
    dependencies.createReadOnlyWorkCatalog ?? createLinearReadOnlyWorkCatalog;
  const createReasoningModel =
    dependencies.createReasoningModel ?? createOpenAIReasoningModel;
  const createHttpServer = dependencies.createHttpServer ?? createNotionWebhookHttpServer;
  const database = await createDatabase(config.dataDir);
  let httpServer: NotionWebhookHttpServer | null = null;

  try {
    const workspace = {
      workspaceId: config.lumaWorkspaceId,
      timezone: appConfig.defaultWorkspaceTimezone,
      outputLanguagePolicy: appConfig.outputLanguagePolicy,
      publishingPolicy: appConfig.publishingPolicy
    };
    const ledger = createObservedSourceLedger({ database });
    const markerVerifier = createOperationalOutcomeMarkerVerifier({ database });
    const readOnlyWorkCatalog = createReadOnlyWorkCatalog(
      linearReadOnlyCatalogConfig(config)
    );

    if (!isIssuedLinearReadOnlyWorkCatalog(readOnlyWorkCatalog)) {
      throw new NotionMeetingNotesObservationServerError(
        "notion-observation-read-only-catalog-invalid",
        "Notion observation requires the issued dedicated Linear read-only catalog"
      );
    }

    const workCatalog = createWorkspaceBoundWorkCatalog({
      workspaceId: workspace.workspaceId,
      providerScopeId: readOnlyWorkCatalog.providerScopeId,
      workCatalog: readOnlyWorkCatalog
    });
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: reasoningModelFromEnv(env, createReasoningModel),
      workCatalogs: [workCatalog],
      importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
        ledger,
        workItemProviderId: workCatalog.providerId
      })
    });
    const meetingNotesIngestion = createMeetingNotesIngestion({
      meetingIntelligence,
      workItemProviderId: workCatalog.providerId
    });
    const source = createSource({
      ledger,
      token: config.notionReadOnlyApiToken,
      meetingsDataSourceId: config.canonicalMeetingsDataSourceId,
      operationalOutcomeMarkerVerifier: markerVerifier
    });
    const canonicalReconciliation = createMeetingNotesSync({
      workspace,
      source,
      ingestion: meetingNotesIngestion,
      intervalMs: config.syncIntervalMs,
      logger: observationSyncLogger
    });
    const observationHost = createNotionMeetingNotesObservationHost({
      lumaWorkspace: workspace,
      notionSubscription: {
        notionWorkspaceId: config.notionWorkspaceId,
        canonicalMeetingsDataSourceId: config.canonicalMeetingsDataSourceId,
        verificationToken: config.webhookVerificationToken,
        subscriptionId: config.subscriptionId,
        integrationId: config.integrationId
      },
      refresher: source,
      ingestion: meetingNotesIngestion,
      canonicalReconciliation
    });
    httpServer = createHttpServer({
      observationHost,
      hostname: config.hostname,
      port: config.port,
      path: config.path
    });
    const address = await httpServer.start();
    let stopping: Promise<void> | null = null;

    return {
      address,
      status: () => observationHost.status(),
      stop() {
        stopping ??= (async () => {
          try {
            await httpServer?.stop();
          } finally {
            await database.close();
          }
        })();
        return stopping;
      }
    };
  } catch (error) {
    try {
      await httpServer?.stop();
    } finally {
      await database.close();
    }
    throw error;
  }
}

const unavailableReasoningModel: ReasoningModel = {
  generateStructured<T>(
    _request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    void _request;
    return Promise.reject(
      new Error("The Notion observation ReasoningModel Adapter is not configured")
    );
  }
};

function reasoningModelFromEnv(
  env: NodeJS.ProcessEnv,
  createReasoningModel: typeof createOpenAIReasoningModel
): ReasoningModel {
  const provider = env["LUMA_REASONING_MODEL_PROVIDER"]?.trim() || "openai";

  if (provider === "disabled") {
    return unavailableReasoningModel;
  }

  if (provider !== "openai") {
    throw new NotionMeetingNotesObservationServerError(
      "notion-observation-config-invalid",
      `Unsupported LUMA_REASONING_MODEL_PROVIDER: ${provider}`
    );
  }

  return createReasoningModel({
    apiKey: requireEnv(env, "OPENAI_API_KEY"),
    model: openAIReasoningModelNameFromEnv(env)
  });
}

const observationSyncLogger: MeetingNotesSyncLogger = {
  // The source/ledger retains structured operational state. Process logs must
  // not repeat provider IDs, source titles, raw error text, or source content.
  info: () => console.info("Luma Notion Meeting Notes canonical recovery started"),
  warn: () => console.warn("Luma Notion Meeting Notes canonical recovery is partial"),
  error: () => console.error("Luma Notion Meeting Notes canonical recovery failed")
};

function observationServerConfigFromEnv(env: NodeJS.ProcessEnv): ObservationServerConfig {
  const notionReadOnlyApiToken = requireEnv(
    env,
    "LUMA_NOTION_OBSERVATION_READONLY_API_TOKEN"
  );
  rejectIncompatibleObservationCredentials(env);

  const readOnlyLinearKey = requireEnv(env, "LINEAR_READONLY_API_KEY");

  const notionWorkspaceId = requireNotionUuid(
    env,
    "LUMA_NOTION_OBSERVATION_WORKSPACE_ID"
  );
  const lumaWorkspaceId = requireDistinctLumaWorkspaceId(env, notionWorkspaceId);

  return {
    lumaWorkspaceId,
    notionWorkspaceId,
    canonicalMeetingsDataSourceId: requireNotionUuid(
      env,
      "LUMA_NOTION_OBSERVATION_MEETINGS_DATA_SOURCE_ID"
    ),
    notionReadOnlyApiToken,
    linearReadOnlyApiKey: readOnlyLinearKey,
    linearTeamId: requireEnv(env, "LINEAR_TEAM_ID"),
    linearProviderId: nonBlank(env["LUMA_NOTION_OBSERVATION_LINEAR_PROVIDER_ID"]),
    linearApiUrl: nonBlank(env["LUMA_NOTION_OBSERVATION_LINEAR_API_URL"]),
    subscriptionId: requireNotionUuid(env, "LUMA_NOTION_OBSERVATION_SUBSCRIPTION_ID"),
    integrationId: requireNotionUuid(env, "LUMA_NOTION_OBSERVATION_INTEGRATION_ID"),
    webhookVerificationToken: requireEnv(
      env,
      "LUMA_NOTION_OBSERVATION_WEBHOOK_VERIFICATION_TOKEN"
    ),
    dataDir: requiredDurableDataDir(env),
    hostname: nonBlank(env["LUMA_NOTION_OBSERVATION_HTTP_HOST"]) ?? DEFAULT_HTTP_HOST,
    port: boundedPort(env["LUMA_NOTION_OBSERVATION_HTTP_PORT"]),
    path: nonBlank(env["LUMA_NOTION_OBSERVATION_HTTP_PATH"]) ?? DEFAULT_HTTP_PATH,
    syncIntervalMs: boundedSyncInterval(env["LUMA_NOTION_OBSERVATION_SYNC_INTERVAL_MS"])
  };
}

function rejectIncompatibleObservationCredentials(env: NodeJS.ProcessEnv): void {
  for (const key of incompatibleObservationCredentialVariables) {
    if (nonBlank(env[key])) {
      throw new NotionMeetingNotesObservationServerError(
        "notion-observation-config-invalid",
        `${key} must not be configured for the Notion observation server`
      );
    }
  }
}

function linearReadOnlyCatalogConfig(
  config: ObservationServerConfig
): LinearReadOnlyWorkCatalogConfig {
  const catalogConfig: LinearReadOnlyWorkCatalogConfig = {
    teamId: config.linearTeamId,
    readOnlyApiKey: config.linearReadOnlyApiKey
  };

  if (config.linearProviderId) {
    catalogConfig.providerId = config.linearProviderId;
  }

  if (config.linearApiUrl) {
    catalogConfig.apiUrl = config.linearApiUrl;
  }

  return catalogConfig;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];

  if (!value || value.trim().length === 0) {
    throw new NotionMeetingNotesObservationServerError(
      "notion-observation-config-invalid",
      `${key} is required`
    );
  }

  return value;
}

function requireNotionUuid(env: NodeJS.ProcessEnv, key: string): string {
  const raw = requireEnv(env, key);
  const canonical = canonicalNotionObjectId(raw);

  if (!canonical) {
    throw new NotionMeetingNotesObservationServerError(
      "notion-observation-config-invalid",
      `${key} must be a Notion UUID`
    );
  }

  return canonical;
}

function requireDistinctLumaWorkspaceId(
  env: NodeJS.ProcessEnv,
  notionWorkspaceId: string
): string {
  const lumaWorkspaceId = requireEnv(env, "LUMA_OBSERVATION_WORKSPACE_ID");

  if (
    lumaWorkspaceId === notionWorkspaceId ||
    canonicalNotionObjectId(lumaWorkspaceId) === notionWorkspaceId
  ) {
    throw new NotionMeetingNotesObservationServerError(
      "notion-observation-config-invalid",
      "LUMA_OBSERVATION_WORKSPACE_ID must be distinct from LUMA_NOTION_OBSERVATION_WORKSPACE_ID"
    );
  }

  return lumaWorkspaceId;
}

function requiredDurableDataDir(env: NodeJS.ProcessEnv): string {
  const dataDir = requireEnv(env, "LUMA_NOTION_OBSERVATION_PGLITE_DATA_DIR").trim();
  const standardServerDataDir = nonBlank(env["LUMA_PGLITE_DATA_DIR"]);
  const resolvedDataDir = resolvedFilesystemPath(dataDir);
  const resolvedDefaultServerDataDir = resolvedFilesystemPath(".luma/pglite");
  const resolvedConfiguredServerDataDir = standardServerDataDir
    ? resolvedFilesystemPath(standardServerDataDir)
    : null;

  if (
    dataDir.includes("://") ||
    resolvedDataDir === resolvedDefaultServerDataDir ||
    resolvedDataDir === resolvedConfiguredServerDataDir
  ) {
    throw new NotionMeetingNotesObservationServerError(
      "notion-observation-config-invalid",
      "LUMA_NOTION_OBSERVATION_PGLITE_DATA_DIR must identify dedicated durable storage"
    );
  }

  return dataDir;
}

/**
 * Resolve aliases that already exist without creating a directory during
 * configuration validation. A future directory has no physical alias yet;
 * once it exists, a symlink cannot bypass the single-PGlite-store guard.
 */
function resolvedFilesystemPath(value: string): string {
  const resolved = resolve(value);

  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function boundedPort(value: string | undefined): number {
  if (!value || value.trim().length === 0) {
    return DEFAULT_HTTP_PORT;
  }

  const port = Number(value);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new NotionMeetingNotesObservationServerError(
      "notion-observation-config-invalid",
      "LUMA_NOTION_OBSERVATION_HTTP_PORT must be a TCP port"
    );
  }

  return port;
}

function boundedSyncInterval(value: string | undefined): number {
  if (!value || value.trim().length === 0) {
    return DEFAULT_SYNC_INTERVAL_MS;
  }

  const intervalMs = Number(value);

  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 3_600_000) {
    throw new NotionMeetingNotesObservationServerError(
      "notion-observation-config-invalid",
      "LUMA_NOTION_OBSERVATION_SYNC_INTERVAL_MS must be between 1000 and 3600000"
    );
  }

  return intervalMs;
}

function nonBlank(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}
