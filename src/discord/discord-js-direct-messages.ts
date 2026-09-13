import { discordAnswerDelivery } from "./discord-answer-delivery.js";
import { createHash } from "node:crypto";
import { ChannelType, MessageType, Routes, type Client, type Message } from "discord.js";
import { z } from "zod";
import type {
  DirectMessage,
  DirectMessageEvent,
  DiscordDirectMessageTransport
} from "./discord-direct-messages.js";

const userSchema = z.object({
  id: z.string(),
  bot: z.boolean().optional().default(false)
});
const messageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  author: userSchema,
  content: z.string(),
  timestamp: z.string(),
  edited_timestamp: z.string().nullable(),
  type: z.number(),
  attachments: z.array(z.unknown()).default([]),
  embeds: z.array(z.unknown()).default([]),
  sticker_items: z.array(z.unknown()).default([]),
  poll: z.unknown().optional(),
  webhook_id: z.string().optional(),
  flags: z.number().default(0)
});
function mapped(raw: unknown): DirectMessage {
  const m = messageSchema.parse(raw);
  return {
    id: m.id,
    channelId: m.channel_id,
    authorId: m.author.id,
    bot: m.author.bot,
    text: m.content,
    createdAt: m.timestamp,
    editedAt: m.edited_timestamp,
    unsupported:
      ![MessageType.Default, MessageType.Reply].includes(m.type) ||
      !!m.webhook_id ||
      m.attachments.length > 0 ||
      m.embeds.length > 0 ||
      m.sticker_items.length > 0 ||
      m.poll != null ||
      !!(m.flags & (1 << 13))
  };
}
export function createDiscordJsDirectMessages(input: {
  client: Client;
  signal: AbortSignal;
  authorize: (id: string) => Promise<boolean>;
}) {
  let handler: ((event: DirectMessageEvent) => Promise<void>) | undefined;
  const { client, signal } = input;
  async function recipient(channelId: string) {
    const channel = z
      .object({
        id: z.string(),
        type: z.nativeEnum(ChannelType),
        recipients: z.array(userSchema).optional()
      })
      .parse(await client.rest.get(Routes.channel(channelId), { signal }));
    const user = channel.recipients?.[0];
    return channel.id === channelId &&
      channel.type === ChannelType.DM &&
      channel.recipients?.length === 1 &&
      user &&
      !user.bot &&
      (await input.authorize(user.id))
      ? user.id
      : null;
  }
  async function requireRecipient(channelId: string) {
    if (!(await recipient(channelId)))
      throw new Error("Direct message channel unavailable");
  }
  const port: DiscordDirectMessageTransport = {
    onMessage(value) {
      handler = value;
    },
    botId: () => client.user?.id ?? null,
    recipient,
    async read(channelId, messageId) {
      await requireRecipient(channelId);
      return mapped(
        await client.rest.get(Routes.channelMessage(channelId, messageId), { signal })
      );
    },
    async before(channelId, messageId, limit) {
      await requireRecipient(channelId);
      const values = z.array(z.unknown()).parse(
        await client.rest.get(Routes.channelMessages(channelId), {
          signal,
          query: new URLSearchParams({ before: messageId, limit: String(limit) })
        })
      );
      return values.map(mapped);
    },
    async send(request) {
      if ((await recipient(request.channelId)) !== request.recipientId)
        throw new Error("DM recipient changed");
      const delivery = discordAnswerDelivery(request.content);
      const sent = await client.rest.post(Routes.channelMessages(request.channelId), {
        signal,
        ...(delivery.attachment
          ? {
              files: [
                {
                  data: delivery.attachment,
                  name: "luma-answer.txt",
                  contentType: "text/plain; charset=utf-8"
                }
              ]
            }
          : {}),
        body: {
          content: delivery.content,
          allowed_mentions: { parse: [] },
          flags: 4,
          nonce: createHash("sha256")
            .update(request.idempotencyKey)
            .digest("hex")
            .slice(0, 24),
          enforce_nonce: true
        }
      });
      const result = z
        .object({
          id: z.string().regex(/^\d{17,20}$/u),
          channel_id: z.string(),
          author: z.object({ id: z.string() })
        })
        .safeParse(sent);
      if (
        !result.success ||
        result.data.channel_id !== request.channelId ||
        result.data.author.id !== client.user?.id
      )
        throw new Error("Discord did not acknowledge the bot-owned message");
      const route = Routes.channelMessage(request.channelId, result.data.id);
      return {
        async edit(content: string) {
          if ((await recipient(request.channelId)) !== request.recipientId)
            throw new Error("DM recipient changed");
          await client.rest.patch(route, {
            signal,
            body: { content: content.slice(0, 2000), allowed_mentions: { parse: [] } }
          });
        },
        async remove() {
          await client.rest.delete(route, { signal });
        }
      };
    }
  };
  return {
    port,
    stopAdmission() {
      handler = undefined;
    },
    async deliver(message: Message) {
      const admitted = handler;
      if (
        !admitted ||
        message.guildId !== null ||
        message.channel.type !== ChannelType.DM ||
        message.author.bot ||
        message.webhookId ||
        !(await input.authorize(message.author.id))
      )
        return;
      await admitted({
        channelId: message.channelId,
        messageId: message.id,
        authorId: message.author.id
      });
    }
  };
}
