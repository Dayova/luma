import { Client, isFullPage } from "@notionhq/client";
import type { CanonicalKnowledgePatchWriter } from "./canonical-knowledge-patch.js";
import { canonicalNotionObjectId } from "./notion-object-id.js";

/** Finite SDK seam for deterministic tests; production uses the pinned SDK. */
export type NotionCanonicalPatchTransport = {
  readPage(pageId: string): Promise<unknown>;
  readMarkdown(pageId: string): Promise<unknown>;
  replace(input: {
    pageId: string;
    oldMarkdown: string;
    newMarkdown: string;
  }): Promise<void>;
};

export function createNotionCanonicalKnowledgePatchWriter(input: {
  token: string;
  providerId: string;
  transport?: NotionCanonicalPatchTransport;
}): CanonicalKnowledgePatchWriter {
  const client = input.transport
    ? null
    : new Client({
        auth: input.token,
        notionVersion: "2026-03-11",
        timeoutMs: 5_000,
        retry: false,
        logger: () => undefined
      });
  const transport: NotionCanonicalPatchTransport = input.transport ?? {
    readPage: (pageId) => client!.pages.retrieve({ page_id: pageId }),
    readMarkdown: (pageId) => client!.pages.retrieveMarkdown({ page_id: pageId }),
    async replace({ pageId, oldMarkdown, newMarkdown }) {
      await client!.pages.updateMarkdown({
        page_id: pageId,
        type: "update_content",
        update_content: {
          content_updates: [
            { old_str: oldMarkdown, new_str: newMarkdown, replace_all_matches: false }
          ],
          allow_deleting_content: false
        }
      });
    }
  };
  function requireCanonicalId(id: string): void {
    if (canonicalNotionObjectId(id) !== id)
      throw new Error("Canonical Notion target ID is required");
  }
  return {
    providerId: input.providerId,
    async readComplete(externalId) {
      requireCanonicalId(externalId);
      const before = await transport.readPage(externalId);
      const markdown = await transport.readMarkdown(externalId);
      const after = await transport.readPage(externalId);
      if (
        !isReadablePage(before, externalId) ||
        !isReadablePage(after, externalId) ||
        before.last_edited_time !== after.last_edited_time ||
        !isCompleteMarkdown(markdown, externalId)
      ) {
        throw new Error(
          "Canonical Notion target could not be read completely and consistently"
        );
      }
      return {
        reference: {
          providerId: input.providerId,
          objectType: "document",
          externalId,
          url: after.url,
          version: after.last_edited_time
        },
        markdown: markdown.markdown
      };
    },
    async replaceExact({ externalId, expectedMarkdown, replacementMarkdown }) {
      requireCanonicalId(externalId);
      if (!expectedMarkdown.trim() || !replacementMarkdown.trim())
        throw new Error("Canonical regions must be nonempty");
      await transport.replace({
        pageId: externalId,
        oldMarkdown: expectedMarkdown,
        newMarkdown: replacementMarkdown
      });
    }
  };
}

function isReadablePage(
  value: unknown,
  id: string
): value is {
  last_edited_time: string;
  url: string;
} {
  return (
    isRecord(value) &&
    isFullPage(value as Parameters<typeof isFullPage>[0]) &&
    value["id"] === id &&
    value["archived"] === false &&
    value["in_trash"] === false &&
    typeof value["last_edited_time"] === "string" &&
    typeof value["url"] === "string"
  );
}
function isCompleteMarkdown(value: unknown, id: string): value is { markdown: string } {
  return (
    isRecord(value) &&
    value["id"] === id &&
    value["object"] === "page_markdown" &&
    value["truncated"] === false &&
    Array.isArray(value["unknown_block_ids"]) &&
    value["unknown_block_ids"].length === 0 &&
    typeof value["markdown"] === "string" &&
    Buffer.byteLength(value["markdown"], "utf8") <= 2_000_000
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
