import { describe, expect, it } from "vitest";
import { createNotionKnowledgeProviderFromEnv } from "../../src/knowledge/notion-knowledge-provider.js";

const liveNotionEnabled =
  process.env["LUMA_LIVE_NOTION_TESTS"] === "1" &&
  Boolean(process.env["NOTION_API_TOKEN"]) &&
  Boolean(process.env["NOTION_MEETINGS_DATA_SOURCE_ID"]);

describe.skipIf(!liveNotionEnabled)("Notion KnowledgeProvider live integration", () => {
  it("can read the configured Meetings data source without mutating it", async () => {
    const provider = createNotionKnowledgeProviderFromEnv();
    const page = await provider.listChanges();

    expect(Array.isArray(page.changes)).toBe(true);
    expect(page.changes[0]?.providerId ?? provider.providerId).toBe(provider.providerId);
  });
});
