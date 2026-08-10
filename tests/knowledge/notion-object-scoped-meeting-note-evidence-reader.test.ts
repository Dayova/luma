import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createNotionObjectScopedMeetingNoteEvidenceReader,
  createNotionObjectScopedMeetingNoteEvidenceReaderFromEnv,
  createNotionObjectScopedMeetingNoteEvidenceReaderForTest,
  createNotionObjectScopedMeetingNoteEvidenceTransportForTest
} from "../../src/knowledge/notion-object-scoped-meeting-note-evidence-reader.js";
import type { NotionObjectScopedMeetingNoteEvidenceReader } from "../../src/knowledge/notion-object-scoped-meeting-note-evidence-source.js";
import { NotionMeetingNotesReadError } from "../../src/knowledge/notion-meeting-notes-source.js";
const pageId = "notion-page-product-sync";

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
    "notion-page-product-sync:first": {
      object: "list",
      type: "block",
      block: {},
      results: [
        {
          object: "block",
          id: "meeting-notes-root",
          type: "meeting_notes",
          has_children: true,
          in_trash: false,
          parent: { type: "page_id", page_id: pageId },
          meeting_notes: {
            title: [{ plain_text: "Product sync" }],
            status: "notes_ready",
            children: {
              summary_block_id: "summary-block",
              notes_block_id: "notes-block",
              transcript_block_id: "transcript-block"
            }
          }
        }
      ],
      next_cursor: null,
      has_more: false
    },
    "summary-block:first": {
      object: "list",
      type: "block",
      block: {},
      results: [
        {
          object: "block",
          id: "summary-line",
          type: "paragraph",
          has_children: false,
          in_trash: false,
          parent: { type: "block_id", block_id: "summary-block" },
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
    id: input.id ?? "meeting-notes-root",
    type,
    has_children: true,
    in_trash: input.inTrash ?? false,
    parent: { type: "page_id", page_id: input.parentPageId ?? pageId },
    [type]: {
      title: [{ plain_text: "Product sync" }],
      status: "notes_ready",
      children: {
        summary_block_id: input.summaryBlockId ?? "summary-block",
        notes_block_id: input.notesBlockId ?? "notes-block",
        transcript_block_id: input.transcriptBlockId ?? "transcript-block"
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
  return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
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
      reader.listBlockChildren({ blockId: "summary-block" })
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
      { blockId: "summary-block" }
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
    await expect(reader.retrievePage({ pageId: "another-page" })).rejects.toMatchObject({
      code: "notion-object-scoped-reader-page-forbidden"
    });
    expect(transport.pageCalls).toEqual([]);
    expect(transport.markdownCalls).toEqual([]);
    expect(transport.blockCalls).toEqual([]);

    await expect(reader.retrievePage({ pageId })).resolves.toMatchObject({ id: pageId });
    await expect(
      reader.retrievePageMarkdown({ pageId: "another-page", includeTranscript: true })
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
            id: "ordinary-page-sibling",
            parentBlockId: pageId,
            hasChildren: true
          }),
          parent: { type: "page_id", page_id: pageId }
        }
      ])
    );
    transport.blockMaterial.set(
      "summary-block:first",
      rawBlockList([
        rawChildBlock({
          id: "safe-summary-descendant",
          parentBlockId: "summary-block",
          hasChildren: true
        }),
        rawChildBlock({
          id: "nested-page",
          parentBlockId: "summary-block",
          type: "child_page",
          hasChildren: true
        }),
        rawChildBlock({
          id: "nested-database",
          parentBlockId: "summary-block",
          type: "child_database",
          hasChildren: true
        }),
        rawChildBlock({
          id: "external-synced-block",
          parentBlockId: "summary-block",
          type: "synced_block",
          hasChildren: true
        })
      ])
    );
    transport.blockMaterial.set("safe-summary-descendant:first", rawBlockList([]));
    const reader = createTestReader(transport);

    await reader.retrievePage({ pageId });
    await expect(
      reader.retrievePageMarkdown({ pageId, includeTranscript: true })
    ).resolves.toMatchObject({
      unknownBlockIds: ["markdown-unknown-block"]
    });
    await reader.listBlockChildren({ blockId: pageId });

    for (const blockId of [
      "meeting-notes-root",
      "ordinary-page-sibling",
      "markdown-unknown-block",
      "arbitrary-block"
    ]) {
      await expect(reader.listBlockChildren({ blockId })).rejects.toMatchObject({
        code: "notion-object-scoped-reader-block-forbidden"
      });
    }

    await reader.listBlockChildren({ blockId: "summary-block" });
    await reader.listBlockChildren({ blockId: "safe-summary-descendant" });

    for (const blockId of ["nested-page", "nested-database", "external-synced-block"]) {
      await expect(reader.listBlockChildren({ blockId })).rejects.toMatchObject({
        code: "notion-object-scoped-reader-block-forbidden"
      });
    }

    expect(transport.blockCalls).toEqual([
      { blockId: pageId },
      { blockId: "summary-block" },
      { blockId: "safe-summary-descendant" }
    ]);
  });

  it("accepts a validated legacy transcription root as a documented pointer source", async () => {
    const transport = new ProgrammableExactPageTransport();
    transport.blockMaterial.set(
      `${pageId}:first`,
      rawBlockList([rawMeetingNotesRoot({ type: "transcription" })])
    );
    transport.blockMaterial.set("summary-block:first", rawBlockList([]));
    const reader = createTestReader(transport);

    await reader.retrievePage({ pageId });
    await reader.listBlockChildren({ blockId: pageId });
    await expect(
      reader.listBlockChildren({ blockId: "summary-block" })
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
        reader.listBlockChildren({ blockId: "summary-block" })
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
      reader.listBlockChildren({ blockId: "summary-block" })
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
      wrongRootParentReader.listBlockChildren({ blockId: "summary-block" })
    ).rejects.toMatchObject({ code: "notion-object-scoped-reader-block-forbidden" });
    expect(wrongRootParent.blockCalls).toEqual([{ blockId: pageId }]);

    const wrongDescendantParent = new ProgrammableExactPageTransport();
    wrongDescendantParent.blockMaterial.set(
      `${pageId}:first`,
      rawBlockList([rawMeetingNotesRoot()])
    );
    wrongDescendantParent.blockMaterial.set(
      "summary-block:first",
      rawBlockList([
        rawChildBlock({
          id: "wrong-parent-child",
          parentBlockId: "another-summary-block",
          hasChildren: true
        })
      ])
    );
    const wrongDescendantParentReader = createTestReader(wrongDescendantParent);

    await wrongDescendantParentReader.retrievePage({ pageId });
    await wrongDescendantParentReader.listBlockChildren({ blockId: pageId });
    await expect(
      wrongDescendantParentReader.listBlockChildren({ blockId: "summary-block" })
    ).rejects.toMatchObject({ code: "source-invalid" });
    await expect(
      wrongDescendantParentReader.listBlockChildren({ blockId: "wrong-parent-child" })
    ).rejects.toMatchObject({ code: "notion-object-scoped-reader-block-forbidden" });
    expect(wrongDescendantParent.blockCalls).toEqual([
      { blockId: pageId },
      { blockId: "summary-block" }
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
    transport.blockMaterial.set("summary-block:first", rawBlockList([]));
    const reader = createTestReader(transport);

    await reader.retrievePage({ pageId });
    await expect(reader.listBlockChildren({ blockId: pageId })).resolves.toMatchObject({
      nextCursor: "root-cursor"
    });
    await expect(
      reader.listBlockChildren({ blockId: "summary-block" })
    ).rejects.toMatchObject({
      code: "notion-object-scoped-reader-block-forbidden"
    });
    await expect(
      reader.listBlockChildren({ blockId: "root-cursor", cursor: "root-cursor" })
    ).rejects.toMatchObject({ code: "notion-object-scoped-reader-block-forbidden" });

    await expect(
      reader.listBlockChildren({ blockId: pageId, cursor: "root-cursor" })
    ).resolves.toMatchObject({ nextCursor: null });
    await expect(
      reader.listBlockChildren({ blockId: pageId, cursor: "root-cursor" })
    ).rejects.toMatchObject({ code: "notion-object-scoped-reader-cursor-forbidden" });
    await expect(
      reader.listBlockChildren({ blockId: "summary-block", cursor: "root-cursor" })
    ).rejects.toMatchObject({ code: "notion-object-scoped-reader-cursor-forbidden" });

    for (let index = 0; index < 100; index += 1) {
      await reader.listBlockChildren({ blockId: "summary-block" });
    }

    await expect(
      reader.listBlockChildren({ blockId: "summary-block" })
    ).rejects.toMatchObject({
      code: "notion-object-scoped-reader-budget-exhausted"
    });
    expect(
      transport.blockCalls.filter((call) => call.blockId === "summary-block")
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
