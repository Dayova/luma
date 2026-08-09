import type {
  ActionItemOwnershipAttribution,
  ActionItemReconciliationHumanResolution,
  ActionItemReconciliationIntentBinding,
  ExternalReference,
  ImportedActionItemCandidate
} from "../domain/model.js";
import { sameActionItemOwnership } from "../domain/action-item-ownership.js";
import type {
  OperationalOutcome,
  OperationalOutcomeTarget
} from "../knowledge/operational-outcome-writer.js";
import type { LumaDatabase } from "../persistence/db.js";

export type OperationalOutcomeSettlementPlan = {
  /**
   * Versions 1 and 2 are read-compatible historical plans. New plans are v3;
   * old plans get explicit empty implementation references when read so they
   * remain aggregates without gaining a new source claim during recovery.
   */
  version: 1 | 2 | 3;
  intentId: string;
  binding: ActionItemReconciliationIntentBinding;
  target: OperationalOutcomeTarget;
  candidate: ImportedActionItemCandidate;
  /** Effective reviewed ownership; source candidate wording stays immutable. */
  ownership: ActionItemOwnershipAttribution;
  resolution: ActionItemReconciliationHumanResolution;
  /**
   * Exact GitHub PR/commit locators frozen from immutable source wording at
   * plan creation. They are display provenance, never live GitHub facts.
   */
  sourceBoundImplementationReferences: ExternalReference[];
};

/** New execution plans must carry ownership plus source-bound code references. */
export type NewOperationalOutcomeSettlementPlan = OperationalOutcomeSettlementPlan & {
  version: 3;
};

export type OperationalOutcomeSettlementStageName = "work" | "outcome";

export type OperationalOutcomeSettlementStageStatus =
  | "not-required"
  | "pending"
  | "executing"
  | "succeeded"
  | "unresolved"
  | "requires-manual-recovery";

export type OperationalOutcomeSettlementStage = {
  stage: OperationalOutcomeSettlementStageName;
  status: OperationalOutcomeSettlementStageStatus;
  idempotencyKey: string;
  externalReferences: ExternalReference[];
  /** Immutable aggregate prepared before the page mutation boundary. */
  preparedOutcomeJson: string | null;
  preparedOperationToken: string | null;
  payloadDigest: string | null;
  contentDigest: string | null;
  operationDigest: string | null;
  error: { code: string; message: string } | null;
  executionLeaseId: string | null;
  attempts: number;
};

export type OperationalOutcomeSettlement = {
  plan: OperationalOutcomeSettlementPlan;
  work: OperationalOutcomeSettlementStage;
  outcome: OperationalOutcomeSettlementStage;
};

type SettlementRow = {
  plan_json: string;
};

type SettlementStageRow = {
  stage: OperationalOutcomeSettlementStageName;
  status: OperationalOutcomeSettlementStageStatus;
  idempotency_key: string;
  reference_json: string | null;
  prepared_outcome_json: string | null;
  prepared_operation_token: string | null;
  payload_digest: string | null;
  content_digest: string | null;
  operation_digest: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  execution_lease_id: string | null;
  attempts: number;
};

type PageLeaseRow = {
  workspace_id: string;
  meeting_id: string;
  intent_id: string;
  execution_lease_id: string;
};

type PageOwnershipRow = {
  workspace_id: string;
};

export type OperationalOutcomePageLeaseAcquisition =
  "acquired" | "busy" | "workspace-mismatch";

export async function ensureOperationalOutcomeSettlement(input: {
  database: LumaDatabase;
  workspaceId: string;
  meetingId: string;
  plan: NewOperationalOutcomeSettlementPlan;
  now: Date;
}): Promise<OperationalOutcomeSettlement> {
  const { database, workspaceId, meetingId, plan } = input;
  const timestamp = input.now.toISOString();
  const planJson = JSON.stringify(plan);

  if (plan.version !== 3) {
    throw new Error("Legacy Operational Outcome plans are read-only and not executable");
  }

  return database.transaction(async (transaction) => {
    const existing = await transaction.query<SettlementRow>(
      `SELECT plan_json
         FROM operational_outcome_settlements
        WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3
        FOR UPDATE`,
      [workspaceId, meetingId, plan.intentId]
    );
    const existingPlanJson = existing.rows[0]?.plan_json;

    if (existingPlanJson && existingPlanJson !== planJson) {
      const existingPlan = parsePlan(existingPlanJson);

      if (!isReadCompatibleV2Plan(existingPlan, plan)) {
        throw new Error(
          `Operational Outcome settlement ${plan.intentId} conflicts with its immutable canonical plan`
        );
      }
    }

    if (!existingPlanJson) {
      await transaction.query(
        `INSERT INTO operational_outcome_settlements (
           workspace_id, meeting_id, intent_id, review_id, candidate_id,
           candidate_lineage_key, source_provider_id, source_document_id,
           source_object_id, source_revision, source_content_hash, plan_json,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
        [
          workspaceId,
          meetingId,
          plan.intentId,
          plan.binding.reviewId,
          plan.binding.candidateId,
          plan.binding.candidateLineageKey,
          plan.target.providerId,
          plan.target.page.externalId,
          plan.target.sourceObjectId,
          plan.target.sourceRevision,
          plan.target.sourceContentHash,
          planJson,
          timestamp
        ]
      );

      const workStatus = workStageInitialStatus(plan);

      for (const stage of ["work", "outcome"] as const) {
        await transaction.query(
          `INSERT INTO operational_outcome_settlement_stages (
             workspace_id, meeting_id, intent_id, stage, status,
             idempotency_key, attempts, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $7)`,
          [
            workspaceId,
            meetingId,
            plan.intentId,
            stage,
            stage === "work" ? workStatus : "pending",
            settlementStageIdempotencyKey(workspaceId, meetingId, plan.intentId, stage),
            timestamp
          ]
        );
      }
    }

    return requireOperationalOutcomeSettlement(
      transaction,
      workspaceId,
      meetingId,
      plan.intentId
    );
  });
}

export async function readOperationalOutcomeSettlement(input: {
  database: Pick<LumaDatabase, "query">;
  workspaceId: string;
  meetingId: string;
  intentId: string;
}): Promise<OperationalOutcomeSettlement | null> {
  const settlement = await input.database.query<SettlementRow>(
    `SELECT plan_json
       FROM operational_outcome_settlements
      WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3`,
    [input.workspaceId, input.meetingId, input.intentId]
  );
  const planJson = settlement.rows[0]?.plan_json;

  if (!planJson) {
    return null;
  }

  const stages = await input.database.query<SettlementStageRow>(
    `SELECT stage, status, idempotency_key, reference_json, prepared_outcome_json,
            prepared_operation_token,
            payload_digest,
            content_digest, operation_digest, last_error_code,
            last_error_message, execution_lease_id, attempts
       FROM operational_outcome_settlement_stages
      WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3`,
    [input.workspaceId, input.meetingId, input.intentId]
  );

  return settlementFromRows(planJson, stages.rows);
}

/**
 * Reads every durable settlement targeting one parent document. A Notion page
 * can contain multiple Meeting Notes roots, so aggregation is page-wide rather
 * than scoped to the one source root currently being settled.
 */
export async function listOperationalOutcomeSettlementsForPage(input: {
  database: Pick<LumaDatabase, "query">;
  workspaceId: string;
  target: OperationalOutcomeTarget;
}): Promise<OperationalOutcomeSettlement[]> {
  const result = await input.database.query<
    SettlementStageRow & { intent_id: string; plan_json: string }
  >(
    `SELECT settlement.intent_id, settlement.plan_json,
            stage.stage, stage.status, stage.idempotency_key, stage.reference_json,
            stage.prepared_outcome_json, stage.prepared_operation_token,
            stage.payload_digest, stage.content_digest, stage.operation_digest,
            stage.last_error_code, stage.last_error_message,
            stage.execution_lease_id, stage.attempts
       FROM operational_outcome_settlements AS settlement
       JOIN operational_outcome_settlement_stages AS stage
         ON stage.workspace_id = settlement.workspace_id
        AND stage.meeting_id = settlement.meeting_id
        AND stage.intent_id = settlement.intent_id
      WHERE settlement.workspace_id = $1
        AND settlement.source_provider_id = $2
        AND settlement.source_document_id = $3
      ORDER BY settlement.intent_id ASC, stage.stage ASC`,
    [input.workspaceId, input.target.providerId, input.target.page.externalId]
  );
  const rowsByIntent = new Map<
    string,
    { planJson: string; stages: SettlementStageRow[] }
  >();

  for (const row of result.rows) {
    const existing = rowsByIntent.get(row.intent_id);

    if (existing) {
      existing.stages.push(row);
    } else {
      rowsByIntent.set(row.intent_id, { planJson: row.plan_json, stages: [row] });
    }
  }

  return [...rowsByIntent.values()]
    .map(({ planJson, stages }) => settlementFromRows(planJson, stages))
    .sort((left, right) => compareBytewise(left.plan.intentId, right.plan.intentId));
}

export async function claimOperationalOutcomeSettlementStage(input: {
  database: LumaDatabase;
  workspaceId: string;
  meetingId: string;
  intentId: string;
  stage: OperationalOutcomeSettlementStageName;
  executionLeaseId: string;
  now: Date;
}): Promise<OperationalOutcomeSettlementStage> {
  const timestamp = input.now.toISOString();

  return input.database.transaction(async (transaction) => {
    const result = await transaction.query<SettlementStageRow>(
      `SELECT stage, status, idempotency_key, reference_json, prepared_outcome_json,
              prepared_operation_token,
              payload_digest,
              content_digest, operation_digest, last_error_code,
              last_error_message, execution_lease_id, attempts
         FROM operational_outcome_settlement_stages
        WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3 AND stage = $4
        FOR UPDATE`,
      [input.workspaceId, input.meetingId, input.intentId, input.stage]
    );
    const row = result.rows[0];

    if (!row) {
      throw new Error(
        `Operational Outcome settlement ${input.intentId} does not have a ${input.stage} stage`
      );
    }

    if (row.status !== "pending") {
      return stageFromRow(row);
    }

    const updated = await transaction.query<SettlementStageRow>(
      `UPDATE operational_outcome_settlement_stages
          SET status = 'executing', execution_lease_id = $5,
              attempts = attempts + 1, updated_at = $6,
              last_error_code = NULL, last_error_message = NULL
        WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3 AND stage = $4
        RETURNING stage, status, idempotency_key, reference_json, prepared_outcome_json,
                  prepared_operation_token,
                  payload_digest,
                  content_digest, operation_digest, last_error_code,
                  last_error_message, execution_lease_id, attempts`,
      [
        input.workspaceId,
        input.meetingId,
        input.intentId,
        input.stage,
        input.executionLeaseId,
        timestamp
      ]
    );
    const claimed = updated.rows[0];

    if (!claimed) {
      throw new Error(
        `Operational Outcome settlement ${input.intentId} stage claim failed`
      );
    }

    return stageFromRow(claimed);
  });
}

export async function completeOperationalOutcomeSettlementStage(input: {
  database: LumaDatabase;
  workspaceId: string;
  meetingId: string;
  intentId: string;
  stage: OperationalOutcomeSettlementStageName;
  executionLeaseId: string;
  externalReferences: ExternalReference[];
  /** Present only for a completed page-output stage. */
  payloadDigest?: string;
  contentDigest?: string;
  operationDigest?: string;
  now: Date;
}): Promise<void> {
  const result = await input.database.query(
    `UPDATE operational_outcome_settlement_stages
        SET status = 'succeeded', reference_json = $6, payload_digest = $7,
            content_digest = $8, operation_digest = $9,
            updated_at = $10, completed_at = $10,
            last_error_code = NULL, last_error_message = NULL
      WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3 AND stage = $4
        AND status = 'executing' AND execution_lease_id = $5`,
    [
      input.workspaceId,
      input.meetingId,
      input.intentId,
      input.stage,
      input.executionLeaseId,
      JSON.stringify(input.externalReferences),
      input.payloadDigest ?? null,
      input.contentDigest ?? null,
      input.operationDigest ?? null,
      input.now.toISOString()
    ]
  );

  if (result.affectedRows !== 1) {
    throw new Error(
      `Operational Outcome settlement ${input.intentId} no longer owns its ${input.stage} stage`
    );
  }
}

/**
 * Persist the exact aggregate before crossing the provider mutation boundary.
 * Recovery can then use a positive reread of this immutable prepared value;
 * it never rebuilds a possibly newer page aggregate after a crash.
 */
export async function prepareOperationalOutcomeSettlementOutput(input: {
  database: LumaDatabase;
  workspaceId: string;
  meetingId: string;
  intentId: string;
  executionLeaseId: string;
  outcome: OperationalOutcome;
  operationToken: string;
  payloadDigest: string;
  contentDigest: string;
  operationDigest: string;
  now: Date;
}): Promise<void> {
  const result = await input.database.query(
    `UPDATE operational_outcome_settlement_stages
        SET prepared_outcome_json = $5, prepared_operation_token = $6,
            payload_digest = $7, content_digest = $8, operation_digest = $9,
            updated_at = $10
      WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3 AND stage = 'outcome'
        AND status = 'executing' AND execution_lease_id = $4`,
    [
      input.workspaceId,
      input.meetingId,
      input.intentId,
      input.executionLeaseId,
      // The renderer derives the durable digest from this structured value.
      // JSON is retained solely as a recovery input, not as a public contract.
      JSON.stringify(input.outcome),
      input.operationToken,
      input.payloadDigest,
      input.contentDigest,
      input.operationDigest,
      input.now.toISOString()
    ]
  );

  if (result.affectedRows !== 1) {
    throw new Error(
      `Operational Outcome settlement ${input.intentId} no longer owns its prepared output stage`
    );
  }
}

/** Record a provider's explicit no-write result before local cleanup begins. */
export async function recordOperationalOutcomeKnownNotApplied(input: {
  database: LumaDatabase;
  workspaceId: string;
  meetingId: string;
  intentId: string;
  executionLeaseId: string;
  error: { code: string; message: string };
  now: Date;
}): Promise<void> {
  const result = await input.database.query(
    `UPDATE operational_outcome_settlement_stages
        SET last_error_code = $5, last_error_message = $6, updated_at = $7
      WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3 AND stage = 'outcome'
        AND status = 'executing' AND execution_lease_id = $4`,
    [
      input.workspaceId,
      input.meetingId,
      input.intentId,
      input.executionLeaseId,
      input.error.code,
      input.error.message,
      input.now.toISOString()
    ]
  );

  if (result.affectedRows !== 1) {
    throw new Error(
      `Operational Outcome settlement ${input.intentId} no longer owns its output stage`
    );
  }
}

export async function markOperationalOutcomeSettlementStagePending(input: {
  database: LumaDatabase;
  workspaceId: string;
  meetingId: string;
  intentId: string;
  stage: OperationalOutcomeSettlementStageName;
  executionLeaseId: string;
  error: { code: string; message: string };
  now: Date;
}): Promise<void> {
  const result = await input.database.query(
    `UPDATE operational_outcome_settlement_stages
        SET status = 'pending', execution_lease_id = NULL, prepared_outcome_json = NULL,
            prepared_operation_token = NULL, payload_digest = NULL,
            content_digest = NULL, operation_digest = NULL,
            last_error_code = $6, last_error_message = $7, updated_at = $8
      WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3 AND stage = $4
        AND status = 'executing' AND execution_lease_id = $5`,
    [
      input.workspaceId,
      input.meetingId,
      input.intentId,
      input.stage,
      input.executionLeaseId,
      input.error.code,
      input.error.message,
      input.now.toISOString()
    ]
  );

  if (result.affectedRows !== 1) {
    throw new Error(
      `Operational Outcome settlement ${input.intentId} no longer owns its ${input.stage} stage`
    );
  }
}

export async function markOperationalOutcomeSettlementStageTerminal(input: {
  database: LumaDatabase;
  workspaceId: string;
  meetingId: string;
  intentId: string;
  stage: OperationalOutcomeSettlementStageName;
  executionLeaseId: string;
  status: "unresolved" | "requires-manual-recovery";
  externalReferences?: ExternalReference[];
  error: { code: string; message: string };
  now: Date;
}): Promise<void> {
  const result = await input.database.query(
    `UPDATE operational_outcome_settlement_stages
        SET status = $6, execution_lease_id = NULL, reference_json = $7,
            last_error_code = $8, last_error_message = $9, updated_at = $10,
            completed_at = $10
      WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3 AND stage = $4
        AND status = 'executing' AND execution_lease_id = $5`,
    [
      input.workspaceId,
      input.meetingId,
      input.intentId,
      input.stage,
      input.executionLeaseId,
      input.status,
      input.externalReferences ? JSON.stringify(input.externalReferences) : null,
      input.error.code,
      input.error.message,
      input.now.toISOString()
    ]
  );

  if (result.affectedRows !== 1) {
    throw new Error(
      `Operational Outcome settlement ${input.intentId} no longer owns its ${input.stage} stage`
    );
  }
}

/** Complete a page-output stage and free its page lease as one local commit. */
export async function completeOperationalOutcomeSettlementOutputAndReleasePageLease(input: {
  database: LumaDatabase;
  workspaceId: string;
  meetingId: string;
  intentId: string;
  executionLeaseId: string;
  target: OperationalOutcomeTarget;
  externalReferences: ExternalReference[];
  payloadDigest: string;
  contentDigest: string;
  operationDigest: string;
  now: Date;
}): Promise<void> {
  const timestamp = input.now.toISOString();

  await input.database.transaction(async (transaction) => {
    const completed = await transaction.query(
      `UPDATE operational_outcome_settlement_stages
          SET status = 'succeeded', reference_json = $5, payload_digest = $6,
              content_digest = $7, operation_digest = $8, updated_at = $9,
              completed_at = $9, last_error_code = NULL, last_error_message = NULL
        WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3 AND stage = 'outcome'
          AND status = 'executing' AND execution_lease_id = $4`,
      [
        input.workspaceId,
        input.meetingId,
        input.intentId,
        input.executionLeaseId,
        JSON.stringify(input.externalReferences),
        input.payloadDigest,
        input.contentDigest,
        input.operationDigest,
        timestamp
      ]
    );

    if (completed.affectedRows !== 1) {
      throw new Error(
        `Operational Outcome settlement ${input.intentId} no longer owns its outcome stage`
      );
    }

    await transaction.query(
      `DELETE FROM operational_outcome_page_leases
        WHERE source_provider_id = $1 AND source_document_id = $2
          AND workspace_id = $3 AND meeting_id = $4 AND intent_id = $5
          AND execution_lease_id = $6`,
      [
        input.target.providerId,
        input.target.page.externalId,
        input.workspaceId,
        input.meetingId,
        input.intentId,
        input.executionLeaseId
      ]
    );
  });
}

/**
 * A manual recovery may complete an earlier prepared page write only after a
 * positive exact reread. The original execution lease is intentionally no
 * longer trusted, so this transitions solely from the durable manual state.
 */
export async function completeOperationalOutcomeSettlementManualOutputAndReleasePageLease(input: {
  database: LumaDatabase;
  workspaceId: string;
  meetingId: string;
  intentId: string;
  target: OperationalOutcomeTarget;
  externalReferences: ExternalReference[];
  payloadDigest: string;
  contentDigest: string;
  operationDigest: string;
  now: Date;
}): Promise<void> {
  const timestamp = input.now.toISOString();

  await input.database.transaction(async (transaction) => {
    const completed = await transaction.query(
      `UPDATE operational_outcome_settlement_stages
          SET status = 'succeeded', reference_json = $4, payload_digest = $5,
              content_digest = $6, operation_digest = $7, updated_at = $8,
              completed_at = $8, last_error_code = NULL, last_error_message = NULL
        WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3 AND stage = 'outcome'
          AND status = 'requires-manual-recovery'`,
      [
        input.workspaceId,
        input.meetingId,
        input.intentId,
        JSON.stringify(input.externalReferences),
        input.payloadDigest,
        input.contentDigest,
        input.operationDigest,
        timestamp
      ]
    );

    if (completed.affectedRows !== 1) {
      throw new Error(
        `Operational Outcome settlement ${input.intentId} is not awaiting manual output recovery`
      );
    }

    await transaction.query(
      `DELETE FROM operational_outcome_page_leases
        WHERE source_provider_id = $1 AND source_document_id = $2
          AND workspace_id = $3 AND meeting_id = $4 AND intent_id = $5`,
      [
        input.target.providerId,
        input.target.page.externalId,
        input.workspaceId,
        input.meetingId,
        input.intentId
      ]
    );
  });
}

/** A positively not-applied page write can be retried only after its lease is freed. */
export async function markOperationalOutcomeSettlementOutputPendingAndReleasePageLease(input: {
  database: LumaDatabase;
  workspaceId: string;
  meetingId: string;
  intentId: string;
  executionLeaseId: string;
  target: OperationalOutcomeTarget;
  error: { code: string; message: string };
  now: Date;
}): Promise<void> {
  const timestamp = input.now.toISOString();

  await input.database.transaction(async (transaction) => {
    const pending = await transaction.query(
      `UPDATE operational_outcome_settlement_stages
          SET status = 'pending', execution_lease_id = NULL, prepared_outcome_json = NULL,
              prepared_operation_token = NULL, payload_digest = NULL,
              content_digest = NULL, operation_digest = NULL,
              last_error_code = $5, last_error_message = $6, updated_at = $7
        WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3 AND stage = 'outcome'
          AND status = 'executing' AND execution_lease_id = $4`,
      [
        input.workspaceId,
        input.meetingId,
        input.intentId,
        input.executionLeaseId,
        input.error.code,
        input.error.message,
        timestamp
      ]
    );

    if (pending.affectedRows !== 1) {
      throw new Error(
        `Operational Outcome settlement ${input.intentId} no longer owns its outcome stage`
      );
    }

    await transaction.query(
      `DELETE FROM operational_outcome_page_leases
        WHERE source_provider_id = $1 AND source_document_id = $2
          AND workspace_id = $3 AND meeting_id = $4 AND intent_id = $5
          AND execution_lease_id = $6`,
      [
        input.target.providerId,
        input.target.page.externalId,
        input.workspaceId,
        input.meetingId,
        input.intentId,
        input.executionLeaseId
      ]
    );
  });
}

/**
 * This narrow recovery exists only for the pre-provider cleanup failure path.
 * That path records this exact code before `writer.upsert` can be reached, so
 * resetting it cannot replay or overwrite an external page mutation. The
 * preparation fields can be populated when their acknowledgement was lost;
 * they are cleared together with the lease because preparation is not a page
 * mutation.
 */
export async function abandonProvenPrewriteOperationalOutcomeAndReleasePageLease(input: {
  database: LumaDatabase;
  workspaceId: string;
  meetingId: string;
  intentId: string;
  target: OperationalOutcomeTarget;
  now: Date;
}): Promise<void> {
  const timestamp = input.now.toISOString();

  await input.database.transaction(async (transaction) => {
    const pending = await transaction.query(
      `UPDATE operational_outcome_settlement_stages
          SET status = 'pending', execution_lease_id = NULL,
              prepared_outcome_json = NULL, prepared_operation_token = NULL,
              payload_digest = NULL, content_digest = NULL, operation_digest = NULL,
              last_error_code = 'operational-outcome-prewrite-abandoned',
              last_error_message = 'Luma confirmed this manual stage failed before any provider write and released its page lease.',
              updated_at = $4, completed_at = NULL
        WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3 AND stage = 'outcome'
          AND status = 'requires-manual-recovery'
          AND execution_lease_id IS NULL
          AND last_error_code = 'operational-outcome-prewrite-cleanup-unknown'`,
      [input.workspaceId, input.meetingId, input.intentId, timestamp]
    );

    if (pending.affectedRows !== 1) {
      throw new Error(
        `Operational Outcome settlement ${input.intentId} is not a proven pre-write manual stage`
      );
    }

    await transaction.query(
      `DELETE FROM operational_outcome_page_leases
        WHERE source_provider_id = $1 AND source_document_id = $2
          AND workspace_id = $3 AND meeting_id = $4 AND intent_id = $5`,
      [
        input.target.providerId,
        input.target.page.externalId,
        input.workspaceId,
        input.meetingId,
        input.intentId
      ]
    );
  });
}

/**
 * An OperationalOutcomeWriteNotAppliedError proves the provider did not write.
 * If only the following local cleanup acknowledgement was lost, this guarded
 * transition can free the prepared lease without inspecting or rewriting the
 * page. It intentionally accepts no generic manual/unknown outcome codes.
 */
export async function resetProvenNotAppliedManualOperationalOutcomeAndReleasePageLease(input: {
  database: LumaDatabase;
  workspaceId: string;
  meetingId: string;
  intentId: string;
  target: OperationalOutcomeTarget;
  previousErrorCode:
    | "operational-outcome-not-written-cleanup-unknown"
    | "operational-outcome-not-writable-cleanup-unknown";
  error: { code: string; message: string };
  now: Date;
}): Promise<void> {
  const timestamp = input.now.toISOString();

  await input.database.transaction(async (transaction) => {
    const pending = await transaction.query(
      `UPDATE operational_outcome_settlement_stages
          SET status = 'pending', execution_lease_id = NULL,
              prepared_outcome_json = NULL, prepared_operation_token = NULL,
              payload_digest = NULL, content_digest = NULL, operation_digest = NULL,
              last_error_code = $5, last_error_message = $6,
              updated_at = $7, completed_at = NULL
        WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3 AND stage = 'outcome'
          AND status = 'requires-manual-recovery'
          AND execution_lease_id IS NULL
          AND last_error_code = $4`,
      [
        input.workspaceId,
        input.meetingId,
        input.intentId,
        input.previousErrorCode,
        input.error.code,
        input.error.message,
        timestamp
      ]
    );

    if (pending.affectedRows !== 1) {
      throw new Error(
        `Operational Outcome settlement ${input.intentId} is not a proven not-applied manual stage`
      );
    }

    await transaction.query(
      `DELETE FROM operational_outcome_page_leases
        WHERE source_provider_id = $1 AND source_document_id = $2
          AND workspace_id = $3 AND meeting_id = $4 AND intent_id = $5`,
      [
        input.target.providerId,
        input.target.page.externalId,
        input.workspaceId,
        input.meetingId,
        input.intentId
      ]
    );
  });
}

/**
 * The prior outer receipt is already manual, so this old executing lease is
 * orphaned. Its exact durable provider-confirmed no-write record makes the
 * transition to pending safe without rereading or rewriting the page.
 */
export async function resetProvenNotAppliedExecutingOperationalOutcomeAndReleasePageLease(input: {
  database: LumaDatabase;
  workspaceId: string;
  meetingId: string;
  intentId: string;
  target: OperationalOutcomeTarget;
  previousExecutionLeaseId: string;
  previousErrorCode:
    | "operational-outcome-not-written-provider-confirmed"
    | "operational-outcome-not-writable-provider-confirmed"
    | "operational-outcome-prewrite-provider-not-started";
  error: { code: string; message: string };
  now: Date;
}): Promise<void> {
  const timestamp = input.now.toISOString();

  await input.database.transaction(async (transaction) => {
    const pending = await transaction.query(
      `UPDATE operational_outcome_settlement_stages
          SET status = 'pending', execution_lease_id = NULL,
              prepared_outcome_json = NULL, prepared_operation_token = NULL,
              payload_digest = NULL, content_digest = NULL, operation_digest = NULL,
              last_error_code = $6, last_error_message = $7,
              updated_at = $8, completed_at = NULL
        WHERE workspace_id = $1 AND meeting_id = $2 AND intent_id = $3 AND stage = 'outcome'
          AND status = 'executing' AND execution_lease_id = $4
          AND last_error_code = $5`,
      [
        input.workspaceId,
        input.meetingId,
        input.intentId,
        input.previousExecutionLeaseId,
        input.previousErrorCode,
        input.error.code,
        input.error.message,
        timestamp
      ]
    );

    if (pending.affectedRows !== 1) {
      throw new Error(
        `Operational Outcome settlement ${input.intentId} is not an orphaned proven not-applied output stage`
      );
    }

    await transaction.query(
      `DELETE FROM operational_outcome_page_leases
        WHERE source_provider_id = $1 AND source_document_id = $2
          AND workspace_id = $3 AND meeting_id = $4 AND intent_id = $5
          AND execution_lease_id = $6`,
      [
        input.target.providerId,
        input.target.page.externalId,
        input.workspaceId,
        input.meetingId,
        input.intentId,
        input.previousExecutionLeaseId
      ]
    );
  });
}

/**
 * Permanently bind the physical page's one owned section to a workspace.
 * This happens before any WorkProvider call so a foreign workspace can never
 * create work that it is later forbidden to publish to the source page.
 */
export async function ensureOperationalOutcomePageWorkspaceOwnership(input: {
  database: LumaDatabase;
  workspaceId: string;
  target: OperationalOutcomeTarget;
  now: Date;
}): Promise<boolean> {
  return input.database.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO operational_outcome_pages (
         source_provider_id, source_document_id, workspace_id, created_at
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_provider_id, source_document_id) DO NOTHING`,
      [
        input.target.providerId,
        input.target.page.externalId,
        input.workspaceId,
        input.now.toISOString()
      ]
    );
    const existing = await transaction.query<PageOwnershipRow>(
      `SELECT workspace_id
         FROM operational_outcome_pages
        WHERE source_provider_id = $1 AND source_document_id = $2
        FOR UPDATE`,
      [input.target.providerId, input.target.page.externalId]
    );

    return existing.rows[0]?.workspace_id === input.workspaceId;
  });
}

export async function acquireOperationalOutcomePageLease(input: {
  database: LumaDatabase;
  workspaceId: string;
  meetingId: string;
  intentId: string;
  target: OperationalOutcomeTarget;
  executionLeaseId: string;
  now: Date;
}): Promise<OperationalOutcomePageLeaseAcquisition> {
  const timestamp = input.now.toISOString();

  return input.database.transaction(async (transaction) => {
    // Defend this lower-level operation too; callers normally established the
    // owner before work resolution, but no output path may bypass the fence.
    await transaction.query(
      `INSERT INTO operational_outcome_pages (
         source_provider_id, source_document_id, workspace_id, created_at
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_provider_id, source_document_id) DO NOTHING`,
      [
        input.target.providerId,
        input.target.page.externalId,
        input.workspaceId,
        timestamp
      ]
    );
    const owner = await transaction.query<PageOwnershipRow>(
      `SELECT workspace_id
         FROM operational_outcome_pages
        WHERE source_provider_id = $1 AND source_document_id = $2
        FOR UPDATE`,
      [input.target.providerId, input.target.page.externalId]
    );

    if (owner.rows[0]?.workspace_id !== input.workspaceId) {
      return "workspace-mismatch";
    }

    await transaction.query(
      `INSERT INTO operational_outcome_page_leases (
         source_provider_id, source_document_id, workspace_id, meeting_id,
         intent_id, execution_lease_id, acquired_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (source_provider_id, source_document_id) DO NOTHING`,
      [
        input.target.providerId,
        input.target.page.externalId,
        input.workspaceId,
        input.meetingId,
        input.intentId,
        input.executionLeaseId,
        timestamp
      ]
    );
    const current = await transaction.query<PageLeaseRow>(
      `SELECT workspace_id, meeting_id, intent_id, execution_lease_id
         FROM operational_outcome_page_leases
        WHERE source_provider_id = $1 AND source_document_id = $2
        FOR UPDATE`,
      [input.target.providerId, input.target.page.externalId]
    );
    const lease = current.rows[0];

    if (!lease) {
      throw new Error("Operational Outcome page lease disappeared after acquisition");
    }

    if (
      lease.workspace_id !== input.workspaceId ||
      lease.meeting_id !== input.meetingId ||
      lease.intent_id !== input.intentId
    ) {
      return "busy";
    }

    await transaction.query(
      `UPDATE operational_outcome_page_leases
          SET execution_lease_id = $4, updated_at = $5
        WHERE source_provider_id = $1 AND source_document_id = $2
          AND workspace_id = $3 AND meeting_id = $6 AND intent_id = $7`,
      [
        input.target.providerId,
        input.target.page.externalId,
        input.workspaceId,
        input.executionLeaseId,
        timestamp,
        input.meetingId,
        input.intentId
      ]
    );

    return "acquired";
  });
}

export async function releaseOperationalOutcomePageLease(input: {
  database: LumaDatabase;
  workspaceId: string;
  meetingId: string;
  intentId: string;
  target: OperationalOutcomeTarget;
}): Promise<void> {
  await input.database.query(
    `DELETE FROM operational_outcome_page_leases
      WHERE source_provider_id = $1 AND source_document_id = $2
        AND workspace_id = $3 AND meeting_id = $4 AND intent_id = $5`,
    [
      input.target.providerId,
      input.target.page.externalId,
      input.workspaceId,
      input.meetingId,
      input.intentId
    ]
  );
}

export function settlementStageIdempotencyKey(
  workspaceId: string,
  meetingId: string,
  intentId: string,
  stage: OperationalOutcomeSettlementStageName
): string {
  return JSON.stringify([
    workspaceId,
    meetingId,
    intentId,
    `operational-outcome-${stage}`
  ]);
}

function workStageInitialStatus(
  plan: NewOperationalOutcomeSettlementPlan
): OperationalOutcomeSettlementStageStatus {
  switch (plan.resolution.outcome.type) {
    case "create-new":
    case "update-existing":
      return "pending";
    case "link-existing":
    case "reject-not-work":
    case "needs-clarification":
      return "not-required";
  }
}

async function requireOperationalOutcomeSettlement(
  database: Pick<LumaDatabase, "query">,
  workspaceId: string,
  meetingId: string,
  intentId: string
): Promise<OperationalOutcomeSettlement> {
  const settlement = await readOperationalOutcomeSettlement({
    database,
    workspaceId,
    meetingId,
    intentId
  });

  if (!settlement) {
    throw new Error(`Operational Outcome settlement ${intentId} disappeared`);
  }

  return settlement;
}

function settlementFromRows(
  planJson: string,
  rows: SettlementStageRow[]
): OperationalOutcomeSettlement {
  const plan = parsePlan(planJson);
  const byStage = new Map(rows.map((row) => [row.stage, stageFromRow(row)]));
  const work = byStage.get("work");
  const outcome = byStage.get("outcome");

  if (!work || !outcome) {
    throw new Error(
      `Operational Outcome settlement ${plan.intentId} has incomplete stage rows`
    );
  }

  return { plan, work, outcome };
}

function stageFromRow(row: SettlementStageRow): OperationalOutcomeSettlementStage {
  return {
    stage: row.stage,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    externalReferences: parseExternalReferences(row.reference_json),
    preparedOutcomeJson: row.prepared_outcome_json,
    preparedOperationToken: row.prepared_operation_token,
    payloadDigest: row.payload_digest,
    contentDigest: row.content_digest,
    operationDigest: row.operation_digest,
    error:
      row.last_error_code && row.last_error_message
        ? { code: row.last_error_code, message: row.last_error_message }
        : null,
    executionLeaseId: row.execution_lease_id,
    attempts: row.attempts
  };
}

function parsePlan(json: string): OperationalOutcomeSettlementPlan {
  try {
    const parsed = JSON.parse(json) as Partial<OperationalOutcomeSettlementPlan>;

    if (typeof parsed.intentId !== "string") {
      throw new Error("invalid intent ID");
    }

    if (parsed.version === 1) {
      return {
        ...(parsed as Omit<
          OperationalOutcomeSettlementPlan,
          "ownership" | "sourceBoundImplementationReferences"
        >),
        // v1 plans predate ownership reliability. They may be rendered as
        // historic settled facts but are never a proof to execute/reassign
        // work under the v2 ownership gate.
        ownership: {
          status: "unresolved",
          reason: "unsupported-semantics",
          likelyOwnerPersonId: null
        },
        sourceBoundImplementationReferences: []
      };
    }

    if (
      (parsed.version !== 2 && parsed.version !== 3) ||
      !parsed.ownership ||
      typeof parsed.ownership !== "object" ||
      typeof parsed.ownership.status !== "string"
    ) {
      throw new Error("missing ownership-bound settlement plan version");
    }

    return {
      ...(parsed as Omit<
        OperationalOutcomeSettlementPlan,
        "sourceBoundImplementationReferences"
      >),
      sourceBoundImplementationReferences:
        parsed.version === 3
          ? parseSourceBoundImplementationReferences(
              parsed.sourceBoundImplementationReferences
            )
          : []
    };
  } catch (error) {
    throw new Error(
      `Operational Outcome settlement plan is invalid: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  }
}

function parseSourceBoundImplementationReferences(value: unknown): ExternalReference[] {
  if (!Array.isArray(value)) {
    throw new Error("missing source-bound GitHub implementation references");
  }

  const references = value.map((reference) => {
    if (
      !reference ||
      typeof reference !== "object" ||
      typeof Reflect.get(reference, "providerId") !== "string" ||
      String(Reflect.get(reference, "providerId")).trim().length === 0 ||
      (Reflect.get(reference, "objectType") !== "pull-request" &&
        Reflect.get(reference, "objectType") !== "commit") ||
      typeof Reflect.get(reference, "externalId") !== "string" ||
      String(Reflect.get(reference, "externalId")).trim().length === 0 ||
      typeof Reflect.get(reference, "url") !== "string" ||
      String(Reflect.get(reference, "url")).trim().length === 0
    ) {
      throw new Error("invalid source-bound GitHub implementation reference");
    }

    return {
      providerId: String(Reflect.get(reference, "providerId")),
      objectType: Reflect.get(reference, "objectType") as "pull-request" | "commit",
      externalId: String(Reflect.get(reference, "externalId")),
      url: String(Reflect.get(reference, "url"))
    } satisfies ExternalReference;
  });

  const unique = new Set<string>();

  for (const reference of references) {
    const key = `${reference.providerId}\u0000${reference.objectType}\u0000${reference.externalId}\u0000${reference.url}`;

    if (unique.has(key)) {
      throw new Error("duplicate source-bound GitHub implementation reference");
    }

    unique.add(key);
  }

  return references;
}

function isReadCompatibleV2Plan(
  existing: OperationalOutcomeSettlementPlan,
  requested: NewOperationalOutcomeSettlementPlan
): boolean {
  return existing.version === 2 && sameExecutionPlanBinding(existing, requested);
}

function sameExecutionPlanBinding(
  left: OperationalOutcomeSettlementPlan,
  right: OperationalOutcomeSettlementPlan
): boolean {
  return (
    left.intentId === right.intentId &&
    left.binding.reviewId === right.binding.reviewId &&
    left.binding.candidateId === right.binding.candidateId &&
    left.binding.candidateLineageKey === right.binding.candidateLineageKey &&
    left.target.workspaceId === right.target.workspaceId &&
    left.target.providerId === right.target.providerId &&
    left.target.page.externalId === right.target.page.externalId &&
    left.target.sourceObjectId === right.target.sourceObjectId &&
    left.target.sourceRevision === right.target.sourceRevision &&
    left.target.sourceContentHash === right.target.sourceContentHash &&
    sameActionItemOwnership(left.ownership, right.ownership) &&
    left.resolution.id === right.resolution.id
  );
}

function parseExternalReferences(json: string | null): ExternalReference[] {
  if (!json) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(json);

    if (!Array.isArray(parsed) || !parsed.every(isExternalReference)) {
      throw new Error("invalid external references");
    }

    return parsed;
  } catch {
    throw new Error("Operational Outcome settlement stage references are invalid");
  }
}

function isExternalReference(value: unknown): value is ExternalReference {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  const objectType = record["objectType"];

  return (
    typeof record["providerId"] === "string" &&
    typeof record["externalId"] === "string" &&
    typeof record["url"] === "string" &&
    (objectType === "document" ||
      objectType === "work-item" ||
      objectType === "pull-request" ||
      objectType === "commit" ||
      objectType === "comment" ||
      objectType === "project" ||
      objectType === "other") &&
    (record["version"] === undefined || typeof record["version"] === "string")
  );
}

function compareBytewise(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
