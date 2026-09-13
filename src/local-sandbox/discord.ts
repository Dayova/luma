import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { startServer, type RunningLumaApp } from "../app/server.js";
import type { AiUsageBudget } from "../ai/ai-usage-budget.js";
import { createDiscordLiveAudience } from "../discord/discord-live-audience.js";
import { lumaTeamPeople } from "../identity/static-identity-directory.js";

const configSchema = z.object({
  DISCORD_TOKEN: z.string().min(20),
  DISCORD_CLIENT_ID: z.string().regex(/^\d{17,20}$/u),
  DISCORD_GUILD_ID: z.string().regex(/^\d{17,20}$/u),
  LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: z.string().regex(/^\d{17,20}(,\d{17,20})*$/u)
});

/** Deliberately selects four settings, never imports the caller's production env. */
export function localDiscordEnvironment(
  raw: NodeJS.ProcessEnv,
  directory: string,
  apiKey: string
) {
  const config = configSchema.parse(raw);
  return {
    ...config,
    NODE_ENV: "development",
    LUMA_WORKSPACE_ID: "luma-local-ai",
    LUMA_DEFAULT_WORKSPACE_TIMEZONE: "Europe/Berlin",
    LUMA_PGLITE_DATA_DIR: join(directory, "discord-store"),
    LUMA_AI_MONTHLY_LIMIT_USD: "1",
    LUMA_AI_WORKFLOW_LIMIT_USD: "0.05",
    LUMA_DISCORD_DM_ENABLED: "1",
    LUMA_DISCORD_CONTEXT_ASK_ENABLED: "1",
    LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS:
      config.LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS,
    LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS: lumaTeamPeople
      .map((p) => p.discordUserId)
      .join(","),
    ...(apiKey ? { OPENAI_API_KEY: apiKey } : {})
  };
}

export function createLocalDiscord(options: {
  directory: string;
  budget: AiUsageBudget;
  readConfig?: () => Promise<NodeJS.ProcessEnv>;
  integrationEnvironment?: () => NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  startRuntime?: typeof startServer;
}) {
  const request = options.fetch ?? fetch;
  let app: RunningLumaApp | undefined;
  let problem = "Check setup before starting the development bot.";
  let ready = false;
  let aiEnabled = false;
  let channelsReady = false;
  let channels: string[] = [];
  let verifiedChannels: string[] = [];
  let blockedChannels: string[] = [];
  let activeChannels: string[] = [];
  let channelNames: Record<string, string> = {};
  let applicationId: string | null = null;
  async function configuration() {
    const raw = options.readConfig
      ? await options.readConfig()
      : parseEnv(await readFile(join(options.directory, "discord.env"), "utf8"));
    const providerEnv = options.integrationEnvironment?.() ?? {};
    const allowed = [
      "LUMA_ORGANIZATIONAL_CONTEXT_ENABLED",
      "LUMA_CONTEXT_SHARING_POLICY_PATH",
      "LUMA_CONTEXT_LINEAR_READONLY_API_KEY",
      "LUMA_CONTEXT_LINEAR_CREDENTIAL_SCOPE_ID",
      "LUMA_CONTEXT_LINEAR_TEAM_ID",
      "LUMA_CONTEXT_NOTION_READONLY_API_TOKEN",
      "LUMA_CONTEXT_NOTION_CREDENTIAL_SCOPE_ID",
      "LUMA_CONTEXT_NOTION_PAGE_IDS",
      "LUMA_GITHUB_CODE_READONLY_TOKEN",
      "LUMA_GITHUB_CODE_CREDENTIAL_SCOPE_ID",
      "LUMA_GITHUB_CODE_REPOSITORIES",
      "LINEAR_API_KEY",
      "LINEAR_TEAM_ID",
      "NOTION_API_TOKEN",
      "NOTION_MEETINGS_DATA_SOURCE_ID"
    ];
    return {
      ...Object.fromEntries(
        allowed
          .filter((key) => providerEnv[key] !== undefined)
          .map((key) => [key, providerEnv[key]])
      ),
      ...localDiscordEnvironment(raw, options.directory, "")
    };
  }
  async function verify(env: ReturnType<typeof localDiscordEnvironment>) {
    const get = async (route: string, signal: AbortSignal) => {
      const response = await request(`https://discord.com/api/v10${route}`, {
        headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` },
        signal
      });
      if (!response.ok) throw new Error("Discord lookup unavailable");
      const value: unknown = await response.json();
      return value;
    };
    verifiedChannels = [];
    blockedChannels = [];
    channelsReady = false;
    const application = z
      .object({ id: z.string(), flags: z.number().int() })
      .parse(await get("/oauth2/applications/@me", AbortSignal.timeout(15000)));
    if (application.id !== env.DISCORD_CLIENT_ID) {
      problem = "The token and application ID do not match.";
      return false;
    }
    applicationId = application.id;
    channels = env.LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS.split(",");
    if (new Set(channels).size !== channels.length) {
      problem = "Remove duplicate channel IDs from discord.env.";
      return false;
    }
    try {
      const inventory = z
        .array(z.object({ id: z.string(), name: z.string() }))
        .parse(
          await get(
            `/guilds/${env.DISCORD_GUILD_ID}/channels`,
            AbortSignal.timeout(15000)
          )
        );
      channelNames = Object.fromEntries(
        inventory.filter((c) => channels.includes(c.id)).map((c) => [c.id, c.name])
      );
    } catch {
      channelNames = {};
    }
    const label = (id: string) => (channelNames[id] ? `#${channelNames[id]}` : id);
    const missing = [];
    if (!(application.flags & ((1 << 14) | (1 << 15))))
      missing.push("Server Members Intent");

    if (missing.length) {
      problem = `Enable ${missing.join(" and ")} in the development application's Bot settings, then check again.`;
      return false;
    }
    if (!(application.flags & ((1 << 18) | (1 << 19)))) {
      problem =
        "DMs are ready. Channel questions remain off until Message Content Intent is enabled.";
      return true;
    }
    const audience = createDiscordLiveAudience({
      guildId: env.DISCORD_GUILD_ID,
      allowedParentChannelIds: channels,
      botUserId: () => application.id,
      authorizeHumanReader: (id) =>
        Promise.resolve(lumaTeamPeople.some((p) => p.discordUserId === id)),
      reader: {
        get: (route, input) =>
          get(`${route}${input.query ? `?${input.query.toString()}` : ""}`, input.signal)
      }
    });
    for (const channelId of channels) {
      if (
        await audience.resolveChannel(
          channelId,
          lumaTeamPeople.map((p) => p.discordUserId!)
        )
      ) {
        verifiedChannels.push(channelId);
      } else {
        blockedChannels.push(channelId);
      }
    }
    channelsReady = verifiedChannels.length > 0;
    problem = `DMs are ready. ${channelsReady ? `Verified channels: ${verifiedChannels.map(label).join(", ")}.` : "No channel access verified."}${blockedChannels.length ? ` Access not verified for ${blockedChannels.map(label).join(", ")}; check bot permissions and founder-only readers there. Other verified channels remain available.` : ""} Stop and start the bot to apply setup changes.`;
    return true;
  }
  async function check() {
    ready = false;
    try {
      ready = await verify(await configuration());
    } catch {
      problem =
        "Could not verify Discord setup. Check the private discord.env file, token, guild installation and network connection. This check does not start or stop the bot.";
    }
    return ready;
  }
  return {
    check,
    status() {
      return {
        connected: app?.gatewayConnected() ?? false,
        started: !!app,
        ready,
        aiEnabled,
        channelsReady,
        message: problem,
        channels,
        activeChannels,
        blockedChannels,
        channelNames,
        applicationId
      };
    },
    async start(apiKey: string) {
      if (app) return;
      // Read once, verify and launch that exact config. No credential-bearing errors escape.
      try {
        const env = await configuration();
        ready = await verify(env);
        if (!ready) return;
        app = await (options.startRuntime ?? startServer)(
          {
            ...env,
            LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: channelsReady
              ? verifiedChannels.join(",")
              : "",
            LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS: verifiedChannels.join(","),
            LUMA_DISCORD_CONTEXT_ASK_ENABLED: channelsReady ? "1" : "0",
            ...(apiKey ? { OPENAI_API_KEY: apiKey } : {})
          },
          { aiUsageBudget: options.budget }
        );
        activeChannels = [...verifiedChannels];
        aiEnabled = !!apiKey;
        const setup = problem;
        problem =
          (apiKey
            ? `Development bot running with real AI. Send it a DM without tagging it. Discord and this page share the $1 monthly allowance.${channelsReady ? " Channels are enabled." : " Channel access remains disabled."}`
            : "Development bot running. Mentioned thread questions explain the missing API key; DMs support usage and /help. Load a key here, then start again for real AI answers.") +
          (blockedChannels.length ? ` ${setup}` : "");
      } catch {
        ready = false;
        problem =
          "Discord startup failed. Check setup and protected logs. If the local Discord store was not cleanly closed, preserve it for recovery; do not delete it.";
      }
    },
    async stop() {
      if (!app) return;
      await app.stop();
      app = undefined;
      aiEnabled = false;
      activeChannels = [];
      problem = "Development bot stopped. Discord messages and local state are retained.";
    }
  };
}
