import {
  createNotionReadOnlyKnowledgeCatalog,
  isIssuedNotionKnowledgeCatalog,
  type NotionKnowledgeCatalog,
  type NotionKnowledgeCatalogConfig
} from "../knowledge/notion-read-only-knowledge-catalog.js";
import type { ContextCatalogAuthorization } from "./catalog-authorization.js";
import type { ContextCatalog } from "./interface.js";

export function createNotionContextCatalog(
  config: NotionKnowledgeCatalogConfig
): ContextCatalog {
  return notionKnowledgeContextCatalog(createNotionReadOnlyKnowledgeCatalog(config));
}

/** Keeps the source behind an issued read-only KnowledgeCatalog, never a narrowed writer. */
export function notionKnowledgeContextCatalog(
  knowledge: NotionKnowledgeCatalog
): ContextCatalog {
  if (!isIssuedNotionKnowledgeCatalog(knowledge))
    throw new Error("An issued read-only Notion knowledge catalog is required");
  return Object.freeze({
    id: knowledge.id,
    async search(input) {
      const result = await knowledge.listDocumentIds(input);
      return {
        sourceIds: result.documentIds,
        complete: result.complete,
        warnings: result.warnings
      };
    },
    async read({ audience, sourceId }) {
      const document = await knowledge.readDocument({ audience, documentId: sourceId });
      if (!document) return null;
      return {
        id: document.id,
        kind: "knowledge-document",
        title: document.title,
        content: document.contentMarkdown,
        version: document.version,
        updatedAt: document.updatedAt,
        externalReference: document.externalReference,
        standing: document.standing ?? "current",
        authority: "source"
      };
    }
  } satisfies ContextCatalog);
}

export function createNotionContextCatalogFromEnv(input: {
  workspaceId: string;
  authorize: ContextCatalogAuthorization;
  env?: NodeJS.ProcessEnv;
}): ContextCatalog {
  const env = input.env ?? process.env;
  return createNotionContextCatalog({
    workspaceId: input.workspaceId,
    authorize: input.authorize,
    credentialScopeId: env["LUMA_CONTEXT_NOTION_CREDENTIAL_SCOPE_ID"] ?? "",
    readOnlyApiToken: env["LUMA_CONTEXT_NOTION_READONLY_API_TOKEN"] ?? "",
    pageIds: (env["LUMA_CONTEXT_NOTION_PAGE_IDS"] ?? "")
      .split(",")
      .map((value) => value.trim())
  });
}
