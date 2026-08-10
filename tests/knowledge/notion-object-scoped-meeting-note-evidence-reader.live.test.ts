import { describe, expect, it } from "vitest";
import { createNotionObjectScopedMeetingNoteEvidenceReader } from "../../src/knowledge/notion-object-scoped-meeting-note-evidence-reader.js";
import { createNotionObjectScopedMeetingNoteEvidenceSource } from "../../src/knowledge/notion-object-scoped-meeting-note-evidence-source.js";

const liveExactPageReaderEnabled =
  process.env["LUMA_LIVE_NATIVE_NOTION_READONLY_TESTS"] === "1" &&
  Boolean(process.env["LUMA_NATIVE_NOTION_READONLY_API_TOKEN"]?.trim()) &&
  Boolean(process.env["LUMA_NATIVE_NOTION_PAGE_ID"]?.trim());

describe.skipIf(!liveExactPageReaderEnabled)(
  "Notion exact-page reader live integration",
  () => {
    it("captures one configured Meeting Note without mutation or source enumeration", async () => {
      const pageId = process.env["LUMA_NATIVE_NOTION_PAGE_ID"]?.trim();
      const readOnlyApiToken =
        process.env["LUMA_NATIVE_NOTION_READONLY_API_TOKEN"]?.trim();

      if (!pageId || !readOnlyApiToken) {
        throw new Error(
          "The opt-in native Notion live test requires its exact read-only inputs"
        );
      }

      const reader = createNotionObjectScopedMeetingNoteEvidenceReader({
        pageId,
        readOnlyApiToken
      });
      const source = createNotionObjectScopedMeetingNoteEvidenceSource({
        workspaceId: "workspace_dayova",
        providerId: "notion",
        pageId,
        reader
      });

      await expect(
        source.capture({
          workspaceId: "workspace_dayova",
          page: { providerId: "notion", pageId }
        })
      ).resolves.toMatchObject({
        status: "captured",
        evidence: {
          source: {
            providerId: "notion",
            parentObjectId: pageId,
            sourceKind: "meeting-note"
          }
        }
      });
    }, 60_000);
  }
);
