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
  fetch?: typeof fetch;
  startRuntime?: typeof startServer;
}) {
  const request = options.fetch ?? fetch;
  let app: RunningLumaApp | undefined;
  let problem = "Check setup before starting the development bot.";
  let ready = false;
  let aiEnabled = false;
  let channels: string[] = [];
  let applicationId: string | null = null;
  async function configuration() {
    const raw = options.readConfig
      ? await options.readConfig()
      : parseEnv(await readFile(join(options.directory, "discord.env"), "utf8"));
    return localDiscordEnvironment(raw, options.directory, "");
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
    const missing = [];
    if (!(application.flags & ((1 << 14) | (1 << 15))))
      missing.push("Server Members Intent");
    if (!(application.flags & ((1 << 18) | (1 << 19))))
      missing.push("Message Content Intent");
    if (missing.length) {
      problem = `Enable ${missing.join(" and ")} in the development application's Bot settings, then check again.`;
      return false;
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
        !(await audience.resolveChannel(
          channelId,
          lumaTeamPeople.map((p) => p.discordUserId!)
        ))
      ) {
        problem = `Cannot verify founder-only access and bot permissions for channel ${channelId}. Give the development bot View Channel, Send Messages, Read Message History, Create Public Threads and Send Messages in Threads there. All four founders must have access; other human readers are refused.`;
        return false;
      }
    }
    problem =
      "Setup verified. Start the bot, then use /meeting start in the configured channel.";
    return true;
  }
  async function check() {
    ready = false;
    try {
      ready = await verify(await configuration());
    } catch {
      problem =
        "Could not verify Discord setup. Check the private discord.env file, token, guild installation and network connection. No bot was started.";
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
        message: problem,
        channels,
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
            LUMA_DISCORD_CONTEXT_ASK_ENABLED: apiKey ? "1" : "0",
            ...(apiKey ? { OPENAI_API_KEY: apiKey } : {})
          },
          { aiUsageBudget: options.budget }
        );
        aiEnabled = !!apiKey;
        problem = apiKey
          ? "Development bot running with real AI. Discord and this page share the $1 monthly allowance."
          : "Development bot running without AI. Notes are retained and analysis is deferred. Load an API key, then start again for real answers.";
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
      problem = "Development bot stopped. Discord messages and local state are retained.";
    }
  };
}
