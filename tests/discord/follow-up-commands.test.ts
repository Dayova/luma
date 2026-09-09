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
import type {
  ChangePage,
  CreateDocumentInput,
  KnowledgeDocument,
  KnowledgeProvider,
  KnowledgeQuery,
  KnowledgeResult
} from "../../src/knowledge/interface.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import type {
  CreateWorkItemInput,
  WorkItem,
  WorkProvider,
  WorkQuery
} from "../../src/work/interface.js";
import type {
  ExternalReference,
  FollowUpIntent,
  MeetingState
} from "../../src/domain/model.js";

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

class RecordingKnowledgeProvider implements KnowledgeProvider {
  readonly providerId = "notion-meetings";
  readonly createCalls: CreateDocumentInput[] = [];
  readonly markerLookups: string[] = [];
  marker: ExternalReference | null = null;

  search(_query: KnowledgeQuery): Promise<KnowledgeResult[]> {
    void _query;
    return Promise.resolve([]);
  }

  getDocument(_id: string): Promise<KnowledgeDocument> {
    void _id;
    return Promise.reject(new Error("not needed"));
  }

  createDocument(input: CreateDocumentInput): Promise<ExternalReference> {
    this.createCalls.push(input);
    return Promise.reject(new Error("legacy generic knowledge must not create"));
  }

  findCreatedDocumentByIdempotencyKey(
    idempotencyKey: string
  ): Promise<ExternalReference | null> {
    this.markerLookups.push(idempotencyKey);
    return Promise.resolve(this.marker);
  }

  listChanges(_cursor?: string): Promise<ChangePage> {
    void _cursor;
    return Promise.resolve({ changes: [], nextCursor: null });
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

async function createLegacyGenericKnowledgeDiscordContext() {
  const database = await createPgliteDatabase();
  const identityDirectory = createLumaTeamIdentityDirectory();
  const workspace = {
    workspaceId: "workspace_legacy_generic_knowledge",
    timezone: "Europe/Berlin"
  };
  const meetingId = "discord_start_legacy_generic_knowledge";
  const meetingIntelligence = createMeetingIntelligence({
    database,
    reasoningModel: new FollowUpReasoningModel(),
    now: () => new Date("2026-08-09T11:00:00.000Z")
  });
  const knowledgeProvider = new RecordingKnowledgeProvider();
  const transport = new TestDiscordTransport();
  const bot = createDiscordMeetingBot({
    database,
    meetingIntelligence,
    followUpExecution: createFollowUpExecution({
      database,
      meetingIntelligence,
      identityDirectory,
      knowledgeProvider,
      now: () => new Date("2026-08-09T11:01:00.000Z")
    }),
    identityDirectory,
    transport,
    workspace,
    guildId: "guild_dayova",
    now: () => new Date("2026-08-09T11:00:00.000Z")
  });

  await bot.start();
  await transport.execute({
    type: "start",
    interactionId: "start_legacy_generic_knowledge",
    guildId: "guild_dayova",
    channelId: "channel_product",
    actorDiscordUserId: "779381502311137301",
    occurredAt: "2026-08-09T10:58:00.000Z",
    title: "Product Meeting",
    languageMode: "en"
  });
  await transport.execute({
    type: "note",
    interactionId: "note_legacy_generic_knowledge",
    guildId: "guild_dayova",
    channelId: "thread_product",
    actorDiscordUserId: "779381502311137301",
    occurredAt: "2026-08-09T10:59:00.000Z",
    text: "Wir sollten die Customer Policy festhalten.",
    language: "de"
  });

  return {
    database,
    workspace,
    meetingId,
    meetingIntelligence,
    knowledgeProvider,
    transport
  };
}

type LegacyGenericKnowledgeDiscordContext = Awaited<
  ReturnType<typeof createLegacyGenericKnowledgeDiscordContext>
>;
type LegacyGenericKnowledgeIntent = Extract<FollowUpIntent, { type: "update-knowledge" }>;

async function currentMeetingState(
  context: LegacyGenericKnowledgeDiscordContext
): Promise<MeetingState> {
  const snapshot = await context.meetingIntelligence.query({
    workspaceId: context.workspace.workspaceId,
    meetingId: context.meetingId,
    query: { type: "snapshot" }
  });

  if (snapshot.type !== "snapshot") {
    throw new Error("expected Meeting snapshot");
  }

  return snapshot.state;
}

async function seedHistoricLegacyGenericKnowledgeIntent(
  context: LegacyGenericKnowledgeDiscordContext,
  status: FollowUpIntent["status"]
): Promise<LegacyGenericKnowledgeIntent> {
  const state = await currentMeetingState(context);
  const followUpIntentions = state.followUpIntentions;
  const currentIntent = followUpIntentions.find(
    (candidate): candidate is Extract<FollowUpIntent, { type: "create-work-item" }> =>
      candidate.id === "intent_linear_release"
  );

  if (!currentIntent) {
    throw new Error("expected generated Follow-up Intent");
  }
  const intent: LegacyGenericKnowledgeIntent = {
    id: "intent_legacy_generic_knowledge",
    type: "update-knowledge",
    title: "Customer policy",
    bodyMarkdown: "## Customer policy\n\nRemember this.",
    relatedMeetingItemIds: [],
    status,
    provenance: currentIntent.provenance
  };

  // Generic update-knowledge is now rejected by Meeting Intelligence, so this
  // fixture writes only a canonical Intent that existed before containment.
  await context.database.query(
    `UPDATE meetings
        SET state_json = $3
      WHERE workspace_id = $1 AND meeting_id = $2`,
    [
      context.workspace.workspaceId,
      context.meetingId,
      JSON.stringify({
        ...state,
        followUpIntentions: followUpIntentions.map((candidate) =>
          candidate.id === currentIntent.id ? intent : candidate
        )
      })
    ]
  );

  return intent;
}

async function seedHistoricLegacyGenericKnowledgeExecution(
  context: LegacyGenericKnowledgeDiscordContext,
  mode: "manual" | "executing"
): Promise<{ intent: LegacyGenericKnowledgeIntent; idempotencyKey: string }> {
  const intent = await seedHistoricLegacyGenericKnowledgeIntent(
    context,
    mode === "manual" ? "requires-manual-recovery" : "approved"
  );
  const idempotencyKey = JSON.stringify([
    context.workspace.workspaceId,
    context.meetingId,
    intent.id,
    "execute"
  ]);
  const executionLeaseId = `historic-legacy-generic-knowledge-${mode}`;
  const occurredAt = "2026-08-09T11:02:00.000Z";
  const resultJson =
    mode === "manual"
      ? JSON.stringify({
          observation: {
            type: "follow-up-execution-recorded",
            observationId: "historic-legacy-generic-knowledge:manual",
            workspaceId: context.workspace.workspaceId,
            meetingId: context.meetingId,
            occurredAt,
            observedAt: occurredAt,
            intentId: intent.id,
            executionLeaseId,
            outcome: {
              status: "failed",
              errorCode: "provider-outcome-unknown",
              message: "The historic provider response could not be proven.",
              retryable: false,
              requiresManualRecovery: true
            }
          },
          events: [],
          idempotencyKey
        })
      : null;

  await context.database.query(
    `INSERT INTO follow_up_executions (
       workspace_id, meeting_id, intent_id, operation, idempotency_key,
       status, attempts, result_json, execution_lease_id, created_at, updated_at
     ) VALUES ($1, $2, $3, 'execute', $4, $5, 1, $6, $7, $8, $8)`,
    [
      context.workspace.workspaceId,
      context.meetingId,
      intent.id,
      idempotencyKey,
      mode === "manual" ? "completed" : "executing",
      resultJson,
      executionLeaseId,
      occurredAt
    ]
  );

  return { intent, idempotencyKey };
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

  it("blocks legacy generic knowledge approval before it can reach a provider", async () => {
    const context = await createLegacyGenericKnowledgeDiscordContext();

    try {
      const intent = await seedHistoricLegacyGenericKnowledgeIntent(context, "suggested");
      const response = await context.transport.execute({
        type: "approve",
        interactionId: "approve_legacy_generic_knowledge",
        guildId: "guild_dayova",
        channelId: "thread_product",
        actorDiscordUserId: "779381502311137301",
        occurredAt: "2026-08-09T11:01:00.000Z",
        intentId: intent.id
      });

      expect(response.content).toContain("legacy generic knowledge update is disabled");
      expect(response.content).toContain("will not create or update");
      expect(context.knowledgeProvider.markerLookups).toEqual([]);
      expect(context.knowledgeProvider.createCalls).toEqual([]);
      expect((await currentMeetingState(context)).followUpIntentions).toContainEqual(
        expect.objectContaining({ id: intent.id, status: "suggested" })
      );
    } finally {
      await context.database.close();
    }
  });

  it.each(["manual", "executing"] as const)(
    "recovers a historic %s legacy generic create only from its exact positive marker",
    async (mode) => {
      const context = await createLegacyGenericKnowledgeDiscordContext();

      try {
        const { intent, idempotencyKey } =
          await seedHistoricLegacyGenericKnowledgeExecution(context, mode);
        const externalId = `notion-historic-legacy-generic-${mode}`;
        const url = `https://notion.so/${externalId}`;
        context.knowledgeProvider.marker = {
          providerId: context.knowledgeProvider.providerId,
          objectType: "document",
          externalId,
          url
        };

        const response = await context.transport.execute({
          type: "recover",
          interactionId: `recover_legacy_generic_knowledge_${mode}`,
          guildId: "guild_dayova",
          channelId: "thread_product",
          actorDiscordUserId: "779381502311137301",
          occurredAt: "2026-08-09T11:03:00.000Z",
          intentId: intent.id
        });

        expect(response.content).toBe(`Follow-up recovered: ${url}`);
        expect(context.knowledgeProvider.markerLookups).toEqual([idempotencyKey]);
        expect(context.knowledgeProvider.createCalls).toEqual([]);
      } finally {
        await context.database.close();
      }
    }
  );

  it("keeps a historic generic knowledge create manual when Discord recovery finds no marker", async () => {
    const context = await createLegacyGenericKnowledgeDiscordContext();

    try {
      const { intent, idempotencyKey } =
        await seedHistoricLegacyGenericKnowledgeExecution(context, "manual");
      const response = await context.transport.execute({
        type: "recover",
        interactionId: "recover_legacy_generic_knowledge_without_marker",
        guildId: "guild_dayova",
        channelId: "thread_product",
        actorDiscordUserId: "779381502311137301",
        occurredAt: "2026-08-09T11:03:00.000Z",
        intentId: intent.id
      });

      expect(response.content).toContain(
        "Follow-up recovery could not prove the provider outcome"
      );
      expect(response.content).toContain("will not create or update");
      expect(context.knowledgeProvider.markerLookups).toEqual([idempotencyKey]);
      expect(context.knowledgeProvider.createCalls).toEqual([]);
      expect((await currentMeetingState(context)).followUpIntentions).toContainEqual(
        expect.objectContaining({ id: intent.id, status: "requires-manual-recovery" })
      );
    } finally {
      await context.database.close();
    }
  });
});
