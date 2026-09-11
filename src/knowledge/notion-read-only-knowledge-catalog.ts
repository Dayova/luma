import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Client } from "@notionhq/client";
import type * as NotionSdk from "@notionhq/client";
import { z } from "zod";
import {
  type ContextCatalogAuthorization,
  validCatalogAudience,
  validCatalogIdentity
} from "../organizational-context/catalog-authorization.js";
import { canonicalNotionObjectId } from "./notion-object-id.js";
import type { KnowledgeAudience, KnowledgeCatalog } from "./knowledge-catalog.js";

export const NOTION_CONTEXT_API_VERSION = "2026-03-11";
const MAX_PAGES = 100;
const requireSdk = createRequire(import.meta.url);
const issuedCatalogs = new WeakSet<object>();
export const notionKnowledgeCatalogBrand: unique symbol = Symbol(
  "NotionKnowledgeCatalog"
);
export interface NotionKnowledgeCatalog extends KnowledgeCatalog {
  readonly [notionKnowledgeCatalogBrand]: true;
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
  retrievePage(pageId: string): Promise<unknown>;
  retrieveMarkdown(pageId: string): Promise<unknown>;
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
  const { Client } = requireSdk("@notionhq/client") as Pick<typeof NotionSdk, "Client">;
  const client = new Client({
    auth: bound.readOnlyApiToken,
    notionVersion: NOTION_CONTEXT_API_VERSION,
    timeoutMs: 4_000,
    retry: false,
    // Provider diagnostics can contain private request material.
    logger: () => undefined
  });
  return createCatalog(bound, sdkTransport(client));
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
      const documentId = input.documentId;
      const pageId = canonicalNotionObjectId(documentId);
      if (!pageId || !(await allowed(audience, pageId))) return null;
      try {
        const before = parsePage(await transport.retrievePage(pageId), pageId);
        if (!(await allowed(audience, pageId))) return null;
        const contentMarkdown = parseMarkdown(
          await transport.retrieveMarkdown(pageId),
          pageId
        );
        if (!(await allowed(audience, pageId))) return null;
        const after = parsePage(await transport.retrievePage(pageId), pageId);
        if (!(await allowed(audience, pageId))) return null;
        if (JSON.stringify(before) !== JSON.stringify(after))
          throw new NotionKnowledgeReadError();
        return {
          id: pageId,
          title: after.title,
          contentMarkdown,
          version: createHash("sha256")
            .update(JSON.stringify([after, contentMarkdown]))
            .digest("hex"),
          updatedAt: after.updatedAt,
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
  return { id: pageId, title, url: page.url, updatedAt: page.last_edited_time };
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
function sdkTransport(client: Client): RawTransport {
  return {
    retrievePage: (pageId) => client.pages.retrieve({ page_id: pageId }),
    retrieveMarkdown: (pageId) =>
      client.pages.retrieveMarkdown({ page_id: pageId, include_transcript: true })
  };
}

function copyAudience(audience: KnowledgeAudience): KnowledgeAudience {
  return { workspaceId: audience.workspaceId, personIds: [...audience.personIds] };
}
