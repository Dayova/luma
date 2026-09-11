import { describe, expect, it, vi } from "vitest";
import { startServer } from "../../src/app/server.js";

const configured = {
  DISCORD_TOKEN: "test-only",
  DISCORD_CLIENT_ID: "application",
  DISCORD_GUILD_ID: "guild",
  LUMA_WORKSPACE_ID: "workspace_dayova",
  LUMA_REASONING_MODEL_PROVIDER: "disabled",
  OPENAI_API_KEY: "test-only",
  LUMA_DECISION_RECORDS_DATA_SOURCE_ID: "3d52e872-28bf-80ae-befe-d1c0e2c39df5",
  LUMA_DECISION_RECORDS_CREDENTIAL_SCOPE_ID: "decisions-write",
  LUMA_DECISION_RECORDS_SIGNING_KEY: "test-only-signing-key-longer-than-32-bytes",
  LUMA_DECISION_RECORDS_NOTION_API_TOKEN: "test-only-write",
  LUMA_DECISION_AUTHORITY_POLICY_PATH: "/protected/authority.json",
  LUMA_CONTEXT_SHARING_POLICY_PATH: "/protected/sharing.json",
  LUMA_CONTEXT_NOTION_READONLY_API_TOKEN: "test-only-read",
  LUMA_CONTEXT_NOTION_CREDENTIAL_SCOPE_ID: "authority-read",
  LUMA_CONTEXT_NOTION_PAGE_IDS: "3bc2e872-28bf-8193-9669-ec8c5a94aae3",
  LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: "100000000000000001",
  LUMA_DISCORD_DECISION_RECORDS_ENABLED: "1",
  LUMA_DISCORD_DECISION_RECORDS_PARENT_CHANNEL_IDS: "100000000000000001",
  LUMA_DISCORD_DECISION_RECORDS_ALLOWED_DISCORD_USER_IDS:
    "779381502311137301,726409024894926869,1492911575806251219,1376219174723911841"
};

describe("Decision Record startup scope", () => {
  it.each([
    { OPENAI_API_KEY: "" },
    { LUMA_DECISION_RECORDS_DATA_SOURCE_ID: "not-a-uuid" },
    { LUMA_DECISION_RECORDS_CREDENTIAL_SCOPE_ID: "" },
    { LUMA_DECISION_RECORDS_SIGNING_KEY: "too-short" },
    { LUMA_DECISION_RECORDS_NOTION_API_TOKEN: "" },
    { LUMA_DECISION_AUTHORITY_POLICY_PATH: "relative.json" },
    { LUMA_CONTEXT_SHARING_POLICY_PATH: "" },
    { LUMA_CONTEXT_NOTION_READONLY_API_TOKEN: "" },
    { LUMA_CONTEXT_NOTION_CREDENTIAL_SCOPE_ID: "" },
    { LUMA_CONTEXT_NOTION_PAGE_IDS: "not-a-page" },
    {
      LUMA_CONTEXT_NOTION_PAGE_IDS:
        "3bc2e872-28bf-8193-9669-ec8c5a94aae3,3bc2e87228bf81939669ec8c5a94aae3"
    },
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
