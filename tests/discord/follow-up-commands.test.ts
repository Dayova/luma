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
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import { createLumaTeamIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import type {
  CreateWorkItemInput,
  WorkItem,
  WorkProvider,
  WorkQuery
} from "../../src/work/interface.js";
import type { ExternalReference } from "../../src/domain/model.js";

class FollowUpReasoningModel implements ReasoningModel {
  generateStructured<T>(
    request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    const evidence = request.evidence[0];

    if (!evidence) {
      throw new Error("expected evidence");
    }

    const value: MeetingAnalysisProposalBatch = {
      actionItems: [],
      decisions: [],
      openQuestions: [],
      risks: [],
      followUpIntentions: [
        {
          id: "intent_linear_release",
          type: "create-work-item",
          title: "Prepare the release checklist",
          description: "Prepare the release checklist discussed in the Meeting.",
          assigneeId: "person_jakob",
          mentionPersonIds: ["person_fabius"],
          dueDate: "2026-07-20",
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
        model: "follow-up",
        promptVersion: request.promptVersion
      }
    });
  }
}

class LinearWorkProvider implements WorkProvider {
  readonly providerId = "linear";
  readonly createCalls: CreateWorkItemInput[] = [];
  readonly recoveryKeys: string[] = [];
  recoveredWorkItem: ExternalReference | null = null;

  searchWorkItems(_query: WorkQuery): Promise<WorkItem[]> {
    void _query;
    return Promise.resolve([]);
  }

  getWorkItem(_id: string): Promise<WorkItem> {
    void _id;
    return Promise.reject(new Error("not needed"));
  }

  createWorkItem(input: CreateWorkItemInput): Promise<ExternalReference> {
    this.createCalls.push(input);
    return Promise.resolve({
      providerId: this.providerId,
      objectType: "work-item",
      externalId: "DAY-301",
      url: "https://linear.app/dayova/issue/DAY-301"
    });
  }

  findCreatedWorkItemByIdempotencyKey(
    idempotencyKey: string
  ): Promise<ExternalReference | null> {
    this.recoveryKeys.push(idempotencyKey);
    return Promise.resolve(this.recoveredWorkItem);
  }

  updateWorkItem(): Promise<ExternalReference> {
    return Promise.reject(new Error("not needed"));
  }

  addComment(): Promise<void> {
    return Promise.reject(new Error("not needed"));
  }
}

class TestDiscordTransport implements DiscordTransport {
  readonly sentMessages: Array<{
    channelId: string;
    content: string;
    allowedUserIds?: string[];
    idempotencyKey?: string;
  }> = [];
  private handler: ((command: DiscordCommand) => Promise<DiscordCommandResponse>) | null =
    null;

  connect(
    handler: (command: DiscordCommand) => Promise<DiscordCommandResponse>
  ): Promise<void> {
    this.handler = handler;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  createThread(): Promise<DiscordThread> {
    return Promise.resolve({
      id: "thread_product",
      url: "https://discord.com/channels/guild_dayova/thread_product"
    });
  }

  sendMessage(input: {
    channelId: string;
    content: string;
    allowedUserIds?: string[];
    idempotencyKey?: string;
  }): Promise<void> {
    this.sentMessages.push(input);
    return Promise.resolve();
  }

  execute(command: DiscordCommand): Promise<DiscordCommandResponse> {
    if (!this.handler) {
      throw new Error("transport is not connected");
    }

    return this.handler(command);
  }
}

describe("Discord follow-up commands", () => {
  it("preserves typed evidence and fails closed for an unbound generic Linear intent", async () => {
    const database = await createPgliteDatabase();
    const identityDirectory = createLumaTeamIdentityDirectory();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new FollowUpReasoningModel(),
      now: () => new Date("2026-07-16T09:05:00.000Z")
    });
    const workProvider = new LinearWorkProvider();
    const followUpExecution = createFollowUpExecution({
      database,
      meetingIntelligence,
      identityDirectory,
      workProvider,
      now: () => new Date("2026-07-16T09:06:00.000Z")
    });
    const transport = new TestDiscordTransport();
    const bot = createDiscordMeetingBot({
      database,
      meetingIntelligence,
      followUpExecution,
      identityDirectory,
      transport,
      workspace: {
        workspaceId: "workspace_dayova",
        timezone: "Europe/Berlin"
      },
      guildId: "guild_dayova",
      now: () => new Date("2026-07-16T09:05:00.000Z")
    });

    await bot.start();
    await transport.execute({
      type: "start",
      interactionId: "start_product",
      guildId: "guild_dayova",
      channelId: "channel_product",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-16T09:00:00.000Z",
      title: "Product Meeting",
      languageMode: "multilingual"
    });
    const noteResponse = await transport.execute({
      type: "note",
      interactionId: "note_release",
      guildId: "guild_dayova",
      channelId: "thread_product",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-16T09:05:00.000Z",
      text: "Ich übernehme die release checklist bis Montag.",
      language: "mixed"
    });
    const approveResponse = await transport.execute({
      type: "approve",
      interactionId: "approve_release",
      guildId: "guild_dayova",
      channelId: "thread_product",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-16T09:06:00.000Z",
      intentId: "intent_linear_release"
    });

    expect(noteResponse.content).toContain("Note saved");
    expect(noteResponse.content).toContain(
      "intent_linear_release: Prepare the release checklist"
    );
    expect(approveResponse.content).toContain("Follow-up failed");
    expect(approveResponse.content).toContain("durable ownership confirmation");
    expect(workProvider.createCalls).toEqual([]);
    await expect(
      database.query<{ original_text: string; language: string }>(
        `SELECT original_text, language FROM utterance_versions WHERE utterance_id = $1`,
        ["discord_note_release"]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          original_text: "Ich übernehme die release checklist bis Montag.",
          language: "mixed"
        }
      ]
    });
    const receiptMessage = transport.sentMessages.at(-1);

    if (!receiptMessage) {
      throw new Error("expected a Discord follow-up receipt");
    }

    expect(receiptMessage.channelId).toBe("thread_product");
    expect(receiptMessage.content).toContain("Follow-up failed");
    expect(receiptMessage.content).toContain("durable ownership confirmation");
    expect(receiptMessage.allowedUserIds).toEqual([
      "779381502311137301",
      "726409024894926869"
    ]);
    expect(receiptMessage.idempotencyKey).toBe(
      `${JSON.stringify([
        "workspace_dayova",
        "discord_start_product",
        "intent_linear_release",
        "execute"
      ])}:follow-up-execution-failed`
    );
  });

  it("rejects a suggested intent without mutating a provider", async () => {
    const database = await createPgliteDatabase();
    const identityDirectory = createLumaTeamIdentityDirectory();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new FollowUpReasoningModel(),
      now: () => new Date("2026-07-16T09:05:00.000Z")
    });
    const workProvider = new LinearWorkProvider();
    const transport = new TestDiscordTransport();
    const bot = createDiscordMeetingBot({
      database,
      meetingIntelligence,
      followUpExecution: createFollowUpExecution({
        database,
        meetingIntelligence,
        identityDirectory,
        workProvider
      }),
      identityDirectory,
      transport,
      workspace: {
        workspaceId: "workspace_dayova",
        timezone: "Europe/Berlin"
      },
      guildId: "guild_dayova"
    });

    await bot.start();
    await transport.execute({
      type: "start",
      interactionId: "start_reject",
      guildId: "guild_dayova",
      channelId: "channel_product",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-16T09:00:00.000Z",
      title: "Product Meeting",
      languageMode: "en"
    });
    await transport.execute({
      type: "note",
      interactionId: "note_reject",
      guildId: "guild_dayova",
      channelId: "thread_product",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-16T09:05:00.000Z",
      text: "Create a release checklist task.",
      language: "en"
    });
    const response = await transport.execute({
      type: "reject",
      interactionId: "reject_release",
      guildId: "guild_dayova",
      channelId: "thread_product",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-16T09:06:00.000Z",
      intentId: "intent_linear_release",
      reason: "We already track this elsewhere."
    });
    const snapshot = await meetingIntelligence.query({
      workspaceId: "workspace_dayova",
      meetingId: "discord_start_reject",
      query: { type: "snapshot" }
    });

    expect(response.content).toBe("Follow-up rejected: intent_linear_release");
    expect(workProvider.createCalls).toHaveLength(0);
    expect(snapshot.type).toBe("snapshot");

    if (snapshot.type !== "snapshot") {
      throw new Error("expected snapshot");
    }

    expect(snapshot.state.followUpIntentions[0]?.status).toBe("rejected");
  });

  it("recovers a stranded execution through a positive provider marker without writing again", async () => {
    const database = await createPgliteDatabase();
    const identityDirectory = createLumaTeamIdentityDirectory();
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new FollowUpReasoningModel(),
      now: () => new Date("2026-07-16T09:05:00.000Z")
    });
    const workProvider = new LinearWorkProvider();
    const transport = new TestDiscordTransport();
    const bot = createDiscordMeetingBot({
      database,
      meetingIntelligence,
      followUpExecution: createFollowUpExecution({
        database,
        meetingIntelligence,
        identityDirectory,
        workProvider,
        now: () => new Date("2026-07-16T09:06:00.000Z")
      }),
      identityDirectory,
      transport,
      workspace,
      guildId: "guild_dayova",
      now: () => new Date("2026-07-16T09:05:00.000Z")
    });

    await bot.start();
    await transport.execute({
      type: "start",
      interactionId: "start_recovery",
      guildId: "guild_dayova",
      channelId: "channel_product",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-16T09:00:00.000Z",
      title: "Product Meeting",
      languageMode: "en"
    });
    await transport.execute({
      type: "note",
      interactionId: "note_recovery",
      guildId: "guild_dayova",
      channelId: "thread_product",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-16T09:05:00.000Z",
      text: "Create a release checklist task.",
      language: "en"
    });

    const meetingId = "discord_start_recovery";
    const intentId = "intent_linear_release";
    const approval = await meetingIntelligence.observe({
      workspace,
      observations: [
        {
          type: "follow-up-intent-approved",
          observationId: "test:recover:approve",
          workspaceId: workspace.workspaceId,
          meetingId,
          occurredAt: "2026-07-16T09:06:00.000Z",
          observedAt: "2026-07-16T09:06:00.000Z",
          intentId,
          approvedBy: "person_jakob"
        }
      ]
    });
    expect(approval.errors).toEqual([]);

    const idempotencyKey = JSON.stringify([
      workspace.workspaceId,
      meetingId,
      intentId,
      "execute"
    ]);
    await database.query(
      `INSERT INTO follow_up_executions (
         workspace_id, meeting_id, intent_id, operation, idempotency_key,
         status, attempts, result_json, execution_lease_id, created_at, updated_at
       ) VALUES ($1, $2, $3, 'execute', $4, 'executing', 1, NULL, $5, $6, $6)`,
      [
        workspace.workspaceId,
        meetingId,
        intentId,
        idempotencyKey,
        "stranded-execution-lease",
        "2026-07-16T09:06:00.000Z"
      ]
    );
    workProvider.recoveredWorkItem = {
      providerId: "linear",
      objectType: "work-item",
      externalId: "DAY-302",
      url: "https://linear.app/dayova/issue/DAY-302"
    };

    const response = await transport.execute({
      type: "recover",
      interactionId: "recover_release",
      guildId: "guild_dayova",
      channelId: "thread_product",
      actorDiscordUserId: "779381502311137301",
      occurredAt: "2026-07-16T09:07:00.000Z",
      intentId
    });

    expect(response.content).toBe(
      "Follow-up recovered: https://linear.app/dayova/issue/DAY-302"
    );
    expect(workProvider.createCalls).toEqual([]);
    expect(workProvider.recoveryKeys).toContain(idempotencyKey);
  });
});
