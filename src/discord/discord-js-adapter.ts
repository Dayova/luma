import { createDiscordLiveAudience } from "./discord-live-audience.js";
import { createWorkspaceAccessPolicy } from "../access/workspace-access-policy.js";
import { createIdentityDirectoryFromEnv } from "../identity/static-identity-directory.js";
import { dayovaFounderPersonIds } from "../app/founder-access.js";
import {
  createDiscordChannelScope,
  discordAllowedParentChannelIdsFromEnv
} from "./discord-channel-scope.js";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  ChannelType,
  Client,
  DefaultRestOptions,
  Events,
  GatewayIntentBits,
  MessageFlags,
  MessageType,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type Message,
  type SendableChannels,
  type TextChannel,
  type ThreadChannel
} from "discord.js";
import type {
  CapturedConversationEvidence,
  ConversationEvidenceSource
} from "../context-intelligence/conversation-evidence-source.js";
import { requireCurrentConversationEvidence } from "../context-intelligence/conversation-evidence-source.js";
import {
  createDiscordConversationEvidenceSource,
  type DiscordConversationMessage,
  type DiscordConversationReader,
  type DiscordConversationThread
} from "./discord-conversation-evidence-source.js";
import {
  discordContextAskConfigFromEnv,
  discordContextAskMentionFromCandidate,
  type DiscordContextAskConfig,
  type DiscordContextAskMessageCandidate,
  type DiscordContextAskMention
} from "./discord-context-ask-runtime.js";
import type {
  DiscordCommand,
  DiscordCommandResponse,
  DiscordContextAskResponse,
  DiscordThread,
  DiscordTransport
} from "./discord-meeting-bot.js";

const DISCORD_MESSAGE_MAX_LENGTH = 2_000;

export type DiscordJsTransportConfig = {
  token: string;
  clientId: string;
  guildId: string;
  allowedParentChannelIds: readonly string[];
  authorizeHumanReader: (discordUserId: string) => Promise<boolean>;
  contextAsk?: DiscordContextAskConfig;
};

/** One shared Gateway client backs command, mention, and evidence paths. */
export type DiscordJsTransport = DiscordTransport &
  ConversationEvidenceSource & {
    gatewayConnected?(): boolean;
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
): DiscordJsTransport {
  if (
    config.contextAsk?.parentChannelIds.some(
      (id) => !config.allowedParentChannelIds.includes(id)
    )
  ) {
    throw new Error(
      "Discord Context Ask parent channels must be within the common Discord channel scope"
    );
  }
  const lifetime = new AbortController();
  const restOptions = {
    ...DefaultRestOptions,
    makeRequest: (
      url: string,
      init: Parameters<typeof DefaultRestOptions.makeRequest>[1]
    ) =>
      DefaultRestOptions.makeRequest(url, {
        ...init,
        signal: AbortSignal.any([lifetime.signal, ...(init.signal ? [init.signal] : [])])
      })
  };
  const client = new Client({
    intents: discordGatewayIntentsForContextAsk(config.contextAsk),
    rest: restOptions
  });
  const liveAudience = createDiscordLiveAudience({
    reader: { get: (route, options) => client.rest.get(route, options) },
    guildId: config.guildId,
    allowedParentChannelIds: config.allowedParentChannelIds,
    botUserId: () => client.user?.id ?? null,
    authorizeHumanReader: config.authorizeHumanReader
  });
  const resolveChannel = liveAudience.resolveChannel;
  const channelScope = createDiscordChannelScope({
    guildId: config.guildId,
    allowedParentChannelIds: config.allowedParentChannelIds,
    resolveChannel: ({ channelId }) => resolveChannel(channelId)
  });
  let commandHandler:
    ((command: DiscordCommand) => Promise<DiscordCommandResponse>) | null = null;
  let contextAskHandler:
    | ((ask: DiscordContextAskMention) => Promise<DiscordContextAskResponse | null>)
    | null = null;
  let disconnected = false;
  let disconnecting: Promise<void> | undefined;
  function assertConnectedLifetime(): void {
    lifetime.signal.throwIfAborted();
  }
  function disconnect(): Promise<void> {
    if (!disconnected) {
      disconnected = true;
      // Remove admission before aborting any asynchronous initialization. All
      // client REST, including gateway discovery inside login, shares this
      // signal, so a stopped client cannot later discover/spawn a new Gateway.
      commandHandler = null;
      contextAskHandler = null;
      lifetime.abort();
      disconnecting = client.destroy();
    }
    return disconnecting ?? Promise.resolve();
  }
  const rawConversationEvidenceSource = config.contextAsk
    ? createDiscordConversationEvidenceSource({
        reader: createDiscordJsConversationReader(client),
        guildId: config.guildId,
        config: config.contextAsk,
        botUserId: () => client.user?.id ?? null
      })
    : null;
  const conversationEvidenceSource: ConversationEvidenceSource | null =
    rawConversationEvidenceSource
      ? {
          async capture(input) {
            await channelScope.requireChannel(
              input.subject.conversationObjectId,
              "public-thread"
            );
            const captured = await rawConversationEvidenceSource.capture(input);
            // Check once around the bounded capture, not once per message. No
            // captured content escapes if the channel gained another reader.
            await channelScope.requireChannel(
              input.subject.conversationObjectId,
              "public-thread"
            );
            return captured;
          }
        }
      : null;

  client.on(Events.InteractionCreate, (interaction) => {
    if (disconnected) return;
    if (!interaction.isChatInputCommand() || interaction.commandName !== "meeting") {
      return;
    }

    void handleInteraction(interaction, config.guildId, commandHandler, channelScope)
      .catch(async () => {
        const content =
          "Luma could not process the command right now. Please try again later.";

        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content });
          return;
        }

        await interaction.reply({
          content,
          flags: MessageFlags.Ephemeral
        });
      })
      .catch(() => {
        reportDiscordDeliveryFailure({
          code: "discord-command-reply-failed",
          channelId: interaction.channelId,
          sourceId: interaction.id
        });
      });
  });

  client.on(Events.MessageCreate, (message) => {
    const handler = contextAskHandler;
    const contextAsk = config.contextAsk;
    const botUserId = client.user?.id;

    if (!handler || !contextAsk || !botUserId) {
      return;
    }

    const ask = discordContextAskMentionFromCandidate({
      candidate: discordContextAskMessageCandidate(message),
      botUserId,
      guildId: config.guildId,
      config: contextAsk
    });

    if (!ask) {
      return;
    }

    void handleContextAskMention({
      message,
      handler,
      ask,
      channelScope,
      conversationEvidenceSource
    }).catch(() => {
      reportDiscordDeliveryFailure({
        code: "discord-context-ask-reply-failed",
        channelId: message.channelId,
        sourceId: message.id
      });
    });
  });

  return {
    gatewayConnected: () => !disconnected && client.isReady(),
    async connect(handler, contextHandler, startupSignal) {
      startupSignal?.throwIfAborted();
      assertConnectedLifetime();
      commandHandler = handler;
      contextAskHandler = contextHandler ?? null;
      const cancel = () => {
        void disconnect().catch(() => undefined);
      };
      startupSignal?.addEventListener("abort", cancel, { once: true });
      try {
        // Discord's REST queue can be asleep after a 429 even when its request
        // signal is aborted. Stop waiting at this already-owned boundary; the
        // shared request signal prevents a later HTTP attempt, and the lifetime
        // fence below prevents any late completion from continuing into login.
        await waitForStartupOperation(
          registerMeetingCommand(config, restOptions, lifetime.signal),
          lifetime.signal
        );
        // A late REST completion must never continue into client.login after
        // disconnect. The SDK's gateway-discovery fetch is also abortable.
        assertConnectedLifetime();
        await Promise.all([
          once(client, Events.ClientReady, { signal: lifetime.signal }),
          client.login(config.token).then(() => assertConnectedLifetime())
        ]);
        assertConnectedLifetime();
      } catch (error) {
        await disconnect();
        throw error;
      } finally {
        startupSignal?.removeEventListener("abort", cancel);
      }
    },
    disconnect,
    resolveChannel: ({ channelId }) => resolveChannel(channelId),
    async createThread(input): Promise<DiscordThread> {
      await channelScope.requireChannel(input.parentChannelId, "text-channel");
      const channel = await client.channels.fetch(input.parentChannelId, { force: true });

      if (
        !channel ||
        channel.type !== ChannelType.GuildText ||
        channel.guildId !== config.guildId ||
        !config.allowedParentChannelIds.includes(channel.id)
      ) {
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
        await channelScope.requireChannel(existingThread.id, "public-thread");
        return {
          id: existingThread.id,
          url: existingThread.url
        };
      }

      await channelScope.requireChannel(input.parentChannelId, "text-channel");
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
      await channelScope.requireChannel(input.channelId, "public-thread");
      const channel = await client.channels.fetch(input.channelId, { force: true });
      if (
        !channel ||
        channel.type !== ChannelType.PublicThread ||
        channel.guildId !== config.guildId ||
        !channel.parentId ||
        !config.allowedParentChannelIds.includes(channel.parentId)
      ) {
        throw new DiscordJsAdapterError(
          "discord-channel-not-allowed",
          "Luma is not enabled in this Discord channel."
        );
      }
      const parent = await client.channels.fetch(channel.parentId, { force: true });
      if (
        !parent ||
        parent.type !== ChannelType.GuildText ||
        parent.guildId !== config.guildId
      ) {
        throw new DiscordJsAdapterError(
          "discord-channel-not-allowed",
          "Luma is not enabled in this Discord channel."
        );
      }

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

      await channelScope.requireChannel(input.channelId, "public-thread");
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
    },
    async capture(input): Promise<CapturedConversationEvidence> {
      if (!conversationEvidenceSource) {
        throw new DiscordJsAdapterError(
          "discord-context-ask-not-configured",
          "Discord Context Ask is not enabled for this transport"
        );
      }

      return conversationEvidenceSource.capture(input);
    }
  };
}

export function createDiscordJsTransportFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  contextAsk: DiscordContextAskConfig | undefined = discordContextAskConfigFromEnv(env)
): DiscordJsTransport {
  const token = nonBlankEnvValue(env["DISCORD_TOKEN"]);
  const clientId = nonBlankEnvValue(env["DISCORD_CLIENT_ID"]);
  const guildId = nonBlankEnvValue(env["DISCORD_GUILD_ID"]);

  if (!token || !clientId || !guildId) {
    throw new DiscordJsAdapterError(
      "discord-config-incomplete",
      "DISCORD_TOKEN, DISCORD_CLIENT_ID, and DISCORD_GUILD_ID are required"
    );
  }

  const workspaceId = env["LUMA_WORKSPACE_ID"] ?? "workspace_dayova";
  const accessPolicy = createWorkspaceAccessPolicy({
    workspaceId,
    identityDirectory: createIdentityDirectoryFromEnv(env),
    authorizedPersonIds: dayovaFounderPersonIds
  });
  return createDiscordJsTransport({
    authorizeHumanReader: async (providerUserId) =>
      Boolean(
        await accessPolicy.authorize({
          workspaceId,
          providerId: "discord",
          providerUserId
        })
      ),
    token,
    clientId,
    guildId,
    allowedParentChannelIds: discordAllowedParentChannelIdsFromEnv(env),
    ...(contextAsk ? { contextAsk } : {})
  });
}

export function discordGatewayIntentsForContextAsk(
  contextAsk: DiscordContextAskConfig | undefined
): GatewayIntentBits[] {
  return contextAsk
    ? [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ]
    : [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers];
}

async function registerMeetingCommand(
  config: DiscordJsTransportConfig,
  restOptions: typeof DefaultRestOptions,
  signal: AbortSignal
): Promise<void> {
  const rest = new REST({ ...restOptions, version: "10" }).setToken(config.token);

  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
    body: [meetingCommand.toJSON()],
    signal
  });
}

function waitForStartupOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Discord startup cancelled", "AbortError")
      );
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        if (signal.aborted) aborted();
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error instanceof Error ? error : new Error("Discord startup failed"));
      }
    );
  });
}

async function handleInteraction(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  commandHandler: ((command: DiscordCommand) => Promise<DiscordCommandResponse>) | null,
  channelScope: ReturnType<typeof createDiscordChannelScope>
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
  const admitted = await channelScope.resolveAllowedChannel(interaction.channelId);
  await interaction.editReply({
    content: admitted
      ? truncateDiscordMessage(response.content)
      : "Luma is not enabled in this Discord channel."
  });
}

async function handleContextAskMention(input: {
  message: Message;
  handler: (ask: DiscordContextAskMention) => Promise<DiscordContextAskResponse | null>;
  ask: DiscordContextAskMention;
  channelScope: ReturnType<typeof createDiscordChannelScope>;
  conversationEvidenceSource: ConversationEvidenceSource | null;
}): Promise<void> {
  const mayReply = async (): Promise<boolean> => {
    const surface = await input.channelScope.resolveAllowedChannel(input.ask.channelId);
    return (
      surface?.kind === "public-thread" &&
      surface.parentChannelId === input.ask.parentChannelId
    );
  };
  if (!(await mayReply())) return;
  let response: DiscordContextAskResponse | null;
  try {
    response = await input.handler(input.ask);
  } catch {
    response = {
      content: "Luma could not answer this thread right now. Please try again later.",
      idempotencyKey: `discord:${input.message.id}:context-ask:reply`
    };
  }
  // A failed or ambiguous send must not trigger a second, contradictory reply.
  if (!response || !(await mayReply())) return;
  if (response.sourceProof) {
    const proof = response.sourceProof;
    if (
      !input.conversationEvidenceSource ||
      proof.subject.providerId !== "discord" ||
      proof.subject.conversationObjectId !== input.ask.channelId ||
      proof.subject.anchorMessageId !== input.ask.messageId ||
      proof.question !== input.ask.question
    )
      return;
    try {
      await requireCurrentConversationEvidence(input.conversationEvidenceSource, proof);
    } catch {
      // Retain the old result for audit, but do not republish its old claims.
      response = {
        content:
          "The conversation changed or is no longer readable. Post a new @Luma question to use its current state.",
        idempotencyKey: response.idempotencyKey
      };
    }
    if (!(await mayReply())) return;
  }
  if (response.requireCurrent) {
    try {
      await response.requireCurrent();
    } catch {
      response = {
        content:
          "The conversation or organizational context changed or is no longer readable. Post a new @Luma question to use its current state.",
        idempotencyKey: response.idempotencyKey
      };
    }
    if (!(await mayReply())) return;
  }
  await replyToContextAskMessage(input.message, response);
}

function discordContextAskMessageCandidate(
  message: Message
): DiscordContextAskMessageCandidate {
  const thread = message.channel.isThread() ? message.channel : null;

  return {
    messageId: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    parentChannelId: thread?.parentId ?? null,
    channelKind:
      thread && thread.type !== ChannelType.PrivateThread ? "public-thread" : "other",
    authorKind: discordAuthorKind(message),
    actorDiscordUserId: message.author.id,
    mentionedDiscordUserIds: [...message.mentions.users.keys()],
    content: message.content,
    occurredAt: message.createdAt.toISOString()
  };
}

function discordAuthorKind(message: Message): "human" | "bot" | "webhook" | "system" {
  if (message.system) {
    return "system";
  }

  if (message.webhookId) {
    return "webhook";
  }

  return message.author.bot ? "bot" : "human";
}

async function replyToContextAskMessage(
  message: Message,
  response: DiscordContextAskResponse
): Promise<void> {
  const channel = message.channel;

  if (!channel.isSendable()) {
    throw new DiscordJsAdapterError(
      "discord-context-ask-reply-not-sendable",
      "Luma cannot reply in this Discord conversation"
    );
  }

  const nonce = discordNonce(response.idempotencyKey);

  // Discord deduplicates an enforced nonce for the same author within its
  // bounded deduplication window. Do not scan later thread history merely to
  // discover an earlier Context reply.
  await message.reply({
    content: renderDiscordMessage(response.content, discordMessageMarker(nonce)),
    allowedMentions: {
      parse: [],
      repliedUser: false
    },
    flags: MessageFlags.SuppressEmbeds,
    nonce,
    enforceNonce: true
  });
}

function createDiscordJsConversationReader(client: Client): DiscordConversationReader {
  return {
    async readThread({
      conversationObjectId
    }): Promise<DiscordConversationThread | null> {
      const thread = await discordThreadById(client, conversationObjectId);

      if (!thread) {
        return null;
      }

      return discordConversationThread(thread);
    },
    async readMessage({
      conversationObjectId,
      messageId
    }): Promise<DiscordConversationMessage | null> {
      const thread = await discordThreadById(client, conversationObjectId);

      if (!thread) {
        return null;
      }

      try {
        const message = await thread.messages.fetch({ message: messageId, force: true });
        return discordConversationMessage(message);
      } catch (error: unknown) {
        if (discordApiErrorCode(error) === 10_008) {
          return null;
        }

        throw error;
      }
    },
    async listMessagesBefore({ conversationObjectId, beforeMessageId, limit }) {
      const thread = await discordThreadById(client, conversationObjectId);

      if (!thread) {
        throw new DiscordJsAdapterError(
          "discord-conversation-thread-unavailable",
          "Discord Context Ask thread is no longer readable"
        );
      }

      const messages = await thread.messages.fetch({
        before: beforeMessageId,
        limit
      });

      return {
        messages: [...messages.values()].map(discordConversationMessage),
        hasMore: messages.size === limit
      };
    }
  };
}

async function discordThreadById(
  client: Client,
  conversationObjectId: string
): Promise<ThreadChannel | null> {
  const channel = await client.channels.fetch(conversationObjectId, { force: true });

  if (
    !channel?.isThread() ||
    channel.type !== ChannelType.PublicThread ||
    !channel.parentId
  ) {
    return null;
  }

  const parent = await client.channels.fetch(channel.parentId, { force: true });
  if (
    !parent ||
    parent.type !== ChannelType.GuildText ||
    parent.guildId !== channel.guildId
  )
    return null;
  const permissions = client.user ? channel.permissionsFor(client.user) : null;
  const parentPermissions = client.user ? parent.permissionsFor(client.user) : null;

  if (
    !permissions?.has(PermissionFlagsBits.ViewChannel) ||
    !permissions.has(PermissionFlagsBits.ReadMessageHistory) ||
    !parentPermissions?.has(PermissionFlagsBits.ViewChannel) ||
    !parentPermissions.has(PermissionFlagsBits.ReadMessageHistory)
  ) {
    return null;
  }

  return channel;
}

function discordConversationThread(thread: ThreadChannel): DiscordConversationThread {
  return {
    id: thread.id,
    guildId: thread.guildId,
    parentChannelId: thread.parentId,
    visibility: thread.type === ChannelType.PrivateThread ? "private" : "public",
    title: thread.name,
    url: thread.url
  };
}

function discordConversationMessage(message: Message): DiscordConversationMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    kind:
      message.type === MessageType.ThreadStarterMessage ? "thread-starter" : "message",
    hasUnsupportedContent:
      message.attachments.size > 0 ||
      message.embeds.length > 0 ||
      message.stickers.size > 0 ||
      message.components.length > 0 ||
      message.poll !== null ||
      message.messageSnapshots.size > 0 ||
      message.flags.has(MessageFlags.IsVoiceMessage),
    author: {
      providerUserId: message.author.id,
      displayName:
        message.member?.displayName ??
        message.author.globalName ??
        message.author.username
    },
    authorKind: discordAuthorKind(message),
    mentionedDiscordUserIds: [...message.mentions.users.keys()],
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    replyToMessageId: message.reference?.messageId ?? null,
    url: message.url
  };
}

function discordApiErrorCode(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "number"
  ) {
    return error.code;
  }

  return null;
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
    case "usage":
      return { ...base, type: "usage" };
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
    command.setName("usage").setDescription("Show shared AI usage, budget and reset time")
  )
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

function reportDiscordDeliveryFailure(event: {
  code: "discord-command-reply-failed" | "discord-context-ask-reply-failed";
  channelId: string;
  sourceId: string;
}): void {
  // Operational IDs aid delivery diagnosis; never log exceptions or message text.
  console.error("Luma Discord delivery failed", event);
}
