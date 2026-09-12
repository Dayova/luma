import { describe, expect, it } from "vitest";
import {
  createLocalDiscord,
  localDiscordEnvironment
} from "../../src/local-sandbox/discord.js";
import { createAiUsageBudget } from "../../src/ai/ai-usage-budget.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { lumaTeamPeople } from "../../src/identity/static-identity-directory.js";

const guild = "1086939783374315530";
const bot = "1526147284822392952";
const parent = "1519252320343425135";
const team = "1507048253206564884";
const env = {
  DISCORD_TOKEN: "fake-development-token",
  DISCORD_CLIENT_ID: bot,
  DISCORD_GUILD_ID: guild,
  LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: parent
};
const founders = lumaTeamPeople.map((p) => ({
  user: { id: p.discordUserId!, bot: false },
  roles: [team]
}));
function api(flags: number, guest = false): typeof fetch {
  return (input) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url
    );
    const route = url.pathname.replace("/api/v10", "");
    const data =
      route === "/oauth2/applications/@me"
        ? { id: bot, flags }
        : route === `/guilds/${guild}`
          ? { id: guild, owner_id: founders[0]!.user.id }
          : route.endsWith("/roles")
            ? [
                { id: guild, permissions: "0" },
                { id: team, permissions: "0" }
              ]
            : route.endsWith("/members")
              ? [
                  ...founders,
                  { user: { id: bot, bot: true }, roles: [team] },
                  ...(guest
                    ? [{ user: { id: "999999999999999999", bot: false }, roles: [team] }]
                    : [])
                ]
              : {
                  id: parent,
                  guild_id: guild,
                  type: 0,
                  permission_overwrites: [{ id: team, type: 0, allow: "1024", deny: "0" }]
                };
    return Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));
  };
}

describe("local Discord testing", () => {
  it("isolates the runtime from unrelated production credentials and activation flags", () => {
    const config = localDiscordEnvironment(
      {
        ...env,
        LINEAR_API_KEY: "never-inherit",
        NOTION_API_TOKEN: "never-inherit",
        LUMA_AUTOMATIC_DECISIONS_ENABLED: "1",
        LUMA_PGLITE_DATA_DIR: "/production",
        OPENAI_API_KEY: "never-inherit"
      },
      "/local",
      "explicit-memory-key"
    );
    expect(config).toMatchObject({
      OPENAI_API_KEY: "explicit-memory-key",
      LUMA_WORKSPACE_ID: "luma-local-ai",
      LUMA_PGLITE_DATA_DIR: "/local/discord-store",
      LUMA_AI_MONTHLY_LIMIT_USD: "1"
    });
    expect(JSON.stringify(config)).not.toContain("never-inherit");
    expect(config).not.toHaveProperty("LUMA_AUTOMATIC_DECISIONS_ENABLED");
  });
  it("reports missing Discord intents without starting or spending", async () => {
    const database = await createPgliteDatabase();
    const budget = createAiUsageBudget({ database, monthlyLimitUsd: 1 });
    try {
      const discord = createLocalDiscord({
        directory: "/local",
        budget,
        readConfig: () => Promise.resolve(env),
        fetch: api(0),
        startRuntime: () => {
          throw new Error("Must not start");
        }
      });
      await discord.start("secret");
      expect(discord.status()).toMatchObject({
        started: false,
        ready: false,
        message: expect.stringContaining("Server Members Intent") as unknown
      });
      expect((await budget.getStatus("luma-local-ai")).requestCount).toBe(0);
      expect(JSON.stringify(discord.status())).not.toContain("secret");
    } finally {
      await database.close();
    }
  });
  it("refuses a channel containing an additional human reader", async () => {
    const database = await createPgliteDatabase();
    try {
      const discord = createLocalDiscord({
        directory: "/local",
        budget: createAiUsageBudget({ database }),
        readConfig: () => Promise.resolve(env),
        fetch: api((1 << 15) | (1 << 19), true),
        startRuntime: () => {
          throw new Error("Must not start");
        }
      });
      await discord.start("secret");
      expect(discord.status()).toMatchObject({
        started: false,
        ready: false,
        message: expect.stringContaining("Cannot verify founder-only") as unknown
      });
    } finally {
      await database.close();
    }
  });
  it("starts the real runtime composition with the same budget and stops it cleanly", async () => {
    const database = await createPgliteDatabase();
    const budget = createAiUsageBudget({ database, monthlyLimitUsd: 1 });
    let connected = false;
    try {
      const discord = createLocalDiscord({
        directory: "/local",
        budget,
        readConfig: () => Promise.resolve(env),
        fetch: api((1 << 15) | (1 << 19)),
        startRuntime: (config, dependencies) => {
          expect(config?.["OPENAI_API_KEY"]).toBe("memory-key");
          expect(dependencies?.aiUsageBudget).toBe(budget);
          connected = true;
          return Promise.resolve({
            gatewayConnected: () => connected,
            stop: () => {
              connected = false;
              return Promise.resolve();
            }
          });
        }
      });
      await discord.start("memory-key");
      expect(discord.status()).toMatchObject({
        started: true,
        connected: true,
        aiEnabled: true
      });
      await discord.stop();
      expect(discord.status()).toMatchObject({
        started: false,
        connected: false,
        aiEnabled: false
      });
      expect(connected).toBe(false);
    } finally {
      await database.close();
    }
  });
});
