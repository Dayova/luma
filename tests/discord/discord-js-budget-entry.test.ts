import { discordAudienceFixture } from "./discord-audience-fixture.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Discord from "discord.js";
import { ChannelType, Events } from "discord.js";
import { createDiscordJsTransport } from "../../src/discord/discord-js-adapter.js";
import type {
  DiscordCommand,
  DiscordCommandResponse
} from "../../src/discord/discord-meeting-bot.js";

const sdk = vi.hoisted(() => ({
  emit: (_event: string, ..._values: unknown[]): boolean => {
    void _event;
    void _values;
    return false;
  },
  put: vi.fn<(route: string, input: unknown) => Promise<void>>(() => Promise.resolve()),
  get: vi.fn(),
  destroy: vi.fn()
}));

vi.mock("discord.js", async (importOriginal) => {
  const original = await importOriginal<typeof Discord>();
  const { EventEmitter } = await import("node:events");
  return {
    ...original,
    Client: class extends EventEmitter {
      user = { id: "bot_luma" };
      rest = { get: sdk.get };
      channels = {
        fetch: (channelId: string) =>
          Promise.resolve(
            new Map([
              [
                "parent",
                {
                  id: "parent",
                  guildId: "guild",
                  type: original.ChannelType.GuildText,
                  parentId: null,
                  permissionsFor: () => ({ has: () => true })
                }
              ],
              [
                "thread",
                {
                  id: "thread",
                  guildId: "guild",
                  type: original.ChannelType.PublicThread,
                  parentId: "parent",
                  permissionsFor: () => ({ has: () => true })
                }
              ]
            ]).get(channelId) ?? null
          )
      };
      constructor() {
        super();
        sdk.emit = this.emit.bind(this);
      }
      login(): Promise<void> {
        queueMicrotask(() => this.emit(original.Events.ClientReady));
        return Promise.resolve();
      }
      destroy = sdk.destroy;
    },
    REST: class {
      setToken() {
        return this;
      }
      put = sdk.put;
    }
  };
});

beforeEach(() => {
  sdk.get.mockImplementation(discordAudienceFixture({ botId: "bot_luma" }).read);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function transport() {
  return createDiscordJsTransport({
    token: "test-token",
    clientId: "client",
    guildId: "guild",
    allowedParentChannelIds: ["parent"],
    authorizeHumanReader: (userId) => Promise.resolve(userId === "founder"),
    contextAsk: {
      parentChannelIds: ["parent"],
      allowedDiscordUserIds: ["founder"],
      maxMessages: 50,
      maxEvidenceChars: 32000,
      minIntervalMs: 60000
    }
  });
}

function message(id: string) {
  return {
    id,
    guildId: "guild",
    channelId: "thread",
    author: { id: "founder", bot: false },
    system: false,
    webhookId: null,
    mentions: { users: new Map([["bot_luma", {}]]) },
    content: "<@bot_luma> usage",
    createdAt: new Date("2026-09-08T12:00:00Z"),
    channel: {
      isThread: () => true,
      parentId: "parent",
      type: ChannelType.PublicThread,
      isSendable: () => true
    },
    reply: vi.fn(() => Promise.resolve())
  };
}

describe("Discord SDK budget entry points", () => {
  it("registers and routes /meeting usage as a deterministic command", async () => {
    const live = transport();
    const handler = vi.fn<(command: DiscordCommand) => Promise<DiscordCommandResponse>>(
      () => Promise.resolve({ content: "Estimated spend: $2.50 / $30.00" })
    );
    await live.connect(handler);
    const interaction = {
      isChatInputCommand: () => true,
      commandName: "meeting",
      inGuild: () => true,
      guildId: "guild",
      id: "interaction",
      channelId: "parent",
      user: { id: "founder" },
      createdAt: new Date("2026-09-08T12:00:00Z"),
      options: { getSubcommand: () => "usage" },
      deferReply: vi.fn(() => Promise.resolve()),
      editReply: vi.fn(() => Promise.resolve())
    };
    sdk.emit(Events.InteractionCreate, interaction);
    await expect.poll(() => interaction.editReply.mock.calls.length).toBe(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "usage", actorDiscordUserId: "founder" })
    );
    expect(JSON.stringify(sdk.put.mock.calls[0]?.[1])).toContain('"name":"usage"');
    await live.disconnect();
  });

  it("passes consecutive eligible mentions to the admitted handler so it can explain cooldown or show status", async () => {
    const live = transport();
    const handler = vi.fn(() =>
      Promise.resolve({ content: "Usage available without AI", idempotencyKey: "status" })
    );
    await live.connect(() => Promise.resolve({ content: "unused" }), handler);
    const first = message("one");
    const second = message("two");
    sdk.emit(Events.MessageCreate, first);
    sdk.emit(Events.MessageCreate, second);
    await expect.poll(() => second.reply.mock.calls.length).toBe(1);
    expect(first.reply).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(second.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedMentions: { parse: [], repliedUser: false },
        enforceNonce: true
      })
    );
    await live.disconnect();
  });

  it("does not turn an ambiguous Discord send into a second contradictory fallback reply", async () => {
    const operationalLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const live = transport();
    await live.connect(
      () => Promise.resolve({ content: "unused" }),
      () =>
        Promise.resolve({ content: "Monthly budget reached", idempotencyKey: "budget" })
    );
    const candidate = message("one");
    candidate.reply.mockRejectedValue(new Error("Discord send outcome unknown"));
    sdk.emit(Events.MessageCreate, candidate);
    await expect.poll(() => candidate.reply.mock.calls.length).toBe(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(candidate.reply).toHaveBeenCalledOnce();
    expect(operationalLog).toHaveBeenCalledWith("Luma Discord delivery failed", {
      code: "discord-context-ask-reply-failed",
      channelId: "thread",
      sourceId: "one"
    });
    expect(JSON.stringify(operationalLog.mock.calls)).not.toContain("outcome unknown");
    await live.disconnect();
  });
});
