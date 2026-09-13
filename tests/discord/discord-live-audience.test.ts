import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelType, PermissionFlagsBits, Routes } from "discord.js";
import { createDiscordLiveAudience } from "../../src/discord/discord-live-audience.js";
import { discordAudienceFixture } from "./discord-audience-fixture.js";

function setup() {
  const fixture = discordAudienceFixture();
  const get = vi.fn(fixture.read);
  const proof = createDiscordLiveAudience({
    reader: { get },
    guildId: "guild",
    allowedParentChannelIds: ["parent"],
    botUserId: () => "bot",
    authorizeHumanReader: (userId) => Promise.resolve(userId === "founder")
  });
  return { ...fixture, get, proof };
}

afterEach(() => vi.useRealTimers());

describe("fresh founder-only Discord audiences", () => {
  it("permits founders and bots, without granting a guest role access or requiring history for new readers", async () => {
    const { state, proof } = setup();
    state.members.push({ user: { id: "guest-person", bot: false }, roles: ["guest"] });
    expect(await proof.isFounderOnly("thread")).toBe(true);
    state.overwrites.push({
      id: "guest",
      type: 0,
      allow: String(PermissionFlagsBits.ViewChannel),
      deny: "0"
    });
    expect(await proof.isFounderOnly("thread")).toBe(false);
    state.overwrites = [];
    expect(await proof.isFounderOnly("thread")).toBe(true);
  });

  it.each(["everyone", "role", "member", "administrator", "owner"])(
    "denies a new human reader through %s even with the same channel IDs",
    async (grant) => {
      const { state, proof } = setup();
      expect(await proof.isFounderOnly("thread")).toBe(true);
      state.members.push({
        user: { id: "outsider", bot: false },
        roles: [grant === "administrator" ? "admin" : "guest"]
      });
      if (grant === "owner") state.ownerId = "outsider";
      else if (grant !== "administrator")
        state.overwrites.push({
          id: grant === "everyone" ? "guild" : grant === "role" ? "guest" : "outsider",
          type: grant === "member" ? 1 : 0,
          allow: String(PermissionFlagsBits.ViewChannel),
          deny: "0"
        });
      // A personal deny cannot fence an owner or Administrator.
      if (grant === "owner" || grant === "administrator")
        state.overwrites.push({
          id: "outsider",
          type: 1,
          allow: "0",
          deny: String(PermissionFlagsBits.ViewChannel)
        });
      expect(await proof.isFounderOnly("parent")).toBe(false);
      expect(await proof.isFounderOnly("thread")).toBe(false);
    }
  );

  it("applies everyone, combined role, then personal overwrites in Discord order", async () => {
    const { state, proof } = setup();
    state.members.push({
      user: { id: "outsider", bot: false },
      roles: ["guest", "team"]
    });
    state.overwrites.push(
      { id: "bots", type: 0, allow: String(PermissionFlagsBits.ViewChannel), deny: "0" },
      { id: "guild", type: 0, allow: "0", deny: String(PermissionFlagsBits.ViewChannel) },
      { id: "guest", type: 0, allow: "0", deny: String(PermissionFlagsBits.ViewChannel) },
      { id: "team", type: 0, allow: String(PermissionFlagsBits.ViewChannel), deny: "0" }
    );
    expect(await proof.isFounderOnly("thread")).toBe(false);
    state.overwrites.push({
      id: "outsider",
      type: 1,
      allow: "0",
      deny: String(PermissionFlagsBits.ViewChannel)
    });
    expect(await proof.isFounderOnly("thread")).toBe(true);
  });

  it("requires the bot's current raw permissions instead of an old SDK member cache", async () => {
    const { state, proof } = setup();
    expect(await proof.resolveChannel("thread")).not.toBeNull();
    state.overwrites.push({
      id: "bot",
      type: 1,
      allow: "0",
      deny: String(PermissionFlagsBits.ViewChannel)
    });
    expect(await proof.resolveChannel("thread")).toBeNull();
  });

  it("never uses private membership as an exception to the supported public-thread boundary", async () => {
    const { state, proof } = setup();
    state.channelType = ChannelType.PrivateThread;
    expect(await proof.isFounderOnly("thread")).toBe(false);
  });

  it.each([
    "missing-owner",
    "unknown-role",
    "duplicate-member",
    "full-page",
    "missing-overwrites",
    "unavailable"
  ])("rejects an incomplete or unprovable audience: %s", async (problem) => {
    const { state, get, proof, read } = setup();
    if (problem === "missing-owner") state.ownerId = "missing";
    if (problem === "unknown-role") state.members[0]?.roles.push("missing");
    if (problem === "duplicate-member")
      state.members.push({ user: { id: "founder", bot: false }, roles: ["team"] });
    if (problem === "full-page")
      state.members = Array.from({ length: 1000 }, (_, index) => ({
        user: { id: String(index), bot: true },
        roles: ["bots"]
      }));
    if (problem === "unavailable")
      get.mockRejectedValue(new Error("Privileged intent missing"));
    if (problem === "missing-overwrites")
      get.mockImplementation((route, options) =>
        route === Routes.channel("parent")
          ? Promise.resolve({
              id: "parent",
              guild_id: "guild",
              type: ChannelType.GuildText
            })
          : read(route, options)
      );
    expect(await proof.isFounderOnly("thread")).toBe(false);
  });

  it("refuses a mixed snapshot if a member becomes an administrator while the proof is assembled", async () => {
    const { state, proof, get, read } = setup();
    state.members.push({ user: { id: "outsider", bot: false }, roles: ["guest"] });
    let memberReads = 0;
    get.mockImplementation((route, options) => {
      if (route === Routes.guildMembers("guild") && ++memberReads === 2)
        state.members[2]?.roles.push("admin");
      return read(route, options);
    });
    expect(await proof.isFounderOnly("thread")).toBe(false);
  });

  it("bounds a rate-limit wait and consumes its late failure without admitting a send", async () => {
    vi.useFakeTimers();
    const { proof, get } = setup();
    let reject: (error: Error) => void = () => undefined;
    get.mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        })
    );
    const pending = proof.isFounderOnly("thread");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBe(false);
    reject(new Error("Late REST abort"));
    await Promise.resolve();
    expect(get.mock.calls.every(([, options]) => options.signal.aborted)).toBe(true);
  });
});
