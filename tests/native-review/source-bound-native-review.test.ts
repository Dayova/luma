import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../../src/ai/reasoning-model.js";
import { createWorkspaceBoundWorkCatalog } from "../../src/app/workspace-bound-work-catalog.js";
import { createStaticIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import { createMeetingNotesIngestion } from "../../src/knowledge/meeting-notes-ingestion.js";
import { createLedgerBackedImportedSourceVerifier } from "../../src/knowledge/ledger-backed-imported-source-verifier.js";
import {
  createObservedSourceLedger,
  type GetObservedSourceRevisionInput,
  type ObservedSourceKind,
  type ObservedSourceLedger,
  type ObservedSourceSnapshot,
  type RawMeetingNoteSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import {
  createSourceBoundNativeReview,
  type CapturedMeetingNoteEvidence,
  type MeetingNoteEvidenceCapture,
  type MeetingNoteEvidenceSource,
  type SourceBoundNativeReviewRequest
} from "../../src/native-review/source-bound-native-review.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import type { WorkCatalog, WorkItem, WorkQuery } from "../../src/work/interface.js";
import {
  createLinearReadOnlyApiForTest,
  createLinearReadOnlyWorkCatalogForTest,
  type LinearReadOnlyApiIssue
} from "../../src/work/linear-read-only-work-catalog.js";
import type { PersonIdentity } from "../../src/identity/interface.js";

const workspace = {
  workspaceId: "workspace_dayova",
  timezone: "Europe/Berlin"
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

class ProgrammableMeetingNoteEvidenceSource implements MeetingNoteEvidenceSource {
  readonly captures: Array<{
    workspaceId: string;
    page: { providerId: string; pageId: string };
  }> = [];

  constructor(private captureResult: MeetingNoteEvidenceCapture) {}

  setCaptureResult(captureResult: MeetingNoteEvidenceCapture): void {
    this.captureResult = captureResult;
  }

  capture(input: { workspaceId: string; page: { providerId: string; pageId: string } }) {
    this.captures.push({ page: { ...input.page }, workspaceId: input.workspaceId });
    return Promise.resolve(this.captureResult);
  }
}

class RecordingReadOnlyWorkCatalog implements WorkCatalog {
  readonly providerId = "linear";
  readonly supportsConditionalUpdates = false;
  readonly searches: WorkQuery[] = [];
  readonly gets: string[] = [];

  private readonly workItem: WorkItem = {
    id: "issue-301",
    providerId: "linear",
    externalId: "LUM-301",
    title: "Prepare the release checklist",
    description: "Prepare the release checklist.",
    status: "active",
    assignees: [],
    dueDate: null,
    labels: [],
    projectId: null,
    parentId: null,
    url: "https://linear.app/dayova/issue/LUM-301",
    updatedAt: "2026-08-09T09:00:00.000Z"
  };
  private searchError: Error | null = null;

  failSearch(error: Error): void {
    this.searchError = error;
  }

  searchWorkItems(query: WorkQuery): Promise<WorkItem[]> {
    this.searches.push(query);
    return this.searchError
      ? Promise.reject(this.searchError)
      : Promise.resolve([this.workItem]);
  }

  getWorkItem(id: string): Promise<WorkItem> {
    this.gets.push(id);
    return id === this.workItem.id
      ? Promise.resolve(this.workItem)
      : Promise.reject(new Error(`unexpected work item ${id}`));
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

    if (id !== "issue-301") {
      return Promise.reject(new Error(`unexpected work item ${id}`));
    }

    return Promise.resolve(linearReadOnlyIssue());
  }
}

describe("SourceBoundNativeReview", () => {
  it("captures one exact page, pins its ledger revision, and returns only its durable reconciliation review", async () => {
    const harness = await createNativeReviewHarness();

    try {
      const receipt = await harness.review.review(nativeReviewRequest());

      expect(harness.source.captures).toEqual([
        {
          workspaceId: workspace.workspaceId,
          page: { providerId: "notion", pageId: "notion-page-product-sync" }
        }
      ]);
      expect(receipt).toMatchObject({
        capabilityVersion: "source-bound-native-review-v1",
        nativeRunId: "native-notion-run-1",
        actor: {
          personId: "person_jakob",
          identityProviderId: "notion",
          providerUserId: "notion-user-jakob"
        },
        page: { providerId: "notion", pageId: "notion-page-product-sync" },
        source: {
          providerId: "notion",
          sourceObjectId: "meeting-notes-root",
          revision: 1
        },
        outcome: {
          type: "reviewed",
          workReferences: [{ providerId: "linear", lookupId: "issue-301" }]
        }
      });
      expect(receipt.source?.contentHash).toMatch(/^sha256:/);
      expect(receipt.outcome.reviewIds).toHaveLength(1);
      expect(harness.catalog.searches).toEqual([
        {
          workspaceId: workspace.workspaceId,
          text: "LUM-301",
          limit: 10
        },
        {
          workspaceId: workspace.workspaceId,
          text: "Jakob will review LUM-301 by Friday.",
          limit: 10
        }
      ]);
      expect(harness.catalog.gets).toEqual(["issue-301"]);
      await expect(
        harness.database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM follow_up_executions
            WHERE workspace_id = $1`,
          [workspace.workspaceId]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await harness.database.close();
    }
  });

  it("keeps a native review in its logical workspace while a bounded catalog uses its opaque provider scope", async () => {
    const api = new RecordingLinearReadOnlyApi();
    // This vertical composition deliberately uses LUM-19's concrete,
    // separately credentialed read-only catalog rather than a narrowed writer.
    const linearCatalog = createLinearReadOnlyWorkCatalogForTest({
      teamId: "team-dayova",
      api: createLinearReadOnlyApiForTest({
        searchIssues: (input) => api.searchIssues(input),
        getIssue: (id) => api.getIssue(id)
      })
    });
    const catalog = createWorkspaceBoundWorkCatalog({
      workspaceId: workspace.workspaceId,
      providerScopeId: "team-dayova",
      workCatalog: linearCatalog
    });
    const harness = await createNativeReviewHarnessWithCatalog(catalog);

    try {
      const receipt = await harness.review.review(nativeReviewRequest());

      expect(receipt).toMatchObject({
        workspaceId: workspace.workspaceId,
        source: {
          providerId: "notion",
          sourceObjectId: "meeting-notes-root",
          revision: 1
        },
        outcome: {
          type: "reviewed",
          workReferences: [{ providerId: "linear", lookupId: "issue-301" }]
        }
      });
      expect(receipt.source?.contentHash).toMatch(/^sha256:/);
      expect(receipt.outcome.reviewIds).toHaveLength(1);
      expect(api.searchCalls).toEqual([
        { teamId: "team-dayova", text: "LUM-301", limit: 10 },
        {
          teamId: "team-dayova",
          text: "Jakob will review LUM-301 by Friday.",
          limit: 10
        }
      ]);
      expect(api.getCalls).toEqual(["issue-301"]);
      expect(workspace.workspaceId).not.toBe("team-dayova");
      expect(Object.hasOwn(linearCatalog, "createWorkItem")).toBe(false);
      expect(Object.hasOwn(linearCatalog, "updateWorkItem")).toBe(false);
      expect(Object.hasOwn(linearCatalog, "addComment")).toBe(false);
      expect(Object.hasOwn(catalog, "createWorkItem")).toBe(false);
      expect(Object.hasOwn(catalog, "updateWorkItem")).toBe(false);
      expect(Object.hasOwn(catalog, "addComment")).toBe(false);
    } finally {
      await harness.database.close();
    }
  });

  it("serializes concurrent requests for one native run into one capture and deterministic replay", async () => {
    const harness = await createNativeReviewHarness();

    try {
      const [first, second] = await Promise.all([
        harness.review.review(nativeReviewRequest()),
        harness.review.review(nativeReviewRequest())
      ]);

      expect(second).toEqual(first);
      expect(harness.source.captures).toHaveLength(1);
      expect(harness.catalog.searches).toHaveLength(2);
      expect(harness.catalog.gets).toEqual(["issue-301"]);
    } finally {
      await harness.database.close();
    }
  });

  it("fails closed before ingestion when a ledger reread substitutes another root and revision", async () => {
    const harness = await createNativeReviewHarness();
    const request = nativeReviewRequest();
    const substituteSource = {
      ...completeMeetingNoteEvidence().source,
      sourceObjectId: "meeting-notes-root-substitute",
      parentObjectId: "other-notion-page"
    };

    try {
      const firstSubstituteRevision = await harness.ledger.record({
        workspaceId: workspace.workspaceId,
        source: substituteSource,
        providerVersion: "2026-08-10T09:00:00.000Z",
        snapshot: completeMeetingNoteSnapshot(),
        observedAt: "2026-08-10T09:00:30.000Z"
      });
      const substituteRevision = await harness.ledger.record({
        workspaceId: workspace.workspaceId,
        source: {
          ...substituteSource,
          parentObjectId: request.page.pageId
        },
        providerVersion: "2026-08-10T09:00:00.000Z",
        snapshot: completeMeetingNoteSnapshot(),
        observedAt: "2026-08-10T09:00:31.000Z"
      });

      function getSubstitutedRevision<
        Input extends GetObservedSourceRevisionInput<ObservedSourceKind>
      >(
        input: Input
      ): Promise<ObservedSourceSnapshot<Input["source"]["sourceKind"]> | null>;
      function getSubstitutedRevision(
        input: GetObservedSourceRevisionInput<ObservedSourceKind>
      ): Promise<ObservedSourceSnapshot<ObservedSourceKind> | null> {
        if (
          input.source.sourceKind === "meeting-note" &&
          input.source.providerId === request.page.providerId &&
          input.source.sourceObjectId === "meeting-notes-root" &&
          input.revision === 1
        ) {
          return Promise.resolve(substituteRevision);
        }

        return harness.ledger.get(input);
      }

      const substitutingLedger = {
        ...harness.ledger,
        get: getSubstitutedRevision
      } satisfies ObservedSourceLedger;
      const review = createSourceBoundNativeReview({
        database: harness.database,
        workspace,
        ledger: substitutingLedger,
        meetingIntelligence: harness.meetingIntelligence,
        meetingNotesIngestion: harness.meetingNotesIngestion,
        meetingNoteEvidenceSource: harness.source,
        identityDirectory: harness.identityDirectory,
        now: () => new Date("2026-08-10T09:02:00.000Z")
      });

      expect(substituteRevision).toMatchObject({
        source: {
          providerId: request.page.providerId,
          sourceObjectId: "meeting-notes-root-substitute",
          parentObjectId: request.page.pageId
        },
        revision: firstSubstituteRevision.revision + 1,
        contentHash: firstSubstituteRevision.contentHash
      });

      const receipt = await review.review(request);

      expect(receipt).toMatchObject({
        source: null,
        outcome: {
          type: "needs-clarification",
          code: "meeting-note-ledger-invalid",
          retryable: false,
          reviewIds: [],
          workReferences: []
        }
      });
      expect(harness.catalog.searches).toEqual([]);
      expect(harness.catalog.gets).toEqual([]);
      await expect(
        harness.database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM meeting_observations
            WHERE workspace_id = $1`,
          [workspace.workspaceId]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(
        harness.database.query<{
          source_object_id: string | null;
          source_revision: number | null;
          source_content_hash: string | null;
        }>(
          `SELECT source_object_id, source_revision, source_content_hash
             FROM source_bound_native_reviews
            WHERE workspace_id = $1 AND native_run_id = $2`,
          [workspace.workspaceId, request.nativeRunId]
        )
      ).resolves.toMatchObject({
        rows: [
          {
            source_object_id: null,
            source_revision: null,
            source_content_hash: null
          }
        ]
      });
    } finally {
      await harness.database.close();
    }
  });

  it("replays the first durable receipt through a rebuilt core without recapturing or querying Linear", async () => {
    const harness = await createNativeReviewHarness();

    try {
      const first = await harness.review.review(nativeReviewRequest());
      const replaySource = new ProgrammableMeetingNoteEvidenceSource({
        status: "captured",
        evidence: {
          ...completeMeetingNoteEvidence(),
          source: {
            ...completeMeetingNoteEvidence().source,
            sourceObjectId: "forged-later-root"
          },
          snapshot: {
            ...completeMeetingNoteSnapshot(),
            title: "Forged later Meeting Note"
          }
        }
      });
      const replayReview = createSourceBoundNativeReview({
        database: harness.database,
        workspace,
        ledger: harness.ledger,
        meetingIntelligence: harness.meetingIntelligence,
        meetingNotesIngestion: harness.meetingNotesIngestion,
        meetingNoteEvidenceSource: replaySource,
        identityDirectory: harness.identityDirectory,
        now: () => new Date("2026-08-10T09:03:00.000Z")
      });

      const replay = await replayReview.review(nativeReviewRequest());

      expect(replay).toEqual(first);
      expect(harness.source.captures).toHaveLength(1);
      expect(replaySource.captures).toEqual([]);
      expect(harness.catalog.searches).toHaveLength(2);
      expect(harness.catalog.gets).toEqual(["issue-301"]);
    } finally {
      await harness.database.close();
    }
  });

  it("fails closed when the same native run ID names a different actor or page", async () => {
    const harness = await createNativeReviewHarness();

    try {
      await harness.review.review(nativeReviewRequest());

      await expect(
        harness.review.review(
          nativeReviewRequest({
            page: { providerId: "notion", pageId: "different-page" }
          })
        )
      ).rejects.toMatchObject({
        code: "native-review-run-id-conflict",
        retryable: false
      });
      await expect(
        harness.review.review(
          nativeReviewRequest({
            actor: {
              identityProviderId: "notion",
              providerUserId: "different-authenticated-user"
            }
          })
        )
      ).rejects.toMatchObject({
        code: "native-review-run-id-conflict",
        retryable: false
      });
      expect(harness.source.captures).toHaveLength(1);
      expect(harness.catalog.searches).toHaveLength(2);
    } finally {
      await harness.database.close();
    }
  });

  it("durably clarifies unmapped or ambiguous native actors before reading Notion or Linear", async () => {
    const unmapped = await createNativeReviewHarness({ people: [] });
    const ambiguous = await createNativeReviewHarness({
      people: [nativeActorPerson(), nativeActorPerson({ personId: "person_other" })]
    });

    try {
      const unmappedReceipt = await unmapped.review.review(nativeReviewRequest());
      const ambiguousReceipt = await ambiguous.review.review(nativeReviewRequest());

      expect(unmappedReceipt).toMatchObject({
        actor: { personId: null },
        source: null,
        outcome: {
          type: "needs-clarification",
          code: "native-actor-unmapped",
          retryable: false
        }
      });
      expect(ambiguousReceipt).toMatchObject({
        actor: { personId: null },
        source: null,
        outcome: {
          type: "needs-clarification",
          code: "native-actor-ambiguous",
          retryable: false
        }
      });
      expect(unmapped.source.captures).toEqual([]);
      expect(ambiguous.source.captures).toEqual([]);
      expect(unmapped.catalog.searches).toEqual([]);
      expect(ambiguous.catalog.searches).toEqual([]);
    } finally {
      await unmapped.database.close();
      await ambiguous.database.close();
    }
  });

  it("never treats a client Person claim or a page attendee as native authorization", async () => {
    const harness = await createNativeReviewHarness({ people: [] });
    const spoofed = nativeReviewRequest({
      actor: {
        identityProviderId: "notion",
        providerUserId: "unmapped-native-user"
      }
    }) as SourceBoundNativeReviewRequest & {
      actor: SourceBoundNativeReviewRequest["actor"] & { personId: string };
    };
    spoofed.actor.personId = "person_jakob";

    try {
      const receipt = await harness.review.review(spoofed);

      expect(receipt).toMatchObject({
        actor: {
          providerUserId: "unmapped-native-user",
          personId: null
        },
        source: null,
        outcome: {
          type: "needs-clarification",
          code: "native-actor-unmapped"
        }
      });
      expect(harness.source.captures).toEqual([]);
      expect(harness.catalog.searches).toEqual([]);
    } finally {
      await harness.database.close();
    }
  });

  it("durably clarifies an ambiguous Meeting Note root without recording or searching it", async () => {
    const harness = await createNativeReviewHarness({
      capture: {
        status: "unavailable",
        code: "meeting-note-root-ambiguous",
        message: "The requested page contains two Meeting Notes blocks.",
        retryable: false
      }
    });

    try {
      const receipt = await harness.review.review(nativeReviewRequest());

      expect(receipt).toMatchObject({
        source: null,
        outcome: {
          type: "needs-clarification",
          code: "meeting-note-root-ambiguous",
          retryable: false
        }
      });
      expect(harness.source.captures).toHaveLength(1);
      expect(harness.catalog.searches).toEqual([]);
      await expect(
        harness.ledger.get({
          workspaceId: workspace.workspaceId,
          source: {
            providerId: "notion",
            sourceKind: "meeting-note",
            sourceObjectId: "meeting-notes-root"
          }
        })
      ).resolves.toBeNull();
    } finally {
      await harness.database.close();
    }
  });

  it("rejects a captured root that is not derived from the requested page", async () => {
    const evidence = completeMeetingNoteEvidence();
    const harness = await createNativeReviewHarness({
      capture: {
        status: "captured",
        evidence: {
          ...evidence,
          source: { ...evidence.source, parentObjectId: "other-notion-page" }
        }
      }
    });

    try {
      const receipt = await harness.review.review(nativeReviewRequest());

      expect(receipt).toMatchObject({
        source: null,
        outcome: {
          type: "needs-clarification",
          code: "meeting-note-root-invalid",
          retryable: false
        }
      });
      expect(harness.catalog.searches).toEqual([]);
      await expect(
        harness.ledger.get({
          workspaceId: workspace.workspaceId,
          source: {
            providerId: "notion",
            sourceKind: "meeting-note",
            sourceObjectId: "meeting-notes-root"
          }
        })
      ).resolves.toBeNull();
    } finally {
      await harness.database.close();
    }
  });

  it("records and surfaces Meeting Intelligence's incomplete-source clarification without searching Linear", async () => {
    const complete = completeMeetingNoteSnapshot();
    const harness = await createNativeReviewHarness({
      capture: {
        status: "captured",
        evidence: {
          ...completeMeetingNoteEvidence(),
          snapshot: {
            ...complete,
            markdown: {
              ...complete.markdown,
              truncated: true
            },
            completeness: {
              state: "partial",
              reasons: [
                {
                  code: "truncated-markdown",
                  message: "The Notion page markdown was truncated."
                }
              ]
            }
          }
        }
      }
    });

    try {
      const receipt = await harness.review.review(nativeReviewRequest());

      expect(receipt).toMatchObject({
        source: {
          sourceObjectId: "meeting-notes-root",
          revision: 1
        },
        outcome: {
          type: "needs-clarification",
          code: "meeting-note-source-incomplete",
          retryable: true,
          reviewIds: [expect.any(String)],
          workReferences: []
        }
      });
      expect(receipt.source?.contentHash).toMatch(/^sha256:/);
      expect(harness.catalog.searches).toEqual([]);
      await expect(
        harness.ledger.get({
          workspaceId: workspace.workspaceId,
          source: {
            providerId: "notion",
            sourceKind: "meeting-note",
            sourceObjectId: "meeting-notes-root"
          }
        })
      ).resolves.toMatchObject({
        snapshot: { completeness: { state: "partial" } }
      });
    } finally {
      await harness.database.close();
    }
  });

  it("persists a source-bound clarification when the dedicated read-only catalog fails", async () => {
    const harness = await createNativeReviewHarness();
    harness.catalog.failSearch(new Error("read-only Linear is unavailable"));

    try {
      const receipt = await harness.review.review(nativeReviewRequest());

      expect(receipt).toMatchObject({
        source: {
          sourceObjectId: "meeting-notes-root",
          revision: 1
        },
        outcome: {
          type: "needs-clarification",
          code: "work-catalog-unavailable",
          retryable: true,
          workReferences: []
        }
      });
      expect(receipt.source?.contentHash).toMatch(/^sha256:/);
      expect(receipt.outcome.reviewIds).toHaveLength(1);
      expect(harness.catalog.searches).toHaveLength(1);
      expect(harness.catalog.gets).toEqual([]);
    } finally {
      await harness.database.close();
    }
  });

  it("fails closed when a digest-valid stored receipt names a forged source hash", async () => {
    const harness = await createNativeReviewHarness();

    try {
      const first = await harness.review.review(nativeReviewRequest());
      const source = first.source;

      if (!source) {
        throw new Error("expected a source-bound review receipt");
      }

      const forgedReceipt = {
        ...first,
        source: {
          ...source,
          contentHash: "sha256:forged-receipt-source-hash"
        }
      };
      const receiptJson = JSON.stringify(forgedReceipt);
      const receiptContentHash = `sha256:${createHash("sha256")
        .update(receiptJson)
        .digest("hex")}`;

      await harness.database.query(
        `UPDATE source_bound_native_reviews
            SET source_content_hash = $3,
                receipt_json = $4,
                receipt_content_hash = $5
          WHERE workspace_id = $1 AND native_run_id = $2`,
        [
          workspace.workspaceId,
          first.nativeRunId,
          forgedReceipt.source.contentHash,
          receiptJson,
          receiptContentHash
        ]
      );

      await expect(harness.review.review(nativeReviewRequest())).rejects.toMatchObject({
        code: "native-review-receipt-corrupt",
        retryable: false
      });
      expect(harness.source.captures).toHaveLength(1);
      expect(harness.catalog.searches).toHaveLength(2);
    } finally {
      await harness.database.close();
    }
  });

  it("rejects a digest-valid stored receipt with an unknown clarification code", async () => {
    const harness = await createNativeReviewHarness({
      people: []
    });

    try {
      const first = await harness.review.review(nativeReviewRequest());
      const forgedReceipt = {
        ...first,
        outcome: {
          ...first.outcome,
          code: "unknown-clarification-code"
        }
      };
      const receiptJson = JSON.stringify(forgedReceipt);
      const receiptContentHash = `sha256:${createHash("sha256")
        .update(receiptJson)
        .digest("hex")}`;

      await harness.database.query(
        `UPDATE source_bound_native_reviews
            SET receipt_json = $3,
                receipt_content_hash = $4
          WHERE workspace_id = $1 AND native_run_id = $2`,
        [workspace.workspaceId, first.nativeRunId, receiptJson, receiptContentHash]
      );

      await expect(harness.review.review(nativeReviewRequest())).rejects.toMatchObject({
        code: "native-review-receipt-corrupt",
        retryable: false
      });
      expect(harness.source.captures).toHaveLength(0);
      expect(harness.catalog.searches).toEqual([]);
    } finally {
      await harness.database.close();
    }
  });
});

async function createNativeReviewHarness(
  input: {
    people?: PersonIdentity[];
    capture?: MeetingNoteEvidenceCapture;
  } = {}
) {
  const catalog = new RecordingReadOnlyWorkCatalog();

  return createNativeReviewHarnessWithCatalog(catalog, input);
}

async function createNativeReviewHarnessWithCatalog<Catalog extends WorkCatalog>(
  catalog: Catalog,
  input: {
    people?: PersonIdentity[];
    capture?: MeetingNoteEvidenceCapture;
  } = {}
) {
  const database = await createPgliteDatabase();
  const ledger = createObservedSourceLedger({ database });
  const meetingIntelligence = createMeetingIntelligence({
    database,
    reasoningModel: new NoAnalysisReasoningModel(),
    workCatalogs: [catalog],
    importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
      ledger,
      workItemProviderId: catalog.providerId
    }),
    now: () => new Date("2026-08-10T09:01:00.000Z")
  });
  const source = new ProgrammableMeetingNoteEvidenceSource(
    input.capture ?? { status: "captured", evidence: completeMeetingNoteEvidence() }
  );
  const meetingNotesIngestion = createMeetingNotesIngestion({
    meetingIntelligence,
    workItemProviderId: catalog.providerId
  });
  const identityDirectory = createStaticIdentityDirectory({
    people: input.people ?? [nativeActorPerson()]
  });
  const review = createSourceBoundNativeReview({
    database,
    workspace,
    ledger,
    meetingIntelligence,
    meetingNotesIngestion,
    meetingNoteEvidenceSource: source,
    identityDirectory,
    now: () => new Date("2026-08-10T09:02:00.000Z")
  });

  return {
    database,
    catalog,
    identityDirectory,
    ledger,
    meetingIntelligence,
    meetingNotesIngestion,
    review,
    source
  };
}

function nativeReviewRequest(
  overrides: Partial<SourceBoundNativeReviewRequest> = {}
): SourceBoundNativeReviewRequest {
  return {
    nativeRunId: "native-notion-run-1",
    actor: {
      identityProviderId: "notion",
      providerUserId: "notion-user-jakob"
    },
    page: {
      providerId: "notion",
      pageId: "notion-page-product-sync"
    },
    ...overrides
  };
}

function nativeActorPerson(overrides: Partial<PersonIdentity> = {}): PersonIdentity {
  return {
    personId: "person_jakob",
    displayName: "Jakob",
    discordUserId: null,
    discordUsername: null,
    githubLogin: null,
    githubUserId: null,
    atlassianAccountId: null,
    notionUserId: "notion-user-jakob",
    linearUserId: "linear-user-jakob",
    languagePreference: "auto",
    ...overrides
  };
}

function linearReadOnlyIssue(): LinearReadOnlyApiIssue {
  return {
    id: "issue-301",
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

function completeMeetingNoteEvidence(): CapturedMeetingNoteEvidence {
  return {
    source: {
      providerId: "notion",
      sourceKind: "meeting-note",
      sourceObjectId: "meeting-notes-root",
      parentObjectId: "notion-page-product-sync",
      url: "https://notion.so/product-sync"
    },
    providerVersion: "2026-08-10T09:00:00.000Z",
    snapshot: completeMeetingNoteSnapshot(),
    observedAt: "2026-08-10T09:00:30.000Z"
  };
}

function completeMeetingNoteSnapshot(): RawMeetingNoteSnapshot {
  return {
    schemaVersion: 1,
    title: "Product sync",
    lifecycle: "ready",
    calendar: {
      startAt: "2026-08-07T09:00:00.000Z",
      endAt: "2026-08-07T10:00:00.000Z",
      attendeeProviderUserIds: ["untrusted-attendee-must-not-authorize"]
    },
    recording: null,
    sections: {
      summary: {
        state: "available",
        sourceBlockId: "summary-block",
        text: "The release checklist needs review.",
        blocks: []
      },
      actionItemsAndNotes: {
        state: "available",
        sourceBlockId: "action-items-block",
        text: "Jakob will review LUM-301 by Friday.",
        blocks: [
          {
            id: "action-item-1",
            type: "to-do",
            text: "Jakob will review LUM-301 by Friday.",
            checked: false,
            children: []
          }
        ]
      },
      transcript: {
        state: "available",
        sourceBlockId: "transcript-block",
        text: "Jakob described the release checklist.",
        blocks: []
      }
    },
    markdown: {
      content: "# Product sync",
      truncated: false,
      unknownBlockIds: []
    },
    completeness: { state: "complete" }
  };
}
