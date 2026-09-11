import { createHash } from "node:crypto";
import type { LumaDatabase } from "../persistence/db.js";
import type {
  DecisionActor,
  DecisionInterpretation,
  DecisionAuthoritySnapshot,
  DecisionCatalogSnapshot,
  DecisionFollowUpIntent,
  DecisionRequestState,
  DecisionSubject,
  DecisionWriteReceipt,
  DecisionWriteStage
} from "../domain/decision-records.js";

export function decisionDigest(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, canonical(entry)])
          )
        : item;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function decisionSubjectKey(subject: DecisionSubject): string {
  return decisionDigest(subject);
}
export type StoredDecisionRequest = {
  requestHash: string;
  actor: DecisionActor;
  requesterPersonId: string;
  state: DecisionRequestState;
  authority: DecisionAuthoritySnapshot;
  catalog: DecisionCatalogSnapshot;
  intent: DecisionFollowUpIntent | null;
  interpretation: DecisionInterpretation | null;
};
export type StoredDecisionStage = {
  index: number;
  createdAt: string;
  stage: DecisionWriteStage;
  operationId: string;
  state: "pending" | "executing" | "succeeded" | "not-applied" | "unknown";
  receipt: DecisionWriteReceipt | null;
};
export async function migrateDecisionIntelligence(database: LumaDatabase): Promise<void> {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS decision_requests (
      workspace_id TEXT NOT NULL, request_id TEXT NOT NULL, subject_key TEXT NOT NULL,
      payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
      PRIMARY KEY (workspace_id, request_id)
    );
    CREATE TABLE IF NOT EXISTS decision_request_revisions (
      workspace_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY(workspace_id,request_id,payload_hash)
    );
    CREATE TABLE IF NOT EXISTS decision_observations (
      workspace_id TEXT NOT NULL, observation_id TEXT NOT NULL, request_id TEXT NOT NULL,
      payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
      PRIMARY KEY (workspace_id, observation_id)
    );
    CREATE TABLE IF NOT EXISTS decision_write_stages (
      workspace_id TEXT NOT NULL, intent_id TEXT NOT NULL, stage_index INTEGER NOT NULL,
      operation_id TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
      PRIMARY KEY (workspace_id, intent_id, stage_index)
    );
    CREATE TABLE IF NOT EXISTS decision_catalog_fences (
      provider_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, intent_id TEXT NOT NULL
    );
  `);
}
function decode<T>(row: { payload_json: string; payload_hash: string }): T {
  const value: unknown = JSON.parse(row.payload_json);
  if (decisionDigest(value) !== row.payload_hash)
    throw new Error("Decision state integrity check failed");
  return value as T;
}
export async function readDecisionRequest(
  database: Pick<LumaDatabase, "query">,
  workspaceId: string,
  requestId: string,
  subject: DecisionSubject
): Promise<StoredDecisionRequest> {
  const result = await database.query<{
    subject_key: string;
    payload_json: string;
    payload_hash: string;
  }>(
    `SELECT subject_key,payload_json,payload_hash FROM decision_requests WHERE workspace_id=$1 AND request_id=$2`,
    [workspaceId, requestId]
  );
  const row = result.rows[0];
  if (!row || row.subject_key !== decisionSubjectKey(subject))
    throw new Error("Decision request was not found in this subject");
  return decode<StoredDecisionRequest>(row);
}
export async function findDecisionRequest(
  database: Pick<LumaDatabase, "query">,
  workspaceId: string,
  requestId: string
): Promise<StoredDecisionRequest | null> {
  const result = await database.query<{ payload_json: string; payload_hash: string }>(
    `SELECT payload_json,payload_hash FROM decision_requests WHERE workspace_id=$1 AND request_id=$2`,
    [workspaceId, requestId]
  );
  return result.rows[0] ? decode<StoredDecisionRequest>(result.rows[0]) : null;
}
export async function saveDecisionRequest(
  database: Pick<LumaDatabase, "query">,
  workspaceId: string,
  value: StoredDecisionRequest
): Promise<void> {
  await database.query(
    `INSERT INTO decision_request_revisions(workspace_id,request_id,payload_hash,payload_json) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [workspaceId, value.state.requestId, decisionDigest(value), JSON.stringify(value)]
  );
  await database.query(
    `INSERT INTO decision_requests (workspace_id,request_id,subject_key,payload_json,payload_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,request_id) DO UPDATE SET payload_json=excluded.payload_json,payload_hash=excluded.payload_hash WHERE decision_requests.subject_key=excluded.subject_key`,
    [
      workspaceId,
      value.state.requestId,
      decisionSubjectKey(value.state.subject),
      JSON.stringify(value),
      decisionDigest(value)
    ]
  );
}
export async function saveDecisionObservation(
  database: Pick<LumaDatabase, "query">,
  workspaceId: string,
  requestId: string,
  observationId: string,
  value: unknown
): Promise<boolean> {
  const digest = decisionDigest(value);
  const prior = await database.query<{ payload_hash: string }>(
    `SELECT payload_hash FROM decision_observations WHERE workspace_id=$1 AND observation_id=$2`,
    [workspaceId, observationId]
  );
  if (prior.rows[0]) {
    if (prior.rows[0].payload_hash !== digest)
      throw new Error(
        "Decision observation ID already has a different immutable instruction"
      );
    return false;
  }
  await database.query(
    `INSERT INTO decision_observations (workspace_id,observation_id,request_id,payload_json,payload_hash) VALUES($1,$2,$3,$4,$5)`,
    [workspaceId, observationId, requestId, JSON.stringify(value), digest]
  );
  return true;
}
export async function readDecisionStages(
  database: Pick<LumaDatabase, "query">,
  workspaceId: string,
  intentId: string
): Promise<StoredDecisionStage[]> {
  const result = await database.query<{ payload_json: string; payload_hash: string }>(
    `SELECT payload_json,payload_hash FROM decision_write_stages WHERE workspace_id=$1 AND intent_id=$2 ORDER BY stage_index`,
    [workspaceId, intentId]
  );
  return result.rows.map((row) => decode<StoredDecisionStage>(row));
}
export async function saveDecisionStage(
  database: Pick<LumaDatabase, "query">,
  workspaceId: string,
  intentId: string,
  value: StoredDecisionStage
): Promise<void> {
  await database.query(
    `INSERT INTO decision_write_stages(workspace_id,intent_id,stage_index,operation_id,payload_json,payload_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,intent_id,stage_index) DO UPDATE SET payload_json=excluded.payload_json,payload_hash=excluded.payload_hash WHERE decision_write_stages.operation_id=excluded.operation_id`,
    [
      workspaceId,
      intentId,
      value.index,
      value.operationId,
      JSON.stringify(value),
      decisionDigest(value)
    ]
  );
}
export async function acquireDecisionFence(
  database: Pick<LumaDatabase, "query">,
  providerId: string,
  workspaceId: string,
  intentId: string
): Promise<void> {
  await database.query(
    `INSERT INTO decision_catalog_fences(provider_id,workspace_id,intent_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
    [providerId, workspaceId, intentId]
  );
  const row = (
    await database.query<{ workspace_id: string; intent_id: string }>(
      `SELECT workspace_id,intent_id FROM decision_catalog_fences WHERE provider_id=$1`,
      [providerId]
    )
  ).rows[0];
  if (row?.workspace_id !== workspaceId || row.intent_id !== intentId)
    throw new Error(
      "A prior Decision write needs recovery before another canonical write"
    );
}
export async function releaseDecisionFence(
  database: Pick<LumaDatabase, "query">,
  providerId: string,
  workspaceId: string,
  intentId: string
): Promise<void> {
  await database.query(
    `DELETE FROM decision_catalog_fences WHERE provider_id=$1 AND workspace_id=$2 AND intent_id=$3`,
    [providerId, workspaceId, intentId]
  );
}
