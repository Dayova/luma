import { ChannelType, PermissionFlagsBits, Routes } from "discord.js";
import { vi } from "vitest";
import { createWorkspaceAccessPolicy } from "../../src/access/workspace-access-policy.js";
import { createLumaTeamIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";
import { createDiscordLiveAudience } from "../../src/discord/discord-live-audience.js";
import { createDiscordDecisionPermissionSourceAccess } from "../../src/discord/discord-decision-standing-runtime.js";
import {
  createDecisionStandingPolicy,
  type DecisionPermissionCommand
} from "../../src/decision-intelligence/standing-permission.js";
import type { DecisionAuthority } from "../../src/decision-intelligence/ports.js";
import type { LumaDatabase } from "../../src/persistence/db.js";
import { decisionDigest } from "../../src/decision-intelligence/persistence.js";
import { decisionRecord } from "../knowledge/decision-record-fixture.js";

export const guildId = "100000000000000001",
  parentId = "100000000000000002",
  threadId = "100000000000000003",
  founderId = "779381502311137301";
export const audience = {
  workspaceId: "workspace_dayova",
  personIds: [...dayovaFounderPersonIds]
};
export function standingFixture(database: LumaDatabase) {
  const directory = createLumaTeamIdentityDirectory();
  let identityCurrent = true,
    audienceCurrent = true,
    authorityCurrent = true;
  let missingReader: string | null = null,
    guest = false,
    parent = parentId;
  let duringAuthorityRead: (() => Promise<void>) | null = null;
  let duringSourceRead: (() => Promise<void>) | null = null;
  const identityDirectory = {
    ...directory,
    findPeopleByProviderUserId: (
      request: Parameters<typeof directory.findPeopleByProviderUserId>[0]
    ) =>
      identityCurrent
        ? directory.findPeopleByProviderUserId(request)
        : Promise.resolve([])
  };
  const accessPolicy = createWorkspaceAccessPolicy({
    workspaceId: audience.workspaceId,
    identityDirectory,
    authorizedPersonIds: audience.personIds
  });
  const read = vi.fn(async (route: `/${string}`): Promise<unknown> => {
    if (!audienceCurrent) throw new Error("No complete current permissions");
    if (duringSourceRead) {
      const hook = duringSourceRead;
      duringSourceRead = null;
      await hook();
    }
    if (route === Routes.guild(guildId)) return { id: guildId, owner_id: founderId };
    if (route === Routes.guildRoles(guildId))
      return [
        { id: guildId, permissions: "0" },
        { id: "team", permissions: String(PermissionFlagsBits.ViewChannel) },
        {
          id: "bots",
          permissions: String(
            PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory
          )
        },
        { id: "admin", permissions: String(PermissionFlagsBits.Administrator) }
      ];
    if (route === Routes.guildMembers(guildId)) {
      const people = await directory.getPeople({
        workspaceId: audience.workspaceId,
        personIds: audience.personIds
      });
      return [
        ...people
          .filter((person) => person.discordUserId !== missingReader)
          .map((person) => ({
            user: { id: person.discordUserId, bot: false },
            roles: ["team"]
          })),
        { user: { id: "bot_luma", bot: true }, roles: ["bots"] },
        ...(guest ? [{ user: { id: "guest", bot: false }, roles: ["admin"] }] : [])
      ];
    }
    if (route.startsWith("/channels/")) {
      const id = route.slice("/channels/".length);
      return {
        id,
        guild_id: guildId,
        type: id === threadId ? ChannelType.PublicThread : ChannelType.GuildText,
        parent_id: id === threadId ? parent : null,
        ...(id !== threadId ? { permission_overwrites: [] } : {})
      };
    }
    throw new Error("Unexpected REST address");
  });
  const live = createDiscordLiveAudience({
    reader: { get: read },
    guildId,
    allowedParentChannelIds: [parentId],
    botUserId: () => "bot_luma",
    authorizeHumanReader: async (providerUserId) =>
      (await accessPolicy.authorize({
        workspaceId: audience.workspaceId,
        providerId: "discord",
        providerUserId
      })) !== null
  });
  const resolveChannel = ({
    channelId,
    requiredHumanReaderIds
  }: {
    channelId: string;
    requiredHumanReaderIds?: readonly string[];
  }) => live.resolveChannel(channelId, requiredHumanReaderIds);
  const sourceAccess = createDiscordDecisionPermissionSourceAccess({
    workspaceId: audience.workspaceId,
    guildId,
    parentChannelIds: [parentId],
    founderPersonIds: audience.personIds,
    identityDirectory,
    accessPolicy,
    resolveChannel
  });
  const snapshot = decisionRecord().authority.snapshot;
  snapshot.grants[0]!.personId = "person_jakob";
  const authority: DecisionAuthority = {
    read: vi.fn(async () => {
      if (duringAuthorityRead) {
        const hook = duringAuthorityRead;
        duringAuthorityRead = null;
        await hook();
      }
      if (!authorityCurrent) throw new Error("Ownership unavailable");
      return structuredClone(snapshot);
    }),
    requireCurrent: ({ snapshot: expected }) => {
      if (!authorityCurrent || decisionDigest(expected) !== decisionDigest(snapshot))
        throw new Error("Ownership changed");
      return Promise.resolve();
    }
  };
  const make = () =>
    createDecisionStandingPolicy({
      database,
      workspaceId: audience.workspaceId,
      audience,
      accessPolicy,
      authority,
      sourceAccess
    });
  const command = (
    n = 1,
    choice: DecisionPermissionCommand["choice"] = {
      action: "enable",
      permissionClass: "new-decisions",
      sharing: "four-founders"
    }
  ): DecisionPermissionCommand => ({
    interactionId: String(1800000000000000000n + BigInt(n)),
    guildId,
    channelId: threadId,
    actorDiscordUserId: founderId,
    occurredAt: "2026-09-11T09:00:00Z",
    scopeId: "luma",
    choice
  });
  return {
    make,
    command,
    sourceAccess,
    accessPolicy,
    identityDirectory,
    authority,
    snapshot,
    read,
    resolveChannel,
    revokeIdentity: () => {
      identityCurrent = false;
    },
    revokeChannel: () => {
      audienceCurrent = false;
    },
    revokeAuthority: () => {
      authorityCurrent = false;
    },
    missingReader: (id: string | null) => {
      missingReader = id;
    },
    addGuest: () => {
      guest = true;
    },
    moveThread: () => {
      parent = "100000000000000004";
    },
    duringAuthority: (hook: () => Promise<void>) => {
      duringAuthorityRead = hook;
    },
    duringSource: (hook: () => Promise<void>) => {
      duringSourceRead = hook;
    }
  };
}
