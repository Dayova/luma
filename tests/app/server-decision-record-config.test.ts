import { describe, expect, it, vi } from "vitest";
import { startServer } from "../../src/app/server.js";

const configured = {
  DISCORD_TOKEN: "test-only",
  DISCORD_CLIENT_ID: "application",
  DISCORD_GUILD_ID: "guild",
  LUMA_WORKSPACE_ID: "workspace_dayova",
  LUMA_REASONING_MODEL_PROVIDER: "disabled",
  OPENAI_API_KEY: "test-only",
  LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: "100000000000000001",
  LUMA_DISCORD_DECISION_RECORDS_ENABLED: "1",
  LUMA_DISCORD_DECISION_RECORDS_PARENT_CHANNEL_IDS: "100000000000000001",
  LUMA_DISCORD_DECISION_RECORDS_ALLOWED_DISCORD_USER_IDS:
    "779381502311137301,726409024894926869,1492911575806251219,1376219174723911841"
};

describe("Decision Record startup scope", () => {
  it.each([
    { OPENAI_API_KEY: "" },
    { LUMA_DISCORD_DECISION_RECORDS_PARENT_CHANNEL_IDS: "100000000000000002" },
    { LUMA_DISCORD_DECISION_RECORDS_ALLOWED_DISCORD_USER_IDS: "779381502311137301" },
    {
      LUMA_DISCORD_DECISION_RECORDS_ALLOWED_DISCORD_USER_IDS:
        "779381502311137301,726409024894926869,1492911575806251219,777777777777777777"
    }
  ])("rejects invalid Decision scope before allocating resources: %j", async (change) => {
    const createDatabase = vi.fn(() => Promise.reject(new Error("must not allocate")));
    const createDiscordTransport = vi.fn(() => {
      throw new Error("must not connect");
    });
    await expect(
      startServer(
        { ...configured, ...change },
        { createDatabase, createDiscordTransport }
      )
    ).rejects.toThrow();
    expect(createDatabase).not.toHaveBeenCalled();
    expect(createDiscordTransport).not.toHaveBeenCalled();
  });
});
