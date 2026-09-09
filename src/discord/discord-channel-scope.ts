/** Discord-owned surface facts. Names, roles and stored Meeting mappings grant no scope. */
export type DiscordChannelSurface = {
  id: string;
  guildId: string;
  kind: "text-channel" | "public-thread";
  parentChannelId: string | null;
};

export class DiscordChannelAccessError extends Error {
  constructor() {
    super("Luma is not enabled in this Discord channel.");
    this.name = "DiscordChannelAccessError";
  }
}

export function discordAllowedParentChannelIdsFromEnv(
  env: NodeJS.ProcessEnv
): readonly string[] {
  const value = env["LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS"]?.trim();
  if (!value) return [];
  const ids = value.split(",").map((id) => id.trim());
  if (
    ids.some((id) => !/^[1-9]\d{16,19}$/u.test(id)) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error(
      "LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS must contain unique comma-separated Discord channel IDs"
    );
  }
  return ids;
}

export function createDiscordChannelScope(input: {
  guildId: string;
  allowedParentChannelIds: readonly string[];
  resolveChannel: (input: { channelId: string }) => Promise<DiscordChannelSurface | null>;
}) {
  const allowed = new Set(input.allowedParentChannelIds);

  async function resolveAllowedChannel(
    channelId: string
  ): Promise<DiscordChannelSurface | null> {
    if (!channelId.trim() || allowed.size === 0) return null;
    try {
      const surface = await input.resolveChannel({ channelId });
      if (!surface || surface.id !== channelId || surface.guildId !== input.guildId)
        return null;
      if (surface.kind === "text-channel") {
        return surface.parentChannelId === null && allowed.has(surface.id)
          ? surface
          : null;
      }
      return surface.kind === "public-thread" &&
        surface.parentChannelId !== null &&
        allowed.has(surface.parentChannelId)
        ? surface
        : null;
    } catch {
      return null;
    }
  }

  return {
    resolveAllowedChannel,
    async requireChannel(
      channelId: string,
      kind?: DiscordChannelSurface["kind"]
    ): Promise<DiscordChannelSurface> {
      const surface = await resolveAllowedChannel(channelId);
      if (!surface || (kind && surface.kind !== kind))
        throw new DiscordChannelAccessError();
      return surface;
    }
  };
}
