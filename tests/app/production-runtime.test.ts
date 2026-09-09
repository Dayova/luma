import { describe, expect, it, vi } from "vitest";
import {
  validateProductionEnvironment,
  verifyProductionDiscordApplication
} from "../../src/app/production-runtime.js";

function configuration(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    LUMA_WORKSPACE_ID: "workspace_dayova",
    LUMA_PGLITE_DATA_DIR: "/var/lib/luma/pglite",
    DISCORD_TOKEN: "test-only-private-token",
    DISCORD_CLIENT_ID: "999999999999999999",
    DISCORD_GUILD_ID: "1086939783374315530",
    LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: "1507049196006408352",
    OPENAI_API_KEY: "test-only-private-ai-key"
  };
}

describe("production deployment preflight", () => {
  it("accepts a future explicitly configured channel without opening any store", async () => {
    const env = configuration();
    env["LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS"] = "888888888888888888";
    await expect(
      validateProductionEnvironment(env, "/opt/luma/releases/revision")
    ).resolves.toBeUndefined();
  });

  it.each([
    { NODE_ENV: "development" },
    { LUMA_PGLITE_DATA_DIR: ".luma/pglite" },
    { LUMA_PGLITE_DATA_DIR: "/tmp/luma/pglite" },
    { LUMA_PGLITE_DATA_DIR: "/opt/luma/releases/revision/data" },
    { DISCORD_CLIENT_ID: "1526147284822392952" },
    { LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: "" },
    { OPENAI_API_KEY: "" },
    { LUMA_AI_MONTHLY_LIMIT_USD: "31" },
    { LUMA_AI_BUDGET_TIMEZONE: "UTC" },
    { LUMA_NOTION_OBSERVATION_READONLY_API_TOKEN: "test-only-observer-token" }
  ])("rejects unsafe deployment configuration %j", async (change) => {
    await expect(
      validateProductionEnvironment(
        { ...configuration(), ...change },
        "/opt/luma/releases/revision"
      )
    ).rejects.toThrow();
  });

  it("rejects an out-of-scope Context Ask parent and a nonfounder", async () => {
    const env: NodeJS.ProcessEnv = {
      ...configuration(),
      LUMA_DISCORD_CONTEXT_ASK_ENABLED: "1",
      LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS: "888888888888888888",
      LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS: "779381502311137301"
    };
    await expect(
      validateProductionEnvironment(env, "/opt/luma/releases/revision")
    ).rejects.toThrow("within");
    env["LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS"] = "1507049196006408352";
    env["LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS"] = "777777777777777777";
    await expect(
      validateProductionEnvironment(env, "/opt/luma/releases/revision")
    ).rejects.toThrow("founder");
  });

  it("does not disclose malformed identity configuration", async () => {
    const secret = "sensitive-config-value";
    const error = await validateProductionEnvironment(
      { ...configuration(), LUMA_IDENTITY_PEOPLE_JSON: secret },
      "/opt/luma/releases/revision"
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(secret);
  });
});

describe("production Discord application proof", () => {
  it("accepts the exact production application and rejects a mismatched token", async () => {
    const fetchApplication = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "999999999999999999", flags: 0 }))
      );
    await expect(
      verifyProductionDiscordApplication(configuration(), fetchApplication)
    ).resolves.toBeUndefined();
    fetchApplication.mockResolvedValue(
      new Response(JSON.stringify({ id: "1526147284822392952", flags: 0 }))
    );
    await expect(
      verifyProductionDiscordApplication(configuration(), fetchApplication)
    ).rejects.toThrow("production application");
  });

  it("requires Message Content intent when bounded Context Ask is enabled", async () => {
    const env: NodeJS.ProcessEnv = {
      ...configuration(),
      LUMA_DISCORD_CONTEXT_ASK_ENABLED: "1",
      LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS: "1507049196006408352",
      LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS: "779381502311137301"
    };
    const fetchApplication = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: env["DISCORD_CLIENT_ID"], flags: 0 }))
      );
    await expect(
      verifyProductionDiscordApplication(env, fetchApplication)
    ).rejects.toThrow("Message Content");
    fetchApplication.mockResolvedValue(
      new Response(JSON.stringify({ id: env["DISCORD_CLIENT_ID"], flags: 1 << 19 }))
    );
    await expect(
      verifyProductionDiscordApplication(env, fetchApplication)
    ).resolves.toBeUndefined();
  });

  it("does not print provider failures or supplied credentials", async () => {
    const fetchApplication = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("test-only-private-token"));
    const error = await verifyProductionDiscordApplication(
      configuration(),
      fetchApplication
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("test-only-private-token");
  });
});
