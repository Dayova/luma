import { describe, expect, it } from "vitest";
import { GatewayIntentBits } from "discord.js";
import { discordGatewayIntentsForContextAsk } from "../../src/discord/discord-js-adapter.js";
import {
  createDiscordContextAskRateLimiter,
  discordContextAskConfigFromEnv,
  discordContextAskMentionFromCandidate,
  renderDiscordContextAskResult,
  type DiscordContextAskConfig
} from "../../src/discord/discord-context-ask-runtime.js";
import type { ContextInquiryResult } from "../../src/context-intelligence/interface.js";

const contextAskConfig: DiscordContextAskConfig = {
  parentChannelIds: ["channel_context"],
  allowedDiscordUserIds: ["user_jakob"],
  maxMessages: 50,
  maxEvidenceChars: 32_000,
  minIntervalMs: 60_000
};

describe("Discord Context Ask runtime boundary", () => {
  it("remains disabled without an explicit enable flag and preserves the Guilds-only intent", () => {
    expect(discordContextAskConfigFromEnv({})).toBeUndefined();
    expect(discordGatewayIntentsForContextAsk(undefined)).toEqual([
      GatewayIntentBits.Guilds
    ]);
  });

  it("requires a bounded reviewed scope when Context Ask is enabled", () => {
    expect(() =>
      discordContextAskConfigFromEnv({
        LUMA_DISCORD_CONTEXT_ASK_ENABLED: "1"
      })
    ).toThrow("PARENT_CHANNEL_IDS");
    expect(() =>
      discordContextAskConfigFromEnv({
        LUMA_DISCORD_CONTEXT_ASK_ENABLED: "1",
        LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS: "channel_context",
        LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS: "user_jakob",
        LUMA_DISCORD_CONTEXT_ASK_MAX_EVIDENCE_CHARS: "1999"
      })
    ).toThrow("MAX_EVIDENCE_CHARS");
    expect(() =>
      discordContextAskConfigFromEnv({
        LUMA_DISCORD_CONTEXT_ASK_ENABLED: "1",
        LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS: "channel_context",
        LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS: "user_jakob",
        LUMA_DISCORD_CONTEXT_ASK_MIN_INTERVAL_MS: "0"
      })
    ).toThrow("MIN_INTERVAL");

    expect(
      discordContextAskConfigFromEnv({
        LUMA_DISCORD_CONTEXT_ASK_ENABLED: "1",
        LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS: "channel_context,channel_product",
        LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS: "user_jakob,user_fabius",
        LUMA_DISCORD_CONTEXT_ASK_MAX_MESSAGES: "25",
        LUMA_DISCORD_CONTEXT_ASK_MAX_EVIDENCE_CHARS: "24000",
        LUMA_DISCORD_CONTEXT_ASK_MIN_INTERVAL_MS: "30000"
      })
    ).toEqual({
      parentChannelIds: ["channel_context", "channel_product"],
      allowedDiscordUserIds: ["user_jakob", "user_fabius"],
      maxMessages: 25,
      maxEvidenceChars: 24_000,
      minIntervalMs: 30_000
    });
    expect(discordGatewayIntentsForContextAsk(contextAskConfig)).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]);
  });

  it("admits only an allowlisted human's leading mention in an allowlisted public thread", () => {
    const accepted = discordContextAskMentionFromCandidate({
      candidate: {
        messageId: "message_ask",
        guildId: "guild_dayova",
        channelId: "thread_context",
        parentChannelId: "channel_context",
        channelKind: "public-thread",
        authorKind: "human",
        actorDiscordUserId: "user_jakob",
        mentionedDiscordUserIds: ["bot_luma"],
        content: " <@!bot_luma> What did we decide?",
        occurredAt: "2026-08-08T10:00:00.000Z"
      },
      botUserId: "bot_luma",
      guildId: "guild_dayova",
      config: contextAskConfig
    });

    expect(accepted).toEqual({
      messageId: "message_ask",
      guildId: "guild_dayova",
      channelId: "thread_context",
      parentChannelId: "channel_context",
      actorDiscordUserId: "user_jakob",
      question: "What did we decide?",
      occurredAt: "2026-08-08T10:00:00.000Z"
    });

    for (const candidate of [
      { authorKind: "bot" as const },
      { authorKind: "webhook" as const },
      { channelKind: "other" as const },
      { parentChannelId: "channel_elsewhere" },
      { actorDiscordUserId: "user_unknown" },
      { mentionedDiscordUserIds: [] },
      { content: "Please ask <@bot_luma> about this" },
      { content: "<@bot_luma>" }
    ]) {
      expect(
        discordContextAskMentionFromCandidate({
          candidate: {
            messageId: "message_ask",
            guildId: "guild_dayova",
            channelId: "thread_context",
            parentChannelId: "channel_context",
            channelKind: "public-thread",
            authorKind: "human",
            actorDiscordUserId: "user_jakob",
            mentionedDiscordUserIds: ["bot_luma"],
            content: "<@bot_luma> What did we decide?",
            occurredAt: "2026-08-08T10:00:00.000Z",
            ...candidate
          },
          botUserId: "bot_luma",
          guildId: "guild_dayova",
          config: contextAskConfig
        })
      ).toBeNull();
    }
  });

  it("rate-limits separate Ask messages without relying on the model path", () => {
    let currentTime = 0;
    const limiter = createDiscordContextAskRateLimiter({
      minIntervalMs: 60_000,
      now: () => currentTime
    });
    const ask = {
      channelId: "thread_context",
      actorDiscordUserId: "user_jakob"
    };

    expect(limiter.tryAcquire(ask)).toBe(true);
    expect(limiter.tryAcquire(ask)).toBe(false);
    currentTime = 60_000;
    expect(limiter.tryAcquire(ask)).toBe(true);
  });

  it("renders model prose as plain text and cites only captured Discord evidence", () => {
    const rendered = renderDiscordContextAskResult(contextInquiryResult());

    expect(rendered).toContain("might\\_ship");
    expect(rendered).toContain("@\u200beveryone");
    expect(rendered).toContain("https:\u200b//outside.example");
    expect(rendered).toContain("<https://discord.com/channels/1/2/3>");
    expect(rendered).not.toContain("<https://outside.example>");
  });
});

function contextInquiryResult(): ContextInquiryResult {
  const evidence = {
    evidenceId: "discord:message_1",
    providerId: "discord",
    conversationObjectId: "thread",
    anchorMessageId: "message_ask",
    sourceRevision: 1,
    messageId: "message_1",
    ordinal: 0,
    author: {
      providerUserId: "user_jakob",
      displayName: "Jakob",
      personId: null
    },
    createdAt: "2026-08-08T09:00:00.000Z",
    editedAt: null,
    replyToMessageId: null,
    url: "https://discord.com/channels/1/2/3",
    state: "available" as const,
    text: "It might ship."
  };

  return {
    type: "answer",
    inquiryId: "discord:message_ask:context-ask",
    question: "What did we decide?",
    subject: {
      type: "conversation-thread",
      providerId: "discord",
      conversationObjectId: "thread",
      anchorMessageId: "message_ask"
    },
    boundary: {
      mode: "thread",
      anchorMessageId: "message_ask",
      firstMessageId: "message_1",
      lastMessageId: "message_ask",
      messageIds: ["message_1", "message_ask"],
      sourceRevision: 1,
      contentHash: "a".repeat(64),
      completeness: "complete"
    },
    answer: {
      text: "The release might_ship @everyone: https://outside.example",
      evidence: [evidence]
    },
    facts: [],
    inferences: [],
    unresolved: [],
    evidence: [evidence],
    uncertainty: "none",
    warnings: []
  };
}
