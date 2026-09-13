import type { EventEmitter } from "node:events";
import type * as Discord from "discord.js";
import { ChannelType, Events, GatewayIntentBits, Partials } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscordJsTransport } from "../../src/discord/discord-js-adapter.js";
const bot = "1526147284822392952";
const founder = "779381502311137301";
const channel = "1550000000000000001";
const messageId = "1550000000000000100";
const sdk = vi.hoisted(() => ({
  emitter: undefined as EventEmitter | undefined,
  options: undefined as Discord.ClientOptions | undefined,
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  destroy: vi.fn<() => Promise<void>>()
}));
vi.mock("discord.js", async (original) => {
  const actual = await original<typeof Discord>();
  const { EventEmitter: Emitter } = await import("node:events");
  return {
    ...actual,
    Client: class extends Emitter {
      user = { id: "1526147284822392952" };
      rest = { get: sdk.get, post: sdk.post, patch: sdk.patch, delete: sdk.delete };
      constructor(options: Discord.ClientOptions) {
        super();
        sdk.emitter = this;
        sdk.options = options;
      }
      login() {
        queueMicrotask(() => this.emit(actual.Events.ClientReady));
        return Promise.resolve();
      }
      isReady() {
        return true;
      }
      destroy() {
        return sdk.destroy();
      }
    },
    REST: class {
      setToken() {
        return this;
      }
      put() {
        return Promise.resolve();
      }
    }
  };
});
beforeEach(() => {
  vi.resetAllMocks();
  sdk.post.mockResolvedValue({
    id: "1550000000000000999",
    channel_id: channel,
    author: { id: bot }
  });
  sdk.destroy.mockResolvedValue(undefined);
  sdk.get.mockImplementation((route: string) =>
    Promise.resolve(
      route === `/channels/${channel}`
        ? { id: channel, type: ChannelType.DM, recipients: [{ id: founder, bot: false }] }
        : {
            id: messageId,
            channel_id: channel,
            author: { id: founder },
            content: "Private text",
            timestamp: "2026-09-13T07:00:00Z",
            edited_timestamp: null,
            type: 0,
            attachments: [],
            embeds: []
          }
    )
  );
});
async function start() {
  const transport = createDiscordJsTransport({
    token: "test-token",
    clientId: bot,
    guildId: "guild",
    allowedParentChannelIds: [],
    authorizeHumanReader: (id) => Promise.resolve(id === founder),
    directMessages: true
  });
  await transport.connect(() => Promise.resolve({ content: "Unused" }));
  return transport;
}
function emit(authorId = founder, type: ChannelType = ChannelType.DM) {
  sdk.emitter?.emit(Events.MessageCreate, {
    id: messageId,
    channelId: channel,
    guildId: null,
    channel: { type },
    author: { id: authorId, bot: false },
    webhookId: null
  });
}

describe("native Discord DM transport", () => {
  it("receives uncached DMs without enabling public-thread message capture", async () => {
    const transport = await start();
    try {
      expect(sdk.options?.intents).toContain(GatewayIntentBits.DirectMessages);
      expect(sdk.options?.intents).not.toContain(GatewayIntentBits.MessageContent);
      expect(sdk.options?.partials).toContain(Partials.Channel);
      const events: unknown[] = [];
      transport.directMessages!.onMessage((event) => {
        events.push(event);
        return Promise.resolve();
      });
      emit("999999999999999999");
      emit(founder, ChannelType.GroupDM);
      emit();
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(events[0]).toEqual({ channelId: channel, messageId, authorId: founder });
      const message = await transport.directMessages!.read(channel, messageId);
      expect(message).toMatchObject({
        text: "Private text",
        authorId: founder,
        unsupported: false
      });
    } finally {
      await transport.disconnect();
    }
  });
  it("rechecks the exact DM recipient before sending and restricts mentions", async () => {
    const transport = await start();
    try {
      const response = {
        channelId: channel,
        recipientId: founder,
        content: "@everyone Private answer",
        idempotencyKey: "dm:reply"
      };
      await transport.directMessages!.send(response);
      expect(sdk.post).toHaveBeenCalledWith(
        `/channels/${channel}/messages`,
        expect.objectContaining({
          body: expect.objectContaining({
            allowed_mentions: { parse: [] },
            enforce_nonce: true,
            flags: 4
          }) as unknown
        })
      );
      sdk.get.mockResolvedValue({
        id: channel,
        type: ChannelType.GroupDM,
        recipients: [{ id: founder }]
      });
      await expect(transport.directMessages!.send(response)).rejects.toThrow();
      expect(sdk.post).toHaveBeenCalledTimes(1);
    } finally {
      await transport.disconnect();
    }
  });
  it("drains admitted DM work before destroying the Gateway and refuses later events", async () => {
    const transport = await start();
    let release = () => {};
    let admitted = 0;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    transport.directMessages!.onMessage(async () => {
      admitted++;
      await pending;
    });
    emit();
    await vi.waitFor(() => expect(admitted).toBe(1));
    const closing = transport.disconnect();
    expect(sdk.destroy).not.toHaveBeenCalled();
    emit();
    release();
    await closing;
    expect(admitted).toBe(1);
    expect(sdk.destroy).toHaveBeenCalledTimes(1);
  });
});

it("edits and removes only the acknowledged bot-owned status message", async () => {
  const transport = await start();
  try {
    const statusId = "1550000000000000999";
    sdk.post.mockResolvedValue({
      id: statusId,
      channel_id: channel,
      author: { id: bot }
    });
    const receipt = await transport.directMessages!.send({
      channelId: channel,
      recipientId: founder,
      content: "Working",
      idempotencyKey: "status"
    });
    expect(receipt).toBeDefined();
    await receipt!.edit("Still working");
    await receipt!.remove();
    expect(sdk.patch).toHaveBeenCalledWith(
      `/channels/${channel}/messages/${statusId}`,
      expect.objectContaining({
        body: { content: "Still working", allowed_mentions: { parse: [] } }
      })
    );
    expect(sdk.delete).toHaveBeenCalledWith(
      `/channels/${channel}/messages/${statusId}`,
      expect.anything()
    );
    sdk.post.mockResolvedValue({
      id: messageId,
      channel_id: channel,
      author: { id: founder }
    });
    await expect(
      transport.directMessages!.send({
        channelId: channel,
        recipientId: founder,
        content: "Working",
        idempotencyKey: "other-status"
      })
    ).rejects.toThrow("did not acknowledge");
    expect(sdk.delete).toHaveBeenCalledTimes(1);
  } finally {
    await transport.disconnect();
  }
});
