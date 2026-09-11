import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNotionReadOnlyKnowledgeCatalogForTest,
  NotionKnowledgeReadError,
  type NotionKnowledgeTransportForTest
} from "../../src/knowledge/notion-read-only-knowledge-catalog.js";
import {
  createNotionContextCatalogFromEnv,
  createNotionContextCatalog,
  notionKnowledgeContextCatalog
} from "../../src/organizational-context/notion-context-catalog.js";
import type { ContextCatalogAuthorization } from "../../src/organizational-context/catalog-authorization.js";
import type { OrganizationalContextRequest } from "../../src/organizational-context/interface.js";
import { createOrganizationalContext } from "../../src/organizational-context/organizational-context.js";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";

const pageId = "3bc2e872-28bf-8193-9669-ec8c5a94aae3";
const anotherId = "3d52e872-28bf-80ae-befe-d1c0e2c39df5";
const audience = { workspaceId: "dayova", personIds: ["jakob", "fabius"] };
const request: OrganizationalContextRequest = {
  audience,
  subject: { type: "conversation", id: "thread" },
  purpose: "answer-question",
  concepts: ["Luma ownership"],
  time: { mode: "current" },
  limit: 10,
  maxCharacters: 8000
};
function page(id = pageId, changes: Record<string, unknown> = {}) {
  return {
    object: "page",
    id,
    archived: false,
    in_trash: false,
    url: `https://notion.so/${id}`,
    last_edited_time: "2026-09-10T10:00:00.000Z",
    properties: { Name: { type: "title", title: [{ plain_text: "Luma ownership" }] } },
    ...changes
  };
}
function markdown(changes: Record<string, unknown> = {}) {
  return {
    object: "page_markdown",
    id: pageId,
    markdown:
      "Jakob currently owns Luma. Final responsibilities remain under discussion.",
    truncated: false,
    unknown_block_ids: [],
    ...changes
  };
}
function setup() {
  let permitted = true;
  let head: unknown = page();
  let body: unknown = markdown();
  const calls: string[] = [];
  const grants: Parameters<ContextCatalogAuthorization>[0][] = [];
  const hooks: { page?: () => void; markdown?: () => void; authorize?: () => void } = {};
  const transport: NotionKnowledgeTransportForTest = {
    retrievePage(id) {
      calls.push(`page:${id}`);
      const value = head;
      hooks.page?.();
      return Promise.resolve(value);
    },
    retrieveMarkdown(id) {
      calls.push(`markdown:${id}`);
      const value = body;
      hooks.markdown?.();
      return Promise.resolve(value);
    }
  };
  const authorize: ContextCatalogAuthorization = (input) => {
    grants.push(input);
    hooks.authorize?.();
    return Promise.resolve(
      permitted && input.audience.personIds.every((id) => audience.personIds.includes(id))
    );
  };
  const config = {
    workspaceId: "dayova",
    credentialScopeId: "founder-pages-v1",
    pageIds: [pageId],
    readOnlyApiToken: "test-only-token",
    authorize
  };
  const knowledge = createNotionReadOnlyKnowledgeCatalogForTest(config, transport);
  return {
    config,
    transport,
    knowledge,
    catalog: notionKnowledgeContextCatalog(knowledge),
    calls,
    grants,
    hooks,
    setHead: (value: unknown) => {
      head = value;
    },
    setBody: (value: unknown) => {
      body = value;
    },
    revoke: () => {
      permitted = false;
    }
  };
}
const databases: LumaDatabase[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("audience-scoped Notion organizational context", () => {
  it("uses only installed SDK GET operations with full transcripts and the dedicated read credential", async () => {
    const urls: URL[] = [];
    const network = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      urls.push(url);
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("notion-version")).toBe("2026-03-11");
      expect(new Headers(init?.headers).has("authorization")).toBe(true);
      return Promise.resolve(
        new Response(
          JSON.stringify(url.pathname.endsWith("/markdown") ? markdown() : page()),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    });
    try {
      const catalog = createNotionContextCatalog(setup().config);
      expect((await catalog.read({ audience, sourceId: pageId }))?.content).toContain(
        "under discussion"
      );
      expect(urls.map((url) => url.pathname)).toEqual([
        `/v1/pages/${pageId}`,
        `/v1/pages/${pageId}/markdown`,
        `/v1/pages/${pageId}`
      ]);
      expect(urls[1]?.searchParams.get("include_transcript")).toBe("true");
      expect(urls.every((url) => url.origin === "https://api.notion.com")).toBe(true);
    } finally {
      network.mockRestore();
    }
  });

  it("reads the exact full page through a query-only KnowledgeCatalog and preserves tentative wording", async () => {
    const test = setup();
    expect(Object.keys(test.knowledge).sort()).toEqual([
      "id",
      "listDocumentIds",
      "readDocument"
    ]);
    expect(
      await test.catalog.search({ audience, concepts: ["ownership"], limit: 10 })
    ).toEqual({ sourceIds: [pageId], complete: true, warnings: [] });
    const source = await test.catalog.read({ audience, sourceId: pageId });
    expect(source).toMatchObject({
      id: pageId,
      title: "Luma ownership",
      authority: "source",
      standing: "current",
      content: markdown().markdown
    });
    expect(source?.version).toMatch(/^[0-9a-f]{64}$/u);
    expect(test.calls).toEqual([
      `page:${pageId}`,
      `markdown:${pageId}`,
      `page:${pageId}`
    ]);
    expect(
      test.grants.every(
        (grant) =>
          grant.credentialScopeId === "founder-pages-v1" &&
          grant.audience.workspaceId === "dayova" &&
          grant.source.provider === "notion" &&
          grant.source.pageId === pageId
      )
    ).toBe(true);
  });

  it("checks workspace, exact page and every recipient before any provider read", async () => {
    const test = setup();
    for (const input of [
      { audience: { ...audience, workspaceId: "other" }, sourceId: pageId },
      { audience: { ...audience, personIds: ["guest"] }, sourceId: pageId },
      { audience: { ...audience, personIds: [] }, sourceId: pageId },
      { audience, sourceId: anotherId },
      { audience, sourceId: "../search" }
    ])
      expect(await test.catalog.read(input)).toBeNull();
    expect(test.calls).toEqual([]);
    test.revoke();
    expect(
      (await test.catalog.search({ audience, concepts: ["Luma"], limit: 10 })).sourceIds
    ).toEqual([]);
  });

  it("keeps the original recipient set stable across caller or authorization-callback mutations", async () => {
    const test = setup();
    const original = { workspaceId: "dayova", personIds: ["jakob"] };
    const seen: string[][] = [];
    const catalog = notionKnowledgeContextCatalog(
      createNotionReadOnlyKnowledgeCatalogForTest(
        {
          ...test.config,
          authorize: (input) => {
            seen.push([...input.audience.personIds]);
            input.audience.personIds.push("callback-edit");
            return Promise.resolve(input.audience.personIds[0] === "jakob");
          }
        },
        test.transport
      )
    );
    test.hooks.page = () => {
      original.personIds[0] = "guest";
    };
    expect(await catalog.read({ audience: original, sourceId: pageId })).not.toBeNull();
    expect(seen).toEqual([["jakob"], ["jakob"], ["jakob"], ["jakob"]]);
    expect(original.personIds).toEqual(["guest"]);
  });

  it.each(["page", "markdown"] as const)(
    "rejects revocation during %s and performs no later read",
    async (stage) => {
      const test = setup();
      test.hooks[stage] = test.revoke;
      expect(await test.catalog.read({ audience, sourceId: pageId })).toBeNull();
      expect(test.calls).toHaveLength(stage === "page" ? 1 : 2);
    }
  );

  it("removes earlier discovery IDs if grants change during another page check", async () => {
    let permitted = true;
    const config = setup().config;
    const knowledge = createNotionReadOnlyKnowledgeCatalogForTest(
      {
        ...config,
        pageIds: [pageId, anotherId],
        authorize: (input) => {
          if (input.source.provider === "notion" && input.source.pageId === anotherId)
            permitted = false;
          return Promise.resolve(permitted);
        }
      },
      {
        retrievePage: () => Promise.resolve(page()),
        retrieveMarkdown: () => Promise.resolve(markdown())
      }
    );
    expect(
      (await knowledge.listDocumentIds({ audience, limit: 10 })).documentIds
    ).toEqual([]);
  });

  it.each([
    { archived: true },
    { in_trash: true },
    { object: "block" },
    { id: anotherId },
    { last_edited_time: "unverified" },
    { url: "javascript:alert(1)" },
    { url: "https://secret@example.com/page" }
  ])("refuses invalid or unavailable page metadata: %j", async (change) => {
    const test = setup();
    test.setHead(page(pageId, change));
    await expect(
      test.catalog.read({ audience, sourceId: pageId })
    ).rejects.toBeInstanceOf(NotionKnowledgeReadError);
    expect(test.calls).toHaveLength(1);
  });

  it.each([
    { truncated: true },
    { unknown_block_ids: [anotherId] },
    { id: anotherId },
    { markdown: '<unknown url="https://notion.so/private" />' },
    { markdown: "x".repeat(100_001) }
  ])("refuses partial, mismatched or oversized Markdown", async (change) => {
    const test = setup();
    test.setBody(markdown(change));
    await expect(
      test.catalog.read({ audience, sourceId: pageId })
    ).rejects.toBeInstanceOf(NotionKnowledgeReadError);
  });

  it("refuses a head change or trash action while Markdown is being read", async () => {
    for (const change of [
      { last_edited_time: "2026-09-10T11:00:00.000Z" },
      { in_trash: true }
    ]) {
      const test = setup();
      test.hooks.markdown = () => test.setHead(page(pageId, change));
      await expect(
        test.catalog.read({ audience, sourceId: pageId })
      ).rejects.toBeInstanceOf(NotionKnowledgeReadError);
    }
  });

  it("rereads after restart and invalidates a receipt when content changes without a timestamp change", async () => {
    const test = setup();
    const database = await createPgliteDatabase();
    databases.push(database);
    const context = createOrganizationalContext({ database, catalogs: [test.catalog] });
    const result = await context.retrieve(request);
    const restarted = notionKnowledgeContextCatalog(
      createNotionReadOnlyKnowledgeCatalogForTest(test.config, test.transport)
    );
    expect((await restarted.read({ audience, sourceId: pageId }))?.version).toBe(
      result.sources[0]?.version
    );
    test.setBody(markdown({ markdown: "Luma ownership is now disputed." }));
    await expect(
      createOrganizationalContext({ database, catalogs: [restarted] }).requireCurrent(
        request,
        result.receiptId
      )
    ).rejects.toThrow("no longer authorized");
  });

  it("sanitizes failures and never accepts a token or a narrowed writer as a sharing grant", async () => {
    const test = setup();
    test.hooks.page = () => {
      throw new Error("SECRET provider diagnostic");
    };
    await expect(test.catalog.read({ audience, sourceId: pageId })).rejects.toThrow(
      "Notion context could not be verified"
    );
    expect(() => notionKnowledgeContextCatalog({ ...test.knowledge })).toThrow(
      "issued read-only"
    );
    expect(() =>
      createNotionContextCatalogFromEnv({
        workspaceId: "dayova",
        authorize: test.config.authorize,
        env: { NOTION_API_TOKEN: "writer-secret" }
      })
    ).toThrow();
    expect(() =>
      createNotionReadOnlyKnowledgeCatalogForTest(
        { ...test.config, pageIds: [pageId, pageId.replaceAll("-", "")] },
        test.transport
      )
    ).toThrow();
  });
});
