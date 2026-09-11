import { AiServiceError } from "../ai/ai-service-error.js";
import { renderAiServiceFailure } from "./discord-ai-status.js";
import type { DecisionIntelligence } from "../decision-intelligence/interface.js";
import type {
  DecisionRequestState,
  DecisionSubject
} from "../domain/decision-records.js";
import type { WorkspaceConfig } from "../domain/model.js";
import type { DecisionFollowUpExecution } from "../follow-up-execution/interface.js";
import type {
  DiscordCommandBase,
  DiscordCommandResponse
} from "./discord-meeting-bot.js";
import {
  discordContextAskConfigFromEnv,
  type DiscordContextAskConfig,
  type DiscordContextAskMention
} from "./discord-context-ask-runtime.js";

/** Explicit recording has its own source scope; enabling Ask never grants writes. */
export function discordDecisionRecordConfigFromEnv(
  env: NodeJS.ProcessEnv
): DiscordContextAskConfig | undefined {
  const prefix = "LUMA_DISCORD_DECISION_RECORDS";
  const enabled = env[`${prefix}_ENABLED`]?.trim();
  if (!enabled || enabled === "0") return undefined;
  if (enabled !== "1") throw new Error(`${prefix}_ENABLED must be 0 or 1`);
  const mapped: NodeJS.ProcessEnv = { LUMA_DISCORD_CONTEXT_ASK_ENABLED: "1" };
  for (const suffix of [
    "PARENT_CHANNEL_IDS",
    "ALLOWED_DISCORD_USER_IDS",
    "MAX_MESSAGES",
    "MAX_EVIDENCE_CHARS",
    "MIN_INTERVAL_MS"
  ]) {
    const value = env[`${prefix}_${suffix}`];
    if (value !== undefined) mapped[`LUMA_DISCORD_CONTEXT_ASK_${suffix}`] = value;
  }
  try {
    return discordContextAskConfigFromEnv(mapped);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new Error(error.message.replaceAll("LUMA_DISCORD_CONTEXT_ASK", prefix));
  }
}

/**
 * Routes an explicit original instruction only. The owned decision module still
 * decides what was agreed, who had authority, and whether any write is justified.
 * This must never be called against retrieved discussion, model text, or quotes
 * as a substitute for an authenticated leading @Luma message.
 */
export function isExplicitDecisionRecordInstruction(text: string): boolean {
  const instruction = text.trim();
  if (instruction.length === 0 || instruction.length > 2_000) return false;
  const english = instruction.replace(
    /^(?:(?:please\s+)|(?:(?:can|could|would)\s+you\s+(?:please\s+)?))/iu,
    ""
  );
  if (
    /^(?:create|make)\s+(?:(?:a|the|this)\s+)?decision\s+record\b/iu.test(english) ||
    /^(?:record|document)\s+(?:this|the|our)\s+decision\b/iu.test(english) ||
    /^update\s+(?:(?:the|this|our)\s+)?(?:existing\s+)?decision(?:\s+record)?\b/iu.test(
      english
    )
  )
    return true;
  const german = instruction.replace(
    /^(?:bitte\s+|(?:kannst|könntest|würdest)\s+du\s+(?:bitte\s+)?)/iu,
    ""
  );
  if (
    /^(?:dokumentiere|halte|erstelle|erstell|aktualisiere)\s+(?:bitte\s+)?(?:(?:diese|die|unsere|einen|den|diesen)\s+)?(?:bestehenden?\s+)?(?:entscheidung|decision\s+record|entscheidungsvermerk|entscheidungsdatensatz)\s+(?:bitte\s+)?(?:noch\s+)?nicht\b/iu.test(
      german
    )
  )
    return false;
  return (
    /^(?:erstelle|erstell)\s+(?:bitte\s+)?(?:(?:einen|den|diesen)\s+)?(?:decision\s+record|entscheidungsvermerk|entscheidungsdatensatz)\b/iu.test(
      german
    ) ||
    /^dokumentiere\s+(?:bitte\s+)?(?:diese|die|unsere)\s+entscheidung\b/iu.test(german) ||
    /^(?:diese|die|unsere)\s+entscheidung\s+(?:bitte\s+)?(?:dokumentieren|festhalten)\b/iu.test(
      german
    ) ||
    /^halte\s+(?:bitte\s+)?(?:diese|die|unsere)\s+entscheidung\s+(?:bitte\s+)?fest\b/iu.test(
      german
    ) ||
    /^aktualisiere\s+(?:bitte\s+)?(?:(?:den|die|diesen|diese)\s+)?(?:bestehenden?\s+)?(?:decision\s+record|entscheidungsvermerk|entscheidungsdatensatz|entscheidung)\b/iu.test(
      german
    )
  );
}

export type DiscordDecisionRecordRuntime = {
  meetingIntelligence: DecisionIntelligence;
  execution: DecisionFollowUpExecution;
  config: DiscordContextAskConfig;
};
export type DiscordDecisionRecordCommand = DiscordCommandBase & {
  type: "decision-record-status" | "decision-record-recover";
  sourceMessageId: string;
  requestId: string;
};

/** The Discord edge forwards one original instruction to the owned MI facade. */
export async function handleDiscordDecisionRecordMention(input: {
  runtime: DiscordDecisionRecordRuntime;
  workspace: WorkspaceConfig;
  mention: DiscordContextAskMention;
}): Promise<DiscordCommandResponse> {
  const { runtime, workspace, mention } = input;
  if (!isExplicitDecisionRecordInstruction(mention.question))
    throw new Error("An explicit Decision Record instruction is required");
  const subject = conversationSubject(mention.channelId, mention.messageId);
  const result = await runtime.meetingIntelligence.observe({
    workspace,
    subject,
    observations: [
      {
        type: "decision-record-requested",
        observationId: `discord:${mention.messageId}:decision-record`,
        actor: { providerId: "discord", providerUserId: mention.actorDiscordUserId },
        instruction: mention.question
      }
    ]
  });
  let executionUnavailable = false;
  if (result.approvedIntentId) {
    try {
      await runtime.execution.execute({
        workspace,
        subject,
        decisionRequestId: result.requestId,
        intentId: result.approvedIntentId
      });
    } catch {
      // A later local failure must not hide an already-retained provider receipt.
      executionUnavailable = true;
    }
  }
  return readResponse(
    runtime,
    workspace.workspaceId,
    subject,
    result.requestId,
    executionUnavailable
  );
}

export async function handleDiscordDecisionRecordCommand(input: {
  runtime: DiscordDecisionRecordRuntime;
  workspace: WorkspaceConfig;
  command: DiscordDecisionRecordCommand;
}): Promise<DiscordCommandResponse> {
  const { runtime, workspace, command } = input;
  const subject = conversationSubject(command.channelId, command.sourceMessageId);
  const state = await runtime.meetingIntelligence.query({
    workspaceId: workspace.workspaceId,
    subject,
    query: { type: "decision-request", requestId: command.requestId }
  });
  let executionUnavailable = false;
  if (command.type === "decision-record-recover" && state.approvedIntentId) {
    try {
      await runtime.execution.recover({
        workspace,
        subject,
        decisionRequestId: command.requestId,
        intentId: state.approvedIntentId
      });
    } catch {
      executionUnavailable = true;
    }
  }
  return readResponse(
    runtime,
    workspace.workspaceId,
    subject,
    command.requestId,
    executionUnavailable
  );
}

async function readResponse(
  runtime: DiscordDecisionRecordRuntime,
  workspaceId: string,
  subject: DecisionSubject,
  requestId: string,
  executionUnavailable = false
): Promise<DiscordCommandResponse> {
  const address = {
    workspaceId,
    subject,
    query: { type: "decision-request" as const, requestId }
  };
  const state = await runtime.meetingIntelligence.query(address);
  const retained = JSON.stringify(state);
  return {
    content: `${executionUnavailable && !state.execution ? "Luma could not verify the execution result. Use /decision-record recover before another recording request.\n" : ""}${renderDecisionRecordResponse(state)}`,

    requireCurrent: async () => {
      // The owned query checks original source, authority and canonical target.
      // A newly corrected request must not authorize delivery of the old wording.
      if (JSON.stringify(await runtime.meetingIntelligence.query(address)) !== retained)
        throw new Error("The Decision Record changed before its receipt was delivered");
    }
  };
}
function conversationSubject(
  channelId: string,
  sourceMessageId: string
): DecisionSubject {
  return {
    type: "conversation-thread",
    providerId: "discord",
    conversationObjectId: channelId,
    anchorMessageId: sourceMessageId
  };
}
export function renderDecisionRecordResponse(state: DecisionRequestState): string {
  const outcome = state.execution?.outcome;
  const references = [
    ...new Set(outcome?.references.map((reference) => reference.url) ?? [])
  ].filter(safeReference);
  const source = [
    ...new Set(
      state.source.evidence.map((evidence) => evidence.reference.externalReference?.url)
    )
  ].filter((url): url is string => !!url && safeReference(url));
  const detail =
    state.message.length <= 550
      ? state.message
      : "The detailed result is retained. Check this request with /decision-record status.";
  const lines = [
    `Decision Record: ${state.state}.`,
    detail,
    ...(outcome?.status === "failed" && outcome.requiresManualRecovery
      ? [
          "The external result is uncertain. Luma will not resend automatically. Use /decision-record recover to check for an existing write."
        ]
      : []),
    ...references.slice(0, 2).map((url) => `Record: <${url}>`),
    ...(source[0] ? [`Source: <${source[0]}>`] : []),
    `Request ID: ${state.requestId}.`,
    ...(state.subject.type === "conversation-thread"
      ? [`Source message: ${state.subject.anchorMessageId}.`]
      : [])
  ];
  const rendered = lines.join("\n");
  if (rendered.length <= 1_850) return rendered;
  return `Decision Record: ${state.state}. The full result and any known references are retained. Use /decision-record status with request ID ${state.requestId}.`;
}
function safeReference(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !/[<>\s]/u.test(value)
    );
  } catch {
    return false;
  }
}

/** Fixed failure copy does not disclose provider errors or imply a failed write was absent. */
export function renderDecisionRecordFailure(
  error: unknown,
  requestId: string,
  sourceMessageId: string
): string {
  const reason =
    error instanceof AiServiceError
      ? renderAiServiceFailure(error)
      : "Luma could not verify this Decision Record request. No unverified decision or receipt will be displayed.";
  return `${reason}\nCheck /decision-record status before requesting another write. Request ID: ${requestId}. Source message: ${sourceMessageId}.`;
}
