import { describe, expect, it } from "vitest";
import type {
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../../src/ai/reasoning-model.js";
import { createWorkspaceBoundWorkCatalog } from "../../src/app/workspace-bound-work-catalog.js";
import { createStaticIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import { createLedgerBackedImportedSourceVerifier } from "../../src/knowledge/ledger-backed-imported-source-verifier.js";
import { createMeetingNotesIngestion } from "../../src/knowledge/meeting-notes-ingestion.js";
import {
  createNotionObjectScopedMeetingNoteEvidenceSource,
  type NotionObjectScopedMeetingNoteEvidenceReader
} from "../../src/knowledge/notion-object-scoped-meeting-note-evidence-source.js";
import type { NotionMeetingNotesBlock } from "../../src/knowledge/notion-meeting-notes-source.js";
import { createObservedSourceLedger } from "../../src/knowledge/observed-source-ledger.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createSourceBoundNativeReview } from "../../src/native-review/source-bound-native-review.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import {
  createLinearReadOnlyApiForTest,
  createLinearReadOnlyWorkCatalogForTest,
  type LinearReadOnlyApiIssue
} from "../../src/work/linear-read-only-work-catalog.js";

const workspace = {
  workspaceId: "workspace_dayova",
  timezone: "Europe/Berlin"
};
const providerId = "notion";
const pageId = "notion-page-product-sync";

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
      url: "https://notion.so/product-sync",
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
        meetingNotesBlock({
          id: "meeting-notes-root",
          summaryBlockId: "summary-block",
          notesBlockId: "notes-block",
          transcriptBlockId: "transcript-block"
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

describe("object-scoped Notion evidence through SourceBoundNativeReview", () => {
  it("pins a complete exact-page revision before using only the separately scoped read-only catalog", async () => {
    const database = await createPgliteDatabase();
    const reader = new ExactPageReader();
    const ledger = createObservedSourceLedger({ database });
    const linearApi = new RecordingLinearReadOnlyApi();
    const linearCatalog = createLinearReadOnlyWorkCatalogForTest({
      teamId: "team-dayova",
      api: createLinearReadOnlyApiForTest({
        searchIssues: (input) => linearApi.searchIssues(input),
        getIssue: (id) => linearApi.getIssue(id)
      })
    });
    const workCatalog = createWorkspaceBoundWorkCatalog({
      workspaceId: workspace.workspaceId,
      providerScopeId: "team-dayova",
      workCatalog: linearCatalog
    });
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel(),
      workCatalogs: [workCatalog],
      importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
        ledger,
        workItemProviderId: workCatalog.providerId
      }),
      now: () => new Date("2026-08-10T09:01:00.000Z")
    });
    const meetingNotesIngestion = createMeetingNotesIngestion({
      meetingIntelligence,
      workItemProviderId: workCatalog.providerId
    });
    const evidenceSource = createNotionObjectScopedMeetingNoteEvidenceSource({
      workspaceId: workspace.workspaceId,
      providerId,
      pageId,
      reader,
      now: () => new Date("2026-08-10T09:02:00.000Z")
    });
    const review = createSourceBoundNativeReview({
      database,
      workspace,
      ledger,
      meetingIntelligence,
      meetingNotesIngestion,
      meetingNoteEvidenceSource: evidenceSource,
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
      })
    });

    try {
      const receipt = await review.review({
        nativeRunId: "native-notion-run-object-scoped-1",
        actor: {
          identityProviderId: "notion",
          providerUserId: "notion-user-jakob"
        },
        page: { providerId, pageId }
      });

      expect(receipt).toMatchObject({
        workspaceId: workspace.workspaceId,
        source: {
          providerId,
          sourceObjectId: "meeting-notes-root",
          revision: 1
        },
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
      expect("createWorkItem" in linearCatalog).toBe(false);
      expect("createWorkItem" in workCatalog).toBe(false);
      expect("updateWorkItem" in workCatalog).toBe(false);
      expect("addComment" in workCatalog).toBe(false);
      await expect(
        database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM follow_up_executions
            WHERE workspace_id = $1`,
          [workspace.workspaceId]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await database.close();
    }
  });

  it("stops incomplete exact-page evidence before the ledger, ingestion, or work catalog", async () => {
    const reader = new TruncatedExactPageReader();
    const harness = await createNativeReviewHarness(reader);

    try {
      const receipt = await harness.review.review({
        nativeRunId: "native-notion-run-object-scoped-incomplete",
        actor: {
          identityProviderId: "notion",
          providerUserId: "notion-user-jakob"
        },
        page: { providerId, pageId }
      });

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

  it("stops an exact page trashed during final verification before durable capture or work reads", async () => {
    const reader = new FinalTrashedExactPageReader();
    const harness = await createNativeReviewHarness(reader);

    try {
      const receipt = await harness.review.review({
        nativeRunId: "native-notion-run-object-scoped-final-trash",
        actor: {
          identityProviderId: "notion",
          providerUserId: "notion-user-jakob"
        },
        page: { providerId, pageId }
      });

      expect(receipt).toMatchObject({
        source: null,
        outcome: {
          type: "needs-clarification",
          code: "meeting-note-page-unreadable",
          retryable: false
        }
      });
      expect(reader.pageCalls).toEqual([pageId, pageId]);
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
  return {
    text: null,
    checked: null,
    hasChildren: false,
    ...overrides
  };
}

function meetingNotesBlock(input: {
  id: string;
  summaryBlockId: string;
  notesBlockId: string;
  transcriptBlockId: string;
}): NotionMeetingNotesBlock {
  return block({
    id: input.id,
    type: "meeting-notes",
    hasChildren: true,
    meetingNotes: {
      title: "Product sync",
      status: "notes_ready",
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
    updatedAt: "2026-08-09T09:00:00.000Z"
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
      url: "https://notion.so/product-sync",
      lastEditedAt: "2026-08-10T09:00:00.000Z",
      inTrash: this.pageCalls.length === 2
    });
  }
}

async function createNativeReviewHarness(
  reader: NotionObjectScopedMeetingNoteEvidenceReader
) {
  const database = await createPgliteDatabase();
  const ledger = createObservedSourceLedger({ database });
  const linearApi = new RecordingLinearReadOnlyApi();
  const linearCatalog = createLinearReadOnlyWorkCatalogForTest({
    teamId: "team-dayova",
    api: createLinearReadOnlyApiForTest({
      searchIssues: (input) => linearApi.searchIssues(input),
      getIssue: (id) => linearApi.getIssue(id)
    })
  });
  const workCatalog = createWorkspaceBoundWorkCatalog({
    workspaceId: workspace.workspaceId,
    providerScopeId: "team-dayova",
    workCatalog: linearCatalog
  });
  const meetingIntelligence = createMeetingIntelligence({
    database,
    reasoningModel: new NoAnalysisReasoningModel(),
    workCatalogs: [workCatalog],
    importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
      ledger,
      workItemProviderId: workCatalog.providerId
    }),
    now: () => new Date("2026-08-10T09:01:00.000Z")
  });
  const meetingNotesIngestion = createMeetingNotesIngestion({
    meetingIntelligence,
    workItemProviderId: workCatalog.providerId
  });
  const evidenceSource = createNotionObjectScopedMeetingNoteEvidenceSource({
    workspaceId: workspace.workspaceId,
    providerId,
    pageId,
    reader,
    now: () => new Date("2026-08-10T09:02:00.000Z")
  });
  const review = createSourceBoundNativeReview({
    database,
    workspace,
    ledger,
    meetingIntelligence,
    meetingNotesIngestion,
    meetingNoteEvidenceSource: evidenceSource,
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
    })
  });

  return { database, linearApi, review };
}
