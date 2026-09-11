import { randomUUID } from "node:crypto";
import type { ExternalReference } from "../domain/model.js";
import {
  exactRegionCount,
  knowledgeDigest,
  type CanonicalKnowledgePatchWriter,
  type PreparedCanonicalKnowledgePatch
} from "../knowledge/canonical-knowledge-patch.js";
import type { LumaDatabase } from "../persistence/db.js";
import {
  acquireOperationalOutcomePageLease,
  releaseOperationalOutcomePageLease,
  type OperationalOutcomeSettlement
} from "./operational-outcome-settlement.js";

export class CanonicalPatchStageError extends Error {
  constructor(
    readonly disposition: "failed" | "manual" | "resumable",
    message: string,
    /** Exact provider reread evidence survives a later local persistence fault. */
    readonly externalReferences: ExternalReference[] = []
  ) {
    super(message);
  }
}

/** Durable exact-region write. Unknown sends are only probed, never repeated. */
export async function settleCanonicalKnowledgePatch(input: {
  database: LumaDatabase;
  workspaceId: string;
  meetingId: string;
  executionLeaseId: string;
  settlement: OperationalOutcomeSettlement;
  writer?: CanonicalKnowledgePatchWriter;
  requireCurrent(): Promise<void>;
  readOnly?: boolean;
}): Promise<ExternalReference[]> {
  const proposal = input.settlement.plan.canonicalKnowledgePatch;
  if (!proposal) return [];
  const stage = input.settlement.knowledge;
  if (!stage)
    throw new CanonicalPatchStageError("manual", "Canonical patch stage is missing.");
  const keys = [input.workspaceId, input.meetingId, input.settlement.plan.intentId];
  const target = {
    ...input.settlement.plan.target,
    providerId: proposal.target.providerId,
    page: proposal.target
  };
  const leaseInput = {
    database: input.database,
    workspaceId: input.workspaceId,
    meetingId: input.meetingId,
    intentId: input.settlement.plan.intentId,
    target
  };
  async function release(): Promise<void> {
    await releaseOperationalOutcomePageLease(leaseInput);
    const remaining = await input.database.query<{ intent_id: string }>(
      `SELECT intent_id FROM operational_outcome_page_leases
       WHERE source_provider_id=$1 AND source_document_id=$2 AND workspace_id=$3
         AND meeting_id=$4 AND intent_id=$5`,
      [target.providerId, target.page.externalId, ...keys]
    );
    if (remaining.rows.length)
      throw new CanonicalPatchStageError(
        "manual",
        "Canonical patch target lease could not be released."
      );
  }
  if (stage.status === "succeeded") {
    if (input.settlement.outcome.status === "pending") await release();
    return stage.externalReferences;
  }
  if (stage.status === "unresolved") {
    await release();
    throw new CanonicalPatchStageError(
      "failed",
      "Canonical patch conflicted with its selected region; fresh Human review is required."
    );
  }
  if (input.readOnly && stage.status === "pending") return [];
  const writer = input.writer;
  if (!writer || writer.providerId !== proposal.target.providerId) {
    throw new CanonicalPatchStageError(
      stage.status === "pending" ? "failed" : "manual",
      "The selected canonical knowledge writer is unavailable."
    );
  }
  const lease = await acquireOperationalOutcomePageLease({
    ...leaseInput,
    executionLeaseId: input.executionLeaseId,
    now: new Date()
  });
  if (lease !== "acquired")
    throw new CanonicalPatchStageError(
      lease === "busy" ? "resumable" : "failed",
      "The selected canonical document is held by another settlement or workspace."
    );
  let prepared: PreparedCanonicalKnowledgePatch;
  let crossedBoundary = stage.status !== "pending";
  let provenReference: ExternalReference | null = null;
  try {
    if (stage.status === "pending") {
      await input.requireCurrent();
      const before = await writer.readComplete(proposal.target.externalId);
      if (
        before.reference.providerId !== proposal.target.providerId ||
        before.reference.externalId !== proposal.target.externalId ||
        before.reference.objectType !== "document" ||
        exactRegionCount(before.markdown, proposal.expectedMarkdown) !== 1 ||
        before.markdown.trim() === proposal.expectedMarkdown.trim()
      ) {
        throw new CanonicalPatchStageError(
          "failed",
          "The selected canonical region is missing or not unique; no patch was sent."
        );
      }
      const after = before.markdown.replace(
        proposal.expectedMarkdown,
        () => proposal.replacementMarkdown
      );
      prepared = {
        operationToken: randomUUID(),
        proposalId: proposal.id,
        target: before.reference,
        expectedMarkdown: proposal.expectedMarkdown,
        replacementMarkdown: proposal.replacementMarkdown,
        beforeDigest: knowledgeDigest(before.markdown),
        afterDigest: knowledgeDigest(after),
        patchDigest: knowledgeDigest(JSON.stringify(proposal))
      };
      await input.requireCurrent();
      // Commit immutable recovery facts and the send boundary in one transaction.
      const result = await input.database.query(
        `UPDATE operational_outcome_settlement_stages SET status='executing',
         execution_lease_id=$4, attempts=attempts+1, prepared_patch_json=$5,
         prepared_operation_token=$6, payload_digest=$7, content_digest=$8,
         operation_digest=$9, updated_at=$10
         WHERE workspace_id=$1 AND meeting_id=$2 AND intent_id=$3 AND stage='knowledge' AND status='pending'`,
        [
          ...keys,
          input.executionLeaseId,
          JSON.stringify(prepared),
          prepared.operationToken,
          prepared.patchDigest,
          prepared.afterDigest,
          knowledgeDigest(JSON.stringify(prepared)),
          new Date().toISOString()
        ]
      );
      if (result.affectedRows !== 1)
        throw new CanonicalPatchStageError(
          "manual",
          "Canonical patch preparation did not retain its execution claim."
        );
      // A crash after preparation is conservatively unknown. In this live run,
      // a guard refusal still proves no provider method was entered.
      await input.requireCurrent();
      crossedBoundary = true;
      await writer.replaceExact({
        externalId: proposal.target.externalId,
        expectedMarkdown: prepared.expectedMarkdown,
        replacementMarkdown: prepared.replacementMarkdown
      });
    } else {
      if (!stage.preparedPatchJson)
        throw new CanonicalPatchStageError(
          "manual",
          "Canonical patch has no immutable recovery request."
        );
      prepared = JSON.parse(stage.preparedPatchJson) as PreparedCanonicalKnowledgePatch;
      if (
        prepared.proposalId !== proposal.id ||
        prepared.patchDigest !== knowledgeDigest(JSON.stringify(proposal)) ||
        prepared.operationToken !== stage.preparedOperationToken ||
        prepared.afterDigest !== stage.contentDigest ||
        knowledgeDigest(JSON.stringify(prepared)) !== stage.operationDigest ||
        prepared.expectedMarkdown !== proposal.expectedMarkdown ||
        prepared.replacementMarkdown !== proposal.replacementMarkdown ||
        prepared.target.providerId !== proposal.target.providerId ||
        prepared.target.externalId !== proposal.target.externalId
      ) {
        throw new CanonicalPatchStageError(
          "manual",
          "Canonical patch recovery facts do not match the approved proposal."
        );
      }
    }
    const after = await writer.readComplete(proposal.target.externalId);
    if (
      after.reference.providerId !== proposal.target.providerId ||
      after.reference.externalId !== proposal.target.externalId ||
      after.reference.objectType !== "document" ||
      knowledgeDigest(after.markdown) !== prepared.afterDigest
    ) {
      throw new CanonicalPatchStageError(
        "manual",
        "The canonical patch's exact prepared result could not be proven; no retry was sent."
      );
    }
    const reference = after.reference;
    provenReference = { ...reference };
    const result = await input.database.query(
      `UPDATE operational_outcome_settlement_stages SET status='succeeded', reference_json=$4,
       execution_lease_id=$5, last_error_code=NULL, last_error_message=NULL, completed_at=$6, updated_at=$6
       WHERE workspace_id=$1 AND meeting_id=$2 AND intent_id=$3 AND stage='knowledge'
         AND status IN ('executing','requires-manual-recovery') AND prepared_operation_token=$7`,
      [
        ...keys,
        JSON.stringify([reference]),
        input.executionLeaseId,
        new Date().toISOString(),
        prepared.operationToken
      ]
    );
    if (result.affectedRows !== 1)
      throw new CanonicalPatchStageError(
        "manual",
        "Canonical patch proof could not be recorded durably."
      );
    await release();
    return [reference];
  } catch (error) {
    const disposition = crossedBoundary
      ? "manual"
      : error instanceof CanonicalPatchStageError
        ? error.disposition
        : "failed";
    const message =
      error instanceof CanonicalPatchStageError
        ? error.message
        : provenReference
          ? "The canonical patch's exact result was observed, but its durable record or target release could not be established. Run recovery without repeating the patch."
          : crossedBoundary
            ? "Canonical patch outcome is unknown; only an exact positive reread may recover it."
            : "The selected canonical document could not be checked completely; no patch was sent.";
    const externalReferences = provenReference ? [provenReference] : [];
    try {
      await input.database.query(
        `UPDATE operational_outcome_settlement_stages SET status=$4, last_error_code='canonical-knowledge-patch-unresolved',
       last_error_message=$5, updated_at=$6
       WHERE workspace_id=$1 AND meeting_id=$2 AND intent_id=$3 AND stage='knowledge' AND status <> 'succeeded'`,
        [
          ...keys,
          crossedBoundary ? "requires-manual-recovery" : "unresolved",
          message,
          new Date().toISOString()
        ]
      );
      if (!crossedBoundary) await release();
    } catch {
      throw new CanonicalPatchStageError(
        "manual",
        "Canonical patch recovery state could not be recorded or released durably. No patch retry was sent.",
        externalReferences
      );
    }
    throw new CanonicalPatchStageError(disposition, message, externalReferences);
  }
}
