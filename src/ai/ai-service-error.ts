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
  readonly timezone?: string;
  readonly retryAfterSeconds?: number;
  readonly limitScope?: "month" | "day" | "workflow";
  /** Explicit adapter proof; absence means the dispatch outcome is unknown. */
  readonly requestDispatched?: boolean;

  constructor(
    readonly code: AiServiceErrorCode,
    message: string,
    details: {
      resetAt?: string;
      timezone?: string;
      retryAfterSeconds?: number;
      limitScope?: "month" | "day" | "workflow";
      requestDispatched?: boolean;
    } = {}
  ) {
    super(message);
    this.name = "AiServiceError";
    if (details.resetAt !== undefined) this.resetAt = details.resetAt;
    if (details.timezone !== undefined) this.timezone = details.timezone;
    if (details.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = details.retryAfterSeconds;
    }
    if (details.limitScope !== undefined) this.limitScope = details.limitScope;
    if (details.requestDispatched !== undefined)
      this.requestDispatched = details.requestDispatched;
  }
}
