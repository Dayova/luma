import type {
  MeetingNotesBlockObjectResponse,
  TranscriptionBlockObjectResponse
} from "@notionhq/client";
import { describe, expect, it } from "vitest";
import {
  createNotionMeetingNotesSource,
  createNotionMeetingNotesSourceFromEnv,
  NotionMeetingNotesReadError,
  normalizeNotionMeetingNotesBlock,
  type NotionMeetingNotesApi,
  type NotionMeetingNotesBlock
} from "../../src/knowledge/notion-meeting-notes-source.js";
import { createObservedSourceLedger } from "../../src/knowledge/observed-source-ledger.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";

function block(
  overrides: Partial<NotionMeetingNotesBlock> &
    Pick<NotionMeetingNotesBlock, "id" | "type">
): NotionMeetingNotesBlock {
  return {
    text: null,
    checked: null,
    hasChildren: false,
    ...overrides
  };
}

class FakeNotionMeetingNotesApi implements NotionMeetingNotesApi {
  readonly dataSourceCalls: Array<{
    dataSourceId: string;
    cursor?: string;
    limit: number;
  }> = [];
  readonly markdownCalls: Array<{ pageId: string; includeTranscript: boolean }> = [];

  listDataSourcePages(input: {
    dataSourceId: string;
    cursor?: string;
    limit: number;
  }): Promise<{
    pages: Array<{
      id: string;
      title: string | null;
      url: string;
      lastEditedAt: string | null;
    }>;
    nextCursor: string | null;
    incomplete: boolean;
  }> {
    this.dataSourceCalls.push(input);
    return Promise.resolve({
      pages: [
        {
          id: "meeting-page-1",
          title: "Product sync",
          url: "https://notion.so/meeting-page-1",
          lastEditedAt: "2026-08-07T08:31:00.000Z"
        },
        {
          id: "ordinary-page",
          title: "Ordinary knowledge",
          url: "https://notion.so/ordinary-page",
          lastEditedAt: "2026-08-07T08:31:00.000Z"
        }
      ],
      nextCursor: "next-page",
      incomplete: false
    });
  }

  listBlockChildren(input: {
    blockId: string;
    cursor?: string;
  }): Promise<{ blocks: NotionMeetingNotesBlock[]; nextCursor: string | null }> {
    const blocksByCursor: Record<
      string,
      { blocks: NotionMeetingNotesBlock[]; nextCursor: string | null }
    > = {
      "meeting-page-1:first": {
        blocks: [
          block({
            id: "meeting-notes-block-1",
            type: "meeting-notes",
            hasChildren: true,
            meetingNotes: {
              title: "Product sync",
              status: "notes_ready",
              summaryBlockId: "summary-block",
              notesBlockId: "notes-block",
              transcriptBlockId: "transcript-block",
              calendar: {
                startAt: "2026-08-07T08:00:00.000Z",
                endAt: "2026-08-07T08:30:00.000Z",
                attendeeProviderUserIds: ["notion-user-jakob"]
              },
              recording: null
            }
          })
        ],
        nextCursor: null
      },
      "ordinary-page:first": {
        blocks: [
          block({ id: "ordinary-paragraph", type: "paragraph", text: "No meeting here." })
        ],
        nextCursor: null
      },
      "summary-block:first": {
        blocks: [
          block({
            id: "summary-text",
            type: "paragraph",
            text: "Ship the proof this week."
          })
        ],
        nextCursor: null
      },
      "notes-block:first": {
        blocks: [
          block({
            id: "action-item",
            type: "to-do",
            text: "Jakob prüft die Notion Quelle.",
            checked: false
          })
        ],
        nextCursor: null
      },
      "transcript-block:first": {
        blocks: [
          block({
            id: "transcript-first",
            type: "paragraph",
            text: "Wir prüfen die Quelle",
            hasChildren: true
          })
        ],
        nextCursor: "transcript-cursor"
      },
      "transcript-block:transcript-cursor": {
        blocks: [
          block({
            id: "transcript-second",
            type: "paragraph",
            text: "before we create work."
          })
        ],
        nextCursor: null
      },
      "transcript-first:first": {
        blocks: [
          block({
            id: "transcript-child",
            type: "paragraph",
            text: "Die Evidence bleibt original."
          })
        ],
        nextCursor: null
      }
    };
    const result = blocksByCursor[`${input.blockId}:${input.cursor ?? "first"}`];

    if (!result) {
      throw new Error(
        `Unexpected block read: ${input.blockId}:${input.cursor ?? "first"}`
      );
    }

    return Promise.resolve(result);
  }

  retrievePageMarkdown(input: {
    pageId: string;
    includeTranscript: boolean;
  }): Promise<{ content: string; truncated: boolean; unknownBlockIds: string[] }> {
    this.markdownCalls.push(input);
    return Promise.resolve({
      content: "# Product sync\n\nWir prüfen die Quelle before we create work.",
      truncated: false,
      unknownBlockIds: []
    });
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function sdkMeetingNotesBlock(
  type: "meeting_notes" | "transcription"
): MeetingNotesBlockObjectResponse | TranscriptionBlockObjectResponse {
  const common = {
    parent: { type: "page_id" as const, page_id: "meeting-page-1" },
    object: "block" as const,
    id: `${type}-block`,
    created_time: "2026-08-07T08:00:00.000Z",
    created_by: { object: "user" as const, id: "notion-user-jakob" },
    last_edited_time: "2026-08-07T08:31:00.000Z",
    last_edited_by: { object: "user" as const, id: "notion-user-jakob" },
    has_children: true,
    in_trash: false,
    archived: false
  };
  const metadata = {
    title: [],
    status: "notes_ready" as const,
    children: {
      summary_block_id: "summary-block",
      notes_block_id: "notes-block",
      transcript_block_id: "transcript-block"
    },
    calendar_event: {
      start_time: "2026-08-07T08:00:00.000Z",
      end_time: "2026-08-07T08:30:00.000Z",
      attendees: ["notion-user-jakob"]
    },
    recording: {
      start_time: "2026-08-07T08:00:00.000Z",
      end_time: "2026-08-07T08:30:00.000Z"
    }
  };

  return type === "meeting_notes"
    ? { ...common, type, meeting_notes: metadata }
    : { ...common, type, transcription: metadata };
}

describe("Notion Meeting Notes source", () => {
  it("normalizes both current and legacy Notion Meeting Notes block variants", () => {
    const current = normalizeNotionMeetingNotesBlock(
      sdkMeetingNotesBlock("meeting_notes")
    );
    const legacy = normalizeNotionMeetingNotesBlock(
      sdkMeetingNotesBlock("transcription")
    );

    expect(current).toMatchObject({
      id: "meeting_notes-block",
      type: "meeting-notes",
      meetingNotes: {
        status: "notes_ready",
        summaryBlockId: "summary-block",
        notesBlockId: "notes-block",
        transcriptBlockId: "transcript-block",
        calendar: { attendeeProviderUserIds: ["notion-user-jakob"] }
      }
    });
    expect(legacy).toMatchObject({
      id: "transcription-block",
      type: "transcription",
      meetingNotes: { status: "notes_ready" }
    });
  });

  it("requires the standard Notion source configuration when built from environment", async () => {
    const database = await createPgliteDatabase();

    try {
      expect(() =>
        createNotionMeetingNotesSourceFromEnv({
          ledger: createObservedSourceLedger({ database }),
          env: {}
        })
      ).toThrow("NOTION_API_TOKEN is required");
    } finally {
      await database.close();
    }
  });

  it("scans the canonical data source and records a complete raw Meeting Note revision", async () => {
    const database = await createPgliteDatabase();
    const api = new FakeNotionMeetingNotesApi();
    const source = createNotionMeetingNotesSource({
      api,
      ledger: createObservedSourceLedger({ database }),
      meetingsDataSourceId: "dayova-meetings"
    });

    try {
      const scan = await source.scan({ workspaceId: "workspace_dayova", limit: 25 });

      expect(api.dataSourceCalls).toEqual([
        { dataSourceId: "dayova-meetings", limit: 25 }
      ]);
      expect(api.markdownCalls).toEqual([
        { pageId: "meeting-page-1", includeTranscript: true }
      ]);
      expect(scan.nextCursor).toBe("next-page");
      expect(scan.completeness).toBe("partial");
      expect(scan.partialReasons).toContainEqual(
        expect.objectContaining({ code: "pagination-pending" })
      );
      expect(scan.records).toHaveLength(1);
      expect(scan.records[0]).toMatchObject({
        change: "new",
        revision: 1,
        source: {
          providerId: "notion",
          sourceKind: "meeting-note",
          sourceObjectId: "meeting-notes-block-1",
          parentObjectId: "meeting-page-1"
        },
        snapshot: {
          title: "Product sync",
          lifecycle: "ready",
          sections: {
            summary: {
              state: "available",
              text: "Ship the proof this week."
            },
            actionItemsAndNotes: {
              state: "available",
              text: "Jakob prüft die Notion Quelle."
            },
            transcript: {
              state: "available",
              text: [
                "Wir prüfen die Quelle",
                "Die Evidence bleibt original.",
                "before we create work."
              ].join("\n")
            }
          },
          completeness: { state: "complete" }
        }
      });
    } finally {
      await database.close();
    }
  });

  it("records missing transcript and unresolved Markdown content as a partial source revision", async () => {
    const database = await createPgliteDatabase();
    const baseApi = new FakeNotionMeetingNotesApi();
    const api: NotionMeetingNotesApi = {
      listDataSourcePages: (input) => baseApi.listDataSourcePages(input),
      async listBlockChildren(input) {
        const result = await baseApi.listBlockChildren(input);

        if (input.blockId !== "meeting-page-1") {
          return result;
        }

        return {
          ...result,
          blocks: result.blocks.map((entry) => {
            if (entry.id !== "meeting-notes-block-1" || !entry.meetingNotes) {
              return entry;
            }

            return {
              ...entry,
              meetingNotes: { ...entry.meetingNotes, transcriptBlockId: null }
            };
          })
        };
      },
      async retrievePageMarkdown(input) {
        const markdown = await baseApi.retrievePageMarkdown(input);
        return { ...markdown, truncated: true, unknownBlockIds: ["restricted-block"] };
      }
    };
    const source = createNotionMeetingNotesSource({
      api,
      ledger: createObservedSourceLedger({ database }),
      meetingsDataSourceId: "dayova-meetings"
    });

    try {
      const scan = await source.scan({ workspaceId: "workspace_dayova" });
      const record = scan.records[0];

      expect(record).toBeDefined();

      if (!record) {
        throw new Error("Expected the Meeting Note to be recorded");
      }

      expect(record.snapshot.sections.transcript).toMatchObject({
        state: "unavailable",
        sourceBlockId: null
      });
      expect(record.snapshot.completeness.state).toBe("partial");

      if (record.snapshot.completeness.state !== "partial") {
        throw new Error("Expected a partial Meeting Note snapshot");
      }

      expect(record.snapshot.completeness.reasons.map((reason) => reason.code)).toEqual(
        expect.arrayContaining([
          "transcript-unavailable",
          "truncated-markdown",
          "unknown-blocks"
        ])
      );
      expect(scan.completeness).toBe("partial");
    } finally {
      await database.close();
    }
  });

  it("records a pending Meeting Note without fetching generated content", async () => {
    const database = await createPgliteDatabase();
    const baseApi = new FakeNotionMeetingNotesApi();
    const api: NotionMeetingNotesApi = {
      listDataSourcePages: (input) => baseApi.listDataSourcePages(input),
      async listBlockChildren(input) {
        const result = await baseApi.listBlockChildren(input);

        if (input.blockId !== "meeting-page-1") {
          return result;
        }

        return {
          ...result,
          blocks: result.blocks.map((entry) => {
            if (entry.id !== "meeting-notes-block-1" || !entry.meetingNotes) {
              return entry;
            }

            return {
              ...entry,
              meetingNotes: { ...entry.meetingNotes, status: "summary_in_progress" }
            };
          })
        };
      },
      retrievePageMarkdown: (input) => baseApi.retrievePageMarkdown(input)
    };
    const source = createNotionMeetingNotesSource({
      api,
      ledger: createObservedSourceLedger({ database }),
      meetingsDataSourceId: "dayova-meetings"
    });

    try {
      const scan = await source.scan({ workspaceId: "workspace_dayova" });
      const record = scan.records[0];

      expect(record).toBeDefined();

      if (!record) {
        throw new Error("Expected the pending Meeting Note to be recorded");
      }

      expect(baseApi.markdownCalls).toEqual([]);
      expect(record.snapshot).toMatchObject({
        lifecycle: "not-ready",
        completeness: {
          state: "not-ready",
          providerStatus: "summary_in_progress"
        }
      });
      expect(scan.completeness).toBe("partial");
    } finally {
      await database.close();
    }
  });

  it("records a missing Meeting Notes lifecycle as unknown rather than pending", async () => {
    const database = await createPgliteDatabase();
    const baseApi = new FakeNotionMeetingNotesApi();
    const api: NotionMeetingNotesApi = {
      listDataSourcePages: (input) => baseApi.listDataSourcePages(input),
      async listBlockChildren(input) {
        const result = await baseApi.listBlockChildren(input);

        if (input.blockId !== "meeting-page-1") {
          return result;
        }

        return {
          ...result,
          blocks: result.blocks.map((entry) => {
            if (entry.id !== "meeting-notes-block-1" || !entry.meetingNotes) {
              return entry;
            }

            return {
              ...entry,
              meetingNotes: { ...entry.meetingNotes, status: null }
            };
          })
        };
      },
      retrievePageMarkdown: (input) => baseApi.retrievePageMarkdown(input)
    };
    const source = createNotionMeetingNotesSource({
      api,
      ledger: createObservedSourceLedger({ database }),
      meetingsDataSourceId: "dayova-meetings"
    });

    try {
      const scan = await source.scan({ workspaceId: "workspace_dayova" });
      const record = scan.records[0];

      expect(record).toBeDefined();

      if (!record || record.snapshot.completeness.state !== "partial") {
        throw new Error(
          "Expected an explicit partial snapshot for unknown lifecycle data"
        );
      }

      expect(baseApi.markdownCalls).toEqual([]);
      expect(record.snapshot.lifecycle).toBe("unknown");
      expect(record.snapshot.completeness.reasons.map((reason) => reason.code)).toContain(
        "unknown-provider-shape"
      );
    } finally {
      await database.close();
    }
  });

  it("records unreadable page Markdown as an explicit partial condition", async () => {
    const database = await createPgliteDatabase();
    const baseApi = new FakeNotionMeetingNotesApi();
    const api: NotionMeetingNotesApi = {
      listDataSourcePages: (input) => baseApi.listDataSourcePages(input),
      listBlockChildren: (input) => baseApi.listBlockChildren(input),
      retrievePageMarkdown: () =>
        Promise.reject(
          new NotionMeetingNotesReadError(
            "source-restricted",
            "Notion denied the Markdown request"
          )
        )
    };
    const source = createNotionMeetingNotesSource({
      api,
      ledger: createObservedSourceLedger({ database }),
      meetingsDataSourceId: "dayova-meetings"
    });

    try {
      const scan = await source.scan({ workspaceId: "workspace_dayova" });
      const record = scan.records[0];

      expect(record).toBeDefined();

      if (!record || record.snapshot.completeness.state !== "partial") {
        throw new Error("Expected an explicit partial Meeting Note snapshot");
      }

      expect(record.snapshot.completeness.reasons.map((reason) => reason.code)).toContain(
        "unreadable-markdown"
      );
      expect(record.snapshot.markdown.unknownBlockIds).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("marks unsupported section blocks as partial source content", async () => {
    const database = await createPgliteDatabase();
    const baseApi = new FakeNotionMeetingNotesApi();
    const api: NotionMeetingNotesApi = {
      listDataSourcePages: (input) => baseApi.listDataSourcePages(input),
      async listBlockChildren(input) {
        const result = await baseApi.listBlockChildren(input);

        if (input.blockId !== "transcript-block") {
          return result;
        }

        return {
          ...result,
          blocks: result.blocks.map((entry) => ({
            ...entry,
            type: "unsupported",
            text: null,
            hasChildren: false
          }))
        };
      },
      retrievePageMarkdown: (input) => baseApi.retrievePageMarkdown(input)
    };
    const source = createNotionMeetingNotesSource({
      api,
      ledger: createObservedSourceLedger({ database }),
      meetingsDataSourceId: "dayova-meetings"
    });

    try {
      const scan = await source.scan({ workspaceId: "workspace_dayova" });
      const record = scan.records[0];

      expect(record?.snapshot.completeness).toMatchObject({ state: "partial" });
      expect(record?.snapshot.completeness).not.toEqual({ state: "complete" });
      expect(scan.completeness).toBe("partial");
    } finally {
      await database.close();
    }
  });

  it("continues scanning readable pages when another source page is inaccessible", async () => {
    const database = await createPgliteDatabase();
    const baseApi = new FakeNotionMeetingNotesApi();
    const api: NotionMeetingNotesApi = {
      listDataSourcePages: (input) => baseApi.listDataSourcePages(input),
      listBlockChildren(input) {
        if (input.blockId === "ordinary-page") {
          return Promise.reject(
            new NotionMeetingNotesReadError("source-restricted", "Page is not shared")
          );
        }

        return baseApi.listBlockChildren(input);
      },
      retrievePageMarkdown: (input) => baseApi.retrievePageMarkdown(input)
    };
    const source = createNotionMeetingNotesSource({
      api,
      ledger: createObservedSourceLedger({ database }),
      meetingsDataSourceId: "dayova-meetings"
    });

    try {
      const scan = await source.scan({ workspaceId: "workspace_dayova" });

      expect(scan.records).toHaveLength(1);
      expect(scan.completeness).toBe("partial");
      expect(scan.partialReasons).toContainEqual(
        expect.objectContaining({
          code: "unreadable-page",
          pageId: "ordinary-page",
          retryable: false
        })
      );
    } finally {
      await database.close();
    }
  });

  it("does not persist a synthetic source revision after a transient Meeting Note read failure", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const baseApi = new FakeNotionMeetingNotesApi();
    const api: NotionMeetingNotesApi = {
      listDataSourcePages: (input) => baseApi.listDataSourcePages(input),
      listBlockChildren: (input) => baseApi.listBlockChildren(input),
      retrievePageMarkdown: () =>
        Promise.reject(
          new NotionMeetingNotesReadError("transient", "Notion is rate limited")
        )
    };
    const source = createNotionMeetingNotesSource({
      api,
      ledger,
      meetingsDataSourceId: "dayova-meetings"
    });
    const sourceIdentity = {
      providerId: "notion",
      sourceKind: "meeting-note" as const,
      sourceObjectId: "meeting-notes-block-1"
    };

    try {
      const scan = await source.scan({ workspaceId: "workspace_dayova" });

      expect(scan.records).toEqual([]);
      expect(scan.completeness).toBe("partial");
      expect(scan.partialReasons).toContainEqual(
        expect.objectContaining({
          code: "unreadable-meeting-note",
          sourceObjectId: "meeting-notes-block-1",
          retryable: true
        })
      );
      await expect(
        ledger.get({ workspaceId: "workspace_dayova", source: sourceIdentity })
      ).resolves.toBeNull();
    } finally {
      await database.close();
    }
  });

  it("marks a provider-reported incomplete data source page as partial coverage", async () => {
    const database = await createPgliteDatabase();
    const baseApi = new FakeNotionMeetingNotesApi();
    const api: NotionMeetingNotesApi = {
      async listDataSourcePages(input) {
        const result = await baseApi.listDataSourcePages(input);
        return { ...result, nextCursor: null, incomplete: true };
      },
      listBlockChildren: (input) => baseApi.listBlockChildren(input),
      retrievePageMarkdown: (input) => baseApi.retrievePageMarkdown(input)
    };
    const source = createNotionMeetingNotesSource({
      api,
      ledger: createObservedSourceLedger({ database }),
      meetingsDataSourceId: "dayova-meetings"
    });

    try {
      const scan = await source.scan({ workspaceId: "workspace_dayova" });

      expect(scan.completeness).toBe("partial");
      expect(scan.partialReasons).toEqual([
        expect.objectContaining({
          code: "source-enumeration-incomplete",
          retryable: false
        })
      ]);
    } finally {
      await database.close();
    }
  });

  it("records exactly one next source revision when a transcript changes", async () => {
    const database = await createPgliteDatabase();
    const baseApi = new FakeNotionMeetingNotesApi();
    let transcript = "Wir prüfen die Quelle";
    const api: NotionMeetingNotesApi = {
      listDataSourcePages: (input) => baseApi.listDataSourcePages(input),
      async listBlockChildren(input) {
        const result = await baseApi.listBlockChildren(input);

        if (input.blockId !== "transcript-block") {
          return result;
        }

        return {
          ...result,
          blocks: result.blocks.map((entry) => ({ ...entry, text: transcript }))
        };
      },
      retrievePageMarkdown: (input) => baseApi.retrievePageMarkdown(input)
    };
    const source = createNotionMeetingNotesSource({
      api,
      ledger: createObservedSourceLedger({ database }),
      meetingsDataSourceId: "dayova-meetings"
    });

    try {
      const first = await source.scan({ workspaceId: "workspace_dayova" });
      transcript = "Wir prüfen die kanonische Quelle.";
      const changed = await source.scan({ workspaceId: "workspace_dayova" });
      const retried = await source.scan({ workspaceId: "workspace_dayova" });

      expect(first.records[0]).toMatchObject({ change: "new", revision: 1 });
      expect(changed.records[0]).toMatchObject({ change: "revised", revision: 2 });
      expect(retried.records[0]).toMatchObject({ change: "unchanged", revision: 2 });
    } finally {
      await database.close();
    }
  });

  it("keeps a partial snapshot idempotent when section responses settle in another order", async () => {
    const database = await createPgliteDatabase();
    const baseApi = new FakeNotionMeetingNotesApi();
    let summaryDelay = 20;
    let notesDelay = 1;
    const api: NotionMeetingNotesApi = {
      listDataSourcePages: (input) => baseApi.listDataSourcePages(input),
      async listBlockChildren(input) {
        if (input.blockId === "summary-block") {
          await wait(summaryDelay);
          throw new NotionMeetingNotesReadError(
            "source-restricted",
            "Summary is inaccessible"
          );
        }

        if (input.blockId === "notes-block") {
          await wait(notesDelay);
          throw new NotionMeetingNotesReadError(
            "source-restricted",
            "Notes are inaccessible"
          );
        }

        return baseApi.listBlockChildren(input);
      },
      retrievePageMarkdown: (input) => baseApi.retrievePageMarkdown(input)
    };
    const source = createNotionMeetingNotesSource({
      api,
      ledger: createObservedSourceLedger({ database }),
      meetingsDataSourceId: "dayova-meetings"
    });

    try {
      const first = await source.scan({ workspaceId: "workspace_dayova" });
      summaryDelay = 1;
      notesDelay = 20;
      const second = await source.scan({ workspaceId: "workspace_dayova" });

      expect(first.records[0]).toMatchObject({ change: "new", revision: 1 });
      expect(second.records[0]).toMatchObject({ change: "unchanged", revision: 1 });
      expect(second.records[0]?.contentHash).toBe(first.records[0]?.contentHash);
    } finally {
      await database.close();
    }
  });
});
