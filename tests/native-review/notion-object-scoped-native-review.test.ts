import { describe, expect, it } from "vitest";
import type {
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../../src/ai/reasoning-model.js";
import { createDormantSourceBoundNativeReview } from "../../src/app/dormant-source-bound-native-review.js";
import { createStaticIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import type { IdentityDirectory } from "../../src/identity/interface.js";
import type { NotionObjectScopedMeetingNoteEvidenceReader } from "../../src/knowledge/notion-object-scoped-meeting-note-evidence-source.js";
import type { NotionMeetingNotesBlock } from "../../src/knowledge/notion-meeting-notes-source.js";
import type { OperationalOutcomeMarkerVerifier } from "../../src/knowledge/operational-outcome-writer.js";
import type { SourceBoundNativeReviewRequest } from "../../src/native-review/source-bound-native-review.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import {
  createLinearReadOnlyApiForTest,
  createLinearReadOnlyWorkCatalogForTest,
  type LinearReadOnlyApiIssue,
  type LinearReadOnlyWorkCatalog
} from "../../src/work/linear-read-only-work-catalog.js";
import { toWorkCatalog, type WorkProvider } from "../../src/work/interface.js";

const workspace = {
  workspaceId: "workspace_dayova",
  timezone: "Europe/Berlin"
};
const providerId = "notion";
const pageId = "notion-page-product-sync";
const neverOwnedOperationalOutcomeMarker: OperationalOutcomeMarkerVerifier = {
  isOwned: () => Promise.resolve(false)
};

class NoAnalysisReasoningModel implements ReasoningModel {
  generateStructured<T>(
    _request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    void _request;
    return Promise.reject(
      new Error("source reconciliation must not invoke model analysis")
    );
  }
}

class ExactPageReader implements NotionObjectScopedMeetingNoteEvidenceReader {
  readonly pageCalls: string[] = [];
  readonly blockCalls: Array<{ blockId: string; cursor?: string }> = [];
  readonly markdownCalls: Array<{ pageId: string; includeTranscript: boolean }> = [];

  retrievePage(input: { pageId: string }) {
    this.pageCalls.push(input.pageId);
    return Promise.resolve({
      id: pageId,
      title: "Product sync",
      url: "https://www.notion.so/product-sync",
      lastEditedAt: "2026-08-10T09:00:00.000Z",
      inTrash: false
    });
  }

  listBlockChildren(input: { blockId: string; cursor?: string }) {
    this.blockCalls.push({ ...input });
    const result = this.blocks[`${input.blockId}:${input.cursor ?? "first"}`];

    return result
      ? Promise.resolve(result)
      : Promise.reject(new Error(`Unexpected exact-page read: ${input.blockId}`));
  }

  retrievePageMarkdown(input: { pageId: string; includeTranscript: boolean }) {
    this.markdownCalls.push({ ...input });
    return Promise.resolve({
      content: "# Product sync",
      truncated: false,
      unknownBlockIds: []
    });
  }

  private readonly blocks: Record<
    string,
    { blocks: NotionMeetingNotesBlock[]; nextCursor: string | null }
  > = {
    "notion-page-product-sync:first": {
      blocks: [
        block({
          id: "meeting-notes-root",
          type: "meeting-notes",
          hasChildren: true,
          meetingNotes: {
            title: "Product sync",
            status: "notes_ready",
            summaryBlockId: "summary-block",
            notesBlockId: "notes-block",
            transcriptBlockId: "transcript-block",
            calendar: {
              startAt: "2026-08-10T08:00:00.000Z",
              endAt: "2026-08-10T08:30:00.000Z",
              attendeeProviderUserIds: ["notion-user-jakob"]
            },
            recording: null
          }
        })
      ],
      nextCursor: null
    },
    "summary-block:first": {
      blocks: [block({ id: "summary-line", type: "paragraph", text: "Review work." })],
      nextCursor: null
    },
    "notes-block:first": {
      blocks: [
        block({
          id: "action-item-1",
          type: "to-do",
          text: "Jakob will review LUM-301 by Friday.",
          checked: false
        })
      ],
      nextCursor: null
    },
    "transcript-block:first": {
      blocks: [
        block({
          id: "transcript-line",
          type: "paragraph",
          text: "Original speech stays canonical."
        })
      ],
      nextCursor: null
    }
  };
}

class TruncatedExactPageReader extends ExactPageReader {
  override retrievePageMarkdown(input: { pageId: string; includeTranscript: boolean }) {
    this.markdownCalls.push({ ...input });
    return Promise.resolve({
      content: "# Product sync\n\nThis source is incomplete.",
      truncated: true,
      unknownBlockIds: []
    });
  }
}

class FinalTrashedExactPageReader extends ExactPageReader {
  override retrievePage(input: { pageId: string }) {
    this.pageCalls.push(input.pageId);

    return Promise.resolve({
      id: pageId,
      title: "Product sync",
      url: "https://www.notion.so/product-sync",
      lastEditedAt: "2026-08-10T09:00:00.000Z",
      inTrash: this.pageCalls.length === 2
    });
  }
}

class RecordingLinearReadOnlyApi {
  readonly searchCalls: Array<{ teamId: string; text: string; limit: number }> = [];
  readonly getCalls: string[] = [];

  searchIssues(input: {
    teamId: string;
    text: string;
    limit: number;
  }): Promise<LinearReadOnlyApiIssue[]> {
    this.searchCalls.push({ ...input });
    return Promise.resolve([linearReadOnlyIssue()]);
  }

  getIssue(id: string): Promise<LinearReadOnlyApiIssue> {
    this.getCalls.push(id);
    return id === "issue-301"
      ? Promise.resolve(linearReadOnlyIssue())
      : Promise.reject(new Error(`Unexpected read-only issue: ${id}`));
  }
}

describe("dormant source-bound native review composition", () => {
  it("returns only a revision-pinned review from one exact page and a separately scoped read-only catalog", async () => {
    const database = await createPgliteDatabase();
    const reader = new ExactPageReader();
    const linearApi = new RecordingLinearReadOnlyApi();
    const readOnlyCatalog = createLinearReadOnlyWorkCatalogForTest({
      teamId: "team-dayova",
      api: createLinearReadOnlyApiForTest({
        searchIssues: (input) => linearApi.searchIssues(input),
        getIssue: (id) => linearApi.getIssue(id)
      })
    });
    const review = createDormantSourceBoundNativeReview({
      database,
      workspace,
      identityDirectory: createStaticIdentityDirectory({
        people: [
          {
            personId: "person_jakob",
            displayName: "Jakob",
            discordUserId: null,
            discordUsername: null,
            githubLogin: null,
            githubUserId: null,
            atlassianAccountId: null,
            notionUserId: "notion-user-jakob",
            linearUserId: "linear-user-jakob",
            languagePreference: "auto"
          }
        ]
      }),
      reasoningModel: new NoAnalysisReasoningModel(),
      reader,
      operationalOutcomeMarkerVerifier: neverOwnedOperationalOutcomeMarker,
      page: { providerId, pageId },
      readOnlyWorkCatalog: readOnlyCatalog,
      now: () => new Date("2026-08-10T09:02:00.000Z")
    });

    try {
      expect(reader.pageCalls).toEqual([]);
      expect(reader.blockCalls).toEqual([]);
      expect(reader.markdownCalls).toEqual([]);
      expect(linearApi.searchCalls).toEqual([]);
      expect(linearApi.getCalls).toEqual([]);

      const receipt = await review.review(nativeReviewRequest());

      expect(receipt).toMatchObject({
        workspaceId: workspace.workspaceId,
        source: { providerId, sourceObjectId: "meeting-notes-root", revision: 1 },
        outcome: {
          type: "reviewed",
          workReferences: [{ providerId: "linear", lookupId: "issue-301" }]
        }
      });
      expect(receipt.source?.contentHash).toMatch(/^sha256:/);
      expect(reader.pageCalls).toEqual([pageId, pageId]);
      expect(reader.markdownCalls).toEqual([{ pageId, includeTranscript: true }]);
      expect(reader.blockCalls).toEqual(
        expect.arrayContaining([
          { blockId: pageId },
          { blockId: "summary-block" },
          { blockId: "notes-block" },
          { blockId: "transcript-block" }
        ])
      );
      expect("listDataSourcePages" in reader).toBe(false);
      expect(linearApi.searchCalls).toEqual([
        { teamId: "team-dayova", text: "LUM-301", limit: 10 },
        {
          teamId: "team-dayova",
          text: "Jakob will review LUM-301 by Friday.",
          limit: 10
        }
      ]);
      expect(linearApi.getCalls).toEqual(["issue-301"]);
      await expect(
        database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM follow_up_executions
            WHERE workspace_id = $1`,
          [workspace.workspaceId]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
      expect("searchWorkItems" in review).toBe(false);
      expect("createWorkItem" in review).toBe(false);
    } finally {
      await database.close();
    }
  });

  it.each([
    ["page", { providerId, pageId: "notion-page-other" }],
    ["provider", { providerId: "other-notion", pageId }]
  ])(
    "refuses a different %s before any Notion, ledger, or Linear read",
    async (_kind, page) => {
      const harness = await createCompositionHarness();

      try {
        const receipt = await harness.review.review(
          nativeReviewRequest({
            nativeRunId: `native-notion-run-wrong-${_kind}`,
            page
          })
        );

        expect(receipt).toMatchObject({
          source: null,
          outcome: {
            type: "needs-clarification",
            code: "meeting-note-capture-unavailable",
            retryable: false
          }
        });
        expect(harness.reader.pageCalls).toEqual([]);
        expect(harness.reader.blockCalls).toEqual([]);
        expect(harness.reader.markdownCalls).toEqual([]);
        expect(harness.linearApi.searchCalls).toEqual([]);
        expect(harness.linearApi.getCalls).toEqual([]);
        await expect(
          harness.database.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count
             FROM observed_source_snapshots
            WHERE workspace_id = $1`,
            [workspace.workspaceId]
          )
        ).resolves.toMatchObject({ rows: [{ count: 0 }] });
        await expect(
          harness.database.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count
             FROM meeting_observations
            WHERE workspace_id = $1`,
            [workspace.workspaceId]
          )
        ).resolves.toMatchObject({ rows: [{ count: 0 }] });
      } finally {
        await harness.database.close();
      }
    }
  );

  it("replays one native run without another capture, Linear read, or durable observation", async () => {
    const harness = await createCompositionHarness();

    try {
      const first = await harness.review.review(nativeReviewRequest());
      const snapshotsAfterFirst = await workspaceRowCount(
        harness.database,
        "observed_source_snapshots"
      );
      const observationsAfterFirst = await workspaceRowCount(
        harness.database,
        "meeting_observations"
      );
      expect(snapshotsAfterFirst).toBe(1);
      expect(observationsAfterFirst).toBe(1);

      const replay = await harness.review.review(nativeReviewRequest());

      expect(replay).toEqual(first);
      expect(harness.reader.pageCalls).toEqual([pageId, pageId]);
      expect(harness.reader.markdownCalls).toEqual([{ pageId, includeTranscript: true }]);
      expect(harness.linearApi.searchCalls).toHaveLength(2);
      expect(harness.linearApi.getCalls).toEqual(["issue-301"]);
      await expect(
        workspaceRowCount(harness.database, "observed_source_snapshots")
      ).resolves.toBe(snapshotsAfterFirst);
      await expect(
        workspaceRowCount(harness.database, "meeting_observations")
      ).resolves.toBe(observationsAfterFirst);
    } finally {
      await harness.database.close();
    }
  });

  it("rejects a narrowed writer catalog even when a caller erases its type", async () => {
    const database = await createPgliteDatabase();
    const writer = writerCatalog();
    const narrowedWriterCatalog = toWorkCatalog(writer);

    try {
      expect(() =>
        createDormantSourceBoundNativeReview({
          database,
          workspace,
          identityDirectory: nativeIdentityDirectory(),
          reasoningModel: new NoAnalysisReasoningModel(),
          reader: new ExactPageReader(),
          operationalOutcomeMarkerVerifier: neverOwnedOperationalOutcomeMarker,
          page: { providerId, pageId },
          readOnlyWorkCatalog:
            narrowedWriterCatalog as unknown as LinearReadOnlyWorkCatalog
        })
      ).toThrow("requires a catalog created by the dedicated Linear read-only factory");
      expect(writer.searchCalls).toEqual([]);
      expect(writer.getCalls).toEqual([]);
      expect(writer.createCalls).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("stops incomplete exact-page evidence before durable capture, Meeting Intelligence, or Linear reads", async () => {
    const harness = await createCompositionHarness({
      reader: new TruncatedExactPageReader()
    });

    try {
      const receipt = await harness.review.review(
        nativeReviewRequest({ nativeRunId: "native-notion-run-incomplete" })
      );

      expect(receipt).toMatchObject({
        source: null,
        outcome: {
          type: "needs-clarification",
          code: "meeting-note-root-unreadable",
          retryable: false
        }
      });
      expect(harness.linearApi.searchCalls).toEqual([]);
      expect(harness.linearApi.getCalls).toEqual([]);
      await expect(
        harness.database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM observed_source_snapshots
            WHERE workspace_id = $1`,
          [workspace.workspaceId]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(
        harness.database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM meeting_observations
            WHERE workspace_id = $1`,
          [workspace.workspaceId]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await harness.database.close();
    }
  });

  it("stops an exact page trashed during final verification before durable capture or Linear reads", async () => {
    const harness = await createCompositionHarness({
      reader: new FinalTrashedExactPageReader()
    });

    try {
      const receipt = await harness.review.review(
        nativeReviewRequest({ nativeRunId: "native-notion-run-final-trash" })
      );

      expect(receipt).toMatchObject({
        source: null,
        outcome: {
          type: "needs-clarification",
          code: "meeting-note-page-unreadable",
          retryable: false
        }
      });
      expect(harness.reader.pageCalls).toEqual([pageId, pageId]);
      expect(harness.linearApi.searchCalls).toEqual([]);
      expect(harness.linearApi.getCalls).toEqual([]);
      await expect(
        harness.database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM observed_source_snapshots
            WHERE workspace_id = $1`,
          [workspace.workspaceId]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(
        harness.database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM meeting_observations
            WHERE workspace_id = $1`,
          [workspace.workspaceId]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await harness.database.close();
    }
  });

  it("does not treat a page share or forged person claim as trusted native identity", async () => {
    const harness = await createCompositionHarness({
      identityDirectory: createStaticIdentityDirectory({ people: [] })
    });

    try {
      const request = nativeReviewRequest({
        nativeRunId: "native-notion-run-unmapped"
      }) as SourceBoundNativeReviewRequest & {
        actor: SourceBoundNativeReviewRequest["actor"] & { personId: string };
      };
      request.actor.personId = "person_jakob";

      const receipt = await harness.review.review(request);

      expect(receipt).toMatchObject({
        actor: { personId: null },
        source: null,
        outcome: {
          type: "needs-clarification",
          code: "native-actor-unmapped",
          retryable: false
        }
      });
      expect(harness.reader.pageCalls).toEqual([]);
      expect(harness.linearApi.searchCalls).toEqual([]);
      expect(harness.linearApi.getCalls).toEqual([]);
      await expect(
        harness.database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM observed_source_snapshots
            WHERE workspace_id = $1`,
          [workspace.workspaceId]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(
        harness.database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM meeting_observations
            WHERE workspace_id = $1`,
          [workspace.workspaceId]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await harness.database.close();
    }
  });
});

function block(
  overrides: Partial<NotionMeetingNotesBlock> &
    Pick<NotionMeetingNotesBlock, "id" | "type">
): NotionMeetingNotesBlock {
  return { text: null, checked: null, hasChildren: false, ...overrides };
}

function linearReadOnlyIssue(): LinearReadOnlyApiIssue {
  return {
    id: "issue-301",
    teamId: "team-dayova",
    identifier: "LUM-301",
    title: "Prepare the release checklist",
    description: "Prepare the release checklist.",
    stateType: "started",
    stateName: "In Progress",
    assignee: null,
    dueDate: null,
    labels: [],
    projectId: null,
    parentId: null,
    url: "https://linear.app/dayova/issue/LUM-301",
    updatedAt: "2026-08-10T09:00:00.000Z"
  };
}

function nativeReviewRequest(
  overrides: Partial<SourceBoundNativeReviewRequest> = {}
): SourceBoundNativeReviewRequest {
  return {
    nativeRunId: "native-notion-run-composition-1",
    actor: { identityProviderId: "notion", providerUserId: "notion-user-jakob" },
    page: { providerId, pageId },
    ...overrides
  };
}

async function createCompositionHarness(
  input: {
    reader?: ExactPageReader;
    identityDirectory?: IdentityDirectory;
  } = {}
): Promise<{
  database: Awaited<ReturnType<typeof createPgliteDatabase>>;
  reader: ExactPageReader;
  linearApi: RecordingLinearReadOnlyApi;
  review: ReturnType<typeof createDormantSourceBoundNativeReview>;
}> {
  const database = await createPgliteDatabase();
  const reader = input.reader ?? new ExactPageReader();
  const linearApi = new RecordingLinearReadOnlyApi();
  const readOnlyWorkCatalog = createLinearReadOnlyWorkCatalogForTest({
    teamId: "team-dayova",
    api: createLinearReadOnlyApiForTest({
      searchIssues: (input) => linearApi.searchIssues(input),
      getIssue: (id) => linearApi.getIssue(id)
    })
  });

  return {
    database,
    reader,
    linearApi,
    review: createDormantSourceBoundNativeReview({
      database,
      workspace,
      identityDirectory: input.identityDirectory ?? nativeIdentityDirectory(),
      reasoningModel: new NoAnalysisReasoningModel(),
      reader,
      operationalOutcomeMarkerVerifier: neverOwnedOperationalOutcomeMarker,
      page: { providerId, pageId },
      readOnlyWorkCatalog,
      now: () => new Date("2026-08-10T09:02:00.000Z")
    })
  };
}

async function workspaceRowCount(
  database: Awaited<ReturnType<typeof createPgliteDatabase>>,
  table: "observed_source_snapshots" | "meeting_observations"
): Promise<number> {
  const result = await database.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM ${table}
      WHERE workspace_id = $1`,
    [workspace.workspaceId]
  );
  return result.rows[0]?.count ?? 0;
}

function nativeIdentityDirectory() {
  return createStaticIdentityDirectory({
    people: [
      {
        personId: "person_jakob",
        displayName: "Jakob",
        discordUserId: null,
        discordUsername: null,
        githubLogin: null,
        githubUserId: null,
        atlassianAccountId: null,
        notionUserId: "notion-user-jakob",
        linearUserId: "linear-user-jakob",
        languagePreference: "auto"
      }
    ]
  });
}

function writerCatalog(): WorkProvider & {
  searchCalls: string[];
  getCalls: string[];
  createCalls: string[];
} {
  const searchCalls: string[] = [];
  const getCalls: string[] = [];
  const createCalls: string[] = [];

  return {
    providerId: "linear",
    searchCalls,
    getCalls,
    createCalls,
    searchWorkItems(query) {
      searchCalls.push(query.text);
      return Promise.resolve([]);
    },
    getWorkItem(id) {
      getCalls.push(id);
      return Promise.reject(new Error("writer catalog must remain unreachable"));
    },
    createWorkItem(input) {
      createCalls.push(input.title);
      return Promise.reject(new Error("writer catalog must remain unreachable"));
    },
    updateWorkItem() {
      return Promise.reject(new Error("writer catalog must remain unreachable"));
    },
    addComment() {
      return Promise.reject(new Error("writer catalog must remain unreachable"));
    }
  };
}
