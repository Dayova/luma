import type { DiscordChannelSurface } from "./discord-channel-scope.js";
import { ChannelType, PermissionFlagsBits, Routes } from "discord.js";
import { z } from "zod";

const PROOF_TIMEOUT_MS = 5_000;
const MEMBER_PAGE_SIZE = 1_000;
const id = z.string().min(1).max(64);
const permissions = z.string().regex(/^\d{1,40}$/u);
const guildSchema = z.object({ id, owner_id: id });
const rolesSchema = z.array(z.object({ id, permissions })).min(1).max(1_000);
const membersSchema = z
  .array(
    z.object({
      user: z.object({ id, bot: z.boolean().optional().default(false) }),
      roles: z.array(id).max(1_000)
    })
  )
  .min(1)
  // A full page cannot prove that no further members exist. The initial
  // four-founder deployment deliberately refuses larger guilds.
  .max(MEMBER_PAGE_SIZE - 1);
const channelSchema = z.object({
  id,
  guild_id: id,
  type: z.nativeEnum(ChannelType),
  parent_id: id.nullable().optional(),
  permission_overwrites: z
    .array(
      z.object({
        id,
        type: z.union([z.literal(0), z.literal(1)]),
        allow: permissions,
        deny: permissions
      })
    )
    .max(1_000)
    .optional()
});

type Channel = z.infer<typeof channelSchema>;
type Member = z.infer<typeof membersSchema>[number];
type Role = z.infer<typeof rolesSchema>[number];

/** Raw, fresh REST reads: SDK member/role caches are not an audience proof. */
export type DiscordAudienceReader = {
  get(
    route: `/${string}`,
    options: { signal: AbortSignal; query?: URLSearchParams }
  ): Promise<unknown>;
};

export function createDiscordLiveAudience(input: {
  reader: DiscordAudienceReader;
  guildId: string;
  allowedParentChannelIds: readonly string[];
  botUserId: () => string | null;
  authorizeHumanReader: (discordUserId: string) => Promise<boolean>;
}) {
  const allowedParents = new Set(input.allowedParentChannelIds);

  return {
    resolveChannel,
    async isFounderOnly(channelId: string): Promise<boolean> {
      return (await resolveChannel(channelId)) !== null;
    }
  };

  /** The entire resolution is bounded; no SDK lookup precedes this proof. */
  async function resolveChannel(
    channelId: string,
    requiredHumanReaders: readonly string[] = []
  ): Promise<DiscordChannelSurface | null> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, PROOF_TIMEOUT_MS);
    });
    try {
      // No positive cache survives this call, including retries of an old reply.
      return await Promise.race([
        verify(channelId, controller.signal, requiredHumanReaders).catch(() => null),
        expired
      ]);
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  async function readSnapshot(channelId: string, signal: AbortSignal) {
    const [rawGuild, rawRoles, rawMembers, rawChannel] = await Promise.all([
      input.reader.get(Routes.guild(input.guildId), { signal }),
      input.reader.get(Routes.guildRoles(input.guildId), { signal }),
      input.reader.get(Routes.guildMembers(input.guildId), {
        signal,
        query: new URLSearchParams({ limit: String(MEMBER_PAGE_SIZE) })
      }),
      input.reader.get(Routes.channel(channelId), { signal })
    ]);
    signal.throwIfAborted();
    const guild = guildSchema.parse(rawGuild);
    const roles = rolesSchema.parse(rawRoles).sort(byId);
    const members = membersSchema
      .parse(rawMembers)
      .map((member) => ({
        ...member,
        roles: member.roles.sort()
      }))
      .sort((left, right) => left.user.id.localeCompare(right.user.id));
    const channel = channelSchema.parse(rawChannel);
    if (
      guild.id !== input.guildId ||
      channel.id !== channelId ||
      channel.guild_id !== guild.id
    )
      return null;
    // Private membership never broadens the supported surface. Public thread
    // readers are exactly the parent channel's VIEW_CHANNEL audience.
    const parent =
      channel.type === ChannelType.PublicThread && channel.parent_id
        ? channelSchema.parse(
            await input.reader.get(Routes.channel(channel.parent_id), { signal })
          )
        : channel;
    if (
      (channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.PublicThread) ||
      parent.type !== ChannelType.GuildText ||
      parent.guild_id !== guild.id ||
      (channel.type === ChannelType.PublicThread && parent.id !== channel.parent_id) ||
      !allowedParents.has(parent.id) ||
      !parent.permission_overwrites
    )
      return null;
    parent.permission_overwrites.sort(
      (left, right) => left.type - right.type || left.id.localeCompare(right.id)
    );
    if (
      new Set(roles.map((role) => role.id)).size !== roles.length ||
      new Set(members.map((member) => member.user.id)).size !== members.length ||
      new Set(
        parent.permission_overwrites.map(
          (overwrite) => `${overwrite.type}:${overwrite.id}`
        )
      ).size !== parent.permission_overwrites.length ||
      !members.some((member) => member.user.id === guild.owner_id) ||
      !members.some((member) => member.user.id === input.botUserId() && member.user.bot)
    )
      return null;
    const roleIds = new Set(roles.map((role) => role.id));
    if (
      !roleIds.has(guild.id) ||
      members.some((member) => member.roles.some((roleId) => !roleIds.has(roleId))) ||
      parent.permission_overwrites.some(
        (overwrite) => overwrite.type === 0 && !roleIds.has(overwrite.id)
      )
    )
      return null;
    return {
      guild,
      roles,
      members,
      channel: { id: channel.id, type: channel.type, parent_id: channel.parent_id },
      parent
    };
  }

  async function verify(
    channelId: string,
    signal: AbortSignal,
    requiredHumanReaders: readonly string[]
  ): Promise<DiscordChannelSurface | null> {
    if (!input.botUserId() || allowedParents.size === 0) return null;
    const first = await readSnapshot(channelId, signal);
    if (!first) return null;
    const bot = first.members.find((member) => member.user.id === input.botUserId());
    if (!bot || !mayView(bot, first.roles, first.guild.owner_id, first.parent))
      return null;
    for (const userId of requiredHumanReaders) {
      const member = first.members.find((candidate) => candidate.user.id === userId);
      if (
        !member ||
        member.user.bot ||
        !mayView(member, first.roles, first.guild.owner_id, first.parent)
      )
        return null;
    }
    for (const member of first.members) {
      if (member.user.bot) continue;
      if (
        mayView(member, first.roles, first.guild.owner_id, first.parent) &&
        !(await input.authorizeHumanReader(member.user.id))
      )
        return null;
      signal.throwIfAborted();
    }
    // Detect changes while assembling the proof instead of combining old roles
    // with new member assignments. REST cannot make check-and-send atomic.
    const second = await readSnapshot(channelId, signal);
    signal.throwIfAborted();
    if (second === null || JSON.stringify(first) !== JSON.stringify(second)) return null;
    return {
      id: channelId,
      guildId: first.guild.id,
      kind:
        first.channel.type === ChannelType.PublicThread
          ? "public-thread"
          : "text-channel",
      parentChannelId:
        first.channel.type === ChannelType.PublicThread ? first.parent.id : null
    };
  }
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

function mayView(
  member: Member,
  roles: Role[],
  ownerId: string,
  parent: Channel
): boolean {
  if (member.user.id === ownerId) return true;
  const memberRoles = new Set([parent.guild_id, ...member.roles]);
  let bits = roles.reduce(
    (current, role) =>
      memberRoles.has(role.id) ? current | BigInt(role.permissions) : current,
    0n
  );
  if ((bits & PermissionFlagsBits.Administrator) !== 0n) return true;
  const overwrites = parent.permission_overwrites ?? [];
  const everyone = overwrites.find(
    (overwrite) => overwrite.type === 0 && overwrite.id === parent.guild_id
  );
  if (everyone) bits = (bits & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const overwrite of overwrites) {
    if (
      overwrite.type === 0 &&
      overwrite.id !== parent.guild_id &&
      memberRoles.has(overwrite.id)
    ) {
      allow |= BigInt(overwrite.allow);
      deny |= BigInt(overwrite.deny);
    }
  }
  bits = (bits & ~deny) | allow;
  const personal = overwrites.find(
    (overwrite) => overwrite.type === 1 && overwrite.id === member.user.id
  );
  if (personal) bits = (bits & ~BigInt(personal.deny)) | BigInt(personal.allow);
  // READ_MESSAGE_HISTORY is not required to see newly published messages.
  return (bits & PermissionFlagsBits.ViewChannel) !== 0n;
}
