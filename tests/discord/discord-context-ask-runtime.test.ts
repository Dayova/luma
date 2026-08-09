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

  it("renders model prose as plain text and includes only captured Discord Evidence", () => {
    const rendered = renderDiscordContextAskResult(contextInquiryResult());

    expect(rendered).toContain("might\\_ship");
    expect(rendered).toContain("@\u200beveryone");
    expect(rendered).toContain("https:\u200b//outside.example");
    expect(rendered).toContain("<https://discord.com/channels/1/2/3>");
    expect(rendered).not.toContain("<https://outside.example>");
  });

  it("renders separately evidenced facts and confidence-labelled inferences", () => {
    const rendered = renderDiscordContextAskResult(contextInquiryResult());

    expect(rendered).toContain(
      "Facts:\n- The Linear issue remains open.\n  Evidence:\n  - Jakob: <https://discord.com/channels/1/2/3>"
    );
    expect(rendered).toContain(
      "Inferences:\n- The team might ship next week. (confidence: medium)\n  Evidence:\n  - Fabius: <https://discord.com/channels/1/2/4>"
    );
    expect(rendered).not.toContain("<https://discord.com/channels/1/2/999>");
  });

  it("keeps the legacy response byte-identical when there are no facts or inferences", () => {
    const result = contextInquiryResult();
    result.facts = [];
    result.inferences = [];

    expect(renderDiscordContextAskResult(result)).toBe(
      [
        "Luma Ask",
        "",
        "The release might\\_ship @\u200beveryone: https:\u200b//outside.example",
        "",
        "Evidence:",
        "- Jakob: <https://discord.com/channels/1/2/3>"
      ].join("\n")
    );
  });

  it("omits fact and inference claims without available captured Discord evidence", () => {
    const result = contextInquiryResult();
    const capturedEvidence = result.evidence.find(
      (evidence) => evidence.messageId === "message_1"
    );

    if (!capturedEvidence) {
      throw new Error("test fixture must contain the captured answer evidence");
    }

    const uncapturedEvidence = {
      ...capturedEvidence,
      evidenceId: "discord:message_999",
      messageId: "message_999",
      url: "https://discord.com/channels/1/2/999"
    };
    const deletedEvidence = {
      ...capturedEvidence,
      evidenceId: "discord:message_deleted",
      messageId: "message_deleted",
      state: "deleted" as const,
      text: null
    };

    result.facts = [
      {
        text: "Uncaptured fact",
        evidence: [uncapturedEvidence]
      }
    ];
    result.inferences = [
      {
        text: "Deleted inference",
        confidence: "high",
        evidence: [deletedEvidence]
      }
    ];

    const rendered = renderDiscordContextAskResult(result);

    expect(rendered).not.toContain("Facts:");
    expect(rendered).not.toContain("Inferences:");
    expect(rendered).not.toContain("Uncaptured fact");
    expect(rendered).not.toContain("Deleted inference");
    expect(rendered).not.toContain("<https://discord.com/channels/1/2/999>");
  });

  it("fails closed instead of rendering a non-insufficient answer without canonical captured Evidence", () => {
    const result = contextInquiryResult();
    const capturedEvidence = result.evidence.find(
      (evidence) => evidence.messageId === "message_1"
    );

    if (!capturedEvidence) {
      throw new Error("test fixture must contain the captured answer evidence");
    }

    result.answer = {
      text: "Unsupported answer",
      evidence: [
        {
          ...capturedEvidence,
          evidenceId: "discord:message_999",
          messageId: "message_999"
        }
      ]
    };

    expect(renderDiscordContextAskResult(result)).toBe(
      "Luma could not safely render a grounded answer from the captured evidence. Please ask a narrower question."
    );
  });

  it("fails closed instead of rendering an insufficient-evidence answer without canonical captured Evidence", () => {
    const result = contextInquiryResult();
    result.uncertainty = "insufficient-evidence";
    result.answer = {
      text: "Unsupported insufficient-evidence answer",
      evidence: []
    };

    expect(renderDiscordContextAskResult(result)).toBe(
      "Luma could not safely render a grounded answer from the captured evidence. Please ask a narrower question."
    );
  });

  it("keeps core capture limitations explicit without rendering an unsupported no-answer text", () => {
    const result = contextInquiryResult();
    result.answer = {
      text: "This model-controlled text must never render.",
      evidence: []
    };
    result.facts = [];
    result.inferences = [];
    result.uncertainty = "insufficient-evidence";
    result.warnings = [
      {
        code: "conversation-boundary-incomplete",
        message:
          "Luma did not answer because the thread boundary is incomplete: history-truncated"
      }
    ];
    result.unresolved = ["Capture a complete thread boundary before asking again."];

    const rendered = renderDiscordContextAskResult(result);

    expect(rendered).toBe(
      [
        "Luma Ask",
        "",
        "Luma cannot answer reliably from the captured evidence.",
        "",
        "Uncertainty: insufficient-evidence",
        "",
        "Limitations:",
        "- Luma did not answer because the thread boundary is incomplete: history-truncated",
        "",
        "Unresolved:",
        "- Capture a complete thread boundary before asking again."
      ].join("\n")
    );
    expect(rendered).not.toContain("This model-controlled text must never render.");
  });

  it("keeps rendered claims and captured Evidence labels on one Discord line", () => {
    const result = contextInquiryResult();
    const capturedEvidence = result.evidence.find(
      (evidence) => evidence.messageId === "message_1"
    );

    if (!capturedEvidence) {
      throw new Error("test fixture must contain the captured answer evidence");
    }

    capturedEvidence.author.displayName = "Jakob\r\n- forged Evidence";
    result.facts = [
      {
        text: "Supported fact\nInferences:\n- unsupported fact",
        evidence: [capturedEvidence]
      }
    ];
    result.inferences = [
      {
        text: "Supported inference\u2028- unsupported inference",
        confidence: "high",
        evidence: [capturedEvidence]
      }
    ];

    const rendered = renderDiscordContextAskResult(result);

    expect(rendered).toContain(
      "Facts:\n- Supported fact Inferences: - unsupported fact\n  Evidence:\n  - Jakob - forged Evidence: <https://discord.com/channels/1/2/3>"
    );
    expect(rendered).toContain(
      "Inferences:\n- Supported inference - unsupported inference (confidence: high)\n  Evidence:\n  - Jakob - forged Evidence: <https://discord.com/channels/1/2/3>"
    );
    expect(rendered).not.toContain("\n- unsupported fact");
    expect(rendered).not.toContain("\n- unsupported inference");
    expect(rendered).not.toContain("\r");
  });

  it("keeps answer, limitations, and unresolved text from forging Discord sections", () => {
    const result = contextInquiryResult();
    result.answer.text = "Grounded answer\nFacts:\n- forged fact";
    result.facts = [];
    result.inferences = [];
    result.warnings = [
      {
        code: "context-answer-unavailable",
        message: "Model caveat\r\nInferences:\n- forged inference"
      }
    ];
    result.unresolved = ["Open point\u2029Unresolved:\n- forged unresolved"];

    expect(renderDiscordContextAskResult(result)).toBe(
      [
        "Luma Ask",
        "",
        "Grounded answer Facts: - forged fact",
        "",
        "Evidence:",
        "- Jakob: <https://discord.com/channels/1/2/3>",
        "",
        "Limitations:",
        "- Model caveat Inferences: - forged inference",
        "",
        "Unresolved:",
        "- Open point Unresolved: - forged unresolved"
      ].join("\n")
    );
  });

  it("renders canonical captured Evidence instead of an answerer-provided copy", () => {
    const result = contextInquiryResult();
    const canonicalEvidence = result.evidence.find(
      (evidence) => evidence.messageId === "message_1"
    );

    if (!canonicalEvidence) {
      throw new Error("test fixture must contain the canonical captured Evidence");
    }

    result.facts = [
      {
        text: "The Linear issue remains open.",
        evidence: [
          {
            ...canonicalEvidence,
            author: { ...canonicalEvidence.author, displayName: "Untrusted copy" },
            url: "https://discord.com/channels/1/2/999"
          }
        ]
      }
    ];

    const rendered = renderDiscordContextAskResult(result);

    expect(rendered).toContain("- Jakob: <https://discord.com/channels/1/2/3>");
    expect(rendered).not.toContain("Untrusted copy");
    expect(rendered).not.toContain("<https://discord.com/channels/1/2/999>");
  });

  it("uses the existing safe fallback instead of truncating fact or inference claims", () => {
    const result = contextInquiryResult();
    result.facts = [
      {
        text: "A".repeat(1_501),
        evidence: result.evidence
      }
    ];

    expect(renderDiscordContextAskResult(result)).toBe(
      "Luma's grounded answer is too long for a safe Discord reply. Please ask a narrower question."
    );
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
  const inferenceEvidence = {
    ...evidence,
    evidenceId: "discord:message_2",
    messageId: "message_2",
    ordinal: 1,
    author: {
      providerUserId: "user_fabius",
      displayName: "Fabius",
      personId: null
    },
    url: "https://discord.com/channels/1/2/4",
    text: "We might ship next week."
  };
  const uncapturedDiscordEvidence = {
    ...inferenceEvidence,
    evidenceId: "discord:message_999",
    messageId: "message_999",
    url: "https://discord.com/channels/1/2/999"
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
    facts: [
      {
        text: "The Linear issue remains open.",
        evidence: [evidence]
      }
    ],
    inferences: [
      {
        text: "The team might ship next week.",
        confidence: "medium",
        evidence: [inferenceEvidence, uncapturedDiscordEvidence]
      }
    ],
    unresolved: [],
    evidence: [evidence, inferenceEvidence],
    uncertainty: "none",
    warnings: []
  };
}
