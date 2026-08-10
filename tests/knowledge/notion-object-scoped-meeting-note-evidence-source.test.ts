import { describe, expect, it } from "vitest";
import {
  createNotionObjectScopedMeetingNoteEvidenceSource,
  type NotionObjectScopedMeetingNoteEvidenceReader,
  type NotionObjectScopedMeetingNoteEvidenceSession
} from "../../src/knowledge/notion-object-scoped-meeting-note-evidence-source.js";
import {
  NotionMeetingNotesReadError,
  type NotionMeetingNotesBlock
} from "../../src/knowledge/notion-meeting-notes-source.js";
import { renderOperationalOutcomeMarkdown } from "../../src/knowledge/operational-outcome-markdown.js";
import type { OperationalOutcomeMarkerVerifier } from "../../src/knowledge/operational-outcome-writer.js";

const workspaceId = "workspace_dayova";
const providerId = "notion";
const pageId = "11111111-2222-4333-8444-555555555555";

class CompleteMeetingNoteReader implements NotionObjectScopedMeetingNoteEvidenceReader {
  readonly pageCalls: string[] = [];
  readonly blockCalls: Array<{ blockId: string; cursor?: string }> = [];
  readonly markdownCalls: Array<{ pageId: string; includeTranscript: boolean }> = [];

  async capture<T>(
    operation: (reader: NotionObjectScopedMeetingNoteEvidenceSession) => Promise<T>
  ): Promise<T> {
    let active = true;
    const session = Object.freeze({
      retrievePage: (input: { pageId: string }) =>
        active
          ? this.retrievePage(input)
          : Promise.reject(
              new Error("The deterministic exact-page reader session has expired")
            ),
      listBlockChildren: (input: { blockId: string; cursor?: string }) =>
        active
          ? this.listBlockChildren(input)
          : Promise.reject(
              new Error("The deterministic exact-page reader session has expired")
            ),
      retrievePageMarkdown: (input: { pageId: string; includeTranscript: boolean }) =>
        active
          ? this.retrievePageMarkdown(input)
          : Promise.reject(
              new Error("The deterministic exact-page reader session has expired")
            )
    } satisfies NotionObjectScopedMeetingNoteEvidenceSession);

    try {
      return await operation(session);
    } finally {
      active = false;
    }
  }

  retrievePage(input: { pageId: string }) {
    this.pageCalls.push(input.pageId);

    return Promise.resolve({
      id: pageId,
      title: "Product sync",
      url: "https://notion.so/product-sync",
      lastEditedAt: "2026-08-10T09:00:00.000Z",
      inTrash: false
    });
  }

  listBlockChildren(input: { blockId: string; cursor?: string }) {
    this.blockCalls.push({ ...input });
    const result = this.blocks[`${input.blockId}:${input.cursor ?? "first"}`];

    if (!result) {
      return Promise.reject(new Error(`Unexpected block read: ${input.blockId}`));
    }

    return Promise.resolve(result);
  }

  retrievePageMarkdown(input: { pageId: string; includeTranscript: boolean }) {
    this.markdownCalls.push({ ...input });

    return Promise.resolve({
      content: "# Product sync\n\nKeep the exact source evidence.",
      truncated: false,
      unknownBlockIds: []
    });
  }

  private readonly blocks: Record<
    string,
    { blocks: NotionMeetingNotesBlock[]; nextCursor: string | null }
  > = {
    "11111111-2222-4333-8444-555555555555:first": {
      blocks: [
        meetingNotesBlock({
          id: "22222222-3333-4444-8555-666666666666",
          summaryBlockId: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
          notesBlockId: "88888888-9999-4aaa-8bbb-cccccccccccc",
          transcriptBlockId: "77777777-8888-4999-8aaa-bbbbbbbbbbbc"
        })
      ],
      nextCursor: null
    },
    "22222222-3333-4444-8555-666666666666:first": {
      blocks: [
        block({ id: "99999999-aaaa-4bbb-8ccc-dddddddddddd", type: "paragraph" }),
        block({ id: "88888888-9999-4aaa-8bbb-cccccccccccc", type: "paragraph" }),
        block({ id: "77777777-8888-4999-8aaa-bbbbbbbbbbbc", type: "paragraph" })
      ],
      nextCursor: null
    },
    "99999999-aaaa-4bbb-8ccc-dddddddddddd:first": {
      blocks: [block({ id: "summary-line", type: "paragraph", text: "Ship safely." })],
      nextCursor: null
    },
    "88888888-9999-4aaa-8bbb-cccccccccccc:first": {
      blocks: [
        block({ id: "notes-line", type: "paragraph", text: "Keep it read-only." })
      ],
      nextCursor: null
    },
    "77777777-8888-4999-8aaa-bbbbbbbbbbbc:first": {
      blocks: [
        block({ id: "transcript-line", type: "paragraph", text: "Original speech." })
      ],
      nextCursor: null
    }
  };
}

describe("object-scoped Notion Meeting Note evidence source", () => {
  it("models callback sessions that expire after capture", async () => {
    const reader = new CompleteMeetingNoteReader();
    const escaped = await reader.capture((session) => Promise.resolve(session));

    await expect(escaped.retrievePage({ pageId })).rejects.toThrow("session has expired");
    expect(reader.pageCalls).toEqual([]);
  });

  it("captures its one configured page as provider-derived immutable Meeting Note evidence", async () => {
    const reader = new CompleteMeetingNoteReader();
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader,
      now: () => new Date("2026-08-10T09:01:00.000Z")
    });

    const result = await source.capture({
      workspaceId,
      page: { providerId, pageId }
    });

    expect(result).toMatchObject({
      status: "captured",
      evidence: {
        source: {
          providerId,
          sourceKind: "meeting-note",
          sourceObjectId: "22222222-3333-4444-8555-666666666666",
          parentObjectId: pageId,
          url: "https://www.notion.so/11111111-2222-4333-8444-555555555555"
        },
        providerVersion: "2026-08-10T09:00:00.000Z",
        observedAt: "2026-08-10T09:01:00.000Z",
        snapshot: {
          lifecycle: "ready",
          completeness: { state: "complete" },
          sections: {
            summary: { state: "available", text: "Ship safely." },
            actionItemsAndNotes: { state: "available", text: "Keep it read-only." },
            transcript: { state: "available", text: "Original speech." }
          }
        }
      }
    });
    expect(reader.pageCalls).toEqual([pageId, pageId]);
    expect(reader.markdownCalls).toEqual([{ pageId, includeTranscript: true }]);
    expect(reader.blockCalls).toEqual(
      expect.arrayContaining([
        { blockId: pageId },
        { blockId: "99999999-aaaa-4bbb-8ccc-dddddddddddd" },
        { blockId: "88888888-9999-4aaa-8bbb-cccccccccccc" },
        { blockId: "77777777-8888-4999-8aaa-bbbbbbbbbbbc" }
      ])
    );
  });

  it("fails closed when the exact page snapshot is incomplete", async () => {
    const reader = new TruncatedMarkdownReader();
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toEqual({
      status: "unavailable",
      code: "meeting-note-root-unreadable",
      message: "The configured Meeting Note root is not completely readable.",
      retryable: true
    });
  });

  it.each([
    {
      label: "workspace",
      request: {
        workspaceId: "workspace_other",
        page: { providerId, pageId }
      }
    },
    {
      label: "provider",
      request: {
        workspaceId,
        page: { providerId: "other-provider", pageId }
      }
    },
    {
      label: "page",
      request: {
        workspaceId,
        page: { providerId, pageId: "other-page" }
      }
    }
  ])("rejects a mismatched $label before any Notion read", async ({ request }) => {
    const reader = new CompleteMeetingNoteReader();
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(source.capture(request)).resolves.toMatchObject({
      status: "unavailable",
      code: "meeting-note-capture-unavailable",
      retryable: false
    });
    expect(reader.pageCalls).toEqual([]);
    expect(reader.blockCalls).toEqual([]);
    expect(reader.markdownCalls).toEqual([]);
  });

  it("fails closed when the provider returns a different page than the configured page", async () => {
    const reader = new ReturnedPageMismatchReader();
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toMatchObject({
      status: "unavailable",
      code: "meeting-note-page-unreadable",
      retryable: false
    });
    expect(reader.pageCalls).toEqual([pageId]);
    expect(reader.blockCalls).toEqual([]);
    expect(reader.markdownCalls).toEqual([]);
  });

  it("fails closed before child reads when the configured page is trashed", async () => {
    const reader = new TrashedPageReader();
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toMatchObject({
      status: "unavailable",
      code: "meeting-note-page-unreadable",
      retryable: false
    });
    expect(reader.pageCalls).toEqual([pageId]);
    expect(reader.blockCalls).toEqual([]);
    expect(reader.markdownCalls).toEqual([]);
  });

  it.each([
    {
      label: "no Meeting Note root",
      blocks: [block({ id: "ordinary-block", type: "paragraph", text: "ordinary" })],
      code: "meeting-note-root-missing"
    },
    {
      label: "multiple Meeting Note roots",
      blocks: [
        meetingNotesBlock({
          id: "first-root",
          summaryBlockId: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
          notesBlockId: "88888888-9999-4aaa-8bbb-cccccccccccc",
          transcriptBlockId: "77777777-8888-4999-8aaa-bbbbbbbbbbbc"
        }),
        meetingNotesBlock({
          id: "second-root",
          summaryBlockId: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
          notesBlockId: "88888888-9999-4aaa-8bbb-cccccccccccc",
          transcriptBlockId: "77777777-8888-4999-8aaa-bbbbbbbbbbbc"
        })
      ],
      code: "meeting-note-root-ambiguous"
    },
    {
      label: "an unknown root block",
      blocks: [
        meetingNotesBlock({
          id: "22222222-3333-4444-8555-666666666666",
          summaryBlockId: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
          notesBlockId: "88888888-9999-4aaa-8bbb-cccccccccccc",
          transcriptBlockId: "77777777-8888-4999-8aaa-bbbbbbbbbbbc"
        }),
        block({ id: "unknown-root", type: "unknown" })
      ],
      code: "meeting-note-root-unreadable"
    },
    {
      label: "a root without readable Meeting Notes metadata",
      blocks: [
        block({ id: "22222222-3333-4444-8555-666666666666", type: "meeting-notes" })
      ],
      code: "meeting-note-root-unreadable"
    }
  ])("fails closed for $label", async ({ blocks, code }) => {
    const reader = new RootBlocksReader(blocks);
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toMatchObject({ status: "unavailable", code });
    expect(reader.markdownCalls).toEqual([]);
  });

  it.each([
    {
      label: "a missing page",
      error: new NotionMeetingNotesReadError("source-not-found", "not found"),
      code: "meeting-note-page-unreadable",
      message: "The configured Meeting Note page could not be read.",
      retryable: false
    },
    {
      label: "a restricted page",
      error: new NotionMeetingNotesReadError("source-restricted", "restricted"),
      code: "meeting-note-page-unreadable",
      message: "The configured Meeting Note page could not be read.",
      retryable: false
    },
    {
      label: "a transient page read failure",
      error: new NotionMeetingNotesReadError("transient", "temporary"),
      code: "meeting-note-page-unreadable",
      message: "The configured Meeting Note page could not be read.",
      retryable: true
    }
  ])(
    "maps $label to a non-disclosing unavailable capture",
    async ({ error, code, message, retryable }) => {
      const reader = new FailingPageReader(error);
      const source = createNotionObjectScopedMeetingNoteEvidenceSource({
        workspaceId,
        providerId,
        pageId,
        reader
      });

      await expect(
        source.capture({ workspaceId, page: { providerId, pageId } })
      ).resolves.toEqual({ status: "unavailable", code, message, retryable });
      expect(reader.blockCalls).toEqual([]);
      expect(reader.markdownCalls).toEqual([]);
    }
  );

  it("fails closed on a repeated root pagination cursor", async () => {
    const reader = new RepeatingRootCursorReader();
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toMatchObject({
      status: "unavailable",
      code: "meeting-note-root-unreadable",
      retryable: false
    });
    expect(reader.markdownCalls).toEqual([]);
  });

  it("fails closed on a malformed root pagination cursor", async () => {
    const reader = new MalformedRootCursorReader();
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toMatchObject({
      status: "unavailable",
      code: "meeting-note-root-unreadable",
      retryable: false
    });
    expect(reader.markdownCalls).toEqual([]);
  });

  it("contains an untyped malformed capture request without reading Notion", async () => {
    const reader = new CompleteMeetingNoteReader();
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });
    const unsafeSource = source as unknown as {
      capture(input: unknown): Promise<unknown>;
    };

    await expect(unsafeSource.capture(null)).resolves.toMatchObject({
      status: "unavailable",
      code: "meeting-note-capture-unavailable",
      retryable: false
    });
    expect(reader.pageCalls).toEqual([]);
  });

  it("does not label a capture with a provider version that changed during the read", async () => {
    const reader = new ChangedVersionReader();
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toMatchObject({
      status: "unavailable",
      code: "meeting-note-page-unreadable",
      retryable: true
    });
    expect(reader.pageCalls).toEqual([pageId, pageId]);
  });

  it("fails closed if the final provider-version verification cannot be read", async () => {
    const reader = new FinalReadFailureReader();
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toEqual({
      status: "unavailable",
      code: "meeting-note-page-unreadable",
      message: "The configured Meeting Note page could not be read.",
      retryable: true
    });
    expect(reader.pageCalls).toEqual([pageId, pageId]);
  });

  it("does not return a capture when the page becomes trashed during final verification", async () => {
    const reader = new FinalTrashedPageReader();
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toEqual({
      status: "unavailable",
      code: "meeting-note-page-unreadable",
      message: "The configured Meeting Note page could not be verified.",
      retryable: false
    });
    expect(reader.pageCalls).toEqual([pageId, pageId]);
    expect(reader.markdownCalls).toEqual([{ pageId, includeTranscript: true }]);
  });

  it("fails closed when a Meeting Note section is unavailable", async () => {
    const reader = new RootBlocksReader([
      meetingNotesBlock({
        id: "22222222-3333-4444-8555-666666666666",
        summaryBlockId: null,
        notesBlockId: "88888888-9999-4aaa-8bbb-cccccccccccc",
        transcriptBlockId: "77777777-8888-4999-8aaa-bbbbbbbbbbbc"
      })
    ]);
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toMatchObject({
      status: "unavailable",
      code: "meeting-note-root-unreadable",
      retryable: false
    });
  });

  it("keeps a genuine not-ready lifecycle retryable without following unavailable pointers", async () => {
    const reader = new RootBlocksReader([
      meetingNotesBlock({
        id: "22222222-3333-4444-8555-666666666666",
        status: "transcribing",
        summaryBlockId: null,
        notesBlockId: null,
        transcriptBlockId: null
      })
    ]);
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toEqual({
      status: "unavailable",
      code: "meeting-note-root-unreadable",
      message: "The configured Meeting Note root could not be read safely.",
      retryable: true
    });
    expect(reader.blockCalls).toEqual([{ blockId: pageId }]);
    expect(reader.markdownCalls).toEqual([]);
  });

  it("keeps a cross-page section pointer nonretryable", async () => {
    const reader = new RootBlocksReader([
      meetingNotesBlock({
        id: "22222222-3333-4444-8555-666666666666",
        summaryBlockId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
        notesBlockId: "88888888-9999-4aaa-8bbb-cccccccccccc",
        transcriptBlockId: "77777777-8888-4999-8aaa-bbbbbbbbbbbc"
      })
    ]);
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toEqual({
      status: "unavailable",
      code: "meeting-note-root-unreadable",
      message: "The configured Meeting Note root could not be read safely.",
      retryable: false
    });
    expect(reader.markdownCalls).toEqual([]);
  });

  it.each([
    { label: "Markdown", reader: new UnreadableMarkdownReader() },
    { label: "a generated section", reader: new UnreadableSectionReader() }
  ])("fails closed when Notion restricts $label", async ({ reader }) => {
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toMatchObject({
      status: "unavailable",
      code: "meeting-note-root-unreadable",
      retryable: true
    });
  });

  it("strips a valid Luma-owned marker only after checking its durable ownership", async () => {
    const rendered = renderedOperationalOutcome();
    const reader = new MarkdownReader(
      `# Product sync\n\nCanonical source text.\n\n${rendered.section}`
    );
    const verifier = new RecordingMarkerVerifier(true);
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader,
      operationalOutcomeMarkerVerifier: verifier
    });

    const result = await source.capture({ workspaceId, page: { providerId, pageId } });

    expect(result).toMatchObject({
      status: "captured",
      evidence: {
        snapshot: {
          markdown: {
            content: "# Product sync\n\nCanonical source text."
          }
        }
      }
    });
    expect(verifier.calls).toEqual([
      {
        workspaceId,
        providerId,
        pageExternalId: pageId,
        payloadDigest: rendered.payloadDigest,
        contentDigest: rendered.contentDigest,
        operationDigest: rendered.operationDigest
      }
    ]);
  });

  it.each([
    {
      label: "a duplicated marker",
      markdown: () => {
        const rendered = renderedOperationalOutcome();
        return `${rendered.section}\n\n${rendered.section}`;
      },
      verifier: undefined,
      retryable: false
    },
    {
      label: "a valid marker without a verifier",
      markdown: () => renderedOperationalOutcome().section,
      verifier: undefined,
      retryable: false
    },
    {
      label: "a marker the verifier does not own",
      markdown: () => renderedOperationalOutcome().section,
      verifier: new RecordingMarkerVerifier(false),
      retryable: false
    },
    {
      label: "an unavailable marker verifier",
      markdown: () => renderedOperationalOutcome().section,
      verifier: new RecordingMarkerVerifier(new Error("verification unavailable")),
      retryable: true
    }
  ])(
    "fails closed for $label with a fixed non-disclosing message",
    async ({ markdown, verifier, retryable }) => {
      const reader = new MarkdownReader(markdown());
      const source = createNotionObjectScopedMeetingNoteEvidenceSource({
        workspaceId,
        providerId,
        pageId,
        reader,
        ...(verifier ? { operationalOutcomeMarkerVerifier: verifier } : {})
      });

      await expect(
        source.capture({ workspaceId, page: { providerId, pageId } })
      ).resolves.toEqual({
        status: "unavailable",
        code: "meeting-note-root-unreadable",
        message: "The configured Meeting Note root could not be read safely.",
        retryable
      });
    }
  );

  it("fails closed on malformed root result shape", async () => {
    const reader = new MalformedRootResultReader();
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toEqual({
      status: "unavailable",
      code: "meeting-note-root-unreadable",
      message: "The configured Meeting Note root could not be read safely.",
      retryable: false
    });
  });

  it("fails closed on a cyclic Meeting Note section tree", async () => {
    const reader = new CyclicSectionReader();
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toEqual({
      status: "unavailable",
      code: "meeting-note-root-unreadable",
      message: "The configured Meeting Note root could not be read safely.",
      retryable: false
    });
  });

  it("serializes wide descendant reads before source evidence can leave Notion", async () => {
    const reader = new WideDescendantReader();
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toMatchObject({
      status: "captured",
      evidence: { snapshot: { completeness: { state: "complete" } } }
    });
    expect(reader.childReadCount).toBe(2);
    expect(reader.maxConcurrentChildReads).toBe(1);
  });

  it("bounds root pagination before a provider can force an unbounded read", async () => {
    const reader = new ExcessiveRootPaginationReader();
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toMatchObject({
      status: "unavailable",
      code: "meeting-note-root-unreadable",
      retryable: false
    });
    expect(reader.blockCalls).toHaveLength(100);
    expect(reader.markdownCalls).toEqual([]);
  });

  it("rejects an oversized Meeting Note block page before it can enter the ledger", async () => {
    const reader = new ExcessiveSectionBlocksReader();
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toMatchObject({
      status: "unavailable",
      code: "meeting-note-root-unreadable",
      retryable: false
    });
  });

  it("bounds cumulative generated sections before they can enter the ledger", async () => {
    const reader = new CumulativeSectionBlocksReader();
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toMatchObject({
      status: "unavailable",
      code: "meeting-note-root-unreadable",
      retryable: false
    });
    expect(reader.summaryBlocksReturned).toBe(10_000);
    expect(
      reader.blockCalls.filter(
        (call) => call.blockId === "99999999-aaaa-4bbb-8ccc-dddddddddddd"
      )
    ).toHaveLength(100);
    expect(
      reader.blockCalls.some(
        (call) => call.blockId === "88888888-9999-4aaa-8bbb-cccccccccccc"
      )
    ).toBe(false);
  });

  it.each([
    { label: "an insecure page URL", reader: new InsecurePageReader() },
    { label: "a page ID with whitespace", reader: new WhitespacePageIdReader() },
    {
      label: "an attacker-controlled HTTPS host",
      reader: new UntrustedPageUrlReader("https://notion.so@evil.example/page")
    },
    {
      label: "Notion URL userinfo",
      reader: new UntrustedPageUrlReader("https://user@notion.so/page")
    },
    {
      label: "an arbitrary HTTPS host",
      reader: new UntrustedPageUrlReader("https://evil.example/page")
    },
    {
      label: "a non-default Notion HTTPS port",
      reader: new UntrustedPageUrlReader("https://notion.so:8443/page")
    }
  ])("fails closed for $label", async ({ reader }) => {
    const source = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId,
      providerId,
      pageId,
      reader
    });

    await expect(
      source.capture({ workspaceId, page: { providerId, pageId } })
    ).resolves.toMatchObject({
      status: "unavailable",
      code: "meeting-note-page-unreadable",
      retryable: false
    });
    expect(reader.blockCalls).toEqual([]);
  });

  it.each([" workspace_dayova", "workspace dayova", " "])(
    "rejects malformed opaque config identifier %j",
    (invalidWorkspaceId) => {
      expect(() =>
        createNotionObjectScopedMeetingNoteEvidenceSource({
          workspaceId: invalidWorkspaceId,
          providerId,
          pageId,
          reader: new CompleteMeetingNoteReader()
        })
      ).toThrow(/opaque identifier without whitespace/);
    }
  );

  it.each([
    "11111111-2222-4333-8444-555555555555#unexpected-path",
    "11111111-2222-4333-8444-555555555555/foreign-page"
  ])(
    "rejects an unsafe configured Notion page ID before any reader call",
    (unsafePageId) => {
      const reader = new CompleteMeetingNoteReader();

      expect(() =>
        createNotionObjectScopedMeetingNoteEvidenceSource({
          workspaceId,
          providerId,
          pageId: unsafePageId,
          reader
        })
      ).toThrow(/pageId must be a Notion UUID/);
      expect(reader.pageCalls).toEqual([]);
      expect(reader.blockCalls).toEqual([]);
      expect(reader.markdownCalls).toEqual([]);
    }
  );
});

class TruncatedMarkdownReader extends CompleteMeetingNoteReader {
  override retrievePageMarkdown(input: { pageId: string; includeTranscript: boolean }) {
    this.markdownCalls.push({ ...input });

    return Promise.resolve({
      content: "# Product sync\n\nOnly a partial source was available.",
      truncated: true,
      unknownBlockIds: []
    });
  }
}

class ReturnedPageMismatchReader extends CompleteMeetingNoteReader {
  override retrievePage(input: { pageId: string }) {
    this.pageCalls.push(input.pageId);

    return Promise.resolve({
      id: "other-page",
      title: "Other page",
      url: "https://notion.so/other-page",
      lastEditedAt: "2026-08-10T09:00:00.000Z",
      inTrash: false
    });
  }
}

class TrashedPageReader extends CompleteMeetingNoteReader {
  override retrievePage(input: { pageId: string }) {
    this.pageCalls.push(input.pageId);

    return Promise.resolve({
      id: pageId,
      title: "Product sync",
      url: "https://notion.so/product-sync",
      lastEditedAt: "2026-08-10T09:00:00.000Z",
      inTrash: true
    });
  }
}

class RootBlocksReader extends CompleteMeetingNoteReader {
  constructor(private readonly rootBlocks: NotionMeetingNotesBlock[]) {
    super();
  }

  override listBlockChildren(input: { blockId: string; cursor?: string }) {
    if (input.blockId === pageId && !input.cursor) {
      this.blockCalls.push({ ...input });
      return Promise.resolve({ blocks: this.rootBlocks, nextCursor: null });
    }

    return super.listBlockChildren(input);
  }
}

class FailingPageReader extends CompleteMeetingNoteReader {
  constructor(private readonly error: Error) {
    super();
  }

  override retrievePage(input: { pageId: string }) {
    this.pageCalls.push(input.pageId);
    return Promise.reject(this.error);
  }
}

class RepeatingRootCursorReader extends CompleteMeetingNoteReader {
  override listBlockChildren(input: { blockId: string; cursor?: string }) {
    if (input.blockId === pageId) {
      this.blockCalls.push({ ...input });
      return Promise.resolve({ blocks: [], nextCursor: "repeated-cursor" });
    }

    return super.listBlockChildren(input);
  }
}

class MalformedRootCursorReader extends CompleteMeetingNoteReader {
  override listBlockChildren(input: { blockId: string; cursor?: string }) {
    if (input.blockId === pageId) {
      this.blockCalls.push({ ...input });
      return Promise.resolve({
        blocks: [],
        nextCursor: ""
      });
    }

    return super.listBlockChildren(input);
  }
}

class ChangedVersionReader extends CompleteMeetingNoteReader {
  override retrievePage(input: { pageId: string }) {
    this.pageCalls.push(input.pageId);

    return Promise.resolve({
      id: pageId,
      title: "Product sync",
      url: "https://notion.so/product-sync",
      lastEditedAt:
        this.pageCalls.length === 1
          ? "2026-08-10T09:00:00.000Z"
          : "2026-08-10T09:02:00.000Z",
      inTrash: false
    });
  }
}

class FinalReadFailureReader extends CompleteMeetingNoteReader {
  override retrievePage(input: { pageId: string }) {
    this.pageCalls.push(input.pageId);

    return this.pageCalls.length === 2
      ? Promise.reject(new NotionMeetingNotesReadError("transient", "temporary"))
      : Promise.resolve({
          id: pageId,
          title: "Product sync",
          url: "https://notion.so/product-sync",
          lastEditedAt: "2026-08-10T09:00:00.000Z",
          inTrash: false
        });
  }
}

class FinalTrashedPageReader extends CompleteMeetingNoteReader {
  override retrievePage(input: { pageId: string }) {
    this.pageCalls.push(input.pageId);

    return Promise.resolve({
      id: pageId,
      title: "Product sync",
      url: "https://notion.so/product-sync",
      lastEditedAt: "2026-08-10T09:00:00.000Z",
      inTrash: this.pageCalls.length === 2
    });
  }
}

class MalformedRootResultReader extends CompleteMeetingNoteReader {
  override listBlockChildren(input: { blockId: string; cursor?: string }) {
    if (input.blockId === pageId) {
      this.blockCalls.push({ ...input });
      return Promise.resolve({
        blocks: "not-a-block-list" as unknown as NotionMeetingNotesBlock[],
        nextCursor: null
      });
    }

    return super.listBlockChildren(input);
  }
}

class CyclicSectionReader extends CompleteMeetingNoteReader {
  override listBlockChildren(input: { blockId: string; cursor?: string }) {
    if (input.blockId === "99999999-aaaa-4bbb-8ccc-dddddddddddd") {
      this.blockCalls.push({ ...input });
      return Promise.resolve({
        blocks: [
          block({
            id: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
            type: "paragraph",
            hasChildren: true,
            text: "A cyclic child."
          })
        ],
        nextCursor: null
      });
    }

    return super.listBlockChildren(input);
  }
}

class WideDescendantReader extends CompleteMeetingNoteReader {
  childReadCount = 0;
  maxConcurrentChildReads = 0;
  private activeChildReads = 0;

  override listBlockChildren(input: { blockId: string; cursor?: string }) {
    if (input.blockId === "99999999-aaaa-4bbb-8ccc-dddddddddddd") {
      this.blockCalls.push({ ...input });
      return Promise.resolve({
        blocks: [
          block({
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            type: "paragraph",
            hasChildren: true
          }),
          block({
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            type: "paragraph",
            hasChildren: true
          })
        ],
        nextCursor: null
      });
    }

    if (
      input.blockId === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" ||
      input.blockId === "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    ) {
      this.blockCalls.push({ ...input });
      this.childReadCount += 1;
      this.activeChildReads += 1;
      this.maxConcurrentChildReads = Math.max(
        this.maxConcurrentChildReads,
        this.activeChildReads
      );

      return new Promise<{ blocks: NotionMeetingNotesBlock[]; nextCursor: null }>(
        (resolve) => {
          setTimeout(() => {
            this.activeChildReads -= 1;
            resolve({ blocks: [], nextCursor: null });
          }, 5);
        }
      );
    }

    return super.listBlockChildren(input);
  }
}

class ExcessiveRootPaginationReader extends CompleteMeetingNoteReader {
  override listBlockChildren(input: { blockId: string; cursor?: string }) {
    if (input.blockId === pageId) {
      this.blockCalls.push({ ...input });
      return Promise.resolve({
        blocks: [],
        nextCursor: `cursor-${this.blockCalls.length}`
      });
    }

    return super.listBlockChildren(input);
  }
}

class ExcessiveSectionBlocksReader extends CompleteMeetingNoteReader {
  override listBlockChildren(input: { blockId: string; cursor?: string }) {
    if (input.blockId === "99999999-aaaa-4bbb-8ccc-dddddddddddd") {
      this.blockCalls.push({ ...input });
      return Promise.resolve({
        blocks: Array.from({ length: 10_001 }, (_, index) =>
          block({ id: `summary-${index}`, type: "paragraph", text: "bounded" })
        ),
        nextCursor: null
      });
    }

    return super.listBlockChildren(input);
  }
}

class CumulativeSectionBlocksReader extends CompleteMeetingNoteReader {
  summaryBlocksReturned = 0;

  override listBlockChildren(input: { blockId: string; cursor?: string }) {
    if (input.blockId === "99999999-aaaa-4bbb-8ccc-dddddddddddd") {
      this.blockCalls.push({ ...input });
      const page = input.cursor ? Number(input.cursor.replace("summary-cursor-", "")) : 0;

      const blocks = Array.from({ length: 100 }, (_, index) =>
        block({
          id: `summary-${page}-${index}`,
          type: "paragraph",
          text: "bounded"
        })
      );
      this.summaryBlocksReturned += blocks.length;

      return Promise.resolve({
        blocks,
        nextCursor: page === 99 ? null : `summary-cursor-${page + 1}`
      });
    }

    return super.listBlockChildren(input);
  }
}

class InsecurePageReader extends CompleteMeetingNoteReader {
  override retrievePage(input: { pageId: string }) {
    this.pageCalls.push(input.pageId);
    return Promise.resolve({
      id: pageId,
      title: "Product sync",
      url: "http://notion.so/product-sync",
      lastEditedAt: "2026-08-10T09:00:00.000Z",
      inTrash: false
    });
  }
}

class WhitespacePageIdReader extends CompleteMeetingNoteReader {
  override retrievePage(input: { pageId: string }) {
    this.pageCalls.push(input.pageId);
    return Promise.resolve({
      id: `${pageId} `,
      title: "Product sync",
      url: "https://notion.so/product-sync",
      lastEditedAt: "2026-08-10T09:00:00.000Z",
      inTrash: false
    });
  }
}

class UntrustedPageUrlReader extends CompleteMeetingNoteReader {
  constructor(private readonly url: string) {
    super();
  }

  override retrievePage(input: { pageId: string }) {
    this.pageCalls.push(input.pageId);
    return Promise.resolve({
      id: pageId,
      title: "Product sync",
      url: this.url,
      lastEditedAt: "2026-08-10T09:00:00.000Z",
      inTrash: false
    });
  }
}

class MarkdownReader extends CompleteMeetingNoteReader {
  constructor(private readonly markdown: string) {
    super();
  }

  override retrievePageMarkdown(input: { pageId: string; includeTranscript: boolean }) {
    this.markdownCalls.push({ ...input });

    return Promise.resolve({
      content: this.markdown,
      truncated: false,
      unknownBlockIds: []
    });
  }
}

class UnreadableMarkdownReader extends CompleteMeetingNoteReader {
  override retrievePageMarkdown(input: { pageId: string; includeTranscript: boolean }) {
    this.markdownCalls.push({ ...input });
    return Promise.reject(new NotionMeetingNotesReadError("source-restricted", "hidden"));
  }
}

class UnreadableSectionReader extends CompleteMeetingNoteReader {
  override listBlockChildren(input: { blockId: string; cursor?: string }) {
    if (input.blockId === "99999999-aaaa-4bbb-8ccc-dddddddddddd") {
      this.blockCalls.push({ ...input });
      return Promise.reject(
        new NotionMeetingNotesReadError("source-restricted", "hidden")
      );
    }

    return super.listBlockChildren(input);
  }
}

type MarkerVerifierInput = Parameters<OperationalOutcomeMarkerVerifier["isOwned"]>[0];

class RecordingMarkerVerifier implements OperationalOutcomeMarkerVerifier {
  readonly calls: MarkerVerifierInput[] = [];

  constructor(private readonly result: boolean | Error) {}

  isOwned(input: MarkerVerifierInput): Promise<boolean> {
    this.calls.push(input);
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result);
  }
}

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

function meetingNotesBlock(input: {
  id: string;
  status?: string | null;
  summaryBlockId: string | null;
  notesBlockId: string | null;
  transcriptBlockId: string | null;
}): NotionMeetingNotesBlock {
  return block({
    id: input.id,
    type: "meeting-notes",
    hasChildren: true,
    meetingNotes: {
      title: "Product sync",
      status: input.status ?? "notes_ready",
      summaryBlockId: input.summaryBlockId,
      notesBlockId: input.notesBlockId,
      transcriptBlockId: input.transcriptBlockId,
      calendar: {
        startAt: "2026-08-10T08:00:00.000Z",
        endAt: "2026-08-10T08:30:00.000Z",
        attendeeProviderUserIds: ["notion-user-jakob"]
      },
      recording: null
    }
  });
}

function renderedOperationalOutcome() {
  return renderOperationalOutcomeMarkdown({
    idempotencyKey: "workspace_dayova:meeting-1:settlement-1:outcome",
    outcome: {
      formatVersion: 1,
      operationToken: "test-operation-token:meeting-1:settlement-1",
      scope: {
        workspaceId,
        providerId,
        pageExternalId: pageId
      },
      entries: [
        {
          settlementIntentId: "settlement-1",
          source: {
            sourceObjectId: "22222222-3333-4444-8555-666666666666",
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
