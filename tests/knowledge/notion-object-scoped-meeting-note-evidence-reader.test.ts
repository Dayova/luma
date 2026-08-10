import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createNotionObjectScopedMeetingNoteEvidenceReader,
  createNotionObjectScopedMeetingNoteEvidenceReaderFromEnv,
  createNotionObjectScopedMeetingNoteEvidenceReaderForTest,
  createNotionObjectScopedMeetingNoteEvidenceTransportForTest
} from "../../src/knowledge/notion-object-scoped-meeting-note-evidence-reader.js";
import type { NotionObjectScopedMeetingNoteEvidenceReader } from "../../src/knowledge/notion-object-scoped-meeting-note-evidence-source.js";
import { NotionMeetingNotesReadError } from "../../src/knowledge/notion-meeting-notes-source.js";
const pageId = "14d90a82-a4fb-4a97-8a3f-299a9dad204a";
const otherPageId = "4e28a2a7-2b90-4566-bb3d-4e50c3f3519d";
const meetingNotesRootId = "f7f30c2a-7c4d-4f27-9f22-0a4b76993201";
const summaryBlockId = "f7f30c2a-7c4d-4f27-9f22-0a4b76993202";
const notesBlockId = "f7f30c2a-7c4d-4f27-9f22-0a4b76993203";
const transcriptBlockId = "f7f30c2a-7c4d-4f27-9f22-0a4b76993204";
const summaryLineId = "f7f30c2a-7c4d-4f27-9f22-0a4b76993205";
const safeSummaryDescendantId = "f7f30c2a-7c4d-4f27-9f22-0a4b76993206";
const ordinaryPageSiblingId = "f7f30c2a-7c4d-4f27-9f22-0a4b76993207";
const nestedPageId = "f7f30c2a-7c4d-4f27-9f22-0a4b76993208";
const nestedDatabaseId = "f7f30c2a-7c4d-4f27-9f22-0a4b76993209";
const externalSyncedBlockId = "f7f30c2a-7c4d-4f27-9f22-0a4b76993210";
const wrongParentChildId = "f7f30c2a-7c4d-4f27-9f22-0a4b76993211";
const anotherSummaryBlockId = "f7f30c2a-7c4d-4f27-9f22-0a4b76993212";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

class RecordingExactPageTransport {
  readonly initialization: Array<{
    auth: string;
    notionVersion: string;
    retry: false;
  }> = [];
  readonly pageCalls: string[] = [];
  readonly markdownCalls: Array<{ pageId: string; includeTranscript: boolean }> = [];
  readonly blockCalls: Array<{ blockId: string; cursor?: string }> = [];

  create(input: { auth: string; notionVersion: string; retry: false }) {
    this.initialization.push({ ...input });

    return {
      retrievePage: (request: { pageId: string }) => {
        this.pageCalls.push(request.pageId);
        return Promise.resolve({
          object: "page",
          id: pageId,
          title: "Product sync",
          url: "https://www.notion.so/product-sync",
          last_edited_time: "2026-08-10T09:00:00.000Z",
          in_trash: false,
          properties: {
            Name: {
              type: "title",
              title: [{ plain_text: "Product sync" }]
            }
          }
        });
      },
      retrievePageMarkdown: (request: { pageId: string; includeTranscript: boolean }) => {
        this.markdownCalls.push({ ...request });
        return Promise.resolve({
          object: "page_markdown",
          id: pageId,
          markdown: "# Product sync",
          truncated: false,
          unknown_block_ids: []
        });
      },
      listBlockChildren: (request: { blockId: string; cursor?: string }) => {
        this.blockCalls.push({ ...request });
        const page = this.blocks[`${request.blockId}:${request.cursor ?? "first"}`];

        return page
          ? Promise.resolve(page)
          : Promise.reject(new Error(`unexpected block read ${request.blockId}`));
      }
    };
  }

  private readonly blocks: Record<
    string,
    {
      object: "list";
      type: "block";
      block: Record<string, never>;
      results: object[];
      next_cursor: string | null;
      has_more: boolean;
    }
  > = {
    [`${pageId}:first`]: {
      object: "list",
      type: "block",
      block: {},
      results: [
        {
          object: "block",
          id: meetingNotesRootId,
          type: "meeting_notes",
          has_children: true,
          in_trash: false,
          parent: { type: "page_id", page_id: pageId },
          meeting_notes: {
            title: [{ plain_text: "Product sync" }],
            status: "notes_ready",
            children: {
              summary_block_id: summaryBlockId,
              notes_block_id: notesBlockId,
              transcript_block_id: transcriptBlockId
            }
          }
        }
      ],
      next_cursor: null,
      has_more: false
    },
    [`${meetingNotesRootId}:first`]: {
      object: "list",
      type: "block",
      block: {},
      results: [
        {
          object: "block",
          id: summaryBlockId,
          type: "paragraph",
          has_children: true,
          in_trash: false,
          parent: { type: "block_id", block_id: meetingNotesRootId },
          paragraph: { rich_text: [] }
        },
        {
          object: "block",
          id: notesBlockId,
          type: "paragraph",
          has_children: true,
          in_trash: false,
          parent: { type: "block_id", block_id: meetingNotesRootId },
          paragraph: { rich_text: [] }
        },
        {
          object: "block",
          id: transcriptBlockId,
          type: "paragraph",
          has_children: true,
          in_trash: false,
          parent: { type: "block_id", block_id: meetingNotesRootId },
          paragraph: { rich_text: [] }
        }
      ],
      next_cursor: null,
      has_more: false
    },
    [`${summaryBlockId}:first`]: {
      object: "list",
      type: "block",
      block: {},
      results: [
        {
          object: "block",
          id: summaryLineId,
          type: "paragraph",
          has_children: false,
          in_trash: false,
          parent: { type: "block_id", block_id: summaryBlockId },
          paragraph: { rich_text: [{ plain_text: "Review only the exact meeting." }] }
        }
      ],
      next_cursor: null,
      has_more: false
    }
  };
}

class ProgrammableExactPageTransport {
  readonly initialization: Array<{
    auth: string;
    notionVersion: string;
    retry: false;
  }> = [];
  readonly pageCalls: string[] = [];
  readonly markdownCalls: Array<{ pageId: string; includeTranscript: boolean }> = [];
  readonly blockCalls: Array<{ blockId: string; cursor?: string }> = [];
  pageMaterial: unknown = rawPage();
  markdownMaterial: unknown = rawMarkdown();
  readonly blockMaterial = new Map<string, unknown>();

  constructor() {
    this.blockMaterial.set(
      `${meetingNotesRootId}:first`,
      rawBlockList([
        rawChildBlock({
          id: summaryBlockId,
          parentBlockId: meetingNotesRootId,
          hasChildren: true
        }),
        rawChildBlock({
          id: notesBlockId,
          parentBlockId: meetingNotesRootId,
          hasChildren: true
        }),
        rawChildBlock({
          id: transcriptBlockId,
          parentBlockId: meetingNotesRootId,
          hasChildren: true
        })
      ])
    );
  }

  create(input: { auth: string; notionVersion: string; retry: false }) {
    this.initialization.push({ ...input });

    return {
      retrievePage: (request: { pageId: string }) => {
        this.pageCalls.push(request.pageId);
        return resolveTransportMaterial(this.pageMaterial);
      },
      retrievePageMarkdown: (request: { pageId: string; includeTranscript: boolean }) => {
        this.markdownCalls.push({ ...request });
        return resolveTransportMaterial(this.markdownMaterial);
      },
      listBlockChildren: (request: { blockId: string; cursor?: string }) => {
        this.blockCalls.push({ ...request });
        const material = this.blockMaterial.get(
          `${request.blockId}:${request.cursor ?? "first"}`
        );

        return material === undefined
          ? Promise.reject(new Error(`unexpected block read ${request.blockId}`))
          : resolveTransportMaterial(material);
      }
    };
  }
}

function createTestReader(transport: ProgrammableExactPageTransport) {
  return createNotionObjectScopedMeetingNoteEvidenceReaderForTest({
    pageId,
    readOnlyApiToken: "native-read-only-token",
    transport: createNotionObjectScopedMeetingNoteEvidenceTransportForTest((input) =>
      transport.create(input)
    )
  });
}

function rawPage(
  overrides: {
    id?: string;
    inTrash?: boolean;
    lastEditedAt?: string | null;
    properties?: Record<string, unknown>;
  } = {}
): Record<string, unknown> {
  return {
    object: "page",
    id: overrides.id ?? pageId,
    url: "https://www.notion.so/product-sync",
    last_edited_time: overrides.lastEditedAt ?? "2026-08-10T09:00:00.000Z",
    in_trash: overrides.inTrash ?? false,
    properties: overrides.properties ?? {
      Name: { type: "title", title: [{ plain_text: "Product sync" }] }
    }
  };
}

function rawMarkdown(
  overrides: { id?: string; unknownBlockIds?: string[]; truncated?: boolean } = {}
): Record<string, unknown> {
  return {
    object: "page_markdown",
    id: overrides.id ?? pageId,
    markdown: "# Product sync",
    truncated: overrides.truncated ?? false,
    unknown_block_ids: overrides.unknownBlockIds ?? []
  };
}

function rawBlockList(
  results: Record<string, unknown>[],
  input: { nextCursor?: string | null; hasMore?: boolean } = {}
): Record<string, unknown> {
  const nextCursor = input.nextCursor ?? null;

  return {
    object: "list",
    type: "block",
    block: {},
    results,
    next_cursor: nextCursor,
    has_more: input.hasMore ?? nextCursor !== null
  };
}

function rawMeetingNotesRoot(
  input: {
    id?: string;
    parentPageId?: string;
    type?: "meeting_notes" | "transcription";
    summaryBlockId?: string | null;
    notesBlockId?: string | null;
    transcriptBlockId?: string | null;
    inTrash?: boolean;
    calendarEvent?: unknown;
    recording?: unknown;
  } = {}
): Record<string, unknown> {
  const type = input.type ?? "meeting_notes";

  return {
    object: "block",
    id: input.id ?? meetingNotesRootId,
    type,
    has_children: true,
    in_trash: input.inTrash ?? false,
    parent: { type: "page_id", page_id: input.parentPageId ?? pageId },
    [type]: {
      title: [{ plain_text: "Product sync" }],
      status: "notes_ready",
      children: {
        summary_block_id: input.summaryBlockId ?? summaryBlockId,
        notes_block_id: input.notesBlockId ?? notesBlockId,
        transcript_block_id: input.transcriptBlockId ?? transcriptBlockId
      },
      ...(input.calendarEvent === undefined
        ? {}
        : { calendar_event: input.calendarEvent }),
      ...(input.recording === undefined ? {} : { recording: input.recording })
    }
  };
}

function rawChildBlock(input: {
  id: string;
  parentBlockId: string;
  type?: string;
  hasChildren?: boolean;
  inTrash?: boolean;
}): Record<string, unknown> {
  const type = input.type ?? "paragraph";

  return {
    object: "block",
    id: input.id,
    type,
    has_children: input.hasChildren ?? false,
    in_trash: input.inTrash ?? false,
    parent: { type: "block_id", block_id: input.parentBlockId },
    ...(type === "paragraph"
      ? { paragraph: { rich_text: [{ plain_text: input.id }] } }
      : type === "synced_block"
        ? { synced_block: { synced_from: { type: "block_id", block_id: "external" } } }
        : {})
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function resolveTransportMaterial(value: unknown): Promise<unknown> {
  const resolved = isTransportMaterialFactory(value) ? value() : value;

  return resolved instanceof Error ? Promise.reject(resolved) : Promise.resolve(resolved);
}

function isTransportMaterialFactory(value: unknown): value is () => unknown {
  return typeof value === "function";
}

function capturedSynchronousError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  return new Error("Expected the action to throw");
}

async function capturedRejectedError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => new Error("Expected the promise to reject"),
    (error: unknown) => error
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "";
}

describe("object-scoped Notion Meeting Note evidence reader", () => {
  it("returns only an exact-page read surface and follows a provider-derived Meeting Notes path", async () => {
    const transport = new RecordingExactPageTransport();
    const reader = createNotionObjectScopedMeetingNoteEvidenceReaderForTest({
      pageId,
      readOnlyApiToken: "native-read-only-token",
      transport: createNotionObjectScopedMeetingNoteEvidenceTransportForTest((input) =>
        transport.create(input)
      )
    });

    expectTypeOf<
      ReturnType<typeof createNotionObjectScopedMeetingNoteEvidenceReader>
    >().toEqualTypeOf<NotionObjectScopedMeetingNoteEvidenceReader>();
    expect(Object.keys(reader).sort()).toEqual([
      "listBlockChildren",
      "retrievePage",
      "retrievePageMarkdown"
    ]);
    expect("listDataSourcePages" in reader).toBe(false);
    expect("search" in reader).toBe(false);
    expect("update" in reader).toBe(false);

    await expect(reader.retrievePage({ pageId })).resolves.toMatchObject({ id: pageId });
    await expect(
      reader.retrievePageMarkdown({ pageId, includeTranscript: true })
    ).resolves.toEqual({
      content: "# Product sync",
      truncated: false,
      unknownBlockIds: []
    });
    await expect(reader.listBlockChildren({ blockId: pageId })).resolves.toMatchObject({
      nextCursor: null
    });
    await expect(
      reader.listBlockChildren({ blockId: meetingNotesRootId })
    ).resolves.toMatchObject({ nextCursor: null });
    await expect(
      reader.listBlockChildren({ blockId: summaryBlockId })
    ).resolves.toMatchObject({
      nextCursor: null
    });
    await expect(
      reader.listBlockChildren({ blockId: "outside-page" })
    ).rejects.toMatchObject({
      code: "notion-object-scoped-reader-block-forbidden"
    });

    expect(transport.initialization).toEqual([
      { auth: "native-read-only-token", notionVersion: "2026-03-11", retry: false }
    ]);
    expect(transport.pageCalls).toEqual([pageId]);
    expect(transport.markdownCalls).toEqual([{ pageId, includeTranscript: true }]);
    expect(transport.blockCalls).toEqual([
      { blockId: pageId },
      { blockId: meetingNotesRootId },
      { blockId: summaryBlockId }
    ]);
  });

  it("rejects out-of-order, mismatched, and forged direct reads before transport I/O", async () => {
    const transport = new ProgrammableExactPageTransport();
    const reader = createTestReader(transport);

    await expect(
      reader.retrievePageMarkdown({ pageId, includeTranscript: true })
    ).rejects.toMatchObject({ code: "notion-object-scoped-reader-page-unverified" });
    await expect(reader.listBlockChildren({ blockId: pageId })).rejects.toMatchObject({
      code: "notion-object-scoped-reader-page-unverified"
    });
    await expect(reader.retrievePage({ pageId: otherPageId })).rejects.toMatchObject({
      code: "notion-object-scoped-reader-page-forbidden"
    });
    expect(transport.pageCalls).toEqual([]);
    expect(transport.markdownCalls).toEqual([]);
    expect(transport.blockCalls).toEqual([]);

    await expect(reader.retrievePage({ pageId })).resolves.toMatchObject({ id: pageId });
    await expect(
      reader.retrievePageMarkdown({ pageId: otherPageId, includeTranscript: true })
    ).rejects.toMatchObject({ code: "notion-object-scoped-reader-page-forbidden" });
    await expect(
      reader.retrievePageMarkdown({ pageId, includeTranscript: false })
    ).rejects.toMatchObject({ code: "notion-object-scoped-reader-request-invalid" });
    await expect(
      reader.listBlockChildren({ blockId: "another-block" })
    ).rejects.toMatchObject({
      code: "notion-object-scoped-reader-block-forbidden"
    });
    await expect(
      reader.listBlockChildren({ blockId: pageId, cursor: "forged-cursor" })
    ).rejects.toMatchObject({ code: "notion-object-scoped-reader-cursor-forbidden" });

    expect(transport.pageCalls).toEqual([pageId]);
    expect(transport.markdownCalls).toEqual([]);
    expect(transport.blockCalls).toEqual([]);
  });

  it("mints only provider-derived Meeting Notes pointers and safe returned descendants", async () => {
    const transport = new ProgrammableExactPageTransport();
    transport.markdownMaterial = rawMarkdown({
      unknownBlockIds: ["markdown-unknown-block"]
    });
    transport.blockMaterial.set(
      `${pageId}:first`,
      rawBlockList([
        rawMeetingNotesRoot(),
        {
          ...rawChildBlock({
            id: ordinaryPageSiblingId,
            parentBlockId: pageId,
            hasChildren: true
          }),
          parent: { type: "page_id", page_id: pageId }
        }
      ])
    );
    transport.blockMaterial.set(
      `${summaryBlockId}:first`,
      rawBlockList([
        rawChildBlock({
          id: safeSummaryDescendantId,
          parentBlockId: summaryBlockId,
          hasChildren: true
        }),
        rawChildBlock({
          id: nestedPageId,
          parentBlockId: summaryBlockId,
          type: "child_page",
          hasChildren: true
        }),
        rawChildBlock({
          id: nestedDatabaseId,
          parentBlockId: summaryBlockId,
          type: "child_database",
          hasChildren: true
        }),
        rawChildBlock({
          id: externalSyncedBlockId,
          parentBlockId: summaryBlockId,
          type: "synced_block",
          hasChildren: true
        })
      ])
    );
    transport.blockMaterial.set(`${safeSummaryDescendantId}:first`, rawBlockList([]));
    const reader = createTestReader(transport);

    await reader.retrievePage({ pageId });
    await expect(
      reader.retrievePageMarkdown({ pageId, includeTranscript: true })
    ).resolves.toMatchObject({
      unknownBlockIds: ["markdown-unknown-block"]
    });
    await reader.listBlockChildren({ blockId: pageId });

    for (const blockId of [
      ordinaryPageSiblingId,
      "markdown-unknown-block",
      "arbitrary-block"
    ]) {
      await expect(reader.listBlockChildren({ blockId })).rejects.toMatchObject({
        code: "notion-object-scoped-reader-block-forbidden"
      });
    }

    await reader.listBlockChildren({ blockId: meetingNotesRootId });
    await reader.listBlockChildren({ blockId: summaryBlockId });
    await reader.listBlockChildren({ blockId: safeSummaryDescendantId });

    for (const blockId of [nestedPageId, nestedDatabaseId, externalSyncedBlockId]) {
      await expect(reader.listBlockChildren({ blockId })).rejects.toMatchObject({
        code: "notion-object-scoped-reader-block-forbidden"
      });
    }

    expect(transport.blockCalls).toEqual([
      { blockId: pageId },
      { blockId: meetingNotesRootId },
      { blockId: summaryBlockId },
      { blockId: safeSummaryDescendantId }
    ]);
  });

  it("requires each Meeting Notes section pointer to appear below the verified root", async () => {
    const foreignBlockId = "f7f30c2a-7c4d-4f27-9f22-0a4b76993213";
    const transport = new ProgrammableExactPageTransport();
    transport.blockMaterial.set(
      `${pageId}:first`,
      rawBlockList([rawMeetingNotesRoot({ summaryBlockId: foreignBlockId })])
    );
    transport.blockMaterial.set(
      `${meetingNotesRootId}:first`,
      rawBlockList([
        rawChildBlock({
          id: notesBlockId,
          parentBlockId: meetingNotesRootId,
          hasChildren: true
        }),
        rawChildBlock({
          id: transcriptBlockId,
          parentBlockId: meetingNotesRootId,
          hasChildren: true
        })
      ])
    );
    const reader = createTestReader(transport);

    await reader.retrievePage({ pageId });
    await reader.listBlockChildren({ blockId: pageId });
    await reader.listBlockChildren({ blockId: meetingNotesRootId });
    await expect(
      reader.listBlockChildren({ blockId: foreignBlockId })
    ).rejects.toMatchObject({
      code: "notion-object-scoped-reader-block-forbidden"
    });

    expect(transport.blockCalls).toEqual([
      { blockId: pageId },
      { blockId: meetingNotesRootId }
    ]);

    const malformedPointerTransport = new ProgrammableExactPageTransport();
    malformedPointerTransport.blockMaterial.set(
      `${pageId}:first`,
      rawBlockList([rawMeetingNotesRoot({ summaryBlockId: `${foreignBlockId}#` })])
    );
    const malformedPointerReader = createTestReader(malformedPointerTransport);

    await malformedPointerReader.retrievePage({ pageId });
    await expect(
      malformedPointerReader.listBlockChildren({ blockId: pageId })
    ).rejects.toMatchObject({ code: "source-invalid" });
    expect(malformedPointerTransport.blockCalls).toEqual([{ blockId: pageId }]);
  });

  it("accepts a validated legacy transcription root as a documented pointer source", async () => {
    const transport = new ProgrammableExactPageTransport();
    transport.blockMaterial.set(
      `${pageId}:first`,
      rawBlockList([rawMeetingNotesRoot({ type: "transcription" })])
    );
    transport.blockMaterial.set(`${summaryBlockId}:first`, rawBlockList([]));
    const reader = createTestReader(transport);

    await reader.retrievePage({ pageId });
    await reader.listBlockChildren({ blockId: pageId });
    await reader.listBlockChildren({ blockId: meetingNotesRootId });
    await expect(
      reader.listBlockChildren({ blockId: summaryBlockId })
    ).resolves.toMatchObject({
      nextCursor: null
    });
  });

  it.each([
    [
      "calendar",
      rawMeetingNotesRoot({
        calendarEvent: {
          start_time: 123,
          end_time: "2026-08-10T08:30:00.000Z",
          attendees: ["notion-user-jakob"]
        }
      })
    ],
    [
      "recording",
      rawMeetingNotesRoot({
        recording: { start_time: "2026-08-10T08:00:00.000Z", end_time: 123 }
      })
    ]
  ])(
    "rejects malformed Meeting Notes %s metadata before minting pointers",
    async (_kind, root) => {
      const transport = new ProgrammableExactPageTransport();
      transport.blockMaterial.set(`${pageId}:first`, rawBlockList([root]));
      const reader = createTestReader(transport);

      await reader.retrievePage({ pageId });
      await expect(reader.listBlockChildren({ blockId: pageId })).rejects.toMatchObject({
        code: "source-invalid"
      });
      await expect(
        reader.listBlockChildren({ blockId: summaryBlockId })
      ).rejects.toMatchObject({
        code: "notion-object-scoped-reader-block-forbidden"
      });
    }
  );

  it("treats a missing raw Meeting Notes payload as invalid provider material", async () => {
    const transport = new ProgrammableExactPageTransport();
    const malformedRoot = rawMeetingNotesRoot();
    delete malformedRoot["meeting_notes"];
    transport.blockMaterial.set(`${pageId}:first`, rawBlockList([malformedRoot]));
    const reader = createTestReader(transport);

    await reader.retrievePage({ pageId });
    const error = await capturedRejectedError(
      reader.listBlockChildren({ blockId: pageId })
    );

    expect(error).toMatchObject({
      code: "source-invalid",
      message: "Notion exact-page material could not be verified"
    });
    expect(errorMessage(error)).not.toContain("Cannot read");
    await expect(
      reader.listBlockChildren({ blockId: summaryBlockId })
    ).rejects.toMatchObject({
      code: "notion-object-scoped-reader-block-forbidden"
    });
  });

  it("fails closed for wrong raw parent, trashed, and malformed provider material", async () => {
    const wrongRootParent = new ProgrammableExactPageTransport();
    wrongRootParent.blockMaterial.set(
      `${pageId}:first`,
      rawBlockList([rawMeetingNotesRoot({ parentPageId: "another-page" })])
    );
    const wrongRootParentReader = createTestReader(wrongRootParent);

    await wrongRootParentReader.retrievePage({ pageId });
    await expect(
      wrongRootParentReader.listBlockChildren({ blockId: pageId })
    ).rejects.toMatchObject({
      code: "source-invalid"
    });
    await expect(
      wrongRootParentReader.listBlockChildren({ blockId: summaryBlockId })
    ).rejects.toMatchObject({ code: "notion-object-scoped-reader-block-forbidden" });
    expect(wrongRootParent.blockCalls).toEqual([{ blockId: pageId }]);

    const wrongDescendantParent = new ProgrammableExactPageTransport();
    wrongDescendantParent.blockMaterial.set(
      `${pageId}:first`,
      rawBlockList([rawMeetingNotesRoot()])
    );
    wrongDescendantParent.blockMaterial.set(
      `${summaryBlockId}:first`,
      rawBlockList([
        rawChildBlock({
          id: wrongParentChildId,
          parentBlockId: anotherSummaryBlockId,
          hasChildren: true
        })
      ])
    );
    const wrongDescendantParentReader = createTestReader(wrongDescendantParent);

    await wrongDescendantParentReader.retrievePage({ pageId });
    await wrongDescendantParentReader.listBlockChildren({ blockId: pageId });
    await wrongDescendantParentReader.listBlockChildren({ blockId: meetingNotesRootId });
    await expect(
      wrongDescendantParentReader.listBlockChildren({ blockId: summaryBlockId })
    ).rejects.toMatchObject({ code: "source-invalid" });
    await expect(
      wrongDescendantParentReader.listBlockChildren({ blockId: wrongParentChildId })
    ).rejects.toMatchObject({ code: "notion-object-scoped-reader-block-forbidden" });
    expect(wrongDescendantParent.blockCalls).toEqual([
      { blockId: pageId },
      { blockId: meetingNotesRootId },
      { blockId: summaryBlockId }
    ]);

    const trashedRoot = new ProgrammableExactPageTransport();
    trashedRoot.blockMaterial.set(
      `${pageId}:first`,
      rawBlockList([rawMeetingNotesRoot({ inTrash: true })])
    );
    const trashedRootReader = createTestReader(trashedRoot);

    await trashedRootReader.retrievePage({ pageId });
    await expect(
      trashedRootReader.listBlockChildren({ blockId: pageId })
    ).rejects.toMatchObject({
      code: "source-invalid"
    });

    const malformedPagination = new ProgrammableExactPageTransport();
    malformedPagination.blockMaterial.set(
      `${pageId}:first`,
      rawBlockList([rawMeetingNotesRoot()], { nextCursor: "next-root", hasMore: false })
    );
    const malformedPaginationReader = createTestReader(malformedPagination);

    await malformedPaginationReader.retrievePage({ pageId });
    await expect(
      malformedPaginationReader.listBlockChildren({ blockId: pageId })
    ).rejects.toMatchObject({ code: "source-invalid" });

    const trashedPage = new ProgrammableExactPageTransport();
    trashedPage.pageMaterial = rawPage({ inTrash: true });
    const trashedPageReader = createTestReader(trashedPage);

    await expect(trashedPageReader.retrievePage({ pageId })).rejects.toMatchObject({
      code: "source-invalid"
    });
    await expect(
      trashedPageReader.retrievePageMarkdown({ pageId, includeTranscript: true })
    ).rejects.toMatchObject({ code: "notion-object-scoped-reader-page-unverified" });
    expect(trashedPage.markdownCalls).toEqual([]);
  });

  it("binds cursors to one parent and one use, and caps repeated child-page reads", async () => {
    const transport = new ProgrammableExactPageTransport();
    transport.blockMaterial.set(
      `${pageId}:first`,
      rawBlockList([rawMeetingNotesRoot()], { nextCursor: "root-cursor" })
    );
    transport.blockMaterial.set("root-cursor:unused", rawBlockList([]));
    transport.blockMaterial.set(
      `${pageId}:root-cursor`,
      rawBlockList([], { nextCursor: null })
    );
    transport.blockMaterial.set(`${summaryBlockId}:first`, rawBlockList([]));
    const reader = createTestReader(transport);

    await reader.retrievePage({ pageId });
    await expect(reader.listBlockChildren({ blockId: pageId })).resolves.toMatchObject({
      nextCursor: "root-cursor"
    });
    await expect(
      reader.listBlockChildren({ blockId: summaryBlockId })
    ).rejects.toMatchObject({
      code: "notion-object-scoped-reader-block-forbidden"
    });
    await expect(
      reader.listBlockChildren({ blockId: "root-cursor", cursor: "root-cursor" })
    ).rejects.toMatchObject({ code: "notion-object-scoped-reader-block-forbidden" });

    await expect(
      reader.listBlockChildren({ blockId: pageId, cursor: "root-cursor" })
    ).resolves.toMatchObject({ nextCursor: null });
    await reader.listBlockChildren({ blockId: meetingNotesRootId });
    await expect(
      reader.listBlockChildren({ blockId: pageId, cursor: "root-cursor" })
    ).rejects.toMatchObject({ code: "notion-object-scoped-reader-cursor-forbidden" });
    await expect(
      reader.listBlockChildren({ blockId: summaryBlockId, cursor: "root-cursor" })
    ).rejects.toMatchObject({ code: "notion-object-scoped-reader-cursor-forbidden" });

    for (let index = 0; index < 100; index += 1) {
      await reader.listBlockChildren({ blockId: summaryBlockId });
    }

    await expect(
      reader.listBlockChildren({ blockId: summaryBlockId })
    ).rejects.toMatchObject({
      code: "notion-object-scoped-reader-budget-exhausted"
    });
    expect(
      transport.blockCalls.filter((call) => call.blockId === summaryBlockId)
    ).toHaveLength(100);
  });

  it("enforces the same pre-I/O pagination cap while scanning the configured root", async () => {
    const transport = new ProgrammableExactPageTransport();
    transport.blockMaterial.set(
      `${pageId}:first`,
      rawBlockList([rawMeetingNotesRoot()], { nextCursor: "root-page-1" })
    );

    for (let index = 1; index < 100; index += 1) {
      transport.blockMaterial.set(
        `${pageId}:root-page-${index}`,
        rawBlockList([], { nextCursor: `root-page-${index + 1}` })
      );
    }

    const reader = createTestReader(transport);
    await reader.retrievePage({ pageId });
    await reader.listBlockChildren({ blockId: pageId });

    for (let index = 1; index < 100; index += 1) {
      await reader.listBlockChildren({ blockId: pageId, cursor: `root-page-${index}` });
    }

    await expect(
      reader.listBlockChildren({ blockId: pageId, cursor: "root-page-100" })
    ).rejects.toMatchObject({ code: "notion-object-scoped-reader-budget-exhausted" });
    expect(transport.blockCalls).toHaveLength(100);
    expect(transport.blockCalls.at(-1)).toEqual({
      blockId: pageId,
      cursor: "root-page-99"
    });
  });

  it("keeps a provider-issued cursor available until its response parses successfully", async () => {
    const transport = new ProgrammableExactPageTransport();
    let cursorAttempt = 0;
    transport.blockMaterial.set(
      `${pageId}:first`,
      rawBlockList([rawMeetingNotesRoot()], { nextCursor: "root-cursor" })
    );
    transport.blockMaterial.set(`${pageId}:root-cursor`, () => {
      cursorAttempt += 1;

      if (cursorAttempt === 1) {
        return new Error("temporary provider failure");
      }

      if (cursorAttempt === 2) {
        return rawBlockList([], { nextCursor: "malformed-cursor", hasMore: false });
      }

      return rawBlockList([]);
    });
    const reader = createTestReader(transport);

    await reader.retrievePage({ pageId });
    await reader.listBlockChildren({ blockId: pageId });
    await expect(
      reader.listBlockChildren({ blockId: pageId, cursor: "root-cursor" })
    ).rejects.toMatchObject({ code: "transient" });
    await expect(
      reader.listBlockChildren({ blockId: pageId, cursor: "root-cursor" })
    ).rejects.toMatchObject({ code: "source-invalid" });
    await expect(
      reader.listBlockChildren({ blockId: pageId, cursor: "root-cursor" })
    ).resolves.toMatchObject({ nextCursor: null });

    expect(transport.blockCalls).toEqual([
      { blockId: pageId },
      { blockId: pageId, cursor: "root-cursor" },
      { blockId: pageId, cursor: "root-cursor" },
      { blockId: pageId, cursor: "root-cursor" }
    ]);
  });

  it("rejects array-shaped provider objects instead of treating them as records", async () => {
    const transport = new ProgrammableExactPageTransport();
    const pageWithArrayProperties = rawPage();
    pageWithArrayProperties["properties"] = [];
    transport.pageMaterial = pageWithArrayProperties;
    const reader = createTestReader(transport);

    await expect(reader.retrievePage({ pageId })).rejects.toMatchObject({
      code: "source-invalid"
    });
    expect(transport.pageCalls).toEqual([pageId]);
  });

  it("requires an exact Notion UUID or 32-hex page identity before transport construction", () => {
    const transport = new ProgrammableExactPageTransport();
    const testTransport = createNotionObjectScopedMeetingNoteEvidenceTransportForTest(
      (input) => transport.create(input)
    );

    for (const malformedPageId of ["notion-page-product-sync", "notion-page-1234", " "]) {
      expect(
        capturedSynchronousError(() =>
          createNotionObjectScopedMeetingNoteEvidenceReaderForTest({
            pageId: malformedPageId,
            readOnlyApiToken: "native-read-only-token",
            transport: testTransport
          })
        )
      ).toMatchObject({ code: "notion-object-scoped-reader-config-invalid" });
    }

    createNotionObjectScopedMeetingNoteEvidenceReaderForTest({
      pageId: pageId.replaceAll("-", ""),
      readOnlyApiToken: "native-read-only-token",
      transport: testTransport
    });

    expect(transport.initialization).toEqual([
      {
        auth: "native-read-only-token",
        notionVersion: "2026-03-11",
        retry: false
      }
    ]);
  });

  it("accepts a compact configured page ID with canonical provider responses", async () => {
    const compactPageId = pageId.replaceAll("-", "");
    const transport = new ProgrammableExactPageTransport();
    transport.blockMaterial.set(
      `${compactPageId}:first`,
      rawBlockList([rawMeetingNotesRoot()])
    );
    const reader = createNotionObjectScopedMeetingNoteEvidenceReaderForTest({
      pageId: compactPageId,
      readOnlyApiToken: "native-read-only-token",
      transport: createNotionObjectScopedMeetingNoteEvidenceTransportForTest((input) =>
        transport.create(input)
      )
    });

    await expect(reader.retrievePage({ pageId: compactPageId })).resolves.toMatchObject({
      id: compactPageId
    });
    await expect(
      reader.retrievePageMarkdown({ pageId: compactPageId, includeTranscript: true })
    ).resolves.toMatchObject({ content: "# Product sync" });
    await expect(
      reader.listBlockChildren({ blockId: compactPageId })
    ).resolves.toMatchObject({
      nextCursor: null
    });

    expect(transport.pageCalls).toEqual([compactPageId]);
    expect(transport.markdownCalls).toEqual([
      { pageId: compactPageId, includeTranscript: true }
    ]);
    expect(transport.blockCalls).toEqual([{ blockId: compactPageId }]);
  });

  it("requires a separate read-only token and exposes no provider error detail", async () => {
    expect(
      capturedSynchronousError(() =>
        createNotionObjectScopedMeetingNoteEvidenceReader({ pageId } as never)
      )
    ).toMatchObject({ code: "notion-object-scoped-reader-config-invalid" });
    expect(
      capturedSynchronousError(() =>
        createNotionObjectScopedMeetingNoteEvidenceReader({
          pageId,
          readOnlyApiToken: "native-read-only-token",
          token: "writer-token"
        } as never)
      )
    ).toMatchObject({ code: "notion-object-scoped-reader-config-invalid" });
    expect(
      capturedSynchronousError(() =>
        createNotionObjectScopedMeetingNoteEvidenceReaderFromEnv({
          NOTION_API_TOKEN: "broad-writer-token"
        })
      )
    ).toMatchObject({ code: "notion-object-scoped-reader-config-invalid" });
    expect(
      capturedSynchronousError(() =>
        createNotionObjectScopedMeetingNoteEvidenceReader({
          pageId,
          readOnlyApiToken: "native-read-only-token",
          dataSourceId: "broad-meetings-source"
        } as never)
      )
    ).toMatchObject({ code: "notion-object-scoped-reader-config-invalid" });

    const transport = new ProgrammableExactPageTransport();
    const reader = createTestReader(transport);
    transport.pageMaterial = new Error(
      "provider response contains a secret URL and token"
    );

    const transientError = await capturedRejectedError(reader.retrievePage({ pageId }));

    expect(transientError).toMatchObject({
      code: "transient",
      message: "Notion exact-page material could not be read"
    });
    expect(errorMessage(transientError)).not.toContain(
      "provider response contains a secret URL and token"
    );

    transport.pageMaterial = new NotionMeetingNotesReadError(
      "source-restricted",
      "provider says this page is restricted to a private group"
    );

    expect(await capturedRejectedError(reader.retrievePage({ pageId }))).toMatchObject({
      code: "source-restricted",
      message: "Notion exact-page access is unavailable"
    });

    transport.pageMaterial = new NotionMeetingNotesReadError(
      "unsafe-operational-outcome-markdown",
      "internal-only marker detail"
    );

    expect(await capturedRejectedError(reader.retrievePage({ pageId }))).toMatchObject({
      code: "transient",
      message: "Notion exact-page material could not be read"
    });
  });

  it("uses only the three pinned, read-only SDK query endpoints", async () => {
    const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit): Promise<Response> => {
      const parsed = new URL(url);
      calls.push({ url: parsed, init });

      if (parsed.pathname === `/v1/pages/${pageId}` && !parsed.search) {
        return Promise.resolve(jsonResponse(rawPage()));
      }

      if (
        parsed.pathname === `/v1/pages/${pageId}/markdown` &&
        parsed.searchParams.get("include_transcript") === "true"
      ) {
        return Promise.resolve(jsonResponse(rawMarkdown()));
      }

      if (
        parsed.pathname === `/v1/blocks/${pageId}/children` &&
        parsed.searchParams.get("page_size") === "100"
      ) {
        return Promise.resolve(jsonResponse(rawBlockList([rawMeetingNotesRoot()])));
      }

      return Promise.resolve(
        jsonResponse(
          {
            object: "error",
            status: 400,
            code: "invalid_request",
            message: "unexpected request"
          },
          400
        )
      );
    });
    const reader = createNotionObjectScopedMeetingNoteEvidenceReader({
      pageId,
      readOnlyApiToken: "native-read-only-token"
    });

    await reader.retrievePage({ pageId });
    await reader.retrievePageMarkdown({ pageId, includeTranscript: true });
    await reader.listBlockChildren({ blockId: pageId });

    expect(calls.map((call) => `${call.url.pathname}${call.url.search}`)).toEqual([
      `/v1/pages/${pageId}`,
      `/v1/pages/${pageId}/markdown?include_transcript=true`,
      `/v1/blocks/${pageId}/children?page_size=100`
    ]);
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      expect(call.init?.method).toBe("GET");
      expect(headers.get("notion-version")).toBe("2026-03-11");
      expect(headers.get("authorization")).toBe("Bearer native-read-only-token");
    }
  });

  it.each([
    [404, "object_not_found", "source-not-found"],
    [403, "restricted_resource", "source-restricted"],
    [401, "unauthorized", "source-restricted"],
    [503, "service_unavailable", "transient"]
  ])(
    "maps Notion %i %s to a safe %s error without an SDK retry",
    async (status, providerCode, expectedCode) => {
      let requestCount = 0;
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.stubGlobal("fetch", (): Promise<Response> => {
        requestCount += 1;
        return Promise.resolve(
          jsonResponse(
            {
              object: "error",
              status,
              code: providerCode,
              message: "provider-private diagnostic and token fragment"
            },
            status
          )
        );
      });
      const reader = createNotionObjectScopedMeetingNoteEvidenceReader({
        pageId,
        readOnlyApiToken: "native-read-only-token"
      });
      const error = await capturedRejectedError(reader.retrievePage({ pageId }));

      expect(error).toMatchObject({ code: expectedCode });
      expect(errorMessage(error)).not.toContain("provider-private diagnostic");
      expect(requestCount).toBe(1);
      expect(consoleWarn).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    }
  );
});
