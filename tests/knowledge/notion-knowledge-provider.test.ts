import { describe, expect, expectTypeOf, it } from "vitest";
import {
  assertCompleteNotionMarkdown,
  createNotionKnowledgeProvider,
  NotionKnowledgeProviderError,
  type NotionApi,
  type NotionApiDocument,
  type NotionCreateDocumentInput
} from "../../src/knowledge/notion-knowledge-provider.js";
import type { KnowledgeProvider } from "../../src/knowledge/interface.js";

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
  markerProbeError: Error | null = null;

  findByIdempotencyKey(): Promise<NotionApiDocument | null> {
    if (this.markerProbeError) {
      return Promise.reject(this.markerProbeError);
    }

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

  listChanges(): Promise<{ documents: NotionApiDocument[]; nextCursor: string | null }> {
    return Promise.resolve({ documents: [], nextCursor: null });
  }
}

describe("Notion KnowledgeProvider", () => {
  it("does not expose a generic whole-page update capability", () => {
    expectTypeOf<KnowledgeProvider>().not.toHaveProperty("updateDocument");
    expectTypeOf<NotionApi>().not.toHaveProperty("updateDocument");

    const provider = createNotionKnowledgeProvider({
      api: new FakeNotionApi(),
      meetingsDataSourceId: "meetings"
    });
    expect(provider).not.toHaveProperty("updateDocument");
  });

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

  it("fails closed when a marker probe cannot read complete Notion Markdown", async () => {
    const api = new FakeNotionApi();
    api.markerProbeError = new NotionKnowledgeProviderError(
      "notion-markdown-incomplete",
      "Notion page notion-page-1 returned incomplete Markdown"
    );
    const provider = createNotionKnowledgeProvider({
      api,
      meetingsDataSourceId: "meetings"
    });

    await expect(
      provider.createDocument({
        title: "Product Meeting",
        contentMarkdown: "Meeting record",
        parentId: null,
        idempotencyKey: "workspace:meeting:intent:execute"
      })
    ).rejects.toMatchObject({ code: "notion-markdown-incomplete" });
    expect(api.createCalls).toEqual([]);
  });

  it("rejects truncated or unknown Notion Markdown before it can prove a marker absent", () => {
    expect(() =>
      assertCompleteNotionMarkdown("notion-page-1", {
        truncated: true,
        unknown_block_ids: []
      })
    ).toThrow("cannot be used to prove a Luma execution marker is absent");
    expect(() =>
      assertCompleteNotionMarkdown("notion-page-1", {
        truncated: false,
        unknown_block_ids: ["restricted-block"]
      })
    ).toThrow("cannot be used to prove a Luma execution marker is absent");
  });
});
