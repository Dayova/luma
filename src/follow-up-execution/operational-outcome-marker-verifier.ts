import type { OperationalOutcomeMarkerVerifier } from "../knowledge/operational-outcome-writer.js";
import type { LumaDatabase } from "../persistence/db.js";

/**
 * Proves that an outcome section on a source page was durably accepted by
 * Luma. Structural marker checks are intentionally insufficient: users can
 * paste checksum-looking Markdown, but only a completed settlement stores the
 * payload digest against its provider/page identity.
 */
export function createOperationalOutcomeMarkerVerifier(input: {
  database: Pick<LumaDatabase, "query">;
}): OperationalOutcomeMarkerVerifier {
  return {
    async isOwned(marker) {
      const result = await input.database.query<{ owned: number }>(
        `SELECT 1 AS owned
           FROM operational_outcome_settlements AS settlement
           JOIN operational_outcome_settlement_stages AS stage
             ON stage.workspace_id = settlement.workspace_id
            AND stage.meeting_id = settlement.meeting_id
            AND stage.intent_id = settlement.intent_id
          WHERE settlement.workspace_id = $1
            AND settlement.source_provider_id = $2
            AND settlement.source_document_id = $3
            AND stage.stage = 'outcome'
            AND stage.status = 'succeeded'
            AND stage.payload_digest = $4
            AND stage.content_digest = $5
            AND stage.operation_digest = $6
          LIMIT 1`,
        [
          marker.workspaceId,
          marker.providerId,
          marker.pageExternalId,
          marker.payloadDigest,
          marker.contentDigest,
          marker.operationDigest
        ]
      );

      return result.rows.length === 1;
    }
  };
}
