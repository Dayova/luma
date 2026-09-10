import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAiUsageBudget } from "../../src/ai/ai-usage-budget.js";
import {
  createAiUsageReconciliation,
  type AccountingOperation
} from "../../src/ai/ai-usage-reconciliation.js";
import {
  createPgliteDatabase,
  runMigrations,
  type LumaDatabase
} from "../../src/persistence/db.js";
import { renderAiUsageStatus } from "../../src/discord/discord-ai-status.js";

const operator = { personId: "person_jakob", localUid: 1001 } as const;
const request = {
  workspaceId: "dayova",
  workflowId: "original-workflow",
  capability: "context-ask",
  model: "gpt-5.6-luna",
  inputTokenUpperBound: 1000,
  maxOutputTokens: 200
};
const evidence = {
  kind: "provider-billing",
  reference: "invoice-reviewed-line-1",
  sha256: "a".repeat(64)
} as const;
const now = new Date("2026-09-10T12:00:00Z");
type Recovery = ReturnType<typeof createAiUsageReconciliation>;
const review = (prepared: { preparationId: string; digest: string }) => ({
  preparationId: prepared.preparationId,
  digest: prepared.digest,
  reviewed: true as const
});

describe("audited AI accounting recovery", () => {
  let database: LumaDatabase;
  let recovery: Recovery;
  beforeEach(async () => {
    database = await createPgliteDatabase();
    recovery = createAiUsageReconciliation({ database, operator, now: () => now });
  });
  afterEach(async () => {
    await database.close();
  });

  async function unknown(workflowId = request.workflowId, blocked = false) {
    const budget = createAiUsageBudget({ database, now: () => now });
    const reservation = await budget.reserve({ ...request, workflowId });
    await budget.recordResponseFacts(reservation.reservationId, {
      providerRequestId: "req_verified",
      failureCode: "timeout"
    });
    await budget.markUnknown(reservation.reservationId, { blockWorkspace: blocked });
    return { budget, reservationId: reservation.reservationId };
  }
  async function charge(
    reservationId: string,
    verifiedAmountUsd = "0.02"
  ): Promise<AccountingOperation> {
    const report = await recovery.inspect("dayova");
    const item = report.requests.find((row) => row.reservationId === reservationId);
    if (!item) throw new Error("missing fixture accounting request");
    return {
      kind: "charge",
      workspaceId: "dayova",
      reservationId,
      expectedRequestDigest: item.requestDigest,
      verifiedAmountUsd,
      reason: "Compared the specific request with provider billing evidence.",
      evidence
    };
  }
  const unblock: AccountingOperation = {
    kind: "unblock",
    workspaceId: "dayova",
    reason: "All identified blockers and pricing configuration were reviewed.",
    evidence
  };

  it("prepares without settling, then applies the exact charge once and retains original facts", async () => {
    const { budget, reservationId } = await unknown();
    const prepared = await recovery.prepare(await charge(reservationId));
    expect(await budget.getStatus("dayova")).toMatchObject({
      unknownUsd: 0.00049,
      spentUsd: 0
    });
    expect(await recovery.history("dayova")).toEqual([]);
    const first = await recovery.apply(review(prepared));
    expect(await recovery.apply(review(prepared))).toEqual(first);
    const history = await recovery.history("dayova");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      operator,
      before: {
        request: {
          state: "unknown"
        }
      },
      after: { request: { state: "settled" } }
    });
    expect(history[0]?.before.request?.response_facts_json).toContain("req_verified");
    expect(await budget.getStatus("dayova")).toMatchObject({
      spentUsd: 0.02,
      unknownUsd: 0,
      monthlyLimitUsd: 30
    });
    await expect(budget.reserve(request)).rejects.toMatchObject({
      code: "request-indeterminate"
    });
    await expect(
      budget.reserve({ ...request, workflowId: "new-approved-work" })
    ).resolves.toHaveProperty("reservationId");
  });

  it("requires positive provider confirmation for zero and accepts exact USD nanos", async () => {
    const { budget, reservationId } = await unknown();
    const zero = await charge(reservationId, "0");
    await expect(recovery.prepare(zero)).rejects.toMatchObject({
      code: "charge-evidence-mismatch"
    });
    const prepared = await recovery.prepare({
      ...zero,
      evidence: { ...evidence, kind: "provider-confirmed-no-charge" }
    });
    await recovery.apply(review(prepared));
    expect(await budget.getStatus("dayova")).toMatchObject({
      spentUsd: 0,
      unknownUsd: 0,
      requestCount: 1
    });
    // A reviewed correction appends a new audit; it never rewrites its predecessor.
    const correction = await recovery.prepare(await charge(reservationId, "0.000000001"));
    await recovery.apply(review(correction));
    expect(await budget.getStatus("dayova")).toMatchObject({ spentUsd: 0.000000001 });
    expect(await recovery.history("dayova")).toHaveLength(2);
    await recovery.apply(review(prepared));
    expect(await budget.getStatus("dayova")).toMatchObject({ spentUsd: 0.000000001 });
  });

  it("rejects live reservations, a wrong workspace, stale facts and an unreviewed or different-operator approval", async () => {
    const budget = createAiUsageBudget({ database, now: () => now });
    const { reservationId } = await budget.reserve(request);
    await expect(recovery.prepare(await charge(reservationId))).rejects.toMatchObject({
      code: "live-reservation"
    });
    await budget.markUnknown(reservationId);
    await budget.getStatus("other");
    await expect(
      recovery.prepare({ ...(await charge(reservationId)), workspaceId: "other" })
    ).rejects.toMatchObject({ code: "request-not-found-in-workspace" });
    const prepared = await recovery.prepare(await charge(reservationId));
    await expect(
      recovery.apply({ ...review(prepared), digest: "b".repeat(64) })
    ).rejects.toMatchObject({ code: "preparation-mismatch" });
    await expect(
      recovery.apply({ ...review(prepared), reviewed: false } as unknown as Parameters<
        Recovery["apply"]
      >[0])
    ).rejects.toThrow();
    const other = createAiUsageReconciliation({
      database,
      operator: { ...operator, personId: "person_julius" },
      now: () => now
    });
    await expect(other.apply(review(prepared))).rejects.toMatchObject({
      code: "operator-or-digest-mismatch"
    });
    await budget.recordResponseFacts(reservationId, { providerResponseId: "resp_late" });
    await expect(recovery.apply(review(prepared))).rejects.toMatchObject({
      code: "request-changed"
    });
    expect(await recovery.history("dayova")).toEqual([]);
  });

  it("requires every blocker before an explicit unblock while preserving unrelated unknown holds", async () => {
    const one = await unknown("one");
    const two = await unknown("two");
    await unknown("unrelated-held");
    await one.budget.markUnknown(one.reservationId, { blockWorkspace: true });
    await two.budget.markUnknown(two.reservationId, { blockWorkspace: true });
    expect(renderAiUsageStatus(await one.budget.getStatus("dayova"))).toContain(
      "stopped-store accounting recovery"
    );
    await expect(recovery.prepare(unblock)).rejects.toMatchObject({
      code: "unresolved-blocker-or-live-reservation"
    });
    await recovery.apply(review(await recovery.prepare(await charge(one.reservationId))));
    await expect(recovery.prepare(unblock)).rejects.toMatchObject({
      code: "unresolved-blocker-or-live-reservation"
    });
    await recovery.apply(review(await recovery.prepare(await charge(two.reservationId))));
    expect(await one.budget.getStatus("dayova")).toMatchObject({
      accountingBlocked: true,
      status: "not-configured",
      unknownUsd: 0.00049
    });
    await recovery.apply(review(await recovery.prepare(unblock)));
    expect(await one.budget.getStatus("dayova")).toMatchObject({
      accountingBlocked: false,
      status: "available",
      spentUsd: 0.04,
      unknownUsd: 0.00049
    });
    await expect(
      one.budget.reserve({ ...request, workflowId: "unrelated-held" })
    ).rejects.toMatchObject({ code: "request-indeterminate" });
  });

  it("refuses a stale unblock even after a newer block was separately reconciled", async () => {
    const one = await unknown("one");
    const two = await unknown("two");
    await one.budget.markUnknown(one.reservationId, { blockWorkspace: true });
    await recovery.apply(review(await recovery.prepare(await charge(one.reservationId))));
    const prepared = await recovery.prepare(unblock);
    await two.budget.markUnknown(two.reservationId, { blockWorkspace: true });
    await expect(recovery.apply(review(prepared))).rejects.toMatchObject({
      code: "unresolved-blocker-or-live-reservation"
    });
    await recovery.apply(review(await recovery.prepare(await charge(two.reservationId))));
    await expect(recovery.apply(review(prepared))).rejects.toMatchObject({
      code: "stale-preparation"
    });
    expect(await one.budget.getStatus("dayova")).toMatchObject({
      accountingBlocked: true
    });
  });

  it("records an above-cap verified charge without increasing the cap or enabling further spending", async () => {
    const { budget, reservationId } = await unknown("one", true);
    await recovery.apply(
      review(await recovery.prepare(await charge(reservationId, "40.01")))
    );
    await recovery.apply(review(await recovery.prepare(unblock)));
    expect(await budget.getStatus("dayova")).toMatchObject({
      spentUsd: 40.01,
      monthlyLimitUsd: 30,
      status: "exhausted",
      accountingBlocked: false
    });
    await expect(
      budget.reserve({ ...request, workflowId: "different" })
    ).rejects.toMatchObject({ code: "budget-exhausted", limitScope: "month" });
  });

  it("serializes concurrent approvals and rejects a competing stale reconciliation", async () => {
    const { reservationId } = await unknown();
    const prepared = await recovery.prepare(await charge(reservationId));
    const competing = await recovery.prepare(await charge(reservationId, "0.03"));
    const results = await Promise.all([
      recovery.apply(review(prepared)),
      recovery.apply(review(prepared))
    ]);
    expect(results[0]?.auditId).toBe(results[1]?.auditId);
    await expect(recovery.apply(review(competing))).rejects.toMatchObject({
      code: "request-changed"
    });
    expect(await recovery.history("dayova")).toHaveLength(1);
  });

  it("keeps preparations and audits immutable and backfills legacy blockers only once", async () => {
    const { budget, reservationId } = await unknown("one", true);
    await database.exec(
      "ALTER TABLE ai_usage_requests DROP COLUMN accounting_blocker; DELETE FROM ai_accounting_migrations WHERE id = 'lum-52-v1'"
    );
    await runMigrations(database);
    expect((await recovery.inspect("dayova")).requests[0]).toMatchObject({
      accountingBlocker: true
    });
    const prepared = await recovery.prepare(await charge(reservationId));
    await recovery.apply(review(prepared));
    await expect(
      database.query("UPDATE ai_accounting_audit SET audit_json = '{}'")
    ).rejects.toThrow("append-only");
    await expect(
      database.query("DELETE FROM ai_accounting_preparations")
    ).rejects.toThrow("append-only");
    await runMigrations(database);
    expect((await recovery.inspect("dayova")).requests[0]).toMatchObject({
      accountingBlocker: false,
      reconciled: true
    });
    expect(await budget.getStatus("dayova")).toMatchObject({ accountingBlocked: true });
  });

  it("rolls back the charge when the audit cannot commit and safely retries the same preparation", async () => {
    const { budget, reservationId } = await unknown();
    const prepared = await recovery.prepare(await charge(reservationId));
    await database.exec(`CREATE FUNCTION fail_test_accounting_audit() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'simulated audit storage failure'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_test_accounting_audit BEFORE INSERT ON ai_accounting_audit
      FOR EACH ROW EXECUTE FUNCTION fail_test_accounting_audit();`);
    await expect(recovery.apply(review(prepared))).rejects.toThrow(
      "simulated audit storage failure"
    );
    expect(await budget.getStatus("dayova")).toMatchObject({
      spentUsd: 0,
      unknownUsd: 0.00049
    });
    expect(await recovery.history("dayova")).toEqual([]);
    await database.exec("DROP TRIGGER fail_test_accounting_audit ON ai_accounting_audit");
    await recovery.apply(review(prepared));
    expect(await budget.getStatus("dayova")).toMatchObject({
      spentUsd: 0.02,
      unknownUsd: 0
    });
  });

  it("recovers an expired reservation through persisted preparation and idempotent restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "luma-accounting-"));
    const store = join(root, "store");
    let persistent = await createPgliteDatabase(store);
    try {
      const budget = createAiUsageBudget({ database: persistent, now: () => now });
      const { reservationId } = await budget.reserve(request);
      const later = () => new Date(now.getTime() + 300_000);
      let service = createAiUsageReconciliation({
        database: persistent,
        operator,
        now: later
      });
      const item = (await service.inspect("dayova")).requests[0]!;
      const prepared = await service.prepare({
        kind: "charge",
        workspaceId: "dayova",
        reservationId,
        expectedRequestDigest: item.requestDigest,
        verifiedAmountUsd: "0.01",
        reason: "Provider receipt confirms this previously interrupted request.",
        evidence
      });
      await persistent.close();
      persistent = await createPgliteDatabase(store);
      service = createAiUsageReconciliation({
        database: persistent,
        operator,
        now: later
      });
      const audit = await service.apply(review(prepared));
      await persistent.close();
      persistent = await createPgliteDatabase(store);
      service = createAiUsageReconciliation({
        database: persistent,
        operator,
        now: later
      });
      expect(await service.apply(review(prepared))).toEqual(audit);
      const restarted = createAiUsageBudget({ database: persistent, now: later });
      expect(await restarted.getStatus("dayova")).toMatchObject({
        spentUsd: 0.01,
        unknownUsd: 0,
        reservedUsd: 0
      });
      await expect(restarted.reserve(request)).rejects.toMatchObject({
        code: "request-indeterminate"
      });
    } finally {
      await persistent.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
