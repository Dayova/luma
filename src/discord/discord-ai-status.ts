import { AiServiceError } from "../ai/ai-service-error.js";
import type { MeetingIntelligenceError } from "../domain/model.js";
import type { AiUsageStatus } from "../ai/ai-usage-budget.js";

/** Fixed operational copy never includes provider exceptions or source content. */
export function renderAiServiceFailure(error: unknown): string {
  if (!(error instanceof AiServiceError)) {
    return "Luma could not answer this request right now. Please try again later. You can check /meeting usage without an AI call.";
  }
  switch (error.code) {
    case "budget-exhausted": {
      if (error.limitScope === "workflow") {
        return "This request reached Luma's workflow cost or attempt limit, so no new AI call was made. Please ask a narrower question or have a founder review the pending workflow. /meeting usage remains available.";
      }
      const scope = error.limitScope === "day" ? "daily safety" : "shared AI";
      return `Luma's ${scope} budget cannot cover this request, so no new AI call was made.${error.resetAt ? ` This budget resets ${formatReset(error.resetAt, error.timezone ?? "UTC")}.` : ""} Check /meeting usage; a founder can review the provisional limit.`;
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
      return "Luma's AI provider is temporarily unavailable. Please try again later. /meeting usage remains available.";
    case "not-configured":
      return "Luma's AI provider or pricing is not configured for safe paid use. A founder needs to check the configuration. /meeting usage remains available.";
    case "request-too-large":
      return "This request exceeds Luma's safe AI request limit. Please ask a narrower question or use a shorter evidence window. /meeting usage remains available.";
    case "request-indeterminate":
      return "Luma cannot yet confirm the outcome or cost of this AI request. It has not started a duplicate paid request. A founder can check /meeting usage and reconcile the pending request.";
  }
}

export function renderAiUsageStatus(status: AiUsageStatus): string {
  const lines = [
    `Luma AI usage — ${status.month} (${status.timezone})`,
    `Estimated spend: ${usd(status.spentUsd)} / ${usd(status.monthlyLimitUsd)} shared monthly cap`,
    `Reserved for active requests: ${usd(status.reservedUsd)}`,
    `Unconfirmed cost held against the cap: ${usd(status.unknownUsd)}`,
    `Requests tracked: ${status.requestCount}`,
    `${status.limitScope === "day" ? "Daily cap" : "Monthly cap"} resets: ${formatReset(status.resetAt, status.timezone)}`
  ];
  if (status.dailyLimitUsd !== undefined) {
    lines.push(
      `Daily safety cap: ${usd(status.dailyLimitUsd)}; estimated spend ${usd(status.dailySpentUsd ?? 0)}, held ${usd((status.dailyReservedUsd ?? 0) + (status.dailyUnknownUsd ?? 0))}`
    );
    if (status.dailyResetAt && status.limitScope !== "day") {
      lines.push(
        `Daily cap resets: ${formatReset(status.dailyResetAt, status.timezone)}`
      );
    }
  }
  const grouped = new Map<
    string,
    { spentUsd: number; heldUsd: number; requestCount: number }
  >();
  for (const usage of status.byCapability) {
    const label = capabilityLabel(usage.capability);
    const existing = grouped.get(label) ?? { spentUsd: 0, heldUsd: 0, requestCount: 0 };
    existing.spentUsd += usage.spentUsd;
    existing.heldUsd += usage.reservedUsd + usage.unknownUsd;
    existing.requestCount += usage.requestCount;
    grouped.set(label, existing);
  }
  if (grouped.size > 0) {
    lines.push("Estimated by use:");
    for (const [label, usage] of grouped) {
      lines.push(
        `- ${label}: ${usd(usage.spentUsd)}; ${usage.requestCount} requests; held ${usd(usage.heldUsd)}`
      );
    }
  }
  if (status.accountingBlocked) {
    lines.push(
      "Paid AI is paused for accounting review. An authorized operator must use Luma's stopped-store accounting recovery workflow to reconcile provider billing evidence and explicitly review resuming AI. Restarting or changing the cap does not clear this hold."
    );
  } else if (!status.configured || status.status === "not-configured") {
    lines.push(
      "Paid AI is not configured. A founder needs to check provider and pricing configuration."
    );
  }
  const warning = renderAiUsageWarning(status);
  if (warning) lines.push(warning);
  lines.push(
    "The configured monthly limit is provisional. Estimates cover Luma's tracked AI calls; provider billing is authoritative. No AI call was used for this status."
  );
  return lines.join("\n");
}

export function renderAiUsageWarning(status: AiUsageStatus): string | undefined {
  if (status.status === "exhausted") {
    return `${status.limitScope === "day" ? "Daily AI safety cap" : "AI budget"} reached: new paid requests are paused. Check /meeting usage; saved evidence and budget status remain available.`;
  }
  if (status.status === "critical") {
    return "AI budget warning: at least 90% of the shared cap is spent or held. Check /meeting usage.";
  }
  if (status.status === "warning") {
    return "AI budget warning: at least 80% of the shared cap is spent or held. Check /meeting usage.";
  }
  return undefined;
}

function usd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function formatReset(value: string, timezone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "at the next configured budget window";
  return `${new Intl.DateTimeFormat("en-GB", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(date)} (${timezone})`;
}

export function renderDeferredAnalysis(errors: MeetingIntelligenceError[]): string {
  for (const error of errors) {
    let code: ConstructorParameters<typeof AiServiceError>[0];
    switch (error.code) {
      case "analysis-budget-exhausted":
        code = "budget-exhausted";
        break;
      case "analysis-provider-quota":
        code = "provider-quota";
        break;
      case "analysis-rate-limited":
        code = "rate-limited";
        break;
      case "analysis-timeout":
        code = "timeout";
        break;
      case "analysis-unavailable":
        code = "unavailable";
        break;
      case "analysis-not-configured":
        code = "not-configured";
        break;
      case "analysis-request-too-large":
        code = "request-too-large";
        break;
      case "analysis-request-indeterminate":
        code = "request-indeterminate";
        break;
      default:
        continue;
    }
    return `Note saved; the original evidence is safe. AI analysis is deferred. ${renderAiServiceFailure(
      new AiServiceError(code, "Analysis deferred", {
        ...(error.resetAt ? { resetAt: error.resetAt } : {}),
        ...(error.timezone ? { timezone: error.timezone } : {}),
        ...(error.limitScope ? { limitScope: error.limitScope } : {}),
        ...(error.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {})
      })
    )} You do not need to submit this note again.`;
  }
  return "Note saved. Analysis is temporarily deferred; the original evidence is safe. You do not need to submit this note again.";
}

function capabilityLabel(capability: string): string {
  switch (capability) {
    case "meeting-understand-discussion":
      return "Meeting analysis";
    case "meeting-answer-question":
      return "Meeting Ask";
    case "meeting-prepare-conclusion":
      return "Meeting conclusion";
    case "meeting-prepare-follow-up":
      return "Follow-up preparation";
    case "context-ask":
      return "Context Ask";
    case "decision-interpretation":
      return "Decision interpretation";
    default:
      return "Other tracked AI";
  }
}
