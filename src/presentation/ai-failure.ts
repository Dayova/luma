import { AiServiceError } from "../ai/ai-service-error.js";

/** Fixed operational copy never includes provider exceptions or source content. */
export function renderAiServiceFailure(error: unknown): string {
  if (!(error instanceof AiServiceError)) {
    return "Luma could not complete this request, and the cause has not been confirmed. Check the saved result and /meeting usage before retrying; an earlier AI call or action may have completed.";
  }
  switch (error.code) {
    case "budget-exhausted": {
      if (error.limitScope === "workflow") {
        return "This request reached Luma's workflow cost or attempt limit, so no new AI call was made. Check the pending workflow and its usage before starting another request; earlier attempts may already have incurred costs. /meeting usage remains available.";
      }
      const scope = error.limitScope === "day" ? "daily safety" : "shared AI";
      return `Luma's ${scope} budget cannot cover this request, so no new AI call was made.${error.resetAt ? ` This budget resets ${formatAiBudgetReset(error.resetAt, error.timezone ?? "UTC")}.` : ""} Check /meeting usage; a founder can review the provisional limit.`;
    }
    case "provider-quota":
      return "Luma's AI provider has reached a billing or quota limit. A founder needs to check the provider account; the monthly Luma budget reset may not resolve it. /meeting usage remains available.";
    case "rate-limited": {
      const retry = error.retryAfterSeconds;
      return `Luma's AI provider is temporarily rate limited. ${retry && Number.isFinite(retry) && retry > 0 ? `Try again in ${Math.ceil(retry)} seconds.` : "Please try again shortly."} /meeting usage remains available.`;
    }
    case "timeout":
      return "Luma's AI request timed out, so no answer is available. Its cost may still be pending; check /meeting usage before retrying.";
    case "unavailable":
      return "Luma's AI workflow failed, but the available error does not establish the cause. Check /meeting usage for a pending charge before retrying. A founder should inspect the diagnostics if it persists.";
    case "not-configured":
      return "Luma could not proceed with its AI setup or access. A founder should check the key, model access, pricing configuration and any accounting hold shown by /meeting usage. For local testing, review the connection on Luma's local page before restarting the bot.";
    case "request-too-large":
      return "Luma could not fit or verify the complete input within its AI request limit. This includes retrieved evidence, not just your question. A shorter evidence window may help; if a short question still fails, a founder needs to review Luma's context limits. /meeting usage remains available.";
    case "request-indeterminate":
      return "Luma cannot yet confirm the outcome or cost of this AI request. It has not started a duplicate paid request. A founder can check /meeting usage and reconcile the pending request.";
  }
}

export function formatAiBudgetReset(value: string, timezone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "at the next configured budget window";
  return `${new Intl.DateTimeFormat("en-GB", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(date)} (${timezone})`;
}
