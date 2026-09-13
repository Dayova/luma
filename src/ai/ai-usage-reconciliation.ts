import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { dayovaFounderPersonIds } from "../app/founder-access.js";
import type { LumaDatabase } from "../persistence/db.js";

const identifier = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/u);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const operatorSchema = z
  .object({
    personId: z.enum(dayovaFounderPersonIds),
    localUid: z.number().int().nonnegative()
  })
  .strict();
export type AccountingOperator = z.infer<typeof operatorSchema>;
const evidenceSchema = z
  .object({
    kind: z.enum(["provider-billing", "provider-confirmed-no-charge"]),
    reference: identifier,
    sha256: digestSchema
  })
  .strict();
const reviewFields = {
  workspaceId: identifier,
  reason: z.string().trim().min(8).max(500),
  evidence: evidenceSchema
};
export const accountingOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("charge"),
      ...reviewFields,
      reservationId: z.string().uuid(),
      expectedRequestDigest: digestSchema,
      verifiedAmountUsd: z.string().regex(/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,9})?$/u)
    })
    .strict(),
  z.object({ kind: z.literal("unblock"), ...reviewFields }).strict()
]);
export type AccountingOperation = z.infer<typeof accountingOperationSchema>;
const approvalSchema = z
  .object({
    preparationId: z.string().uuid(),
    digest: digestSchema,
    reviewed: z.literal(true)
  })
  .strict();
export type AccountingApproval = z.infer<typeof approvalSchema>;

type Transaction = Parameters<Parameters<LumaDatabase["transaction"]>[0]>[0];
type Workspace = { accounting_blocked: boolean; accounting_revision: string | number };
type RequestRow = {
  reservation_id: string;
  workspace_id: string;
  workflow_id: string;
  capability: string;
  model: string;
  price_version: string;
  month: string;
  day: string;
  state: "reserved" | "unknown" | "settled";
  reserved_nanos: string | number;
  charged_nanos: string | number | null;
  created_at: string;
  expires_at: string;
  settled_at: string | null;
  input_token_upper_bound: number;
  max_output_tokens: number;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  response_facts_json: string | null;
  accounting_blocker: boolean;
  reconciliation_id: string | null;
};
const requestColumns = `reservation_id,workspace_id,workflow_id,capability,model,price_version,
  month,day,state,reserved_nanos,charged_nanos,created_at,expires_at,settled_at,
  input_token_upper_bound,max_output_tokens,input_tokens,cached_input_tokens,
  cache_write_tokens,output_tokens,reasoning_tokens,response_facts_json,
  accounting_blocker,reconciliation_id`;

export class AiAccountingRecoveryError extends Error {
  constructor(readonly code: string) {
    super(`AI accounting recovery refused: ${code}`);
    this.name = "AiAccountingRecoveryError";
  }
}

type Prepared = {
  preparationId: string;
  operator: AccountingOperator;
  operation: AccountingOperation;
  before: { blocked: boolean; revision: string; request?: RequestRow };
  createdAt: string;
};
type Audit = {
  auditId: string;
  preparationId: string;
  operator: AccountingOperator;
  operation: AccountingOperation;
  before: Prepared["before"];
  after: { blocked: boolean; revision: string; request?: RequestRow };
  recordedAt: string;
};

/** Local accounting only. The caller owns a cleanly stopped, exclusive store.
 * Evidence is an identified operator's billing attestation, never an inferred charge.
 * No method calls a provider, changes a cap, or dispatches previously paid work.
 */
export function createAiUsageReconciliation(input: {
  database: LumaDatabase;
  operator: AccountingOperator;
  now?: () => Date;
}) {
  const operator = operatorSchema.parse(input.operator);
  const clock = input.now ?? (() => new Date());
  return {
    async inspect(workspaceId: string, afterReservationId?: string) {
      identifier.parse(workspaceId);
      if (afterReservationId) z.string().uuid().parse(afterReservationId);
      return input.database.transaction(async (tx) => {
        const workspace = await lockWorkspace(tx, workspaceId);
        const { rows } = await tx.query<RequestRow>(
          `SELECT ${requestColumns} FROM ai_usage_requests WHERE workspace_id = $1
           AND ($2::text IS NULL OR reservation_id > $2) ORDER BY reservation_id LIMIT 101`,
          [workspaceId, afterReservationId ?? null]
        );
        const page = rows.slice(0, 100);
        return {
          workspaceId,
          accountingBlocked: workspace.accounting_blocked,
          accountingRevision: String(workspace.accounting_revision),
          requests: page.map((row) => ({
            reservationId: row.reservation_id,
            requestDigest: hash(row),
            workflowHash: safeIdentifier(row.workflow_id),
            capability: safeIdentifier(row.capability),
            model: safeIdentifier(row.model),
            priceVersion: safeIdentifier(row.price_version),
            month: safeIdentifier(row.month),
            state: row.state,
            reservedUsd: usd(row.reserved_nanos),
            chargedUsd: row.charged_nanos === null ? null : usd(row.charged_nanos),
            accountingBlocker: row.accounting_blocker,
            reconciled: row.reconciliation_id !== null,
            liveReservation:
              row.state === "reserved" && Date.parse(row.expires_at) > clock().getTime(),
            providerFacts: safeProviderFacts(row.response_facts_json)
          })),
          nextAfterReservationId:
            rows.length > 100 ? page.at(-1)?.reservation_id : undefined
        };
      });
    },
    async prepare(value: AccountingOperation) {
      const operation = accountingOperationSchema.parse(value);
      validateEvidence(operation);
      return input.database.transaction(async (tx) => {
        const workspace = await lockWorkspace(tx, operation.workspaceId);
        const before = await currentState(tx, operation, workspace, clock());
        const prepared: Prepared = {
          preparationId: randomUUID(),
          operator,
          operation,
          before,
          createdAt: clock().toISOString()
        };
        const digest = hash(prepared);
        await tx.query("INSERT INTO ai_accounting_preparations VALUES ($1,$2,$3,$4,$5)", [
          prepared.preparationId,
          operation.workspaceId,
          canonical(prepared),
          digest,
          prepared.createdAt
        ]);
        return { ...prepared, digest };
      });
    },
    async apply(value: AccountingApproval) {
      const approval = approvalSchema.parse(value);
      return input.database.transaction(async (tx) => {
        const { rows: preparations } = await tx.query<{
          preparation_json: string;
          digest: string;
        }>(
          "SELECT preparation_json,digest FROM ai_accounting_preparations WHERE preparation_id = $1",
          [approval.preparationId]
        );
        const stored = preparations[0];
        if (!stored || stored.digest !== approval.digest) fail("preparation-mismatch");
        const prepared = JSON.parse(stored.preparation_json) as Prepared;
        if (
          hash(prepared) !== approval.digest ||
          canonical(prepared.operator) !== canonical(operator)
        )
          fail("operator-or-digest-mismatch");
        const operation = accountingOperationSchema.parse(prepared.operation);
        validateEvidence(operation);
        const workspace = await lockWorkspace(tx, operation.workspaceId);
        const prior = await loadAudit(tx, approval.preparationId);
        if (prior) return prior;
        const before = await currentState(tx, operation, workspace, clock());
        if (hash(before) !== hash(prepared.before)) fail("stale-preparation");
        const auditId = randomUUID();
        if (operation.kind === "charge") {
          await tx.query(
            `UPDATE ai_usage_requests SET state = 'settled', charged_nanos = $3,
             settled_at = $4, accounting_blocker = FALSE, reconciliation_id = $5
             WHERE workspace_id = $1 AND reservation_id = $2`,
            [
              operation.workspaceId,
              operation.reservationId,
              nanos(operation.verifiedAmountUsd),
              clock().toISOString(),
              auditId
            ]
          );
        } else {
          await tx.query(
            "UPDATE ai_usage_locks SET accounting_blocked = FALSE WHERE workspace_id = $1",
            [operation.workspaceId]
          );
        }
        await tx.query(
          "UPDATE ai_usage_locks SET accounting_revision = accounting_revision + 1 WHERE workspace_id = $1",
          [operation.workspaceId]
        );
        const afterWorkspace = await lockWorkspace(tx, operation.workspaceId);
        const after: Prepared["before"] = {
          blocked: afterWorkspace.accounting_blocked,
          revision: String(afterWorkspace.accounting_revision),
          ...(operation.kind === "charge"
            ? {
                request: await loadRequest(
                  tx,
                  operation.workspaceId,
                  operation.reservationId
                )
              }
            : {})
        };
        const audit: Audit = {
          auditId,
          preparationId: prepared.preparationId,
          operator,
          operation,
          before,
          after,
          recordedAt: clock().toISOString()
        };
        await tx.query("INSERT INTO ai_accounting_audit VALUES ($1,$2,$3,$4,$5)", [
          auditId,
          prepared.preparationId,
          operation.workspaceId,
          canonical(audit),
          audit.recordedAt
        ]);
        return audit;
      });
    },
    async history(workspaceId: string) {
      identifier.parse(workspaceId);
      const { rows } = await input.database.query<{ audit_json: string }>(
        "SELECT audit_json FROM ai_accounting_audit WHERE workspace_id = $1 ORDER BY created_at,audit_id",
        [workspaceId]
      );
      return rows.map((row) => JSON.parse(row.audit_json) as Audit);
    }
  };
}

async function currentState(
  tx: Transaction,
  operation: AccountingOperation,
  workspace: Workspace,
  now: Date
): Promise<Prepared["before"]> {
  const base = {
    blocked: workspace.accounting_blocked,
    revision: String(workspace.accounting_revision)
  };
  if (operation.kind === "charge") {
    const request = await loadRequest(tx, operation.workspaceId, operation.reservationId);
    if (hash(request) !== operation.expectedRequestDigest) fail("request-changed");
    if (
      request.state === "reserved" &&
      (!Number.isFinite(Date.parse(request.expires_at)) ||
        Date.parse(request.expires_at) > now.getTime())
    )
      fail("live-reservation");
    return { ...base, request };
  }
  if (!workspace.accounting_blocked) fail("workspace-not-blocked");
  const { rows } = await tx.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM ai_usage_requests WHERE workspace_id = $1
     AND (accounting_blocker = TRUE OR (state = 'reserved' AND expires_at > $2))`,
    [operation.workspaceId, now.toISOString()]
  );
  if (Number(rows[0]?.count) !== 0) fail("unresolved-blocker-or-live-reservation");
  return base;
}

async function lockWorkspace(tx: Transaction, workspaceId: string): Promise<Workspace> {
  const { rows } = await tx.query<Workspace>(
    "SELECT accounting_blocked,accounting_revision FROM ai_usage_locks WHERE workspace_id = $1 FOR UPDATE",
    [workspaceId]
  );
  if (!rows[0]) fail("workspace-not-found");
  return rows[0];
}
async function loadRequest(
  tx: Transaction,
  workspaceId: string,
  reservationId: string
): Promise<RequestRow> {
  const { rows } = await tx.query<RequestRow>(
    `SELECT ${requestColumns} FROM ai_usage_requests WHERE workspace_id = $1 AND reservation_id = $2`,
    [workspaceId, reservationId]
  );
  if (!rows[0]) fail("request-not-found-in-workspace");
  return rows[0];
}
async function loadAudit(
  tx: Transaction,
  preparationId: string
): Promise<Audit | undefined> {
  const { rows } = await tx.query<{ audit_json: string }>(
    "SELECT audit_json FROM ai_accounting_audit WHERE preparation_id = $1",
    [preparationId]
  );
  return rows[0] ? (JSON.parse(rows[0].audit_json) as Audit) : undefined;
}
function validateEvidence(operation: AccountingOperation): void {
  if (operation.kind !== "charge") return;
  const amount = nanos(operation.verifiedAmountUsd);
  if ((amount === 0) !== (operation.evidence.kind === "provider-confirmed-no-charge"))
    fail("charge-evidence-mismatch");
}
function nanos(value: string): number {
  const [whole = "0", fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) fail("amount-out-of-range");
  return Number(amount);
}
function usd(value: string | number): string {
  const amount = BigInt(value);
  return `${amount / 1_000_000_000n}.${String(amount % 1_000_000_000n).padStart(9, "0")}`;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    return (
      "{" +
      entries
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value) ?? "null";
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function safeIdentifier(value: string): string {
  return identifier.safeParse(value).success ? value : "unavailable";
}
function safeProviderFacts(raw: string | null): Record<string, string> {
  const safe: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (!parsed || typeof parsed !== "object") return safe;
    for (const key of [
      "providerResponseId",
      "providerRequestId",
      "returnedModel",
      "serviceTier",
      "responseStatus",
      "failureCode"
    ])
      if (key in parsed) {
        const value: unknown = Reflect.get(parsed, key);
        if (typeof value === "string") safe[key] = safeIdentifier(value);
      }
  } catch {
    /* Damaged telemetry is unavailable, not printable diagnostic text. */
  }
  return safe;
}
function fail(code: string): never {
  throw new AiAccountingRecoveryError(code);
}
