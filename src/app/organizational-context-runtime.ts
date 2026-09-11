import { isAbsolute } from "node:path";
import type { ContextCatalog } from "../organizational-context/interface.js";
import { createGitHubCodeProviderFromEnv } from "../code/github-code-provider.js";
import {
  createGitHubContextCatalog,
  type GitHubContextAuthorization
} from "../organizational-context/github-context-catalog.js";
import { createGitHubChangeContextCatalog } from "../organizational-context/github-change-context-catalog.js";
import { createNotionContextCatalogFromEnv } from "../organizational-context/notion-context-catalog.js";
import { createLinearContextCatalogFromEnv } from "../organizational-context/linear-context-catalog.js";
import type { ContextCatalogAuthorization } from "../organizational-context/catalog-authorization.js";
import { createContextSharingPolicy } from "./context-sharing-policy.js";

const groups = {
  github: [
    "LUMA_GITHUB_CODE_READONLY_TOKEN",
    "LUMA_GITHUB_CODE_CREDENTIAL_SCOPE_ID",
    "LUMA_GITHUB_CODE_REPOSITORIES"
  ],
  notion: [
    "LUMA_CONTEXT_NOTION_READONLY_API_TOKEN",
    "LUMA_CONTEXT_NOTION_CREDENTIAL_SCOPE_ID",
    "LUMA_CONTEXT_NOTION_PAGE_IDS"
  ],
  linear: [
    "LUMA_CONTEXT_LINEAR_READONLY_API_KEY",
    "LUMA_CONTEXT_LINEAR_CREDENTIAL_SCOPE_ID",
    "LUMA_CONTEXT_LINEAR_TEAM_ID"
  ]
} as const;
export type OrganizationalContextRuntimeConfig = {
  policyPath: string;
  providers: (keyof typeof groups)[];
};

/** Configuration validation has no provider or credential side effects. */
export function organizationalContextRuntimeConfig(
  env: NodeJS.ProcessEnv
): OrganizationalContextRuntimeConfig | undefined {
  const enabled = env["LUMA_ORGANIZATIONAL_CONTEXT_ENABLED"]?.trim();
  if (!enabled || enabled === "0") return undefined;
  if (enabled !== "1") throw invalidConfiguration();
  const policyPath = env["LUMA_CONTEXT_SHARING_POLICY_PATH"]?.trim();
  if (!policyPath || !isAbsolute(policyPath)) throw invalidConfiguration();
  const providers = (Object.keys(groups) as (keyof typeof groups)[]).filter((provider) =>
    groups[provider].some((key) => !!env[key]?.trim())
  );
  if (
    !providers.length ||
    providers.some((provider) => groups[provider].some((key) => !env[key]?.trim()))
  )
    throw invalidConfiguration();
  return { policyPath, providers };
}

/** Creates read-only catalogs; explicit policy is reread around every provider read. */
export async function organizationalContextCatalogsFromEnv(input: {
  workspaceId: string;
  env: NodeJS.ProcessEnv;
}): Promise<ContextCatalog[] | undefined> {
  const config = organizationalContextRuntimeConfig(input.env);
  if (!config) return undefined;
  const policy = createContextSharingPolicy({
    path: config.policyPath,
    workspaceId: input.workspaceId
  });
  await policy.validate();
  const authorize: ContextCatalogAuthorization = (request) =>
    policy.authorize({
      audience: request.audience,
      credentialScopeId: request.credentialScopeId,
      provider: request.source.provider,
      resource:
        request.source.provider === "notion"
          ? request.source.pageId
          : request.source.teamId
    });
  return config.providers.flatMap((provider): ContextCatalog[] => {
    switch (provider) {
      case "github": {
        const github = {
          codeProvider: createGitHubCodeProviderFromEnv(input.env),
          authorize: (request: Parameters<GitHubContextAuthorization>[0]) =>
            policy.authorize({
              audience: request.audience,
              provider: "github-code",
              credentialScopeId: request.credentialScopeId,
              resource: request.repository
            })
        };
        return [
          createGitHubContextCatalog(github),
          createGitHubChangeContextCatalog(github)
        ];
      }
      case "notion":
        return [createNotionContextCatalogFromEnv({ ...input, authorize })];
      case "linear":
        return [createLinearContextCatalogFromEnv({ ...input, authorize })];
    }
  });
}
function invalidConfiguration(): Error {
  return new Error(
    "Organizational context requires enabled=1, an absolute sharing-policy path, and complete dedicated read-only provider configuration."
  );
}
