import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import {
  aiUsageBudgetSettingsFromEnv,
  createAiUsageBudget
} from "../../src/ai/ai-usage-budget.js";

const reservation = {
  workspaceId: "dayova",
  workflowId: "meeting-evidence-revision-question",
  capability: "context-ask",
  model: "gpt-5.6-luna",
  inputTokenUpperBound: 1000,
  maxOutputTokens: 200
};
const usage = {
  inputTokens: 1000,
  cachedInputTokens: 200,
  cacheWriteTokens: 300,
  outputTokens: 200,
  reasoningTokens: 100
};

describe("durable AI usage budget", () => {
  let database: LumaDatabase;
  beforeEach(async () => {
    database = await createPgliteDatabase();
  });
  afterEach(async () => {
    await database.close();
  });

  it("reserves before spending, settles real cache usage and never charges reasoning twice", async () => {
    const budget = createAiUsageBudget({ database });
    const { reservationId } = await budget.reserve(reservation);
    expect(await budget.getStatus("dayova")).toMatchObject({
      spentUsd: 0,
      reservedUsd: 0.00049,
      unknownUsd: 0,
      requestCount: 1
    });
    await budget.settle(reservationId, usage);
    await budget.settle(reservationId, { ...usage, outputTokens: 1 });
    expect(await budget.getStatus("dayova")).toMatchObject({
      spentUsd: 0.000419,
      reservedUsd: 0,
      unknownUsd: 0,
      requestCount: 1,
      byCapability: [{ capability: "context-ask", spentUsd: 0.000419, requestCount: 1 }]
    });
    const { rows } = await database.query<{ workflow_id: string; price_version: string }>(
      "SELECT workflow_id,price_version FROM ai_usage_requests"
    );
    expect(rows[0]?.workflow_id).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.price_version).toBe("openai-standard-2026-09-08");
  });

  it("serializes final funds across independent budget instances sharing durable persistence", async () => {
    const one = createAiUsageBudget({ database, monthlyLimitUsd: 0.0007 });
    const two = createAiUsageBudget({ database, monthlyLimitUsd: 0.0007 });
    const results = await Promise.allSettled([
      one.reserve(reservation),
      two.reserve({ ...reservation, workflowId: "another" })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { code: "budget-exhausted", limitScope: "month" } }
    ]);
    expect(await one.getStatus("dayova")).toMatchObject({
      requestCount: 1,
      reservedUsd: 0.00049
    });
  });

  it("rejects concurrent duplicates and keeps uncertain charges rather than treating them as free", async () => {
    const budget = createAiUsageBudget({ database });
    const { reservationId } = await budget.reserve(reservation);
    await expect(budget.reserve(reservation)).rejects.toMatchObject({
      code: "request-indeterminate"
    });
    await budget.settle(reservationId, undefined);
    expect(await budget.getStatus("dayova")).toMatchObject({
      spentUsd: 0,
      reservedUsd: 0,
      unknownUsd: 0.00049
    });
    await expect(budget.reserve(reservation)).rejects.toMatchObject({
      code: "request-indeterminate"
    });
    await budget.settle(reservationId, usage);
    expect(await budget.getStatus("dayova")).toMatchObject({
      spentUsd: 0.000419,
      unknownUsd: 0
    });
  });

  it("limits settled attempts for a stable workflow, and lowered caps take effect immediately", async () => {
    const budget = createAiUsageBudget({ database });
    for (let index = 0; index < 3; index++) {
      const { reservationId } = await budget.reserve(reservation);
      await budget.settle(reservationId, usage);
    }
    await expect(budget.reserve(reservation)).rejects.toMatchObject({
      code: "budget-exhausted",
      limitScope: "workflow"
    });
    const lowered = createAiUsageBudget({ database, monthlyLimitUsd: 0.001 });
    await expect(
      lowered.reserve({ ...reservation, workflowId: "new" })
    ).rejects.toMatchObject({ code: "budget-exhausted", limitScope: "month" });
  });

  it("enforces a workflow spending ceiling independently of available monthly funds", async () => {
    const budget = createAiUsageBudget({ database, workflowLimitUsd: 0.0005 });
    const { reservationId } = await budget.reserve(reservation);
    await budget.settle(reservationId, usage);
    await expect(budget.reserve(reservation)).rejects.toMatchObject({
      code: "budget-exhausted",
      limitScope: "workflow"
    });
  });

  it("exposes 80 and 90 percent warnings using spend plus all held charges", async () => {
    const budget = createAiUsageBudget({ database, monthlyLimitUsd: 0.001 });
    const { reservationId } = await budget.reserve({
      ...reservation,
      inputTokenUpperBound: 800,
      maxOutputTokens: 500
    });
    expect(await budget.getStatus("dayova")).toMatchObject({
      status: "warning",
      alerts: [80]
    });
    await budget.markUnknown(reservationId);
    await budget.reserve({
      ...reservation,
      workflowId: "other",
      inputTokenUpperBound: 160,
      maxOutputTokens: 50
    });
    expect(await budget.getStatus("dayova")).toMatchObject({
      status: "critical",
      alerts: [80, 90],
      unknownUsd: 0.0008,
      reservedUsd: 0.0001
    });
    await budget.reserve({
      ...reservation,
      workflowId: "last",
      inputTokenUpperBound: 160,
      maxOutputTokens: 50
    });
    expect(await budget.getStatus("dayova")).toMatchObject({
      status: "exhausted",
      alerts: [80, 90, 100],
      limitScope: "month"
    });
  });

  it("uses Europe/Berlin month boundaries and settles late responses in their original period", async () => {
    let now = new Date("2026-09-30T21:59:00.000Z");
    const budget = createAiUsageBudget({ database, now: () => now });
    const { reservationId } = await budget.reserve(reservation);
    expect(await budget.getStatus("dayova")).toMatchObject({
      month: "2026-09",
      resetAt: "2026-09-30T22:00:00.000Z"
    });
    now = new Date("2026-09-30T22:01:00.000Z");
    expect(await budget.getStatus("dayova")).toMatchObject({
      month: "2026-10",
      spentUsd: 0,
      reservedUsd: 0
    });
    await expect(budget.reserve(reservation)).rejects.toMatchObject({
      code: "request-indeterminate"
    });
    await budget.settle(reservationId, usage);
    expect(await budget.getStatus("dayova")).toMatchObject({
      spentUsd: 0,
      requestCount: 0
    });
    const { rows } = await database.query("SELECT month,state FROM ai_usage_requests");
    expect(rows).toEqual([{ month: "2026-09", state: "settled" }]);
    now = new Date("2026-10-31T22:30:00.000Z");
    expect(await budget.getStatus("dayova")).toMatchObject({
      resetAt: "2026-10-31T23:00:00.000Z"
    });
  });

  it("daily caps identify their actual DST-aware reset without exhausting the monthly cap", async () => {
    let now = new Date("2026-03-28T23:01:00.000Z");
    const budget = createAiUsageBudget({
      database,
      dailyLimitUsd: 0.00049,
      now: () => now
    });
    await budget.reserve(reservation);
    expect(await budget.getStatus("dayova")).toMatchObject({
      status: "exhausted",
      limitScope: "day",
      dailyReservedUsd: 0.00049,
      resetAt: "2026-03-29T22:00:00.000Z"
    });
    await expect(
      budget.reserve({ ...reservation, workflowId: "other" })
    ).rejects.toMatchObject({ limitScope: "day", resetAt: "2026-03-29T22:00:00.000Z" });
    now = new Date("2026-03-29T22:01:00.000Z");
    await expect(
      budget.reserve({ ...reservation, workflowId: "other" })
    ).resolves.toHaveProperty("reservationId");
  });

  it("persists reservations through database restart and expires abandoned attempts to unknown", async () => {
    const path = await mkdtemp(join(tmpdir(), "luma-budget-"));
    let persistent = await createPgliteDatabase(path);
    try {
      const first = createAiUsageBudget({
        database: persistent,
        now: () => new Date("2026-09-08T12:00:00Z")
      });
      await first.reserve(reservation);
      await persistent.close();
      persistent = await createPgliteDatabase(path);
      const restarted = createAiUsageBudget({
        database: persistent,
        now: () => new Date("2026-09-08T13:00:00Z")
      });
      expect(await restarted.getStatus("dayova")).toMatchObject({
        requestCount: 1,
        reservedUsd: 0,
        unknownUsd: 0.00049
      });
      await expect(restarted.reserve(reservation)).rejects.toMatchObject({
        code: "request-indeterminate"
      });
    } finally {
      await persistent.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it.each([
    { ...usage, cachedInputTokens: 900 },
    { ...usage, outputTokens: -1 },
    { ...usage, reasoningTokens: 201 },
    { ...usage, inputTokens: 1.5 }
  ])("holds malformed token accounting as unknown (%j)", async (invalid) => {
    const budget = createAiUsageBudget({ database });
    const { reservationId } = await budget.reserve(reservation);
    await budget.settle(reservationId, invalid);
    expect(await budget.getStatus("dayova")).toMatchObject({
      spentUsd: 0,
      unknownUsd: 0.00049
    });
  });

  it("blocks further spend durably if actual tokens violate the verified reserved bounds", async () => {
    const budget = createAiUsageBudget({ database });
    const { reservationId } = await budget.reserve(reservation);
    await expect(
      budget.settle(reservationId, { ...usage, inputTokens: 272001 })
    ).rejects.toMatchObject({ code: "not-configured" });
    const restarted = createAiUsageBudget({ database });
    expect(await restarted.getStatus("dayova")).toMatchObject({
      status: "not-configured",
      unknownUsd: 0.00049
    });
    await expect(
      restarted.reserve({ ...reservation, workflowId: "other" })
    ).rejects.toMatchObject({ code: "not-configured" });
  });

  it("treats zero as disabled spending and never silently prices unknown models", async () => {
    const zero = createAiUsageBudget({ database, monthlyLimitUsd: 0 });
    await expect(zero.reserve(reservation)).rejects.toMatchObject({
      code: "budget-exhausted"
    });
    const budget = createAiUsageBudget({ database });
    await expect(
      budget.reserve({ ...reservation, model: "unpriced" })
    ).rejects.toMatchObject({ code: "not-configured" });
    expect(await budget.getStatus("dayova")).toMatchObject({ requestCount: 0 });
    expect(
      await createAiUsageBudget({ database, configured: false }).getStatus("dayova")
    ).toMatchObject({ status: "not-configured", configured: false });
  });

  it("refuses to reprice an old reservation with a different price version", async () => {
    const budget = createAiUsageBudget({ database });
    const { reservationId } = await budget.reserve(reservation);
    await database.query(
      "UPDATE ai_usage_requests SET price_version = 'historical-unknown' WHERE reservation_id = $1",
      [reservationId]
    );
    await expect(budget.settle(reservationId, usage)).rejects.toMatchObject({
      code: "not-configured"
    });
    expect(await budget.getStatus("dayova")).toMatchObject({
      status: "not-configured",
      unknownUsd: 0.00049,
      spentUsd: 0
    });
  });

  it("validates financial configuration and defaults to the provisional shared USD30 budget", () => {
    expect(aiUsageBudgetSettingsFromEnv({})).toEqual({
      monthlyLimitUsd: 30,
      timezone: "Europe/Berlin",
      workflowLimitUsd: 0.25,
      maxWorkflowAttempts: 3
    });
    for (const value of ["-1", "NaN", "Infinity", "oops"]) {
      expect(() =>
        aiUsageBudgetSettingsFromEnv({ LUMA_AI_MONTHLY_LIMIT_USD: value })
      ).toThrow();
    }
    expect(() =>
      aiUsageBudgetSettingsFromEnv({ LUMA_AI_BUDGET_TIMEZONE: "invalid" })
    ).toThrow();
  });
});
