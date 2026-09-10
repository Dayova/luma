import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  type DiscordContextAskResponse,
  type DiscordThread,
  type DiscordTransport
} from "../../src/discord/discord-meeting-bot.js";
import type { ContextIntelligence } from "../../src/context-intelligence/interface.js";
import type {
  ContextInquiry,
  ContextInquiryResult
} from "../../src/context-intelligence/interface.js";
import type { DiscordChannelSurface } from "../../src/discord/discord-channel-scope.js";
import type { DiscordContextAskMention } from "../../src/discord/discord-context-ask-runtime.js";
import {
  createIdentityDirectoryFromEnv,
  createLumaTeamIdentityDirectory
} from "../../src/identity/static-identity-directory.js";
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

class ActionReasoningModel implements ReasoningModel {
  generateStructured<T>(
    request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    const evidence = request.evidence[0];
    if (!evidence?.excerpt) {
      throw new Error("expected original Meeting evidence");
    }
    const value: MeetingAnalysisProposalBatch = {
      actionItems: [
        {
          stableKey: "release-checklist",
          description: evidence.excerpt,
          ownerId: "person_jakob",
          dueDate: {
            originalPhrase: null,
            normalizedDate: null,
            confidence: "unknown",
            timezone: "Europe/Berlin"
          },
          status: "candidate",
          relatedDecisionIds: [],
          evidenceIds: [evidence.evidenceId],
          confidence: "high"
        }
      ],
      decisions: [],
      openQuestions: [],
      risks: [],
      followUpIntentions: []
    };
    return Promise.resolve({
      value: value as T,
      metadata: {
        provider: "test",
        model: "action",
        promptVersion: request.promptVersion
      }
    });
  }
}

class RecordingContextIntelligence implements ContextIntelligence {
  readonly inquiries: ContextInquiry[] = [];

  constructor(
    private readonly result: ContextInquiryResult | Error = contextInquiryResult()
  ) {}

  inquire(input: ContextInquiry): Promise<ContextInquiryResult> {
    this.inquiries.push(input);

    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result);
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
  private contextAskHandler:
    | ((ask: DiscordContextAskMention) => Promise<DiscordContextAskResponse | null>)
    | null = null;
  protected readonly channels = new Map<string, DiscordChannelSurface>([
    [
      "channel_meeting_notes",
      {
        id: "channel_meeting_notes",
        guildId: "guild_dayova",
        kind: "text-channel",
        parentChannelId: null
      }
    ],
    [
      "channel_context",
      {
        id: "channel_context",
        guildId: "guild_dayova",
        kind: "text-channel",
        parentChannelId: null
      }
    ],
    [
      "thread_context",
      {
        id: "thread_context",
        guildId: "guild_dayova",
        kind: "public-thread",
        parentChannelId: "channel_context"
      }
    ]
  ]);
  private readonly threads = new Map<string, DiscordThread>();
  private readonly deliveredMessageKeys = new Set<string>();

  connect(
    commandHandler: (command: DiscordCommand) => Promise<DiscordCommandResponse>,
    contextAskHandler?: (
      ask: DiscordContextAskMention
    ) => Promise<DiscordContextAskResponse | null>
  ): Promise<void> {
    this.commandHandler = commandHandler;
    this.contextAskHandler = contextAskHandler ?? null;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  resolveChannel(input: { channelId: string }): Promise<DiscordChannelSurface | null> {
    return Promise.resolve(this.channels.get(input.channelId) ?? null);
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
    this.channels.set(thread.id, {
      id: thread.id,
      guildId: "guild_dayova",
      kind: "public-thread",
      parentChannelId: input.parentChannelId
    });

    return Promise.resolve(thread);
  }

  seedThread(input: {
    parentChannelId: string;
    name: string;
    thread: DiscordThread;
  }): void {
    this.threads.set(this.threadKey(input), input.thread);
    this.channels.set(input.thread.id, {
      id: input.thread.id,
      guildId: "guild_dayova",
      kind: "public-thread",
      parentChannelId: input.parentChannelId
    });
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

  executeContextAsk(
    ask: DiscordContextAskMention
  ): Promise<DiscordContextAskResponse | null> {
    if (!this.contextAskHandler) {
      throw new Error("Discord Context Ask handler is not connected");
    }

    return this.contextAskHandler(ask);
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

    const thread = {
      id: `thread_product_${sequence}`,
      url: `https://discord.com/channels/guild_dayova/thread_product_${sequence}`
    };
    this.channels.set(thread.id, {
      id: thread.id,
      guildId: "guild_dayova",
      kind: "public-thread",
      parentChannelId: input.parentChannelId
    });
    return Promise.resolve(thread);
  }
}

describe("Discord meeting bot", () => {
  it("keeps an ended Meeting readable in its exact thread after restart and a newer Meeting", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "luma-ended-meeting-"));
    let database = await createPgliteDatabase(dataDir);
    const transport = new ProgrammableDiscordTransport();
    const makeBot = () =>
      createDiscordMeetingBot({
        allowedParentChannelIds: ["channel_meeting_notes"],
        authorizedPersonIds: [
          "person_jakob",
          "person_fabius",
          "person_philipp",
          "person_julius"
        ],
        database,
        meetingIntelligence: createMeetingIntelligence({
          database,
          reasoningModel: new ActionReasoningModel(),
          now: () => new Date("2026-07-11T14:00:00.000Z")
        }),
        identityDirectory: createLumaTeamIdentityDirectory(),
        transport,
        workspace: { workspaceId: "workspace_dayova", timezone: "Europe/Berlin" },
        guildId: "guild_dayova",
        now: () => new Date("2026-07-11T14:00:00.000Z")
      });
    let bot = makeBot();
    const base = {
      guildId: "guild_dayova",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-11T13:00:00.000Z"
    };
    const ask: DiscordCommand = {
      ...base,
      type: "ask",
      interactionId: "ask_ended_meeting",
      channelId: "thread_product",
      actorDiscordUserId: "779381502311137301",
      question: "Which action items remain?"
    };
    const catchup: DiscordCommand = {
      ...base,
      type: "catchup",
      interactionId: "catchup_ended_meeting",
      channelId: "thread_product",
      sinceRevision: 0
    };

    try {
      await bot.start();
      await transport.execute({
        ...base,
        type: "start",
        interactionId: "start_ended_meeting",
        channelId: "channel_meeting_notes",
        title: "Original Meeting",
        languageMode: "en"
      });
      await transport.execute({
        ...base,
        type: "note",
        interactionId: "note_ended_meeting",
        channelId: "thread_product",
        text: "I will prepare the original release checklist.",
        language: "en"
      });
      const originalAnswer = await transport.execute(ask);
      const originalCatchup = await transport.execute(catchup);
      expect(originalAnswer.content).toContain(
        "I will prepare the original release checklist."
      );
      expect(originalCatchup.content).toContain(
        "I will prepare the original release checklist."
      );
      await transport.execute({
        ...base,
        type: "stop",
        interactionId: "stop_ended_meeting",
        channelId: "thread_product",
        occurredAt: "2026-07-11T13:30:00.000Z"
      });
      await bot.stop();
      await database.close();
      database = await createPgliteDatabase(dataDir);
      bot = makeBot();
      await bot.start();

      for (const query of [ask, catchup]) {
        const parentResponse = await transport.execute({
          ...query,
          channelId: "channel_meeting_notes"
        });
        expect(parentResponse.content).toBe(
          "There is no active Meeting in this Discord channel."
        );
      }
      expect(await transport.execute(ask)).toEqual(originalAnswer);
      expect(await transport.execute(catchup)).toEqual(originalCatchup);

      await transport.execute({
        ...base,
        type: "start",
        interactionId: "start_newer_meeting",
        channelId: "channel_meeting_notes",
        title: "Newer Meeting",
        languageMode: "en",
        occurredAt: "2026-07-11T14:00:00.000Z"
      });
      expect(await transport.execute(ask)).toEqual(originalAnswer);
      expect(await transport.execute(catchup)).toEqual(originalCatchup);
      const parentAnswer = await transport.execute({
        ...ask,
        channelId: "channel_meeting_notes"
      });
      expect(parentAnswer.content).toBe(
        "I do not have enough evidence to answer that factually.\n\nEvidence: none"
      );
      const parentCatchup = await transport.execute({
        ...catchup,
        channelId: "channel_meeting_notes"
      });
      expect(parentCatchup.content).toBe(
        "No grounded changes are available for this Meeting yet.\n\nEvidence: none"
      );
      for (const command of [
        {
          ...base,
          type: "note",
          interactionId: "note_after_end",
          channelId: "thread_product",
          text: "A later note",
          language: "en"
        },
        {
          ...base,
          type: "stop",
          interactionId: "stop_again",
          channelId: "thread_product"
        }
      ] satisfies DiscordCommand[]) {
        expect((await transport.execute(command)).content).toBe(
          "There is no active Meeting in this Discord channel."
        );
      }
      expect(
        (await transport.execute({ ...ask, guildId: "another_guild" })).content
      ).toBe("Luma is not configured for this Discord server.");
    } finally {
      await bot.stop();
      await database.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each(["configured nonfounder", "unmapped", "ambiguous", "identity unavailable"])(
    "denies every command and Context Ask for %s before side effects",
    async (scenario) => {
      const database = await createPgliteDatabase();
      const transport = new ProgrammableDiscordTransport();
      const contextIntelligence = new RecordingContextIntelligence();
      const actorDiscordUserId =
        scenario === "ambiguous"
          ? "779381502311137301"
          : scenario === "unmapped"
            ? "unmapped"
            : "discord_guest";
      const directory = createIdentityDirectoryFromEnv({
        LUMA_IDENTITY_PEOPLE_JSON: JSON.stringify([
          {
            personId: "person_guest",
            displayName: "Guest",
            discordUserId: scenario === "ambiguous" ? actorDiscordUserId : "discord_guest"
          }
        ])
      });
      let identityUnavailable = false;
      let meetingCalls = 0;
      let executionCalls = 0;
      const meetingIntelligence = createMeetingIntelligence({
        database,
        reasoningModel: new EmptyReasoningModel()
      });
      const deniedExecution = () => {
        executionCalls += 1;
        return Promise.reject(new Error("Unauthorized Follow-up execution"));
      };
      const bot = createDiscordMeetingBot({
        allowedParentChannelIds: ["channel_meeting_notes"],
        authorizedPersonIds: [
          "person_jakob",
          "person_fabius",
          "person_philipp",
          "person_julius"
        ],
        database,
        meetingIntelligence: {
          observe(input) {
            meetingCalls += 1;
            return meetingIntelligence.observe(input);
          },
          query(input) {
            meetingCalls += 1;
            return meetingIntelligence.query(input);
          },
          conclude(input) {
            meetingCalls += 1;
            return meetingIntelligence.conclude(input);
          }
        },
        followUpExecution: { execute: deniedExecution, recover: deniedExecution },
        identityDirectory: {
          ...directory,
          findPeopleByProviderUserId: (input) =>
            identityUnavailable
              ? Promise.reject(new Error("private identity provider error"))
              : directory.findPeopleByProviderUserId(input)
        },
        transport,
        workspace: { workspaceId: "workspace_dayova", timezone: "Europe/Berlin" },
        guildId: "guild_dayova",
        contextAsk: {
          contextIntelligence,
          config: {
            parentChannelIds: ["channel_meeting_notes"],
            allowedDiscordUserIds: [actorDiscordUserId],
            maxMessages: 50,
            maxEvidenceChars: 32_000,
            minIntervalMs: 60_000
          }
        }
      });

      try {
        await bot.start();
        const base = {
          guildId: "guild_dayova",
          channelId: "channel_meeting_notes",
          actorDiscordUserId,
          occurredAt: "2026-09-08T10:00:00.000Z"
        };
        await transport.execute({
          ...base,
          type: "start",
          interactionId: "founder_start",
          actorDiscordUserId: "726409024894926869",
          title: "Founder Meeting",
          languageMode: "en"
        });
        const messages = [...transport.sentMessages];
        meetingCalls = 0;
        identityUnavailable = scenario === "identity unavailable";
        for (const payload of [
          { type: "start", title: "Unauthorized Meeting", languageMode: "multilingual" },
          { type: "ask", question: "What did the founders decide?" },
          { type: "catchup", sinceRevision: 0 },
          { type: "note", text: "I will publish the source", language: "en" },
          { type: "approve", intentId: "private_intent" },
          { type: "recover", intentId: "private_intent" },
          { type: "reject", intentId: "private_intent" },
          { type: "stop" }
        ] as const) {
          await expect(
            transport.execute({
              ...base,
              ...payload,
              interactionId: `denied_${payload.type}`
            })
          ).resolves.toEqual({
            content: "You do not have access to Luma in this workspace."
          });
        }
        await expect(
          transport.executeContextAsk({
            ...base,
            channelId: "thread_product",
            parentChannelId: "channel_meeting_notes",
            messageId: "denied_context_ask",
            question: "What did the founders decide?"
          })
        ).resolves.toBeNull();
        expect(contextIntelligence.inquiries).toEqual([]);
        expect(meetingCalls).toBe(0);
        expect(executionCalls).toBe(0);
        expect(transport.createdThreads).toHaveLength(1);
        expect(transport.sentMessages).toEqual(messages);
      } finally {
        await bot.stop();
        await database.close();
      }
    }
  );

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
      allowedParentChannelIds: ["channel_meeting_notes"],
      authorizedPersonIds: [
        "person_jakob",
        "person_fabius",
        "person_philipp",
        "person_julius"
      ],
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
    await expect(transport.execute(command)).resolves.toEqual({
      content:
        "Luma could not answer this request right now. Please try again later. You can check /meeting usage without an AI call."
    });
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
      allowedParentChannelIds: ["channel_meeting_notes"],
      authorizedPersonIds: [
        "person_jakob",
        "person_fabius",
        "person_philipp",
        "person_julius"
      ],
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
      allowedParentChannelIds: ["channel_meeting_notes"],
      authorizedPersonIds: [
        "person_jakob",
        "person_fabius",
        "person_philipp",
        "person_julius"
      ],
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
      allowedParentChannelIds: ["channel_meeting_notes"],
      authorizedPersonIds: [
        "person_jakob",
        "person_fabius",
        "person_philipp",
        "person_julius"
      ],
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
      allowedParentChannelIds: ["channel_meeting_notes"],
      authorizedPersonIds: [
        "person_jakob",
        "person_fabius",
        "person_philipp",
        "person_julius"
      ],
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
      allowedParentChannelIds: ["channel_meeting_notes"],
      authorizedPersonIds: [
        "person_jakob",
        "person_fabius",
        "person_philipp",
        "person_julius"
      ],
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

  it("routes an allowlisted thread mention through Context Intelligence without creating a Meeting or Follow-up", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new EmptyReasoningModel(),
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });
    const transport = new ProgrammableDiscordTransport();
    const contextIntelligence = new RecordingContextIntelligence();
    const bot = createDiscordMeetingBot({
      allowedParentChannelIds: ["channel_context"],
      authorizedPersonIds: [
        "person_jakob",
        "person_fabius",
        "person_philipp",
        "person_julius"
      ],
      database,
      meetingIntelligence,
      identityDirectory: createLumaTeamIdentityDirectory(),
      transport,
      workspace: {
        workspaceId: "workspace_dayova",
        timezone: "Europe/Berlin"
      },
      guildId: "guild_dayova",
      contextAsk: {
        contextIntelligence,
        config: {
          parentChannelIds: ["channel_context"],
          allowedDiscordUserIds: ["779381502311137301"],
          maxMessages: 50,
          maxEvidenceChars: 32_000,
          minIntervalMs: 60_000
        }
      }
    });

    await bot.start();
    const response = await transport.executeContextAsk({
      messageId: "message_context_ask",
      guildId: "guild_dayova",
      channelId: "thread_context",
      parentChannelId: "channel_context",
      actorDiscordUserId: "779381502311137301",
      question: "What did we decide about the release?",
      occurredAt: "2026-08-08T10:00:00.000Z"
    });

    expect(contextIntelligence.inquiries).toEqual([
      {
        type: "ask",
        workspaceId: "workspace_dayova",
        inquiryId: "discord:message_context_ask:context-ask",
        question: "What did we decide about the release?",
        audience: {
          workspaceId: "workspace_dayova",
          personIds: ["person_jakob", "person_fabius", "person_philipp", "person_julius"]
        },
        subject: {
          type: "conversation-thread",
          providerId: "discord",
          conversationObjectId: "thread_context",
          anchorMessageId: "message_context_ask"
        }
      }
    ]);
    expect(response?.content).toContain("Luma Ask");
    expect(response?.idempotencyKey).toBe(
      "discord:message_context_ask:context-ask:reply"
    );
    expect(transport.createdThreads).toEqual([]);
    expect(transport.sentMessages).toEqual([]);
    await expect(
      database.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM meetings")
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("does not send a Context inquiry outside its reviewed parent/user scope", async () => {
    const database = await createPgliteDatabase();
    const transport = new ProgrammableDiscordTransport();
    const contextIntelligence = new RecordingContextIntelligence();
    const bot = createDiscordMeetingBot({
      allowedParentChannelIds: ["channel_context"],
      authorizedPersonIds: [
        "person_jakob",
        "person_fabius",
        "person_philipp",
        "person_julius"
      ],
      database,
      meetingIntelligence: createMeetingIntelligence({
        database,
        reasoningModel: new EmptyReasoningModel()
      }),
      identityDirectory: createLumaTeamIdentityDirectory(),
      transport,
      workspace: {
        workspaceId: "workspace_dayova",
        timezone: "Europe/Berlin"
      },
      guildId: "guild_dayova",
      contextAsk: {
        contextIntelligence,
        config: {
          parentChannelIds: ["channel_context"],
          allowedDiscordUserIds: ["779381502311137301"],
          maxMessages: 50,
          maxEvidenceChars: 32_000,
          minIntervalMs: 60_000
        }
      }
    });

    await bot.start();
    await expect(
      transport.executeContextAsk({
        messageId: "message_outside_scope",
        guildId: "guild_dayova",
        channelId: "thread_elsewhere",
        parentChannelId: "channel_elsewhere",
        actorDiscordUserId: "779381502311137301",
        question: "What did we decide?",
        occurredAt: "2026-08-08T10:00:00.000Z"
      })
    ).resolves.toBeNull();
    expect(contextIntelligence.inquiries).toEqual([]);
  });

  it("does not disclose Context provider errors in a public thread reply", async () => {
    const database = await createPgliteDatabase();
    const transport = new ProgrammableDiscordTransport();
    const bot = createDiscordMeetingBot({
      allowedParentChannelIds: ["channel_context"],
      authorizedPersonIds: [
        "person_jakob",
        "person_fabius",
        "person_philipp",
        "person_julius"
      ],
      database,
      meetingIntelligence: createMeetingIntelligence({
        database,
        reasoningModel: new EmptyReasoningModel()
      }),
      identityDirectory: createLumaTeamIdentityDirectory(),
      transport,
      workspace: {
        workspaceId: "workspace_dayova",
        timezone: "Europe/Berlin"
      },
      guildId: "guild_dayova",
      contextAsk: {
        contextIntelligence: new RecordingContextIntelligence(
          new Error("provider secret: should not escape")
        ),
        config: {
          parentChannelIds: ["channel_context"],
          allowedDiscordUserIds: ["779381502311137301"],
          maxMessages: 50,
          maxEvidenceChars: 32_000,
          minIntervalMs: 60_000
        }
      }
    });

    await bot.start();
    const response = await transport.executeContextAsk({
      messageId: "message_provider_failure",
      guildId: "guild_dayova",
      channelId: "thread_context",
      parentChannelId: "channel_context",
      actorDiscordUserId: "779381502311137301",
      question: "What did we decide?",
      occurredAt: "2026-08-08T10:00:00.000Z"
    });

    expect(response).toEqual({
      content:
        "Luma could not answer this request right now. Please try again later. You can check /meeting usage without an AI call.",
      idempotencyKey: "discord:message_provider_failure:context-ask:reply"
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
      allowedParentChannelIds: ["channel_meeting_notes"],
      authorizedPersonIds: [
        "person_jakob",
        "person_fabius",
        "person_philipp",
        "person_julius"
      ],
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
      allowedParentChannelIds: ["channel_meeting_notes"],
      authorizedPersonIds: [
        "person_jakob",
        "person_fabius",
        "person_philipp",
        "person_julius"
      ],
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

  it("keeps a scoped answer intact while reporting Evidence references that do not fit in Discord", async () => {
    const database = await createPgliteDatabase();
    const reasoningModel: ReasoningModel = {
      generateStructured<T>(
        request: StructuredReasoningRequest<T>
      ): Promise<StructuredReasoningResult<T>> {
        const value: MeetingAnalysisProposalBatch = {
          decisions: request.evidence.map((reference, index) => ({
            stableKey: `discord-bounds-${index}`,
            statement: reference.excerpt ?? "",
            rationale: [],
            status: "confirmed",
            supportingParticipantIds: [],
            objectingParticipantIds: [],
            relatedTopicIds: [],
            evidenceIds: [reference.evidenceId],
            confidence: "high"
          })),
          actionItems: [],
          openQuestions: [],
          risks: [],
          followUpIntentions: []
        };
        return Promise.resolve({
          value: value as T,
          metadata: {
            provider: "test",
            model: "bounded-decisions",
            promptVersion: request.promptVersion
          }
        });
      }
    };
    const meetingIntelligence = createMeetingIntelligence({ database, reasoningModel });
    const transport = new ProgrammableDiscordTransport();
    const workspace = { workspaceId: "workspace_dayova", timezone: "Europe/Berlin" };
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
      allowedParentChannelIds: ["channel_meeting_notes"],
      transport,
      workspace,
      guildId: "guild_dayova"
    });
    const base = {
      guildId: "guild_dayova",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-09-09T12:00:00.000Z"
    };
    try {
      await bot.start();
      await transport.execute({
        ...base,
        type: "start",
        interactionId: "bounded",
        channelId: "channel_meeting_notes",
        title: "Release bounds",
        languageMode: "en"
      });
      const update = await meetingIntelligence.observe({
        workspace,
        observations: Array.from({ length: 8 }, (_, index) => ({
          type: "utterance-committed" as const,
          observationId: `bounded:observation:${index}`,
          workspaceId: workspace.workspaceId,
          meetingId: "discord_bounded",
          occurredAt: base.occurredAt,
          observedAt: base.occurredAt,
          utteranceId: `long_source_${index}_${"x".repeat(140)}`,
          version: 1,
          speaker: {
            status: "attributed" as const,
            personId: "person_jakob",
            confidence: "deterministic" as const,
            basis: "provider-identity" as const
          },
          startedAt: base.occurredAt,
          endedAt: base.occurredAt,
          originalText: `Release rule ${index}: ${"Keep the original source and review context. ".repeat(2)}END-${index}`,
          language: "en" as const
        }))
      });
      expect(update.errors).toEqual([]);
      const answer = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "discord_bounded",
        query: { type: "freeform", text: "What did we decide?" }
      });
      if (answer.type !== "freeform") throw new Error("Expected a scoped answer");
      expect(answer.answer.evidence).toHaveLength(8);
      const response = await transport.execute({
        ...base,
        type: "ask",
        interactionId: "bounded_ask",
        channelId: "thread_product",
        question: "What did we decide?"
      });
      expect(response.content.startsWith(`${answer.answer.text}\n\nEvidence:`)).toBe(
        true
      );
      expect(response.content.length).toBeLessThanOrEqual(2000);
      expect(response.content).toContain(
        "additional reference(s) retained in the Meeting record"
      );
      const referenceSection = response.content.slice(answer.answer.text.length);
      for (const reference of answer.answer.evidence) {
        if (referenceSection.includes(reference.sourceObjectId.slice(0, 20))) {
          expect(referenceSection).toContain(
            `${reference.source}:${reference.sourceObjectId}`
          );
        }
      }
      const unchanged = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "discord_bounded",
        query: { type: "freeform", text: "What did we decide?" }
      });
      expect(unchanged).toEqual(answer);
    } finally {
      await bot.stop();
      await database.close();
    }
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
      allowedParentChannelIds: ["channel_meeting_notes"],
      authorizedPersonIds: [
        "person_jakob",
        "person_fabius",
        "person_philipp",
        "person_julius"
      ],
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
      allowedParentChannelIds: ["channel_meeting_notes"],
      authorizedPersonIds: [
        "person_jakob",
        "person_fabius",
        "person_philipp",
        "person_julius"
      ],
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

function contextInquiryResult(): ContextInquiryResult {
  const evidence = {
    evidenceId: "discord:message_release",
    providerId: "discord",
    conversationObjectId: "thread_context",
    anchorMessageId: "message_context_ask",
    sourceRevision: 1,
    messageId: "message_release",
    ordinal: 0,
    author: {
      providerUserId: "779381502311137301",
      displayName: "Jakob",
      personId: null
    },
    createdAt: "2026-08-08T09:00:00.000Z",
    editedAt: null,
    replyToMessageId: null,
    url: "https://discord.com/channels/1/2/3",
    state: "available" as const,
    text: "We might ship on Friday."
  };

  return {
    type: "answer",
    inquiryId: "discord:message_context_ask:context-ask",
    question: "What did we decide about the release?",
    subject: {
      type: "conversation-thread",
      providerId: "discord",
      conversationObjectId: "thread_context",
      anchorMessageId: "message_context_ask"
    },
    boundary: {
      mode: "thread",
      anchorMessageId: "message_context_ask",
      firstMessageId: "message_release",
      lastMessageId: "message_context_ask",
      messageIds: ["message_release", "message_context_ask"],
      sourceRevision: 1,
      contentHash: "a".repeat(64),
      completeness: "complete"
    },
    answer: {
      text: "The release might ship on Friday.",
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
