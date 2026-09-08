import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiUsageStatus } from "../../src/ai/ai-usage-budget.js";
import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../../src/ai/reasoning-model.js";
import type {
  ContextInquiry,
  ContextInquiryResult
} from "../../src/context-intelligence/interface.js";
import type { DiscordChannelSurface } from "../../src/discord/discord-channel-scope.js";
import type { DiscordContextAskMention } from "../../src/discord/discord-context-ask-runtime.js";
import {
  createDiscordMeetingBot,
  type DiscordCommand,
  type DiscordCommandResponse,
  type DiscordContextAskResponse,
  type DiscordTransport
} from "../../src/discord/discord-meeting-bot.js";
import type { FollowUpExecution } from "../../src/follow-up-execution/interface.js";
import { createLumaTeamIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";

const founder = "779381502311137301";
const workspace = { workspaceId: "workspace_dayova", timezone: "Europe/Berlin" };
const commandBase = {
  guildId: "guild_dayova",
  channelId: "team_chat",
  actorDiscordUserId: founder,
  occurredAt: "2026-09-08T18:00:00.000Z"
};
const commandPayloads = [
  { type: "start", title: "Release discussion", languageMode: "en" },
  { type: "ask", question: "What should Jakob prepare?" },
  { type: "catchup", sinceRevision: 0 },
  { type: "note", text: "I will prepare the release checklist.", language: "en" },
  { type: "approve", intentId: "intent_release" },
  { type: "recover", intentId: "intent_release" },
  { type: "reject", intentId: "intent_release" },
  { type: "stop" },
  { type: "usage" }
] as const;
const mentionBase: DiscordContextAskMention = {
  ...commandBase,
  channelId: "context_thread",
  parentChannelId: "team_chat",
  messageId: "context_ask",
  question: "What should Jakob prepare?"
};

class ScopeTransport implements DiscordTransport {
  readonly channels = new Map<string, DiscordChannelSurface>(
    ["team_chat", "allgemein", "gaeste"].map((id) => [
      id,
      { id, guildId: "guild_dayova", kind: "text-channel", parentChannelId: null }
    ])
  );
  command: (command: DiscordCommand) => Promise<DiscordCommandResponse> = () =>
    Promise.reject(new Error("not connected"));
  mention: (ask: DiscordContextAskMention) => Promise<DiscordContextAskResponse | null> =
    () => Promise.reject(new Error("not connected"));
  constructor() {
    this.putThread("context_thread", "team_chat");
    this.putThread("guest_thread", "gaeste");
  }
  putThread(id: string, parentChannelId: string): void {
    this.channels.set(id, {
      id,
      guildId: "guild_dayova",
      kind: "public-thread",
      parentChannelId
    });
  }
  connect(command: ScopeTransport["command"], mention?: ScopeTransport["mention"]) {
    this.command = command;
    if (mention) this.mention = mention;
    return Promise.resolve();
  }
  disconnect() {
    return Promise.resolve();
  }
  resolveChannel = vi.fn(({ channelId }: { channelId: string }) =>
    Promise.resolve(this.channels.get(channelId) ?? null)
  );
  createThread = vi.fn(
    ({ parentChannelId }: { parentChannelId: string; name: string }) => {
      this.putThread("meeting_thread", parentChannelId);
      return Promise.resolve({
        id: "meeting_thread",
        url: "https://discord.com/channels/guild_dayova/meeting_thread"
      });
    }
  );
  sendMessage = vi.fn<DiscordTransport["sendMessage"]>(() => Promise.resolve());
}

class GroundedReasoningModel implements ReasoningModel {
  generateStructured<T>(
    request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    const evidence = request.evidence[0];
    if (!evidence) throw new Error("Expected original evidence");
    const value: MeetingAnalysisProposalBatch = {
      actionItems: [],
      decisions: [],
      openQuestions: [],
      risks: [],
      followUpIntentions: [
        {
          id: "intent_release",
          type: "create-work-item",
          title: "Prepare the release checklist",
          description: "Prepare the release checklist.",
          assigneeId: "person_jakob",
          mentionPersonIds: [],
          dueDate: null,
          relatedMeetingItemIds: [],
          evidenceIds: [evidence.evidenceId],
          confidence: "high"
        }
      ]
    };
    return Promise.resolve({
      value: value as T,
      metadata: {
        provider: "test",
        model: "grounded",
        promptVersion: request.promptVersion
      }
    });
  }
}

function usageStatus(): AiUsageStatus {
  return {
    month: "2026-09",
    timezone: "Europe/Berlin",
    resetAt: "2026-09-30T22:00:00.000Z",
    monthlyLimitUsd: 30,
    spentUsd: 2,
    reservedUsd: 0,
    unknownUsd: 0,
    requestCount: 10,
    status: "available",
    alerts: [],
    byCapability: [],
    configured: true
  };
}
function contextResult(input: ContextInquiry): ContextInquiryResult {
  return {
    type: "answer",
    inquiryId: input.inquiryId,
    question: input.question,
    subject: input.subject,
    boundary: {
      mode: "thread",
      anchorMessageId: input.subject.anchorMessageId,
      firstMessageId: "source",
      lastMessageId: "source",
      messageIds: ["source"],
      sourceRevision: 1,
      contentHash: "fixture-hash",
      completeness: "complete"
    },
    answer: { text: "There is insufficient evidence.", evidence: [] },
    facts: [],
    inferences: [],
    unresolved: [],
    evidence: [],
    uncertainty: "insufficient-evidence",
    warnings: []
  };
}
function deferred<T>() {
  let resolve = (_value: T): void => {
    void _value;
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const databases: LumaDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) await database.close();
});
async function fixture(allowedParentChannelIds: readonly string[] = ["team_chat"]) {
  const database = await createPgliteDatabase();
  databases.push(database);
  const databaseQuery = vi.spyOn(database, "query");
  const meetingIntelligence = createMeetingIntelligence({
    database,
    reasoningModel: new GroundedReasoningModel()
  });
  const observe = vi.spyOn(meetingIntelligence, "observe");
  const query = vi.spyOn(meetingIntelligence, "query");
  const conclude = vi.spyOn(meetingIntelligence, "conclude");
  const execute = vi.fn<FollowUpExecution["execute"]>(() =>
    Promise.reject(new Error("No external write expected"))
  );
  const recover = vi.fn<FollowUpExecution["recover"]>(() =>
    Promise.reject(new Error("No external recovery expected"))
  );
  const inquire = vi.fn((input: ContextInquiry) => Promise.resolve(contextResult(input)));
  const getStatus = vi.fn(() => Promise.resolve(usageStatus()));
  const transport = new ScopeTransport();
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
    allowedParentChannelIds,
    transport,
    workspace,
    guildId: "guild_dayova",
    followUpExecution: { execute, recover },
    aiUsage: { getStatus },
    now: () => new Date(commandBase.occurredAt),
    contextAsk: {
      contextIntelligence: { inquire },
      config: {
        parentChannelIds: ["team_chat", "gaeste"],
        allowedDiscordUserIds: [founder],
        maxMessages: 50,
        maxEvidenceChars: 32000,
        minIntervalMs: 60000
      }
    }
  });
  await bot.start();
  return {
    database,
    databaseQuery,
    meetingIntelligence,
    observe,
    query,
    conclude,
    execute,
    recover,
    inquire,
    getStatus,
    transport,
    bot
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function clearCalls(f: Fixture) {
  for (const mock of [
    f.databaseQuery,
    f.observe,
    f.query,
    f.conclude,
    f.execute,
    f.recover,
    f.inquire,
    f.getStatus,
    f.transport.resolveChannel,
    f.transport.createThread,
    f.transport.sendMessage
  ])
    mock.mockClear();
}
function expectNoWork(f: Fixture) {
  for (const mock of [
    f.observe,
    f.query,
    f.conclude,
    f.execute,
    f.recover,
    f.inquire,
    f.getStatus,
    f.transport.createThread,
    f.transport.sendMessage
  ])
    expect(mock).not.toHaveBeenCalled();
}
async function startMeeting(f: Fixture) {
  const response = await f.transport.command({
    ...commandBase,
    ...commandPayloads[0],
    interactionId: "start"
  });
  expect(response.content).toContain("Meeting started in");
}

describe("shared Discord channel scope", () => {
  it("denies every slash command in excluded channels before reads or side effects", async () => {
    const f = await fixture();
    for (const channelId of ["allgemein", "gaeste", "guest_thread", "unknown_channel"]) {
      for (const payload of commandPayloads) {
        expect(
          await f.transport.command({
            ...commandBase,
            ...payload,
            channelId,
            interactionId: `${channelId}_${payload.type}`
          })
        ).toEqual({ content: "Luma is not enabled in this Discord channel." });
      }
    }
    expectNoWork(f);
    expect(f.databaseQuery).not.toHaveBeenCalled();
    expect(
      (
        await f.database.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM discord_meeting_threads"
        )
      ).rows
    ).toEqual([{ count: 0 }]);
    expect(
      (
        await f.database.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM meetings"
        )
      ).rows
    ).toEqual([{ count: 0 }]);
  });

  it("treats an empty common scope as disabled for commands and mentions", async () => {
    const f = await fixture([]);
    for (const payload of commandPayloads) {
      expect(
        (
          await f.transport.command({
            ...commandBase,
            ...payload,
            interactionId: payload.type
          })
        ).content
      ).toBe("Luma is not enabled in this Discord channel.");
    }
    expect(await f.transport.mention({ ...mentionBase, question: "usage" })).toBeNull();
    expectNoWork(f);
    expect(f.databaseQuery).not.toHaveBeenCalled();
    expect(f.transport.resolveChannel).not.toHaveBeenCalled();
  });

  it("authorizes the actor before resolving channels", async () => {
    const f = await fixture();
    expect(
      (
        await f.transport.command({
          ...commandBase,
          type: "usage",
          interactionId: "outsider",
          actorDiscordUserId: "outsider"
        })
      ).content
    ).toContain("do not have access");
    expect(
      await f.transport.mention({ ...mentionBase, actorDiscordUserId: "outsider" })
    ).toBeNull();
    expect(f.transport.resolveChannel).not.toHaveBeenCalled();
    expect(f.databaseQuery).not.toHaveBeenCalled();
    expectNoWork(f);
  });

  it("does not trust an allowed parent's stored Meeting mapping after its thread leaves scope", async () => {
    const f = await fixture();
    await startMeeting(f);
    f.transport.putThread("meeting_thread", "allgemein");
    clearCalls(f);
    for (const payload of commandPayloads.filter((payload) => payload.type !== "usage")) {
      expect(
        (
          await f.transport.command({
            ...commandBase,
            ...payload,
            interactionId: `moved_${payload.type}`
          })
        ).content
      ).toBe("Luma is not enabled in this Discord channel.");
    }
    expectNoWork(f);
  });

  it("retains Ask, catch-up and Human review in an allowed ended Meeting thread", async () => {
    const f = await fixture();
    await startMeeting(f);
    const inThread = { ...commandBase, channelId: "meeting_thread" };
    expect(
      (
        await f.transport.command({
          ...inThread,
          ...commandPayloads[3],
          interactionId: "note"
        })
      ).content
    ).toContain("intent_release");
    expect(
      (await f.transport.command({ ...inThread, type: "stop", interactionId: "stop" }))
        .content
    ).toContain("Meeting ended");
    clearCalls(f);
    for (const payload of [commandPayloads[1], commandPayloads[2]]) {
      expect(
        (
          await f.transport.command({
            ...inThread,
            ...payload,
            interactionId: `ended_${payload.type}`
          })
        ).content
      ).toContain("Evidence:");
    }
    expect(
      (
        await f.transport.command({
          ...inThread,
          ...commandPayloads[6],
          interactionId: "ended_reject"
        })
      ).content
    ).toBe("Follow-up rejected: intent_release");
    const snapshot = await f.meetingIntelligence.query({
      workspaceId: workspace.workspaceId,
      meetingId: "discord_start",
      query: { type: "snapshot" }
    });
    expect(snapshot).toMatchObject({
      type: "snapshot",
      state: {
        followUpIntentions: [
          expect.objectContaining({ id: "intent_release", status: "rejected" })
        ]
      }
    });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.recover).not.toHaveBeenCalled();
  });

  it("denies Context status and inquiries when Context configuration is wider than common scope", async () => {
    const f = await fixture();
    for (const question of ["usage", "status", "What was decided?"]) {
      expect(
        await f.transport.mention({
          ...mentionBase,
          messageId: question,
          channelId: "guest_thread",
          parentChannelId: "gaeste",
          question
        })
      ).toBeNull();
    }
    expectNoWork(f);
    expect(f.databaseQuery).not.toHaveBeenCalled();
  });

  it("rechecks common scope before a cooldown or budget-status response", async () => {
    const f = await fixture();
    expect(await f.transport.mention(mentionBase)).not.toBeNull();
    f.transport.putThread("context_thread", "allgemein");
    clearCalls(f);
    for (const question of ["What was decided?", "usage", "status"]) {
      expect(
        await f.transport.mention({ ...mentionBase, messageId: question, question })
      ).toBeNull();
    }
    expectNoWork(f);
    expect(f.databaseQuery).not.toHaveBeenCalled();
  });

  it("blocks deferred Meeting receipts after their destination leaves scope", async () => {
    const f = await fixture();
    await startMeeting(f);
    f.transport.channels.delete("meeting_thread");
    clearCalls(f);
    await expect(
      f.bot.publishMeetingEvents({
        workspaceId: workspace.workspaceId,
        meetingId: "discord_start",
        events: [{ type: "follow-up-execution-started", intentId: "intent_release" }],
        mentionPersonIds: ["person_jakob"]
      })
    ).rejects.toThrow("Luma is not enabled in this Discord channel.");
    expect(f.transport.sendMessage).not.toHaveBeenCalled();
  });

  it("discards a Context answer if its thread leaves scope while the inquiry is pending", async () => {
    const f = await fixture();
    const entered = deferred<ContextInquiry>();
    const completed = deferred<ContextInquiryResult>();
    f.inquire.mockImplementation((input) => {
      entered.resolve(input);
      return completed.promise;
    });
    const result = f.transport.mention(mentionBase);
    const inquiry = await entered.promise;
    f.transport.putThread("context_thread", "allgemein");
    completed.resolve(contextResult(inquiry));
    expect(await result).toBeNull();
    expect(f.transport.sendMessage).not.toHaveBeenCalled();
  });

  it("discards budget status if its thread leaves scope during the status read", async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const completed = deferred<AiUsageStatus>();
    f.getStatus.mockImplementation(() => {
      entered.resolve();
      return completed.promise;
    });
    const result = f.transport.mention({ ...mentionBase, question: "status" });
    await entered.promise;
    f.transport.putThread("context_thread", "allgemein");
    completed.resolve(usageStatus());
    expect(await result).toBeNull();
    expect(f.inquire).not.toHaveBeenCalled();
    expect(f.transport.sendMessage).not.toHaveBeenCalled();
  });
});
