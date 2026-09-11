import type { ConversationConsultations } from "../context-intelligence/conversation-consultations.js";
import { ConversationConsultationError } from "../context-intelligence/conversation-consultations.js";
import type { ConversationFollowUpExecution } from "../follow-up-execution/interface.js";
import type { ConsultationReceipt } from "../consultation/interface.js";
import type { WorkspaceConfig } from "../domain/model.js";
import type { WorkspaceAccessPolicy } from "../access/workspace-access-policy.js";
import type {
  DiscordCommandBase,
  DiscordCommandResponse
} from "./discord-meeting-bot.js";
import {
  discordContextAskConfigFromEnv,
  type DiscordContextAskConfig
} from "./discord-context-ask-runtime.js";

export type DiscordConsultationConfig = {
  teamRoleId: string;
  capture: DiscordContextAskConfig;
};
export function discordConsultationConfigFromEnv(
  env: NodeJS.ProcessEnv
): DiscordConsultationConfig | undefined {
  const enabled = env["LUMA_DISCORD_CONSULTATION_ENABLED"]?.trim();
  if (!enabled || enabled === "0") return undefined;
  if (enabled !== "1")
    throw new Error("LUMA_DISCORD_CONSULTATION_ENABLED must be 0 or 1");
  const teamRoleId = env["LUMA_DISCORD_TEAM_ROLE_ID"]?.trim();
  if (!teamRoleId || !/^\d{1,22}$/.test(teamRoleId))
    throw new Error(
      "LUMA_DISCORD_TEAM_ROLE_ID must be the exact reviewed Discord role ID"
    );
  const capture = discordContextAskConfigFromEnv({
    LUMA_DISCORD_CONTEXT_ASK_ENABLED: "1",
    LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS:
      env["LUMA_DISCORD_CONSULTATION_PARENT_CHANNEL_IDS"],
    LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS:
      env["LUMA_DISCORD_CONSULTATION_ALLOWED_DISCORD_USER_IDS"]
  })!;
  return { teamRoleId, capture };
}
export type DiscordConsultationCommand = DiscordCommandBase & {
  sourceMessageId: string;
  recovery?: "publication" | "closure";
} & (
    | {
        type: "consultation-start";
        purpose: string;
        question: string;
        options: string[];
        durationHours?: number;
        ownerDiscordUserId?: string;
        replacesConsultationId?: string;
      }
    | {
        type: "consultation-status" | "consultation-recover" | "consultation-close";
        consultationId: string;
      }
    | {
        type: "consultation-judgment";
        consultationId: string;
        choice: string;
        rationale: string;
      }
  );
export type DiscordConsultationRuntime = {
  context: ConversationConsultations;
  execution: ConversationFollowUpExecution;
};

/** The common Discord ingress admits founder and live channel before this handler. */
export async function handleDiscordConsultationCommand(input: {
  runtime: DiscordConsultationRuntime;
  workspace: WorkspaceConfig;
  command: DiscordConsultationCommand;
  accessPolicy: WorkspaceAccessPolicy;
}): Promise<DiscordCommandResponse> {
  const { command, runtime, workspace } = input;
  const subject = {
    type: "conversation-thread" as const,
    providerId: "discord",
    conversationObjectId: command.channelId,
    anchorMessageId: command.sourceMessageId
  };
  const actor = { providerId: "discord", providerUserId: command.actorDiscordUserId };
  let consultationId: string;
  let content: string;
  if (command.type === "consultation-start") {
    const owner = command.ownerDiscordUserId
      ? await input.accessPolicy.authorize({
          workspaceId: workspace.workspaceId,
          providerId: "discord",
          providerUserId: command.ownerDiscordUserId
        })
      : null;
    if (command.ownerDiscordUserId && !owner)
      throw new ConversationConsultationError(
        "consultation-owner-unresolved",
        "The selected owner must uniquely map to an authorized founder."
      );
    const requested = await runtime.context.request({
      workspace,
      subject,
      actor,
      consultationId: command.interactionId,
      instruction: {
        purpose: command.purpose,
        question: command.question,
        options: command.options,
        ...(command.durationHours !== undefined
          ? { durationHours: command.durationHours }
          : {}),
        ...(owner ? { ownerPersonId: owner.personId } : {}),
        ...(command.replacesConsultationId
          ? { replacesConsultationId: command.replacesConsultationId }
          : {})
      }
    });
    consultationId = requested.consultation.consultation.id;
    const outcome = (
      await runtime.execution.execute({
        workspace,
        subject,
        intentId: requested.intentId
      })
    ).observation.outcome;
    content =
      outcome.status === "succeeded"
        ? renderConsultationReceipt(outcome.receipt)
        : outcome.message;
  } else {
    consultationId = command.consultationId;
    const address = { workspaceId: workspace.workspaceId, subject, consultationId };
    await runtime.context.get(address);
    if (command.type === "consultation-judgment") {
      await runtime.context.recordJudgment({
        ...address,
        actor,
        judgmentId: command.interactionId,
        choice: command.choice,
        rationale: command.rationale
      });
      content =
        "The Human choice and rationale were recorded separately from the advisory poll. This does not authorize spending, work, or a Decision Record.";
    } else if (command.type === "consultation-close") {
      const { intentId } = await runtime.context.requestClose({
        ...address,
        actor,
        requestId: command.interactionId
      });
      const outcome = (await runtime.execution.execute({ workspace, subject, intentId }))
        .observation.outcome;
      content =
        outcome.status === "succeeded"
          ? renderConsultationReceipt(outcome.receipt)
          : outcome.message;
    } else if (command.type === "consultation-recover") {
      const outcome = (
        await runtime.execution.recover({
          workspace,
          subject,
          intentId: `${command.recovery === "closure" ? "close" : "publish"}-consultation:${consultationId}`
        })
      ).observation.outcome;
      content =
        outcome.status === "succeeded"
          ? renderConsultationReceipt(outcome.receipt)
          : outcome.message;
    } else {
      content = renderConsultationReceipt(
        await runtime.execution.readConsultation({
          workspace,
          subject,
          intentId: `publish-consultation:${consultationId}`
        })
      );
    }
    const judgments = await runtime.context.readJudgments(address);
    if (judgments.length)
      content += `\nRecent Human reasoning (separate from votes): ${judgments
        .slice(0, 2)
        .map(
          (judgment) =>
            `${judgment.personId} (${judgment.authority}): ${judgment.choice.slice(0, 100)} — ${judgment.rationale.slice(0, 160)}`
        )
        .join("; ")}`;
  }
  return {
    content: `${content}\nConsultation ID: ${consultationId}. Source message: ${command.sourceMessageId}.`,
    requireCurrent: async () => {
      await runtime.context.get({
        workspaceId: workspace.workspaceId,
        subject,
        consultationId
      });
    }
  };
}
export function renderConsultationReceipt(receipt: ConsultationReceipt): string {
  const results = receipt.poll.results;
  const counts =
    results.status === "unknown"
      ? "Results are unknown; missing counts are not zero votes."
      : `${results.status === "finalized" ? "Finalized" : "Provisional"} counts: ${receipt.poll.options.map((option) => `${option.text}: ${results.counts.find((count) => count.optionId === option.id)?.votes ?? "unknown"}`).join("; ")}.`;
  return [
    receipt.disposition === "reused"
      ? "Existing advisory poll reused."
      : "Advisory poll recorded.",
    receipt.reference.url,
    counts,
    "Votes and expiry are advisory. They do not establish unanimity, quorum, or an authorized decision.",
    receipt.mention === "incomplete" || receipt.mention === "unknown"
      ? "The Dayova Team notification was not fully verified. Luma will not republish or repeat the mention; a founder can review the existing poll."
      : ""
  ]
    .filter(Boolean)
    .join("\n");
}
