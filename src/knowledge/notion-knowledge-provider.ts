import {
  Client,
  isFullPage,
  isFullUser,
  type CreatePageParameters,
  type PageObjectResponse
} from "@notionhq/client";
import type { ExternalReference, ExternalUser } from "../domain/model.js";
import type {
  ChangePage,
  CreateDocumentInput,
  KnowledgeDocument,
  KnowledgeProvider,
  KnowledgeQuery,
  KnowledgeResult
} from "./interface.js";

const IDEMPOTENCY_MARKER_PREFIX = "Luma execution key:";

export type NotionApiDocument = {
  id: string;
  title: string;
  contentMarkdown: string;
  url: string;
  version: string;
  updatedAt: string;
  updatedBy: ExternalUser | null;
};

export type NotionCreateDocumentInput = {
  dataSourceId: string;
  titleProperty: string;
  attendeesProperty: string | null;
  title: string;
  contentMarkdown: string;
  participantUserIds: string[];
};

export interface NotionApi {
  findByIdempotencyKey(input: {
    dataSourceId: string;
    idempotencyKey: string;
    titleProperty: string;
  }): Promise<NotionApiDocument | null>;
  searchDocuments(input: {
    text: string;
    limit: number;
    titleProperty: string;
  }): Promise<NotionApiDocument[]>;
  getDocument(input: { id: string; titleProperty: string }): Promise<NotionApiDocument>;
  createDocument(input: NotionCreateDocumentInput): Promise<NotionApiDocument>;
  listChanges(input: {
    dataSourceId: string;
    titleProperty: string;
    cursor?: string;
  }): Promise<{ documents: NotionApiDocument[]; nextCursor: string | null }>;
}

export type NotionKnowledgeProviderConfig = {
  meetingsDataSourceId: string;
  token?: string;
  providerId?: string;
  titleProperty?: string;
  attendeesProperty?: string;
  api?: NotionApi;
};

export class NotionKnowledgeProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NotionKnowledgeProviderError";
    this.code = code;
  }
}

export function createNotionKnowledgeProvider(
  config: NotionKnowledgeProviderConfig
): KnowledgeProvider {
  const providerId = config.providerId ?? "notion";
  const titleProperty = config.titleProperty ?? "Name";
  const attendeesProperty = config.attendeesProperty ?? "Attendees";
  const api = config.api ?? createNotionSdkApi(config);

  return {
    providerId,
    identityProviderId: "notion",
    async search(query: KnowledgeQuery): Promise<KnowledgeResult[]> {
      const documents = await api.searchDocuments({
        text: query.text,
        limit: query.limit,
        titleProperty
      });
      return documents.map((document, index) => ({
        document: toKnowledgeDocument(document, providerId),
        score: Math.max(0, 1 - index / Math.max(1, documents.length))
      }));
    },
    async getDocument(id: string): Promise<KnowledgeDocument> {
      return toKnowledgeDocument(
        await api.getDocument({ id, titleProperty }),
        providerId
      );
    },
    async createDocument(input: CreateDocumentInput): Promise<ExternalReference> {
      const dataSourceId = input.parentId ?? config.meetingsDataSourceId;
      const existing = await api.findByIdempotencyKey({
        dataSourceId,
        idempotencyKey: input.idempotencyKey,
        titleProperty
      });

      if (existing) {
        return toExternalReference(existing, providerId);
      }

      const document = await api.createDocument({
        dataSourceId,
        titleProperty,
        attendeesProperty,
        title: input.title,
        contentMarkdown: withIdempotencyMarker(
          input.contentMarkdown,
          input.idempotencyKey
        ),
        participantUserIds: unique(input.participantProviderUserIds ?? [])
      });
      return toExternalReference(document, providerId);
    },
    async findCreatedDocumentByIdempotencyKey(idempotencyKey) {
      const existing = await api.findByIdempotencyKey({
        dataSourceId: config.meetingsDataSourceId,
        idempotencyKey,
        titleProperty
      });
      return existing ? toExternalReference(existing, providerId) : null;
    },
    async listChanges(cursor?: string): Promise<ChangePage> {
      const result = await api.listChanges({
        dataSourceId: config.meetingsDataSourceId,
        titleProperty,
        ...(cursor ? { cursor } : {})
      });
      return {
        changes: result.documents.map((document) =>
          toKnowledgeDocument(document, providerId)
        ),
        nextCursor: result.nextCursor
      };
    }
  };
}

export function createNotionKnowledgeProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env
): KnowledgeProvider {
  const config: NotionKnowledgeProviderConfig = {
    token: requireEnv(env, "NOTION_API_TOKEN"),
    meetingsDataSourceId: requireEnv(env, "NOTION_MEETINGS_DATA_SOURCE_ID")
  };
  const providerId = nonBlank(env["LUMA_NOTION_PROVIDER_ID"]);
  const titleProperty = nonBlank(env["NOTION_MEETINGS_TITLE_PROPERTY"]);
  const attendeesProperty = nonBlank(env["NOTION_MEETINGS_ATTENDEES_PROPERTY"]);

  if (providerId) {
    config.providerId = providerId;
  }

  if (titleProperty) {
    config.titleProperty = titleProperty;
  }

  if (attendeesProperty) {
    config.attendeesProperty = attendeesProperty;
  }

  return createNotionKnowledgeProvider(config);
}

function createNotionSdkApi(config: NotionKnowledgeProviderConfig): NotionApi {
  if (!config.token) {
    throw new NotionKnowledgeProviderError(
      "notion-token-missing",
      "NOTION_API_TOKEN is required for the Notion KnowledgeProvider"
    );
  }

  return new NotionSdkApi(new Client({ auth: config.token }));
}

class NotionSdkApi implements NotionApi {
  constructor(private readonly client: Client) {}

  async findByIdempotencyKey(input: {
    dataSourceId: string;
    idempotencyKey: string;
    titleProperty: string;
  }): Promise<NotionApiDocument | null> {
    let cursor: string | undefined;
    const marker = `${IDEMPOTENCY_MARKER_PREFIX} \`${input.idempotencyKey}\``;

    do {
      const result = await this.client.dataSources.query({
        data_source_id: input.dataSourceId,
        page_size: 100,
        result_type: "page",
        ...(cursor ? { start_cursor: cursor } : {})
      });
      const pages = result.results.filter(isFullPage);

      if (
        result.request_status?.type === "incomplete" ||
        pages.length !== result.results.length
      ) {
        throw new NotionKnowledgeProviderError(
          "notion-idempotency-probe-incomplete",
          "Notion returned incomplete page coverage while checking a Luma execution marker"
        );
      }

      const documents = await Promise.all(
        pages.map((page) => this.toApiDocument(page, input.titleProperty))
      );
      const existing = documents.find((document) =>
        document.contentMarkdown.includes(marker)
      );

      if (existing) {
        return existing;
      }

      cursor = result.next_cursor ?? undefined;
    } while (cursor);

    return null;
  }

  async searchDocuments(input: {
    text: string;
    limit: number;
    titleProperty: string;
  }): Promise<NotionApiDocument[]> {
    const result = await this.client.search({
      query: input.text,
      page_size: input.limit,
      filter: { property: "object", value: "page" }
    });
    return Promise.all(
      result.results
        .filter(isFullPage)
        .slice(0, input.limit)
        .map((page) => this.toApiDocument(page, input.titleProperty))
    );
  }

  async getDocument(input: {
    id: string;
    titleProperty: string;
  }): Promise<NotionApiDocument> {
    const page = await this.client.pages.retrieve({ page_id: input.id });

    if (!isFullPage(page)) {
      throw new NotionKnowledgeProviderError(
        "notion-page-incomplete",
        `Notion page ${input.id} was returned without properties`
      );
    }

    return this.toApiDocument(page, input.titleProperty);
  }

  async createDocument(input: NotionCreateDocumentInput): Promise<NotionApiDocument> {
    const properties: NonNullable<CreatePageParameters["properties"]> = {
      [input.titleProperty]: {
        type: "title",
        title: [{ type: "text", text: { content: input.title } }]
      }
    };

    if (input.attendeesProperty && input.participantUserIds.length > 0) {
      properties[input.attendeesProperty] = {
        type: "people",
        people: input.participantUserIds.map((id) => ({ id }))
      };
    }

    const page = await this.client.pages.create({
      parent: { type: "data_source_id", data_source_id: input.dataSourceId },
      properties,
      markdown: input.contentMarkdown
    });

    if (!isFullPage(page)) {
      throw new NotionKnowledgeProviderError(
        "notion-page-create-incomplete",
        "Notion did not return the created page"
      );
    }

    return this.toApiDocument(page, input.titleProperty);
  }

  async listChanges(input: {
    dataSourceId: string;
    titleProperty: string;
    cursor?: string;
  }): Promise<{ documents: NotionApiDocument[]; nextCursor: string | null }> {
    const result = await this.client.dataSources.query({
      data_source_id: input.dataSourceId,
      page_size: 100,
      result_type: "page",
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      ...(input.cursor ? { start_cursor: input.cursor } : {})
    });
    const pages = result.results.filter(isFullPage);

    if (
      result.request_status?.type === "incomplete" ||
      pages.length !== result.results.length
    ) {
      throw new NotionKnowledgeProviderError(
        "notion-change-scan-incomplete",
        "Notion returned incomplete page coverage while listing Knowledge changes"
      );
    }

    return {
      documents: await Promise.all(
        pages.map((page) => this.toApiDocument(page, input.titleProperty))
      ),
      nextCursor: result.next_cursor
    };
  }

  private async toApiDocument(
    page: PageObjectResponse,
    titleProperty: string
  ): Promise<NotionApiDocument> {
    const markdown = await this.client.pages.retrieveMarkdown({ page_id: page.id });

    assertCompleteNotionMarkdown(page.id, markdown);

    const updatedBy = isFullUser(page.last_edited_by)
      ? {
          id: page.last_edited_by.id,
          displayName: page.last_edited_by.name ?? page.last_edited_by.id
        }
      : null;

    return {
      id: page.id,
      title: readPageTitle(page, titleProperty),
      contentMarkdown: markdown.markdown,
      url: page.url,
      version: page.last_edited_time,
      updatedAt: page.last_edited_time,
      updatedBy
    };
  }
}

export function assertCompleteNotionMarkdown(
  pageId: string,
  markdown: { truncated: boolean; unknown_block_ids: string[] }
): void {
  if (!markdown.truncated && markdown.unknown_block_ids.length === 0) {
    return;
  }

  throw new NotionKnowledgeProviderError(
    "notion-markdown-incomplete",
    `Notion page ${pageId} returned incomplete Markdown; it cannot be used to prove a Luma execution marker is absent`
  );
}

function readPageTitle(page: PageObjectResponse, titleProperty: string): string {
  const property = page.properties[titleProperty];

  if (!property || property.type !== "title") {
    return "Untitled";
  }

  return property.title.map((part) => part.plain_text).join("") || "Untitled";
}

function toKnowledgeDocument(
  document: NotionApiDocument,
  providerId: string
): KnowledgeDocument {
  return {
    id: document.id,
    providerId,
    externalId: document.id,
    title: document.title,
    contentMarkdown: document.contentMarkdown,
    parentId: null,
    url: document.url,
    version: document.version,
    updatedAt: document.updatedAt,
    updatedBy: document.updatedBy,
    permissions: {
      visibility: "shared",
      authorizedPrincipalIds: []
    },
    metadata: {}
  };
}

function toExternalReference(
  document: NotionApiDocument,
  providerId: string
): ExternalReference {
  return {
    providerId,
    objectType: "document",
    externalId: document.id,
    url: document.url,
    version: document.version
  };
}

function withIdempotencyMarker(content: string, idempotencyKey: string): string {
  return `${content.trim()}\n\n_${IDEMPOTENCY_MARKER_PREFIX} \`${idempotencyKey}\`_`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = nonBlank(env[key]);

  if (!value) {
    throw new NotionKnowledgeProviderError(
      "notion-config-incomplete",
      `${key} is required for the Notion KnowledgeProvider`
    );
  }

  return value;
}

function nonBlank(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
