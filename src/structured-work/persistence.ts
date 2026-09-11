import { createHash } from "node:crypto";
import type { LumaDatabase } from "../persistence/db.js";
import type {
  ObserveStructuredWork,
  StructuredRecordCreate,
  StructuredRecordSnapshot,
  StructuredWorkState
} from "../domain/structured-work.js";
import type { CreateWorkItemInput, WorkItem } from "../work/interface.js";
import type { ExternalReference } from "../domain/model.js";

export function operationDigest(value: unknown): string {
  const sorted = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sorted)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, sorted(child)])
          )
        : item;
  return createHash("sha256")
    .update(JSON.stringify(sorted(value)))
    .digest("hex");
}
export type StoredOperationStage = {
  target: "record" | "work";
  action: "create" | "link" | "update";
  state: "pending" | "executing" | "unknown" | "succeeded" | "not-applied";
  operationId: string;
  reference: ExternalReference | null;
  message: string;
  recordDraft?: StructuredRecordCreate;
  workInput?: CreateWorkItemInput;
};
export type StoredStructuredWork = {
  request: ObserveStructuredWork;
  requestHash: string;
  requesterPersonId: string;
  policyHash: string;
  ownerProviderUserId: string | null;
  records: StructuredRecordSnapshot;
  work: WorkItem[];
  workSearch: string;
  state: StructuredWorkState;
  stages: StoredOperationStage[];
  intent: null | {
    id: string;
    type: "execute-structured-work";
    status: "approved";
    authorization: "explicit-instruction";
    authorizedBy: string;
    planHash: string;
  };
};
export async function migrateStructuredWork(database: LumaDatabase): Promise<void> {
  await database.exec(`CREATE TABLE IF NOT EXISTS structured_work_requests (
    workspace_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL, PRIMARY KEY(workspace_id,request_id)
  )`);
}
export async function readStructuredWork(
  database: Pick<LumaDatabase, "query">,
  workspaceId: string,
  requestId: string
): Promise<StoredStructuredWork | null> {
  const row = (
    await database.query<{ payload_json: string; payload_hash: string }>(
      "SELECT payload_json,payload_hash FROM structured_work_requests WHERE workspace_id=$1 AND request_id=$2",
      [workspaceId, requestId]
    )
  ).rows[0];
  if (!row) return null;
  const value: StoredStructuredWork = JSON.parse(
    row.payload_json
  ) as StoredStructuredWork;
  if (
    operationDigest(value) !== row.payload_hash ||
    value.request.workspace.workspaceId !== workspaceId ||
    value.state.requestId !== requestId ||
    operationDigest(value.request) !== value.requestHash
  )
    throw new Error("Original structured request integrity is unavailable");
  return value;
}
export async function saveStructuredWork(
  database: Pick<LumaDatabase, "query">,
  value: StoredStructuredWork,
  previousHash: string | null
): Promise<void> {
  const args = [
    value.request.workspace.workspaceId,
    value.state.requestId,
    JSON.stringify(value),
    operationDigest(value)
  ];
  const result =
    previousHash === null
      ? await database.query(
          "INSERT INTO structured_work_requests(workspace_id,request_id,payload_json,payload_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING request_id",
          args
        )
      : await database.query(
          "UPDATE structured_work_requests SET payload_json=$3,payload_hash=$4 WHERE workspace_id=$1 AND request_id=$2 AND payload_hash=$5 RETURNING request_id",
          [...args, previousHash]
        );
  if (result.rows.length !== 1)
    throw new Error("Structured request changed during persistence");
}
