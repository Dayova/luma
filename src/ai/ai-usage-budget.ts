import { createHash, randomUUID } from "node:crypto";
import type { LumaDatabase } from "../persistence/db.js";
import { AiServiceError, type AiServiceErrorCode } from "./ai-service-error.js";

const NANOS_PER_USD = 1_000_000_000;
// Standard, short-context, 30-minute cache prices checked 2026-09-08.
// Reasoning is a subset of output tokens, never an additional charge.
export const AI_PRICE_VERSION = "openai-standard-2026-09-08";
const LUNA_PRICE = { input: 200, cachedInput: 20, cacheWrite: 250, output: 1200 };

export function isAiModelPriced(model: string): boolean {
  return model === "gpt-5.6-luna";
}

export type AiTokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

export type AiUsageBreakdown = {
  capability: string;
  spentUsd: number;
  reservedUsd: number;
  unknownUsd: number;
  requestCount: number;
};

export type AiUsageStatus = {
  month: string;
  timezone: string;
  resetAt: string;
  monthlyLimitUsd: number;
  dailyLimitUsd?: number;
  spentUsd: number;
  reservedUsd: number;
  unknownUsd: number;
  requestCount: number;
  status: "available" | "warning" | "critical" | "exhausted" | "not-configured";
  alerts: (80 | 90 | 100)[];
  byCapability: AiUsageBreakdown[];
  configured: boolean;
  limitScope?: "month" | "day";
  dailySpentUsd?: number;
  dailyReservedUsd?: number;
  dailyUnknownUsd?: number;
  dailyResetAt?: string;
};

export type AiResponseFacts = {
  providerResponseId?: string;
  providerRequestId?: string;
  returnedModel?: string;
  serviceTier?: string;
  responseStatus?: string;
  incompleteReason?: string;
  failureCode?: AiServiceErrorCode;
  reportedUsage?: AiTokenUsage;
};

export type AiUsageBudgetSettings = {
  monthlyLimitUsd: number;
  dailyLimitUsd?: number;
  timezone: string;
  workflowLimitUsd: number;
  maxWorkflowAttempts: number;
};

export interface AiUsageBudget {
  getStatus(workspaceId: string): Promise<AiUsageStatus>;
  reserve(input: {
    workspaceId: string;
    workflowId: string;
    capability: string;
    model: string;
    inputTokenUpperBound: number;
    maxOutputTokens: number;
    timeoutMs?: number;
  }): Promise<{ reservationId: string }>;
  settle(reservationId: string, usage: AiTokenUsage | undefined): Promise<void>;
  recordResponseFacts(reservationId: string, facts: AiResponseFacts): Promise<void>;
  markUnknown(
    reservationId: string,
    options?: { blockWorkspace?: boolean }
  ): Promise<void>;
}

type UsageRow = {
  reservation_id: string;
  workflow_id: string;
  capability: string;
  month: string;
  day: string;
  state: "reserved" | "unknown" | "settled";
  reserved_nanos: string | number;
  charged_nanos: string | number | null;
  workspace_id: string;
  input_token_upper_bound: number;
  max_output_tokens: number;
  price_version: string;
  model: string;
};

type BudgetConfig = Partial<AiUsageBudgetSettings> & {
  database: LumaDatabase;
  configured?: boolean;
  now?: () => Date;
};

export function aiUsageBudgetSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): AiUsageBudgetSettings {
  const daily = env["LUMA_AI_DAILY_LIMIT_USD"]?.trim();
  return validateSettings({
    monthlyLimitUsd: configuredNumber(env["LUMA_AI_MONTHLY_LIMIT_USD"], 30),
    ...(daily ? { dailyLimitUsd: configuredNumber(daily, 0) } : {}),
    timezone: env["LUMA_AI_BUDGET_TIMEZONE"]?.trim() || "Europe/Berlin",
    workflowLimitUsd: configuredNumber(env["LUMA_AI_WORKFLOW_LIMIT_USD"], 0.25),
    maxWorkflowAttempts: 3
  });
}

export function createAiUsageBudget(config: BudgetConfig): AiUsageBudget {
  const settings = validateSettings({
    monthlyLimitUsd: config.monthlyLimitUsd ?? 30,
    ...(config.dailyLimitUsd !== undefined
      ? { dailyLimitUsd: config.dailyLimitUsd }
      : {}),
    timezone: config.timezone ?? "Europe/Berlin",
    workflowLimitUsd: config.workflowLimitUsd ?? 0.25,
    maxWorkflowAttempts: config.maxWorkflowAttempts ?? 3
  });
  const configured = config.configured ?? true;
  const clock = config.now ?? (() => new Date());

  return {
    async getStatus(workspaceId) {
      const now = clock();
      return config.database.transaction(async (tx) => {
        const blocked = await lockWorkspace(tx, workspaceId);
        await expireReservations(tx, workspaceId, now);
        const { rows } = await tx.query<UsageRow>(
          "SELECT * FROM ai_usage_requests WHERE workspace_id = $1 AND month = $2",
          [workspaceId, localDate(now, settings.timezone).slice(0, 7)]
        );
        return statusFor(rows, now, settings, configured && !blocked);
      });
    },
    async reserve(input) {
      if (!configured) {
        throw new AiServiceError("not-configured", "AI usage is not configured.");
      }
      if (!isAiModelPriced(input.model)) {
        throw new AiServiceError(
          "not-configured",
          "The selected AI model does not have a verified price configuration."
        );
      }
      if (
        !positiveInteger(input.inputTokenUpperBound) ||
        !positiveInteger(input.maxOutputTokens) ||
        input.inputTokenUpperBound + input.maxOutputTokens > 272_000
      ) {
        throw new AiServiceError(
          "request-too-large",
          "This AI request exceeds its safe token limit."
        );
      }
      const reserved =
        input.inputTokenUpperBound * LUNA_PRICE.cacheWrite +
        input.maxOutputTokens * LUNA_PRICE.output;
      const now = clock();
      const day = localDate(now, settings.timezone);
      const month = day.slice(0, 7);
      // Even callers passing human-readable identifiers cannot put source text in telemetry.
      const workflowId = createHash("sha256").update(input.workflowId).digest("hex");
      return config.database.transaction(async (tx) => {
        if (await lockWorkspace(tx, input.workspaceId)) {
          throw new AiServiceError(
            "not-configured",
            "AI accounting needs reconciliation before further paid requests."
          );
        }
        await expireReservations(tx, input.workspaceId, now);
        const { rows } = await tx.query<UsageRow>(
          `SELECT * FROM ai_usage_requests
           WHERE workspace_id = $1 AND (month = $2 OR workflow_id = $3)`,
          [input.workspaceId, month, workflowId]
        );
        const workflow = rows.filter((row) => row.workflow_id === workflowId);
        if (workflow.some((row) => row.state !== "settled")) {
          throw new AiServiceError(
            "request-indeterminate",
            "This AI request is already running or has an unresolved charge; it will not be sent again."
          );
        }
        if (
          workflow.length >= settings.maxWorkflowAttempts ||
          totalNanos(workflow) + reserved > dollars(settings.workflowLimitUsd)
        ) {
          throw new AiServiceError(
            "budget-exhausted",
            "This workflow has reached its AI attempt or spending limit.",
            { limitScope: "workflow" }
          );
        }
        const current = rows.filter((row) => row.month === month);
        if (totalNanos(current) + reserved > dollars(settings.monthlyLimitUsd)) {
          throw new AiServiceError(
            "budget-exhausted",
            "There is not enough unreserved monthly AI budget for this request.",
            {
              resetAt: nextBoundary(now, settings.timezone, "month"),
              limitScope: "month"
            }
          );
        }
        if (
          settings.dailyLimitUsd !== undefined &&
          totalNanos(current.filter((row) => row.day === day)) + reserved >
            dollars(settings.dailyLimitUsd)
        ) {
          throw new AiServiceError(
            "budget-exhausted",
            "There is not enough unreserved daily AI budget for this request.",
            { resetAt: nextBoundary(now, settings.timezone, "day"), limitScope: "day" }
          );
        }
        const reservationId = randomUUID();
        await tx.query(
          `INSERT INTO ai_usage_requests
           (reservation_id,workspace_id,workflow_id,capability,model,price_version,month,day,
            state,reserved_nanos,created_at,expires_at,input_token_upper_bound,max_output_tokens)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9,$10,$11,$12,$13)`,
          [
            reservationId,
            input.workspaceId,
            workflowId,
            input.capability,
            input.model,
            AI_PRICE_VERSION,
            month,
            day,
            reserved,
            now.toISOString(),
            new Date(now.getTime() + (input.timeoutMs ?? 60_000) + 120_000).toISOString(),
            input.inputTokenUpperBound,
            input.maxOutputTokens
          ]
        );
        return { reservationId };
      });
    },
    async settle(reservationId, usage) {
      if (!usage || !validUsage(usage)) {
        await this.markUnknown(reservationId);
        return;
      }
      const { rows } = await config.database.query<UsageRow>(
        "SELECT * FROM ai_usage_requests WHERE reservation_id = $1",
        [reservationId]
      );
      const row = rows[0];
      if (!row || row.state === "settled") return;
      if (
        row.price_version !== AI_PRICE_VERSION ||
        !isAiModelPriced(row.model) ||
        usage.inputTokens > row.input_token_upper_bound ||
        usage.outputTokens > row.max_output_tokens
      ) {
        await this.markUnknown(reservationId, { blockWorkspace: true });
        throw new AiServiceError(
          "not-configured",
          "AI usage exceeded its reserved bounds; accounting needs reconciliation."
        );
      }
      const charged =
        (usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens) *
          LUNA_PRICE.input +
        usage.cachedInputTokens * LUNA_PRICE.cachedInput +
        usage.cacheWriteTokens * LUNA_PRICE.cacheWrite +
        usage.outputTokens * LUNA_PRICE.output;
      // Settlement is idempotent. Late positive usage can resolve an unknown reservation.
      await config.database.query(
        `UPDATE ai_usage_requests SET state = 'settled', charged_nanos = $2,
         input_tokens = $3, cached_input_tokens = $4, cache_write_tokens = $5,
         output_tokens = $6, reasoning_tokens = $7, settled_at = $8
         WHERE reservation_id = $1 AND state IN ('reserved','unknown')`,
        [
          reservationId,
          charged,
          usage.inputTokens,
          usage.cachedInputTokens,
          usage.cacheWriteTokens,
          usage.outputTokens,
          usage.reasoningTokens,
          clock().toISOString()
        ]
      );
    },
    async recordResponseFacts(reservationId, facts) {
      const safe: AiResponseFacts = {};
      for (const key of [
        "providerResponseId",
        "providerRequestId",
        "returnedModel",
        "serviceTier",
        "responseStatus",
        "incompleteReason",
        "failureCode"
      ] as const) {
        const value = facts[key];
        if (value && value.length <= 256 && /^[a-zA-Z0-9_.:-]+$/.test(value)) {
          Object.assign(safe, { [key]: value });
        }
      }
      if (facts.reportedUsage && validUsage(facts.reportedUsage))
        safe.reportedUsage = facts.reportedUsage;
      await config.database.query(
        `UPDATE ai_usage_requests SET response_facts_json =
         (COALESCE(response_facts_json::jsonb, '{}'::jsonb) || $2::jsonb)::text
         WHERE reservation_id = $1`,
        [reservationId, JSON.stringify(safe)]
      );
    },
    async markUnknown(reservationId, options) {
      await config.database.transaction(async (tx) => {
        const { rows } = await tx.query<{ workspace_id: string }>(
          "SELECT workspace_id FROM ai_usage_requests WHERE reservation_id = $1",
          [reservationId]
        );
        const row = rows[0];
        if (!row) return;
        await lockWorkspace(tx, row.workspace_id);
        await tx.query(
          "UPDATE ai_usage_requests SET state = 'unknown' WHERE reservation_id = $1 AND state = 'reserved'",
          [reservationId]
        );
        if (options?.blockWorkspace) {
          await tx.query(
            "UPDATE ai_usage_locks SET accounting_blocked = TRUE WHERE workspace_id = $1",
            [row.workspace_id]
          );
        }
      });
    }
  };
}

function validUsage(usage: AiTokenUsage): boolean {
  return (
    Object.values(usage).every((value) => Number.isSafeInteger(value) && value >= 0) &&
    usage.cachedInputTokens + usage.cacheWriteTokens <= usage.inputTokens &&
    usage.reasoningTokens <= usage.outputTokens
  );
}

type Transaction = Parameters<Parameters<LumaDatabase["transaction"]>[0]>[0];

async function lockWorkspace(tx: Transaction, workspaceId: string): Promise<boolean> {
  await tx.query(
    "INSERT INTO ai_usage_locks (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [workspaceId]
  );
  const { rows } = await tx.query<{ accounting_blocked: boolean }>(
    "SELECT accounting_blocked FROM ai_usage_locks WHERE workspace_id = $1 FOR UPDATE",
    [workspaceId]
  );
  return rows[0]?.accounting_blocked ?? false;
}

async function expireReservations(
  tx: Transaction,
  workspaceId: string,
  now: Date
): Promise<void> {
  await tx.query(
    "UPDATE ai_usage_requests SET state = 'unknown' WHERE workspace_id = $1 AND state = 'reserved' AND expires_at <= $2",
    [workspaceId, now.toISOString()]
  );
}

function statusFor(
  rows: UsageRow[],
  now: Date,
  settings: AiUsageBudgetSettings,
  configured: boolean
): AiUsageStatus {
  const sums = breakdown(rows, "all");
  const total = totalNanos(rows);
  const ratio =
    settings.monthlyLimitUsd === 0 ? 1 : total / dollars(settings.monthlyLimitUsd);
  const dailyReached =
    settings.dailyLimitUsd !== undefined &&
    totalNanos(rows.filter((row) => row.day === localDate(now, settings.timezone))) >=
      dollars(settings.dailyLimitUsd);
  const daily = breakdown(
    rows.filter((row) => row.day === localDate(now, settings.timezone)),
    "all"
  );
  return {
    month: localDate(now, settings.timezone).slice(0, 7),
    timezone: settings.timezone,
    resetAt: nextBoundary(
      now,
      settings.timezone,
      dailyReached && ratio < 1 ? "day" : "month"
    ),
    monthlyLimitUsd: settings.monthlyLimitUsd,
    ...(settings.dailyLimitUsd !== undefined
      ? {
          dailyLimitUsd: settings.dailyLimitUsd,
          dailySpentUsd: daily.spentUsd,
          dailyReservedUsd: daily.reservedUsd,
          dailyUnknownUsd: daily.unknownUsd,
          dailyResetAt: nextBoundary(now, settings.timezone, "day")
        }
      : {}),
    spentUsd: sums.spentUsd,
    reservedUsd: sums.reservedUsd,
    unknownUsd: sums.unknownUsd,
    requestCount: rows.length,
    status: !configured
      ? "not-configured"
      : ratio >= 1 || dailyReached
        ? "exhausted"
        : ratio >= 0.9
          ? "critical"
          : ratio >= 0.8
            ? "warning"
            : "available",
    alerts:
      ratio >= 1 ? [80, 90, 100] : ratio >= 0.9 ? [80, 90] : ratio >= 0.8 ? [80] : [],
    byCapability: [...new Set(rows.map((row) => row.capability))]
      .sort()
      .map((capability) =>
        breakdown(
          rows.filter((row) => row.capability === capability),
          capability
        )
      ),
    configured,
    ...(ratio >= 1
      ? { limitScope: "month" as const }
      : dailyReached
        ? { limitScope: "day" as const }
        : {})
  };
}

function breakdown(rows: UsageRow[], capability: string): AiUsageBreakdown {
  return {
    capability,
    spentUsd:
      rows
        .filter((row) => row.state === "settled")
        .reduce((sum, row) => sum + Number(row.charged_nanos), 0) / NANOS_PER_USD,
    reservedUsd:
      rows
        .filter((row) => row.state === "reserved")
        .reduce((sum, row) => sum + Number(row.reserved_nanos), 0) / NANOS_PER_USD,
    unknownUsd:
      rows
        .filter((row) => row.state === "unknown")
        .reduce((sum, row) => sum + Number(row.reserved_nanos), 0) / NANOS_PER_USD,
    requestCount: rows.length
  };
}

function totalNanos(rows: UsageRow[]): number {
  return rows.reduce(
    (sum, row) =>
      sum + Number(row.state === "settled" ? row.charged_nanos : row.reserved_nanos),
    0
  );
}

function dollars(value: number): number {
  return Math.round(value * NANOS_PER_USD);
}
function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
function configuredNumber(value: string | undefined, fallback: number): number {
  return value?.trim() ? Number(value) : fallback;
}

function validateSettings(settings: AiUsageBudgetSettings): AiUsageBudgetSettings {
  for (const value of [
    settings.monthlyLimitUsd,
    settings.workflowLimitUsd,
    settings.dailyLimitUsd ?? 0
  ]) {
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(dollars(value))) {
      throw new AiServiceError(
        "not-configured",
        "AI spending limits must be non-negative finite USD amounts."
      );
    }
  }
  if (!positiveInteger(settings.maxWorkflowAttempts))
    throw new AiServiceError(
      "not-configured",
      "AI workflow attempts must be a positive integer."
    );
  try {
    new Intl.DateTimeFormat("en", { timeZone: settings.timezone }).format();
  } catch {
    throw new AiServiceError("not-configured", "The AI budget timezone is invalid.");
  }
  return settings;
}

function localDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const part = (type: string): string =>
    parts.find((value) => value.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Find the actual timezone boundary, including DST, without machine-local dates. */
function nextBoundary(now: Date, timezone: string, unit: "month" | "day"): string {
  const key = (timestamp: number): string =>
    localDate(new Date(timestamp), timezone).slice(0, unit === "month" ? 7 : 10);
  const initial = key(now.getTime());
  let low = now.getTime();
  let high = low + (unit === "month" ? 32 : 2) * 86_400_000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (key(middle) === initial) low = middle;
    else high = middle;
  }
  return new Date(high).toISOString();
}
