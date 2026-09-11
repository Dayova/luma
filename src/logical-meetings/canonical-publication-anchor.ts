import type { ExternalReference } from "../domain/model.js";
import type { LumaDatabase } from "../persistence/db.js";

/** Private persistence bridge. There is no caller-controlled public anchor setter. */
export async function recordCanonicalPublicationAnchor(input: {
  database: LumaDatabase;
  workspaceId: string;
  logicalMeetingId: string;
  intentId: string;
  executionLeaseId: string;
  reference: ExternalReference;
}): Promise<"recorded" | "conflict"> {
  return input.database.transaction(async (tx) => {
    const receiptRows = await tx.query<{ state_json: string }>(
      "SELECT state_json FROM meeting_synthesis_publications WHERE workspace_id=$1 AND meeting_id=$2 AND intent_id=$3 FOR UPDATE",
      [input.workspaceId, input.logicalMeetingId, input.intentId]
    );
    const receipt = receiptRows.rows[0]
      ? (JSON.parse(receiptRows.rows[0].state_json) as {
          executionLeaseId?: string;
          plan?: {
            workspaceId: string;
            logicalMeetingId: string;
            intentId: string;
            operationToken: string;
          };
          applied?: { operationToken: string; externalReference: ExternalReference };
        })
      : null;
    if (
      !receipt?.plan ||
      !receipt.applied ||
      receipt.executionLeaseId !== input.executionLeaseId ||
      receipt.plan.workspaceId !== input.workspaceId ||
      receipt.plan.logicalMeetingId !== input.logicalMeetingId ||
      receipt.plan.intentId !== input.intentId ||
      receipt.plan.operationToken !== receipt.applied.operationToken ||
      !sameAnchor(receipt.applied.externalReference, input.reference)
    )
      throw new Error(
        "Canonical anchor requires its positively recorded publication receipt"
      );
    const rows = await tx.query<{ canonical_anchor_ref_json: string | null }>(
      "SELECT canonical_anchor_ref_json FROM logical_meetings WHERE workspace_id=$1 AND logical_meeting_id=$2 FOR UPDATE",
      [input.workspaceId, input.logicalMeetingId]
    );
    if (!rows.rows[0]) throw new Error("Published Logical Meeting was not found");
    const existing = rows.rows[0].canonical_anchor_ref_json
      ? (JSON.parse(rows.rows[0].canonical_anchor_ref_json) as ExternalReference)
      : null;
    if (existing && !sameAnchor(existing, input.reference)) return "conflict";
    if (!existing)
      await tx.query(
        "UPDATE logical_meetings SET canonical_anchor_ref_json=$3 WHERE workspace_id=$1 AND logical_meeting_id=$2 AND canonical_anchor_ref_json IS NULL",
        [input.workspaceId, input.logicalMeetingId, JSON.stringify(input.reference)]
      );
    return "recorded";
  });
}
export async function readCanonicalPublicationAnchor(
  database: LumaDatabase,
  workspaceId: string,
  logicalMeetingId: string
): Promise<ExternalReference | null> {
  const rows = await database.query<{ canonical_anchor_ref_json: string | null }>(
    "SELECT canonical_anchor_ref_json FROM logical_meetings WHERE workspace_id=$1 AND logical_meeting_id=$2",
    [workspaceId, logicalMeetingId]
  );
  return rows.rows[0]?.canonical_anchor_ref_json
    ? (JSON.parse(rows.rows[0].canonical_anchor_ref_json) as ExternalReference)
    : null;
}
export function sameAnchor(
  left: ExternalReference | null,
  right: ExternalReference | null
): boolean {
  return left === null || right === null
    ? left === right
    : left.providerId === right.providerId &&
        left.objectType === right.objectType &&
        left.externalId === right.externalId;
}
