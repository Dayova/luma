export type AiServiceErrorCode =
  | "budget-exhausted"
  | "provider-quota"
  | "rate-limited"
  | "timeout"
  | "unavailable"
  | "not-configured"
  | "request-too-large"
  | "request-indeterminate";

/** Safe operational failure; provider payloads and source content stay private. */
export class AiServiceError extends Error {
  readonly resetAt?: string;
  readonly retryAfterSeconds?: number;
  readonly limitScope?: "month" | "day" | "workflow";

  constructor(
    readonly code: AiServiceErrorCode,
    message: string,
    details: {
      resetAt?: string;
      retryAfterSeconds?: number;
      limitScope?: "month" | "day" | "workflow";
    } = {}
  ) {
    super(message);
    this.name = "AiServiceError";
    if (details.resetAt !== undefined) this.resetAt = details.resetAt;
    if (details.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = details.retryAfterSeconds;
    }
    if (details.limitScope !== undefined) this.limitScope = details.limitScope;
  }
}
