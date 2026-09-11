import { z } from "zod";
import type { WorkspaceAccessPolicy } from "../access/workspace-access-policy.js";
import type { WorkspaceConfig } from "../domain/model.js";
import type { IdentityDirectory } from "../identity/interface.js";
import { createNotionNativeReviewAccess } from "../knowledge/notion-native-review-access.js";
import { createNativeReviewSourceAccess } from "../knowledge/native-review-source-access.js";
import { createNotionObjectScopedMeetingNoteEvidenceReader } from "../knowledge/notion-object-scoped-meeting-note-evidence-reader.js";
import { createNotionObjectScopedMeetingNoteEvidenceSource } from "../knowledge/notion-object-scoped-meeting-note-evidence-source.js";
import type { ObservedSourceLedger } from "../knowledge/observed-source-ledger.js";
import type { OperationalOutcomeMarkerVerifier } from "../knowledge/operational-outcome-writer.js";
import type { MeetingIntelligence } from "../meeting-intelligence/interface.js";
import type { LumaDatabase } from "../persistence/db.js";
import { createLinearReadOnlyWorkCatalog } from "../work/linear-read-only-work-catalog.js";
import { createContextSharingPolicy } from "./context-sharing-policy.js";
import { createNativeNotionReviewMcp } from "./native-notion-review-mcp.js";
import { createNativeNotionReviewRuntime } from "./native-notion-review-runtime.js";
import { createWorkspaceBoundWorkCatalog } from "./workspace-bound-work-catalog.js";

const configSchema = z.object({
  notionWorkspaceId: z.string().uuid(),
  agentId: z.string().uuid(),
  pageId: z.string().uuid(),
  agentReadToken: z.string().min(1),
  adminReadToken: z.string().min(1),
  pageReadToken: z.string().min(1),
  pageCredentialScopeId: z.string().min(1),
  linearReadToken: z.string().min(1),
  linearTeamId: z.string().min(1),
  workItemProviderId: z.string().min(1),
  linearCredentialScopeId: z.string().min(1),
  sharingPolicyPath: z.string().min(1),
  bearerToken: z.string().min(32),
  hostname: z.literal("127.0.0.1"),
  port: z.number().int().min(1).max(65535),
  path: z.string().regex(/^\/[A-Za-z0-9/_-]+$/u)
});
export type NativeNotionReviewConfig = z.infer<typeof configSchema>;
export function nativeNotionReviewConfig(
  env: NodeJS.ProcessEnv
): NativeNotionReviewConfig | undefined {
  const enabled = env["LUMA_NATIVE_REVIEW_ENABLED"]?.trim();
  if (!enabled || ["0", "false"].includes(enabled)) return undefined;
  if (!["1", "true"].includes(enabled))
    throw new Error("LUMA_NATIVE_REVIEW_ENABLED must be 1 or 0");
  const get = (key: string) => env[key]?.trim() ?? "";
  const config = configSchema.safeParse({
    notionWorkspaceId: get("LUMA_NATIVE_NOTION_WORKSPACE_ID"),
    agentId: get("LUMA_NATIVE_NOTION_AGENT_ID"),
    pageId: get("LUMA_NATIVE_NOTION_PAGE_ID"),
    agentReadToken: get("LUMA_NATIVE_NOTION_AGENT_READ_TOKEN"),
    adminReadToken: get("LUMA_NATIVE_NOTION_ADMIN_READ_TOKEN"),
    pageReadToken: get("LUMA_NATIVE_NOTION_READONLY_API_TOKEN"),
    pageCredentialScopeId: get("LUMA_NATIVE_NOTION_CREDENTIAL_SCOPE_ID"),
    linearReadToken: get("LINEAR_READONLY_API_KEY"),
    linearTeamId: get("LINEAR_TEAM_ID"),
    workItemProviderId: get("LUMA_LINEAR_PROVIDER_ID") || "linear",
    linearCredentialScopeId: get("LUMA_NATIVE_LINEAR_CREDENTIAL_SCOPE_ID"),
    sharingPolicyPath: get("LUMA_CONTEXT_SHARING_POLICY_PATH"),
    bearerToken: get("LUMA_NATIVE_REVIEW_MCP_BEARER_TOKEN"),
    hostname: "127.0.0.1",
    port: Number(get("LUMA_NATIVE_REVIEW_HTTP_PORT") || "3003"),
    path: get("LUMA_NATIVE_REVIEW_HTTP_PATH") || "/notion/review/mcp"
  });
  if (
    !config.success ||
    new Set([
      config.data?.agentReadToken,
      config.data?.adminReadToken,
      config.data?.pageReadToken
    ]).size !== 3
  )
    throw new Error(
      "Native Notion review requires complete separate read credentials, exact provider IDs, sharing scopes and a protected MCP bearer"
    );
  if (
    [
      "NOTION_API_TOKEN",
      "LUMA_DECISION_RECORDS_NOTION_API_TOKEN",
      "LUMA_SYNTHESIS_NOTION_API_TOKEN",
      "LUMA_STRUCTURED_WORK_NOTION_API_TOKEN"
    ].some((key) => config.data.pageReadToken === get(key)) ||
    config.data.linearReadToken === get("LINEAR_API_KEY")
  )
    throw new Error(
      "Native Notion review cannot reuse the writable Notion or Linear credential"
    );
  return config.data;
}

/** Construct before the main MI, which must use this issued read-only catalog for native reconciliation. */
export function createNativeNotionReviewResources(
  input: {
    config: NativeNotionReviewConfig;
    database: LumaDatabase;
    workspace: WorkspaceConfig;
    ledger: ObservedSourceLedger;
    identityDirectory: IdentityDirectory;
    accessPolicy: WorkspaceAccessPolicy;
    operationalOutcomeMarkerVerifier: OperationalOutcomeMarkerVerifier;
  },
  dependencies: Partial<{
    createAccess: typeof createNotionNativeReviewAccess;
    createEvidenceSource: typeof createNotionObjectScopedMeetingNoteEvidenceSource;
    createWorkCatalog: typeof createLinearReadOnlyWorkCatalog;
  }> = {}
) {
  const config = input.config;
  if (
    [config.notionWorkspaceId, config.linearTeamId].includes(input.workspace.workspaceId)
  )
    throw new Error(
      "Native review provider scopes must be distinct from the logical Luma workspace"
    );
  const policy = createContextSharingPolicy({
    path: config.sharingPolicyPath,
    workspaceId: input.workspace.workspaceId
  });
  const catalog = (dependencies.createWorkCatalog ?? createLinearReadOnlyWorkCatalog)({
    teamId: config.linearTeamId,
    readOnlyApiKey: config.linearReadToken,
    providerId: config.workItemProviderId
  });
  const workCatalog = createWorkspaceBoundWorkCatalog({
    workspaceId: input.workspace.workspaceId,
    providerScopeId: catalog.providerScopeId,
    workCatalog: catalog
  });
  const access = (dependencies.createAccess ?? createNotionNativeReviewAccess)({
    workspaceId: input.workspace.workspaceId,
    notionWorkspaceId: config.notionWorkspaceId,
    agentId: config.agentId,
    pageId: config.pageId,
    agentReadToken: config.agentReadToken,
    adminReadToken: config.adminReadToken,
    identityDirectory: input.identityDirectory,
    accessPolicy: input.accessPolicy
  });
  const evidenceSource = (
    dependencies.createEvidenceSource ?? createNotionObjectScopedMeetingNoteEvidenceSource
  )({
    workspaceId: input.workspace.workspaceId,
    providerId: "notion",
    pageId: config.pageId,
    reader: createNotionObjectScopedMeetingNoteEvidenceReader({
      pageId: config.pageId,
      readOnlyApiToken: config.pageReadToken
    }),
    operationalOutcomeMarkerVerifier: input.operationalOutcomeMarkerVerifier
  });
  const authorizeSources: Parameters<
    typeof createNativeNotionReviewRuntime
  >[0]["authorizeSources"] = async ({ audience, pageId }) =>
    (await policy.authorize({
      audience,
      provider: "notion",
      credentialScopeId: config.pageCredentialScopeId,
      resource: pageId
    })) &&
    (await policy.authorize({
      audience,
      provider: "linear",
      credentialScopeId: config.linearCredentialScopeId,
      resource: config.linearTeamId
    }));
  const history = createNativeReviewSourceAccess({
    database: input.database,
    workspaceId: input.workspace.workspaceId,
    pageId: config.pageId,
    workItemProviderId: config.workItemProviderId,
    ledger: input.ledger,
    access,
    evidenceSource,
    authorizeSources
  });
  return {
    workCatalog,
    ...history,
    validate: () => policy.validate(),
    async stop() {
      await Promise.all([history.stop(), access.discovery.stop()]);
    },
    createRuntime(shared: { meetingIntelligence: MeetingIntelligence }) {
      const runtime = createNativeNotionReviewRuntime({
        ...input,
        ...shared,
        workItemProviderId: config.workItemProviderId,
        access,
        evidenceSource,
        authorizeSources
      });
      const http = createNativeNotionReviewMcp({
        runtime,
        discovery: access.discovery,
        bearerToken: config.bearerToken,
        hostname: config.hostname,
        port: config.port,
        path: config.path
      });
      return { ...http, runtime };
    }
  };
}
