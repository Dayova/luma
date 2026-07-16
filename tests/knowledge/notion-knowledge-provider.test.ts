import { describe, expect, it } from "vitest";
import {
  createNotionKnowledgeProvider,
  type NotionApi,
  type NotionApiDocument,
  type NotionCreateDocumentInput
} from "../../src/knowledge/notion-knowledge-provider.js";

function notionDocument(overrides: Partial<NotionApiDocument> = {}): NotionApiDocument {
  return {
    id: "notion-page-1",
    title: "Product Meeting",
    contentMarkdown: "# Product Meeting",
    url: "https://notion.so/notion-page-1",
    version: "2026-07-16T09:06:00.000Z",
    updatedAt: "2026-07-16T09:06:00.000Z",
    updatedBy: null,
    ...overrides
  };
}

class FakeNotionApi implements NotionApi {
  readonly createCalls: NotionCreateDocumentInput[] = [];
  existing: NotionApiDocument | null = null;

  findByIdempotencyKey(): Promise<NotionApiDocument | null> {
    return Promise.resolve(this.existing);
  }

  searchDocuments(): Promise<NotionApiDocument[]> {
    return Promise.resolve([]);
  }

  getDocument(): Promise<NotionApiDocument> {
    return Promise.resolve(notionDocument());
  }

  createDocument(input: NotionCreateDocumentInput): Promise<NotionApiDocument> {
    this.createCalls.push(input);
    return Promise.resolve(
      notionDocument({ title: input.title, contentMarkdown: input.contentMarkdown })
    );
  }

  updateDocument(): Promise<NotionApiDocument> {
    return Promise.resolve(notionDocument());
  }

  listChanges(): Promise<{ documents: NotionApiDocument[]; nextCursor: string | null }> {
    return Promise.resolve({ documents: [], nextCursor: null });
  }
}

describe("Notion KnowledgeProvider", () => {
  it("creates an idempotent Meeting record in the configured data source", async () => {
    const api = new FakeNotionApi();
    const provider = createNotionKnowledgeProvider({
      api,
      meetingsDataSourceId: "3982e872-28bf-8080-bf00-000b188b90d6",
      titleProperty: "Name",
      attendeesProperty: "Attendees"
    });

    const reference = await provider.createDocument({
      title: "Product Meeting",
      contentMarkdown: "# Product Meeting\n\nWe decided to ship on Monday.",
      parentId: null,
      participantProviderUserIds: [
        "612665e1-6fad-4c71-a856-a41a0fb1f32e",
        "398d872b-594c-81f6-ac94-00026a72946d"
      ],
      idempotencyKey: "workspace:meeting:intent:execute"
    });

    expect(api.createCalls).toEqual([
      {
        dataSourceId: "3982e872-28bf-8080-bf00-000b188b90d6",
        titleProperty: "Name",
        attendeesProperty: "Attendees",
        title: "Product Meeting",
        contentMarkdown: [
          "# Product Meeting",
          "",
          "We decided to ship on Monday.",
          "",
          "_Luma execution key: `workspace:meeting:intent:execute`_"
        ].join("\n"),
        participantUserIds: [
          "612665e1-6fad-4c71-a856-a41a0fb1f32e",
          "398d872b-594c-81f6-ac94-00026a72946d"
        ]
      }
    ]);
    expect(reference).toEqual({
      providerId: "notion",
      objectType: "document",
      externalId: "notion-page-1",
      url: "https://notion.so/notion-page-1",
      version: "2026-07-16T09:06:00.000Z"
    });
  });

  it("does not create a second page when the idempotency marker is found", async () => {
    const api = new FakeNotionApi();
    api.existing = notionDocument();
    const provider = createNotionKnowledgeProvider({
      api,
      meetingsDataSourceId: "meetings"
    });

    const reference = await provider.createDocument({
      title: "Product Meeting",
      contentMarkdown: "Meeting record",
      parentId: null,
      idempotencyKey: "workspace:meeting:intent:execute"
    });

    expect(reference.externalId).toBe("notion-page-1");
    expect(api.createCalls).toHaveLength(0);
  });
});
