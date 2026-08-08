import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type SendableChannels,
  type TextChannel
} from "discord.js";
import type {
  DiscordCommand,
  DiscordCommandResponse,
  DiscordThread,
  DiscordTransport
} from "./discord-meeting-bot.js";

const DISCORD_MESSAGE_MAX_LENGTH = 2_000;

export type DiscordJsTransportConfig = {
  token: string;
  clientId: string;
  guildId: string;
};

export class DiscordJsAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DiscordJsAdapterError";
    this.code = code;
  }
}

export function createDiscordJsTransport(
  config: DiscordJsTransportConfig
): DiscordTransport {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });
  let commandHandler:
    ((command: DiscordCommand) => Promise<DiscordCommandResponse>) | null = null;

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "meeting") {
      return;
    }

    void handleInteraction(interaction, config.guildId, commandHandler).catch(
      async (error: unknown) => {
        const content =
          error instanceof Error
            ? `Luma could not process the command: ${error.message}`
            : "Luma could not process the command.";

        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content });
          return;
        }

        await interaction.reply({
          content,
          flags: MessageFlags.Ephemeral
        });
      }
    );
  });

  return {
    async connect(handler) {
      commandHandler = handler;
      await registerMeetingCommand(config);
      const ready = once(client, Events.ClientReady);
      await client.login(config.token);
      await ready;
    },
    async disconnect() {
      await client.destroy();
      commandHandler = null;
    },
    async createThread(input): Promise<DiscordThread> {
      const channel = await client.channels.fetch(input.parentChannelId);

      if (!channel || channel.type !== ChannelType.GuildText) {
        throw new DiscordJsAdapterError(
          "discord-thread-parent-invalid",
          "The /meeting start command must be used in a server text channel"
        );
      }

      const activeThreads = await channel.threads.fetchActive();
      let existingThread = activeThreads.threads.find(
        (thread) => thread.name === input.name && thread.ownerId === client.user?.id
      );

      if (!existingThread) {
        existingThread = await findOwnedArchivedThread(
          channel,
          input.name,
          client.user?.id
        );
      }

      if (existingThread) {
        return {
          id: existingThread.id,
          url: existingThread.url
        };
      }

      const thread = await channel.threads.create({
        name: input.name,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        reason: "Persistent Luma Meeting thread"
      });

      return {
        id: thread.id,
        url: thread.url
      };
    },
    async sendMessage(input) {
      const channel = await client.channels.fetch(input.channelId);

      if (!channel?.isSendable()) {
        throw new DiscordJsAdapterError(
          "discord-channel-not-sendable",
          "Luma cannot send a message to the configured Discord channel"
        );
      }

      const nonce = input.idempotencyKey ? discordNonce(input.idempotencyKey) : undefined;
      const marker = nonce ? discordMessageMarker(nonce) : undefined;

      if (marker && (await hasDeliveredMessage(channel, marker, client.user?.id))) {
        return;
      }

      await channel.send({
        content: renderDiscordMessage(input.content, marker),
        allowedMentions: {
          parse: [],
          users: input.allowedUserIds ?? []
        },
        ...(nonce
          ? {
              nonce,
              enforceNonce: true
            }
          : {})
      });
    }
  };
}

export function createDiscordJsTransportFromEnv(
  env: NodeJS.ProcessEnv = process.env
): DiscordTransport {
  const token = nonBlankEnvValue(env["DISCORD_TOKEN"]);
  const clientId = nonBlankEnvValue(env["DISCORD_CLIENT_ID"]);
  const guildId = nonBlankEnvValue(env["DISCORD_GUILD_ID"]);

  if (!token || !clientId || !guildId) {
    throw new DiscordJsAdapterError(
      "discord-config-incomplete",
      "DISCORD_TOKEN, DISCORD_CLIENT_ID, and DISCORD_GUILD_ID are required"
    );
  }

  return createDiscordJsTransport({
    token,
    clientId,
    guildId
  });
}

async function registerMeetingCommand(config: DiscordJsTransportConfig): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.token);

  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
    body: [meetingCommand.toJSON()]
  });
}

async function handleInteraction(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  commandHandler: ((command: DiscordCommand) => Promise<DiscordCommandResponse>) | null
): Promise<void> {
  if (!commandHandler) {
    throw new DiscordJsAdapterError(
      "discord-command-handler-missing",
      "The Discord bot has not finished starting"
    );
  }

  if (!interaction.inGuild() || interaction.guildId !== guildId) {
    await interaction.reply({
      content: "Luma is not configured for this Discord server.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });
  const response = await commandHandler(toDiscordCommand(interaction));
  await interaction.editReply({
    content: truncateDiscordMessage(response.content)
  });
}

function toDiscordCommand(interaction: ChatInputCommandInteraction): DiscordCommand {
  const base = {
    interactionId: interaction.id,
    guildId: interaction.guildId ?? "",
    channelId: interaction.channelId,
    actorDiscordUserId: interaction.user.id,
    occurredAt: interaction.createdAt.toISOString()
  };
  const subcommand = interaction.options.getSubcommand(true);

  switch (subcommand) {
    case "start":
      return {
        ...base,
        type: "start",
        title: interaction.options.getString("title", true),
        languageMode: readLanguageMode(interaction.options.getString("language"))
      };
    case "stop":
      return {
        ...base,
        type: "stop"
      };
    case "ask":
      return {
        ...base,
        type: "ask",
        question: interaction.options.getString("question", true)
      };
    case "catchup":
      return {
        ...base,
        type: "catchup",
        sinceRevision: interaction.options.getInteger("since_revision") ?? 0
      };
    case "note":
      return {
        ...base,
        type: "note",
        text: interaction.options.getString("text", true),
        language: readUtteranceLanguage(interaction.options.getString("language"))
      };
    case "approve":
      return {
        ...base,
        type: "approve",
        intentId: interaction.options.getString("intent_id", true)
      };
    case "recover":
      return {
        ...base,
        type: "recover",
        intentId: interaction.options.getString("intent_id", true)
      };
    case "reject": {
      const reason = interaction.options.getString("reason");
      return {
        ...base,
        type: "reject",
        intentId: interaction.options.getString("intent_id", true),
        ...(reason ? { reason } : {})
      };
    }
    default:
      throw new DiscordJsAdapterError(
        "discord-command-unsupported",
        `Unsupported /meeting command: ${subcommand}`
      );
  }
}

function readLanguageMode(value: string | null): "auto" | "de" | "en" | "multilingual" {
  return value === "auto" || value === "de" || value === "en" ? value : "multilingual";
}

function readUtteranceLanguage(value: string | null): "de" | "en" | "mixed" | "unknown" {
  return value === "de" || value === "en" || value === "mixed" ? value : "unknown";
}

function truncateDiscordMessage(
  content: string,
  maxLength = DISCORD_MESSAGE_MAX_LENGTH
): string {
  if (content.length <= maxLength) {
    return content;
  }

  return `${content.slice(0, maxLength - 16)}\n[truncated]`;
}

function nonBlankEnvValue(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

function discordNonce(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 25);
}

function discordMessageMarker(nonce: string): string {
  return `\n\n-# Luma event ${nonce}`;
}

async function hasDeliveredMessage(
  channel: SendableChannels,
  marker: string,
  botUserId: string | undefined
): Promise<boolean> {
  let before: string | undefined;

  while (true) {
    const messages = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {})
    });

    if (
      messages.some(
        (message) => message.content.includes(marker) && message.author.id === botUserId
      )
    ) {
      return true;
    }

    if (messages.size < 100) {
      return false;
    }

    before = messages.last()?.id;

    if (!before) {
      return false;
    }
  }
}

async function findOwnedArchivedThread(
  channel: TextChannel,
  name: string,
  botUserId: string | undefined
) {
  let before: Date | undefined;

  while (true) {
    const archivedThreads = await channel.threads.fetchArchived({
      type: "public",
      limit: 100,
      ...(before ? { before } : {})
    });
    const existingThread = archivedThreads.threads.find(
      (thread) => thread.name === name && thread.ownerId === botUserId
    );

    if (existingThread || !archivedThreads.hasMore) {
      return existingThread;
    }

    const archivedAt = archivedThreads.threads.last()?.archivedAt;

    if (!archivedAt) {
      return undefined;
    }

    before = archivedAt;
  }
}

function renderDiscordMessage(content: string, marker: string | undefined): string {
  if (!marker) {
    return truncateDiscordMessage(content);
  }

  return `${truncateDiscordMessage(content, DISCORD_MESSAGE_MAX_LENGTH - marker.length)}${marker}`;
}

const meetingCommand = new SlashCommandBuilder()
  .setName("meeting")
  .setDescription("Run a Luma Meeting in Discord")
  .addSubcommand((command) =>
    command
      .setName("start")
      .setDescription("Start a Meeting and create its persistent thread")
      .addStringOption((option) =>
        option
          .setName("title")
          .setDescription("Meeting title")
          .setRequired(true)
          .setMaxLength(100)
      )
      .addStringOption((option) =>
        option
          .setName("language")
          .setDescription("Expected Meeting language")
          .addChoices(
            { name: "German and English", value: "multilingual" },
            { name: "German", value: "de" },
            { name: "English", value: "en" },
            { name: "Automatic", value: "auto" }
          )
      )
  )
  .addSubcommand((command) =>
    command
      .setName("note")
      .setDescription("Record typed evidence in the active Meeting")
      .addStringOption((option) =>
        option
          .setName("text")
          .setDescription("What was said")
          .setRequired(true)
          .setMaxLength(1_800)
      )
      .addStringOption((option) =>
        option
          .setName("language")
          .setDescription("Language of the original evidence")
          .addChoices(
            { name: "German", value: "de" },
            { name: "English", value: "en" },
            { name: "German and English", value: "mixed" },
            { name: "Unknown", value: "unknown" }
          )
      )
  )
  .addSubcommand((command) =>
    command
      .setName("approve")
      .setDescription("Approve and execute a proposed Follow-up Intent")
      .addStringOption((option) =>
        option
          .setName("intent_id")
          .setDescription("Follow-up Intent ID")
          .setRequired(true)
          .setMaxLength(200)
      )
  )
  .addSubcommand((command) =>
    command
      .setName("recover")
      .setDescription("Safely resolve a stranded Follow-up execution")
      .addStringOption((option) =>
        option
          .setName("intent_id")
          .setDescription("Follow-up Intent ID")
          .setRequired(true)
          .setMaxLength(200)
      )
  )
  .addSubcommand((command) =>
    command
      .setName("reject")
      .setDescription("Reject a proposed Follow-up Intent")
      .addStringOption((option) =>
        option
          .setName("intent_id")
          .setDescription("Follow-up Intent ID")
          .setRequired(true)
          .setMaxLength(200)
      )
      .addStringOption((option) =>
        option
          .setName("reason")
          .setDescription("Optional reason for rejection")
          .setMaxLength(1_000)
      )
  )
  .addSubcommand((command) =>
    command.setName("stop").setDescription("End the active Meeting")
  )
  .addSubcommand((command) =>
    command
      .setName("ask")
      .setDescription("Ask an evidence-grounded question about the Meeting")
      .addStringOption((option) =>
        option
          .setName("question")
          .setDescription("Question about the active Meeting")
          .setRequired(true)
          .setMaxLength(1_800)
      )
  )
  .addSubcommand((command) =>
    command
      .setName("catchup")
      .setDescription("Get grounded changes from the active Meeting")
      .addIntegerOption((option) =>
        option
          .setName("since_revision")
          .setDescription("Meeting Revision to catch up from")
          .setMinValue(0)
      )
  );
