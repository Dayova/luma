import { createHash } from "node:crypto";
import { AiServiceError } from "./ai-service-error.js";
import type { AiTokenUsage, AiUsageBudget } from "./ai-usage-budget.js";

export type AiRequestLimits = {
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
};

/** Provider-normalized accounting facts; optional means unknown, never zero. */
export type AiResponse = {
  outputText: string;
  model?: string;
  serviceTier?: string;
  usage?: AiTokenUsage;
  status?: string;
  incompleteReason?: string;
  providerResponseId?: string;
  providerRequestId?: string;
};

export function aiRequestLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): AiRequestLimits {
  const number = (key: string, fallback: number): number =>
    env[key]?.trim() ? Number(env[key]) : fallback;
  return resolveAiRequestLimits({
    maxInputTokens: number("LUMA_AI_MAX_INPUT_TOKENS", 100_000),
    maxOutputTokens: number("LUMA_AI_MAX_OUTPUT_TOKENS", 8192),
    timeoutMs: number("LUMA_AI_TIMEOUT_MS", 60_000)
  });
}

export function resolveAiRequestLimits(
  limits: Partial<AiRequestLimits> = {}
): AiRequestLimits {
  const result = {
    maxInputTokens: 100_000,
    maxOutputTokens: 8192,
    timeoutMs: 60_000,
    ...limits
  };
  if (
    !Object.values(result).every((value) => Number.isSafeInteger(value) && value > 0) ||
    result.maxInputTokens + result.maxOutputTokens > 272_000 ||
    result.maxOutputTokens < 16 ||
    result.maxOutputTokens > 128_000 ||
    result.timeoutMs > 300_000
  ) {
    throw new AiServiceError(
      "not-configured",
      "AI request limits are invalid or exceed the verified short-context price range."
    );
  }
  return result;
}

export async function runBudgetedAiRequest(input: {
  budget?: AiUsageBudget;
  workspaceId: string;
  workflow: unknown;
  capability: string;
  model: string;
  instructions: string;
  input: string;
  schema: Record<string, unknown>;
  limits: AiRequestLimits;
  /** Fresh disclosure proof after durable reservation, before any provider dispatch. */
  beforeInvoke?: (signal: AbortSignal) => Promise<void>;
  invoke: (signal: AbortSignal) => Promise<AiResponse>;
}): Promise<AiResponse> {
  // The text tokenizer cannot have more tokens than UTF-8 bytes. Include the
  // instructions, schema and a conservative framing allowance, not chars / 4.
  const inputTokenUpperBound =
    Buffer.byteLength(input.instructions, "utf8") +
    Buffer.byteLength(input.input, "utf8") +
    Buffer.byteLength(JSON.stringify(input.schema), "utf8") +
    1024;
  if (inputTokenUpperBound > input.limits.maxInputTokens) {
    throw new AiServiceError(
      "request-too-large",
      "This AI request is too large; narrow the source or question before retrying.",
      { requestDispatched: false }
    );
  }
  const reservation = await input.budget
    ?.reserve({
      workspaceId: input.workspaceId,
      workflowId: createHash("sha256")
        .update(JSON.stringify(input.workflow))
        .digest("hex"),
      capability: input.capability,
      model: input.model,
      inputTokenUpperBound,
      maxOutputTokens: input.limits.maxOutputTokens,
      timeoutMs: input.limits.timeoutMs
    })
    .catch((error: unknown) => {
      const safe = normalizeAiServiceError(error);
      throw new AiServiceError(safe.code, safe.message, {
        ...safe,
        requestDispatched: false
      });
    });
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let dispatched = false;
  try {
    // Race admission and the provider read. A late admission cannot dispatch,
    // and accounting stays inside this request's owned lifetime: a late provider
    // response cannot write into a closed store. Its held charge needs reconciliation.
    const response = await Promise.race([
      (async () => {
        await input.beforeInvoke?.(controller.signal);
        if (controller.signal.aborted)
          throw new AiServiceError(
            "timeout",
            "The AI request timed out before dispatch.",
            { requestDispatched: false }
          );
        dispatched = true;
        return input.invoke(controller.signal);
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(
            new AiServiceError(
              "timeout",
              dispatched
                ? "The AI request timed out. Its possible charge remains reserved."
                : "The current source could not be verified before the AI admission deadline. No request was dispatched."
            )
          );
        }, input.limits.timeoutMs);
      })
    ]);
    clearTimeout(timeout);
    timeout = undefined;
    if (reservation && input.budget) {
      await input.budget.recordResponseFacts(reservation.reservationId, {
        ...(response.providerResponseId
          ? { providerResponseId: response.providerResponseId }
          : {}),
        ...(response.providerRequestId
          ? { providerRequestId: response.providerRequestId }
          : {}),
        ...(response.model ? { returnedModel: response.model } : {}),
        ...(response.serviceTier ? { serviceTier: response.serviceTier } : {}),
        ...(response.status ? { responseStatus: response.status } : {}),
        ...(response.incompleteReason
          ? { incompleteReason: response.incompleteReason }
          : {}),
        ...(response.usage ? { reportedUsage: response.usage } : {})
      });
      const known = response.model === input.model && response.serviceTier === "default";
      if (!known) {
        await input.budget.markUnknown(reservation.reservationId, {
          blockWorkspace: true
        });
        throw new AiServiceError(
          "not-configured",
          "The AI provider returned an unverified model or pricing tier; accounting needs reconciliation."
        );
      }
      // Settle before parsing application output, even when output is invalid.
      await input.budget.settle(
        reservation.reservationId,
        known ? response.usage : undefined
      );
    }
    if (
      (input.budget || response.status !== undefined) &&
      response.status !== "completed"
    ) {
      if (
        response.status === "incomplete" &&
        response.incompleteReason === "max_output_tokens"
      ) {
        throw new AiServiceError(
          "request-too-large",
          "The AI answer reached its output limit. Narrow the question or source before retrying; reported usage has been accounted for."
        );
      }
      throw new AiServiceError(
        "unavailable",
        "The AI provider did not complete its answer. Reported usage has still been accounted for."
      );
    }
    return response;
  } catch (error) {
    const safe = normalizeAiServiceError(error);
    if (reservation && input.budget) {
      const requestId =
        error && typeof error === "object" && "request_id" in error
          ? error.request_id
          : undefined;
      await input.budget.recordResponseFacts(reservation.reservationId, {
        failureCode: safe.code,
        ...(typeof requestId === "string" ? { providerRequestId: requestId } : {})
      });
      if (dispatched) await input.budget.markUnknown(reservation.reservationId);
      else
        await input.budget.settle(reservation.reservationId, {
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0
        });
    }
    throw new AiServiceError(safe.code, safe.message, {
      ...safe,
      requestDispatched: dispatched
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function normalizeAiServiceError(error: unknown): AiServiceError {
  if (error instanceof AiServiceError) return error;
  const record =
    error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const status = record["status"];
  const code = record["code"];
  const nested = record["error"];
  const nestedCode =
    nested && typeof nested === "object"
      ? (nested as Record<string, unknown>)["code"]
      : undefined;
  if (
    [code, nestedCode].some(
      (value) =>
        value === "insufficient_quota" ||
        value === "billing_hard_limit_reached" ||
        value === "usage_limit_reached" ||
        value === "organization_spend_limit_exceeded" ||
        value === "project_spend_limit_exceeded" ||
        value === "organization_usage_limit_exceeded" ||
        value === "credit_balance_exhausted"
    )
  ) {
    return new AiServiceError(
      "provider-quota",
      "The AI provider's quota or spending limit has been reached."
    );
  }
  if (status === 429) {
    const headers = record["headers"];
    const retry = headers instanceof Headers ? headers.get("retry-after") : undefined;
    const seconds = retry === null || retry === undefined ? NaN : Number(retry);
    return new AiServiceError(
      "rate-limited",
      "The AI provider is temporarily rate limiting requests.",
      Number.isFinite(seconds) && seconds >= 0
        ? { retryAfterSeconds: Math.ceil(seconds) }
        : {}
    );
  }
  if (record["name"] === "APIConnectionTimeoutError" || record["name"] === "AbortError") {
    return new AiServiceError(
      "timeout",
      "The AI request timed out. Its possible charge remains reserved."
    );
  }
  if (status === 401 || status === 403)
    return new AiServiceError(
      "not-configured",
      "The AI provider credentials or access need configuration."
    );
  return new AiServiceError(
    "unavailable",
    "The AI provider is unavailable. The request's possible charge remains reserved."
  );
}

/** Normalize only complete usage; malformed details are not silently filled with zero. */
export function normalizedOpenAiUsage(value: unknown): AiTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const inputs = raw["input_tokens_details"];
  const outputs = raw["output_tokens_details"];
  if (!inputs || typeof inputs !== "object" || !outputs || typeof outputs !== "object")
    return undefined;
  const inDetails = inputs as Record<string, unknown>;
  const outDetails = outputs as Record<string, unknown>;
  const values = [
    raw["input_tokens"],
    inDetails["cached_tokens"],
    inDetails["cache_write_tokens"],
    raw["output_tokens"],
    outDetails["reasoning_tokens"]
  ];
  if (
    !values.every(
      (item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0
    )
  )
    return undefined;
  const [
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens
  ] = values as [number, number, number, number, number];
  if (
    cachedInputTokens + cacheWriteTokens > inputTokens ||
    reasoningTokens > outputTokens ||
    raw["total_tokens"] !== inputTokens + outputTokens
  )
    return undefined;
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens
  };
}
