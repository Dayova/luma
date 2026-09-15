import { createHash, randomUUID } from "node:crypto";
import { type Client, Events } from "discord.js";
import { z } from "zod";
import {
  ConversationLifecycleChangedError,
  type RetainedConversationLifecycle
} from "../knowledge/retained-conversation-lifecycle.js";
import type { ConversationEvidenceSource } from "../context-intelligence/conversation-evidence-source.js";

const dispatchSchema = z.object({
  t: z.string(),
  s: z.number().int().nonnegative(),
  d: z.unknown()
});
const messageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  guild_id: z.string(),
  content: z.string().max(32_000).optional(),
  edited_timestamp: z.string().nullable().optional(),
  author: z.object({ id: z.string(), bot: z.boolean().optional() }).optional(),
  webhook_id: z.string().optional()
});
const bulkSchema = z.object({
  channel_id: z.string(),
  guild_id: z.string(),
  ids: z.array(z.string()).max(100)
});

/** Raw dispatches include uncached deletions and stable session sequence numbers. */
export function createDiscordRetainedLifecycle(input: {
  client: Client;
  lifecycle: RetainedConversationLifecycle;
  guildId: string;
  requireChannel(channelId: string): Promise<void>;
  authorize(userId: string): Promise<boolean>;
}) {
  let tail = Promise.resolve();
  let failure: unknown;
  let stopped = false;
  let received = 0;
  const boot = randomUUID();
  const sessions = new Map<number, string>();
  function enqueue(work: () => Promise<void>) {
    if (stopped) return;
    received++;
    tail = tail.then(work).catch((error: unknown) => {
      failure = error;
    });
  }
  async function flush() {
    let pending: Promise<void>;
    do {
      pending = tail;
      await pending;
    } while (pending !== tail);
    if (failure)
      throw new Error(
        "Discord retained-source persistence failed; restart after checking the store"
      );
  }
  const onRaw = (packet: unknown, shardId: number) => {
    const parsed = dispatchSchema.safeParse(packet);
    if (!parsed.success) return;
    const { t, s, d } = parsed.data;
    if (t === "READY") {
      const ready = z.object({ session_id: z.string() }).safeParse(d);
      if (ready.success) {
        const session = createHash("sha256").update(ready.data.session_id).digest("hex");
        sessions.set(shardId, session);
        enqueue(() =>
          input.lifecycle.gap(
            `ready:${boot}:${shardId}:${session}`,
            new Date().toISOString()
          )
        );
      }
      return;
    }
    if (
      ![
        "MESSAGE_CREATE",
        "MESSAGE_UPDATE",
        "MESSAGE_DELETE",
        "MESSAGE_DELETE_BULK",
        "THREAD_DELETE"
      ].includes(t)
    )
      return;
    const eventId = `gateway:${sessions.get(shardId) ?? boot}:${shardId}:${s}`;
    const observedAt = new Date().toISOString();
    if (t === "THREAD_DELETE") {
      const thread = z.object({ id: z.string(), guild_id: z.string() }).safeParse(d);
      if (thread.success && thread.data.guild_id === input.guildId)
        enqueue(() =>
          input.lifecycle.observe({
            eventId,
            observedAt,
            conversationId: thread.data.id,
            kind: "excluded"
          })
        );
      return;
    }
    if (t === "MESSAGE_DELETE_BULK") {
      const bulk = bulkSchema.safeParse(d);
      if (!bulk.success || bulk.data.guild_id !== input.guildId) return;
      enqueue(async () => {
        if (!(await input.lifecycle.tracks(bulk.data.channel_id))) return;
        // Positive deletion metadata is retained even if the channel is no longer readable.
        for (const messageId of bulk.data.ids)
          await input.lifecycle.observe({
            eventId: `${eventId}:${messageId}`,
            observedAt,
            conversationId: bulk.data.channel_id,
            kind: "deleted",
            messageId
          });
      });
      return;
    }
    const message = messageSchema.safeParse(d);
    if (!message.success || message.data.guild_id !== input.guildId) return;
    const data = message.data;
    // Assistant progress/results must not invalidate their own source proofs.
    if (
      data.author?.bot ||
      data.webhook_id ||
      (data.author && data.author.id === input.client.user?.id)
    )
      return;
    // Poll closure, embeds and pin metadata are not text revisions. Poll evidence has its own fresh proof.
    if (
      t === "MESSAGE_UPDATE" &&
      data.content === undefined &&
      data.edited_timestamp === undefined
    )
      return;
    enqueue(async () => {
      if (!(await input.lifecycle.tracks(data.channel_id))) return;
      if (t === "MESSAGE_DELETE") {
        await input.lifecycle.observe({
          eventId,
          observedAt,
          conversationId: data.channel_id,
          kind: "deleted",
          messageId: data.id
        });
        return;
      }
      try {
        await input.requireChannel(data.channel_id);
      } catch {
        await input.lifecycle.gap(`${eventId}:access-unverified`, observedAt);
        return;
      }
      const canRetainText = data.author && (await input.authorize(data.author.id));
      await input.lifecycle.observe({
        eventId,
        observedAt,
        conversationId: data.channel_id,
        kind: t === "MESSAGE_CREATE" ? "created" : "edited",
        messageId: data.id,
        text: canRetainText ? (data.content ?? null) : null,
        providerVersion: data.edited_timestamp ?? null
      });
    });
  };
  const onDisconnect = () =>
    enqueue(() =>
      input.lifecycle.gap(`disconnect:${randomUUID()}`, new Date().toISOString())
    );
  input.client.on(Events.Raw, onRaw);
  input.client.on(Events.ShardDisconnect, onDisconnect);
  input.client.on(Events.ShardReconnecting, onDisconnect);
  return {
    async start() {
      enqueue(() => input.lifecycle.gap(`start:${boot}`, new Date().toISOString()));
      await flush();
    },
    async stop() {
      stopped = true;
      input.client.off(Events.Raw, onRaw);
      input.client.off(Events.ShardDisconnect, onDisconnect);
      input.client.off(Events.ShardReconnecting, onDisconnect);
      await flush();
    },
    async capture(
      source: ConversationEvidenceSource,
      request: Parameters<ConversationEvidenceSource["capture"]>[0]
    ) {
      if (stopped) throw new Error("Discord retained source is stopped");
      for (let attempt = 0; attempt < 3; attempt++) {
        await flush();
        const before = received;
        try {
          const captured = await input.lifecycle.capture(source, request);
          await flush();
          if (before === received) return captured;
        } catch (error) {
          if (!(error instanceof ConversationLifecycleChangedError)) throw error;
        }
      }
      throw new ConversationLifecycleChangedError(
        "Discord source kept changing during current-source verification"
      );
    }
  };
}
