import { isAbsolute } from "node:path";
import { canonicalNotionObjectId } from "../knowledge/notion-object-id.js";
import { createNotionMeetingSynthesisWriter } from "../knowledge/notion-meeting-synthesis-writer.js";
import { createContextSharingPolicy } from "./context-sharing-policy.js";
import { organizationalContextRuntimeConfig } from "./organizational-context-runtime.js";

export type MeetingCaptureRuntimeConfig = {
  notion?: {
    providerId: "notion";
    canonicalSourceScopeId: string;
    authorizationScopeId: string;
  };
  granolaEnabled: boolean;
  publication: {
    importedMeetingsDataSourceId: string;
    credentialScopeId: string;
    sharingPolicyPath: string;
  };
};

/** Validate all selected capabilities before starting intake or opening persistence. */
export function meetingCaptureRuntimeConfig(
  env: NodeJS.ProcessEnv
): MeetingCaptureRuntimeConfig | undefined {
  if (!flag(env, "LUMA_MEETING_CAPTURE_SYNTHESIS_ENABLED")) return undefined;
  const granolaEnabled = flag(env, "LUMA_GRANOLA_OAUTH_ENABLED");
  const sourceToken = env["NOTION_API_TOKEN"]?.trim();
  const sourceId = env["NOTION_MEETINGS_DATA_SOURCE_ID"]?.trim();
  const notionConfigured = Boolean(sourceToken || sourceId);
  const importedMeetingsDataSourceId = canonicalNotionObjectId(
    env["LUMA_SYNTHESIS_IMPORTED_MEETINGS_DATA_SOURCE_ID"] ?? ""
  );
  const credentialScopeId = env["LUMA_SYNTHESIS_CREDENTIAL_SCOPE_ID"]?.trim();
  const sharingPolicyPath = env["LUMA_CONTEXT_SHARING_POLICY_PATH"]?.trim();
  if (
    !importedMeetingsDataSourceId ||
    !credentialScopeId ||
    !sharingPolicyPath ||
    !isAbsolute(sharingPolicyPath) ||
    !env["LUMA_SYNTHESIS_NOTION_API_TOKEN"]?.trim() ||
    Buffer.byteLength(env["LUMA_SYNTHESIS_SIGNING_KEY"] ?? "") < 32 ||
    !env["OPENAI_API_KEY"]?.trim() ||
    (env["LUMA_REASONING_MODEL_PROVIDER"]?.trim() || "openai") !== "openai" ||
    (!notionConfigured && !granolaEnabled)
  )
    throw new Error(
      "Capture synthesis requires a governed source, shared AI capability, exact imported-record destination, dedicated publication credential/scope, protected sharing policy and stable signing key."
    );
  let notion: MeetingCaptureRuntimeConfig["notion"];
  if (notionConfigured) {
    const canonicalSourceScopeId = canonicalNotionObjectId(sourceId ?? "");
    const context = organizationalContextRuntimeConfig(env);
    const authorizationScopeId = env["LUMA_CONTEXT_NOTION_CREDENTIAL_SCOPE_ID"]?.trim();
    if (
      !sourceToken ||
      !canonicalSourceScopeId ||
      !authorizationScopeId ||
      !context?.providers.includes("notion") ||
      (env["LUMA_NOTION_PROVIDER_ID"]?.trim() || "notion") !== "notion"
    )
      throw new Error(
        "Notion capture synthesis requires the canonical Notion source and separately granted read-only imported-source access."
      );
    notion = { providerId: "notion", canonicalSourceScopeId, authorizationScopeId };
  }
  return {
    ...(notion ? { notion } : {}),
    granolaEnabled,
    publication: { importedMeetingsDataSourceId, credentialScopeId, sharingPolicyPath }
  };
}

/** One approved publication port; the shared policy grants exact pages or the owned-record location. */
export async function createMeetingSynthesisRuntime(input: {
  workspaceId: string;
  config: MeetingCaptureRuntimeConfig;
  env: NodeJS.ProcessEnv;
}) {
  const config = structuredClone(input.config.publication);
  const policy = createContextSharingPolicy({
    workspaceId: input.workspaceId,
    path: config.sharingPolicyPath
  });
  await policy.validate();
  return createNotionMeetingSynthesisWriter({
    workspaceId: input.workspaceId,
    importedMeetingsDataSourceId: config.importedMeetingsDataSourceId,
    token: input.env["LUMA_SYNTHESIS_NOTION_API_TOKEN"]!,
    signingKey: input.env["LUMA_SYNTHESIS_SIGNING_KEY"]!,
    titleProperty: "title",
    authorize: ({ audience, target }) =>
      policy.authorize({
        audience,
        provider: "notion",
        credentialScopeId: config.credentialScopeId,
        resource: target.externalId
      })
  });
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim();
  if (!value || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error(`${name} must be 1 or 0`);
}
