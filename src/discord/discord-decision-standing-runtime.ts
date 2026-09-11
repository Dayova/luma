import type { WorkspaceAccessPolicy } from "../access/workspace-access-policy.js";
import type { IdentityDirectory } from "../identity/interface.js";
import type { DecisionAudience } from "../domain/decision-records.js";
import { decisionDigest } from "../decision-intelligence/persistence.js";
import {
  decisionPermissionDescriptions,
  type DecisionPermissionCommand,
  type DecisionPermissionSourceAccess,
  type ManagedDecisionStandingPolicy
} from "../decision-intelligence/standing-permission.js";
import {
  createDiscordChannelScope,
  type DiscordChannelSurface
} from "./discord-channel-scope.js";
import type {
  DiscordCommandBase,
  DiscordCommandResponse
} from "./discord-meeting-bot.js";

export type DiscordDecisionAutomaticCommand = DiscordCommandBase & {
  type: "decision-record-automatic";
  scopeId: string;
  choice: DecisionPermissionCommand["choice"];
};

export class DiscordDecisionPermissionInputError extends Error {
  constructor() {
    super(
      "To enable your permission, choose an exact scope, a recording class and sharing:four-founders. Status and disable require only action and scope."
    );
    this.name = "DiscordDecisionPermissionInputError";
  }
}

export class DiscordDecisionPermissionUnavailableError extends Error {
  constructor() {
    super(
      "The automatic recording permission changed or could not be verified before delivery. Use /decision-record automatic with action:status and the same scope to check the saved permission."
    );
    this.name = "DiscordDecisionPermissionUnavailableError";
  }
}

/** Reuses the connected transport's fresh, complete live founder-audience proof. */
export function createDiscordDecisionPermissionSourceAccess(input: {
  workspaceId: string;
  guildId: string;
  parentChannelIds: readonly string[];
  founderPersonIds: readonly string[];
  identityDirectory: IdentityDirectory;
  accessPolicy: WorkspaceAccessPolicy;
  resolveChannel(input: {
    channelId: string;
    requiredHumanReaderIds?: readonly string[];
  }): Promise<DiscordChannelSurface | null>;
}): DecisionPermissionSourceAccess {
  const founders = [...input.founderPersonIds].sort();
  if (founders.length !== 4 || new Set(founders).size !== 4)
    throw new Error("Exactly four uniquely mapped founders are required");
  async function read(audience: DecisionAudience, guildId: string, channelId: string) {
    if (
      audience.workspaceId !== input.workspaceId ||
      guildId !== input.guildId ||
      decisionDigest([...audience.personIds].sort()) !== decisionDigest(founders)
    )
      throw new Error("The standing permission audience is unavailable");
    async function identities() {
      const readers: Array<{ personId: string; providerUserId: string }> = [];
      for (const personId of founders) {
        const person = await input.identityDirectory.getPerson({
          workspaceId: input.workspaceId,
          personId
        });
        if (
          !person?.discordUserId ||
          (
            await input.accessPolicy.authorize({
              workspaceId: input.workspaceId,
              providerId: "discord",
              providerUserId: person.discordUserId
            })
          )?.personId !== personId
        )
          throw new Error("A founder's current Discord identity is unavailable");
        readers.push({ personId, providerUserId: person.discordUserId });
      }
      if (new Set(readers.map((reader) => reader.providerUserId)).size !== 4)
        throw new Error("Founder Discord identities are ambiguous");
      return readers;
    }
    const before = await identities();
    // resolveChannel is supplied by the existing Discord runtime, whose live
    // audience verifier refuses guest/public/incomplete membership or permissions.
    const channelScope = createDiscordChannelScope({
      guildId: input.guildId,
      allowedParentChannelIds: input.parentChannelIds,
      resolveChannel: (request) =>
        input.resolveChannel({
          ...request,
          requiredHumanReaderIds: before.map((reader) => reader.providerUserId)
        })
    });
    const surface = await channelScope.requireChannel(channelId);
    const readers = await identities();
    if (decisionDigest(before) !== decisionDigest(readers))
      throw new Error("Founder identities changed during channel authorization");
    return {
      guildId,
      channelId,
      kind: surface.kind,
      parentChannelId: surface.parentChannelId,
      readers
    };
  }
  return {
    async capture({ audience, command }) {
      const boundary = await read(audience, command.guildId, command.channelId);
      if (
        !boundary.readers.some(
          (reader) => reader.providerUserId === command.actorDiscordUserId
        )
      )
        throw new Error("Only a current founder may set their own recording permission");
      return boundary;
    },
    async requireCurrent({ audience, boundary }) {
      const current = await read(audience, boundary.guildId, boundary.channelId);
      if (decisionDigest(current) !== decisionDigest(boundary))
        throw new Error("The original permission channel or founder identities changed");
    }
  };
}

export async function handleDiscordDecisionAutomaticCommand(input: {
  policy: ManagedDecisionStandingPolicy | undefined;
  command: DiscordDecisionAutomaticCommand;
}): Promise<DiscordCommandResponse> {
  if (!input.policy)
    return {
      content:
        "Automatic Decision Record permission is not configured. No standing permission was changed."
    };
  const { type, ...command } = input.command;
  if (type !== "decision-record-automatic")
    throw new Error("A native automatic permission command is required");
  const statusCommand: DecisionPermissionCommand = {
    ...command,
    choice: { action: "status" }
  };
  try {
    const result = await input.policy.command(command);
    const content = [
      `Automatic Decision recording: ${result.state}.`,
      `Owner: ${result.personId}. Exact scope: ${result.scopeId}.`,
      result.permissionClass
        ? decisionPermissionDescriptions[result.permissionClass]
        : "No active standing permission for this scope.",
      result.grant
        ? `Recipients: ${result.grant.audience.personIds.join(", ")}.\nGrant: ${result.grant.id}\nOriginal interaction: ${result.instructionId}\nOrigin channel: ${result.grant.source.url}`
        : `Instruction receipt: ${result.instructionId ?? "none"}.`,
      result.state === "unavailable"
        ? "The saved permission cannot currently be used: original founder access or scope ownership could not be proven. Disable remains available to its owner."
        : "Permission to record does not grant decision-making authority. Tentative ideas and poll votes never become confirmed decisions automatically.",
      "Changing or disabling this permission invalidates its previous grant; existing records and history are retained."
    ].join("\n");
    return {
      content,
      requireCurrent: async () => {
        try {
          if (
            decisionDigest(await input.policy!.command(statusCommand)) !==
            decisionDigest(result)
          )
            throw new DiscordDecisionPermissionUnavailableError();
        } catch {
          throw new DiscordDecisionPermissionUnavailableError();
        }
      }
    };
  } catch {
    return {
      content:
        "This permission could not be changed or verified. Enable requires your own current documented scope, an explicit recording class and four-founder sharing. Use automatic status to check the retained result; disable only affects your own scope."
    };
  }
}
