import { describe, expect, it, vi } from "vitest";
import {
  parseProductionEnvironmentFile,
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
  it("validates the shared webhook subscription and analysis configuration before opening runtime resources", async () => {
    const env = {
      ...configuration(),
      LUMA_NOTION_WEBHOOK_ENABLED: "1",
      LUMA_NOTION_WEBHOOK_WORKSPACE_ID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      LUMA_NOTION_WEBHOOK_SUBSCRIPTION_ID: "cccccccc-dddd-eeee-ffff-000000000000",
      LUMA_NOTION_WEBHOOK_INTEGRATION_ID: "dddddddd-eeee-ffff-0000-111111111111",
      LUMA_NOTION_WEBHOOK_VERIFICATION_TOKEN: "synthetic-subscription",
      NOTION_MEETINGS_DATA_SOURCE_ID: "00000000-0000-0000-0000-000000000002",
      NOTION_API_TOKEN: "synthetic-source",
      LUMA_ORGANIZATIONAL_CONTEXT_ENABLED: "1",
      LUMA_CONTEXT_SHARING_POLICY_PATH: "/etc/luma/context-sharing.json",
      LUMA_CONTEXT_NOTION_READONLY_API_TOKEN: "synthetic-reader",
      LUMA_CONTEXT_NOTION_CREDENTIAL_SCOPE_ID: "source-read",
      LUMA_CONTEXT_NOTION_PAGE_IDS: "00000000-0000-0000-0000-000000000001"
    };
    await expect(
      validateProductionEnvironment(env, "/opt/luma/releases/revision")
    ).resolves.toBeUndefined();
    for (const change of [
      { LUMA_NOTION_WEBHOOK_SUBSCRIPTION_ID: "" },
      { LUMA_NOTION_WEBHOOK_HTTP_PORT: "70000" },
      { LUMA_NOTION_WEBHOOK_HTTP_PATH: "/notion/webhook?private" },
      { LUMA_ORGANIZATIONAL_CONTEXT_ENABLED: "0" },
      { NOTION_API_TOKEN: "" },
      { LUMA_WORKSPACE_ID: env.LUMA_NOTION_WEBHOOK_WORKSPACE_ID }
    ])
      await expect(
        validateProductionEnvironment(
          { ...env, ...change },
          "/opt/luma/releases/revision"
        )
      ).rejects.toThrow();
  });
  it("allows temporarily pausing paid AI without disabling the runtime", async () => {
    await expect(
      validateProductionEnvironment(
        { ...configuration(), LUMA_AI_MONTHLY_LIMIT_USD: "0" },
        "/opt/luma/releases/revision"
      )
    ).resolves.toBeUndefined();
  });
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

  it("requires the complete consultation configuration, four mapped founders and common parent scope", async () => {
    const env = {
      ...configuration(),
      LUMA_DISCORD_CONSULTATION_ENABLED: "1",
      LUMA_DISCORD_CONSULTATION_PARENT_CHANNEL_IDS: "1507049196006408352",
      LUMA_DISCORD_CONSULTATION_ALLOWED_DISCORD_USER_IDS:
        "779381502311137301,726409024894926869,1492911575806251219,1376219174723911841",
      LUMA_DISCORD_TEAM_ROLE_ID: "500000000000000001"
    };
    await expect(
      validateProductionEnvironment(env, "/opt/luma/releases/revision")
    ).resolves.toBeUndefined();
    for (const change of [
      { LUMA_DISCORD_CONSULTATION_ALLOWED_DISCORD_USER_IDS: "779381502311137301" },
      {
        LUMA_DISCORD_CONSULTATION_ALLOWED_DISCORD_USER_IDS:
          "779381502311137301,726409024894926869,1492911575806251219,777777777777777777"
      },
      { LUMA_DISCORD_CONSULTATION_PARENT_CHANNEL_IDS: "777777777777777777" },
      { LUMA_DISCORD_TEAM_ROLE_ID: "" }
    ])
      await expect(
        validateProductionEnvironment(
          { ...env, ...change },
          "/opt/luma/releases/revision"
        )
      ).rejects.toThrow();
  });

  it("requires all four mapped founders and the common parent scope for explicit recording", async () => {
    const env = {
      ...configuration(),
      LUMA_DISCORD_DECISION_RECORDS_ENABLED: "1",
      LUMA_DISCORD_DECISION_RECORDS_PARENT_CHANNEL_IDS: "1507049196006408352",
      LUMA_DISCORD_DECISION_RECORDS_ALLOWED_DISCORD_USER_IDS:
        "779381502311137301,726409024894926869,1492911575806251219,1376219174723911841"
    };
    await expect(
      validateProductionEnvironment(env, "/opt/luma/releases/revision")
    ).resolves.toBeUndefined();
    for (const change of [
      { LUMA_DISCORD_DECISION_RECORDS_ALLOWED_DISCORD_USER_IDS: "779381502311137301" },
      {
        LUMA_DISCORD_DECISION_RECORDS_ALLOWED_DISCORD_USER_IDS:
          "779381502311137301,726409024894926869,1492911575806251219,777777777777777777"
      },
      { LUMA_DISCORD_DECISION_RECORDS_PARENT_CHANNEL_IDS: "777777777777777777" }
    ])
      await expect(
        validateProductionEnvironment(
          { ...env, ...change },
          "/opt/luma/releases/revision"
        )
      ).rejects.toThrow();
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

describe("production environment file syntax", () => {
  it("preserves literal values and permits whole-line comments and blank entries", () => {
    expect(
      parseProductionEnvironmentFile(
        "# Configuration\nTOKEN=example_only-._+/=\nEMPTY=\n\n"
      )
    ).toEqual({ TOKEN: "example_only-._+/=", EMPTY: "" });
  });

  it.each([
    'TOKEN="quoted"',
    "TOKEN=inline#comment",
    "TOKEN=two words",
    "TOKEN=escaped\\value",
    "TOKEN=$INTERPOLATION",
    "TOKEN=before\u0000after",
    "export TOKEN=value",
    "TOKEN =value",
    "TOKEN=first\nTOKEN=second"
  ])("rejects ambiguous parser syntax without exposing values", (content) => {
    expect(() => parseProductionEnvironmentFile(content)).toThrow();
  });
});

describe("production Discord application proof", () => {
  it("accepts the exact production application and rejects a mismatched token", async () => {
    const fetchApplication = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "999999999999999999", flags: 1 << 15 }))
      );
    await expect(
      verifyProductionDiscordApplication(configuration(), fetchApplication)
    ).resolves.toBeUndefined();
    fetchApplication.mockResolvedValue(
      new Response(JSON.stringify({ id: "1526147284822392952", flags: 1 << 15 }))
    );
    await expect(
      verifyProductionDiscordApplication(configuration(), fetchApplication)
    ).rejects.toThrow("production application");
  });

  it.each([0, 1 << 1, 1 << 13, 1 << 19])(
    "requires Server Members approval even with Context Ask disabled (flags %i)",
    async (flags) => {
      const env: NodeJS.ProcessEnv = {
        ...configuration(),
        LUMA_DISCORD_CONTEXT_ASK_ENABLED: "0"
      };
      const fetchApplication = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ id: env["DISCORD_CLIENT_ID"], flags }))
        );
      await expect(
        verifyProductionDiscordApplication(env, fetchApplication)
      ).rejects.toThrow("Server Members");
    }
  );

  it.each([1 << 14, 1 << 15])(
    "accepts either Discord Server Members application approval flag %i",
    async (flags) => {
      const env: NodeJS.ProcessEnv = {
        ...configuration(),
        LUMA_DISCORD_CONTEXT_ASK_ENABLED: "0"
      };
      const fetchApplication = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ id: env["DISCORD_CLIENT_ID"], flags }))
        );
      await expect(
        verifyProductionDiscordApplication(env, fetchApplication)
      ).resolves.toBeUndefined();
    }
  );

  it.each([1 << 18, 1 << 19])(
    "additionally requires Message Content approval for Context Ask (flag %i)",
    async (messageContentFlag) => {
      const env: NodeJS.ProcessEnv = {
        ...configuration(),
        LUMA_DISCORD_CONTEXT_ASK_ENABLED: "1",
        LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS: "1507049196006408352",
        LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS: "779381502311137301"
      };
      const fetchApplication = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ id: env["DISCORD_CLIENT_ID"], flags: 1 << 15 }))
        );
      await expect(
        verifyProductionDiscordApplication(env, fetchApplication)
      ).rejects.toThrow("Message Content");
      fetchApplication.mockResolvedValue(
        new Response(
          JSON.stringify({
            id: env["DISCORD_CLIENT_ID"],
            flags: (1 << 15) | messageContentFlag
          })
        )
      );
      await expect(
        verifyProductionDiscordApplication(env, fetchApplication)
      ).resolves.toBeUndefined();
    }
  );

  it.each(["DECISION_RECORDS", "CONSULTATION"])(
    "requires Message Content for enabled %s even when Ask is disabled",
    async (capability) => {
      const env = {
        ...configuration(),
        [`LUMA_DISCORD_${capability}_ENABLED`]: "1",
        [`LUMA_DISCORD_${capability}_PARENT_CHANNEL_IDS`]: "1507049196006408352",
        [`LUMA_DISCORD_${capability}_ALLOWED_DISCORD_USER_IDS`]:
          "779381502311137301,726409024894926869,1492911575806251219,1376219174723911841",
        LUMA_DISCORD_TEAM_ROLE_ID: "500000000000000001"
      };
      const read = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ id: env["DISCORD_CLIENT_ID"], flags: 1 << 15 }))
        );
      await expect(verifyProductionDiscordApplication(env, read)).rejects.toThrow(
        "Message Content"
      );
      read.mockResolvedValue(
        new Response(
          JSON.stringify({ id: env["DISCORD_CLIENT_ID"], flags: (1 << 15) | (1 << 19) })
        )
      );
      await expect(
        verifyProductionDiscordApplication(env, read)
      ).resolves.toBeUndefined();
    }
  );

  it.each([undefined, "32768", -1, 32768.5])(
    "refuses an absent or malformed application intent proof (%s)",
    async (flags) => {
      const fetchApplication = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ id: "999999999999999999", flags }))
        );
      await expect(
        verifyProductionDiscordApplication(configuration(), fetchApplication)
      ).rejects.toThrow("verification failed");
    }
  );

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
