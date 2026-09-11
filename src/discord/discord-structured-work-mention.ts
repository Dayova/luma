import type { WorkspaceConfig } from "../domain/model.js";
import { isExplicitStructuredWorkInstruction } from "../structured-work/explicit-instruction.js";
import type { DiscordContextAskMention } from "./discord-context-ask-runtime.js";
import type { DiscordCommandResponse } from "./discord-meeting-bot.js";
import {
  handleDiscordStructuredWorkCommand,
  renderStructuredWorkFailure,
  type DiscordStructuredWorkRuntime,
  type DiscordStructuredWorkCommand
} from "./discord-structured-work-runtime.js";

/** Only literal configured destination names select a target; no semantic or paid guess. */
export function resolveStructuredWorkMentionTarget(
  instruction: string,
  targets: readonly { key: string; label: string }[]
): { type: "selected"; key: string } | { type: "clarify"; message: string } {
  const normalize = (value: string) =>
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  // A destination mentioned only in the requested task is not a table selection.
  const knowledgeClause =
    instruction.split(
      /\b(?:and|und)\s+(?:(?:please|bitte)\s+)?(?:create|add|open|erstelle|lege|erzeuge)\b/iu
    )[0] ?? "";
  const clause = ` ${normalize(knowledgeClause)} `;
  const selected = targets.filter((target) =>
    [target.key, target.label].some((name) => {
      const literal = normalize(name);
      return literal.length > 0 && clause.includes(` ${literal} `);
    })
  );
  if (selected.length === 1) return { type: "selected", key: selected[0]!.key };
  const choices = targets.map((target) => target.key).join(", ");
  return {
    type: "clarify",
    message: `${selected.length ? "The command names more than one configured table." : "I could not identify a configured table in the command."} Name exactly one target: ${choices}. No source analysis or writes were started. You can also use /structured-work request with this source message and the exact target alias.`
  };
}

/** An authenticated native message selects the same durable command as slash ingress. */
export async function handleDiscordStructuredWorkMention(input: {
  runtime: DiscordStructuredWorkRuntime;
  workspace: WorkspaceConfig;
  mention: DiscordContextAskMention;
  requireCurrent: () => Promise<void>;
}): Promise<DiscordCommandResponse> {
  const { runtime, mention } = input;
  await input.requireCurrent();
  if (!isExplicitStructuredWorkInstruction(mention.question))
    return {
      content: "The command must explicitly request a table entry and a work task."
    };
  const target = resolveStructuredWorkMentionTarget(
    mention.question,
    runtime.targets ?? runtime.targetKeys.map((key) => ({ key, label: key }))
  );
  if (target.type === "clarify")
    return { content: target.message, requireCurrent: input.requireCurrent };
  const command: DiscordStructuredWorkCommand = {
    type: "structured-work-request",
    interactionId: `message:${mention.messageId}`,
    guildId: mention.guildId,
    channelId: mention.channelId,
    actorDiscordUserId: mention.actorDiscordUserId,
    occurredAt: mention.occurredAt,
    sourceMessageId: mention.messageId,
    meeting: false,
    targetKey: target.key
  };
  try {
    return await handleDiscordStructuredWorkCommand({
      runtime,
      workspace: input.workspace,
      command,
      expectedInstruction: mention.question,
      requireCurrent: input.requireCurrent
    });
  } catch (error: unknown) {
    return {
      content: renderStructuredWorkFailure(error, command),
      requireCurrent: input.requireCurrent
    };
  }
}
