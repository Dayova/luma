import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Discord from "discord.js";
import {
  ChannelType,
  Collection,
  Events,
  MessageType,
  PermissionFlagsBits
} from "discord.js";
import { conversationSnapshotContentHash } from "../../src/knowledge/observed-source-ledger.js";
import { createDiscordJsTransport } from "../../src/discord/discord-js-adapter.js";
import type { DiscordContextAskResponse } from "../../src/discord/discord-meeting-bot.js";

const sdk = vi.hoisted(() => ({
  channels: new Map<string, unknown>(),
  emit: (_event: string, ..._values: unknown[]): boolean => {
    void _event;
    void _values;
    return false;
  },
  fetch: vi.fn<(id: string, options?: unknown) => Promise<unknown>>()
}));

vi.mock("discord.js", async (importOriginal) => {
  const original = await importOriginal<typeof Discord>();
  const { EventEmitter } = await import("node:events");
  return {
    ...original,
    Client: class extends EventEmitter {
      user = { id: "bot" };
      channels = { fetch: sdk.fetch };
      constructor() {
        super();
        sdk.emit = this.emit.bind(this);
      }
      login(): Promise<void> {
        queueMicrotask(() => this.emit(original.Events.ClientReady));
        return Promise.resolve();
      }
      destroy(): Promise<void> {
        return Promise.resolve();
      }
    },
    REST: class {
      setToken() {
        return this;
      }
      put(): Promise<void> {
        return Promise.resolve();
      }
    }
  };
});

function channel(id: string, type: ChannelType, parentId: string | null = null) {
  return {
    id,
    type,
    guildId: "guild",
    parentId,
    name: "a changeable label",
    permissionsFor: () => ({ has: () => true }),
    isSendable: () => true,
    send: vi.fn(() => Promise.resolve()),
    messages: { fetch: vi.fn(() => Promise.resolve(new Collection())) }
  };
}

beforeEach(() => {
  sdk.channels.clear();
  sdk.channels.set("parent", channel("parent", ChannelType.GuildText));
  sdk.channels.set("thread", channel("thread", ChannelType.PublicThread, "parent"));
  sdk.fetch.mockImplementation((id) => Promise.resolve(sdk.channels.get(id) ?? null));
});
afterEach(() => {
  vi.clearAllMocks();
});

function transport() {
  return createDiscordJsTransport({
    token: "test-only",
    clientId: "application",
    guildId: "guild",
    allowedParentChannelIds: ["parent"],
    contextAsk: {
      parentChannelIds: ["parent"],
      allowedDiscordUserIds: ["founder"],
      maxMessages: 50,
      maxEvidenceChars: 32000,
      minIntervalMs: 60000
    }
  });
}

function mention() {
  return {
    id: "message",
    guildId: "guild",
    channelId: "thread",
    author: { id: "founder", bot: false },
    system: false,
    webhookId: null,
    mentions: { users: new Map([["bot", {}]]) },
    content: "<@bot> usage",
    createdAt: new Date("2026-09-08T12:00:00Z"),
    channel: {
      isThread: () => true,
      isSendable: () => true,
      parentId: "parent",
      type: ChannelType.PublicThread
    },
    reply: vi.fn<(options: unknown) => Promise<void>>(() => Promise.resolve())
  };
}

describe("Discord production channel resolution and delivery", () => {
  it.each([true, false])(
    "fences organizational context at final delivery without invoking the handler twice: %s",
    async (current) => {
      const live = transport();
      const message = mention();
      const fence = vi.fn(() =>
        current
          ? Promise.resolve()
          : Promise.reject(new Error("Source revoked after answering"))
      );
      const handler = vi.fn(() =>
        Promise.resolve({
          content: "Old organizational claim",
          idempotencyKey: "context-result",
          requireCurrent: fence
        })
      );
      await live.connect(() => Promise.resolve({ content: "unused" }), handler);
      sdk.emit(Events.MessageCreate, message);
      await vi.waitFor(() => expect(message.reply).toHaveBeenCalledOnce());
      expect(fence).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledOnce();
      const sent = message.reply.mock.calls[0]?.[0];
      expect(sent).toHaveProperty(
        "content",
        current
          ? expect.stringContaining("Old organizational claim")
          : expect.stringContaining("organizational context changed")
      );
      if (!current)
        expect(sent).not.toHaveProperty(
          "content",
          expect.stringContaining("Old organizational claim")
        );
      await live.disconnect();
    }
  );
  it.each(["unchanged", "edited", "deleted", "history-revoked", "anchor-edited"])(
    "revalidates answer evidence and reading permission at final delivery: %s",
    async (change) => {
      const live = transport();
      const anchor = {
        ...mention(),
        content: "<@bot> What did we decide?",
        type: MessageType.Default,
        author: { id: "founder", bot: false, username: "Founder" },
        url: "https://discord.com/channels/guild/thread/message",
        attachments: new Map(),
        embeds: [],
        stickers: new Map(),
        components: [],
        poll: null,
        messageSnapshots: new Map(),
        flags: { has: () => false },
        editedAt: null,
        reference: null
      };
      const historical = {
        ...anchor,
        id: "source",
        content: "Internal original claim",
        createdAt: new Date("2026-09-08T11:00:00Z"),
        url: "https://discord.com/channels/guild/thread/source"
      };
      let historyReadable = true;
      let deleted = false;
      const messageFetch = vi.fn<(input: unknown) => Promise<unknown>>((input) => {
        if (input && typeof input === "object" && "message" in input)
          return Promise.resolve(anchor);
        return Promise.resolve(
          new Collection(deleted ? [] : [[historical.id, historical]])
        );
      });
      sdk.channels.set("thread", {
        ...channel("thread", ChannelType.PublicThread, "parent"),
        isThread: () => true,
        url: "https://discord.com/channels/guild/thread",
        permissionsFor: () => ({
          has: (permission: bigint) =>
            permission !== PermissionFlagsBits.ReadMessageHistory || historyReadable
        }),
        messages: { fetch: messageFetch }
      });
      const captureInput = {
        workspaceId: "workspace",
        subject: {
          type: "conversation-thread" as const,
          providerId: "discord",
          conversationObjectId: "thread",
          anchorMessageId: "message"
        },
        question: "What did we decide?"
      };
      const captured = await live.capture(captureInput);
      let finish: (response: DiscordContextAskResponse) => void = () => undefined;
      const pending = new Promise<DiscordContextAskResponse>((resolve) => {
        finish = resolve;
      });
      const handler = vi.fn(() => pending);
      await live.connect(() => Promise.resolve({ content: "unused" }), handler);
      sdk.emit(Events.MessageCreate, anchor);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
      if (change === "edited") historical.content = "Corrected claim";
      if (change === "deleted") deleted = true;
      if (change === "history-revoked") historyReadable = false;
      if (change === "anchor-edited") anchor.content = "<@bot> A different question";
      finish({
        content: "Internal old answer",
        idempotencyKey: "answer",
        sourceProof: {
          ...captureInput,
          contentHash: conversationSnapshotContentHash(captured.snapshot)
        }
      });
      await vi.waitFor(() => expect(anchor.reply).toHaveBeenCalledOnce());
      const sent = anchor.reply.mock.calls[0]?.[0];
      if (change === "unchanged")
        expect(sent).toHaveProperty(
          "content",
          expect.stringContaining("Internal old answer")
        );
      else {
        expect(sent).toHaveProperty(
          "content",
          expect.stringContaining("conversation changed or is no longer readable")
        );
        expect(sent).not.toHaveProperty(
          "content",
          expect.stringContaining("Internal old answer")
        );
      }
      expect(messageFetch).toHaveBeenCalledWith({ message: "message", force: true });
      expect(handler).toHaveBeenCalledOnce();
      await live.disconnect();
    }
  );

  it("freshly resolves stable channel identity and supported parent type", async () => {
    const live = transport();
    expect(await live.resolveChannel({ channelId: "thread" })).toEqual({
      id: "thread",
      guildId: "guild",
      kind: "public-thread",
      parentChannelId: "parent"
    });
    expect(sdk.fetch).toHaveBeenCalledWith("thread", { force: true });
    expect(sdk.fetch).toHaveBeenCalledWith("parent", { force: true });
    sdk.channels.set("parent", {
      ...channel("parent", ChannelType.GuildText),
      name: "renamed work channel"
    });
    expect(await live.resolveChannel({ channelId: "thread" })).toMatchObject({
      parentChannelId: "parent"
    });
    sdk.channels.set("parent", channel("parent", ChannelType.GuildForum));
    expect(await live.resolveChannel({ channelId: "thread" })).toBeNull();
    sdk.channels.set("thread", channel("thread", ChannelType.PrivateThread, "parent"));
    expect(await live.resolveChannel({ channelId: "thread" })).toBeNull();
    expect(await live.resolveChannel({ channelId: "missing" })).toBeNull();
  });

  it("denies stale mention metadata before invoking its handler", async () => {
    const live = transport();
    const handler = vi.fn(() =>
      Promise.resolve({ content: "internal usage", idempotencyKey: "reply" })
    );
    await live.connect(() => Promise.resolve({ content: "unused" }), handler);
    sdk.channels.set("thread", channel("thread", ChannelType.PublicThread, "excluded"));
    sdk.channels.set("excluded", channel("excluded", ChannelType.GuildText));
    const message = mention();
    sdk.emit(Events.MessageCreate, message);
    await vi.waitFor(() =>
      expect(sdk.fetch).toHaveBeenCalledWith("excluded", { force: true })
    );
    expect(handler).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
    await live.disconnect();
  });

  it.each([false, true])(
    "suppresses a pending response and its fallback after scope loss (failure: %s)",
    async (fails) => {
      const live = transport();
      let finish: () => void = () => undefined;
      const pending = new Promise<DiscordContextAskResponse>((resolve, reject) => {
        finish = () =>
          fails
            ? reject(new Error("private provider detail"))
            : resolve({ content: "internal usage", idempotencyKey: "reply" });
      });
      const handler = vi.fn(() => pending);
      await live.connect(() => Promise.resolve({ content: "unused" }), handler);
      const message = mention();
      sdk.emit(Events.MessageCreate, message);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
      sdk.channels.delete("thread");
      sdk.fetch.mockClear();
      finish();
      await vi.waitFor(() =>
        expect(sdk.fetch).toHaveBeenCalledWith("thread", { force: true })
      );
      expect(message.reply).not.toHaveBeenCalled();
      await live.disconnect();
    }
  );

  it("blocks direct lifecycle publication outside scope before history or send", async () => {
    const live = transport();
    const destination = channel("thread", ChannelType.PublicThread, "excluded");
    sdk.channels.set("thread", destination);
    await expect(
      live.sendMessage({
        channelId: "thread",
        content: "internal receipt",
        idempotencyKey: "receipt"
      })
    ).rejects.toThrow("not enabled");
    expect(destination.messages.fetch).not.toHaveBeenCalled();
    expect(destination.send).not.toHaveBeenCalled();
    await expect(
      live.createThread({ parentChannelId: "excluded", name: "internal title" })
    ).rejects.toThrow();
  });

  it("rechecks scope after asynchronous receipt recovery before sending", async () => {
    const live = transport();
    const destination = channel("thread", ChannelType.PublicThread, "parent");
    destination.messages.fetch.mockImplementation(() => {
      sdk.channels.delete("thread");
      return Promise.resolve(new Collection());
    });
    sdk.channels.set("thread", destination);
    await expect(
      live.sendMessage({
        channelId: "thread",
        content: "internal receipt",
        idempotencyKey: "receipt"
      })
    ).rejects.toThrow("not enabled");
    expect(destination.messages.fetch).toHaveBeenCalled();
    expect(destination.send).not.toHaveBeenCalled();
  });
});
