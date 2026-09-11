import { z } from "zod";
import { createDiscordLiveAudience } from "../discord/discord-live-audience.js";
import { discordAllowedParentChannelIdsFromEnv } from "../discord/discord-channel-scope.js";
import { createWorkspaceAccessPolicy } from "../access/workspace-access-policy.js";
import { createIdentityDirectoryFromEnv } from "../identity/static-identity-directory.js";
import { dayovaFounderPersonIds } from "../app/founder-access.js";

const id = z.string().regex(/^\d{17,20}$/u);
const webhookSchema = z.object({
  id,
  type: z.literal(1),
  guild_id: id,
  channel_id: id
});

export const operationsWebhookUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "discord.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]+$/u.test(url.pathname)
    );
  });

/** Even fixed availability notices obey the current four-founder audience.
 * This uses bounded raw REST reads, never a second Gateway client or SDK cache. */
export async function sendOperationsDiscordAlert(input: {
  webhookUrl: string;
  runtimeEnv: NodeJS.ProcessEnv;
  message: string;
  fetch?: typeof fetch;
}): Promise<void> {
  try {
    const webhookUrl = operationsWebhookUrlSchema.parse(input.webhookUrl);
    const webhookId = new URL(webhookUrl).pathname.split("/")[3];
    const guildId = id.parse(input.runtimeEnv["DISCORD_GUILD_ID"]);
    const applicationId = id.parse(input.runtimeEnv["DISCORD_CLIENT_ID"]);
    const token = z.string().min(1).parse(input.runtimeEnv["DISCORD_TOKEN"]);
    const workspaceId = z.string().min(1).parse(input.runtimeEnv["LUMA_WORKSPACE_ID"]);
    const allowedParentChannelIds = discordAllowedParentChannelIdsFromEnv(
      input.runtimeEnv
    );
    const access = createWorkspaceAccessPolicy({
      workspaceId,
      authorizedPersonIds: dayovaFounderPersonIds,
      identityDirectory: createIdentityDirectoryFromEnv(input.runtimeEnv)
    });
    const message = z.string().min(1).max(2_000).parse(input.message);
    const request = input.fetch ?? fetch;
    const lifetime = AbortSignal.timeout(20_000);
    async function getJson(
      url: string,
      bot: boolean,
      signal = lifetime
    ): Promise<unknown> {
      const response = await request(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.any([lifetime, signal]),
        ...(bot ? { headers: { Authorization: `Bot ${token}` } } : {})
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("Discord read failed");
      }
      const reader = response.body.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          const value: unknown = next.value;
          if (!(value instanceof Uint8Array))
            throw new Error("Invalid Discord response stream");
          bytes += value.byteLength;
          if (bytes > 2 * 1024 * 1024)
            throw new Error("Discord proof response is too large");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      lifetime.throwIfAborted();
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    }
    async function readBinding() {
      const binding = webhookSchema.parse(await getJson(webhookUrl, false));
      if (
        binding.id !== webhookId ||
        binding.guild_id !== guildId ||
        !allowedParentChannelIds.includes(binding.channel_id)
      ) {
        throw new Error("Webhook binding is outside the configured founder surface");
      }
      return binding;
    }
    const [binding, rawApplication, rawBot] = await Promise.all([
      readBinding(),
      getJson("https://discord.com/api/v10/oauth2/applications/@me", true),
      getJson("https://discord.com/api/v10/users/@me", true)
    ]);
    const application = z.object({ id }).parse(rawApplication);
    const bot = z.object({ id, bot: z.literal(true) }).parse(rawBot);
    if (application.id !== applicationId)
      throw new Error("The bot credential does not match the production application");
    const audience = createDiscordLiveAudience({
      guildId,
      allowedParentChannelIds,
      botUserId: () => bot.id,
      reader: {
        get: (route, options) =>
          getJson(
            `https://discord.com/api/v10${route}${options.query ? `?${options.query.toString()}` : ""}`,
            true,
            options.signal
          )
      },
      authorizeHumanReader: async (providerUserId) =>
        Boolean(
          await access.authorize({ workspaceId, providerId: "discord", providerUserId })
        )
    });
    const surface = await audience.resolveChannel(binding.channel_id);
    if (surface?.kind !== "text-channel" || surface.guildId !== binding.guild_id)
      throw new Error("Webhook audience is not currently founder-only");
    const freshBinding = await readBinding();
    if (
      freshBinding.id !== binding.id ||
      freshBinding.channel_id !== binding.channel_id ||
      freshBinding.guild_id !== binding.guild_id
    )
      throw new Error("Webhook destination changed during verification");
    // Recheck permissions after the fresh webhook lookup. Discord offers no
    // transaction that can make separate permission reads and a send atomic.
    if (!(await audience.isFounderOnly(freshBinding.channel_id)))
      throw new Error("Webhook audience changed before publication");
    lifetime.throwIfAborted();
    const response = await request(`${webhookUrl}?wait=true`, {
      method: "POST",
      redirect: "error",
      signal: lifetime,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message, allowed_mentions: { parse: [] } })
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("Discord alert was not accepted");
  } catch {
    // Raw SDK/fetch/schema errors may include webhook secrets or identity data.
    throw new Error(
      "The operational Discord alert could not verify its founder-only destination or complete delivery"
    );
  }
}
