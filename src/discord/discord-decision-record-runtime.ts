import { hasDecisionRecordingRefusal } from "../decision-intelligence/recording-instruction.js";
import { AiServiceError } from "../ai/ai-service-error.js";
import type { AutomaticDecisionProcessing } from "../app/automatic-decision-processing.js";
import { decisionDigest } from "../decision-intelligence/persistence.js";
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
  if (hasDecisionRecordingRefusal(instruction)) return false;
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
  automatic?: Pick<AutomaticDecisionProcessing, "review">;
  meetingIntelligence: DecisionIntelligence;
  execution: DecisionFollowUpExecution;
  config: DiscordContextAskConfig;
};
export type DiscordDecisionRecordCommand = DiscordCommandBase &
  (
    | { type: "decision-record-meeting"; instruction: string; targetRecordId?: string }
    | {
        type: "decision-record-candidates";
        sourceMessageId?: string;
        candidate?: number;
        page?: number;
      }
    | {
        type: "decision-record-status" | "decision-record-recover";
        sourceMessageId?: string;
        requestId: string;
        page?: number;
      }
    | {
        type: "decision-record-accept";
        sourceMessageId?: string;
        requestId: string;
        reviewToken: string;
        instruction: string;
      }
  );
export function discordDecisionRequestId(command: DiscordDecisionRecordCommand): string {
  if (command.type === "decision-record-candidates")
    return `discord:${command.interactionId}:decision-candidates`;
  return command.type === "decision-record-meeting"
    ? `discord:${command.interactionId}:decision-record`
    : command.requestId;
}

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
  /** Resolved from the bot's existing guarded imported Meeting binding, never user input. */
  meetingId?: string;
  requireCurrent?: () => Promise<void>;
}): Promise<DiscordCommandResponse> {
  const { runtime, workspace, command } = input;
  if (
    command.type === "decision-record-meeting" &&
    hasDecisionRecordingRefusal(command.instruction)
  )
    throw new Error(
      "The recording instruction includes an explicit refusal; no recording was started."
    );
  await input.requireCurrent?.();
  const subject: DecisionSubject =
    "sourceMessageId" in command && command.sourceMessageId
      ? conversationSubject(command.channelId, command.sourceMessageId)
      : input.meetingId
        ? { type: "meeting", meetingId: input.meetingId }
        : (() => {
            throw new Error("Bind this thread to its imported Meeting first");
          })();
  if (command.type === "decision-record-candidates") {
    if (!runtime.automatic)
      return {
        content:
          "Automatic decision processing is not enabled. Explicit recording and /meeting usage remain available."
      };
    const result = await runtime.automatic.review(subject);
    const selected = command.candidate ?? 1;
    if (!Number.isSafeInteger(selected) || selected < 1)
      throw new Error("Select a positive candidate number");
    const batch = result.batch;
    const candidate = batch?.candidates[selected - 1];
    const content = candidate
      ? `Automatic decisions: candidate ${selected}/${batch.candidates.length}.${batch.complete ? "" : " Analysis is incomplete."}\n${renderDecisionRecordResponse(candidate, command.page)}`
      : batch
        ? `${batch.message.slice(0, 1200)}\n${batch.candidates.length} retained candidates. Select candidate:1 through candidate:${Math.max(1, batch.candidates.length)}. /meeting usage remains available.`
        : (
            {
              unseen:
                "This source has not been queued for automatic decisions. A new admitted conversation or accepted Meeting import starts processing.",
              queued: "This source is queued for automatic decision analysis.",
              processing: "This source is being analyzed for decisions.",
              completed:
                "No retained automatic decision review is available for this source.",
              unavailable:
                "Automatic decision analysis is unavailable. Original evidence remains retained. Check /meeting usage; a new explicit recording request remains available.",
              interrupted:
                "Automatic decision analysis was interrupted. Luma has not repeated the paid request. Check /meeting usage before starting a fresh explicit request."
            } as const
          )[result.status];
    return {
      content,
      requireCurrent: async () => {
        await input.requireCurrent?.();
        if (
          decisionDigest(await runtime.automatic!.review(subject)) !==
          decisionDigest(result)
        )
          throw new Error("Automatic decision review changed before delivery");
      }
    };
  }
  const requestId = discordDecisionRequestId(command);
  if (
    command.type === "decision-record-meeting" ||
    command.type === "decision-record-accept"
  ) {
    await runtime.meetingIntelligence.observe({
      workspace,
      subject,
      observations: [
        command.type === "decision-record-meeting"
          ? {
              type: "decision-record-requested",
              observationId: requestId,
              actor: {
                providerId: "discord",
                providerUserId: command.actorDiscordUserId
              },
              instruction: command.instruction,
              ...(command.targetRecordId
                ? { targetRecordId: command.targetRecordId }
                : {})
            }
          : {
              type: "decision-candidate-accepted",
              observationId: `discord:${command.interactionId}:decision-acceptance`,
              requestId,
              actor: {
                providerId: "discord",
                providerUserId: command.actorDiscordUserId
              },
              reviewToken: command.reviewToken,
              instruction: command.instruction
            }
      ]
    });
  }
  const state = await runtime.meetingIntelligence.query({
    workspaceId: workspace.workspaceId,
    subject,
    query: { type: "decision-request", requestId }
  });
  let executionUnavailable = false;
  if (command.type !== "decision-record-status" && state.approvedIntentId) {
    try {
      await input.requireCurrent?.();
      await runtime.execution[
        command.type === "decision-record-recover" ? "recover" : "execute"
      ]({
        workspace,
        subject,
        decisionRequestId: requestId,
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
    requestId,
    executionUnavailable,
    command.type === "decision-record-status" ? (command.page ?? 1) : 1
  );
}

async function readResponse(
  runtime: DiscordDecisionRecordRuntime,
  workspaceId: string,
  subject: DecisionSubject,
  requestId: string,
  executionUnavailable = false,
  page = 1
): Promise<DiscordCommandResponse> {
  const address = {
    workspaceId,
    subject,
    query: { type: "decision-request" as const, requestId }
  };
  const state = await runtime.meetingIntelligence.query(address);
  const retained = JSON.stringify(state);
  return {
    content: `${executionUnavailable && !state.execution ? "Luma could not verify the execution result. Use /decision-record recover before another recording request.\n" : ""}${renderDecisionRecordResponse(state, page)}`,

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
export function renderDecisionRecordResponse(
  state: DecisionRequestState,
  page = 1
): string {
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
    state.message.length <= (state.candidate && state.reviewToken ? 200 : 550)
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
    ...(source[0] && (!state.reviewToken || source[0].length <= 200)
      ? [`Source: <${source[0]}>`]
      : []),
    `Request ID: ${state.requestId}.`,
    ...(state.subject.type === "conversation-thread"
      ? [`Source message: ${state.subject.anchorMessageId}.`]
      : [])
  ];
  if (state.candidate && !state.execution && state.reviewToken) {
    const candidate = state.candidate;
    const details = [
      `Statement: ${candidate.statement.text}`,
      `Scope: ${candidate.scopeId ?? "unclear"}. Decision-maker: ${candidate.decisionMakerPersonIds.join(", ") || "unclear"}.`,
      `Status: ${candidate.modality}. Disposition: ${candidate.disposition}. Effective: ${candidate.effectiveAt ?? "not specified"}.`,
      ...(candidate.context ? [`Context: ${candidate.context.text}`] : []),
      ...candidate.rationale.map((claim) => `Reason: ${claim.text}`),
      ...candidate.alternatives.map((claim) => `Alternative: ${claim.text}`),
      ...candidate.consequences.map((claim) => `Consequence: ${claim.text}`),
      ...candidate.objections.map((claim) => `Objection: ${claim.text}`),
      ...candidate.unresolved.map((value) => `Unresolved: ${value}`),
      ...candidate.relatedWork.map((ref) => `Related work: ${ref.url}`),
      ...candidate.implementationEvidence.map(
        (ref) => `Implementation evidence: ${ref.url}`
      )
    ].join("\n");
    const pages = [""];
    for (const character of details) {
      if (pages[pages.length - 1]!.length + character.length > 500) pages.push("");
      pages[pages.length - 1] += character;
    }
    const selected =
      Number.isSafeInteger(page) && page >= 1 ? Math.min(page, pages.length) : 1;
    lines.push(`Candidate review ${selected}/${pages.length}:`, pages[selected - 1]!);
    if (selected < pages.length)
      lines.push(
        `Read the remaining details with /decision-record status page:${selected + 1}.`
      );
    else
      lines.push(
        `Review token: ${state.reviewToken}`,
        "If this is your decision, use /decision-record accept with this token and your literal confirmation. Unresolved qualifications still require clarification."
      );
  }
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
  sourceMessageId?: string
): string {
  const reason =
    error instanceof AiServiceError
      ? renderAiServiceFailure(error)
      : "Luma could not verify this Decision Record request. No unverified decision or receipt will be displayed.";
  return `${reason}\nCheck /decision-record status before requesting another write. Request ID: ${requestId}.${sourceMessageId ? ` Source message: ${sourceMessageId}.` : ""}`;
}
