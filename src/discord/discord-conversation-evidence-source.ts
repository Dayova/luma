import type {
  CapturedConversationEvidence,
  ConversationEvidenceSource
} from "../context-intelligence/conversation-evidence-source.js";
import type { ConversationContextSubject } from "../context-intelligence/interface.js";
import type { WorkspaceId } from "../domain/model.js";
import type {
  ConversationSourcePartialReason,
  RawConversationMessage
} from "../knowledge/observed-source-ledger.js";
import {
  MAX_DISCORD_CONTEXT_ASK_EVIDENCE_CHARS,
  MAX_DISCORD_CONTEXT_ASK_MESSAGES,
  questionAfterLeadingDiscordBotMention,
  type DiscordContextAskConfig
} from "./discord-context-ask-runtime.js";

const DISCORD_MESSAGE_PAGE_SIZE = 100;

export type DiscordConversationThread = {
  id: string;
  guildId: string | null;
  parentChannelId: string | null;
  visibility: "public" | "private";
  title: string | null;
  url: string;
};

export type DiscordConversationMessage = {
  id: string;
  channelId: string;
  /** Discord's thread-starter system record has no conversational content. */
  kind: "message" | "thread-starter";
  /** The adapter saw message content that this text-only capture does not retain. */
  hasUnsupportedContent: boolean;
  author: {
    providerUserId: string;
    displayName: string;
  };
  authorKind: "human" | "bot" | "webhook" | "system";
  mentionedDiscordUserIds: readonly string[];
  content: string;
  createdAt: string;
  editedAt: string | null;
  replyToMessageId: string | null;
  url: string;
};

/** Messages are ordered newest-to-oldest, matching Discord's history API. */
export type DiscordConversationMessagePage = {
  messages: DiscordConversationMessage[];
  hasMore: boolean;
};

/**
 * Narrow Discord-owned reader seam. The production adapter maps discord.js to
 * this shape; Context Intelligence receives only ConversationEvidenceSource.
 */
export interface DiscordConversationReader {
  readThread(input: {
    conversationObjectId: string;
  }): Promise<DiscordConversationThread | null>;
  readMessage(input: {
    conversationObjectId: string;
    messageId: string;
  }): Promise<DiscordConversationMessage | null>;
  listMessagesBefore(input: {
    conversationObjectId: string;
    beforeMessageId: string;
    limit: number;
  }): Promise<DiscordConversationMessagePage>;
}

export type CreateDiscordConversationEvidenceSourceInput = {
  reader: DiscordConversationReader;
  guildId: string;
  config: DiscordContextAskConfig;
  botUserId: () => string | null;
  now?: () => Date;
};

export class DiscordConversationEvidenceError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "DiscordConversationEvidenceError";
  }
}

/**
 * Captures a bounded current Discord thread ending at the triggering mention.
 * It deliberately does not infer edits or deletions after capture; that needs
 * a separate retained-event slice.
 */
export function createDiscordConversationEvidenceSource(
  input: CreateDiscordConversationEvidenceSourceInput
): ConversationEvidenceSource {
  validateScope(input);
  const now = input.now ?? (() => new Date());

  return {
    async capture(captureInput): Promise<CapturedConversationEvidence> {
      validateDiscordSubject(captureInput.workspaceId, captureInput.subject);
      const subject = captureInput.subject;
      const thread = await readThread(input, subject);
      const anchor = await readAnchor(input, subject, thread);
      const capture = await readThreadThroughAnchor(input, thread.id, anchor);
      const partialReasons = [
        ...capture.partialReasons,
        ...incompleteEvidenceReasons(capture.messages)
      ];
      const messages = capture.messages
        .filter(isReadableHumanTextMessage)
        .sort(compareDiscordMessagesChronologically)
        .map((message, ordinal) => rawConversationMessage(message, ordinal));

      if (messages.length === 0) {
        throw new DiscordConversationEvidenceError(
          "discord-conversation-empty",
          "Discord did not return the triggering conversation message"
        );
      }

      const firstMessage = messages[0];

      if (!firstMessage) {
        throw new DiscordConversationEvidenceError(
          "discord-conversation-empty",
          "Discord did not return the first bounded conversation message"
        );
      }

      return {
        source: {
          providerId: "discord",
          sourceKind: "conversation",
          sourceObjectId: subject.anchorMessageId,
          parentObjectId: thread.id,
          url: anchor.url
        },
        providerVersion: null,
        snapshot: {
          schemaVersion: 1,
          conversation: {
            conversationObjectId: thread.id,
            parentConversationObjectId: thread.parentChannelId,
            title: thread.title,
            url: thread.url
          },
          boundary: {
            mode: "thread",
            anchorMessageId: anchor.id,
            firstMessageId: firstMessage.id,
            lastMessageId: anchor.id,
            messageIds: messages.map((message) => message.id)
          },
          messages,
          completeness:
            partialReasons.length === 0
              ? { state: "complete" }
              : { state: "partial", reasons: partialReasons }
        },
        observedAt: now().toISOString()
      };
    }
  };
}

function validateScope(input: CreateDiscordConversationEvidenceSourceInput): void {
  if (input.guildId.trim().length === 0) {
    throw new DiscordConversationEvidenceError(
      "discord-conversation-guild-invalid",
      "Discord Context Ask requires a configured guild"
    );
  }

  if (input.config.parentChannelIds.length === 0) {
    throw new DiscordConversationEvidenceError(
      "discord-conversation-parent-scope-empty",
      "Discord Context Ask requires an allowlisted parent channel"
    );
  }

  if (input.config.allowedDiscordUserIds.length === 0) {
    throw new DiscordConversationEvidenceError(
      "discord-conversation-user-scope-empty",
      "Discord Context Ask requires an allowlisted Discord user"
    );
  }

  if (
    !Number.isSafeInteger(input.config.maxMessages) ||
    input.config.maxMessages <= 0 ||
    input.config.maxMessages > MAX_DISCORD_CONTEXT_ASK_MESSAGES ||
    !Number.isSafeInteger(input.config.maxEvidenceChars) ||
    input.config.maxEvidenceChars < 2_000 ||
    input.config.maxEvidenceChars > MAX_DISCORD_CONTEXT_ASK_EVIDENCE_CHARS
  ) {
    throw new DiscordConversationEvidenceError(
      "discord-conversation-boundary-invalid",
      "Discord Context Ask requires bounded message and evidence character limits"
    );
  }
}

function validateDiscordSubject(
  _workspaceId: WorkspaceId,
  subject: ConversationContextSubject
): void {
  if (
    subject.type !== "conversation-thread" ||
    subject.providerId !== "discord" ||
    subject.conversationObjectId.trim().length === 0 ||
    subject.anchorMessageId.trim().length === 0
  ) {
    throw new DiscordConversationEvidenceError(
      "discord-conversation-subject-invalid",
      "Discord Context Ask can capture only a non-empty Discord conversation thread and anchor"
    );
  }
}

async function readThread(
  input: CreateDiscordConversationEvidenceSourceInput,
  subject: ConversationContextSubject
): Promise<DiscordConversationThread> {
  const thread = await input.reader.readThread({
    conversationObjectId: subject.conversationObjectId
  });

  if (
    !thread ||
    thread.id !== subject.conversationObjectId ||
    thread.guildId !== input.guildId ||
    thread.visibility !== "public" ||
    !thread.parentChannelId ||
    !input.config.parentChannelIds.includes(thread.parentChannelId)
  ) {
    throw new DiscordConversationEvidenceError(
      "discord-conversation-thread-not-allowed",
      "The requested Discord conversation is not an allowlisted readable thread"
    );
  }

  return thread;
}

async function readAnchor(
  input: CreateDiscordConversationEvidenceSourceInput,
  subject: ConversationContextSubject,
  thread: DiscordConversationThread
): Promise<DiscordConversationMessage> {
  const anchor = await input.reader.readMessage({
    conversationObjectId: thread.id,
    messageId: subject.anchorMessageId
  });

  const botUserId = input.botUserId();

  if (
    !anchor ||
    anchor.id !== subject.anchorMessageId ||
    anchor.channelId !== thread.id ||
    anchor.authorKind !== "human" ||
    !input.config.allowedDiscordUserIds.includes(anchor.author.providerUserId) ||
    !botUserId ||
    !anchor.mentionedDiscordUserIds.includes(botUserId) ||
    !questionAfterLeadingDiscordBotMention(anchor.content, botUserId)
  ) {
    throw new DiscordConversationEvidenceError(
      "discord-conversation-anchor-unavailable",
      "The Discord Context Ask anchor message is no longer readable"
    );
  }

  return anchor;
}

async function readThreadThroughAnchor(
  input: CreateDiscordConversationEvidenceSourceInput,
  conversationObjectId: string,
  anchor: DiscordConversationMessage
): Promise<{
  messages: DiscordConversationMessage[];
  partialReasons: ConversationSourcePartialReason[];
}> {
  const messages = [anchor];
  let evidenceCharacterCount = anchor.content.length;
  let beforeMessageId = anchor.id;

  while (true) {
    const remainingMessages = input.config.maxMessages - messages.length;
    let page: DiscordConversationMessagePage;

    try {
      page = await input.reader.listMessagesBefore({
        conversationObjectId,
        beforeMessageId,
        limit: Math.min(DISCORD_MESSAGE_PAGE_SIZE, Math.max(1, remainingMessages + 1))
      });
    } catch {
      return paginationIncomplete(messages);
    }

    if (page.messages.length === 0) {
      if (page.hasMore) {
        return paginationIncomplete(messages);
      }

      break;
    }

    try {
      assertPageBelongsToConversation(
        page,
        conversationObjectId,
        beforeMessageId,
        messages
      );
    } catch {
      return paginationIncomplete(messages);
    }

    for (const message of page.messages) {
      if (message.kind === "thread-starter") {
        continue;
      }

      if (
        messages.length >= input.config.maxMessages ||
        evidenceCharacterCount + message.content.length > input.config.maxEvidenceChars
      ) {
        return historyTruncated(messages, input.config);
      }

      messages.push(message);
      evidenceCharacterCount += message.content.length;
    }

    if (!page.hasMore) {
      break;
    }

    const oldestMessage = page.messages.at(-1);

    if (!oldestMessage) {
      return paginationIncomplete(messages);
    }

    beforeMessageId = oldestMessage.id;
  }

  return { messages, partialReasons: [] };
}

function historyTruncated(
  messages: DiscordConversationMessage[],
  config: DiscordContextAskConfig
): {
  messages: DiscordConversationMessage[];
  partialReasons: ConversationSourcePartialReason[];
} {
  return {
    messages,
    partialReasons: [
      {
        code: "history-truncated",
        message: `The configured Context Ask boundary reached its ${config.maxMessages}-message or ${config.maxEvidenceChars}-character limit.`
      }
    ]
  };
}

function paginationIncomplete(messages: DiscordConversationMessage[]): {
  messages: DiscordConversationMessage[];
  partialReasons: ConversationSourcePartialReason[];
} {
  return {
    messages,
    partialReasons: [
      {
        code: "pagination-incomplete",
        message:
          "Discord history could not be completed, so the bounded conversation is incomplete."
      }
    ]
  };
}

function assertPageBelongsToConversation(
  page: DiscordConversationMessagePage,
  conversationObjectId: string,
  beforeMessageId: string,
  existing: DiscordConversationMessage[]
): void {
  const seenMessageIds = new Set(existing.map((message) => message.id));

  for (const message of page.messages) {
    if (
      message.channelId !== conversationObjectId ||
      message.id === beforeMessageId ||
      seenMessageIds.has(message.id)
    ) {
      throw new DiscordConversationEvidenceError(
        "discord-conversation-pagination-invalid",
        "Discord returned a duplicate or cross-thread conversation message"
      );
    }

    seenMessageIds.add(message.id);
  }
}

function incompleteEvidenceReasons(
  messages: DiscordConversationMessage[]
): ConversationSourcePartialReason[] {
  return messages.flatMap((message): ConversationSourcePartialReason[] => {
    if (message.authorKind !== "human") {
      return [
        {
          code: "unknown-provider-shape" as const,
          messageId: message.id,
          message:
            "The current Discord Context Ask slice does not treat bot, webhook, or system messages as original human evidence."
        }
      ];
    }

    if (message.hasUnsupportedContent) {
      return [
        {
          code: "message-content-unavailable" as const,
          messageId: message.id,
          message:
            "A Discord message contains attachment, embed, sticker, poll, component, voice, or forwarded content that this text-only capture does not retain."
        }
      ];
    }

    if (message.content.trim().length === 0) {
      return [
        {
          code: "message-content-unavailable" as const,
          messageId: message.id,
          message:
            "A Discord message has no readable text content, so this bounded conversation is incomplete."
        }
      ];
    }

    return [];
  });
}

function isReadableHumanTextMessage(message: DiscordConversationMessage): boolean {
  return message.authorKind === "human" && message.content.trim().length > 0;
}

function rawConversationMessage(
  message: DiscordConversationMessage,
  ordinal: number
): RawConversationMessage {
  return {
    id: message.id,
    ordinal,
    author: message.author,
    createdAt: message.createdAt,
    editedAt: message.editedAt,
    replyToMessageId: message.replyToMessageId,
    url: message.url,
    state: "available",
    text: message.content
  };
}

function compareDiscordMessagesChronologically(
  left: DiscordConversationMessage,
  right: DiscordConversationMessage
): number {
  const timestampComparison = left.createdAt.localeCompare(right.createdAt);

  return timestampComparison === 0
    ? left.id.localeCompare(right.id)
    : timestampComparison;
}
