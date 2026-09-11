import { createHash } from "node:crypto";
import { z } from "zod";
import { createScheduledNotionClient } from "./notion-scheduled-client.js";
import { NOTION_OPERATION_TIMEOUT_MS } from "./notion-request-scheduler.js";
import {
  isKnowledgeStanding,
  type KnowledgeStanding
} from "../domain/knowledge-standing.js";
import {
  type ContextCatalogAuthorization,
  validCatalogAudience,
  validCatalogIdentity
} from "../organizational-context/catalog-authorization.js";
import { canonicalNotionObjectId } from "./notion-object-id.js";
import type { KnowledgeAudience, KnowledgeCatalog } from "./knowledge-catalog.js";

export const NOTION_CONTEXT_API_VERSION = "2026-03-11";
const MAX_PAGES = 100;
const issuedCatalogs = new WeakSet<object>();
export const notionKnowledgeCatalogBrand: unique symbol = Symbol(
  "NotionKnowledgeCatalog"
);
export interface NotionKnowledgeCatalog extends KnowledgeCatalog {
  readonly [notionKnowledgeCatalogBrand]: true;
  readDocument(
    input: Parameters<KnowledgeCatalog["readDocument"]>[0] & {
      signal?: AbortSignal;
      priority?: "background";
    }
  ): ReturnType<KnowledgeCatalog["readDocument"]>;
}
export type NotionKnowledgeCatalogConfig = {
  workspaceId: string;
  credentialScopeId: string;
  pageIds: readonly string[];
  readOnlyApiToken: string;
  authorize: ContextCatalogAuthorization;
  token?: never;
  api?: never;
  client?: never;
};
type RawTransport = {
  retrievePage(
    pageId: string,
    signal?: AbortSignal,
    priority?: "background"
  ): Promise<unknown>;
  retrieveMarkdown(
    pageId: string,
    signal?: AbortSignal,
    priority?: "background"
  ): Promise<unknown>;
};
/** Finite deterministic read seam only; production accepts no injected client. */
export type NotionKnowledgeTransportForTest = RawTransport & {
  createPage?: never;
  updatePage?: never;
  search?: never;
};

export class NotionKnowledgeReadError extends Error {
  constructor() {
    super("Notion context could not be verified as a complete current authorized page.");
    this.name = "NotionKnowledgeReadError";
  }
}

export function createNotionReadOnlyKnowledgeCatalog(
  config: NotionKnowledgeCatalogConfig
): NotionKnowledgeCatalog {
  const bound = validateConfig(config);
  return createCatalog(bound, sdkTransport(bound.readOnlyApiToken));
}

export function createNotionReadOnlyKnowledgeCatalogForTest(
  config: NotionKnowledgeCatalogConfig,
  transport: NotionKnowledgeTransportForTest
): NotionKnowledgeCatalog {
  if (
    Object.keys(transport).some(
      (key) => !["retrievePage", "retrieveMarkdown"].includes(key)
    ) ||
    typeof transport.retrievePage !== "function" ||
    typeof transport.retrieveMarkdown !== "function"
  )
    throw new NotionKnowledgeReadError();
  return createCatalog(validateConfig(config), transport);
}

export function isIssuedNotionKnowledgeCatalog(
  value: unknown
): value is NotionKnowledgeCatalog {
  return typeof value === "object" && value !== null && issuedCatalogs.has(value);
}

function createCatalog(
  config: NotionKnowledgeCatalogConfig,
  transport: RawTransport
): NotionKnowledgeCatalog {
  const pages = new Set(config.pageIds);
  const allowed = async (
    audience: KnowledgeAudience,
    pageId: string
  ): Promise<boolean> => {
    if (!pages.has(pageId) || !validCatalogAudience(audience, config.workspaceId))
      return false;
    try {
      return (
        (await config.authorize({
          audience: copyAudience(audience),
          credentialScopeId: config.credentialScopeId,
          source: { provider: "notion", pageId }
        })) === true
      );
    } catch {
      return false;
    }
  };
  const catalog: NotionKnowledgeCatalog = {
    [notionKnowledgeCatalogBrand]: true,
    id: `notion:${config.credentialScopeId}`,
    async listDocumentIds(input) {
      const audience = copyAudience(input.audience);
      const limit = input.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGES)
        throw new NotionKnowledgeReadError();
      if (!validCatalogAudience(audience, config.workspaceId))
        return {
          documentIds: [],
          complete: false,
          warnings: ["The requested audience is outside this knowledge scope."]
        };
      const eligible: string[] = [];
      let withheld = false;
      for (const id of pages) {
        if (await allowed(audience, id)) eligible.push(id);
        else withheld = true;
      }
      // A grant can change while another page is checked. Never disclose a stale ID.
      const current: string[] = [];
      for (const id of eligible) {
        if (await allowed(audience, id)) current.push(id);
        else withheld = true;
      }
      const complete = !withheld && current.length <= limit;
      return {
        documentIds: current.slice(0, limit),
        complete,
        warnings: complete
          ? []
          : [
              "Some configured pages were outside the current audience or discovery bound."
            ]
      };
    },
    async readDocument(input) {
      const audience = copyAudience(input.audience);
      const signal = input.signal ?? AbortSignal.timeout(NOTION_OPERATION_TIMEOUT_MS);
      if (signal.aborted) throw new NotionKnowledgeReadError();
      const documentId = input.documentId;
      const pageId = canonicalNotionObjectId(documentId);
      if (!pageId || !(await allowed(audience, pageId))) return null;
      try {
        const before = parsePage(
          await transport.retrievePage(pageId, signal, input.priority),
          pageId
        );
        if (!(await allowed(audience, pageId))) return null;
        const contentMarkdown = parseMarkdown(
          await transport.retrieveMarkdown(pageId, signal, input.priority),
          pageId
        );
        if (!(await allowed(audience, pageId))) return null;
        const after = parsePage(
          await transport.retrievePage(pageId, signal, input.priority),
          pageId
        );
        if (!(await allowed(audience, pageId))) return null;
        if (signal.aborted || JSON.stringify(before) !== JSON.stringify(after))
          throw new NotionKnowledgeReadError();
        return {
          id: pageId,
          title: after.title,
          contentMarkdown,
          version: createHash("sha256")
            .update(JSON.stringify([after, contentMarkdown]))
            .digest("hex"),
          updatedAt: after.updatedAt,
          standing: after.standing,
          externalReference: {
            providerId: "notion",
            objectType: "document",
            externalId: pageId,
            url: after.url
          }
        };
      } catch {
        throw new NotionKnowledgeReadError();
      }
    }
  };
  issuedCatalogs.add(catalog);
  return Object.freeze(catalog);
}

function validateConfig(
  config: NotionKnowledgeCatalogConfig
): NotionKnowledgeCatalogConfig {
  const pageIds = config.pageIds.map(canonicalNotionObjectId);
  if (
    !config.workspaceId.trim() ||
    !validCatalogIdentity(config.credentialScopeId) ||
    !config.readOnlyApiToken.trim() ||
    typeof config.authorize !== "function" ||
    !pageIds.length ||
    pageIds.length > MAX_PAGES ||
    pageIds.some((id) => id === null) ||
    new Set(pageIds).size !== pageIds.length ||
    Object.keys(config).some(
      (key) =>
        ![
          "workspaceId",
          "credentialScopeId",
          "pageIds",
          "readOnlyApiToken",
          "authorize"
        ].includes(key)
    )
  )
    throw new NotionKnowledgeReadError();
  return { ...config, pageIds: pageIds as string[] };
}

const pageSchema = z.object({
  object: z.literal("page"),
  id: z.string(),
  url: z.string().url().max(2048),
  archived: z.literal(false),
  in_trash: z.literal(false),
  last_edited_time: z.string().datetime({ offset: true }),
  properties: z.record(z.unknown())
});
function parsePage(raw: unknown, pageId: string) {
  const page = pageSchema.parse(raw);
  const url = new URL(page.url);
  if (
    canonicalNotionObjectId(page.id) !== pageId ||
    url.protocol !== "https:" ||
    url.username ||
    url.password
  )
    throw new NotionKnowledgeReadError();
  const titles = Object.values(page.properties).filter(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "title"
  );
  if (titles.length !== 1) throw new NotionKnowledgeReadError();
  const titleProperty = z
    .object({
      title: z.array(z.object({ plain_text: z.string() })).max(100)
    })
    .parse(titles[0]);
  const title = titleProperty.title.map((item) => item.plain_text).join("") || "Untitled";
  if (title.length > 1024) throw new NotionKnowledgeReadError();
  return {
    id: pageId,
    title,
    url: page.url,
    updatedAt: page.last_edited_time,
    standing: explicitStanding(page.properties)
  };
}

function explicitStanding(properties: Record<string, unknown>): KnowledgeStanding {
  const raw = properties["Luma knowledge state"];
  if (raw === undefined) return "current";
  const property = z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("select"),
        select: z.object({ name: z.string() }).nullable()
      }),
      z.object({
        type: z.literal("status"),
        status: z.object({ name: z.string() }).nullable()
      })
    ])
    .parse(raw);
  const option = property.type === "select" ? property.select : property.status;
  // An explicitly present but unset/unknown policy field cannot silently assert currentness.
  const standing = option?.name.trim().toLowerCase();
  if (!isKnowledgeStanding(standing)) throw new NotionKnowledgeReadError();
  return standing;
}
function parseMarkdown(raw: unknown, pageId: string): string {
  const markdown = z
    .object({
      object: z.literal("page_markdown"),
      id: z.string(),
      markdown: z.string().min(1).max(100_000),
      truncated: z.literal(false),
      unknown_block_ids: z.array(z.string()).max(0)
    })
    .parse(raw);
  if (
    canonicalNotionObjectId(markdown.id) !== pageId ||
    /<unknown(?:\s|\/|>)/u.test(markdown.markdown)
  )
    throw new NotionKnowledgeReadError();
  return markdown.markdown;
}
function sdkTransport(token: string): RawTransport {
  const { client, request } = createScheduledNotionClient(token);
  return {
    retrievePage: (pageId, signal, priority) =>
      request({
        signal: signal ?? AbortSignal.timeout(NOTION_OPERATION_TIMEOUT_MS),
        readOnly: true,
        ...(priority ? { priority } : {}),
        send: () => client.pages.retrieve({ page_id: pageId })
      }),
    retrieveMarkdown: (pageId, signal, priority) =>
      request({
        signal: signal ?? AbortSignal.timeout(NOTION_OPERATION_TIMEOUT_MS),
        readOnly: true,
        ...(priority ? { priority } : {}),
        send: () =>
          client.pages.retrieveMarkdown({ page_id: pageId, include_transcript: true })
      })
  };
}

function copyAudience(audience: KnowledgeAudience): KnowledgeAudience {
  return { workspaceId: audience.workspaceId, personIds: [...audience.personIds] };
}
