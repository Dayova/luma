import { createHash } from "node:crypto";
import { z } from "zod";
import { withAiRequestGuard } from "../ai/ai-request-guard.js";
import { importedSourceMeetingId } from "../domain/imported-source-provenance.js";
import type { WorkspaceAccessPolicy } from "../access/workspace-access-policy.js";
import type {
  CurrentActionItemReconciliationReview,
  WorkspaceConfig
} from "../domain/model.js";
import type { IdentityDirectory } from "../identity/interface.js";
import {
  createMeetingNotesIngestion,
  observedMeetingNoteToObservation
} from "../knowledge/meeting-notes-ingestion.js";
import {
  meetingNoteSnapshotContentHash,
  type ObservedSourceLedger
} from "../knowledge/observed-source-ledger.js";
import type {
  MeetingIntelligence,
  MeetingUpdate
} from "../meeting-intelligence/interface.js";
import {
  NativeReviewUnavailable,
  type NativeReviewAccess,
  type NativeReviewInstruction,
  type NativeReviewLocator
} from "../native-review/native-review-access.js";
import {
  createSourceBoundNativeReview,
  type CapturedMeetingNoteEvidence,
  type MeetingNoteEvidenceSource,
  type SourceBoundNativeReviewReceipt
} from "../native-review/source-bound-native-review.js";
import type { ContextAudience } from "../organizational-context/interface.js";
import type { LumaDatabase } from "../persistence/db.js";

export type NativeNotionReviewResult = {
  receipt: SourceBoundNativeReviewReceipt;
  /** Current Human resolutions are projected by the same MI, never inferred by this ingress. */
  reviews: CurrentActionItemReconciliationReview[];
  analysis: {
    status: MeetingUpdate["analysisStatus"];
    errors: Array<{ code: string; retryable: boolean }>;
  };
};
export type NativeNotionReviewRuntime = {
  review(locator: NativeReviewLocator): Promise<NativeNotionReviewResult>;
  /** Final transport disclosure fence, including current MI projection. */
  requireCurrent(
    locator: NativeReviewLocator,
    result: NativeNotionReviewResult
  ): Promise<void>;
  stop(): Promise<void>;
};

export type NativeNotionReviewRuntimeInput = {
  database: LumaDatabase;
  workspace: WorkspaceConfig;
  ledger: ObservedSourceLedger;
  /** The main runtime's opaque WorkProvider namespace; identities remain Linear. */
  workItemProviderId?: string;
  /** The main runtime's sole MI, with its guarded Work Catalog and shared AI accounting. */
  meetingIntelligence: MeetingIntelligence;
  identityDirectory: IdentityDirectory;
  accessPolicy: WorkspaceAccessPolicy;
  access: NativeReviewAccess;
  evidenceSource: MeetingNoteEvidenceSource;
  /** Fresh exact source sharing AND dedicated Linear read-scope sharing for the full audience. */
  authorizeSources(input: {
    audience: ContextAudience;
    pageId: string;
  }): Promise<boolean>;
};

/** Shared-store composition. No new MI, model, provider writer, scheduler or AI budget is constructed. */
export function createNativeNotionReviewRuntime(
  input: NativeNotionReviewRuntimeInput
): NativeNotionReviewRuntime {
  const workItemProviderId = (input.workItemProviderId ?? "linear").trim();
  // Deliberately has no onProcessedSource hook: native read-only review cannot schedule automatic writes.
  const ingestion = createMeetingNotesIngestion({
    meetingIntelligence: input.meetingIntelligence,
    workItemProviderId
  });
  let stopped = false;
  const active = new Set<Promise<unknown>>();
  const locks = new Map<string, Promise<void>>();
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = operation();
    active.add(run);
    void run.finally(() => active.delete(run)).catch(() => undefined);
    return run;
  };
  const admitted = <T>(operation: () => Promise<T>): Promise<T> =>
    stopped ? Promise.reject(new NativeReviewUnavailable("stopped")) : track(operation);
  const authorize = async (instruction: NativeReviewInstruction) => {
    if (instruction.audience.workspaceId !== input.workspace.workspaceId)
      throw new NativeReviewUnavailable("access-unavailable");
    await input.access.requireCurrent(instruction);
    const actor = await input.accessPolicy.authorize({
      workspaceId: input.workspace.workspaceId,
      providerId: instruction.actor.identityProviderId,
      providerUserId: instruction.actor.providerUserId
    });
    if (
      actor?.personId !== instruction.actor.personId ||
      !(await input.authorizeSources({
        audience: instruction.audience,
        pageId: instruction.page.pageId
      }))
    )
      throw new NativeReviewUnavailable("access-unavailable");
  };
  const capture = async (
    instruction: NativeReviewInstruction
  ): Promise<CapturedMeetingNoteEvidence> => {
    await authorize(instruction);
    const result = await input.evidenceSource.capture({
      workspaceId: input.workspace.workspaceId,
      page: instruction.page
    });
    if (
      result.status !== "captured" ||
      result.evidence.snapshot.completeness.state !== "complete" ||
      result.evidence.source.providerId !== instruction.page.providerId ||
      result.evidence.source.parentObjectId !== instruction.page.pageId
    )
      throw new NativeReviewUnavailable("source-unavailable");
    await authorize(instruction);
    return result.evidence;
  };
  const exact = async (
    instruction: NativeReviewInstruction,
    source: CapturedMeetingNoteEvidence
  ) => {
    const fresh = await capture(instruction);
    if (
      JSON.stringify(fresh.source) !== JSON.stringify(source.source) ||
      fresh.providerVersion !== source.providerVersion ||
      meetingNoteSnapshotContentHash(fresh.snapshot) !==
        meetingNoteSnapshotContentHash(source.snapshot)
    )
      throw new NativeReviewUnavailable("source-changed");
  };
  const bind = async (
    instruction: NativeReviewInstruction,
    source: CapturedMeetingNoteEvidence,
    create = false
  ): Promise<string> => {
    const id = digest([instruction.agentId, instruction.sessionId, instruction.eventId]);
    const payload = JSON.stringify({
      instruction,
      source: {
        source: source.source,
        providerVersion: source.providerVersion,
        contentHash: meetingNoteSnapshotContentHash(source.snapshot)
      }
    });
    if (create)
      await input.database.query(
        `INSERT INTO native_review_instructions (workspace_id, instruction_id, payload_json, payload_hash,source_provider_id,source_object_id,source_content_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (workspace_id,instruction_id) DO NOTHING`,
        [
          input.workspace.workspaceId,
          id,
          payload,
          digest(payload),
          source.source.providerId,
          source.source.sourceObjectId,
          meetingNoteSnapshotContentHash(source.snapshot)
        ]
      );
    const row = (
      await input.database.query<{ payload_json: string; payload_hash: string }>(
        "SELECT payload_json,payload_hash FROM native_review_instructions WHERE workspace_id=$1 AND instruction_id=$2",
        [input.workspace.workspaceId, id]
      )
    ).rows[0];
    if (
      !row ||
      row.payload_hash !== digest(row.payload_json) ||
      row.payload_json !== payload
    )
      throw new NativeReviewUnavailable("request-conflict");
    return id;
  };
  const project = async (
    receipt: SourceBoundNativeReviewReceipt
  ): Promise<CurrentActionItemReconciliationReview[]> => {
    if (!receipt.source) return [];
    const original = await input.ledger.get({
      workspaceId: input.workspace.workspaceId,
      source: {
        providerId: receipt.source.providerId,
        sourceKind: "meeting-note",
        sourceObjectId: receipt.source.sourceObjectId
      },
      revision: receipt.source.revision
    });
    if (!original || original.contentHash !== receipt.source.contentHash)
      throw new NativeReviewUnavailable("review-unavailable");
    const observation = observedMeetingNoteToObservation(
      { workspace: input.workspace, source: { ...original, change: "unchanged" } },
      workItemProviderId
    );
    const result = await input.meetingIntelligence.query({
      workspaceId: input.workspace.workspaceId,
      meetingId: observation.meetingId,
      query: { type: "action-item-reconciliation-review" }
    });
    if (result.type !== "action-item-reconciliation-review")
      throw new NativeReviewUnavailable("review-unavailable");
    const reviews = result.reviews.filter((review) =>
      receipt.outcome.reviewIds.includes(review.proposal.id)
    );
    if (reviews.length !== receipt.outcome.reviewIds.length)
      throw new NativeReviewUnavailable("review-unavailable");
    return reviews;
  };
  const requireCurrent = async (
    locator: NativeReviewLocator,
    result: NativeNotionReviewResult
  ) => {
    const instruction = await input.access.read(locator);
    const source = await capture(instruction);
    const id = await bind(instruction, source);
    if (
      result.receipt.nativeRunId !== id ||
      !result.receipt.source ||
      result.receipt.source.contentHash !==
        meetingNoteSnapshotContentHash(source.snapshot) ||
      result.receipt.source.sourceObjectId !== source.source.sourceObjectId
    )
      throw new NativeReviewUnavailable("source-changed");
    const meetingId = importedSourceMeetingId(result.receipt.source);
    const revision = async () =>
      (
        await input.database.query<{ revision: number }>(
          "SELECT revision FROM meetings WHERE workspace_id=$1 AND meeting_id=$2",
          [input.workspace.workspaceId, meetingId]
        )
      ).rows[0]?.revision;
    const originalRevision = await revision();
    if (originalRevision === undefined)
      throw new NativeReviewUnavailable("review-unavailable");
    if (JSON.stringify(await project(result.receipt)) !== JSON.stringify(result.reviews))
      throw new NativeReviewUnavailable("review-unavailable");
    if (JSON.stringify(await analysis(id)) !== JSON.stringify(result.analysis))
      throw new NativeReviewUnavailable("review-unavailable");
    await exact(instruction, source);
    if ((await revision()) !== originalRevision)
      throw new NativeReviewUnavailable("review-unavailable");
  };
  const analysis = async (id: string): Promise<NativeNotionReviewResult["analysis"]> => {
    const row = (
      await input.database.query<{ analysis_json: string | null }>(
        "SELECT analysis_json FROM native_review_instructions WHERE workspace_id=$1 AND instruction_id=$2",
        [input.workspace.workspaceId, id]
      )
    ).rows[0];
    if (!row?.analysis_json) return { status: "not-needed", errors: [] };
    return z
      .object({
        status: z.enum(["completed", "deferred", "not-needed"]),
        errors: z
          .array(z.object({ code: z.string().max(128), retryable: z.boolean() }).strict())
          .max(100)
      })
      .strict()
      .parse(JSON.parse(row.analysis_json) as unknown);
  };
  return {
    review(locator) {
      return admitted(async () => {
        const key = JSON.stringify(locator);
        const prior = locks.get(key) ?? Promise.resolve();
        let release!: () => void;
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        const tail = prior.then(() => hold);
        locks.set(key, tail);
        await prior;
        try {
          const instruction = await input.access.read(locator);
          const source = await capture(instruction);
          const id = await bind(instruction, source, true);
          // Repeat after durable admission. A revoked source/actor cannot reach MI because a DB await was slow.
          await exact(instruction, source);
          const guardedLedger: ObservedSourceLedger = {
            ...input.ledger,
            record: async (request) => {
              await exact(instruction, source);
              return input.ledger.record(request);
            }
          };
          const core = createSourceBoundNativeReview({
            database: input.database,
            workspace: input.workspace,
            ledger: guardedLedger,
            identityDirectory: input.identityDirectory,
            meetingIntelligence: input.meetingIntelligence,
            meetingNoteEvidenceSource: {
              capture: async () => {
                await exact(instruction, source);
                return { status: "captured", evidence: source };
              }
            },
            meetingNotesIngestion: {
              ingest: async (request) => {
                await exact(instruction, source);
                const result = await ingestion.ingest(request);
                await input.database.query(
                  "UPDATE native_review_instructions SET analysis_json=$3 WHERE workspace_id=$1 AND instruction_id=$2 AND analysis_json IS NULL",
                  [
                    input.workspace.workspaceId,
                    id,
                    JSON.stringify({
                      status: result.analysisStatus,
                      errors: result.errors.map((error) => ({
                        code: error.code,
                        retryable: error.retryable
                      }))
                    })
                  ]
                );
                await exact(instruction, source);
                return result;
              }
            }
          });
          const receipt = await withAiRequestGuard(
            () => track(() => exact(instruction, source)),
            () =>
              core.review({
                nativeRunId: id,
                actor: instruction.actor,
                page: instruction.page
              })
          );
          const result = {
            receipt,
            reviews: await project(receipt),
            analysis: await analysis(id)
          };
          await requireCurrent(locator, result);
          return result;
        } finally {
          release();
          if (locks.get(key) === tail) locks.delete(key);
        }
      });
    },
    requireCurrent: (locator, result) => admitted(() => requireCurrent(locator, result)),
    async stop() {
      stopped = true;
      while (active.size) await Promise.allSettled([...active]);
    }
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
