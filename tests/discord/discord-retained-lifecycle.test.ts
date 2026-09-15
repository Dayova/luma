import { Client, Events } from "discord.js";
import { afterEach, describe, expect, it } from "vitest";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import { createRetainedConversationLifecycle } from "../../src/knowledge/retained-conversation-lifecycle.js";
import { createDiscordRetainedLifecycle } from "../../src/discord/discord-retained-lifecycle.js";
import type { ConversationEvidenceSource } from "../../src/context-intelligence/conversation-evidence-source.js";
import { conversationSnapshotContentHash } from "../../src/knowledge/observed-source-ledger.js";
const databases: LumaDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
});
async function harness() {
  const database = await createPgliteDatabase();
  databases.push(database);
  const client = new Client({ intents: [] });
  const lifecycle = createRetainedConversationLifecycle({
    database,
    workspaceId: "dayova",
    providerId: "discord",
    allowedParentIds: ["parent"]
  });
  let readable = true;
  const adapter = createDiscordRetainedLifecycle({
    client,
    lifecycle,
    guildId: "guild",
    requireChannel: () =>
      readable ? Promise.resolve() : Promise.reject(new Error("unavailable")),
    authorize: (id) => Promise.resolve(id === "founder")
  });
  const request = {
    workspaceId: "dayova",
    subject: {
      type: "conversation-thread" as const,
      providerId: "discord",
      conversationObjectId: "thread",
      anchorMessageId: "message"
    }
  };
  let text = "Original";
  const source: ConversationEvidenceSource = {
    capture: () =>
      Promise.resolve({
        observedAt: "2026-09-15T13:00:00.000Z",
        providerVersion: null,
        source: {
          providerId: "discord",
          sourceKind: "conversation",
          sourceObjectId: "message",
          parentObjectId: "thread",
          url: "https://discord.com/channels/guild/thread/message"
        },
        snapshot: {
          schemaVersion: 1,
          conversation: {
            conversationObjectId: "thread",
            parentConversationObjectId: "parent",
            title: "Luma",
            url: "https://discord.com/channels/guild/thread"
          },
          boundary: {
            mode: "thread",
            anchorMessageId: "message",
            firstMessageId: "message",
            lastMessageId: "message",
            messageIds: ["message"]
          },
          messages: [
            {
              id: "message",
              ordinal: 0,
              author: { providerUserId: "founder", displayName: "Founder" },
              createdAt: "2026-09-15T13:00:00.000Z",
              editedAt: null,
              replyToMessageId: null,
              url: "https://discord.com/channels/guild/thread/message",
              state: "available",
              text
            }
          ],
          completeness: { state: "complete" }
        }
      })
  };
  await adapter.start();
  const initial = await adapter.capture(source, request);
  const emit = (t: string, s: number, d: unknown) =>
    client.emit(Events.Raw, { t, s, d }, 0);
  return {
    database,
    client,
    lifecycle,
    adapter,
    initial,
    emit,
    source,
    request,
    update: (value: string) => {
      text = value;
    },
    revoke: () => {
      readable = false;
    },
    capture: () => adapter.capture(source, request)
  };
}
const message = {
  id: "message",
  channel_id: "thread",
  guild_id: "guild",
  author: { id: "founder" },
  content: "Edited"
};
describe("Discord retained Gateway adapter", () => {
  it("records uncached edit dispatches and deduplicates replay within the same Gateway session", async () => {
    const h = await harness();
    h.emit("READY", 0, { session_id: "session" });
    await h.capture();
    h.emit("MESSAGE_UPDATE", 1, message);
    h.emit("MESSAGE_UPDATE", 1, message);
    h.update("Edited");
    const current = await h.capture();
    expect(conversationSnapshotContentHash(current.snapshot)).not.toBe(
      conversationSnapshotContentHash(h.initial.snapshot)
    );
    expect(
      (
        await h.database.query(
          "SELECT * FROM conversation_lifecycle_events WHERE kind='edited'"
        )
      ).rows
    ).toHaveLength(1);
    await h.adapter.stop();
  });
  it("records uncached bulk deletion tombstones and drains them on stop", async () => {
    const h = await harness();
    h.emit("MESSAGE_DELETE_BULK", 1, {
      guild_id: "guild",
      channel_id: "thread",
      ids: ["message", "other"]
    });
    await h.adapter.stop();
    expect(
      (
        await h.database.query(
          "SELECT * FROM conversation_lifecycle_events WHERE kind='deleted'"
        )
      ).rows
    ).toHaveLength(2);
    await expect(h.capture()).rejects.toThrow("stopped");
  });
  it("ignores bot progress, poll-only metadata, other guilds and untracked conversations", async () => {
    const h = await harness();
    h.emit("MESSAGE_CREATE", 1, { ...message, author: { id: "bot", bot: true } });
    h.emit("MESSAGE_UPDATE", 2, {
      id: "message",
      channel_id: "thread",
      guild_id: "guild",
      poll: {}
    });
    h.emit("MESSAGE_CREATE", 3, { ...message, guild_id: "elsewhere" });
    h.emit("MESSAGE_CREATE", 4, { ...message, channel_id: "personal" });
    const current = await h.capture();
    expect(current.snapshot.lifecycle).toEqual(h.initial.snapshot.lifecycle);
    expect(
      (
        await h.database.query(
          "SELECT * FROM conversation_lifecycle_events WHERE kind IN ('created','edited')"
        )
      ).rows
    ).toHaveLength(0);
    await h.adapter.stop();
  });
  it("records an access-verification gap without retaining potentially private event text", async () => {
    const h = await harness();
    h.revoke();
    h.emit("MESSAGE_UPDATE", 1, message);
    await h.adapter.stop();
    const events = await h.database.query<{ kind: string; payload_json: string }>(
      "SELECT kind,payload_json FROM conversation_lifecycle_events"
    );
    expect(events.rows.filter((r) => r.kind === "edited")).toHaveLength(0);
    expect(events.rows.some((r) => r.kind === "gap")).toBe(true);
    expect(events.rows.some((r) => r.payload_json.includes("Edited"))).toBe(false);
  });
  it("records a disconnected interval and invalidates pre-gap proofs even when current text is unchanged", async () => {
    const h = await harness();
    h.client.emit(Events.ShardReconnecting, 0);
    const current = await h.capture();
    expect(current.snapshot.lifecycle?.gapObserved).toBe(true);
    expect(current.snapshot.lifecycle?.revision).not.toBe(
      h.initial.snapshot.lifecycle?.revision
    );
    await h.adapter.stop();
  });
  it("refuses a stale reread that contradicts a full edit without a timestamp", async () => {
    const h = await harness();
    h.emit("MESSAGE_UPDATE", 1, message);
    await expect(h.capture()).rejects.toThrow("contradicts");
    await h.adapter.stop();
  });
  it("retains a partial edit as unknown text, never a deletion", async () => {
    const h = await harness();
    h.emit("MESSAGE_UPDATE", 1, {
      id: "message",
      channel_id: "thread",
      guild_id: "guild",
      edited_timestamp: null
    });
    await h.capture();
    const event = await h.database.query<{ kind: string; payload_json: string }>(
      "SELECT kind,payload_json FROM conversation_lifecycle_events WHERE kind='edited'"
    );
    expect(JSON.parse(event.rows[0]!.payload_json)).toMatchObject({ text: null });
    expect(
      (
        await h.database.query(
          "SELECT * FROM conversation_lifecycle_events WHERE kind='deleted'"
        )
      ).rows
    ).toHaveLength(0);
    await h.adapter.stop();
  });
});
