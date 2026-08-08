import type {
  ContextEvidence,
  ContextInquiryResult
} from "../context-intelligence/interface.js";

export const DEFAULT_DISCORD_CONTEXT_ASK_MAX_MESSAGES = 50;
export const MAX_DISCORD_CONTEXT_ASK_MESSAGES = 500;
export const DEFAULT_DISCORD_CONTEXT_ASK_MAX_EVIDENCE_CHARS = 32_000;
export const MAX_DISCORD_CONTEXT_ASK_EVIDENCE_CHARS = 64_000;
export const MIN_DISCORD_CONTEXT_ASK_MIN_INTERVAL_MS = 1_000;
export const DEFAULT_DISCORD_CONTEXT_ASK_MIN_INTERVAL_MS = 60_000;
export const MAX_DISCORD_CONTEXT_ASK_MIN_INTERVAL_MS = 3_600_000;

const DISCORD_CONTEXT_ASK_SAFE_RESPONSE_MAX_LENGTH = 1_500;

/**
 * Explicit opt-in scope for Discord conversation Ask. The adapter enforces it
 * before it reads a thread or sends its content to Context Intelligence.
 */
export type DiscordContextAskConfig = {
  parentChannelIds: readonly string[];
  allowedDiscordUserIds: readonly string[];
  maxMessages: number;
  maxEvidenceChars: number;
  minIntervalMs: number;
};

export type DiscordContextAskMention = {
  messageId: string;
  guildId: string;
  /** The Discord thread that supplies the bounded conversation evidence. */
  channelId: string;
  parentChannelId: string;
  actorDiscordUserId: string;
  question: string;
  occurredAt: string;
};

export type DiscordContextAskMessageCandidate = {
  messageId: string;
  guildId: string | null;
  channelId: string;
  parentChannelId: string | null;
  channelKind: "public-thread" | "other";
  authorKind: "human" | "bot" | "webhook" | "system";
  actorDiscordUserId: string;
  mentionedDiscordUserIds: readonly string[];
  content: string;
  occurredAt: string;
};

export class DiscordContextAskConfigError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "DiscordContextAskConfigError";
  }
}

/**
 * Returns no configuration unless the feature was deliberately enabled. A
 * malformed attempted enablement is an error, never a silent broad fallback.
 */
export function discordContextAskConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): DiscordContextAskConfig | undefined {
  const enabled = env["LUMA_DISCORD_CONTEXT_ASK_ENABLED"]?.trim();

  if (!enabled || enabled === "0") {
    return undefined;
  }

  if (enabled !== "1") {
    throw new DiscordContextAskConfigError(
      "discord-context-ask-enable-invalid",
      "LUMA_DISCORD_CONTEXT_ASK_ENABLED must be 0 or 1"
    );
  }

  const configuredParentChannelIds = env["LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS"];
  const parentChannelIds = configuredParentChannelIds
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (!parentChannelIds || parentChannelIds.length === 0) {
    throw new DiscordContextAskConfigError(
      "discord-context-ask-parent-channels-missing",
      "LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS must list one or more parent channels when Context Ask is enabled"
    );
  }

  if (new Set(parentChannelIds).size !== parentChannelIds.length) {
    throw new DiscordContextAskConfigError(
      "discord-context-ask-parent-channels-duplicate",
      "LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS must not contain duplicate channel IDs"
    );
  }

  const configuredAllowedDiscordUserIds =
    env["LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS"];
  const allowedDiscordUserIds = configuredAllowedDiscordUserIds
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (!allowedDiscordUserIds || allowedDiscordUserIds.length === 0) {
    throw new DiscordContextAskConfigError(
      "discord-context-ask-users-missing",
      "LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS must list one or more Discord users when Context Ask is enabled"
    );
  }

  if (new Set(allowedDiscordUserIds).size !== allowedDiscordUserIds.length) {
    throw new DiscordContextAskConfigError(
      "discord-context-ask-users-duplicate",
      "LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS must not contain duplicate Discord user IDs"
    );
  }

  const configuredMaxMessages = env["LUMA_DISCORD_CONTEXT_ASK_MAX_MESSAGES"]?.trim();
  const maxMessages = configuredMaxMessages
    ? Number(configuredMaxMessages)
    : DEFAULT_DISCORD_CONTEXT_ASK_MAX_MESSAGES;

  if (
    !Number.isSafeInteger(maxMessages) ||
    maxMessages <= 0 ||
    maxMessages > MAX_DISCORD_CONTEXT_ASK_MESSAGES
  ) {
    throw new DiscordContextAskConfigError(
      "discord-context-ask-max-messages-invalid",
      `LUMA_DISCORD_CONTEXT_ASK_MAX_MESSAGES must be an integer from 1 to ${MAX_DISCORD_CONTEXT_ASK_MESSAGES}`
    );
  }

  const configuredMaxEvidenceChars =
    env["LUMA_DISCORD_CONTEXT_ASK_MAX_EVIDENCE_CHARS"]?.trim();
  const maxEvidenceChars = configuredMaxEvidenceChars
    ? Number(configuredMaxEvidenceChars)
    : DEFAULT_DISCORD_CONTEXT_ASK_MAX_EVIDENCE_CHARS;

  if (
    !Number.isSafeInteger(maxEvidenceChars) ||
    maxEvidenceChars < 2_000 ||
    maxEvidenceChars > MAX_DISCORD_CONTEXT_ASK_EVIDENCE_CHARS
  ) {
    throw new DiscordContextAskConfigError(
      "discord-context-ask-max-evidence-chars-invalid",
      `LUMA_DISCORD_CONTEXT_ASK_MAX_EVIDENCE_CHARS must be an integer from 2000 to ${MAX_DISCORD_CONTEXT_ASK_EVIDENCE_CHARS}`
    );
  }

  const configuredMinIntervalMs = env["LUMA_DISCORD_CONTEXT_ASK_MIN_INTERVAL_MS"]?.trim();
  const minIntervalMs = configuredMinIntervalMs
    ? Number(configuredMinIntervalMs)
    : DEFAULT_DISCORD_CONTEXT_ASK_MIN_INTERVAL_MS;

  if (
    !Number.isSafeInteger(minIntervalMs) ||
    minIntervalMs < MIN_DISCORD_CONTEXT_ASK_MIN_INTERVAL_MS ||
    minIntervalMs > MAX_DISCORD_CONTEXT_ASK_MIN_INTERVAL_MS
  ) {
    throw new DiscordContextAskConfigError(
      "discord-context-ask-min-interval-invalid",
      `LUMA_DISCORD_CONTEXT_ASK_MIN_INTERVAL_MS must be an integer from ${MIN_DISCORD_CONTEXT_ASK_MIN_INTERVAL_MS} to ${MAX_DISCORD_CONTEXT_ASK_MIN_INTERVAL_MS}`
    );
  }

  return {
    parentChannelIds,
    allowedDiscordUserIds,
    maxMessages,
    maxEvidenceChars,
    minIntervalMs
  };
}

/**
 * Converts a safely narrowed Discord message to an Ask trigger. Everything
 * outside the explicit guild/thread/mention scope is ignored without reading
 * conversation history.
 */
export function discordContextAskMentionFromCandidate(input: {
  candidate: DiscordContextAskMessageCandidate;
  botUserId: string;
  guildId: string;
  config: DiscordContextAskConfig;
}): DiscordContextAskMention | null {
  const { candidate } = input;

  if (
    candidate.guildId !== input.guildId ||
    candidate.channelKind !== "public-thread" ||
    candidate.authorKind !== "human" ||
    !candidate.parentChannelId ||
    !input.config.parentChannelIds.includes(candidate.parentChannelId) ||
    !input.config.allowedDiscordUserIds.includes(candidate.actorDiscordUserId) ||
    !candidate.mentionedDiscordUserIds.includes(input.botUserId)
  ) {
    return null;
  }

  const question = questionAfterLeadingDiscordBotMention(
    candidate.content,
    input.botUserId
  );

  if (!question) {
    return null;
  }

  return {
    messageId: candidate.messageId,
    guildId: input.guildId,
    channelId: candidate.channelId,
    parentChannelId: candidate.parentChannelId,
    actorDiscordUserId: candidate.actorDiscordUserId,
    question,
    occurredAt: candidate.occurredAt
  };
}

/** Returns null unless content starts with this exact bot mention. */
export function questionAfterLeadingDiscordBotMention(
  content: string,
  botUserId: string
): string | null {
  const leadingMention = new RegExp(
    `^\\s*<@!?${escapeRegularExpression(botUserId)}>\\s*`
  );

  if (!leadingMention.test(content)) {
    return null;
  }

  const question = content.replace(leadingMention, "").trim();

  return question.length > 0 ? question : null;
}

/**
 * In-memory admission control for one-process Discord runtime deployments.
 * Core inquiry idempotency still prevents duplicate capture and model work
 * when Discord repeats the same Gateway event.
 */
export function createDiscordContextAskRateLimiter(config: {
  minIntervalMs: number;
  now?: () => number;
}): {
  tryAcquire(
    input: Pick<DiscordContextAskMention, "channelId" | "actorDiscordUserId">
  ): boolean;
} {
  if (
    !Number.isSafeInteger(config.minIntervalMs) ||
    config.minIntervalMs < MIN_DISCORD_CONTEXT_ASK_MIN_INTERVAL_MS ||
    config.minIntervalMs > MAX_DISCORD_CONTEXT_ASK_MIN_INTERVAL_MS
  ) {
    throw new DiscordContextAskConfigError(
      "discord-context-ask-min-interval-invalid",
      `Discord Context Ask requires an interval from ${MIN_DISCORD_CONTEXT_ASK_MIN_INTERVAL_MS} to ${MAX_DISCORD_CONTEXT_ASK_MIN_INTERVAL_MS} milliseconds`
    );
  }

  const now = config.now ?? Date.now;
  const nextAllowedAtByActorThread = new Map<string, number>();

  return {
    tryAcquire(input) {
      const key = `${input.channelId}:${input.actorDiscordUserId}`;
      const currentTime = now();
      const nextAllowedAt = nextAllowedAtByActorThread.get(key) ?? 0;

      if (currentTime < nextAllowedAt) {
        return false;
      }

      nextAllowedAtByActorThread.set(key, currentTime + config.minIntervalMs);
      return true;
    }
  };
}

/**
 * Discord replies contain only escaped model prose and citations derived from
 * captured Discord URLs. A too-long answer is not truncated into a claim.
 */
export function renderDiscordContextAskResult(result: ContextInquiryResult): string {
  const citations = uniqueAvailableDiscordEvidence(result.answer.evidence);
  const lines = ["Luma Ask", "", escapeDiscordPlainText(result.answer.text)];

  if (citations.length > 0) {
    lines.push("", "Evidence:");
    lines.push(
      ...citations.map(
        (evidence) =>
          `- ${escapeDiscordPlainText(evidence.author.displayName)}: <${evidence.url}>`
      )
    );
  }

  if (result.uncertainty !== "none") {
    lines.push("", `Uncertainty: ${result.uncertainty}`);
  }

  if (result.warnings.length > 0) {
    lines.push("", "Limitations:");
    lines.push(
      ...result.warnings.map((warning) => `- ${escapeDiscordPlainText(warning.message)}`)
    );
  }

  if (result.unresolved.length > 0) {
    lines.push("", "Unresolved:");
    lines.push(...result.unresolved.map((item) => `- ${escapeDiscordPlainText(item)}`));
  }

  const rendered = lines.join("\n");

  return rendered.length <= DISCORD_CONTEXT_ASK_SAFE_RESPONSE_MAX_LENGTH
    ? rendered
    : "Luma's grounded answer is too long for a safe Discord reply. Please ask a narrower question.";
}

function uniqueAvailableDiscordEvidence(evidence: ContextEvidence[]): ContextEvidence[] {
  const byMessageId = new Map<string, ContextEvidence>();

  for (const item of evidence) {
    if (
      item.state === "available" &&
      isDiscordMessageUrl(item.url) &&
      !byMessageId.has(item.messageId)
    ) {
      byMessageId.set(item.messageId, item);
    }
  }

  return [...byMessageId.values()];
}

function isDiscordMessageUrl(value: string): boolean {
  return /^https:\/\/discord(?:app)?\.com\/channels\/\d+\/\d+\/\d+$/u.test(value);
}

function escapeDiscordPlainText(value: string): string {
  return value
    .replace(/https?:\/\/\S+/giu, (url) => url.replace("://", ":\u200b//"))
    .replace(/\\/gu, "\\\\")
    .replace(/([`*_~|>#\u005b\u005d()<>{}])/gu, "\\$1")
    .replace(/@/gu, "@\u200b");
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
