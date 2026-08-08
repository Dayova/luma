import type {
  FollowUpIntent,
  MeetingIntelligenceEvent,
  MeetingLanguageMode,
  MeetingState,
  PersonId,
  UtteranceLanguage,
  WorkspaceConfig
} from "../domain/model.js";
import type {
  ExecuteFollowUpResult,
  FollowUpExecution
} from "../follow-up-execution/interface.js";
import type { IdentityDirectory } from "../identity/interface.js";
import { resolveDiscordMentions } from "../identity/static-identity-directory.js";
import type { MeetingIntelligence } from "../meeting-intelligence/interface.js";
import type { LumaDatabase } from "../persistence/db.js";
import type { ContextIntelligence } from "../context-intelligence/interface.js";
import {
  renderDiscordContextAskResult,
  type DiscordContextAskConfig,
  type DiscordContextAskMention
} from "./discord-context-ask-runtime.js";

type DiscordCommandBase = {
  interactionId: string;
  guildId: string;
  channelId: string;
  actorDiscordUserId: string;
  occurredAt: string;
};

export type DiscordCommand =
  | (DiscordCommandBase & {
      type: "start";
      title: string;
      languageMode: MeetingLanguageMode;
    })
  | (DiscordCommandBase & {
      type: "ask";
      question: string;
    })
  | (DiscordCommandBase & {
      type: "catchup";
      sinceRevision: number;
    })
  | (DiscordCommandBase & {
      type: "note";
      text: string;
      language: UtteranceLanguage;
    })
  | (DiscordCommandBase & {
      type: "approve";
      intentId: string;
    })
  | (DiscordCommandBase & {
      type: "recover";
      intentId: string;
    })
  | (DiscordCommandBase & {
      type: "reject";
      intentId: string;
      reason?: string;
    })
  | (DiscordCommandBase & {
      type: "stop";
    });

export type DiscordCommandResponse = {
  content: string;
};

export type DiscordContextAskResponse = {
  content: string;
  /** Stable message-derived delivery identity for Gateway replay safety. */
  idempotencyKey: string;
};

export type DiscordThread = {
  id: string;
  url: string;
};

export interface DiscordTransport {
  connect(
    commandHandler: (command: DiscordCommand) => Promise<DiscordCommandResponse>,
    contextAskHandler?: (
      ask: DiscordContextAskMention
    ) => Promise<DiscordContextAskResponse | null>
  ): Promise<void>;
  disconnect(): Promise<void>;
  createThread(input: { parentChannelId: string; name: string }): Promise<DiscordThread>;
  sendMessage(input: {
    channelId: string;
    content: string;
    allowedUserIds?: string[];
    idempotencyKey?: string;
  }): Promise<void>;
}

export interface DiscordMeetingBot {
  start(): Promise<void>;
  stop(): Promise<void>;
  publishMeetingEvents(input: {
    workspaceId: string;
    meetingId: string;
    events: MeetingIntelligenceEvent[];
    mentionPersonIds?: PersonId[];
    idempotencyKeyPrefix?: string;
  }): Promise<void>;
}

export type CreateDiscordMeetingBotInput = {
  database: LumaDatabase;
  meetingIntelligence: MeetingIntelligence;
  followUpExecution?: FollowUpExecution;
  identityDirectory: IdentityDirectory;
  transport: DiscordTransport;
  workspace: WorkspaceConfig;
  guildId: string;
  /**
   * A separate, opt-in read-only conversation surface. It intentionally has
   * no Meeting ID, Follow-up operation, or Meeting Intelligence dependency.
   */
  contextAsk?: {
    contextIntelligence: ContextIntelligence;
    config: DiscordContextAskConfig;
  };
  now?: () => Date;
};

export function createDiscordMeetingBot(
  input: CreateDiscordMeetingBotInput
): DiscordMeetingBot {
  const now = input.now ?? (() => new Date());
  const startLocks = new Map<string, Promise<void>>();

  return {
    start: () =>
      input.transport.connect(
        (command) => {
          if (command.type !== "start") {
            return handleCommand(input, command, now);
          }

          return withStartLock(
            startLocks,
            `${command.guildId}:${command.channelId}`,
            () => handleCommand(input, command, now)
          );
        },
        input.contextAsk ? (ask) => answerConversationThread(input, ask) : undefined
      ),
    stop: () => input.transport.disconnect(),
    publishMeetingEvents: (publishInput) => publishMeetingEvents(input, publishInput)
  };
}

async function answerConversationThread(
  input: CreateDiscordMeetingBotInput,
  ask: DiscordContextAskMention
): Promise<DiscordContextAskResponse | null> {
  const contextAsk = input.contextAsk;

  if (
    !contextAsk ||
    ask.guildId !== input.guildId ||
    !contextAsk.config.parentChannelIds.includes(ask.parentChannelId) ||
    !contextAsk.config.allowedDiscordUserIds.includes(ask.actorDiscordUserId)
  ) {
    return null;
  }

  try {
    const result = await contextAsk.contextIntelligence.inquire({
      type: "ask",
      workspaceId: input.workspace.workspaceId,
      inquiryId: `discord:${ask.messageId}:context-ask`,
      question: ask.question,
      subject: {
        type: "conversation-thread",
        providerId: "discord",
        conversationObjectId: ask.channelId,
        anchorMessageId: ask.messageId
      }
    });

    return {
      content: renderDiscordContextAskResult(result),
      idempotencyKey: `discord:${ask.messageId}:context-ask:reply`
    };
  } catch {
    return {
      content: "Luma could not answer this thread right now. Please try again later.",
      idempotencyKey: `discord:${ask.messageId}:context-ask:reply`
    };
  }
}

async function withStartLock(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<DiscordCommandResponse>
): Promise<DiscordCommandResponse> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  locks.set(key, tail);
  await previous;

  try {
    return await operation();
  } finally {
    release();

    if (locks.get(key) === tail) {
      locks.delete(key);
    }
  }
}

async function publishMeetingEvents(
  input: CreateDiscordMeetingBotInput,
  publishInput: {
    workspaceId: string;
    meetingId: string;
    events: MeetingIntelligenceEvent[];
    mentionPersonIds?: PersonId[];
    idempotencyKeyPrefix?: string;
  }
): Promise<void> {
  const meetingThread = await findMeetingThread(
    input.database,
    publishInput.workspaceId,
    publishInput.meetingId
  );

  if (!meetingThread?.thread_id) {
    throw new Error("Cannot publish Discord events without an attached Meeting thread");
  }

  const mentions = await resolveDiscordMentions({
    identityDirectory: input.identityDirectory,
    workspaceId: publishInput.workspaceId,
    personIds: publishInput.mentionPersonIds ?? []
  });
  const allowedUserIds = mentions.map((mention) => mention.userId);
  const mentionContent = mentions.map((mention) => mention.content);

  for (const event of publishInput.events) {
    const content = renderMeetingEvent(event, mentionContent);
    const message: {
      channelId: string;
      content: string;
      allowedUserIds?: string[];
      idempotencyKey?: string;
    } = {
      channelId: meetingThread.thread_id,
      content
    };

    if (allowedUserIds.length > 0) {
      message.allowedUserIds = allowedUserIds;
    }

    if (publishInput.idempotencyKeyPrefix) {
      message.idempotencyKey = `${publishInput.idempotencyKeyPrefix}:${event.type}`;
    }

    await input.transport.sendMessage(message);
  }
}

async function handleCommand(
  input: CreateDiscordMeetingBotInput,
  command: DiscordCommand,
  now: () => Date
): Promise<DiscordCommandResponse> {
  if (command.guildId !== input.guildId) {
    return {
      content: "Luma is not configured for this Discord server."
    };
  }

  switch (command.type) {
    case "start":
      return startMeeting(input, command, now);
    case "ask":
      return answerMeetingQuestion(input, command);
    case "catchup":
      return catchUpMeeting(input, command);
    case "note":
      return recordMeetingNote(input, command, now);
    case "approve":
      return approveFollowUp(input, command, now);
    case "recover":
      return recoverFollowUp(input, command);
    case "reject":
      return rejectFollowUp(input, command, now);
    case "stop":
      return stopMeeting(input, command, now);
  }
}

async function recordMeetingNote(
  input: CreateDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "note" }>,
  now: () => Date
): Promise<DiscordCommandResponse> {
  const context = await resolveActiveMeetingActor(input, command);

  if ("response" in context) {
    return context.response;
  }

  const update = await input.meetingIntelligence.observe({
    workspace: input.workspace,
    observations: [
      {
        type: "utterance-committed",
        observationId: `discord:${command.interactionId}:utterance`,
        workspaceId: context.meetingThread.workspace_id,
        meetingId: context.meetingThread.meeting_id,
        occurredAt: command.occurredAt,
        observedAt: now().toISOString(),
        utteranceId: `discord_${command.interactionId}`,
        version: 1,
        speaker: {
          status: "attributed",
          personId: context.actor.personId,
          confidence: "deterministic",
          basis: "provider-identity"
        },
        startedAt: command.occurredAt,
        endedAt: command.occurredAt,
        originalText: command.text,
        language: command.language
      }
    ]
  });
  const snapshot = await queryMeetingSnapshot(input, context.meetingThread);
  const suggestedIntents = snapshot.followUpIntentions.filter(
    (intent) => intent.status === "suggested"
  );

  if (update.analysisStatus === "deferred") {
    return {
      content:
        "Note saved. Analysis is temporarily deferred; the original evidence is safe."
    };
  }

  return {
    content:
      suggestedIntents.length > 0
        ? [
            "Note saved.",
            "",
            "Follow-up approval needed:",
            ...suggestedIntents.map(
              (intent) => `- ${intent.id}: ${followUpIntentLabel(intent)}`
            )
          ].join("\n")
        : "Note saved. No grounded follow-up was proposed."
  };
}

async function approveFollowUp(
  input: CreateDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "approve" }>,
  now: () => Date
): Promise<DiscordCommandResponse> {
  const context = await resolveActiveMeetingActor(input, command);

  if ("response" in context) {
    return context.response;
  }

  const snapshot = await queryMeetingSnapshot(input, context.meetingThread);
  const intent = snapshot.followUpIntentions.find(
    (candidate) => candidate.id === command.intentId
  );

  if (!intent) {
    return { content: `Follow-up Intent not found: ${command.intentId}` };
  }

  if (intent.status === "rejected") {
    return { content: `Follow-up Intent was rejected: ${command.intentId}` };
  }

  if (intent.status === "succeeded" || intent.status === "partially-succeeded") {
    return { content: `Follow-up already executed: ${command.intentId}` };
  }

  if (!input.followUpExecution) {
    return { content: "Follow-up execution is not configured." };
  }

  const approval = await input.meetingIntelligence.observe({
    workspace: input.workspace,
    observations: [
      {
        type: "follow-up-intent-approved",
        observationId: `discord:${command.interactionId}:approve:${intent.id}`,
        workspaceId: context.meetingThread.workspace_id,
        meetingId: context.meetingThread.meeting_id,
        occurredAt: command.occurredAt,
        observedAt: now().toISOString(),
        intentId: intent.id,
        approvedBy: context.actor.personId
      }
    ]
  });

  const approvalError = approval.errors[0];

  if (approvalError) {
    return {
      content:
        approvalError.code === "invalid-observation"
          ? `Follow-up cannot be approved: ${approvalError.message}`
          : "Follow-up cannot be approved because its Meeting state is unavailable."
    };
  }

  const approvedSnapshot = await queryMeetingSnapshot(input, context.meetingThread);
  const approvedIntent = approvedSnapshot.followUpIntentions.find(
    (candidate) => candidate.id === intent.id
  );

  if (!approvedIntent) {
    throw new Error(`Approved Follow-up Intent disappeared: ${intent.id}`);
  }

  if (approvedIntent.status !== "approved") {
    return {
      content: `Follow-up was not approved: ${approvedIntent.id} is ${approvedIntent.status}.`
    };
  }

  const result = await input.followUpExecution.execute({
    workspace: input.workspace,
    meetingId: context.meetingThread.meeting_id,
    intentId: approvedIntent.id
  });
  await publishMeetingEvents(input, {
    workspaceId: context.meetingThread.workspace_id,
    meetingId: context.meetingThread.meeting_id,
    events: result.events,
    mentionPersonIds: relevantPeople(approvedIntent, context.actor.personId),
    idempotencyKeyPrefix: result.idempotencyKey
  });
  const references =
    result.observation.outcome.status === "failed"
      ? []
      : result.observation.outcome.externalReferences;
  const firstReference = references[0];

  if (result.observation.outcome.status === "failed") {
    return { content: `Follow-up failed: ${result.observation.outcome.message}` };
  }

  return {
    content: firstReference
      ? `Follow-up completed: ${firstReference.url}`
      : `Follow-up completed: ${intent.id}`
  };
}

async function recoverFollowUp(
  input: CreateDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "recover" }>
): Promise<DiscordCommandResponse> {
  const context = await resolveActiveMeetingActor(input, command);

  if ("response" in context) {
    return context.response;
  }

  const snapshot = await queryMeetingSnapshot(input, context.meetingThread);
  const intent = snapshot.followUpIntentions.find(
    (candidate) => candidate.id === command.intentId
  );

  if (!intent) {
    return { content: `Follow-up Intent not found: ${command.intentId}` };
  }

  const canRecoverPartialOperationalOutcome =
    intent.type === "settle-operational-outcome" &&
    intent.status === "partially-succeeded";
  const canProbeManualOperationalOutcome =
    intent.type === "settle-operational-outcome" &&
    intent.status === "requires-manual-recovery";

  if (
    intent.status !== "approved" &&
    !canRecoverPartialOperationalOutcome &&
    !canProbeManualOperationalOutcome
  ) {
    return {
      content: `Follow-up is not recoverable: ${intent.id} is ${intent.status}.`
    };
  }

  if (!input.followUpExecution) {
    return { content: "Follow-up execution is not configured." };
  }

  let result: ExecuteFollowUpResult;

  try {
    result = await input.followUpExecution.recover({
      workspace: input.workspace,
      meetingId: context.meetingThread.meeting_id,
      intentId: intent.id
    });
  } catch (error) {
    return {
      content: `Follow-up recovery could not run: ${
        error instanceof Error ? error.message : "unknown recovery error"
      }`
    };
  }

  await publishMeetingEvents(input, {
    workspaceId: context.meetingThread.workspace_id,
    meetingId: context.meetingThread.meeting_id,
    events: result.events,
    mentionPersonIds: relevantPeople(intent, context.actor.personId),
    idempotencyKeyPrefix: result.idempotencyKey
  });

  if (result.observation.outcome.status === "failed") {
    return {
      content: `Follow-up recovery could not prove the provider outcome: ${result.observation.outcome.message}`
    };
  }

  if (result.observation.outcome.status === "partially-succeeded") {
    return {
      content: `Follow-up recovery is still incomplete: ${result.observation.outcome.message}`
    };
  }

  const firstReference = result.observation.outcome.externalReferences[0];

  return {
    content: firstReference
      ? `Follow-up recovered: ${firstReference.url}`
      : `Follow-up recovered: ${intent.id}`
  };
}

async function rejectFollowUp(
  input: CreateDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "reject" }>,
  now: () => Date
): Promise<DiscordCommandResponse> {
  const context = await resolveActiveMeetingActor(input, command);

  if ("response" in context) {
    return context.response;
  }

  const snapshot = await queryMeetingSnapshot(input, context.meetingThread);
  const intent = snapshot.followUpIntentions.find(
    (candidate) => candidate.id === command.intentId
  );

  if (!intent) {
    return { content: `Follow-up Intent not found: ${command.intentId}` };
  }

  if (intent.status !== "suggested") {
    return { content: `Follow-up Intent is already ${intent.status}: ${intent.id}` };
  }

  await input.meetingIntelligence.observe({
    workspace: input.workspace,
    observations: [
      {
        type: "follow-up-intent-rejected",
        observationId: `discord:${command.interactionId}:reject:${intent.id}`,
        workspaceId: context.meetingThread.workspace_id,
        meetingId: context.meetingThread.meeting_id,
        occurredAt: command.occurredAt,
        observedAt: now().toISOString(),
        intentId: intent.id,
        rejectedBy: context.actor.personId,
        ...(command.reason ? { reason: command.reason } : {})
      }
    ]
  });

  return { content: `Follow-up rejected: ${intent.id}` };
}

async function stopMeeting(
  input: CreateDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "stop" }>,
  now: () => Date
): Promise<DiscordCommandResponse> {
  const meetingThread = await findActiveMeetingThread(
    input.database,
    command.guildId,
    command.channelId
  );

  if (!meetingThread) {
    return {
      content: "There is no active Meeting in this Discord channel."
    };
  }

  if (!meetingThread.thread_id) {
    return {
      content: "The Meeting thread is still being created. Please retry shortly."
    };
  }

  if (!meetingThread.conclusion_message_sent_at) {
    await input.meetingIntelligence.observe({
      workspace: input.workspace,
      observations: [
        {
          type: "meeting-ended",
          observationId: `discord:${meetingThread.meeting_id}:meeting-ended`,
          workspaceId: meetingThread.workspace_id,
          meetingId: meetingThread.meeting_id,
          occurredAt: command.occurredAt,
          observedAt: now().toISOString(),
          endedAt: command.occurredAt
        }
      ]
    });
    const snapshot = await input.meetingIntelligence.query({
      workspaceId: meetingThread.workspace_id,
      meetingId: meetingThread.meeting_id,
      query: {
        type: "snapshot"
      }
    });

    if (snapshot.type !== "snapshot") {
      throw new Error("Meeting Intelligence returned an unexpected query result");
    }

    const conclusion = await input.meetingIntelligence.conclude({
      workspaceId: meetingThread.workspace_id,
      meetingId: meetingThread.meeting_id
    });

    await input.transport.sendMessage({
      channelId: meetingThread.thread_id,
      content: `Meeting ended: **${snapshot.state.title}**\n\n${conclusion.summary.brief}`,
      idempotencyKey: `meeting:${meetingThread.meeting_id}:conclusion:${conclusion.revision}`
    });
    await markMeetingConclusionSent(
      input.database,
      meetingThread.workspace_id,
      meetingThread.meeting_id,
      now().toISOString()
    );
  }

  await markMeetingThreadEnded(
    input.database,
    meetingThread.workspace_id,
    meetingThread.meeting_id,
    command.occurredAt,
    now().toISOString()
  );

  return {
    content: "Meeting ended. The Conclusion was posted in the Meeting thread."
  };
}

async function startMeeting(
  input: CreateDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "start" }>,
  now: () => Date
): Promise<DiscordCommandResponse> {
  const existing = await findActiveMeetingThread(
    input.database,
    command.guildId,
    command.channelId
  );

  const meetingId = existing?.meeting_id ?? `discord_${command.interactionId}`;
  const meetingTitle = existing?.meeting_title ?? command.title;
  const startedAt = existing?.started_at ?? command.occurredAt;
  const languageMode = existing?.language_mode ?? command.languageMode;
  const actorDiscordUserId =
    existing?.actor_discord_user_id ?? command.actorDiscordUserId;
  const threadName =
    existing?.thread_name ??
    renderThreadName(
      command.title,
      command.occurredAt,
      input.workspace.timezone,
      meetingId
    );

  if (!existing) {
    await reserveMeetingThread(input.database, {
      workspaceId: input.workspace.workspaceId,
      meetingId,
      guildId: command.guildId,
      parentChannelId: command.channelId,
      meetingTitle,
      threadName,
      languageMode,
      actorDiscordUserId,
      startedAt,
      createdAt: now().toISOString()
    });
  }

  if (!existing?.meeting_observed_at) {
    const actor = await input.identityDirectory.findPersonByDiscordUserId({
      workspaceId: input.workspace.workspaceId,
      discordUserId: actorDiscordUserId
    });

    await input.meetingIntelligence.observe({
      workspace: input.workspace,
      observations: [
        {
          type: "meeting-started",
          observationId: `discord:${meetingId}:meeting-started`,
          workspaceId: input.workspace.workspaceId,
          meetingId,
          occurredAt: startedAt,
          observedAt: now().toISOString(),
          title: meetingTitle,
          startedAt,
          languageMode,
          participantIds: actor ? [actor.personId] : []
        }
      ]
    });
    await markMeetingObserved(
      input.database,
      input.workspace.workspaceId,
      meetingId,
      now().toISOString()
    );
  }

  if (existing?.thread_url && existing.thread_id) {
    if (!existing.start_message_sent_at) {
      await postMeetingStartedMessage(input, {
        workspaceId: existing.workspace_id,
        meetingId: existing.meeting_id,
        meetingTitle: existing.meeting_title,
        threadId: existing.thread_id,
        updatedAt: now().toISOString()
      });
    }

    return {
      content: `A Meeting is already active in ${existing.thread_url}`
    };
  }

  const thread = await input.transport.createThread({
    parentChannelId: command.channelId,
    name: threadName
  });

  await attachMeetingThread(input.database, {
    workspaceId: input.workspace.workspaceId,
    meetingId,
    thread,
    updatedAt: now().toISOString()
  });

  await postMeetingStartedMessage(input, {
    workspaceId: input.workspace.workspaceId,
    meetingId,
    meetingTitle,
    threadId: thread.id,
    updatedAt: now().toISOString()
  });

  return {
    content: `Meeting started in ${thread.url}`
  };
}

async function catchUpMeeting(
  input: CreateDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "catchup" }>
): Promise<DiscordCommandResponse> {
  const meetingThread = await findActiveMeetingThread(
    input.database,
    command.guildId,
    command.channelId
  );

  if (!meetingThread) {
    return {
      content: "There is no active Meeting in this Discord channel."
    };
  }

  const result = await input.meetingIntelligence.query({
    workspaceId: meetingThread.workspace_id,
    meetingId: meetingThread.meeting_id,
    query: {
      type: "catch-up",
      since: {
        type: "revision",
        value: command.sinceRevision
      }
    }
  });

  if (result.type !== "catch-up") {
    throw new Error("Meeting Intelligence returned an unexpected query result");
  }

  return {
    content: `${result.answer.text}\n\n${renderEvidenceSummary(result.answer.evidence)}`
  };
}

async function answerMeetingQuestion(
  input: CreateDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "ask" }>
): Promise<DiscordCommandResponse> {
  const meetingThread = await findActiveMeetingThread(
    input.database,
    command.guildId,
    command.channelId
  );

  if (!meetingThread) {
    return {
      content: "There is no active Meeting in this Discord channel."
    };
  }

  const actor = await input.identityDirectory.findPersonByDiscordUserId({
    workspaceId: meetingThread.workspace_id,
    discordUserId: command.actorDiscordUserId
  });
  const query: {
    type: "freeform";
    text: string;
    participantId?: PersonId;
  } = {
    type: "freeform",
    text: command.question
  };

  if (actor) {
    query.participantId = actor.personId;
  }

  const result = await input.meetingIntelligence.query({
    workspaceId: meetingThread.workspace_id,
    meetingId: meetingThread.meeting_id,
    query
  });

  if (result.type !== "freeform") {
    throw new Error("Meeting Intelligence returned an unexpected query result");
  }

  return {
    content: `${result.answer.text}\n\n${renderEvidenceSummary(result.answer.evidence)}`
  };
}

type DiscordMeetingThreadRow = {
  workspace_id: string;
  meeting_id: string;
  meeting_title: string;
  thread_name: string;
  language_mode: MeetingLanguageMode;
  actor_discord_user_id: string;
  started_at: string;
  meeting_observed_at: string | null;
  thread_id: string | null;
  thread_url: string | null;
  start_message_sent_at: string | null;
  conclusion_message_sent_at: string | null;
};

async function resolveActiveMeetingActor(
  input: CreateDiscordMeetingBotInput,
  command: DiscordCommandBase
): Promise<
  | {
      meetingThread: DiscordMeetingThreadRow;
      actor: NonNullable<
        Awaited<ReturnType<IdentityDirectory["findPersonByDiscordUserId"]>>
      >;
    }
  | { response: DiscordCommandResponse }
> {
  const meetingThread = await findActiveMeetingThread(
    input.database,
    command.guildId,
    command.channelId
  );

  if (!meetingThread) {
    return {
      response: { content: "There is no active Meeting in this Discord channel." }
    };
  }

  const actor = await input.identityDirectory.findPersonByDiscordUserId({
    workspaceId: meetingThread.workspace_id,
    discordUserId: command.actorDiscordUserId
  });

  if (!actor) {
    return {
      response: {
        content: "Only a mapped Luma participant can record or judge Meeting evidence."
      }
    };
  }

  return { meetingThread, actor };
}

async function queryMeetingSnapshot(
  input: CreateDiscordMeetingBotInput,
  meetingThread: DiscordMeetingThreadRow
): Promise<MeetingState> {
  const result = await input.meetingIntelligence.query({
    workspaceId: meetingThread.workspace_id,
    meetingId: meetingThread.meeting_id,
    query: { type: "snapshot" }
  });

  if (result.type !== "snapshot") {
    throw new Error("Meeting Intelligence returned an unexpected query result");
  }

  return result.state;
}

function relevantPeople(intent: FollowUpIntent, actorId: PersonId): PersonId[] {
  if (intent.type !== "create-work-item") {
    return [actorId];
  }

  return [intent.assigneeId, ...(intent.mentionPersonIds ?? [])].filter(
    (personId, index, personIds): personId is PersonId =>
      Boolean(personId) && personIds.indexOf(personId) === index
  );
}

function followUpIntentLabel(intent: FollowUpIntent): string {
  switch (intent.type) {
    case "record-meeting":
    case "update-knowledge":
    case "create-work-item":
      return intent.title;
    case "settle-operational-outcome":
      return "Publish approved operational outcome";
    case "update-work-item":
      return `Update ${intent.externalReference.externalId}`;
    case "comment-on-code-change":
      return `Comment on ${intent.externalReference.externalId}`;
  }
}

async function findMeetingThread(
  database: LumaDatabase,
  workspaceId: string,
  meetingId: string
): Promise<DiscordMeetingThreadRow | null> {
  const result = await database.query<DiscordMeetingThreadRow>(
    `SELECT workspace_id, meeting_id, meeting_title, thread_name, language_mode,
            actor_discord_user_id, started_at, meeting_observed_at, thread_id, thread_url,
            start_message_sent_at, conclusion_message_sent_at
       FROM discord_meeting_threads
      WHERE workspace_id = $1 AND meeting_id = $2
      LIMIT 1`,
    [workspaceId, meetingId]
  );

  return result.rows[0] ?? null;
}

async function findActiveMeetingThread(
  database: LumaDatabase,
  guildId: string,
  channelId: string
): Promise<DiscordMeetingThreadRow | null> {
  const result = await database.query<DiscordMeetingThreadRow>(
    `SELECT workspace_id, meeting_id, meeting_title, thread_name, language_mode,
            actor_discord_user_id, started_at, meeting_observed_at, thread_id, thread_url,
            start_message_sent_at, conclusion_message_sent_at
       FROM discord_meeting_threads
      WHERE guild_id = $1
        AND ended_at IS NULL
        AND (parent_channel_id = $2 OR thread_id = $2)
      ORDER BY created_at DESC
      LIMIT 1`,
    [guildId, channelId]
  );

  return result.rows[0] ?? null;
}

async function markMeetingThreadEnded(
  database: LumaDatabase,
  workspaceId: string,
  meetingId: string,
  endedAt: string,
  updatedAt: string
): Promise<void> {
  await database.query(
    `UPDATE discord_meeting_threads
        SET ended_at = $3, updated_at = $4
      WHERE workspace_id = $1 AND meeting_id = $2`,
    [workspaceId, meetingId, endedAt, updatedAt]
  );
}

async function markMeetingConclusionSent(
  database: LumaDatabase,
  workspaceId: string,
  meetingId: string,
  updatedAt: string
): Promise<void> {
  await database.query(
    `UPDATE discord_meeting_threads
        SET conclusion_message_sent_at = $3, updated_at = $3
      WHERE workspace_id = $1 AND meeting_id = $2`,
    [workspaceId, meetingId, updatedAt]
  );
}

async function markMeetingObserved(
  database: LumaDatabase,
  workspaceId: string,
  meetingId: string,
  updatedAt: string
): Promise<void> {
  await database.query(
    `UPDATE discord_meeting_threads
        SET meeting_observed_at = $3, updated_at = $3
      WHERE workspace_id = $1 AND meeting_id = $2`,
    [workspaceId, meetingId, updatedAt]
  );
}

function renderEvidenceSummary(
  evidence: Array<{ source: string; sourceObjectId: string }>
): string {
  if (evidence.length === 0) {
    return "Evidence: none";
  }

  return `Evidence: ${evidence
    .map((reference) => `${reference.source}:${reference.sourceObjectId}`)
    .join(", ")}`;
}

function renderMeetingEvent(event: MeetingIntelligenceEvent, mentions: string[]): string {
  switch (event.type) {
    case "follow-up-awaiting-approval":
      return withMentions(
        ["Follow-up approval needed", "", `Intents: ${event.intentIds.join(", ")}`],
        mentions
      );
    case "follow-up-execution-started":
      return withMentions(
        ["Follow-up started", "", `Intent: ${event.intentId}`],
        mentions
      );
    case "follow-up-execution-succeeded":
      return withMentions(
        ["Follow-up completed", "", event.summary, ...renderReferences(event)],
        mentions
      );
    case "follow-up-execution-partially-succeeded":
      return withMentions(
        ["Follow-up needs attention", "", event.message, ...renderReferences(event)],
        mentions
      );
    case "follow-up-execution-failed":
      return withMentions(
        [
          "Follow-up failed",
          "",
          event.message,
          `Retry: ${event.retryable ? "available" : "not available"}`
        ],
        mentions
      );
    case "action-item-status-changed":
      return withMentions(
        [
          "Action Item status changed",
          "",
          `${event.actionItemId}: ${event.previousStatus} -> ${event.currentStatus}`,
          ...renderReferences(event)
        ],
        mentions
      );
    case "meeting-follow-up-completed":
      return withMentions(
        [
          "Meeting follow-up completed",
          "",
          `Completed: ${renderIdList(event.completedIntentIds)}`,
          `Outstanding: ${renderIdList(event.outstandingIntentIds)}`
        ],
        mentions
      );
  }
}

function renderReferences(input: {
  externalReferences: Array<{ providerId: string; url: string }>;
}): string[] {
  return input.externalReferences.map(
    (reference) => `${providerDisplayName(reference.providerId)}: ${reference.url}`
  );
}

function withMentions(lines: string[], mentions: string[]): string {
  return [...lines, ...(mentions.length > 0 ? ["", mentions.join(" ")] : [])].join("\n");
}

function renderIdList(ids: string[]): string {
  return ids.length > 0 ? ids.join(", ") : "none";
}

function providerDisplayName(providerId: string): string {
  if (providerId === "github-issues" || providerId === "github-code") {
    return "GitHub";
  }

  if (providerId === "confluence") {
    return "Confluence";
  }

  if (providerId === "linear") {
    return "Linear";
  }

  if (providerId === "notion") {
    return "Notion";
  }

  return providerId;
}

async function reserveMeetingThread(
  database: LumaDatabase,
  input: {
    workspaceId: string;
    meetingId: string;
    guildId: string;
    parentChannelId: string;
    meetingTitle: string;
    threadName: string;
    languageMode: MeetingLanguageMode;
    actorDiscordUserId: string;
    startedAt: string;
    createdAt: string;
  }
): Promise<void> {
  await database.query(
    `INSERT INTO discord_meeting_threads (
       workspace_id,
       meeting_id,
       guild_id,
       parent_channel_id,
       meeting_title,
       thread_name,
       language_mode,
       actor_discord_user_id,
       meeting_observed_at,
       thread_id,
       thread_url,
       started_at,
       ended_at,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, NULL, $9, NULL, $10, $10)`,
    [
      input.workspaceId,
      input.meetingId,
      input.guildId,
      input.parentChannelId,
      input.meetingTitle,
      input.threadName,
      input.languageMode,
      input.actorDiscordUserId,
      input.startedAt,
      input.createdAt
    ]
  );
}

async function attachMeetingThread(
  database: LumaDatabase,
  input: {
    workspaceId: string;
    meetingId: string;
    thread: DiscordThread;
    updatedAt: string;
  }
): Promise<void> {
  await database.query(
    `UPDATE discord_meeting_threads
        SET thread_id = $3, thread_url = $4, updated_at = $5
      WHERE workspace_id = $1 AND meeting_id = $2`,
    [
      input.workspaceId,
      input.meetingId,
      input.thread.id,
      input.thread.url,
      input.updatedAt
    ]
  );
}

async function postMeetingStartedMessage(
  input: CreateDiscordMeetingBotInput,
  message: {
    workspaceId: string;
    meetingId: string;
    meetingTitle: string;
    threadId: string;
    updatedAt: string;
  }
): Promise<void> {
  await input.transport.sendMessage({
    channelId: message.threadId,
    content: `Meeting started: **${message.meetingTitle}**`,
    idempotencyKey: `meeting:${message.meetingId}:started`
  });
  await input.database.query(
    `UPDATE discord_meeting_threads
        SET start_message_sent_at = $3, updated_at = $3
      WHERE workspace_id = $1 AND meeting_id = $2`,
    [message.workspaceId, message.meetingId, message.updatedAt]
  );
}

function renderThreadName(
  title: string,
  occurredAt: string,
  timezone: string,
  meetingId: string
): string {
  const date = new Date(occurredAt);
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: timezone
  }).formatToParts(date);
  const day = parts.find((part) => part.type === "day")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const year = parts.find((part) => part.type === "year")?.value;

  const suffix = ` [${meetingId}]`;
  const base = `${title} - ${day} ${month} ${year}`;

  return `${base.slice(0, Math.max(0, 100 - suffix.length))}${suffix}`.slice(-100);
}
