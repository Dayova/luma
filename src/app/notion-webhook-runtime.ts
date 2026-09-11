import type { WorkspaceConfig } from "../domain/model.js";
import type { MeetingNotesIngestion } from "../knowledge/meeting-notes-ingestion.js";
import type { MeetingNotesPageRefresher } from "../knowledge/meeting-notes-source.js";
import type { MeetingNotesSync } from "../knowledge/meeting-notes-sync.js";
import { canonicalNotionObjectId } from "../knowledge/notion-object-id.js";
import {
  createNotionMeetingNotesObservationHost,
  type NotionObservationSubscription
} from "./notion-meeting-notes-observation-host.js";
import { createNotionWebhookHttpServer } from "./notion-webhook-http-server.js";

export type NotionWebhookRuntimeConfig = {
  subscription: NotionObservationSubscription;
  hostname: string;
  port: number;
  path: string;
};

/** Validates the optional single-process listener before runtime resources are opened. */
export function notionWebhookRuntimeConfig(
  env: NodeJS.ProcessEnv,
  workspaceId: string
): NotionWebhookRuntimeConfig | undefined {
  const enabled = env["LUMA_NOTION_WEBHOOK_ENABLED"]?.trim();
  if (!enabled || enabled === "0" || enabled === "false") return undefined;
  if (enabled !== "1" && enabled !== "true")
    throw new Error("LUMA_NOTION_WEBHOOK_ENABLED must be 1 or 0");
  const notionWorkspaceId = uuid(env, "LUMA_NOTION_WEBHOOK_WORKSPACE_ID");
  if (
    workspaceId === notionWorkspaceId ||
    canonicalNotionObjectId(workspaceId) === notionWorkspaceId
  )
    throw new Error(
      "The Notion webhook provider workspace must be distinct from the logical Luma workspace"
    );
  const port = Number(env["LUMA_NOTION_WEBHOOK_HTTP_PORT"]?.trim() || "3001");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error("LUMA_NOTION_WEBHOOK_HTTP_PORT must be a TCP port");
  const path = env["LUMA_NOTION_WEBHOOK_HTTP_PATH"]?.trim() || "/notion/webhook";
  if (
    !path.startsWith("/") ||
    path.includes("?") ||
    path.includes("#") ||
    /\s/u.test(path)
  )
    throw new Error("LUMA_NOTION_WEBHOOK_HTTP_PATH must be an exact absolute HTTP path");
  return {
    subscription: {
      notionWorkspaceId,
      canonicalMeetingsDataSourceId: uuid(env, "NOTION_MEETINGS_DATA_SOURCE_ID"),
      verificationToken: required(env, "LUMA_NOTION_WEBHOOK_VERIFICATION_TOKEN"),
      subscriptionId: uuid(env, "LUMA_NOTION_WEBHOOK_SUBSCRIPTION_ID"),
      integrationId: uuid(env, "LUMA_NOTION_WEBHOOK_INTEGRATION_ID")
    },
    hostname: env["LUMA_NOTION_WEBHOOK_HTTP_HOST"]?.trim() || "127.0.0.1",
    port,
    path
  };
}

/** Reuses the main runtime's source, ingestion and sole canonical schedule. */
export function createNotionWebhookRuntime(input: {
  config: NotionWebhookRuntimeConfig;
  workspace: WorkspaceConfig;
  source: MeetingNotesPageRefresher;
  ingestion: MeetingNotesIngestion;
  canonicalReconciliation: MeetingNotesSync;
  createHttpServer?: typeof createNotionWebhookHttpServer;
}) {
  const host = createNotionMeetingNotesObservationHost({
    lumaWorkspace: input.workspace,
    notionSubscription: input.config.subscription,
    refresher: input.source,
    ingestion: input.ingestion,
    canonicalReconciliation: input.canonicalReconciliation
  });
  const http = (input.createHttpServer ?? createNotionWebhookHttpServer)({
    observationHost: host,
    hostname: input.config.hostname,
    port: input.config.port,
    path: input.config.path
  });
  return {
    start: () => http.start(),
    stop: () => http.stop(),
    status: () => host.status()
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Notion webhook intake`);
  return value;
}

function uuid(env: NodeJS.ProcessEnv, name: string): string {
  const value = canonicalNotionObjectId(required(env, name));
  if (!value) throw new Error(`${name} must be a Notion UUID`);
  return value;
}
