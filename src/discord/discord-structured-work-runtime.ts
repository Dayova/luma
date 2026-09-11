import { createHash } from "node:crypto";
import type { ConversationEvidenceSource } from "../context-intelligence/conversation-evidence-source.js";
import type { WorkspaceConfig } from "../domain/model.js";
import type {
  StructuredWorkConversationSubject,
  StructuredWorkState,
  StructuredWorkUpdateValue,
  StructuredWorkSubject
} from "../domain/structured-work.js";
import type {
  StructuredWorkExecution,
  StructuredWorkIntelligence
} from "../structured-work/interface.js";
import { isExplicitStructuredWorkInstruction } from "../structured-work/explicit-instruction.js";
import { AiServiceError } from "../ai/ai-service-error.js";
import { renderAiServiceFailure } from "./discord-ai-status.js";
import {
  discordContextAskConfigFromEnv,
  type DiscordContextAskConfig
} from "./discord-context-ask-runtime.js";
import type {
  DiscordCommandBase,
  DiscordCommandResponse
} from "./discord-meeting-bot.js";

export class DiscordStructuredWorkUnavailableError extends Error {}

export function discordStructuredWorkConfigFromEnv(
  env: NodeJS.ProcessEnv
): DiscordContextAskConfig | undefined {
  const prefix = "LUMA_DISCORD_STRUCTURED_WORK";
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
  } catch {
    throw new Error(
      "Structured work requires a valid explicit Discord founder and parent-channel capture scope."
    );
  }
}

export type DiscordStructuredWorkCommand = DiscordCommandBase & {
  sourceMessageId: string;
  /** Explicitly use the existing guarded imported Meeting binding. */
  meeting: boolean;
} & (
    | { type: "structured-work-request"; targetKey: string; workItemId?: string }
    | {
        type: "structured-work-status" | "structured-work-recover";
        requestId: string;
        page: number;
      }
  );
export function isStructuredWorkCommand(command: {
  type: string;
}): command is DiscordStructuredWorkCommand {
  return [
    "structured-work-request",
    "structured-work-status",
    "structured-work-recover"
  ].includes(command.type);
}
export type DiscordStructuredWorkRuntime = {
  config: DiscordContextAskConfig;
  targetKeys: readonly string[];
  targets?: readonly { key: string; label: string }[];
  source: ConversationEvidenceSource;
  meetingIntelligence: StructuredWorkIntelligence;
  execution: StructuredWorkExecution;
};
/** The same exact original source and selection have one identity across slash-command retries. */
export function discordStructuredWorkRequestId(
  command: DiscordStructuredWorkCommand
): string {
  if (command.type !== "structured-work-request") return command.requestId;
  const selection = createHash("sha256")
    .update(
      JSON.stringify([
        command.guildId,
        command.channelId,
        command.sourceMessageId,
        command.meeting,
        command.targetKey,
        command.workItemId ?? null
      ])
    )
    .digest("hex")
    .slice(0, 24);
  return `discord:${command.sourceMessageId}:structured-work:${selection}`;
}
export async function handleDiscordStructuredWorkCommand(input: {
  runtime: DiscordStructuredWorkRuntime;
  workspace: WorkspaceConfig;
  command: DiscordStructuredWorkCommand;
  meetingId?: string;
  /** Native mentions must still match the exact original event before admission. */
  expectedInstruction?: string;
  requireCurrent?: () => Promise<void>;
}): Promise<DiscordCommandResponse> {
  const { runtime, workspace, command } = input;
  if (!/^\d{17,20}$/u.test(command.sourceMessageId))
    throw new DiscordStructuredWorkUnavailableError(
      "Select the original Discord message ID with Copy Message ID, then use it as source_message."
    );
  const instructionSubject: StructuredWorkConversationSubject = {
    type: "conversation-thread",
    providerId: "discord",
    conversationObjectId: command.channelId,
    anchorMessageId: command.sourceMessageId
  };
  if (command.meeting && !input.meetingId)
    throw new DiscordStructuredWorkUnavailableError(
      "Bind this thread to its imported Meeting first, or omit meeting:true to use the discussion."
    );
  const subject: StructuredWorkSubject = command.meeting
    ? { type: "meeting", meetingId: input.meetingId! }
    : instructionSubject;
  const requestId = discordStructuredWorkRequestId(command);
  if (requestId.length > 160 || !/^[a-zA-Z0-9:_-]+$/u.test(requestId))
    throw new DiscordStructuredWorkUnavailableError(
      "Use the exact request ID returned by Luma."
    );
  const address = {
    workspaceId: workspace.workspaceId,
    subject,
    query: { type: "structured-work-request" as const, requestId }
  };
  await input.requireCurrent?.();
  if (command.type === "structured-work-request") {
    if (!runtime.targetKeys.includes(command.targetKey))
      throw new DiscordStructuredWorkUnavailableError(
        `Choose a configured target: ${runtime.targetKeys.join(", ")}.`
      );
    // Native capture verifies the leading @Luma mention and complete current
    // audience. The owned module captures again before persistence or inference.
    const capture = await runtime.source.capture({
      workspaceId: workspace.workspaceId,
      subject: instructionSubject,
      purpose: "structured-work"
    });
    const anchor = capture.snapshot.messages.at(-1);
    if (
      capture.snapshot.completeness.state !== "complete" ||
      capture.source.providerId !== "discord" ||
      capture.source.parentObjectId !== command.channelId ||
      capture.source.sourceObjectId !== command.sourceMessageId ||
      capture.snapshot.boundary.anchorMessageId !== command.sourceMessageId ||
      !anchor ||
      anchor.id !== command.sourceMessageId ||
      anchor.state !== "available" ||
      anchor.author.providerUserId !== command.actorDiscordUserId
    )
      throw new DiscordStructuredWorkUnavailableError(
        "The original command must be complete, readable, and written by you in this thread. Ask its author to run the command, or post your own explicit instruction."
      );
    const instruction = anchor.text.trim().replace(/^<@!?[^>]+>\s*/u, "");
    if (
      input.expectedInstruction !== undefined &&
      instruction !== input.expectedInstruction
    )
      throw new DiscordStructuredWorkUnavailableError(
        "The original command changed before admission. Post the current instruction as a new @Luma message. No writes were started."
      );
    if (!isExplicitStructuredWorkInstruction(instruction))
      throw new DiscordStructuredWorkUnavailableError(
        "The original @Luma message must explicitly request both the table entry and validation task. Questions, quotations and negated instructions do not authorize writes."
      );
    await input.requireCurrent?.();
    await runtime.meetingIntelligence.observe({
      workspace,
      subject,
      observations: [
        {
          type: "structured-work-requested",
          observationId: requestId,
          actor: { providerId: "discord", providerUserId: command.actorDiscordUserId },
          instruction,
          targetKey: command.targetKey,
          ...(command.meeting ? { instructionSubject } : {}),
          ...(command.workItemId ? { workItemId: command.workItemId } : {})
        }
      ]
    });
  }
  let state = await runtime.meetingIntelligence.query(address);
  requireAddress(state, instructionSubject);
  let executionUnavailable = false;
  if (command.type !== "structured-work-status" && state.approvedIntentId) {
    try {
      await input.requireCurrent?.();
      const operation = {
        workspace,
        subject,
        structuredWorkRequestId: requestId,
        intentId: state.approvedIntentId
      };
      if (command.type === "structured-work-recover")
        await runtime.execution.recover(operation);
      else await runtime.execution.execute(operation);
    } catch {
      executionUnavailable = true;
    }
    state = await runtime.meetingIntelligence.query(address);
    requireAddress(state, instructionSubject);
  }
  const retained = JSON.stringify(state);
  return {
    content: renderStructuredWorkResponse(
      state,
      command.type === "structured-work-request" ? 1 : command.page,
      executionUnavailable
    ),
    requireCurrent: async () => {
      await input.requireCurrent?.();
      const current = await runtime.meetingIntelligence.query(address);
      requireAddress(current, instructionSubject);
      if (JSON.stringify(current) !== retained)
        throw new Error("The structured request changed before delivery");
    }
  };
}
function requireAddress(
  state: StructuredWorkState,
  expected: StructuredWorkConversationSubject
) {
  const original = state.source.instructionSource?.subject ?? state.source.subject;
  if (
    original.type !== "conversation-thread" ||
    original.providerId !== expected.providerId ||
    original.conversationObjectId !== expected.conversationObjectId ||
    original.anchorMessageId !== expected.anchorMessageId
  )
    throw new Error("The request belongs to another original command");
}
export function renderStructuredWorkResponse(
  state: StructuredWorkState,
  page = 1,
  executionUnavailable = false
): string {
  const details = [state.message];
  if (executionUnavailable)
    details.push(
      "The execution result could not be verified. Check recovery before requesting another write."
    );
  for (const result of state.outcomes) {
    details.push(
      `${result.target === "record" ? "Notion record" : "Linear task"}: ${result.disposition}. ${result.message}`
    );
    if (result.reference && safeUrl(result.reference.url))
      details.push(`<${result.reference.url}>`);
  }
  for (const proposal of state.updateProposals ?? []) {
    details.push(
      `${proposal.target === "record" ? "Notion record" : "Linear task"}: apply these proposed changes manually.`
    );
    if (safeUrl(proposal.reference.url)) details.push(`<${proposal.reference.url}>`);
    for (const change of proposal.changes)
      details.push(
        `${change.label}: ${renderUpdateValue(change.before)} → ${renderUpdateValue(change.after)}`
      );
  }
  if (state.preview) {
    const preview = state.preview;
    details.push(
      `Table: ${preview.targetKey}. Record: ${JSON.stringify(preview.record.reconciliation)}.`
    );
    for (const [key, field] of Object.entries(preview.record.fields))
      details.push(`${key}: ${field.value}`);
    details.push(
      `Task: ${preview.work.title}`,
      preview.work.description,
      `Task reconciliation: ${JSON.stringify(preview.work.reconciliation)}.`,
      `Owner: ${preview.work.ownership.status === "confirmed" ? preview.work.ownership.personId : preview.work.ownership.status === "intentionally-unassigned" ? "intentionally unassigned" : preview.work.ownership.reason}.`
    );
  }
  const text = details.join("\n").replaceAll("@", "@\u200b");
  const pages: string[] = [""];
  for (const character of text) {
    if (pages.at(-1)!.length + character.length > 1100) pages.push("");
    pages[pages.length - 1] += character;
  }
  const selected =
    Number.isSafeInteger(page) && page >= 1 ? Math.min(page, pages.length) : 1;
  const source = state.source.instructionSource?.subject ?? state.source.subject;
  const nextStep =
    state.state === "manual-application-required"
      ? "Apply the proposed changes in the linked targets, then send a new command to reconcile their current state. Use /structured-work status to review this proposal."
      : "Use /structured-work status for this receipt; recover checks an uncertain write without resending it.";
  return `Structured work: ${state.state}. Page ${selected}/${pages.length}.\n${pages[selected - 1]}\nRequest ID: ${state.requestId}\nSource message: ${source.type === "conversation-thread" ? source.anchorMessageId : "unavailable"}. Meeting: ${state.subject.type === "meeting" ? "true" : "false"}.\n${selected < pages.length ? `Read all details with /structured-work status page:${selected + 1}.` : nextStep}`;
}
function renderUpdateValue(value: StructuredWorkUpdateValue | null): string {
  if (value === null) return "not set";
  if (value.type === "people")
    return value.value.length
      ? value.value
          .map(
            (person) =>
              `${person.displayName} (${person.providerId}:${person.providerUserId})`
          )
          .join(", ")
      : "unassigned";
  return JSON.stringify(value.value);
}

function safeUrl(value: string): boolean {
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
export function renderStructuredWorkFailure(
  error: unknown,
  command: DiscordStructuredWorkCommand
): string {
  return `${error instanceof AiServiceError ? renderAiServiceFailure(error) : error instanceof DiscordStructuredWorkUnavailableError ? error.message : "Luma could not verify the original instruction, source access or selected structured target. No unverified result will be displayed."}\nUse /structured-work status before another request. Request ID: ${discordStructuredWorkRequestId(command)}. Source message: ${command.sourceMessageId}.`;
}
