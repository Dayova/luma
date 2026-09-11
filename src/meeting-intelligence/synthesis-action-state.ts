import type { MeetingState } from "../domain/model.js";
import type { LumaDatabase } from "../persistence/db.js";

const table = `CREATE TABLE IF NOT EXISTS synthesis_action_execution_fences (
 workspace_id TEXT NOT NULL, meeting_id TEXT NOT NULL, intent_id TEXT NOT NULL,
 execution_lease_id TEXT NOT NULL, target_json TEXT NOT NULL,
 PRIMARY KEY(workspace_id,meeting_id))`;
export async function ensureSynthesisActionFences(
  database: Pick<LumaDatabase, "query">
): Promise<void> {
  await database.query(table);
}
export async function releaseSynthesisActionFence(input: {
  database: Pick<LumaDatabase, "query">;
  workspaceId: string;
  meetingId: string;
  intentId: string;
}): Promise<void> {
  await ensureSynthesisActionFences(input.database);
  await input.database.query(
    "DELETE FROM synthesis_action_execution_fences WHERE workspace_id=$1 AND meeting_id=$2 AND intent_id=$3",
    [input.workspaceId, input.meetingId, input.intentId]
  );
}
/** Source admission and execution use the same durable row; unknown provider effects retain it. */
export async function requireUnfencedSynthesis(
  database: Pick<LumaDatabase, "query">,
  workspaceId: string,
  meetingId: string
): Promise<void> {
  const held = await database.query(
    "SELECT intent_id FROM synthesis_action_execution_fences WHERE workspace_id=$1 AND meeting_id=$2 FOR UPDATE",
    [workspaceId, meetingId]
  );
  if (held.rows.length)
    throw new Error("A source-bound action is executing or needs positive recovery");
}

/** Retain history in storage, but do not disclose claims from a no-longer-proven capture set. */
export function projectCurrentSynthesisActions(state: MeetingState): MeetingState {
  const source = state.captureSynthesisActionSource;
  if (!source) return state;
  const candidates = state.importedActionItemCandidates.filter(
    (candidate) =>
      candidate.source.source.sourceKind === "capture-synthesis" &&
      candidate.source.source.contentHash === source.sourceSetDigest
  );
  const ids = new Set(candidates.map((candidate) => candidate.id));
  const reviews = state.actionItemReconciliationReviews.filter((review) =>
    ids.has(review.candidateId)
  );
  const reviewIds = new Set(reviews.map((review) => review.id));
  return {
    ...state,
    importedActionItemCandidates: candidates,
    currentImportedActionItemCandidateIds:
      state.currentImportedActionItemCandidateIds.filter((id) => ids.has(id)),
    actionItemReconciliationReviews: reviews,
    actionItemReconciliationHumanResolutions:
      state.actionItemReconciliationHumanResolutions.filter((item) =>
        reviewIds.has(item.reviewId)
      ),
    actionItemOwnershipHumanResolutions: state.actionItemOwnershipHumanResolutions.filter(
      (item) => ids.has(item.candidateId)
    ),
    actionItemReconciliationCreatedWorkMappings:
      state.actionItemReconciliationCreatedWorkMappings.filter((item) =>
        ids.has(item.candidateId)
      ),
    followUpIntentions: state.followUpIntentions.filter(
      (intent) =>
        !("reconciliation" in intent) ||
        !intent.reconciliation ||
        ids.has(intent.reconciliation.candidateId)
    )
  };
}
