import { randomUUID } from "node:crypto";
import type { LumaDatabase } from "../persistence/db.js";
import type { MeetingIntelligence } from "../meeting-intelligence/interface.js";
import type { ExternalReference, FollowUpExecutionRecorded } from "../domain/model.js";
import type {
  ExecuteFollowUpInput,
  ExecuteFollowUpResult,
  FollowUpExecution
} from "./interface.js";
import {
  MeetingSynthesisWriteNotAppliedError,
  type MeetingSynthesisPublicationReceipt,
  type MeetingSynthesisWriter
} from "../knowledge/meeting-synthesis-writer.js";
import {
  isSynthesisPublicationIntent,
  migrateSynthesisPublications,
  readSynthesisPublication,
  type SynthesisPublicationState
} from "../meeting-intelligence/synthesis-publication-state.js";
import { synthesisDigest } from "../knowledge/meeting-synthesis-markdown.js";
import {
  acquireOperationalOutcomePageLease,
  releaseOperationalOutcomePageLease
} from "./operational-outcome-settlement.js";
import type { OperationalOutcomeTarget } from "../knowledge/operational-outcome-writer.js";
import {
  readCanonicalPublicationAnchor,
  recordCanonicalPublicationAnchor,
  sameAnchor
} from "../logical-meetings/canonical-publication-anchor.js";

const flights = new WeakMap<LumaDatabase, Set<string>>();
export function withSynthesisPublicationExecution(input: {
  base: FollowUpExecution;
  database: LumaDatabase;
  meetingIntelligence: MeetingIntelligence;
  writer?: MeetingSynthesisWriter;
  now: () => Date;
}): FollowUpExecution {
  let active = flights.get(input.database);
  if (!active) {
    active = new Set();
    flights.set(input.database, active);
  }
  const run = async (
    request: ExecuteFollowUpInput,
    recovery: boolean
  ): Promise<ExecuteFollowUpResult> => {
    const scope = structuredClone(request),
      key = synthesisDigest([scope.workspace.workspaceId, scope.meetingId]);
    if (active.has(key)) throw new Error("Synthesis publication is already running");
    active.add(key);
    let state: SynthesisPublicationState | null = null;
    let target: OperationalOutcomeTarget | undefined;
    let writing = false;
    const args = [scope.workspace.workspaceId, scope.meetingId, scope.intentId];
    const current = async () => {
      const view = await input.meetingIntelligence.query({
        workspaceId: scope.workspace.workspaceId,
        meetingId: scope.meetingId,
        query: { type: "capture-synthesis" }
      });
      if (
        view.type !== "capture-synthesis" ||
        view.availability !== "available" ||
        !view.synthesis ||
        view.followUpIntentions?.[0]?.id !== scope.intentId
      )
        throw new Error(
          "Approved synthesis sources, binding or audience are no longer current"
        );
      if (
        writing &&
        state?.plan &&
        !state.applied &&
        !sameAnchor(view.synthesis.canonicalAnchorRef, state.plan.anchor)
      )
        throw new Error("Canonical synthesis anchor changed before mutation");
      return view.synthesis;
    };
    const save = async (next: SynthesisPublicationState) => {
      await input.database.query(
        "UPDATE meeting_synthesis_publications SET state_json=$4 WHERE workspace_id=$1 AND meeting_id=$2 AND intent_id=$3",
        [...args, JSON.stringify(next)]
      );
      state = structuredClone(next);
    };
    const release = async () => {
      if (target)
        await releaseOperationalOutcomePageLease({
          database: input.database,
          workspaceId: scope.workspace.workspaceId,
          meetingId: scope.meetingId,
          intentId: scope.intentId,
          target
        });
      await input.database.query(
        "DELETE FROM meeting_synthesis_publication_locks WHERE workspace_id=$1 AND meeting_id=$2 AND intent_id=$3",
        args
      );
    };
    const recordApplied = async (receipt: MeetingSynthesisPublicationReceipt) => {
      const latest = await readSynthesisPublication(
        input.database,
        ...(args as [string, string, string])
      );
      if (
        !latest?.plan ||
        latest.executionLeaseId !== state?.executionLeaseId ||
        receipt.operationToken !== latest.plan.operationToken ||
        receipt.synthesisRevision !== latest.intent.synthesisRevision ||
        receipt.sourceSetDigest !== latest.intent.sourceSetDigest ||
        receipt.externalReference.providerId !== input.writer?.providerId ||
        receipt.externalReference.objectType !== "document"
      )
        throw new Error("Synthesis writer returned an unbound receipt");
      if (latest.applied && synthesisDigest(latest.applied) !== synthesisDigest(receipt))
        throw new Error("A different positive publication receipt is already retained");
      // Preserve positive remote evidence first. Anchor bookkeeping may fail later.
      await save({ ...latest, applied: structuredClone(receipt), phase: "applied" });
      const anchorStatus = await recordCanonicalPublicationAnchor({
        database: input.database,
        workspaceId: scope.workspace.workspaceId,
        logicalMeetingId: scope.meetingId,
        intentId: scope.intentId,
        executionLeaseId: latest.executionLeaseId!,
        reference: receipt.externalReference
      });
      await save({ ...state, anchorStatus });
    };
    try {
      if (!input.writer)
        throw new Error("Meeting synthesis publication is not configured");
      await migrateSynthesisPublications(input.database);
      const synthesis = await current();
      state = await readSynthesisPublication(
        input.database,
        ...(args as [string, string, string])
      );
      if (!state) throw new Error("Synthesis publication intent not found");
      if (state.plan?.anchor) target = pageTarget(state.plan.anchor);
      if (
        state.phase === "recorded" &&
        state.pendingObservation?.outcome.status === "succeeded"
      )
        return await deliver(state.pendingObservation);
      if (state.phase === "unclaimed") {
        if (recovery || state.intent.status !== "approved")
          throw new Error("Synthesis publication requires its exact approved intent");
        const knownAnchor = await readCanonicalPublicationAnchor(
          input.database,
          scope.workspace.workspaceId,
          scope.meetingId
        );
        if (
          knownAnchor &&
          synthesis.canonicalAnchorRef &&
          (knownAnchor.providerId !== synthesis.canonicalAnchorRef.providerId ||
            knownAnchor.externalId !== synthesis.canonicalAnchorRef.externalId)
        )
          throw new Error("A different native anchor requires explicit canonical review");
        const prepared: SynthesisPublicationState = {
          ...state,
          phase: "prepared",
          intent: { ...state.intent, status: "executing" },
          executionLeaseId: randomUUID(),
          plan: {
            workspaceId: scope.workspace.workspaceId,
            logicalMeetingId: scope.meetingId,
            intentId: scope.intentId,
            operationToken: randomUUID(),
            audience: state.audience,
            synthesis,
            anchor: knownAnchor ?? synthesis.canonicalAnchorRef
          }
        };
        await input.database.transaction(async (tx) => {
          await tx.query(
            "INSERT INTO meeting_synthesis_publication_locks(workspace_id,meeting_id,intent_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            args
          );
          const lock = await tx.query<{ intent_id: string }>(
            "SELECT intent_id FROM meeting_synthesis_publication_locks WHERE workspace_id=$1 AND meeting_id=$2 FOR UPDATE",
            args.slice(0, 2)
          );
          if (lock.rows[0]?.intent_id !== scope.intentId)
            throw new Error(
              "An earlier uncertain synthesis publication requires recovery"
            );
          const row = await tx.query<{ state_json: string }>(
            "SELECT state_json FROM meeting_synthesis_publications WHERE workspace_id=$1 AND meeting_id=$2 AND intent_id=$3 FOR UPDATE",
            args
          );
          const latest = JSON.parse(row.rows[0]!.state_json) as SynthesisPublicationState;
          if (latest.phase !== "unclaimed" || latest.intent.status !== "approved")
            throw new Error("Synthesis approval changed before claim");
          await tx.query(
            "UPDATE meeting_synthesis_publications SET state_json=$4 WHERE workspace_id=$1 AND meeting_id=$2 AND intent_id=$3",
            [...args, JSON.stringify(prepared)]
          );
        });
        state = prepared;
      }
      if (!state.plan || !state.executionLeaseId)
        throw new Error("Synthesis publication has no durable plan");
      if (state.plan.anchor) target = pageTarget(state.plan.anchor);
      if (!state.applied) {
        if (state.phase !== "prepared") {
          if (!recovery)
            throw new Error("Uncertain synthesis publication requires positive recovery");
          const found = await input.writer.findPublished({
            publication: state.plan,
            requireCurrent: async () => {
              await current();
            }
          });
          if (found) await recordApplied(found);
        } else {
          try {
            writing = true;
            await current();
            await input.writer.publish({
              publication: state.plan,
              requireCurrent: async () => {
                await current();
              },
              beforeWrite: async (reference) => {
                if (reference) {
                  target = pageTarget(reference);
                  const acquired = await acquireOperationalOutcomePageLease({
                    database: input.database,
                    workspaceId: scope.workspace.workspaceId,
                    meetingId: scope.meetingId,
                    intentId: scope.intentId,
                    target,
                    executionLeaseId: state!.executionLeaseId!,
                    now: input.now()
                  });
                  if (acquired !== "acquired")
                    throw new Error(
                      "Canonical page is already owned by another publication"
                    );
                }
                await current();
                await save({ ...state!, phase: "dispatching" });
              },
              recordApplied
            });
          } catch (error) {
            state = await readSynthesisPublication(
              input.database,
              ...(args as [string, string, string])
            );
            if (
              !state?.applied &&
              error instanceof MeetingSynthesisWriteNotAppliedError
            ) {
              await save({
                ...state!,
                phase: "unclaimed",
                intent: { ...state!.intent, status: "approved" },
                plan: null,
                executionLeaseId: null
              });
              await release();
              throw error;
            }
          }
        }
      }
      state = await readSynthesisPublication(
        input.database,
        ...(args as [string, string, string])
      );
      if (state?.applied && state.anchorStatus !== "recorded") {
        await recordApplied(state.applied).catch(() => undefined);
        state = await readSynthesisPublication(
          input.database,
          ...(args as [string, string, string])
        );
      }
      if (!state?.executionLeaseId)
        throw new Error("Synthesis publication lease was lost");
      const observation: FollowUpExecutionRecorded =
        (!state.applied || state.anchorStatus !== "recorded") &&
        state.pendingObservation?.outcome.status === "failed"
          ? state.pendingObservation
          : {
              type: "follow-up-execution-recorded",
              observationId: `${scope.intentId}:${state.executionLeaseId}:${state.applied && state.anchorStatus === "recorded" ? "succeeded" : state.applied ? "anchor-review" : "unknown"}`,
              workspaceId: scope.workspace.workspaceId,
              meetingId: scope.meetingId,
              occurredAt: input.now().toISOString(),
              observedAt: input.now().toISOString(),
              intentId: scope.intentId,
              executionLeaseId: state.executionLeaseId,
              outcome:
                state.applied && state.anchorStatus === "recorded"
                  ? {
                      status: "succeeded",
                      externalReferences: [state.applied.externalReference],
                      summary: "Luma Synthesis published."
                    }
                  : {
                      status: "failed",
                      errorCode: state.applied
                        ? "synthesis-canonical-anchor-unsettled"
                        : "synthesis-publication-indeterminate",
                      message: state.applied
                        ? "Publication applied, but its canonical anchor needs review. Luma preserved the existing anchor and will not repeat the write."
                        : "Publication may have applied. Luma will only use positive recovery and will not repeat the write.",
                      retryable: false,
                      requiresManualRecovery: true,
                      ...(state.applied
                        ? { externalReferences: [state.applied.externalReference] }
                        : {})
                    }
            };
      await save({ ...state, pendingObservation: observation });
      const result = await deliver(observation);
      return result;
    } finally {
      active.delete(key);
    }
    async function deliver(
      observation: FollowUpExecutionRecorded
    ): Promise<ExecuteFollowUpResult> {
      const update = await input.meetingIntelligence.observe({
        workspace: scope.workspace,
        observations: [observation]
      });
      if (
        update.errors.length ||
        !(
          update.acceptedObservationIds.includes(observation.observationId) ||
          update.duplicateObservationIds.includes(observation.observationId)
        )
      )
        throw new Error("Synthesis publication receipt was not accepted");
      if (observation.outcome.status === "succeeded") await release();
      else if (state?.applied && target)
        await releaseOperationalOutcomePageLease({
          database: input.database,
          workspaceId: scope.workspace.workspaceId,
          meetingId: scope.meetingId,
          intentId: scope.intentId,
          target
        });
      await current();
      const events = update.events.length
        ? update.events
        : observation.outcome.status === "succeeded"
          ? [
              {
                type: "follow-up-execution-succeeded" as const,
                intentId: scope.intentId,
                externalReferences: observation.outcome.externalReferences,
                summary: "Luma Synthesis published."
              }
            ]
          : [
              {
                type: "follow-up-execution-failed" as const,
                intentId: scope.intentId,
                message: "Synthesis publication requires review.",
                retryable: false
              }
            ];
      return { observation, events, idempotencyKey: scope.intentId };
    }
    function pageTarget(reference: ExternalReference): OperationalOutcomeTarget {
      if (reference.objectType !== "document")
        throw new Error("Synthesis anchor is not a document");
      return {
        workspaceId: scope.workspace.workspaceId,
        providerId: reference.providerId,
        page: { ...reference, objectType: "document" },
        sourceObjectId: scope.meetingId,
        sourceRevision: state!.intent.synthesisRevision,
        sourceContentHash: state!.intent.sourceSetDigest
      };
    }
  };
  return {
    execute: (request) =>
      isSynthesisPublicationIntent(request.intentId)
        ? run(request, false)
        : input.base.execute(request),
    recover: (request) =>
      isSynthesisPublicationIntent(request.intentId)
        ? run(request, true)
        : input.base.recover(request)
  };
}
