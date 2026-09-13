import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => vi.unstubAllGlobals());
import {
  createNotionCanonicalKnowledgePatchWriter,
  type NotionCanonicalPatchTransport
} from "../../src/knowledge/notion-canonical-knowledge-patch-writer.js";

const pageId = "1c2dd0f2-bad4-42f9-806e-932393a20109";
function transportFixture() {
  const page = {
    object: "page",
    id: pageId,
    properties: {},
    archived: false,
    in_trash: false,
    last_edited_time: "2026-09-11T00:00:00.000Z",
    url: `https://notion.so/${pageId}`
  };
  const markdown = {
    object: "page_markdown",
    id: pageId,
    markdown: "## Policy\nCurrent text.",
    truncated: false,
    unknown_block_ids: [] as string[]
  };
  const writes: Parameters<NotionCanonicalPatchTransport["replace"]>[0][] = [];
  let reads = 0;
  const transport: NotionCanonicalPatchTransport = {
    readPage: () => {
      reads++;
      return Promise.resolve(structuredClone(page));
    },
    readMarkdown: () => Promise.resolve(structuredClone(markdown)),
    replace: (input) => {
      writes.push(input);
      return Promise.resolve();
    }
  };
  const writer = createNotionCanonicalKnowledgePatchWriter({
    token: "unused-test-token",
    providerId: "notion",
    transport
  });
  return { page, markdown, writes, transport, writer, reads: () => reads };
}
describe("canonical Notion patch capability", () => {
  it("uses the real SDK exact-update wire contract with deletion and multiple matches disabled", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", (url: string | URL, init: RequestInit) => {
      requests.push({ url: String(url), init });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            object: "page_markdown",
            id: pageId,
            markdown: "Approved text.",
            truncated: false,
            unknown_block_ids: []
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    });
    const writer = createNotionCanonicalKnowledgePatchWriter({
      token: "test-only-token",
      providerId: "notion"
    });
    await writer.replaceExact({
      externalId: pageId,
      expectedMarkdown: "Old text.",
      replacementMarkdown: "Approved text."
    });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe(`https://api.notion.com/v1/pages/${pageId}/markdown`);
    expect(request.init.method?.toLowerCase()).toBe("patch");
    expect(new Headers(request.init.headers).get("notion-version")).toBe("2026-03-11");
    if (typeof request.init.body !== "string")
      throw new Error("Expected serialized JSON request");
    expect(JSON.parse(request.init.body)).toEqual({
      type: "update_content",
      update_content: {
        content_updates: [
          { old_str: "Old text.", new_str: "Approved text.", replace_all_matches: false }
        ],
        allow_deleting_content: false
      }
    });
  });

  it("reads one complete stable canonical document and submits only its exact region", async () => {
    const h = transportFixture();
    expect(await h.writer.readComplete(pageId)).toMatchObject({
      markdown: h.markdown.markdown,
      reference: { externalId: pageId }
    });
    await h.writer.replaceExact({
      externalId: pageId,
      expectedMarkdown: "Current text.",
      replacementMarkdown: "Approved text."
    });
    expect(h.writes).toEqual([
      { pageId, oldMarkdown: "Current text.", newMarkdown: "Approved text." }
    ]);
  });
  it.each([
    "truncated",
    "unknown-block",
    "wrong-page",
    "archived",
    "partial-page",
    "changed-page"
  ])("refuses a %s read as complete evidence", async (mode) => {
    const h = transportFixture();
    if (mode === "truncated") h.markdown.truncated = true;
    if (mode === "unknown-block") h.markdown.unknown_block_ids.push("unread-block");
    if (mode === "wrong-page") h.markdown.id = "different";
    if (mode === "archived") h.page.archived = true;
    if (mode === "partial-page") h.page.object = "block";
    if (mode === "changed-page")
      h.transport.readMarkdown = () => {
        h.page.last_edited_time = "2026-09-11T01:00:00.000Z";
        return Promise.resolve(h.markdown);
      };
    await expect(h.writer.readComplete(pageId)).rejects.toThrow(
      "completely and consistently"
    );
    expect(h.writes).toEqual([]);
  });
  it.each([
    pageId.toUpperCase(),
    pageId.replaceAll("-", ""),
    "../other-page",
    "not-a-page"
  ])("requires a canonical page identity before reads or writes (%s)", async (id) => {
    const h = transportFixture();
    await expect(h.writer.readComplete(id)).rejects.toThrow("Canonical Notion target ID");
    await expect(
      h.writer.replaceExact({
        externalId: id,
        expectedMarkdown: "old",
        replacementMarkdown: "new"
      })
    ).rejects.toThrow("Canonical Notion target ID");
    expect(h.reads()).toBe(0);
    expect(h.writes).toEqual([]);
  });
});
