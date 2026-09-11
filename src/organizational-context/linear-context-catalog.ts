import { createHash } from "node:crypto";
import {
  isKnowledgeStanding,
  type KnowledgeStanding
} from "../domain/knowledge-standing.js";
import {
  createLinearReadOnlyWorkCatalog,
  isIssuedLinearReadOnlyWorkCatalog,
  type LinearReadOnlyWorkCatalog
} from "../work/linear-read-only-work-catalog.js";
import type { WorkItem } from "../work/interface.js";
import {
  validCatalogAudience,
  validCatalogIdentity,
  type ContextCatalogAuthorization
} from "./catalog-authorization.js";
import type { ContextAudience, ContextCatalog, ContextSource } from "./interface.js";

const MAX_RESULTS = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,63}-[1-9][0-9]{0,14}$/iu;
const BOUNDED_WARNING =
  "Linear context uses bounded, non-exhaustive search; additional or archived work may be omitted.";
const UNAVAILABLE_WARNING = "Linear context is unavailable for this audience or source.";

export type LinearContextCatalogConfig = {
  workspaceId: string;
  credentialScopeId: string;
  authorize: ContextCatalogAuthorization;
  readOnlyWorkCatalog: LinearReadOnlyWorkCatalog;
};

/** Explicit audience grants and a separately issued read-only capability are both required. */
export function createLinearContextCatalog(
  config: LinearContextCatalogConfig
): ContextCatalog {
  if (
    !validCatalogIdentity(config.workspaceId) ||
    !validCatalogIdentity(config.credentialScopeId) ||
    typeof config.authorize !== "function" ||
    !isIssuedLinearReadOnlyWorkCatalog(config.readOnlyWorkCatalog) ||
    !validCatalogIdentity(config.readOnlyWorkCatalog.providerScopeId)
  ) {
    throw new Error(
      "Linear context requires a workspace, credential scope, and issued read-only team catalog"
    );
  }
  const {
    workspaceId,
    credentialScopeId,
    readOnlyWorkCatalog: reader,
    authorize
  } = config;
  const teamId = reader.providerScopeId;

  async function granted(audience: ContextAudience, issueId?: string): Promise<boolean> {
    if (!validCatalogAudience(audience, workspaceId)) return false;
    return (
      (await authorize({
        audience: {
          workspaceId: audience.workspaceId,
          personIds: [...audience.personIds]
        },
        credentialScopeId,
        source: { provider: "linear", teamId, ...(issueId ? { issueId } : {}) }
      })) === true
    );
  }

  async function sourceGranted(
    audience: ContextAudience,
    issueId: string
  ): Promise<boolean> {
    return (await granted(audience)) && (await granted(audience, issueId));
  }

  return Object.freeze({
    id: `linear:${credentialScopeId}:${teamId}`,
    async search(input) {
      const audience = copyAudience(input.audience);
      const unavailable = () => ({
        sourceIds: [],
        complete: false,
        warnings: [UNAVAILABLE_WARNING]
      });
      if (
        !validCatalogAudience(audience, workspaceId) ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.concepts.length === 0 ||
        input.concepts.length > 20 ||
        input.concepts.some((text) => !text.trim() || text.length > 2_000)
      )
        return unavailable();
      const limit = Math.min(input.limit, MAX_RESULTS);
      const candidates = new Map<string, string>();
      try {
        for (const text of new Set(input.concepts.map((concept) => concept.trim()))) {
          if (!(await granted(audience))) return unavailable();
          const results = await reader.searchWorkItems({
            workspaceId: teamId,
            text,
            limit
          });
          if (!(await granted(audience))) return unavailable();
          for (const item of results) {
            const sourceId = sourceIdFor(item);
            if (!sourceId) return unavailable();
            if (await granted(audience, item.id)) candidates.set(sourceId, item.id);
            if (candidates.size >= limit) break;
          }
          if (candidates.size >= limit) break;
        }
        // Recheck every accumulated result after all provider reads. An earlier
        // grant can disappear while another concept or issue is being inspected.
        const sourceIds: string[] = [];
        for (const [sourceId, issueId] of candidates) {
          if (await granted(audience, issueId)) sourceIds.push(sourceId);
        }
        if (!(await granted(audience))) return unavailable();
        return { sourceIds, complete: false, warnings: [BOUNDED_WARNING] };
      } catch {
        // No provider diagnostics or partially accumulated private identifiers escape.
        return unavailable();
      }
    },
    async read(input) {
      const audience = copyAudience(input.audience);
      const sourceId = input.sourceId;
      const selector = parseSourceId(sourceId);
      if (!selector || !validCatalogAudience(audience, workspaceId)) return null;
      try {
        if (!(await sourceGranted(audience, selector.issueId))) return null;
        // The underlying reader admits UUIDs only through its own bounded search.
        // Repeat that admission after restart without persisting provider capabilities.
        const results = await reader.searchWorkItems({
          workspaceId: teamId,
          text: selector.identifier,
          limit: MAX_RESULTS
        });
        if (!(await sourceGranted(audience, selector.issueId))) return null;
        if (
          !results.some(
            (item) =>
              item.id === selector.issueId && item.externalId === selector.identifier
          )
        )
          return null;
        const item = await reader.getWorkItem(selector.issueId);
        if (!(await sourceGranted(audience, selector.issueId))) return null;
        if (item.id !== selector.issueId || item.externalId !== selector.identifier)
          return null;
        return toContextSource(item, sourceId);
      } catch {
        return null;
      }
    }
  } satisfies ContextCatalog);
}

/** No writer or reconciliation credential fallback is permitted. */
export function createLinearContextCatalogFromEnv(input: {
  workspaceId: string;
  authorize: ContextCatalogAuthorization;
  env?: NodeJS.ProcessEnv;
}): ContextCatalog {
  const env = input.env ?? process.env;
  const readOnlyApiKey = requiredEnvironment(env, "LUMA_CONTEXT_LINEAR_READONLY_API_KEY");
  const teamId = requiredEnvironment(env, "LUMA_CONTEXT_LINEAR_TEAM_ID");
  const credentialScopeId = requiredEnvironment(
    env,
    "LUMA_CONTEXT_LINEAR_CREDENTIAL_SCOPE_ID"
  );
  if (
    !validCatalogIdentity(input.workspaceId) ||
    !validCatalogIdentity(credentialScopeId) ||
    !validCatalogIdentity(teamId)
  ) {
    throw new Error("Linear context has an invalid workspace or credential scope");
  }
  return createLinearContextCatalog({
    workspaceId: input.workspaceId,
    credentialScopeId,
    authorize: input.authorize,
    readOnlyWorkCatalog: createLinearReadOnlyWorkCatalog({ teamId, readOnlyApiKey })
  });
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Linear context`);
  return value;
}

function copyAudience(audience: ContextAudience): ContextAudience {
  return { workspaceId: audience.workspaceId, personIds: [...audience.personIds] };
}

function sourceIdFor(item: WorkItem): string | null {
  return UUID.test(item.id) && IDENTIFIER.test(item.externalId)
    ? `issue:${item.id}:${item.externalId}`
    : null;
}

function parseSourceId(sourceId: string): { issueId: string; identifier: string } | null {
  const parts = sourceId.split(":");
  const [, issueId, identifier] = parts;
  return parts.length === 3 &&
    parts[0] === "issue" &&
    issueId &&
    identifier &&
    UUID.test(issueId) &&
    IDENTIFIER.test(identifier)
    ? { issueId, identifier }
    : null;
}

function toContextSource(item: WorkItem, sourceId: string): ContextSource | null {
  const standing = explicitStanding(item.labels);
  if (!standing) return null;
  if (
    !item.title.trim() ||
    !Number.isFinite(Date.parse(item.updatedAt)) ||
    !/(?:Z|[+-]\d\d:\d\d)$/u.test(item.updatedAt)
  )
    return null;
  const url = new URL(item.url);
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const content = [
    `Linear work item: ${item.externalId}`,
    `Title: ${item.title}`,
    `Description:\n${item.description}`,
    `Normalized work state: ${item.status}`,
    `Due date: ${item.dueDate ?? "not set"}`,
    `Labels: ${item.labels.length ? item.labels.join(", ") : "none"}`,
    "This is the current tracker record, not a Human-confirmed Decision or Ownership Attribution."
  ].join("\n\n");
  return {
    id: sourceId,
    kind: "work-item",
    title: item.title,
    content,
    version: createHash("sha256").update(JSON.stringify(item)).digest("hex"),
    updatedAt: item.updatedAt,
    externalReference: {
      providerId: item.providerId,
      objectType: "work-item",
      externalId: item.externalId,
      url: item.url
    },
    authority: "source",
    standing
  };
}

function explicitStanding(labels: string[]): KnowledgeStanding | null {
  const prefix = "luma:knowledge:";
  const explicit = [...new Set(labels.filter((label) => label.startsWith(prefix)))];
  if (explicit.length === 0) return "current";
  // Conflicting labels are not a licence to select the most convenient state.
  if (explicit.length !== 1) return null;
  const standing = explicit[0]!.slice(prefix.length);
  return isKnowledgeStanding(standing) ? standing : null;
}
