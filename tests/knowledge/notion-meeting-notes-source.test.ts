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
import {
  createObservedSourceLedger,
  type ObservedSourceLedger
} from "../../src/knowledge/observed-source-ledger.js";
import { renderOperationalOutcomeMarkdown } from "../../src/knowledge/operational-outcome-markdown.js";
import type { OperationalOutcomeMarkerVerifier } from "../../src/knowledge/operational-outcome-writer.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";

const baseMeetingMarkdown =
  "# Product sync\n\nWir prüfen die Quelle before we create work.";

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
      content: baseMeetingMarkdown,
      truncated: false,
      unknownBlockIds: []
    });
  }
}

type OperationalOutcomeMarkerVerificationInput = Parameters<
  OperationalOutcomeMarkerVerifier["isOwned"]
>[0];

class FakeOperationalOutcomeMarkerVerifier implements OperationalOutcomeMarkerVerifier {
  readonly calls: OperationalOutcomeMarkerVerificationInput[] = [];

  constructor(
    private readonly behavior:
      boolean | Error | ((input: OperationalOutcomeMarkerVerificationInput) => boolean)
  ) {}

  isOwned(input: OperationalOutcomeMarkerVerificationInput): Promise<boolean> {
    this.calls.push(input);

    if (this.behavior instanceof Error) {
      return Promise.reject(this.behavior);
    }

    return Promise.resolve(
      typeof this.behavior === "function" ? this.behavior(input) : this.behavior
    );
  }
}

function renderedOperationalOutcome() {
  return renderOperationalOutcomeMarkdown({
    idempotencyKey: "workspace_dayova:meeting-1:settlement-1:outcome",
    outcome: {
      formatVersion: 1,
      operationToken: "test-operation-token:meeting-1:settlement-1",
      scope: {
        workspaceId: "workspace_dayova",
        providerId: "notion",
        pageExternalId: "meeting-page-1"
      },
      entries: [
        {
          settlementIntentId: "settlement-1",
          source: {
            sourceObjectId: "meeting-notes-block-1",
            sourceRevision: 1,
            sourceContentHash: "sha256:meeting-note-source"
          },
          resolution: {
            type: "needs-clarification",
            rationale: "Needs a decision from the accountable owner."
          },
          ownership: {
            status: "unresolved",
            reason: "no-owner-stated",
            likelyOwnerPersonId: null
          },
          workReferences: [],
          knowledgeReferences: [],
          githubReferences: [],
          unresolved: ["Confirm the delivery owner."]
        }
      ]
    }
  });
}

function emptyPaginatedApi(): NotionMeetingNotesApi {
  return {
    listDataSourcePages: (input) =>
      Promise.resolve(
        input.cursor
          ? { pages: [], nextCursor: null, incomplete: false }
          : { pages: [], nextCursor: "shared-cursor", incomplete: false }
      ),
    listBlockChildren: () => Promise.resolve({ blocks: [], nextCursor: null }),
    retrievePageMarkdown: () =>
      Promise.resolve({ content: "", truncated: false, unknownBlockIds: [] })
  };
}

const emptyObservedSourceLedger: ObservedSourceLedger = {
  record: () =>
    Promise.reject(new Error("The empty paginated API never records a source")),
  acquireExecutionFence: () => Promise.resolve({ status: "superseded", current: null }),
  verifyExecutionFenceHeldCurrent: () => Promise.resolve({ status: "not-held" }),
  releaseExecutionFence: () => Promise.resolve(),
  get: () => Promise.resolve(null),
  listCurrent: () => Promise.resolve([]),
  recordTombstone: () => Promise.resolve(null)
};

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

  it("does not mint a source revision when a valid Luma Operational Outcome section is written back", async () => {
    const database = await createPgliteDatabase();
    const baseApi = new FakeNotionMeetingNotesApi();
    const ledger = createObservedSourceLedger({ database });
    const rendered = renderedOperationalOutcome();
    const verifier = new FakeOperationalOutcomeMarkerVerifier(
      (input) =>
        input.workspaceId === "workspace_dayova" &&
        input.providerId === "notion" &&
        input.pageExternalId === "meeting-page-1" &&
        input.payloadDigest === rendered.payloadDigest &&
        input.contentDigest === rendered.contentDigest &&
        input.operationDigest === rendered.operationDigest
    );
    let markdown = baseMeetingMarkdown;
    const api: NotionMeetingNotesApi = {
      async listDataSourcePages(input) {
        return { ...(await baseApi.listDataSourcePages(input)), nextCursor: null };
      },
      listBlockChildren: (input) => baseApi.listBlockChildren(input),
      async retrievePageMarkdown(input) {
        return { ...(await baseApi.retrievePageMarkdown(input)), content: markdown };
      }
    };
    const source = createNotionMeetingNotesSource({
      api,
      ledger,
      meetingsDataSourceId: "dayova-meetings",
      operationalOutcomeMarkerVerifier: verifier
    });

    try {
      const first = await source.scan({ workspaceId: "workspace_dayova" });
      const original = first.records[0];

      if (!original) {
        throw new Error("expected an initial Meeting Note source revision");
      }

      markdown = `${baseMeetingMarkdown}\n\n${rendered.section}`;

      const afterOutcome = await source.scan({ workspaceId: "workspace_dayova" });
      const current = afterOutcome.records[0];

      expect(current).toMatchObject({
        change: "unchanged",
        revision: 1,
        contentHash: original.contentHash,
        snapshot: {
          markdown: { content: baseMeetingMarkdown },
          completeness: { state: "complete" }
        }
      });
      expect(current?.contentHash).toBe(original.contentHash);
      expect(verifier.calls).toEqual([
        {
          workspaceId: "workspace_dayova",
          providerId: "notion",
          pageExternalId: "meeting-page-1",
          payloadDigest: rendered.payloadDigest,
          contentDigest: rendered.contentDigest,
          operationDigest: rendered.operationDigest
        }
      ]);
    } finally {
      await database.close();
    }
  });

  it("fails closed for malformed, duplicate, or edited Luma Operational Outcome sections", async () => {
    const validSection = renderedOperationalOutcome().section;
    const unsafeMarkdownCases = [
      {
        label: "malformed marker",
        markdown: `${baseMeetingMarkdown}\n\n## Luma — Operational Outcome\n\n\`luma-operational-outcome:start:v1\``
      },
      {
        label: "duplicate owned section",
        markdown: `${baseMeetingMarkdown}\n\n${validSection}\n\n${validSection}`
      },
      {
        label: "edited owned section",
        markdown: `${baseMeetingMarkdown}\n\n${validSection.replace(
          "Needs a decision from the accountable owner.",
          "Tampered after Luma wrote it."
        )}`
      }
    ];

    for (const unsafeCase of unsafeMarkdownCases) {
      const database = await createPgliteDatabase();
      const baseApi = new FakeNotionMeetingNotesApi();
      const ledger = createObservedSourceLedger({ database });
      let markdown = baseMeetingMarkdown;
      const api: NotionMeetingNotesApi = {
        async listDataSourcePages(input) {
          return { ...(await baseApi.listDataSourcePages(input)), nextCursor: null };
        },
        listBlockChildren: (input) => baseApi.listBlockChildren(input),
        async retrievePageMarkdown(input) {
          return { ...(await baseApi.retrievePageMarkdown(input)), content: markdown };
        }
      };
      const source = createNotionMeetingNotesSource({
        api,
        ledger,
        meetingsDataSourceId: "dayova-meetings"
      });

      try {
        const seeded = await source.scan({ workspaceId: "workspace_dayova" });
        const original = seeded.records[0];

        if (!original) {
          throw new Error(`expected a seeded source for ${unsafeCase.label}`);
        }

        markdown = unsafeCase.markdown;

        const unsafeScan = await source.scan({ workspaceId: "workspace_dayova" });

        expect(unsafeScan.records).toEqual([]);
        expect(unsafeScan.completeness).toBe("partial");
        expect(unsafeScan.completeScan).toBeUndefined();
        expect(unsafeScan.partialReasons).toContainEqual(
          expect.objectContaining({
            code: "unreadable-meeting-note",
            sourceObjectId: original.source.sourceObjectId,
            retryable: false
          })
        );
        await expect(
          ledger.get({ workspaceId: "workspace_dayova", source: original.source })
        ).resolves.toMatchObject({ revision: 1, contentHash: original.contentHash });
      } finally {
        await database.close();
      }
    }
  });

  it("requires a matching durable ownership proof before stripping a valid Luma Operational Outcome section", async () => {
    const rendered = renderedOperationalOutcome();
    const expectedMarker: OperationalOutcomeMarkerVerificationInput = {
      workspaceId: "workspace_dayova",
      providerId: "notion",
      pageExternalId: "meeting-page-1",
      payloadDigest: rendered.payloadDigest,
      contentDigest: rendered.contentDigest,
      operationDigest: rendered.operationDigest
    };
    const unverifiedCases: Array<{
      label: string;
      verifier?: FakeOperationalOutcomeMarkerVerifier;
      retryable: boolean;
    }> = [
      { label: "no configured verifier", retryable: false },
      {
        label: "wrong workspace binding",
        verifier: new FakeOperationalOutcomeMarkerVerifier(
          (input) => input.workspaceId === "workspace_other"
        ),
        retryable: false
      },
      {
        label: "wrong provider binding",
        verifier: new FakeOperationalOutcomeMarkerVerifier(
          (input) => input.providerId === "linear"
        ),
        retryable: false
      },
      {
        label: "wrong page binding",
        verifier: new FakeOperationalOutcomeMarkerVerifier(
          (input) => input.pageExternalId === "another-page"
        ),
        retryable: false
      },
      {
        label: "wrong payload binding",
        verifier: new FakeOperationalOutcomeMarkerVerifier(
          (input) => input.payloadDigest === "f".repeat(64)
        ),
        retryable: false
      },
      {
        label: "wrong content binding",
        verifier: new FakeOperationalOutcomeMarkerVerifier(
          (input) => input.contentDigest === "e".repeat(64)
        ),
        retryable: false
      },
      {
        label: "wrong operation binding",
        verifier: new FakeOperationalOutcomeMarkerVerifier(
          (input) => input.operationDigest === "d".repeat(64)
        ),
        retryable: false
      },
      {
        label: "verification dependency rejection",
        verifier: new FakeOperationalOutcomeMarkerVerifier(
          new Error("durable verifier unavailable")
        ),
        retryable: true
      }
    ];

    for (const unverifiedCase of unverifiedCases) {
      const database = await createPgliteDatabase();
      const baseApi = new FakeNotionMeetingNotesApi();
      const ledger = createObservedSourceLedger({ database });
      let markdown = baseMeetingMarkdown;
      const api: NotionMeetingNotesApi = {
        async listDataSourcePages(input) {
          return { ...(await baseApi.listDataSourcePages(input)), nextCursor: null };
        },
        listBlockChildren: (input) => baseApi.listBlockChildren(input),
        async retrievePageMarkdown(input) {
          return { ...(await baseApi.retrievePageMarkdown(input)), content: markdown };
        }
      };
      const source = createNotionMeetingNotesSource({
        api,
        ledger,
        meetingsDataSourceId: "dayova-meetings",
        ...(unverifiedCase.verifier
          ? { operationalOutcomeMarkerVerifier: unverifiedCase.verifier }
          : {})
      });

      try {
        const seeded = await source.scan({ workspaceId: "workspace_dayova" });
        const original = seeded.records[0];

        if (!original) {
          throw new Error(`expected a seeded source for ${unverifiedCase.label}`);
        }

        markdown = `${baseMeetingMarkdown}\n\n${rendered.section}`;

        const unverifiedScan = await source.scan({ workspaceId: "workspace_dayova" });

        expect(unverifiedScan.records).toEqual([]);
        expect(unverifiedScan.completeness).toBe("partial");
        expect(unverifiedScan.completeScan).toBeUndefined();
        expect(unverifiedScan.partialReasons).toContainEqual(
          expect.objectContaining({
            code: "unreadable-meeting-note",
            sourceObjectId: original.source.sourceObjectId,
            retryable: unverifiedCase.retryable
          })
        );
        if (unverifiedCase.verifier) {
          expect(unverifiedCase.verifier.calls).toEqual([expectedMarker]);
        }
        await expect(
          ledger.get({ workspaceId: "workspace_dayova", source: original.source })
        ).resolves.toMatchObject({ revision: 1, contentHash: original.contentHash });
      } finally {
        await database.close();
      }
    }
  });

  it("turns a root absent from a completed canonical scan into an immutable tombstone", async () => {
    const database = await createPgliteDatabase();
    const baseApi = new FakeNotionMeetingNotesApi();
    let dataSourceReads = 0;
    const api: NotionMeetingNotesApi = {
      async listDataSourcePages(input) {
        dataSourceReads += 1;

        if (dataSourceReads > 1) {
          return { pages: [], nextCursor: null, incomplete: false };
        }

        return { ...(await baseApi.listDataSourcePages(input)), nextCursor: null };
      },
      listBlockChildren: (input) => baseApi.listBlockChildren(input),
      retrievePageMarkdown: (input) => baseApi.retrievePageMarkdown(input)
    };
    const ledger = createObservedSourceLedger({ database });
    const source = createNotionMeetingNotesSource({
      api,
      ledger,
      meetingsDataSourceId: "dayova-meetings",
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });

    try {
      const initial = await source.scan({ workspaceId: "workspace_dayova" });

      expect(initial.completeness).toBe("complete");
      expect(initial.completeScan).toBeDefined();

      const absent = await source.scan({ workspaceId: "workspace_dayova" });

      if (!absent.completeScan) {
        throw new Error("expected a completed scan capability");
      }

      const removed = await absent.completeScan.reconcileAbsent();

      expect(removed).toMatchObject({
        tombstones: [
          {
            change: "revised",
            revision: 2,
            source: { sourceObjectId: "meeting-notes-block-1" },
            snapshot: {
              lifecycle: "removed",
              completeness: { state: "removed" },
              sections: {
                actionItemsAndNotes: { state: "unavailable" }
              }
            }
          }
        ],
        partialReasons: []
      });
      await expect(absent.completeScan.reconcileAbsent()).rejects.toThrow("only once");

      const replay = await source.scan({ workspaceId: "workspace_dayova" });

      if (!replay.completeScan) {
        throw new Error("expected a replay scan capability");
      }

      await expect(replay.completeScan.reconcileAbsent()).resolves.toMatchObject({
        tombstones: [{ change: "unchanged", revision: 2 }],
        partialReasons: []
      });
    } finally {
      await database.close();
    }
  });

  it("reports retryable partial coverage and withholds absence authority while an execution fences a source root", async () => {
    const database = await createPgliteDatabase();
    const baseApi = new FakeNotionMeetingNotesApi();
    const api: NotionMeetingNotesApi = {
      async listDataSourcePages(input) {
        return { ...(await baseApi.listDataSourcePages(input)), nextCursor: null };
      },
      listBlockChildren: (input) => baseApi.listBlockChildren(input),
      retrievePageMarkdown: (input) => baseApi.retrievePageMarkdown(input)
    };
    const ledger = createObservedSourceLedger({ database });
    const source = createNotionMeetingNotesSource({
      api,
      ledger,
      meetingsDataSourceId: "dayova-meetings",
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });

    try {
      const seeded = await source.scan({ workspaceId: "workspace_dayova" });
      const record = seeded.records[0];

      if (!record) {
        throw new Error("expected a source record before fencing");
      }

      await expect(
        ledger.acquireExecutionFence({
          workspaceId: "workspace_dayova",
          source: record.source,
          expected: {
            revision: record.revision,
            contentHash: record.contentHash
          },
          owner: {
            meetingId: "meeting-product-sync",
            intentId: "settlement-product-sync",
            executionLeaseId: "lease-product-sync"
          },
          now: new Date("2026-08-08T10:01:00.000Z")
        })
      ).resolves.toEqual({ status: "acquired" });

      const fenced = await source.scan({ workspaceId: "workspace_dayova" });

      expect(fenced.records).toEqual([]);
      expect(fenced.completeness).toBe("partial");
      expect(fenced.completeScan).toBeUndefined();
      expect(fenced.partialReasons).toContainEqual(
        expect.objectContaining({
          code: "source-execution-fenced",
          sourceObjectId: record.source.sourceObjectId,
          retryable: true
        })
      );
      await expect(
        ledger.get({ workspaceId: "workspace_dayova", source: record.source })
      ).resolves.toMatchObject({
        revision: record.revision,
        contentHash: record.contentHash
      });
    } finally {
      await database.close();
    }
  });

  it("reports partial absence reconciliation instead of tombstoning an execution-fenced root", async () => {
    const database = await createPgliteDatabase();
    const baseApi = new FakeNotionMeetingNotesApi();
    let sourceIsVisible = true;
    const api: NotionMeetingNotesApi = {
      async listDataSourcePages(input) {
        return sourceIsVisible
          ? { ...(await baseApi.listDataSourcePages(input)), nextCursor: null }
          : { pages: [], nextCursor: null, incomplete: false };
      },
      listBlockChildren: (input) => baseApi.listBlockChildren(input),
      retrievePageMarkdown: (input) => baseApi.retrievePageMarkdown(input)
    };
    const ledger = createObservedSourceLedger({ database });
    const source = createNotionMeetingNotesSource({
      api,
      ledger,
      meetingsDataSourceId: "dayova-meetings",
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });

    try {
      const seeded = await source.scan({ workspaceId: "workspace_dayova" });
      const record = seeded.records[0];

      if (!record) {
        throw new Error("expected a source record before fencing");
      }

      await ledger.acquireExecutionFence({
        workspaceId: "workspace_dayova",
        source: record.source,
        expected: {
          revision: record.revision,
          contentHash: record.contentHash
        },
        owner: {
          meetingId: "meeting-product-sync",
          intentId: "settlement-product-sync",
          executionLeaseId: "lease-product-sync"
        },
        now: new Date("2026-08-08T10:01:00.000Z")
      });
      sourceIsVisible = false;

      const absent = await source.scan({ workspaceId: "workspace_dayova" });

      if (!absent.completeScan) {
        throw new Error("expected a complete source scan before absence reconciliation");
      }

      await expect(absent.completeScan.reconcileAbsent()).resolves.toMatchObject({
        tombstones: [],
        partialReasons: [
          expect.objectContaining({
            code: "source-execution-fenced",
            sourceObjectId: record.source.sourceObjectId,
            retryable: true
          })
        ]
      });
      await expect(
        ledger.get({ workspaceId: "workspace_dayova", source: record.source })
      ).resolves.toMatchObject({
        revision: record.revision,
        contentHash: record.contentHash,
        snapshot: { lifecycle: "ready" }
      });
    } finally {
      await database.close();
    }
  });

  it("keeps absence authority after a fully readable paginated scan", async () => {
    const database = await createPgliteDatabase();
    const baseApi = new FakeNotionMeetingNotesApi();
    let mode: "seed" | "paginate" = "seed";
    const api: NotionMeetingNotesApi = {
      async listDataSourcePages(input) {
        if (mode === "seed") {
          return { ...(await baseApi.listDataSourcePages(input)), nextCursor: null };
        }

        return input.cursor
          ? { pages: [], nextCursor: null, incomplete: false }
          : { pages: [], nextCursor: "page-2", incomplete: false };
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
      const initial = await source.scan({ workspaceId: "workspace_dayova" });
      expect(initial.records).toHaveLength(1);

      mode = "paginate";
      const firstPage = await source.scan({ workspaceId: "workspace_dayova" });
      expect(firstPage.nextCursor).toBe("page-2");
      expect(firstPage.completeScan).toBeUndefined();
      const finalPage = await source.scan({
        workspaceId: "workspace_dayova",
        cursor: "page-2"
      });

      expect(finalPage.completeness).toBe("complete");
      if (!finalPage.completeScan) {
        throw new Error("expected a completed pagination scan capability");
      }

      await expect(finalPage.completeScan.reconcileAbsent()).resolves.toMatchObject({
        tombstones: [
          { change: "revised", source: { sourceObjectId: "meeting-notes-block-1" } }
        ],
        partialReasons: []
      });
    } finally {
      await database.close();
    }
  });

  it("keeps paginated source scans isolated when Notion reuses a cursor across workspaces", async () => {
    const database = await createPgliteDatabase();
    const source = createNotionMeetingNotesSource({
      api: emptyPaginatedApi(),
      ledger: createObservedSourceLedger({ database }),
      meetingsDataSourceId: "dayova-meetings"
    });

    try {
      await source.scan({ workspaceId: "workspace_alpha" });
      await source.scan({ workspaceId: "workspace_beta" });

      const alpha = await source.scan({
        workspaceId: "workspace_alpha",
        cursor: "shared-cursor"
      });
      const beta = await source.scan({
        workspaceId: "workspace_beta",
        cursor: "shared-cursor"
      });

      expect(alpha.completeScan).toBeDefined();
      expect(beta.completeScan).toBeDefined();
    } finally {
      await database.close();
    }
  });

  it("expires and bounds abandoned paginated source scans without granting absence authority", async () => {
    let nowMs = Date.parse("2026-08-08T10:00:00.000Z");
    const source = createNotionMeetingNotesSource({
      api: emptyPaginatedApi(),
      ledger: emptyObservedSourceLedger,
      meetingsDataSourceId: "dayova-meetings",
      now: () => new Date(nowMs)
    });

    await source.scan({ workspaceId: "workspace_expired" });
    nowMs += 10 * 60 * 1000;

    const expired = await source.scan({
      workspaceId: "workspace_expired",
      cursor: "shared-cursor"
    });

    expect(expired.completeScan).toBeUndefined();

    for (let index = 0; index <= 100; index += 1) {
      await source.scan({ workspaceId: `workspace_${index}` });
    }

    const evicted = await source.scan({
      workspaceId: "workspace_0",
      cursor: "shared-cursor"
    });
    const retained = await source.scan({
      workspaceId: "workspace_100",
      cursor: "shared-cursor"
    });

    expect(evicted.completeScan).toBeUndefined();
    expect(retained.completeScan).toBeDefined();
  });

  it("never infers root absence when Notion returns an unreadable root block", async () => {
    const database = await createPgliteDatabase();
    const baseApi = new FakeNotionMeetingNotesApi();
    let restricted = false;
    const api: NotionMeetingNotesApi = {
      async listDataSourcePages(input) {
        return { ...(await baseApi.listDataSourcePages(input)), nextCursor: null };
      },
      async listBlockChildren(input) {
        if (restricted && input.blockId === "meeting-page-1") {
          return {
            blocks: [block({ id: "restricted-root", type: "unknown" })],
            nextCursor: null
          };
        }

        return baseApi.listBlockChildren(input);
      },
      retrievePageMarkdown: (input) => baseApi.retrievePageMarkdown(input)
    };
    const ledger = createObservedSourceLedger({ database });
    const source = createNotionMeetingNotesSource({
      api,
      ledger,
      meetingsDataSourceId: "dayova-meetings"
    });

    try {
      const seeded = await source.scan({ workspaceId: "workspace_dayova" });
      const original = seeded.records[0];

      if (!original) {
        throw new Error("expected a seeded Meeting Notes root");
      }

      restricted = true;
      const scan = await source.scan({ workspaceId: "workspace_dayova" });

      expect(scan.completeness).toBe("partial");
      expect(scan.completeScan).toBeUndefined();
      expect(scan.partialReasons).toContainEqual(
        expect.objectContaining({
          code: "unreadable-page",
          pageId: "meeting-page-1"
        })
      );
      await expect(
        ledger.get({
          workspaceId: "workspace_dayova",
          source: original.source
        })
      ).resolves.toMatchObject({ revision: 1, snapshot: { lifecycle: "ready" } });
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
      expect(scan.partialReasons).toContainEqual(
        expect.objectContaining({
          code: "source-record-incomplete",
          sourceObjectId: "meeting-notes-block-1"
        })
      );
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
