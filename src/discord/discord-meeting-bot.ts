import {
  handleDiscordStructuredWorkCommand,
  isStructuredWorkCommand,
  renderStructuredWorkFailure,
  type DiscordStructuredWorkCommand,
  type DiscordStructuredWorkRuntime
} from "./discord-structured-work-runtime.js";
import {
  isGranolaCommand,
  DiscordGranolaUnavailableError,
  type DiscordGranolaCommand,
  type DiscordGranolaRuntime
} from "./discord-granola-runtime.js";
import {
  isCaptureReviewCommand,
  DiscordCaptureReviewUnavailableError,
  type DiscordCaptureReviewCommand,
  type DiscordCaptureReviewRuntime
} from "./discord-capture-review-runtime.js";
import {
  discordDecisionRequestId,
  handleDiscordDecisionRecordCommand,
  handleDiscordDecisionRecordMention,
  renderDecisionRecordFailure,
  isExplicitDecisionRecordInstruction,
  type DiscordDecisionRecordCommand,
  type DiscordDecisionRecordRuntime
} from "./discord-decision-record-runtime.js";
import {
  handleDiscordConsultationCommand,
  type DiscordConsultationCommand,
  type DiscordConsultationRuntime
} from "./discord-consultation-runtime.js";
import { ConversationConsultationError } from "../context-intelligence/conversation-consultations.js";
import {
  createDiscordChannelScope,
  DiscordChannelAccessError,
  type DiscordChannelSurface
} from "./discord-channel-scope.js";
import {
  renderReconciliationReviewPages,
  reviewIntent
} from "./discord-reconciliation-review.js";
import { canonicalNotionObjectId } from "../knowledge/notion-object-id.js";
import type { AiUsageBudget } from "../ai/ai-usage-budget.js";
import {
  renderDeferredAnalysis,
  renderAiServiceFailure,
  renderAiUsageStatus,
  renderAiUsageWarning
} from "./discord-ai-status.js";
import type {
  FollowUpIntent,
  HumanJudgment,
  CurrentActionItemReconciliationReview,
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
import {
  createWorkspaceAccessPolicy,
  type WorkspaceAccessPolicy
} from "../access/workspace-access-policy.js";
import { resolveDiscordMentions } from "../identity/static-identity-directory.js";
import type { MeetingIntelligence } from "../meeting-intelligence/interface.js";
import type { LumaDatabase } from "../persistence/db.js";
import type {
  ContextIntelligence,
  ContextInquiry
} from "../context-intelligence/interface.js";
import type { ConversationEvidenceProof } from "../context-intelligence/conversation-evidence-source.js";
import { ContextIntelligenceError } from "../context-intelligence/context-intelligence.js";
import {
  createDiscordContextAskRateLimiter,
  renderDiscordContextAskResult,
  type DiscordContextAskConfig,
  type DiscordContextAskMention
} from "./discord-context-ask-runtime.js";

export type DiscordCommandBase = {
  interactionId: string;
  guildId: string;
  channelId: string;
  actorDiscordUserId: string;
  occurredAt: string;
};

export type DiscordCommand =
  | DiscordConsultationCommand
  | DiscordCaptureReviewCommand
  | DiscordGranolaCommand
  | DiscordDecisionRecordCommand
  | DiscordStructuredWorkCommand
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
    })
  | (DiscordCommandBase & { type: "usage" })
  | (DiscordCommandBase & { type: "bind"; sourcePage: string; sourceObjectId?: string })
  | (DiscordCommandBase & { type: "review"; page: number; reviewId?: string })
  | (DiscordCommandBase & {
      type: "owner";
      claimId: string;
      ownership: "confirm-owner" | "intentionally-unassigned" | "keep-unresolved";
      ownerDiscordUserId?: string;
    })
  | (DiscordCommandBase & {
      type: "reconcile";
      reviewId: string;
      choice:
        | "accept-proposal"
        | "reject-proposal"
        | "select-create-new"
        | "select-needs-clarification"
        | "link-existing"
        | "update-existing";
      externalId?: string;
      reason?: string;
      execute: boolean;
    })
  | (DiscordCommandBase & { type: "refresh"; reviewId: string })
  | (DiscordCommandBase & {
      type: "patch";
      intentId: string;
      pageId: string;
      expectedMarkdown: string;
      replacementMarkdown: string;
    });

export type DiscordCommandResponse = {
  content: string;
  /** Fresh source/recipient proof at the actual Discord reply boundary. */
  requireCurrent?: () => Promise<void>;
};

export type DiscordContextAskResponse = {
  content: string;
  /** Stable message-derived delivery identity for Gateway replay safety. */
  idempotencyKey: string;
  /** Required for evidence-derived answers, revalidated at the final send boundary. */
  sourceProof?: ConversationEvidenceProof;
  /** A final read-only fence immediately before delivering the cached answer. */
  requireCurrent?: () => Promise<void>;
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
    ) => Promise<DiscordContextAskResponse | null>,
    startupSignal?: AbortSignal
  ): Promise<void>;
  /** Stop admission and wait for admitted handlers and final deliveries before closing. */
  disconnect(): Promise<void>;
  resolveChannel(input: { channelId: string }): Promise<DiscordChannelSurface | null>;
  createThread(input: { parentChannelId: string; name: string }): Promise<DiscordThread>;
  sendMessage(input: {
    channelId: string;
    content: string;
    allowedUserIds?: string[];
    idempotencyKey?: string;
  }): Promise<void>;
}

export interface DiscordMeetingBot {
  start(startupSignal?: AbortSignal): Promise<void>;
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
  consultations?: DiscordConsultationRuntime;
  captureReview?: DiscordCaptureReviewRuntime;
  granola?: DiscordGranolaRuntime;
  decisionRecords?: DiscordDecisionRecordRuntime;
  structuredWork?: DiscordStructuredWorkRuntime;
  identityDirectory: IdentityDirectory;
  /** Explicit workspace admission; identity mappings and participants grant no access. */
  authorizedPersonIds: readonly PersonId[];
  transport: DiscordTransport;
  workspace: WorkspaceConfig;
  guildId: string;
  /** Reviewed text parents; an empty set denies every Discord content surface. */
  allowedParentChannelIds: readonly string[];
  /**
   * A separate, opt-in read-only conversation surface. It intentionally has
   * no Meeting ID, Follow-up operation, or Meeting Intelligence dependency.
   */
  contextAsk?: {
    contextIntelligence: ContextIntelligence;
    config: DiscordContextAskConfig;
  };
  importedMeetingAccess?: {
    resolve(input: { workspaceId: string; pageId: string }): Promise<string | null>;
    requireCurrent(input: {
      state: MeetingState;
      personIds: readonly PersonId[];
    }): Promise<void>;
  };
  aiUsage?: Pick<AiUsageBudget, "getStatus">;
  now?: () => Date;
};

type ScopedDiscordMeetingBotInput = CreateDiscordMeetingBotInput & {
  channelScope: ReturnType<typeof createDiscordChannelScope>;
};

export function createDiscordMeetingBot(
  configuration: CreateDiscordMeetingBotInput
): DiscordMeetingBot {
  const channelScope = createDiscordChannelScope({
    guildId: configuration.guildId,
    allowedParentChannelIds: configuration.allowedParentChannelIds,
    resolveChannel: (surface) => configuration.transport.resolveChannel(surface)
  });
  // Recheck each destination at the publication boundary, including deferred receipts.
  const input: ScopedDiscordMeetingBotInput = {
    channelScope,
    ...configuration,
    transport: {
      connect: (handler, contextHandler, startupSignal) =>
        configuration.transport.connect(handler, contextHandler, startupSignal),
      disconnect: () => configuration.transport.disconnect(),
      resolveChannel: (surface) => configuration.transport.resolveChannel(surface),
      async createThread(thread) {
        await channelScope.requireChannel(thread.parentChannelId, "text-channel");
        return configuration.transport.createThread(thread);
      },
      async sendMessage(message) {
        await channelScope.requireChannel(message.channelId, "public-thread");
        return configuration.transport.sendMessage(message);
      }
    }
  };
  const now = input.now ?? (() => new Date());
  const accessPolicy = createWorkspaceAccessPolicy({
    workspaceId: input.workspace.workspaceId,
    authorizedPersonIds: input.authorizedPersonIds,
    identityDirectory: input.identityDirectory
  });
  const startLocks = new Map<string, Promise<void>>();
  const admitted = new Set<Promise<unknown>>();
  let stopping = false;
  let stopped: Promise<void> | undefined;
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = Promise.resolve().then(operation);
    admitted.add(pending);
    const finished = () => admitted.delete(pending);
    void pending.then(finished, finished);
    return pending;
  };
  const contextRateLimiter = input.contextAsk
    ? createDiscordContextAskRateLimiter({
        minIntervalMs: input.contextAsk.config.minIntervalMs,
        now: () => now().getTime()
      })
    : undefined;
  const decisionRateLimiter = input.decisionRecords
    ? createDiscordContextAskRateLimiter({
        minIntervalMs: input.decisionRecords.config.minIntervalMs,
        now: () => now().getTime()
      })
    : undefined;
  // A second Gateway delivery must not become a second cooldown/status reply.
  const seenContextMessages = new Map<string, number>();

  return {
    start: (startupSignal) =>
      input.transport.connect(
        (command) => {
          if (stopping)
            return Promise.resolve({
              content: "Luma is shutting down. Please try again after it restarts."
            });
          return track(() =>
            command.type !== "start" && command.type !== "bind"
              ? handleCommand(input, command, now, accessPolicy, channelScope)
              : withStartLock(startLocks, `${command.guildId}:${command.channelId}`, () =>
                  handleCommand(input, command, now, accessPolicy, channelScope)
                )
          );
        },
        input.contextAsk || input.decisionRecords
          ? (ask) =>
              stopping
                ? Promise.resolve(null)
                : track(() =>
                    answerConversationThread(
                      input,
                      ask,
                      accessPolicy,
                      channelScope,
                      ask.purpose === "decision-record"
                        ? decisionRateLimiter
                        : contextRateLimiter,
                      seenContextMessages,
                      now
                    )
                  )
          : undefined,
        startupSignal
      ),
    stop() {
      stopping = true;
      stopped ??= (async () => {
        // The transport owns final delivery/source checks after a handler returns;
        // the bot also owns admitted work when using any other transport adapter.
        const results = await Promise.allSettled([
          input.transport.disconnect(),
          ...admitted
        ]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })();
      return stopped;
    },
    publishMeetingEvents: (publishInput) =>
      stopping
        ? Promise.reject(new Error("Luma is shutting down"))
        : track(() => publishMeetingEvents(input, publishInput))
  };
}

async function answerConversationThread(
  input: ScopedDiscordMeetingBotInput,
  ask: DiscordContextAskMention,
  accessPolicy: WorkspaceAccessPolicy,
  channelScope: ReturnType<typeof createDiscordChannelScope>,
  rateLimiter: ReturnType<typeof createDiscordContextAskRateLimiter> | undefined,
  seenMessages: Map<string, number>,
  now: () => Date
): Promise<DiscordContextAskResponse | null> {
  const contextAsk = input.contextAsk;
  const decisionRecords =
    ask.purpose === "decision-record" ? input.decisionRecords : undefined;
  const scope = ask.purpose === "decision-record" ? decisionRecords : contextAsk;

  if (
    !scope ||
    ask.guildId !== input.guildId ||
    !scope.config.parentChannelIds.includes(ask.parentChannelId) ||
    !scope.config.allowedDiscordUserIds.includes(ask.actorDiscordUserId) ||
    !(await accessPolicy.authorize({
      workspaceId: input.workspace.workspaceId,
      providerId: "discord",
      providerUserId: ask.actorDiscordUserId
    }))
  ) {
    return null;
  }

  const allowedSurface = async (): Promise<boolean> => {
    const surface = await channelScope.resolveAllowedChannel(ask.channelId);
    return (
      surface?.kind === "public-thread" && surface.parentChannelId === ask.parentChannelId
    );
  };
  if (!(await allowedSurface())) return null;

  const reply = async (content: string): Promise<DiscordContextAskResponse | null> =>
    (await allowedSurface())
      ? {
          content,
          idempotencyKey: `discord:${ask.messageId}:${ask.purpose ?? "context-ask"}:reply`
        }
      : null;
  const currentTime = now().getTime();
  for (const [messageId, expiresAt] of seenMessages) {
    if (expiresAt <= currentTime) seenMessages.delete(messageId);
  }
  if (seenMessages.has(ask.messageId)) return null;
  seenMessages.set(ask.messageId, currentTime + 86_400_000);
  if (seenMessages.size > 10_000) {
    const oldest = seenMessages.keys().next().value;
    if (oldest) seenMessages.delete(oldest);
  }
  if (/^(?:usage|status)$/iu.test(ask.question.trim())) {
    return reply(await readAiUsage(input));
  }
  const retryAfterSeconds = rateLimiter?.acquire(ask) ?? 0;
  if (retryAfterSeconds > 0) {
    return reply(
      `Luma is cooling down in this thread. Try again in ${retryAfterSeconds} seconds. You can still use @Luma usage or /meeting usage; no AI call was made.`
    );
  }

  try {
    if (ask.purpose === "decision-record") {
      if (!decisionRecords || !isExplicitDecisionRecordInstruction(ask.question))
        return null;
      const decision = await handleDiscordDecisionRecordMention({
        runtime: decisionRecords,
        workspace: input.workspace,
        mention: ask
      });
      const response = await reply(await appendAiUsageWarning(input, decision.content));
      return response
        ? {
            ...response,
            requireCurrent: async () => {
              if (
                !(await accessPolicy.authorize({
                  workspaceId: input.workspace.workspaceId,
                  providerId: "discord",
                  providerUserId: ask.actorDiscordUserId
                })) ||
                !(await allowedSurface())
              )
                throw new DiscordChannelAccessError();
              await decision.requireCurrent?.();
            }
          }
        : null;
    }
    if (!contextAsk) return null;
    const inquiry: ContextInquiry = {
      type: "ask",
      workspaceId: input.workspace.workspaceId,
      inquiryId: `discord:${ask.messageId}:context-ask`,
      question: ask.question,
      audience: {
        workspaceId: input.workspace.workspaceId,
        personIds: [...input.authorizedPersonIds]
      },
      subject: {
        type: "conversation-thread",
        providerId: "discord",
        conversationObjectId: ask.channelId,
        anchorMessageId: ask.messageId
      }
    };
    const result = await contextAsk.contextIntelligence.inquire(inquiry);
    if (result.organizationalContext && !contextAsk.contextIntelligence.requireCurrent)
      throw new Error("Organizational context requires a final delivery fence");

    const response = await reply(
      await appendAiUsageWarning(input, renderDiscordContextAskResult(result))
    );
    return response
      ? {
          ...response,
          ...(contextAsk.contextIntelligence.requireCurrent
            ? {
                requireCurrent: () =>
                  contextAsk.contextIntelligence.requireCurrent!(inquiry)
              }
            : {}),
          sourceProof: {
            workspaceId: input.workspace.workspaceId,
            subject: { ...result.subject },
            question: result.question,
            contentHash: result.boundary.contentHash
          }
        }
      : null;
  } catch (error: unknown) {
    if (ask.purpose === "decision-record")
      return reply(
        renderDecisionRecordFailure(
          error,
          `discord:${ask.messageId}:decision-record`,
          ask.messageId
        )
      );
    if (
      error instanceof ContextIntelligenceError &&
      (error.code === "context-answer-already-attempted" ||
        error.code === "context-answer-invalid" ||
        error.code === "context-answer-unavailable")
    )
      return reply(
        "Luma already attempted this question but has no deliverable answer. It has not repeated the possible paid request. Check @Luma usage; post a new question for a new attempt."
      );
    if (
      error instanceof ContextIntelligenceError &&
      (error.code === "context-inquiry-source-changed" ||
        error.code === "context-inquiry-context-changed")
    ) {
      return reply(
        "The conversation or organizational context changed or is no longer readable. Post a new @Luma question to use its current state."
      );
    }
    return reply(renderAiServiceFailure(error));
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
  input: ScopedDiscordMeetingBotInput,
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

  const surface = await input.channelScope.requireChannel(
    meetingThread.thread_id,
    "public-thread"
  );
  if (
    surface.parentChannelId !== meetingThread.parent_channel_id ||
    surface.guildId !== meetingThread.guild_id
  )
    throw new DiscordChannelAccessError();

  const mentions = await resolveDiscordMentions({
    identityDirectory: input.identityDirectory,
    workspaceId: publishInput.workspaceId,
    personIds: publishInput.mentionPersonIds ?? []
  });
  const allowedUserIds = mentions.map((mention) => mention.userId);
  const mentionContent = mentions.map((mention) => mention.content);

  const publicationState = await queryMeetingSnapshot(input, meetingThread);
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

    await requireImportedMeetingCurrent(input, publicationState);
    await input.transport.sendMessage(message);
  }
}

async function handleCommand(
  input: ScopedDiscordMeetingBotInput,
  command: DiscordCommand,
  now: () => Date,
  accessPolicy: WorkspaceAccessPolicy,
  channelScope: ReturnType<typeof createDiscordChannelScope>
): Promise<DiscordCommandResponse> {
  if (command.guildId !== input.guildId) {
    return {
      content: "Luma is not configured for this Discord server."
    };
  }

  if (
    !(await accessPolicy.authorize({
      workspaceId: input.workspace.workspaceId,
      providerId: "discord",
      providerUserId: command.actorDiscordUserId
    }))
  ) {
    return { content: "You do not have access to Luma in this workspace." };
  }

  const surface = await channelScope.resolveAllowedChannel(command.channelId);
  if (!surface || (command.type === "start" && surface.kind !== "text-channel")) {
    return { content: new DiscordChannelAccessError().message };
  }
  try {
    const sourceFence = await commandSourceFence(input, command);
    await sourceFence?.();
    const response = isStructuredWorkCommand(command)
      ? input.structuredWork &&
        surface.kind === "public-thread" &&
        surface.parentChannelId &&
        input.structuredWork.config.parentChannelIds.includes(surface.parentChannelId) &&
        input.structuredWork.config.allowedDiscordUserIds.includes(
          command.actorDiscordUserId
        )
        ? await executeStructuredWorkCommand(input, command)
        : { content: "Structured work is not enabled for you in this discussion." }
      : isGranolaCommand(command)
        ? await handleGranola(input, command, accessPolicy)
        : isCaptureReviewCommand(command)
          ? await handleCaptureReview(input, command, accessPolicy)
          : command.type === "usage"
            ? { content: await readAiUsage(input) }
            : isConsultationCommand(command)
              ? input.consultations
                ? await handleDiscordConsultationCommand({
                    runtime: input.consultations,
                    workspace: input.workspace,
                    command,
                    accessPolicy
                  })
                : {
                    content:
                      "Advisory consultations are not configured in this workspace."
                  }
              : isDecisionRecordCommand(command)
                ? input.decisionRecords &&
                  surface.kind === "public-thread" &&
                  surface.parentChannelId &&
                  input.decisionRecords.config.parentChannelIds.includes(
                    surface.parentChannelId
                  ) &&
                  input.decisionRecords.config.allowedDiscordUserIds.includes(
                    command.actorDiscordUserId
                  )
                  ? await executeDecisionRecordCommand(input, command)
                  : {
                      content:
                        "Decision Records are not enabled for you in this discussion."
                    }
                : await executeAdmittedCommand(input, command, now);
    const content =
      command.type === "usage"
        ? response.content
        : await appendAiUsageWarning(input, response.content);
    const requireCurrent = async () => {
      if (
        !(await accessPolicy.authorize({
          workspaceId: input.workspace.workspaceId,
          providerId: "discord",
          providerUserId: command.actorDiscordUserId
        }))
      )
        throw new DiscordChannelAccessError();
      await sourceFence?.();
      await response.requireCurrent?.();
      await channelScope.requireChannel(command.channelId);
    };
    await requireCurrent();
    return {
      content,
      ...(sourceFence || response.requireCurrent ? { requireCurrent } : {})
    };
  } catch (error: unknown) {
    if (isStructuredWorkCommand(command))
      return { content: renderStructuredWorkFailure(error, command) };
    if (isDecisionRecordCommand(command))
      return {
        content: renderDecisionRecordFailure(
          error,
          discordDecisionRequestId(command),
          "sourceMessageId" in command ? command.sourceMessageId : undefined
        )
      };
    return {
      content:
        error instanceof DiscordGranolaUnavailableError ||
        error instanceof DiscordCaptureReviewUnavailableError ||
        error instanceof ImportedMeetingReviewUnavailableError ||
        error instanceof ConversationConsultationError
          ? error.message
          : error instanceof DiscordChannelAccessError ||
              !(await channelScope.resolveAllowedChannel(command.channelId))
            ? new DiscordChannelAccessError().message
            : renderAiServiceFailure(error)
    };
  }
}

async function executeStructuredWorkCommand(
  input: ScopedDiscordMeetingBotInput,
  command: DiscordStructuredWorkCommand
): Promise<DiscordCommandResponse> {
  if (!input.structuredWork) throw new Error("Structured work is not configured");
  if (!command.meeting)
    return handleDiscordStructuredWorkCommand({
      runtime: input.structuredWork,
      workspace: input.workspace,
      command
    });
  const binding = await findMeetingThreadForChannel(
    input,
    command.guildId,
    command.channelId,
    "include-ended-thread"
  );
  if (!binding || binding.thread_id !== command.channelId)
    return {
      content:
        "Bind this thread to its imported Meeting with /meeting bind first, or omit meeting:true to use only the discussion."
    };
  const state = await queryMeetingSnapshot(input, binding);
  if (!state.importedSources.length)
    return { content: "This request requires an actual imported Meeting binding." };
  const requireBinding = async () => {
    const current = await findMeetingThreadForChannel(
      input,
      command.guildId,
      command.channelId,
      "include-ended-thread"
    );
    if (
      !current ||
      current.meeting_id !== binding.meeting_id ||
      current.thread_id !== binding.thread_id ||
      current.parent_channel_id !== binding.parent_channel_id
    )
      throw new ImportedMeetingReviewUnavailableError();
    await requireImportedMeetingCurrent(input, state);
  };
  await requireBinding();
  const response = await handleDiscordStructuredWorkCommand({
    runtime: input.structuredWork,
    workspace: input.workspace,
    command,
    meetingId: binding.meeting_id,
    requireCurrent: requireBinding
  });
  return {
    content: response.content,
    requireCurrent: async () => {
      await requireBinding();
      await response.requireCurrent?.();
    }
  };
}

async function executeDecisionRecordCommand(
  input: ScopedDiscordMeetingBotInput,
  command: DiscordDecisionRecordCommand
): Promise<DiscordCommandResponse> {
  if (!input.decisionRecords) throw new Error("Decision Records are not configured");
  if ("sourceMessageId" in command && command.sourceMessageId)
    return handleDiscordDecisionRecordCommand({
      runtime: input.decisionRecords,
      workspace: input.workspace,
      command
    });
  const binding = await findMeetingThreadForChannel(
    input,
    command.guildId,
    command.channelId,
    "include-ended-thread"
  );
  if (!binding || binding.thread_id !== command.channelId)
    return {
      content:
        "Attach this thread to its imported Meeting with /meeting bind first, or supply source_message for a Conversation request."
    };
  const state = await queryMeetingSnapshot(input, binding);
  if (!state.importedSources.length)
    return {
      content:
        "This command needs an imported Meeting binding. Use an explicit @Luma recording request for the discussion."
    };
  const requireBinding = async () => {
    const current = await findMeetingThreadForChannel(
      input,
      command.guildId,
      command.channelId,
      "include-ended-thread"
    );
    if (
      !current ||
      current.meeting_id !== binding.meeting_id ||
      current.thread_id !== binding.thread_id ||
      current.parent_channel_id !== binding.parent_channel_id
    )
      throw new ImportedMeetingReviewUnavailableError();
    await requireImportedMeetingCurrent(input, state);
  };
  await requireBinding();
  const response = await handleDiscordDecisionRecordCommand({
    runtime: input.decisionRecords,
    workspace: input.workspace,
    command,
    meetingId: binding.meeting_id,
    requireCurrent: requireBinding
  });
  await requireBinding();
  return {
    content: response.content,
    requireCurrent: async () => {
      await requireBinding();
      await response.requireCurrent?.();
    }
  };
}

async function handleGranola(
  input: ScopedDiscordMeetingBotInput,
  command: DiscordGranolaCommand,
  accessPolicy: WorkspaceAccessPolicy
): Promise<DiscordCommandResponse> {
  if (!input.granola)
    return { content: "Granola connections are not configured in this workspace." };
  const actor = await accessPolicy.authorize({
    workspaceId: input.workspace.workspaceId,
    providerId: "discord",
    providerUserId: command.actorDiscordUserId
  });
  if (!actor) throw new DiscordChannelAccessError();
  return input.granola.handle({ command, actorPersonId: actor.personId });
}

async function handleCaptureReview(
  input: ScopedDiscordMeetingBotInput,
  command: DiscordCaptureReviewCommand,
  accessPolicy: WorkspaceAccessPolicy
): Promise<DiscordCommandResponse> {
  if (!input.captureReview)
    return { content: "Captured meeting synthesis is not configured in this workspace." };
  const actor = await accessPolicy.authorize({
    workspaceId: input.workspace.workspaceId,
    providerId: "discord",
    providerUserId: command.actorDiscordUserId
  });
  if (!actor) throw new DiscordChannelAccessError();
  const thread = await findMeetingThreadForChannel(
    input,
    command.guildId,
    command.channelId,
    "include-ended-thread"
  );
  return input.captureReview.handle({
    command,
    actorPersonId: actor.personId,
    ...(thread ? { boundMeetingId: thread.meeting_id } : {})
  });
}

async function readAiUsage(input: CreateDiscordMeetingBotInput): Promise<string> {
  if (!input.aiUsage)
    return "AI usage tracking is not configured. A founder needs to check the AI provider and pricing configuration before paid AI use.";
  try {
    return renderAiUsageStatus(
      await input.aiUsage.getStatus(input.workspace.workspaceId)
    );
  } catch {
    return "Luma could not read AI usage right now. Please try /meeting usage again later.";
  }
}

async function appendAiUsageWarning(
  input: ScopedDiscordMeetingBotInput,
  content: string
): Promise<string> {
  if (!input.aiUsage) return content;
  try {
    const warning = renderAiUsageWarning(
      await input.aiUsage.getStatus(input.workspace.workspaceId)
    );
    return warning ? `${content}\n\n${warning}` : content;
  } catch {
    // A status read must not turn an accepted action into an apparent failure.
    return content;
  }
}

async function executeAdmittedCommand(
  input: ScopedDiscordMeetingBotInput,
  command: Exclude<
    DiscordCommand,
    | { type: "usage" }
    | DiscordConsultationCommand
    | DiscordDecisionRecordCommand
    | DiscordStructuredWorkCommand
    | DiscordCaptureReviewCommand
    | DiscordGranolaCommand
  >,
  now: () => Date
): Promise<DiscordCommandResponse> {
  switch (command.type) {
    case "bind":
      return bindImportedMeeting(input, command, now);
    case "review":
      return reviewMeeting(input, command);
    case "patch":
      return patchCanonicalKnowledge(input, command, now);
    case "owner":
    case "reconcile":
    case "refresh":
      return judgeReconciliation(input, command, now);
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

class ImportedMeetingReviewUnavailableError extends Error {
  constructor() {
    super(
      "Luma withheld this response because current source access or revision could not be verified. Existing decisions and execution receipts are retained. Check the exact source grant and refresh source ingestion."
    );
  }
}

async function requireImportedMeetingCurrent(
  input: ScopedDiscordMeetingBotInput,
  state: MeetingState
): Promise<void> {
  if (!state.importedSources.length) return;
  if (!input.importedMeetingAccess) throw new ImportedMeetingReviewUnavailableError();
  try {
    await input.importedMeetingAccess.requireCurrent({
      state,
      personIds: input.authorizedPersonIds
    });
  } catch {
    throw new ImportedMeetingReviewUnavailableError();
  }
}

async function commandSourceFence(
  input: ScopedDiscordMeetingBotInput,
  command: DiscordCommand
): Promise<(() => Promise<void>) | undefined> {
  if (
    isGranolaCommand(command) ||
    isCaptureReviewCommand(command) ||
    isConsultationCommand(command) ||
    isDecisionRecordCommand(command) ||
    isStructuredWorkCommand(command) ||
    command.type === "usage" ||
    command.type === "bind" ||
    command.type === "start"
  )
    return undefined;
  const thread = await findMeetingThreadForChannel(
    input,
    command.guildId,
    command.channelId,
    "include-ended-thread"
  );
  if (!thread) return undefined;
  const state = await queryMeetingSnapshot(input, thread);
  if (!state.importedSources.length) return undefined;
  // Capture the exact sources used by this operation; a later provider revision cannot authorize an older reply.
  return () => requireImportedMeetingCurrent(input, state);
}

async function bindImportedMeeting(
  input: ScopedDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "bind" }>,
  now: () => Date
): Promise<DiscordCommandResponse> {
  const surface = await input.channelScope.requireChannel(
    command.channelId,
    "public-thread"
  );
  if (!surface.parentChannelId || !input.importedMeetingAccess)
    throw new ImportedMeetingReviewUnavailableError();
  const pageId = notionPageId(command.sourcePage);
  if (!pageId) return { content: "Use the exact Notion Meeting Note page URL or UUID." };
  const meetingId = await input.importedMeetingAccess.resolve({
    workspaceId: input.workspace.workspaceId,
    pageId
  });
  if (!meetingId)
    return {
      content:
        "No unique imported Meeting was found for that page. Wait for source ingestion. A page containing multiple Meeting Note roots cannot be bound safely."
    };
  const result = await input.meetingIntelligence.query({
    workspaceId: input.workspace.workspaceId,
    meetingId,
    query: { type: "snapshot" }
  });
  if (result.type !== "snapshot" || !result.state.importedSources.length)
    throw new ImportedMeetingReviewUnavailableError();
  const requireCurrent = () => requireImportedMeetingCurrent(input, result.state);
  await requireCurrent();
  // Never redirect an existing binding or overwrite another Meeting in this thread.
  const existing = await findMeetingThread(
    input.database,
    input.workspace.workspaceId,
    meetingId
  );
  if (existing)
    return existing.thread_id === command.channelId &&
      existing.guild_id === command.guildId &&
      existing.parent_channel_id === surface.parentChannelId
      ? {
          content:
            "This thread is already attached to the imported Meeting. Use /meeting review.",
          requireCurrent
        }
      : {
          content: "This Meeting already has a Discord thread. Its binding was preserved."
        };
  const bound = await input.database.query(
    `INSERT INTO discord_meeting_threads (workspace_id, meeting_id, guild_id, parent_channel_id, meeting_title, thread_name, language_mode, actor_discord_user_id, meeting_observed_at, thread_id, thread_url, started_at, ended_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$8,$8,$8) ON CONFLICT DO NOTHING RETURNING meeting_id`,
    [
      input.workspace.workspaceId,
      meetingId,
      command.guildId,
      surface.parentChannelId,
      result.state.title,
      "multilingual",
      command.actorDiscordUserId,
      now().toISOString(),
      command.channelId,
      `https://discord.com/channels/${command.guildId}/${command.channelId}`,
      result.state.importedSources[0]!.capturedAt
    ]
  );
  if (!bound.rows.length)
    return {
      content:
        "This thread or Meeting was attached by another command. Its binding was preserved."
    };
  await requireCurrent();
  return {
    content:
      "Imported Meeting attached. Use /meeting review to inspect the original wording, ownership and canonical work matches.",
    requireCurrent
  };
}

function notionPageId(value: string): string | null {
  const direct = canonicalNotionObjectId(value.trim());
  if (direct) return direct;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !["notion.so", "www.notion.so", "app.notion.com"].includes(url.hostname)
    )
      return null;
    const segment = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    return (
      canonicalNotionObjectId(segment) ?? canonicalNotionObjectId(segment.slice(-32))
    );
  } catch {
    return null;
  }
}

async function currentReviewState(
  input: ScopedDiscordMeetingBotInput,
  thread: DiscordMeetingThreadRow
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await queryMeetingSnapshot(input, thread);
    const result = await input.meetingIntelligence.query({
      workspaceId: thread.workspace_id,
      meetingId: thread.meeting_id,
      query: { type: "action-item-reconciliation-review" }
    });
    if (result.type !== "action-item-reconciliation-review")
      throw new Error("Unexpected reconciliation query result");
    const current = await queryMeetingSnapshot(input, thread);
    if (state.revision === current.revision)
      return { state: current, reviews: result.reviews };
  }
  throw new Error("The Meeting changed repeatedly while reading its review");
}

async function reviewMeeting(
  input: ScopedDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "review" }>
): Promise<DiscordCommandResponse> {
  const context = await resolveMeetingActor(input, command, "include-ended-thread");
  if ("response" in context) return context.response;
  const view = await currentReviewState(input, context.meetingThread);
  if (command.reviewId)
    view.reviews = view.reviews.filter(
      (review) => review.proposal.id === command.reviewId
    );
  const pages = renderReconciliationReviewPages(view);
  if (
    !Number.isSafeInteger(command.page) ||
    command.page < 1 ||
    command.page > pages.length
  )
    return { content: `Choose a review page from 1 to ${pages.length}.` };
  return { content: pages[command.page - 1]! };
}

async function judgeReconciliation(
  input: ScopedDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "owner" | "reconcile" | "refresh" }>,
  now: () => Date
): Promise<DiscordCommandResponse> {
  const context = await resolveMeetingActor(input, command, "include-ended-thread");
  if ("response" in context) return context.response;
  const view = await currentReviewState(input, context.meetingThread);
  let judgment: HumanJudgment;
  let review: CurrentActionItemReconciliationReview | undefined;
  if (command.type === "owner") {
    review = view.reviews.find((review) => review.ownershipClaimId === command.claimId);
    if (!review)
      return {
        content:
          "That ownership claim is no longer current. Use /meeting review for its current revision."
      };
    let resolution: Extract<
      HumanJudgment,
      { kind: "resolve-action-item-ownership" }
    >["resolution"];
    if (command.ownership === "confirm-owner") {
      if (!command.ownerDiscordUserId)
        return { content: "Select the founder who owns this Action Item." };
      const people = await input.identityDirectory.findPeopleByProviderUserId({
        workspaceId: input.workspace.workspaceId,
        providerId: "discord",
        providerUserId: command.ownerDiscordUserId
      });
      const owner = people[0];
      if (
        people.length !== 1 ||
        !owner ||
        !input.authorizedPersonIds.includes(owner.personId)
      )
        return {
          content:
            "The selected owner must uniquely map to one of the four authorized founders."
        };
      resolution = { type: "confirm-owner", ownerPersonId: owner.personId };
    } else {
      if (command.ownerDiscordUserId)
        return { content: "An unassigned or unresolved choice cannot include an owner." };
      resolution = { type: command.ownership };
    }
    judgment = {
      kind: "resolve-action-item-ownership",
      claimId: command.claimId,
      resolution
    };
  } else {
    review = view.reviews.find((review) => review.proposal.id === command.reviewId);
    if (!review)
      return {
        content:
          "That review is no longer current. Use /meeting review for its current revision."
      };
    if (command.type === "refresh")
      judgment = {
        kind: "refresh-action-item-reconciliation",
        reviewId: command.reviewId
      };
    else {
      let resolution: Extract<
        HumanJudgment,
        { kind: "resolve-action-item-reconciliation" }
      >["resolution"];
      if (command.choice === "link-existing" || command.choice === "update-existing") {
        const matches = review.proposal.searches
          .flatMap((search) => search.workItems)
          .filter((work) => work.externalId === command.externalId);
        const outcome = review.proposal.outcome;
        if (
          (outcome.type === "link-existing" || outcome.type === "update-existing") &&
          outcome.workItem.externalId === command.externalId
        )
          matches.push(outcome.workItem);
        const providers = new Set(matches.map((work) => work.providerId));
        if (providers.size !== 1 || !matches[0])
          return {
            content:
              "Select an exact target ID already shown in this review. Use /meeting refresh if canonical work has changed."
          };
        resolution = {
          type: "select-existing",
          providerId: matches[0].providerId,
          externalId: matches[0].externalId,
          action: command.choice
        };
      } else {
        if (command.externalId)
          return {
            content: "Only a link or update choice can select an existing target."
          };
        resolution = {
          type: command.choice,
          ...((command.choice === "reject-proposal" ||
            command.choice === "select-needs-clarification") &&
          command.reason
            ? { reason: command.reason }
            : {})
        };
      }
      judgment = {
        kind: "resolve-action-item-reconciliation",
        reviewId: command.reviewId,
        resolution
      };
    }
  }
  await requireImportedMeetingCurrent(input, view.state);
  const update = await input.meetingIntelligence.observe({
    workspace: input.workspace,
    observations: [
      {
        type: "human-judgment-recorded",
        observationId: `discord:${command.interactionId}:${command.type}`,
        workspaceId: context.meetingThread.workspace_id,
        meetingId: context.meetingThread.meeting_id,
        occurredAt: command.occurredAt,
        observedAt: now().toISOString(),
        participantId: context.actor.personId,
        judgment
      }
    ]
  });
  const error = update.errors[0];
  if (error)
    return {
      content: `No review decision was applied: ${"message" in error ? error.message : error.code}`
    };
  const after = await queryMeetingSnapshot(input, context.meetingThread);
  if (command.type !== "reconcile")
    return {
      content:
        "Human Judgment recorded. Use /meeting review to inspect the current ownership and reconciliation proposal."
    };
  const intents = after.followUpIntentions.filter((intent) =>
    reviewIntent(intent, command.reviewId)
  );
  const intent = intents.find((intent) => intent.type === "settle-operational-outcome");
  if (command.execute && intent)
    return approveFollowUp(
      input,
      { ...command, type: "approve", intentId: intent.id },
      now
    );
  return {
    content: `Reconciliation decision recorded.${intent ? ` Follow-up ${intent.id} is ${intent.status}. Use /meeting approve to execute it.` : " No executable follow-up was produced."}`
  };
}

async function recordMeetingNote(
  input: ScopedDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "note" }>,
  now: () => Date
): Promise<DiscordCommandResponse> {
  const context = await resolveMeetingActor(input, command, "active");

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
  if (update.analysisStatus === "deferred") {
    return { content: renderDeferredAnalysis(update.errors) };
  }
  const snapshot = await queryMeetingSnapshot(input, context.meetingThread);
  const suggestedIntents = snapshot.followUpIntentions.filter(
    (intent) => intent.status === "suggested"
  );

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

/** Revalidate both Discord surfaces after all preparation, immediately before execution. */
async function requireFollowUpExecutionScope(
  input: ScopedDiscordMeetingBotInput,
  command: DiscordCommandBase,
  meetingThread: DiscordMeetingThreadRow
): Promise<void> {
  if (
    !meetingThread.thread_id ||
    meetingThread.guild_id !== command.guildId ||
    meetingThread.workspace_id !== input.workspace.workspaceId ||
    (command.channelId !== meetingThread.thread_id &&
      command.channelId !== meetingThread.parent_channel_id)
  )
    throw new DiscordChannelAccessError();

  await requireImportedMeetingCurrent(
    input,
    await queryMeetingSnapshot(input, meetingThread)
  );
  const threadCheck = input.channelScope.requireChannel(
    meetingThread.thread_id,
    "public-thread"
  );
  const commandCheck =
    command.channelId === meetingThread.thread_id
      ? threadCheck
      : input.channelScope.requireChannel(command.channelId, "text-channel");
  const [, thread] = await Promise.all([commandCheck, threadCheck]);
  if (
    thread.parentChannelId !== meetingThread.parent_channel_id ||
    thread.guildId !== meetingThread.guild_id
  )
    throw new DiscordChannelAccessError();
}

async function patchCanonicalKnowledge(
  input: ScopedDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "patch" }>,
  now: () => Date
): Promise<DiscordCommandResponse> {
  const context = await resolveMeetingActor(input, command, "include-ended-thread");
  if ("response" in context) return context.response;
  if (!input.followUpExecution)
    return { content: "Follow-up execution is not configured." };
  const pageId = canonicalNotionObjectId(command.pageId);
  if (!pageId)
    return { content: "Select the existing canonical Notion page by its exact page ID." };
  const state = await queryMeetingSnapshot(input, context.meetingThread);
  const intent = state.followUpIntentions.find(
    (candidate) => candidate.id === command.intentId
  );
  if (intent?.type !== "settle-operational-outcome")
    return { content: "Select a source-bound settlement from /meeting review first." };
  const review = state.actionItemReconciliationReviews.find(
    (item) => item.id === intent.reconciliation.reviewId
  );
  const providerId = review?.candidate.source.source.providerId;
  if (!providerId)
    return { content: "The source-bound Notion provider could not be established." };
  await requireImportedMeetingCurrent(input, state);
  await requireFollowUpExecutionScope(input, command, context.meetingThread);
  const approval = await input.meetingIntelligence.observe({
    workspace: input.workspace,
    observations: [
      {
        type: "human-judgment-recorded",
        observationId: `discord:${command.interactionId}:canonical-patch`,
        workspaceId: context.meetingThread.workspace_id,
        meetingId: context.meetingThread.meeting_id,
        occurredAt: command.occurredAt,
        observedAt: now().toISOString(),
        participantId: context.actor.personId,
        judgment: {
          kind: "approve-canonical-knowledge-patch",
          intentId: intent.id,
          target: {
            providerId,
            objectType: "document",
            externalId: pageId,
            url: `https://www.notion.so/${pageId.replaceAll("-", "")}`
          },
          expectedMarkdown: command.expectedMarkdown,
          replacementMarkdown: command.replacementMarkdown
        }
      }
    ]
  });
  const error = approval.errors[0];
  if (error)
    return {
      content: `Canonical patch was not approved: ${"message" in error ? error.message : error.code}`
    };
  await requireFollowUpExecutionScope(input, command, context.meetingThread);
  const result = await input.followUpExecution.execute({
    workspace: input.workspace,
    meetingId: context.meetingThread.meeting_id,
    intentId: intent.id
  });
  await publishMeetingEvents(input, {
    workspaceId: context.meetingThread.workspace_id,
    meetingId: context.meetingThread.meeting_id,
    events: result.events,
    mentionPersonIds: [context.actor.personId],
    idempotencyKeyPrefix: result.idempotencyKey
  });
  return {
    content:
      result.observation.outcome.status === "succeeded"
        ? "Canonical knowledge patch and its Meeting Operational Outcome were completed."
        : `Canonical patch needs attention: ${result.observation.outcome.message} Use /meeting recover intent_id:${intent.id} to inspect an uncertain outcome; conflicts require fresh review.`
  };
}

async function approveFollowUp(
  input: ScopedDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "approve" }>,
  now: () => Date
): Promise<DiscordCommandResponse> {
  const context = await resolveMeetingActor(input, command, "include-ended-thread");

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

  if (intent.type === "update-knowledge") {
    return {
      content:
        "This legacy generic knowledge update is disabled. Luma will not create or update a Notion document without a Human-selected canonical target, exact region, and conflict policy."
    };
  }

  if (intent.status === "rejected") {
    return { content: `Follow-up Intent was rejected: ${command.intentId}` };
  }

  if (intent.status === "succeeded")
    return { content: `Follow-up already executed: ${command.intentId}` };
  if (intent.status === "partially-succeeded")
    return {
      content: `Follow-up is only partly complete. Use /meeting recover intent_id:${command.intentId} to resume the unfinished stage.`
    };

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

  await requireFollowUpExecutionScope(input, command, context.meetingThread);
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

  if (result.observation.outcome.status === "partially-succeeded")
    return {
      content: `Follow-up needs attention: ${result.observation.outcome.message} Use /meeting recover intent_id:${intent.id}. Completed writes are retained.`
    };
  return {
    content: firstReference
      ? `Follow-up completed: ${firstReference.url}`
      : `Follow-up completed: ${intent.id}`
  };
}

async function recoverFollowUp(
  input: ScopedDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "recover" }>
): Promise<DiscordCommandResponse> {
  const context = await resolveMeetingActor(input, command, "include-ended-thread");

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
  const canProbeManualLegacyGenericKnowledgeCreate =
    intent.type === "update-knowledge" && intent.status === "requires-manual-recovery";

  if (
    intent.status !== "approved" &&
    !canRecoverPartialOperationalOutcome &&
    !canProbeManualOperationalOutcome &&
    !canProbeManualLegacyGenericKnowledgeCreate
  ) {
    return {
      content: `Follow-up is not recoverable: ${intent.id} is ${intent.status}.`
    };
  }

  if (!input.followUpExecution) {
    return { content: "Follow-up execution is not configured." };
  }

  let result: ExecuteFollowUpResult;

  await requireFollowUpExecutionScope(input, command, context.meetingThread);
  try {
    result = await input.followUpExecution.recover({
      workspace: input.workspace,
      meetingId: context.meetingThread.meeting_id,
      intentId: intent.id
    });
  } catch {
    return {
      content:
        "Follow-up recovery could not run. Its provider outcome is still unconfirmed; please try recovery again later."
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
  input: ScopedDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "reject" }>,
  now: () => Date
): Promise<DiscordCommandResponse> {
  const context = await resolveMeetingActor(input, command, "include-ended-thread");

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
  input: ScopedDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "stop" }>,
  now: () => Date
): Promise<DiscordCommandResponse> {
  const meetingThread = await findMeetingThreadForChannel(
    input,
    command.guildId,
    command.channelId,
    "active"
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

    await requireImportedMeetingCurrent(input, snapshot.state);
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
  input: ScopedDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "start" }>,
  now: () => Date
): Promise<DiscordCommandResponse> {
  const existing = await findMeetingThreadForChannel(
    input,
    command.guildId,
    command.channelId,
    "active"
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
  input: ScopedDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "catchup" }>
): Promise<DiscordCommandResponse> {
  const meetingThread = await findMeetingThreadForChannel(
    input,
    command.guildId,
    command.channelId,
    "include-ended-thread"
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
  input: ScopedDiscordMeetingBotInput,
  command: Extract<DiscordCommand, { type: "ask" }>
): Promise<DiscordCommandResponse> {
  const meetingThread = await findMeetingThreadForChannel(
    input,
    command.guildId,
    command.channelId,
    "include-ended-thread"
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
    content: renderScopedMeetingAnswer(result.answer.text, result.answer.evidence)
  };
}

type DiscordMeetingThreadRow = {
  guild_id: string;
  parent_channel_id: string;
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

type MeetingThreadScope = "active" | "include-ended-thread";

async function resolveMeetingActor(
  input: ScopedDiscordMeetingBotInput,
  command: DiscordCommandBase,
  scope: MeetingThreadScope
): Promise<
  | {
      meetingThread: DiscordMeetingThreadRow;
      actor: NonNullable<
        Awaited<ReturnType<IdentityDirectory["findPersonByDiscordUserId"]>>
      >;
    }
  | { response: DiscordCommandResponse }
> {
  const meetingThread = await findMeetingThreadForChannel(
    input,
    command.guildId,
    command.channelId,
    scope
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
  input: ScopedDiscordMeetingBotInput,
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
    case "publish-meeting-synthesis":
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
    `SELECT guild_id, parent_channel_id, workspace_id, meeting_id, meeting_title, thread_name, language_mode,
            actor_discord_user_id, started_at, meeting_observed_at, thread_id, thread_url,
            start_message_sent_at, conclusion_message_sent_at
       FROM discord_meeting_threads
      WHERE workspace_id = $1 AND meeting_id = $2
      LIMIT 1`,
    [workspaceId, meetingId]
  );

  return result.rows[0] ?? null;
}

async function findMeetingThreadForChannel(
  input: ScopedDiscordMeetingBotInput,
  guildId: string,
  channelId: string,
  scope: MeetingThreadScope
): Promise<DiscordMeetingThreadRow | null> {
  const result = await input.database.query<DiscordMeetingThreadRow>(
    `SELECT guild_id, parent_channel_id, workspace_id, meeting_id, meeting_title, thread_name, language_mode,
            actor_discord_user_id, started_at, meeting_observed_at, thread_id, thread_url,
            start_message_sent_at, conclusion_message_sent_at
       FROM discord_meeting_threads
      WHERE guild_id = $1 AND workspace_id = $4
        AND (
          (parent_channel_id = $2 AND ended_at IS NULL)
          OR (thread_id = $2 AND (ended_at IS NULL OR $3))
        )
      ORDER BY created_at DESC
      LIMIT 1`,
    [guildId, channelId, scope === "include-ended-thread", input.workspace.workspaceId]
  );

  const meetingThread = result.rows[0] ?? null;
  if (meetingThread?.thread_id) {
    const surface = await input.channelScope.requireChannel(
      meetingThread.thread_id,
      "public-thread"
    );
    if (
      surface.parentChannelId !== meetingThread.parent_channel_id ||
      surface.guildId !== meetingThread.guild_id
    )
      throw new DiscordChannelAccessError();
  }
  return meetingThread;
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
  input: ScopedDiscordMeetingBotInput,
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

/** Preserve whole claims and references inside Discord's message budget. */
function renderScopedMeetingAnswer(
  text: string,
  evidence: Array<{ source: string; sourceObjectId: string }>
): string {
  if (text.length > 1600)
    return "This Meeting answer is too large to display safely. Ask about a narrower topic.";
  const references: string[] = [];
  const unique = [
    ...new Set(
      evidence.map((reference) => `${reference.source}:${reference.sourceObjectId}`)
    )
  ];
  for (const reference of unique) {
    const candidate = `${text}\n\nEvidence: ${[...references, reference].join(", ")}`;
    if (candidate.length > 1850) continue;
    references.push(reference);
  }
  const omitted = unique.length - references.length;
  return `${text}\n\nEvidence: ${references.join(", ") || (omitted > 0 ? "none displayed" : "none")}${omitted > 0 ? `; ${omitted} additional reference(s) retained in the Meeting record.` : ""}`;
}

function isConsultationCommand(
  command: DiscordCommand
): command is DiscordConsultationCommand {
  return command.type.startsWith("consultation-");
}

function isDecisionRecordCommand(
  command: DiscordCommand
): command is DiscordDecisionRecordCommand {
  return command.type.startsWith("decision-record-");
}
