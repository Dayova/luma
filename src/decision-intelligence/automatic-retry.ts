import { z } from "zod";
import { AiServiceError } from "../ai/ai-service-error.js";
import { nextBoundary } from "../ai/ai-usage-budget.js";
import type { AutomaticDecisionBatch } from "../domain/automatic-decisions.js";

export const automaticDetectionAttemptLimit = 3;
const attemptsSchema = z
  .array(
    z
      .object({
        observationId: z.string().min(1).max(512),
        startedAt: z.string().datetime(),
        disposition: z.enum(["not-dispatched", "unknown", "completed"]),
        retryAt: z.string().datetime().nullable(),
        failureCode: z.string().min(1).max(64).optional()
      })
      .strict()
  )
  .min(1)
  .max(automaticDetectionAttemptLimit);
export type AutomaticDetectionAttempt = z.infer<typeof attemptsSchema>[number];

export function automaticRetryState(
  attempts: AutomaticDetectionAttempt[] | undefined
): AutomaticDecisionBatch["analysisRetry"] {
  if (!attempts) return undefined; // Legacy and interrupted history never proves zero dispatch.
  attempts = attemptsSchema.parse(attempts);
  const latest = attempts.at(-1)!;
  const canRetry =
    latest.disposition === "not-dispatched" &&
    attempts.length < automaticDetectionAttemptLimit;
  return {
    disposition: latest.disposition,
    lastObservationId: latest.observationId,
    attempts: attempts.length,
    maxAttempts: automaticDetectionAttemptLimit,
    canRetry,
    nextAttemptAt: canRetry ? latest.retryAt : null
  };
}

export function failedAutomaticAttempt(
  attempt: AutomaticDetectionAttempt,
  error: unknown,
  now: Date,
  timezone: string,
  attemptCount: number
): AutomaticDetectionAttempt {
  if (!(error instanceof AiServiceError) || error.requestDispatched !== false)
    return { ...attempt, disposition: "unknown", retryAt: null };
  const minimum = now.getTime() + Math.min(3_600_000, 60_000 * 2 ** (attemptCount - 1));
  const budgetReset =
    error.code === "budget-exhausted"
      ? Number.isFinite(Date.parse(error.resetAt ?? ""))
        ? Date.parse(error.resetAt!)
        : Date.parse(
            nextBoundary(
              now,
              error.timezone ?? timezone,
              error.limitScope === "day" ? "day" : "month"
            )
          )
      : 0;
  const retryAfter =
    Number.isFinite(error.retryAfterSeconds) && (error.retryAfterSeconds ?? 0) > 0
      ? now.getTime() + error.retryAfterSeconds! * 1000
      : 0;
  return {
    ...attempt,
    disposition: "not-dispatched",
    retryAt: new Date(Math.max(minimum, budgetReset, retryAfter)).toISOString(),
    failureCode: error.code
  };
}
