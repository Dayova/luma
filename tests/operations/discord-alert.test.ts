import { ChannelType, PermissionFlagsBits } from "discord.js";
import { describe, expect, it } from "vitest";
import { sendOperationsDiscordAlert } from "../../src/operations/discord-alert.js";
import { lumaTeamPeople } from "../../src/identity/static-identity-directory.js";
import { deliverHealthStatus } from "../../src/operations/health-monitor.js";

const guildId = "1086939783374315530";
const channelId = "1507049196006408352";
const secondChannelId = "1519252320343425135";
const applicationId = "123456789012345678";
const webhookId = "223456789012345678";
const webhookUrl = `https://discord.com/api/webhooks/${webhookId}/test-private-webhook-token`;
const botToken = "test-private-bot-token";

function fixture() {
  const state = {
    applicationId,
    binding: { id: webhookId, type: 1, guild_id: guildId, channel_id: channelId },
    members: [
      ...lumaTeamPeople.map((person) => ({
        user: { id: person.discordUserId!, bot: false },
        roles: ["team"]
      })),
      { user: { id: applicationId, bot: true }, roles: ["bots"] }
    ],
    failRead: false,
    onBindingRead: (_count: number) => {
      void _count;
    }
  };
  const posts: { content: string; allowed_mentions: { parse: string[] } }[] = [];
  let bindingReads = 0;
  const fetch: typeof globalThis.fetch = (resource, init) => {
    const url = new URL(
      typeof resource === "string"
        ? resource
        : resource instanceof URL
          ? resource.href
          : resource.url
    );
    if (url.origin !== "https://discord.com")
      return Promise.reject(new Error("Unexpected external origin"));
    if (init?.method === "POST") {
      expect(url.href).toBe(`${webhookUrl}?wait=true`);
      expect(init.headers).not.toHaveProperty("Authorization");
      if (typeof init.body !== "string") throw new Error("Expected serialized alert");
      posts.push(JSON.parse(init.body) as (typeof posts)[number]);
      return Promise.resolve(Response.json({ id: "sent" }));
    }
    if (state.failRead) return Promise.reject(new Error(`${webhookUrl} ${botToken}`));
    let data: unknown;
    if (url.href === webhookUrl) {
      expect(init?.headers).toBeUndefined();
      state.onBindingRead(++bindingReads);
      data = structuredClone(state.binding);
    } else {
      expect(init?.headers).toEqual({ Authorization: `Bot ${botToken}` });
      if (url.pathname === "/api/v10/oauth2/applications/@me")
        data = { id: state.applicationId };
      else if (url.pathname === "/api/v10/users/@me")
        data = { id: applicationId, bot: true };
      else if (url.pathname === `/api/v10/guilds/${guildId}`)
        data = { id: guildId, owner_id: "779381502311137301" };
      else if (url.pathname === `/api/v10/guilds/${guildId}/roles`)
        data = [
          { id: guildId, permissions: "0" },
          { id: "team", permissions: String(PermissionFlagsBits.ViewChannel) },
          { id: "bots", permissions: String(PermissionFlagsBits.ViewChannel) },
          { id: "administrator", permissions: String(PermissionFlagsBits.Administrator) }
        ];
      else if (url.pathname === `/api/v10/guilds/${guildId}/members`) {
        expect(url.searchParams.get("limit")).toBe("1000");
        data = structuredClone(state.members);
      } else if (url.pathname.startsWith("/api/v10/channels/"))
        data = {
          id: url.pathname.split("/").at(-1),
          guild_id: guildId,
          type: ChannelType.GuildText,
          parent_id: null,
          permission_overwrites: []
        };
      else return Promise.reject(new Error("Unexpected API endpoint"));
    }
    return Promise.resolve(Response.json(data));
  };
  const runtimeEnv: NodeJS.ProcessEnv = {
    LUMA_WORKSPACE_ID: "workspace_dayova",
    DISCORD_GUILD_ID: guildId,
    DISCORD_CLIENT_ID: applicationId,
    DISCORD_TOKEN: botToken,
    LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: `${channelId},${secondChannelId}`
  };
  const send = () =>
    sendOperationsDiscordAlert({
      webhookUrl,
      runtimeEnv,
      message: "Luma is unavailable.",
      fetch
    });
  return { state, posts, runtimeEnv, send, fetch };
}

describe("founder-only operational Discord alerts", () => {
  it("binds the authenticated production app and actual webhook destination to a fresh founder-only audience", async () => {
    const input = fixture();
    await input.send();
    expect(input.posts).toEqual([
      { content: "Luma is unavailable.", allowed_mentions: { parse: [] } }
    ]);
    input.state.members.push({
      user: { id: "323456789012345678", bot: false },
      roles: ["administrator"]
    });
    await expect(input.send()).rejects.toThrow("founder-only destination");
    expect(input.posts).toHaveLength(1);
  });

  it.each(["guild", "channel", "id", "application"])(
    "refuses a mismatched actual %s binding before posting",
    async (mismatch) => {
      const input = fixture();
      if (mismatch === "guild") input.state.binding.guild_id = "423456789012345678";
      if (mismatch === "channel") input.state.binding.channel_id = "423456789012345678";
      if (mismatch === "id") input.state.binding.id = "423456789012345678";
      if (mismatch === "application") input.state.applicationId = "423456789012345678";
      await expect(input.send()).rejects.toThrow("founder-only destination");
      expect(input.posts).toEqual([]);
    }
  );

  it("does not follow a webhook moved to another channel during verification", async () => {
    const input = fixture();
    input.state.onBindingRead = (count) => {
      if (count === 2) input.state.binding.channel_id = secondChannelId;
    };
    await expect(input.send()).rejects.toThrow("founder-only destination");
    expect(input.posts).toEqual([]);
  });

  it("rechecks live readers after the final webhook lookup", async () => {
    const input = fixture();
    input.state.onBindingRead = (count) => {
      if (count === 2)
        input.state.members.push({
          user: { id: "323456789012345678", bot: false },
          roles: ["administrator"]
        });
    };
    await expect(input.send()).rejects.toThrow("founder-only destination");
    expect(input.posts).toEqual([]);
  });

  it("refuses ambiguous founder identities and incomplete member inventories", async () => {
    const ambiguous = fixture();
    const fabius = lumaTeamPeople.find((person) => person.personId === "person_fabius")!;
    ambiguous.runtimeEnv["LUMA_IDENTITY_PEOPLE_JSON"] = JSON.stringify([
      { ...fabius, discordUserId: "779381502311137301" }
    ]);
    await expect(ambiguous.send()).rejects.toThrow("founder-only destination");
    expect(ambiguous.posts).toEqual([]);
    const incomplete = fixture();
    while (incomplete.state.members.length < 1000)
      incomplete.state.members.push({
        user: {
          id: String(500000000000000000n + BigInt(incomplete.state.members.length)),
          bot: true
        },
        roles: ["bots"]
      });
    await expect(incomplete.send()).rejects.toThrow("founder-only destination");
    expect(incomplete.posts).toEqual([]);
  });

  it("redacts read failures and leaves alerts retryable without renewing the outside heartbeat", async () => {
    const input = fixture();
    input.state.failRead = true;
    let recorded = false;
    let pinged = false;
    const error = await input.send().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(botToken);
    expect(String(error)).not.toContain("test-private-webhook-token");
    await expect(
      deliverHealthStatus({
        problems: ["runtime-unavailable"],
        previous: null,
        now: new Date(),
        send: () => input.send(),
        record: () => {
          recorded = true;
          return Promise.resolve();
        },
        heartbeat: () => {
          pinged = true;
          return Promise.resolve();
        }
      })
    ).rejects.toThrow();
    expect(input.posts).toEqual([]);
    expect(recorded).toBe(false);
    expect(pinged).toBe(false);
    input.state.failRead = false;
    await input.send();
    expect(input.posts).toHaveLength(1);
  });
});
