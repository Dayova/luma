import { renderContextVerificationFailure } from "../presentation/context-failure.js";
import {
  startDiscordRequestProgress,
  type DiscordProgressMessage
} from "./discord-request-progress.js";
import type { LumaDatabase } from "../persistence/db.js";
import type { AiUsageBudget } from "../ai/ai-usage-budget.js";
import type { ContextInquiry } from "../context-intelligence/interface.js";
import type { ContextAnswerer } from "../context-intelligence/context-answerer.js";
import {
  createContextIntelligence,
  ContextIntelligenceError
} from "../context-intelligence/context-intelligence.js";
import {
  requireCurrentConversationEvidence,
  type ConversationEvidenceSource
} from "../context-intelligence/conversation-evidence-source.js";
import {
  createObservedSourceLedger,
  type RawConversationMessage
} from "../knowledge/observed-source-ledger.js";
import type { OrganizationalContext } from "../organizational-context/interface.js";
import { renderDiscordContextAskResult } from "./discord-context-ask-runtime.js";
import { renderAiServiceFailure, renderAiUsageStatus } from "./discord-ai-status.js";

export type DirectMessageEvent = {
  channelId: string;
  messageId: string;
  authorId: string;
};
export type DirectMessage = {
  id: string;
  channelId: string;
  authorId: string;
  bot: boolean;
  text: string;
  createdAt: string;
  editedAt: string | null;
  unsupported: boolean;
};
/** Only one-to-one channels are returned. Group DMs and guild channels are absent. */
export interface DiscordDirectMessageTransport {
  onMessage(handler: (event: DirectMessageEvent) => Promise<void>): void;
  recipient(channelId: string): Promise<string | null>;
  read(channelId: string, messageId: string): Promise<DirectMessage | null>;
  before(channelId: string, messageId: string, limit: number): Promise<DirectMessage[]>;
  botId(): string | null;
  send(input: {
    channelId: string;
    recipientId: string;
    content: string;
    idempotencyKey: string;
  }): Promise<DiscordProgressMessage | void>;
}
export function discordDirectMessagesEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env["LUMA_DISCORD_DM_ENABLED"]?.trim();
  if (value && value !== "0" && value !== "1")
    throw new Error("LUMA_DISCORD_DM_ENABLED must be 0 or 1");
  return value === "1";
}
class DirectMessageInputError extends ContextIntelligenceError {
  constructor(message: string) {
    super("conversation-capture-unavailable", false, message);
  }
}
const idPattern = /^\d{17,20}$/u;
const MAX_MESSAGES = 50;
const MAX_CHARACTERS = 32000;

/** Private read-only conversation facade; no Meeting or Follow-up execution is created. */
export async function createDiscordDirectMessages(input: {
  workspaceId: string;
  database: LumaDatabase;
  transport: DiscordDirectMessageTransport;
  authorize: (discordUserId: string) => Promise<string | null>;
  answerer: ContextAnswerer;
  budget: AiUsageBudget;
  organizationalContext?: OrganizationalContext;
  now?: () => Date;
}) {
  const { transport, database, workspaceId } = input;
  const now = input.now ?? (() => new Date());
  await database.exec(`CREATE TABLE IF NOT EXISTS discord_dm_resets (
    workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL, author_id TEXT NOT NULL,
    message_id TEXT NOT NULL, PRIMARY KEY(workspace_id, channel_id, message_id)
  )`);
  const busy = new Set<string>();
  const lastRequest = new Map<string, number>();
  async function admit(event: DirectMessageEvent) {
    const personId = await input.authorize(event.authorId);
    if (!personId || (await transport.recipient(event.channelId)) !== event.authorId)
      return null;
    return personId;
  }
  async function send(
    event: DirectMessageEvent,
    content: string,
    idempotencyKey = `discord-dm:${event.messageId}:reply`
  ) {
    if (!(await admit(event))) return;
    return transport.send({
      channelId: event.channelId,
      recipientId: event.authorId,
      content,
      idempotencyKey
    });
  }
  async function anchor(event: DirectMessageEvent) {
    const message = await transport.read(event.channelId, event.messageId);
    if (
      !message ||
      message.authorId !== event.authorId ||
      message.bot ||
      message.channelId !== event.channelId
    )
      throw new DirectMessageInputError(
        "Luma could not verify the original DM or its author. Check that the message is still available before sending a new question."
      );
    return message;
  }
  function evidenceSource(event: DirectMessageEvent): ConversationEvidenceSource {
    return {
      async capture(request) {
        if (
          request.workspaceId !== workspaceId ||
          request.subject.providerId !== "discord-dm" ||
          request.subject.conversationObjectId !== event.channelId ||
          request.subject.anchorMessageId !== event.messageId ||
          !(await admit(event))
        )
          throw new DirectMessageInputError(
            "Luma could not verify access to this private conversation. A founder should check the DM setup before retrying."
          );
        const message = await anchor(event);
        if (message.text !== request.question)
          throw new DirectMessageInputError("The message changed. Send a new question.");
        const reset = (
          await database.query<{ message_id: string }>(
            `SELECT message_id FROM discord_dm_resets WHERE workspace_id=$1 AND channel_id=$2 AND author_id=$3
         AND message_id::numeric < $4::numeric ORDER BY message_id::numeric DESC LIMIT 1`,
            [workspaceId, event.channelId, event.authorId, event.messageId]
          )
        ).rows[0]?.message_id;
        const history = [message];
        let cursor = message.id;
        let complete = false;
        while (history.length <= MAX_MESSAGES) {
          const page = await transport.before(
            event.channelId,
            cursor,
            Math.min(100, MAX_MESSAGES + 1 - history.length)
          );
          if (!page.length) {
            complete = !reset;
            break;
          }
          for (const previous of page) {
            if (
              !idPattern.test(previous.id) ||
              BigInt(previous.id) >= BigInt(cursor) ||
              previous.channelId !== event.channelId
            )
              throw new DirectMessageInputError(
                "Discord returned an inconsistent DM history. Try a new message."
              );
            cursor = previous.id;
            if (reset && previous.id === reset) {
              if (
                previous.authorId !== event.authorId ||
                previous.bot ||
                previous.unsupported ||
                previous.text.trim().toLowerCase() !== "/new"
              )
                throw new DirectMessageInputError(
                  "The /new boundary changed. Send /new again to establish a fresh conversation."
                );
              complete = true;
              break;
            }
            history.push(previous);
          }
          if (complete || history.length > MAX_MESSAGES) break;
        }
        if (!complete)
          throw new DirectMessageInputError(
            "This DM conversation is too long or its /new boundary is unavailable. Send /new, then repeat the relevant context and question. Earlier history is retained."
          );
        const botId = transport.botId();
        if (!botId)
          throw new DirectMessageInputError("Luma is reconnecting. Please try later.");
        if (
          history.some(
            (m) =>
              m.unsupported ||
              (m.authorId !== event.authorId && m.authorId !== botId) ||
              (m.authorId === event.authorId && m.bot)
          )
        )
          throw new DirectMessageInputError(
            "This conversation includes unsupported attachments, polls or message content. Send /new and paste the relevant text."
          );
        const human = history.filter((m) => m.authorId === event.authorId).reverse();
        if (human.reduce((n, m) => n + m.text.length, 0) > MAX_CHARACTERS)
          throw new DirectMessageInputError(
            "This DM exceeds the text limit. Send /new and provide shorter context."
          );
        const personId = await admit(event);
        if (!personId)
          throw new DirectMessageInputError(
            "Luma could not verify current access to this private conversation. A founder should check the DM setup before retrying."
          );
        const messages: RawConversationMessage[] = human.map((m, ordinal) => ({
          id: m.id,
          ordinal,
          author: { providerUserId: m.authorId, personId, displayName: "You" },
          createdAt: m.createdAt,
          editedAt: m.editedAt,
          replyToMessageId: null,
          url: `https://discord.com/channels/@me/${event.channelId}/${m.id}`,
          state: "available",
          text: m.text
        }));
        const url = `https://discord.com/channels/@me/${event.channelId}`;
        return {
          source: {
            providerId: "discord-dm",
            sourceKind: "conversation",
            sourceObjectId: message.id,
            parentObjectId: event.channelId,
            url
          },
          providerVersion: null,
          snapshot: {
            schemaVersion: 1,
            conversation: {
              conversationObjectId: event.channelId,
              parentConversationObjectId: null,
              title: "Private Luma conversation",
              url
            },
            boundary: {
              mode: "thread",
              anchorMessageId: message.id,
              firstMessageId: messages[0]!.id,
              lastMessageId: message.id,
              messageIds: messages.map((m) => m.id)
            },
            messages,
            excludedMessages: history
              .filter((m) => m.authorId === botId)
              .map((m) => ({
                messageId: m.id,
                providerUserId: botId,
                reason: "assistant-output" as const
              })),
            completeness: { state: "complete" }
          },
          observedAt: now().toISOString()
        };
      }
    };
  }
  async function handle(event: DirectMessageEvent): Promise<void> {
    if (
      ![event.channelId, event.messageId, event.authorId].every((id) =>
        idPattern.test(id)
      )
    )
      return;
    const personId = await admit(event);
    if (!personId) return;
    const progress = startDiscordRequestProgress({
      send: (update) =>
        send(
          event,
          update.content,
          `discord-dm:${event.messageId}:progress:${update.sequence}`
        )
    });
    await progress.ready;
    let held = false;
    async function respond(personId: string): Promise<string> {
      // Bound concurrent model work; status remains available during an AI request.
      const message = await anchor(event);
      const command = message.text.trim().toLowerCase();
      if (command === "usage" || command === "/usage" || command === "status") {
        return renderAiUsageStatus(await input.budget.getStatus(workspaceId));
      }
      if (busy.has(event.channelId)) {
        return "I am still answering your previous DM. Please wait before sending more context. You can send usage to check the budget.";
      }
      busy.add(event.channelId);
      held = true;
      if (message.unsupported || !message.text.trim())
        throw new DirectMessageInputError(
          "Please send a text message. Attachments, voice messages and polls are not supported in DMs yet."
        );
      if (command === "/new") {
        await database.query(
          "INSERT INTO discord_dm_resets(workspace_id,channel_id,author_id,message_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [workspaceId, event.channelId, event.authorId, event.messageId]
        );
        return "Started a fresh private conversation. Earlier history is retained but excluded from this conversation. Send your context and question; no mention is needed.";
      }
      if (command === "/help" || command === "help") {
        return "Send me a text question; no @mention is needed. Your conversation stays in this DM. Send usage for the shared AI budget, or /new to start fresh without deleting history. I use your text as evidence and do not automatically change Linear or Notion.";
      }
      const time = now().getTime();
      if (time - (lastRequest.get(event.authorId) ?? -Infinity) < 10000) {
        return "Please wait 10 seconds between AI questions. No AI call was made. You can still send usage.";
      }
      lastRequest.set(event.authorId, time);
      const source = evidenceSource(event);
      const context = createContextIntelligence({
        database,
        ledger: createObservedSourceLedger({ database }),
        conversationEvidenceSource: source,
        answerer: input.answerer,
        now,
        ...(input.organizationalContext
          ? { organizationalContext: input.organizationalContext }
          : {})
      });
      const inquiry: ContextInquiry = {
        type: "ask",
        workspaceId,
        inquiryId: `discord-dm:${event.messageId}`,
        question: message.text,
        subject: {
          type: "conversation-thread",
          providerId: "discord-dm",
          conversationObjectId: event.channelId,
          anchorMessageId: event.messageId
        },
        audience: { workspaceId, personIds: [personId] }
      };
      const result = await context.inquire(inquiry);
      await progress.stop();
      await requireCurrentConversationEvidence(source, {
        workspaceId,
        subject: inquiry.subject,
        question: inquiry.question,
        contentHash: result.boundary.contentHash
      });
      await context.requireCurrent?.(inquiry);
      return renderDiscordContextAskResult(result, "direct-message");
    }
    try {
      let content: string;
      try {
        content = await respond(personId);
      } catch (error) {
        content =
          error instanceof DirectMessageInputError
            ? error.message
            : (
                renderContextVerificationFailure(error) ?? renderAiServiceFailure(error)
              ).replaceAll("/meeting usage", "usage");
      }
      await progress.stop();
      // Do not turn an ambiguous final send into a contradictory fallback.
      await send(event, content);
    } finally {
      await progress.clear();
      if (held) busy.delete(event.channelId);
    }
  }

  return { handle };
}
