import { afterEach, describe, expect, it, vi } from "vitest";
import { AiServiceError } from "../../src/ai/ai-service-error.js";
import type { AiUsageStatus } from "../../src/ai/ai-usage-budget.js";
import type { ReasoningModel } from "../../src/ai/reasoning-model.js";
import type { ContextIntelligence } from "../../src/context-intelligence/interface.js";
import {
  renderDeferredAnalysis,
  renderAiServiceFailure,
  renderAiUsageStatus,
  renderAiUsageWarning
} from "../../src/discord/discord-ai-status.js";
import type { DiscordContextAskMention } from "../../src/discord/discord-context-ask-runtime.js";
import {
  createDiscordMeetingBot,
  type DiscordCommand,
  type DiscordCommandResponse,
  type DiscordContextAskResponse,
  type DiscordTransport
} from "../../src/discord/discord-meeting-bot.js";
import { createLumaTeamIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";

const founder = "779381502311137301";
const commandBase = {
  interactionId: "usage-1",
  guildId: "guild",
  channelId: "parent",
  actorDiscordUserId: founder,
  occurredAt: "2026-09-08T10:00:00Z"
};
const mention: DiscordContextAskMention = {
  messageId: "mention-1",
  guildId: "guild",
  channelId: "thread",
  parentChannelId: "parent",
  actorDiscordUserId: founder,
  occurredAt: commandBase.occurredAt,
  question: "What happened?"
};

class ScriptedTransport implements DiscordTransport {
  command: (command: DiscordCommand) => Promise<DiscordCommandResponse> = () =>
    Promise.reject(new Error("not connected"));
  mention: (ask: DiscordContextAskMention) => Promise<DiscordContextAskResponse | null> =
    () => Promise.reject(new Error("not connected"));
  connect(
    command: ScriptedTransport["command"],
    mention?: ScriptedTransport["mention"]
  ): Promise<void> {
    this.command = command;
    if (mention) this.mention = mention;
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  createThread = vi.fn(() =>
    Promise.resolve({
      id: "meeting-thread",
      url: "https://discord.com/channels/guild/meeting-thread"
    })
  );
  sendMessage = vi.fn(() => Promise.resolve());
}

const databases: LumaDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
});

function status(overrides: Partial<AiUsageStatus> = {}): AiUsageStatus {
  return {
    month: "2026-09",
    timezone: "Europe/Berlin",
    resetAt: "2026-09-30T22:00:00.000Z",
    monthlyLimitUsd: 30,
    spentUsd: 26,
    reservedUsd: 1,
    unknownUsd: 0.5,
    requestCount: 120,
    status: "critical",
    alerts: [80, 90],
    byCapability: [],
    configured: true,
    ...overrides
  };
}

async function fixture(
  error = new AiServiceError("budget-exhausted", "secret provider data", {
    resetAt: "2026-09-30T22:00:00Z"
  }),
  usage = status()
) {
  const database = await createPgliteDatabase();
  databases.push(database);
  const generateStructured = vi.fn(() => Promise.reject(error));
  const model: ReasoningModel = { generateStructured };
  const meetingIntelligence = createMeetingIntelligence({
    database,
    reasoningModel: model
  });
  const inquire = vi.fn<ContextIntelligence["inquire"]>(() => Promise.reject(error));
  const getStatus = vi.fn(() => Promise.resolve(usage));
  const transport = new ScriptedTransport();
  let time = new Date(commandBase.occurredAt).getTime();
  const bot = createDiscordMeetingBot({
    database,
    meetingIntelligence,
    identityDirectory: createLumaTeamIdentityDirectory(),
    authorizedPersonIds: [
      "person_jakob",
      "person_fabius",
      "person_philipp",
      "person_julius"
    ],
    transport,
    workspace: { workspaceId: "workspace", timezone: "Europe/Berlin" },
    guildId: "guild",
    aiUsage: { getStatus },
    now: () => new Date(time),
    contextAsk: {
      contextIntelligence: { inquire },
      config: {
        parentChannelIds: ["parent"],
        allowedDiscordUserIds: [founder, "outsider"],
        maxMessages: 50,
        maxEvidenceChars: 32000,
        minIntervalMs: 60000
      }
    }
  });
  await bot.start();
  return {
    database,
    transport,
    inquire,
    getStatus,
    model,
    generateStructured,
    advance: (milliseconds: number) => {
      time += milliseconds;
    }
  };
}

describe("Discord AI usage and failure experience", () => {
  it("shows founder-only status without a meeting or model call, with reservations and local reset", async () => {
    const { transport, generateStructured, inquire, getStatus } = await fixture();
    const denied = await transport.command({
      ...commandBase,
      type: "usage",
      actorDiscordUserId: "outsider"
    });
    expect(denied.content).toContain("do not have access");
    expect(getStatus).not.toHaveBeenCalled();
    const response = await transport.command({ ...commandBase, type: "usage" });
    expect(response.content).toContain("$26.00 / $30.00");
    expect(response.content).toContain("active requests: $1.00");
    expect(response.content).toContain("cap: $0.50");
    expect(response.content).toContain("1 Oct 2026, 00:00 (Europe/Berlin)");
    expect(response.content).toContain("90%");
    expect(generateStructured).not.toHaveBeenCalled();
    expect(inquire).not.toHaveBeenCalled();
  });

  it("keeps mention usage/status usable at the cap and during cooldown without capturing evidence", async () => {
    const { transport, inquire, getStatus } = await fixture(
      undefined,
      status({ status: "exhausted", spentUsd: 30, reservedUsd: 0, unknownUsd: 0 })
    );
    const failure = await transport.mention(mention);
    expect(failure?.content).toContain("no new AI call was made");
    for (const question of ["usage", "STATUS"]) {
      const result = await transport.mention({
        ...mention,
        messageId: question,
        question
      });
      expect(result?.content).toContain("new paid requests are paused");
    }
    expect(inquire).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("explains an eligible cooldown, deduplicates Gateway events, and authorizes before disclosure", async () => {
    const { transport, inquire, getStatus, advance } = await fixture();
    await transport.mention(mention);
    expect(await transport.mention(mention)).toBeNull();
    advance(1100);
    const cooling = await transport.mention({ ...mention, messageId: "mention-2" });
    expect(cooling?.content).toContain("59 seconds");
    expect(cooling?.content).toContain("no AI call was made");
    expect(await transport.mention({ ...mention, messageId: "mention-2" })).toBeNull();
    expect(
      await transport.mention({
        ...mention,
        actorDiscordUserId: "outsider",
        question: "usage"
      })
    ).toBeNull();
    expect(
      await transport.mention({
        ...mention,
        parentChannelId: "other",
        question: "status"
      })
    ).toBeNull();
    expect(getStatus).not.toHaveBeenCalled();
    expect(inquire).toHaveBeenCalledTimes(1);
    advance(58900);
    await transport.mention({ ...mention, messageId: "mention-3" });
    expect(inquire).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["provider-quota", "billing or quota limit"],
    ["rate-limited", "Try again in 12 seconds"],
    ["timeout", "cost may still be pending"],
    ["unavailable", "temporarily unavailable"],
    ["not-configured", "not configured"],
    ["request-too-large", "narrower question"],
    ["request-indeterminate", "not started a duplicate"]
  ] as const)("explains %s safely in an eligible mention", async (code, expected) => {
    const { transport } = await fixture(
      new AiServiceError(code, "secret api key and user text", { retryAfterSeconds: 12 })
    );
    const response = await transport.mention(mention);
    expect(response?.content).toContain(expected);
    expect(response?.content).not.toContain("secret");
    if (code === "provider-quota")
      expect(response?.content).toContain("reset may not resolve it");
  });

  it("confirms durable note evidence when analysis is blocked and tells users not to resubmit", async () => {
    const { transport, database } = await fixture();
    await transport.command({
      ...commandBase,
      type: "start",
      title: "Budget test",
      languageMode: "en"
    });
    const response = await transport.command({
      ...commandBase,
      interactionId: "note-1",
      channelId: "meeting-thread",
      type: "note",
      text: "I will prepare the release checklist.",
      language: "en"
    });
    expect(response.content).toContain("Note saved");
    expect(response.content).toContain("budget cannot cover");
    expect(response.content).toContain("do not need to submit this note again");
    const rows = await database.query<{ original_text: string }>(
      "SELECT original_text FROM utterance_versions"
    );
    expect(rows.rows).toEqual([
      { original_text: "I will prepare the release checklist." }
    ]);
  });

  it("labels provisional configured prices and capability costs without disclosing arbitrary ledger text", () => {
    const rendered = renderAiUsageStatus(
      status({
        monthlyLimitUsd: 50,
        byCapability: [
          {
            capability: "meeting-understand-discussion",
            spentUsd: 2,
            reservedUsd: 0.2,
            unknownUsd: 0.3,
            requestCount: 4
          },
          {
            capability: "context-ask",
            spentUsd: 1,
            reservedUsd: 0,
            unknownUsd: 0,
            requestCount: 2
          },
          {
            capability: "@everyone secret",
            spentUsd: 0.1,
            reservedUsd: 0,
            unknownUsd: 0,
            requestCount: 1
          }
        ]
      })
    );
    expect(rendered).toContain("$50.00 shared monthly cap");
    expect(rendered).not.toContain("$30");
    expect(rendered).toContain("Meeting analysis: $2.00; 4 requests; held $0.50");
    expect(rendered).toContain("Context Ask: $1.00");
    expect(rendered).toContain("Other tracked AI: $0.10");
    expect(rendered).not.toContain("secret");
    expect(rendered.length).toBeLessThan(1800);
    expect(renderAiUsageWarning(status({ status: "warning" }))).toContain("80%");
  });

  it("renders configured budget timezones through immediate and deferred failures", () => {
    const details = {
      limitScope: "month" as const,
      timezone: "Asia/Tokyo",
      resetAt: "2026-09-30T15:00:00Z"
    };
    expect(
      renderAiServiceFailure(new AiServiceError("budget-exhausted", "internal", details))
    ).toContain("1 Oct 2026, 00:00 (Asia/Tokyo)");
    expect(
      renderDeferredAnalysis([
        {
          code: "analysis-budget-exhausted",
          retryable: false,
          ...details
        }
      ])
    ).toContain("1 Oct 2026, 00:00 (Asia/Tokyo)");
    expect(
      renderAiServiceFailure(
        new AiServiceError("budget-exhausted", "legacy", {
          resetAt: details.resetAt
        })
      )
    ).toContain("30 Sept 2026, 15:00 (UTC)");
  });

  it("distinguishes daily and workflow limits from the shared monthly allowance", () => {
    const daily = renderAiServiceFailure(
      new AiServiceError("budget-exhausted", "internal", {
        limitScope: "day",
        timezone: "Europe/Berlin",
        resetAt: "2026-09-08T22:00:00Z"
      })
    );
    expect(daily).toContain("daily safety budget");
    expect(daily).toContain("9 Sept 2026, 00:00");
    const workflow = renderAiServiceFailure(
      new AiServiceError("budget-exhausted", "internal", { limitScope: "workflow" })
    );
    expect(workflow).toContain("workflow cost or attempt limit");
    expect(workflow).not.toContain("resets");
    const deferred = renderDeferredAnalysis([
      { code: "analysis-budget-exhausted", retryable: false, limitScope: "workflow" }
    ]);
    expect(deferred).toContain("workflow cost or attempt limit");
    expect(deferred).toContain("Note saved");
    const dailyStatus = renderAiUsageStatus(
      status({
        status: "exhausted",
        limitScope: "day",
        dailyLimitUsd: 2,
        dailySpentUsd: 1.5,
        dailyReservedUsd: 0.2,
        dailyUnknownUsd: 0.3,
        resetAt: "2026-09-08T22:00:00Z"
      })
    );
    expect(dailyStatus).toContain("Daily cap resets: 9 Sept 2026, 00:00");
    expect(dailyStatus).toContain(
      "Daily safety cap: $2.00; estimated spend $1.50, held $0.50"
    );
    const availableDaily = renderAiUsageStatus(
      status({
        status: "available",
        dailyLimitUsd: 2,
        dailyResetAt: "2026-09-08T22:00:00Z"
      })
    );
    expect(availableDaily).toContain("Daily cap resets: 9 Sept 2026, 00:00");
    expect(availableDaily).toContain("Monthly cap resets: 1 Oct 2026, 00:00");
  });

  it("does not leak arbitrary exception text", () => {
    expect(renderAiServiceFailure(new Error("secret provider response"))).not.toContain(
      "secret"
    );
  });
});
