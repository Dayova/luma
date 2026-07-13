import { describe, expect, it } from "vitest";
import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../../src/ai/reasoning-model.js";
import {
  createDiscordMeetingBot,
  type DiscordCommand,
  type DiscordCommandResponse,
  type DiscordThread,
  type DiscordTransport
} from "../../src/discord/discord-meeting-bot.js";
import { createLumaTeamIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import type { MeetingIntelligence } from "../../src/meeting-intelligence/interface.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";

class EmptyReasoningModel implements ReasoningModel {
  generateStructured<T>(
    request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    const value: MeetingAnalysisProposalBatch = {
      actionItems: [],
      decisions: [],
      openQuestions: [],
      risks: [],
      followUpIntentions: []
    };

    return Promise.resolve({
      value: value as T,
      metadata: {
        provider: "test",
        model: "empty",
        promptVersion: request.promptVersion
      }
    });
  }
}

class ProgrammableDiscordTransport implements DiscordTransport {
  createdThreads: Array<{ parentChannelId: string; name: string }> = [];
  sentMessages: Array<{
    channelId: string;
    content: string;
    allowedUserIds?: string[];
    idempotencyKey?: string;
  }> = [];
  private commandHandler:
    ((command: DiscordCommand) => Promise<DiscordCommandResponse>) | null = null;
  private readonly threads = new Map<string, DiscordThread>();
  private readonly deliveredMessageKeys = new Set<string>();

  connect(
    commandHandler: (command: DiscordCommand) => Promise<DiscordCommandResponse>
  ): Promise<void> {
    this.commandHandler = commandHandler;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  createThread(input: { parentChannelId: string; name: string }): Promise<DiscordThread> {
    const key = this.threadKey(input);
    const existing = this.threads.get(key);

    if (existing) {
      return Promise.resolve(existing);
    }

    this.createdThreads.push(input);
    const sequence = this.createdThreads.length;
    const suffix = sequence === 1 ? "" : `_${sequence}`;
    const thread = {
      id: `thread_product${suffix}`,
      url: `https://discord.com/channels/guild_dayova/thread_product${suffix}`
    };
    this.threads.set(key, thread);

    return Promise.resolve(thread);
  }

  seedThread(input: {
    parentChannelId: string;
    name: string;
    thread: DiscordThread;
  }): void {
    this.threads.set(this.threadKey(input), input.thread);
  }

  sendMessage(input: {
    channelId: string;
    content: string;
    allowedUserIds?: string[];
    idempotencyKey?: string;
  }): Promise<void> {
    if (input.idempotencyKey && this.deliveredMessageKeys.has(input.idempotencyKey)) {
      return Promise.resolve();
    }

    if (input.idempotencyKey) {
      this.deliveredMessageKeys.add(input.idempotencyKey);
    }

    this.sentMessages.push(input);
    return Promise.resolve();
  }

  execute(command: DiscordCommand): Promise<DiscordCommandResponse> {
    if (!this.commandHandler) {
      throw new Error("Discord transport is not connected");
    }

    return this.commandHandler(command);
  }

  private threadKey(input: { parentChannelId: string; name: string }): string {
    return `${input.parentChannelId}:${input.name}`;
  }
}

class ConcurrentDiscordTransport extends ProgrammableDiscordTransport {
  override createThread(input: {
    parentChannelId: string;
    name: string;
  }): Promise<DiscordThread> {
    this.createdThreads.push(input);
    const sequence = this.createdThreads.length;

    return Promise.resolve({
      id: `thread_product_${sequence}`,
      url: `https://discord.com/channels/guild_dayova/thread_product_${sequence}`
    });
  }
}

describe("Discord meeting bot", () => {
  it("can retry a start after Meeting Intelligence temporarily fails", async () => {
    const database = await createPgliteDatabase();
    const durableMeetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new EmptyReasoningModel(),
      now: () => new Date("2026-07-11T13:00:00.000Z")
    });
    let observeAttempts = 0;
    const meetingIntelligence: MeetingIntelligence = {
      observe(input) {
        observeAttempts += 1;

        if (observeAttempts === 1) {
          return Promise.reject(new Error("temporary persistence failure"));
        }

        return durableMeetingIntelligence.observe(input);
      },
      query: (input) => durableMeetingIntelligence.query(input),
      conclude: (input) => durableMeetingIntelligence.conclude(input)
    };
    const transport = new ProgrammableDiscordTransport();
    const bot = createDiscordMeetingBot({
      database,
      meetingIntelligence,
      identityDirectory: createLumaTeamIdentityDirectory(),
      transport,
      workspace: {
        workspaceId: "workspace_dayova",
        timezone: "Europe/Berlin"
      },
      guildId: "guild_dayova",
      now: () => new Date("2026-07-11T13:00:00.000Z")
    });
    const command: DiscordCommand = {
      type: "start",
      interactionId: "interaction_retry_product",
      guildId: "guild_dayova",
      channelId: "channel_meeting_notes",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-11T13:00:00.000Z",
      title: "Product Meeting",
      languageMode: "multilingual"
    };

    await bot.start();
    await expect(transport.execute(command)).rejects.toThrow(
      "temporary persistence failure"
    );
    expect(transport.createdThreads).toHaveLength(0);
    await expect(
      database.query<{ meeting_observed_at: string | null; thread_id: string | null }>(
        `SELECT meeting_observed_at, thread_id
           FROM discord_meeting_threads
          WHERE workspace_id = $1 AND meeting_id = $2`,
        ["workspace_dayova", "discord_interaction_retry_product"]
      )
    ).resolves.toMatchObject({
      rows: [{ meeting_observed_at: null, thread_id: null }]
    });

    const response = await transport.execute(command);

    expect(transport.createdThreads).toHaveLength(1);
    expect(response.content).toBe(
      "Meeting started in https://discord.com/channels/guild_dayova/thread_product"
    );
  });

  it("recovers a reserved Meeting by attaching its existing Discord thread", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new EmptyReasoningModel(),
      now: () => new Date("2026-07-11T13:00:00.000Z")
    });
    await meetingIntelligence.observe({
      workspace: {
        workspaceId: "workspace_dayova",
        timezone: "Europe/Berlin"
      },
      observations: [
        {
          type: "meeting-started",
          observationId: "discord:interaction_recover_product:meeting-started",
          workspaceId: "workspace_dayova",
          meetingId: "discord_interaction_recover_product",
          occurredAt: "2026-07-11T13:00:00.000Z",
          observedAt: "2026-07-11T13:00:00.000Z",
          title: "Product Meeting",
          startedAt: "2026-07-11T13:00:00.000Z",
          languageMode: "multilingual",
          participantIds: ["person_jakob"]
        }
      ]
    });
    await database.query(
      `INSERT INTO discord_meeting_threads (
         workspace_id, meeting_id, guild_id, parent_channel_id,
         meeting_title, thread_name, language_mode, actor_discord_user_id,
         meeting_observed_at, thread_id, thread_url,
         started_at, ended_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, $10, NULL, $11, $11)`,
      [
        "workspace_dayova",
        "discord_interaction_recover_product",
        "guild_dayova",
        "channel_meeting_notes",
        "Product Meeting",
        "Product Meeting - 11 Jul 2026 [discord_interaction_recover_product]",
        "multilingual",
        "779381502311137301",
        "2026-07-11T13:00:00.000Z",
        "2026-07-11T13:00:00.000Z",
        "2026-07-11T13:00:00.000Z"
      ]
    );
    const transport = new ProgrammableDiscordTransport();
    transport.seedThread({
      parentChannelId: "channel_meeting_notes",
      name: "Product Meeting - 11 Jul 2026 [discord_interaction_recover_product]",
      thread: {
        id: "thread_product",
        url: "https://discord.com/channels/guild_dayova/thread_product"
      }
    });
    const bot = createDiscordMeetingBot({
      database,
      meetingIntelligence,
      identityDirectory: createLumaTeamIdentityDirectory(),
      transport,
      workspace: {
        workspaceId: "workspace_dayova",
        timezone: "Europe/Berlin"
      },
      guildId: "guild_dayova",
      now: () => new Date("2026-07-11T13:00:00.000Z")
    });

    await bot.start();
    const response = await transport.execute({
      type: "start",
      interactionId: "interaction_recover_product",
      guildId: "guild_dayova",
      channelId: "channel_meeting_notes",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-11T13:00:00.000Z",
      title: "Product Meeting",
      languageMode: "multilingual"
    });

    expect(transport.createdThreads).toHaveLength(0);
    expect(response.content).toBe(
      "Meeting started in https://discord.com/channels/guild_dayova/thread_product"
    );
    await expect(
      database.query<{ thread_id: string; thread_url: string }>(
        `SELECT thread_id, thread_url
           FROM discord_meeting_threads
          WHERE workspace_id = $1 AND meeting_id = $2`,
        ["workspace_dayova", "discord_interaction_recover_product"]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          thread_id: "thread_product",
          thread_url: "https://discord.com/channels/guild_dayova/thread_product"
        }
      ]
    });
  });

  it("creates only one active Meeting thread for concurrent starts", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new EmptyReasoningModel(),
      now: () => new Date("2026-07-11T13:00:00.000Z")
    });
    const transport = new ConcurrentDiscordTransport();
    const bot = createDiscordMeetingBot({
      database,
      meetingIntelligence,
      identityDirectory: createLumaTeamIdentityDirectory(),
      transport,
      workspace: {
        workspaceId: "workspace_dayova",
        timezone: "Europe/Berlin"
      },
      guildId: "guild_dayova",
      now: () => new Date("2026-07-11T13:00:00.000Z")
    });

    await bot.start();
    const responses = await Promise.all([
      transport.execute({
        type: "start",
        interactionId: "interaction_start_product_1",
        guildId: "guild_dayova",
        channelId: "channel_meeting_notes",
        actorDiscordUserId: "779381502311137301",
        occurredAt: "2026-07-11T13:00:00.000Z",
        title: "Product Meeting",
        languageMode: "multilingual"
      }),
      transport.execute({
        type: "start",
        interactionId: "interaction_start_product_2",
        guildId: "guild_dayova",
        channelId: "channel_meeting_notes",
        actorDiscordUserId: "726409024894926869",
        occurredAt: "2026-07-11T13:00:00.000Z",
        title: "Product Meeting",
        languageMode: "multilingual"
      })
    ]);

    expect(transport.createdThreads).toHaveLength(1);
    expect(responses.map((response) => response.content).sort()).toEqual(
      [
        "A Meeting is already active in https://discord.com/channels/guild_dayova/thread_product_1",
        "Meeting started in https://discord.com/channels/guild_dayova/thread_product_1"
      ].sort()
    );
  });

  it("creates distinct threads for sequential same-title Meetings", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new EmptyReasoningModel(),
      now: () => new Date("2026-07-11T14:00:00.000Z")
    });
    const transport = new ProgrammableDiscordTransport();
    const bot = createDiscordMeetingBot({
      database,
      meetingIntelligence,
      identityDirectory: createLumaTeamIdentityDirectory(),
      transport,
      workspace: {
        workspaceId: "workspace_dayova",
        timezone: "Europe/Berlin"
      },
      guildId: "guild_dayova",
      now: () => new Date("2026-07-11T14:00:00.000Z")
    });

    await bot.start();
    await transport.execute({
      type: "start",
      interactionId: "interaction_first_product",
      guildId: "guild_dayova",
      channelId: "channel_meeting_notes",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-11T13:00:00.000Z",
      title: "Product Meeting",
      languageMode: "multilingual"
    });
    await transport.execute({
      type: "stop",
      interactionId: "interaction_stop_first_product",
      guildId: "guild_dayova",
      channelId: "thread_product",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-11T13:30:00.000Z"
    });
    const response = await transport.execute({
      type: "start",
      interactionId: "interaction_second_product",
      guildId: "guild_dayova",
      channelId: "channel_meeting_notes",
      actorDiscordUserId: "726409024894926869",
      occurredAt: "2026-07-11T14:00:00.000Z",
      title: "Product Meeting",
      languageMode: "multilingual"
    });

    expect(transport.createdThreads).toEqual([
      {
        parentChannelId: "channel_meeting_notes",
        name: "Product Meeting - 11 Jul 2026 [discord_interaction_first_product]"
      },
      {
        parentChannelId: "channel_meeting_notes",
        name: "Product Meeting - 11 Jul 2026 [discord_interaction_second_product]"
      }
    ]);
    expect(response.content).toBe(
      "Meeting started in https://discord.com/channels/guild_dayova/thread_product_2"
    );
  });

  it("starts a Meeting in a persistent Discord thread", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new EmptyReasoningModel(),
      now: () => new Date("2026-07-11T13:00:00.000Z")
    });
    const transport = new ProgrammableDiscordTransport();
    const bot = createDiscordMeetingBot({
      database,
      meetingIntelligence,
      identityDirectory: createLumaTeamIdentityDirectory(),
      transport,
      workspace: {
        workspaceId: "workspace_dayova",
        timezone: "Europe/Berlin"
      },
      guildId: "guild_dayova",
      now: () => new Date("2026-07-11T13:00:00.000Z")
    });

    await bot.start();
    const response = await transport.execute({
      type: "start",
      interactionId: "interaction_start_product",
      guildId: "guild_dayova",
      channelId: "channel_meeting_notes",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-11T13:00:00.000Z",
      title: "Product Meeting",
      languageMode: "multilingual"
    });

    expect(transport.createdThreads).toEqual([
      {
        parentChannelId: "channel_meeting_notes",
        name: "Product Meeting - 11 Jul 2026 [discord_interaction_start_product]"
      }
    ]);
    expect(transport.sentMessages).toEqual([
      {
        channelId: "thread_product",
        content: "Meeting started: **Product Meeting**",
        idempotencyKey: "meeting:discord_interaction_start_product:started"
      }
    ]);
    expect(response).toEqual({
      content:
        "Meeting started in https://discord.com/channels/guild_dayova/thread_product"
    });
  });

  it("answers a Meeting question through the active Discord thread", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new EmptyReasoningModel(),
      now: () => new Date("2026-07-11T13:00:00.000Z")
    });
    const transport = new ProgrammableDiscordTransport();
    const bot = createDiscordMeetingBot({
      database,
      meetingIntelligence,
      identityDirectory: createLumaTeamIdentityDirectory(),
      transport,
      workspace: {
        workspaceId: "workspace_dayova",
        timezone: "Europe/Berlin"
      },
      guildId: "guild_dayova",
      now: () => new Date("2026-07-11T13:00:00.000Z")
    });

    await bot.start();
    await transport.execute({
      type: "start",
      interactionId: "interaction_start_product",
      guildId: "guild_dayova",
      channelId: "channel_meeting_notes",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-11T13:00:00.000Z",
      title: "Product Meeting",
      languageMode: "multilingual"
    });
    const response = await transport.execute({
      type: "ask",
      interactionId: "interaction_ask_release",
      guildId: "guild_dayova",
      channelId: "thread_product",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-11T13:05:00.000Z",
      question: "What did we decide about the release?"
    });

    expect(response).toEqual({
      content: "I do not have enough evidence to answer that factually.\n\nEvidence: none"
    });
  });

  it("returns a grounded catch-up from the active Discord thread", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new EmptyReasoningModel(),
      now: () => new Date("2026-07-11T13:00:00.000Z")
    });
    const transport = new ProgrammableDiscordTransport();
    const bot = createDiscordMeetingBot({
      database,
      meetingIntelligence,
      identityDirectory: createLumaTeamIdentityDirectory(),
      transport,
      workspace: {
        workspaceId: "workspace_dayova",
        timezone: "Europe/Berlin"
      },
      guildId: "guild_dayova",
      now: () => new Date("2026-07-11T13:00:00.000Z")
    });

    await bot.start();
    await transport.execute({
      type: "start",
      interactionId: "interaction_start_product",
      guildId: "guild_dayova",
      channelId: "channel_meeting_notes",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-11T13:00:00.000Z",
      title: "Product Meeting",
      languageMode: "multilingual"
    });
    const response = await transport.execute({
      type: "catchup",
      interactionId: "interaction_catchup_product",
      guildId: "guild_dayova",
      channelId: "thread_product",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-11T13:10:00.000Z",
      sinceRevision: 0
    });

    expect(response).toEqual({
      content: "No grounded changes are available for this Meeting yet.\n\nEvidence: none"
    });
  });

  it("ends a Meeting and posts its Conclusion in the persistent thread", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new EmptyReasoningModel(),
      now: () => new Date("2026-07-11T13:30:00.000Z")
    });
    const transport = new ProgrammableDiscordTransport();
    const bot = createDiscordMeetingBot({
      database,
      meetingIntelligence,
      identityDirectory: createLumaTeamIdentityDirectory(),
      transport,
      workspace: {
        workspaceId: "workspace_dayova",
        timezone: "Europe/Berlin"
      },
      guildId: "guild_dayova",
      now: () => new Date("2026-07-11T13:30:00.000Z")
    });

    await bot.start();
    const startCommand: DiscordCommand = {
      type: "start",
      interactionId: "interaction_start_product",
      guildId: "guild_dayova",
      channelId: "channel_meeting_notes",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-11T13:00:00.000Z",
      title: "Product Meeting",
      languageMode: "multilingual"
    };
    await transport.execute(startCommand);
    await database.query(
      `UPDATE discord_meeting_threads
          SET start_message_sent_at = NULL
        WHERE workspace_id = $1 AND meeting_id = $2`,
      ["workspace_dayova", "discord_interaction_start_product"]
    );
    const startRetry = await transport.execute(startCommand);
    const stopCommand: DiscordCommand = {
      type: "stop",
      interactionId: "interaction_stop_product",
      guildId: "guild_dayova",
      channelId: "thread_product",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-11T13:30:00.000Z"
    };
    const response = await transport.execute(stopCommand);
    await database.query(
      `UPDATE discord_meeting_threads
          SET ended_at = NULL, conclusion_message_sent_at = NULL
        WHERE workspace_id = $1 AND meeting_id = $2`,
      ["workspace_dayova", "discord_interaction_start_product"]
    );
    const stopRetry = await transport.execute(stopCommand);

    expect(transport.sentMessages).toEqual([
      {
        channelId: "thread_product",
        content: "Meeting started: **Product Meeting**",
        idempotencyKey: "meeting:discord_interaction_start_product:started"
      },
      {
        channelId: "thread_product",
        content:
          "Meeting ended: **Product Meeting**\n\nThe Meeting has no grounded Action Items yet.",
        idempotencyKey: "meeting:discord_interaction_start_product:conclusion:2"
      }
    ]);
    expect(startRetry).toEqual({
      content:
        "A Meeting is already active in https://discord.com/channels/guild_dayova/thread_product"
    });
    expect(response).toEqual({
      content: "Meeting ended. The Conclusion was posted in the Meeting thread."
    });
    expect(stopRetry).toEqual(response);
  });

  it("posts a bot-authored Follow-up receipt with explicit Discord mentions", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new EmptyReasoningModel(),
      now: () => new Date("2026-07-11T13:00:00.000Z")
    });
    const transport = new ProgrammableDiscordTransport();
    const bot = createDiscordMeetingBot({
      database,
      meetingIntelligence,
      identityDirectory: createLumaTeamIdentityDirectory(),
      transport,
      workspace: {
        workspaceId: "workspace_dayova",
        timezone: "Europe/Berlin"
      },
      guildId: "guild_dayova",
      now: () => new Date("2026-07-11T13:00:00.000Z")
    });

    await bot.start();
    await transport.execute({
      type: "start",
      interactionId: "interaction_start_product",
      guildId: "guild_dayova",
      channelId: "channel_meeting_notes",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-11T13:00:00.000Z",
      title: "Product Meeting",
      languageMode: "multilingual"
    });
    await bot.publishMeetingEvents({
      workspaceId: "workspace_dayova",
      meetingId: "discord_interaction_start_product",
      mentionPersonIds: ["person_jakob", "person_fabius"],
      events: [
        {
          type: "follow-up-execution-succeeded",
          intentId: "intent_github_issue",
          externalReferences: [
            {
              providerId: "github-issues",
              objectType: "work-item",
              externalId: "312",
              url: "https://github.com/Dayova/dayova-mvp/issues/312"
            }
          ],
          summary: "Created GitHub Issue #312"
        }
      ]
    });

    expect(transport.sentMessages.at(-1)).toEqual({
      channelId: "thread_product",
      content: [
        "Follow-up completed",
        "",
        "Created GitHub Issue #312",
        "GitHub: https://github.com/Dayova/dayova-mvp/issues/312",
        "",
        "<@779381502311137301> <@726409024894926869>"
      ].join("\n"),
      allowedUserIds: ["779381502311137301", "726409024894926869"]
    });
  });

  it("renders the provider-independent Follow-up lifecycle in Discord", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new EmptyReasoningModel(),
      now: () => new Date("2026-07-11T13:00:00.000Z")
    });
    const transport = new ProgrammableDiscordTransport();
    const bot = createDiscordMeetingBot({
      database,
      meetingIntelligence,
      identityDirectory: createLumaTeamIdentityDirectory(),
      transport,
      workspace: {
        workspaceId: "workspace_dayova",
        timezone: "Europe/Berlin"
      },
      guildId: "guild_dayova",
      now: () => new Date("2026-07-11T13:00:00.000Z")
    });

    await bot.start();
    await transport.execute({
      type: "start",
      interactionId: "interaction_start_product",
      guildId: "guild_dayova",
      channelId: "channel_meeting_notes",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-11T13:00:00.000Z",
      title: "Product Meeting",
      languageMode: "multilingual"
    });
    await bot.publishMeetingEvents({
      workspaceId: "workspace_dayova",
      meetingId: "discord_interaction_start_product",
      events: [
        {
          type: "follow-up-awaiting-approval",
          intentIds: ["intent_issue", "intent_notes"]
        },
        {
          type: "follow-up-execution-started",
          intentId: "intent_issue"
        },
        {
          type: "follow-up-execution-partially-succeeded",
          intentId: "intent_issue",
          externalReferences: [
            {
              providerId: "github-issues",
              objectType: "work-item",
              externalId: "312",
              url: "https://github.com/Dayova/dayova-mvp/issues/312"
            }
          ],
          message: "The issue was created, but its assignee could not be resolved."
        },
        {
          type: "follow-up-execution-failed",
          intentId: "intent_notes",
          message: "Confluence is temporarily unavailable.",
          retryable: true
        },
        {
          type: "action-item-status-changed",
          actionItemId: "action_release",
          previousStatus: "planned",
          currentStatus: "completed",
          externalReferences: []
        },
        {
          type: "meeting-follow-up-completed",
          meetingId: "discord_interaction_start_product",
          completedIntentIds: ["intent_issue"],
          outstandingIntentIds: ["intent_notes"]
        }
      ]
    });

    expect(transport.sentMessages.slice(1).map((message) => message.content)).toEqual([
      "Follow-up approval needed\n\nIntents: intent_issue, intent_notes",
      "Follow-up started\n\nIntent: intent_issue",
      [
        "Follow-up needs attention",
        "",
        "The issue was created, but its assignee could not be resolved.",
        "GitHub: https://github.com/Dayova/dayova-mvp/issues/312"
      ].join("\n"),
      "Follow-up failed\n\nConfluence is temporarily unavailable.\nRetry: available",
      "Action Item status changed\n\naction_release: planned -> completed",
      [
        "Meeting follow-up completed",
        "",
        "Completed: intent_issue",
        "Outstanding: intent_notes"
      ].join("\n")
    ]);
  });
});
