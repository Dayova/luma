import { describe, expect, it, vi } from "vitest";
import { startServer } from "../../src/app/server.js";
import { discordAllowedParentChannelIdsFromEnv } from "../../src/discord/discord-channel-scope.js";

const parent = "100000000000000001";
const otherParent = "100000000000000002";

describe("shared Discord channel scope configuration", () => {
  it("uses stable IDs and defaults to no permitted channels", () => {
    expect(discordAllowedParentChannelIdsFromEnv({})).toEqual([]);
    expect(
      discordAllowedParentChannelIdsFromEnv({
        LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: "  "
      })
    ).toEqual([]);
    expect(
      discordAllowedParentChannelIdsFromEnv({
        LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: ` ${parent}, ${otherParent} `
      })
    ).toEqual([parent, otherParent]);
  });

  it.each([
    "team-chat",
    "123",
    `${parent},`,
    `,${parent}`,
    `${parent},${parent}`,
    `${parent}, ${parent}`,
    "100000000000000000000",
    "000000000000000001"
  ])("rejects malformed or ambiguous scope %s", (value) => {
    expect(() =>
      discordAllowedParentChannelIdsFromEnv({
        LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: value
      })
    ).toThrow("unique comma-separated Discord channel IDs");
  });

  it.each([
    { LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: "team-chat" },
    { LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: `${parent},${parent}` },
    {
      LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: parent,
      LUMA_DISCORD_CONTEXT_ASK_ENABLED: "1",
      LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS: otherParent,
      LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS: "779381502311137301"
    },
    {
      LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: "",
      LUMA_DISCORD_CONTEXT_ASK_ENABLED: "1",
      LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS: parent,
      LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS: "779381502311137301"
    }
  ])("fails unsafe composition before allocating resources", async (scope) => {
    const createDatabase = vi.fn(() =>
      Promise.reject(new Error("database allocation reached"))
    );
    const createDiscordTransport = vi.fn(() => {
      throw new Error("transport allocation reached");
    });
    await expect(
      startServer(
        {
          DISCORD_TOKEN: "test-only",
          DISCORD_CLIENT_ID: "application",
          DISCORD_GUILD_ID: "guild",
          OPENAI_API_KEY: "test-only",
          ...scope
        },
        { createDatabase, createDiscordTransport }
      )
    ).rejects.toThrow(/Discord channel IDs|must be within/u);
    expect(createDatabase).not.toHaveBeenCalled();
    expect(createDiscordTransport).not.toHaveBeenCalled();
  });
});
