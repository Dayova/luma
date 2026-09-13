import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { organizationalContextCatalogsFromEnv } from "../app/organizational-context-runtime.js";
import type { ContextSharingPolicyDocument } from "../app/context-sharing-policy.js";
import { dayovaFounderPersonIds } from "../app/founder-access.js";
import { canonicalNotionObjectId } from "../knowledge/notion-object-id.js";

export class LocalIntegrationError extends Error {}

export const localIntegrationSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("linear"),
      token: z.string().trim().min(20).max(4096),
      teamId: z.string().uuid(),
      writeToken: z.string().trim().max(4096).default("")
    })
    .strict(),
  z
    .object({
      provider: z.literal("notion"),
      token: z.string().trim().min(20).max(4096),
      pageIds: z
        .array(
          z
            .string()
            .trim()
            .refine((id) => canonicalNotionObjectId(id) !== null)
        )
        .min(1)
        .max(100),
      writeToken: z.string().trim().max(4096).default(""),
      dataSourceId: z.string().trim().default("")
    })
    .strict(),
  z
    .object({
      provider: z.literal("github"),
      token: z.string().trim().min(20).max(4096),
      repositories: z
        .array(z.string().regex(/^[\w.-]+\/[\w.-]+$/u))
        .min(1)
        .max(20)
    })
    .strict()
]);
export type LocalIntegration = z.infer<typeof localIntegrationSchema>;
export type LocalIntegrationProvider = LocalIntegration["provider"];
const workspaceId = "luma-local-ai";

/** Local credentials are explicit session input, never inherited from the production environment. */
export function createLocalIntegrations(input: {
  directory: string;
  catalogs?: typeof organizationalContextCatalogsFromEnv;
}) {
  const connections = new Map<LocalIntegrationProvider, LocalIntegration>();
  const checks = new Map<LocalIntegrationProvider, { at: string; message: string }>();
  let revision = randomUUID();
  let writesEnabled = false;
  const policyPath = join(input.directory, "local-context-sharing.json");
  const scopeId = (provider: string) => `local-${provider}-${revision}`;
  function environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    if (connections.size) {
      env["LUMA_ORGANIZATIONAL_CONTEXT_ENABLED"] = "1";
      env["LUMA_CONTEXT_SHARING_POLICY_PATH"] = policyPath;
    }
    const linear = connections.get("linear");
    if (linear?.provider === "linear") {
      env["LUMA_CONTEXT_LINEAR_READONLY_API_KEY"] = linear.token;
      env["LUMA_CONTEXT_LINEAR_CREDENTIAL_SCOPE_ID"] = scopeId("linear");
      env["LUMA_CONTEXT_LINEAR_TEAM_ID"] = linear.teamId;
      if (writesEnabled && linear.writeToken) {
        env["LINEAR_API_KEY"] = linear.writeToken;
        env["LINEAR_TEAM_ID"] = linear.teamId;
      }
    }
    const notion = connections.get("notion");
    if (notion?.provider === "notion") {
      env["LUMA_CONTEXT_NOTION_READONLY_API_TOKEN"] = notion.token;
      env["LUMA_CONTEXT_NOTION_CREDENTIAL_SCOPE_ID"] = scopeId("notion");
      env["LUMA_CONTEXT_NOTION_PAGE_IDS"] = notion.pageIds.join(",");
      if (writesEnabled && notion.writeToken) {
        env["NOTION_API_TOKEN"] = notion.writeToken;
        env["NOTION_MEETINGS_DATA_SOURCE_ID"] = notion.dataSourceId;
      }
    }
    const github = connections.get("github");
    if (github?.provider === "github") {
      env["LUMA_GITHUB_CODE_READONLY_TOKEN"] = github.token;
      env["LUMA_GITHUB_CODE_CREDENTIAL_SCOPE_ID"] = scopeId("github");
      env["LUMA_GITHUB_CODE_REPOSITORIES"] = github.repositories.join(",");
    }
    return env;
  }
  async function publishPolicy() {
    const grants: ContextSharingPolicyDocument["grants"] = [...connections.values()].map(
      (c) => ({
        provider: c.provider === "github" ? "github-code" : c.provider,
        credentialScopeId: scopeId(c.provider),
        resources:
          c.provider === "linear"
            ? [c.teamId]
            : c.provider === "notion"
              ? c.pageIds
              : c.repositories,
        personIds: [...dayovaFounderPersonIds]
      })
    );
    await mkdir(input.directory, { recursive: true, mode: 0o700 });
    const temporary = `${policyPath}.${randomUUID()}`;
    await writeFile(temporary, JSON.stringify({ version: 1, workspaceId, grants }), {
      mode: 0o600,
      flag: "wx"
    });
    await rename(temporary, policyPath);
  }
  async function catalogs() {
    return (
      (await (input.catalogs ?? organizationalContextCatalogsFromEnv)({
        workspaceId,
        env: environment()
      })) ?? []
    );
  }
  return {
    environment,
    catalogs,
    revision: () => (connections.size ? revision : "none"),
    status() {
      return {
        writesEnabled,
        providers: [...connections.values()].map((c) => ({
          provider: c.provider,
          resources:
            c.provider === "linear"
              ? [c.teamId]
              : c.provider === "notion"
                ? c.pageIds
                : c.repositories,
          writeConfigured: c.provider !== "github" && !!c.writeToken,
          check: checks.get(c.provider) ?? null
        }))
      };
    },
    async configure(raw: unknown) {
      const connection = localIntegrationSchema.parse(raw);
      if (connection.provider !== "github" && connection.writeToken) {
        if (
          connection.writeToken.length < 20 ||
          connection.writeToken === connection.token
        )
          throw new LocalIntegrationError("Use a separate write credential.");
        if (
          connection.provider === "notion" &&
          !canonicalNotionObjectId(connection.dataSourceId)
        )
          throw new LocalIntegrationError(
            "Notion writes require a meetings data source ID."
          );
      }
      if (connection.provider === "notion") {
        connection.pageIds = [
          ...new Set(connection.pageIds.map((id) => canonicalNotionObjectId(id)!))
        ];
        if (connection.dataSourceId) {
          const dataSourceId = canonicalNotionObjectId(connection.dataSourceId);
          if (!dataSourceId)
            throw new LocalIntegrationError("Notion requires a valid data source ID.");
          connection.dataSourceId = dataSourceId;
        }
      }
      const previous = connections.get(connection.provider);
      const previousRevision = revision;
      connections.set(connection.provider, connection);
      revision = randomUUID();
      try {
        await publishPolicy();
        await catalogs();
        checks.clear();
        if (
          ![...connections.values()].some(
            (c) => c.provider !== "github" && !!c.writeToken
          )
        )
          writesEnabled = false;
      } catch {
        if (previous) connections.set(connection.provider, previous);
        else connections.delete(connection.provider);
        revision = previousRevision;
        await publishPolicy();
        throw new LocalIntegrationError(
          "Provider configuration failed. Check credentials and resource IDs."
        );
      }
    },
    async remove(provider: LocalIntegrationProvider) {
      connections.delete(provider);
      checks.clear();
      if (
        ![...connections.values()].some((c) => c.provider !== "github" && !!c.writeToken)
      )
        writesEnabled = false;
      revision = randomUUID();
      await publishPolicy();
    },
    setWrites(enabled: boolean) {
      if (
        enabled &&
        ![...connections.values()].some((c) => c.provider !== "github" && !!c.writeToken)
      )
        throw new LocalIntegrationError("Configure a separate write credential first.");
      writesEnabled = enabled;
    },
    async check(provider: LocalIntegrationProvider, query: string) {
      if (!connections.has(provider))
        throw new LocalIntegrationError("Configure this provider first.");
      try {
        const available = (await catalogs()).filter(
          (c) =>
            c.id.startsWith(provider + ":") ||
            (provider === "github" && c.id.startsWith("github"))
        );
        const audience = { workspaceId, personIds: [...dayovaFounderPersonIds] };
        const sources: Array<{ title: string; content: string; reference: unknown }> = [];
        const warnings: string[] = [];
        for (const catalog of available) {
          const found = await catalog.search({ audience, concepts: [query], limit: 3 });
          warnings.push(...found.warnings);
          for (const sourceId of found.sourceIds.slice(0, 3)) {
            const source = await catalog.read({ audience, sourceId });
            if (source)
              sources.push({
                title: source.title,
                content: source.content.slice(0, 1200),
                reference: source.externalReference
              });
          }
        }
        const message = sources.length
          ? `Read ${sources.length} real source(s).`
          : "No readable source matched. Check the credential, scope, sharing and query; access is not verified.";
        checks.set(provider, { at: new Date().toISOString(), message });
        return {
          provider,
          message,
          sources,
          warnings: [...new Set(warnings)],
          aiCalls: 0
        };
      } catch {
        const message =
          "Source read failed. Check the token, selected resources and provider access; access is not verified.";
        checks.set(provider, { at: new Date().toISOString(), message });
        throw new LocalIntegrationError(message);
      }
    },
    async close() {
      connections.clear();
      writesEnabled = false;
      revision = randomUUID();
      await publishPolicy();
    }
  };
}
export type LocalIntegrations = ReturnType<typeof createLocalIntegrations>;
