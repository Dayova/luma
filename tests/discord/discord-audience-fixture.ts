import { ChannelType, PermissionFlagsBits, Routes } from "discord.js";
import type { DiscordAudienceReader } from "../../src/discord/discord-live-audience.js";

/** A programmable fresh Discord REST surface, separate from SDK caches. */
export function discordAudienceFixture(
  input: {
    botId?: string;
    channel?: (
      id: string
    ) =>
      | { id: string; type: ChannelType; guildId: string; parentId: string | null }
      | undefined;
  } = {}
) {
  const botId = input.botId ?? "bot";
  const state = {
    ownerId: "founder",
    roles: [
      { id: "guild", permissions: "0" },
      { id: "team", permissions: String(PermissionFlagsBits.ViewChannel) },
      {
        id: "bots",
        permissions: String(
          PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory
        )
      },
      { id: "guest", permissions: "0" },
      { id: "admin", permissions: String(PermissionFlagsBits.Administrator) }
    ],
    members: [
      { user: { id: "founder", bot: false }, roles: ["team"] },
      { user: { id: botId, bot: true }, roles: ["bots"] }
    ],
    overwrites: [] as Array<{ id: string; type: 0 | 1; allow: string; deny: string }>,
    channelType: ChannelType.PublicThread
  };
  const read: DiscordAudienceReader["get"] = (route) => {
    if (route === Routes.guild("guild"))
      return Promise.resolve({ id: "guild", owner_id: state.ownerId });
    if (route === Routes.guildRoles("guild"))
      return Promise.resolve(structuredClone(state.roles));
    if (route === Routes.guildMembers("guild"))
      return Promise.resolve(structuredClone(state.members));
    if (route.startsWith("/channels/")) {
      const id = route.slice("/channels/".length);
      const channel = input.channel
        ? input.channel(id)
        : {
            id,
            guildId: "guild",
            type: id === "parent" ? ChannelType.GuildText : state.channelType,
            parentId: id === "parent" ? null : "parent"
          };
      return Promise.resolve(
        channel
          ? {
              id: channel.id,
              guild_id: channel.guildId,
              type: channel.type,
              parent_id: channel.parentId,
              ...(channel.type === ChannelType.GuildText
                ? { permission_overwrites: structuredClone(state.overwrites) }
                : {})
            }
          : null
      );
    }
    return Promise.reject(new Error("Unexpected test REST read"));
  };
  return { state, read };
}
