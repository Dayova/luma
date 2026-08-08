import { describe, expect, it } from "vitest";
import type { ExternalReference } from "../../src/domain/model.js";
import {
  createNotionOperationalOutcomeWriter,
  type NotionOperationalOutcomeApi
} from "../../src/knowledge/notion-operational-outcome-writer.js";
import { renderOperationalOutcomeMarkdown } from "../../src/knowledge/operational-outcome-markdown.js";
import type {
  OperationalOutcome,
  OperationalOutcomeTarget
} from "../../src/knowledge/operational-outcome-writer.js";

class FakeNotionOperationalOutcomeApi implements NotionOperationalOutcomeApi {
  readonly retrieveCalls: Array<{ pageId: string; includeTranscript: boolean }> = [];
  readonly insertCalls: Array<{ pageId: string; content: string }> = [];
  readonly updateCalls: Array<{
    pageId: string;
    oldContent: string;
    newContent: string;
  }> = [];
  truncated = false;
  unknownBlockIds: string[] = [];
  failNextInsertAfterApply = false;
  content: string;

  constructor(content: string) {
    this.content = content;
  }

  retrievePageMarkdown(input: { pageId: string; includeTranscript: boolean }): Promise<{
    content: string;
    truncated: boolean;
    unknownBlockIds: string[];
  }> {
    this.retrieveCalls.push(input);
    return Promise.resolve({
      content: this.content,
      truncated: this.truncated,
      unknownBlockIds: this.unknownBlockIds
    });
  }

  insertPageMarkdown(input: { pageId: string; content: string }): Promise<void> {
    this.insertCalls.push(input);
    this.content += input.content;

    if (this.failNextInsertAfterApply) {
      this.failNextInsertAfterApply = false;
      return Promise.reject(
        new Error("Notion response was lost after applying the insert")
      );
    }

    return Promise.resolve();
  }

  updatePageMarkdown(input: {
    pageId: string;
    oldContent: string;
    newContent: string;
  }): Promise<void> {
    this.updateCalls.push(input);
    const position = this.content.indexOf(input.oldContent);

    if (position < 0) {
      return Promise.reject(new Error("Notion could not find the exact owned content"));
    }

    this.content = `${this.content.slice(0, position)}${input.newContent}${this.content.slice(
      position + input.oldContent.length
    )}`;
    return Promise.resolve();
  }
}

const target: OperationalOutcomeTarget = {
  workspaceId: "workspace_dayova",
  providerId: "notion",
  page: {
    providerId: "notion",
    objectType: "document",
    externalId: "notion-page-product-sync",
    url: "https://notion.so/notion-page-product-sync",
    version: "2026-08-08T09:00:00.000Z"
  },
  sourceObjectId: "notion-page-product-sync",
  sourceRevision: 4,
  sourceContentHash: "source-content-hash"
};

function outcome(
  rationale = "The owner needs to clarify the deadline."
): OperationalOutcome {
  return {
    formatVersion: 1,
    operationToken: "operation-token:notion-writer-test",
    scope: {
      workspaceId: target.workspaceId,
      providerId: target.providerId,
      pageExternalId: target.page.externalId
    },
    entries: [
      {
        settlementIntentId: "follow-up:intent:operational-outcome",
        source: {
          sourceObjectId: target.sourceObjectId,
          sourceRevision: target.sourceRevision,
          sourceContentHash: target.sourceContentHash
        },
        resolution: { type: "needs-clarification", rationale },
        workReferences: [workReference()],
        knowledgeReferences: [],
        githubReferences: [],
        unresolved: [rationale]
      }
    ]
  };
}

function workReference(): ExternalReference {
  return {
    providerId: "linear",
    objectType: "work-item",
    externalId: "LUM-8",
    url: "https://linear.app/dayova/issue/LUM-8",
    version: "2026-08-08T08:30:00.000Z"
  };
}

const idempotencyKey = '["workspace_dayova","meeting:product","intent:outcome"]';

describe("Notion Operational Outcome writer", () => {
  it("appends one owned section without changing original Meeting Note Markdown", async () => {
    const originalMarkdown = [
      "# Product sync",
      "",
      "## Notes",
      "The original German-English evidence stays untouched."
    ].join("\n");
    const api = new FakeNotionOperationalOutcomeApi(originalMarkdown);
    const writer = createNotionOperationalOutcomeWriter({ api });
    const expected = renderOperationalOutcomeMarkdown({
      outcome: outcome(),
      idempotencyKey
    });

    const receipt = await writer.upsert({ target, outcome: outcome(), idempotencyKey });

    expect(receipt).toEqual({
      externalReference: target.page,
      status: "inserted",
      payloadDigest: expected.payloadDigest,
      contentDigest: expected.contentDigest,
      operationDigest: expected.operationDigest
    });
    expect(api.retrieveCalls).toEqual([
      { pageId: target.page.externalId, includeTranscript: false }
    ]);
    expect(api.insertCalls).toEqual([
      { pageId: target.page.externalId, content: `\n\n${expected.section}` }
    ]);
    expect(api.updateCalls).toEqual([]);
    expect(api.content).toBe(`${originalMarkdown}\n\n${expected.section}`);
  });

  it("replaces only the exact valid owned section and preserves Markdown on both sides", async () => {
    const oldOutcome = outcome("Confirm whether this belongs in the release plan.");
    const oldRendered = renderOperationalOutcomeMarkdown({
      outcome: oldOutcome,
      idempotencyKey
    });
    const nextOutcome = outcome("Jakob confirmed the deadline is Friday.");
    const nextRendered = renderOperationalOutcomeMarkdown({
      outcome: nextOutcome,
      idempotencyKey
    });
    const prefix = "# Product sync\n\nOriginal evidence before Luma.";
    const suffix = "\n\n## Human notes\nNever alter this paragraph.";
    const api = new FakeNotionOperationalOutcomeApi(
      `${prefix}\n\n${oldRendered.section}${suffix}`
    );
    const writer = createNotionOperationalOutcomeWriter({
      api,
      markerVerifier: {
        isOwned: (marker) =>
          Promise.resolve(
            marker.workspaceId === target.workspaceId &&
              marker.providerId === target.providerId &&
              marker.pageExternalId === target.page.externalId &&
              marker.payloadDigest === oldRendered.payloadDigest &&
              marker.contentDigest === oldRendered.contentDigest &&
              marker.operationDigest === oldRendered.operationDigest
          )
      }
    });

    const receipt = await writer.upsert({
      target,
      outcome: nextOutcome,
      idempotencyKey
    });

    expect(receipt).toEqual({
      externalReference: target.page,
      status: "replaced",
      payloadDigest: nextRendered.payloadDigest,
      contentDigest: nextRendered.contentDigest,
      operationDigest: nextRendered.operationDigest
    });
    expect(api.insertCalls).toEqual([]);
    expect(api.updateCalls).toEqual([
      {
        pageId: target.page.externalId,
        oldContent: `\n\n${oldRendered.section}`,
        newContent: `\n\n${nextRendered.section}`
      }
    ]);
    expect(api.content).toBe(`${prefix}\n\n${nextRendered.section}${suffix}`);
  });

  it("fails closed without a mutation when the page Markdown is incomplete or the owned marker is untrusted", async () => {
    const rendered = renderOperationalOutcomeMarkdown({
      outcome: outcome(),
      idempotencyKey
    });
    const cases: Array<{
      label: string;
      markdown: string;
      truncated?: boolean;
      unknownBlockIds?: string[];
    }> = [
      {
        label: "truncated",
        markdown: "# Product sync",
        truncated: true
      },
      {
        label: "unknown blocks",
        markdown: "# Product sync",
        unknownBlockIds: ["restricted-block"]
      },
      {
        label: "edited content digest",
        markdown: `# Product sync\n\n${rendered.section.replace(
          "### Resolution",
          "### Resolution edited by hand"
        )}`
      },
      {
        label: "duplicate section",
        markdown: `# Product sync\n\n${rendered.section}\n\n${rendered.section}`
      },
      {
        label: "checksum-valid but unowned exact future section",
        markdown: `# Product sync\n\n${rendered.section}`
      }
    ];

    for (const testCase of cases) {
      const api = new FakeNotionOperationalOutcomeApi(testCase.markdown);
      api.truncated = testCase.truncated ?? false;
      api.unknownBlockIds = testCase.unknownBlockIds ?? [];
      const writer = createNotionOperationalOutcomeWriter({ api });

      await expect(
        writer.upsert({ target, outcome: outcome(), idempotencyKey })
      ).rejects.toMatchObject({
        retryable: false
      });
      expect(api.insertCalls, testCase.label).toEqual([]);
      expect(api.updateCalls, testCase.label).toEqual([]);
    }
  });

  it("treats a lost write response as success only after rereading the exact expected section", async () => {
    const originalMarkdown = "# Product sync\n\nOriginal evidence.";
    const api = new FakeNotionOperationalOutcomeApi(originalMarkdown);
    api.failNextInsertAfterApply = true;
    const writer = createNotionOperationalOutcomeWriter({ api });
    const expected = renderOperationalOutcomeMarkdown({
      outcome: outcome(),
      idempotencyKey
    });

    const receipt = await writer.upsert({ target, outcome: outcome(), idempotencyKey });

    expect(receipt).toEqual({
      externalReference: target.page,
      status: "inserted",
      payloadDigest: expected.payloadDigest,
      contentDigest: expected.contentDigest,
      operationDigest: expected.operationDigest
    });
    expect(api.insertCalls).toHaveLength(1);
    expect(api.updateCalls).toEqual([]);
    expect(api.retrieveCalls).toEqual([
      { pageId: target.page.externalId, includeTranscript: false },
      { pageId: target.page.externalId, includeTranscript: false }
    ]);
    expect(api.content).toBe(`${originalMarkdown}\n\n${expected.section}`);
  });
});
