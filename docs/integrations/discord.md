# Discord Bot Integration

## Current Capability

Discord is Luma's primary meeting surface. The Discord Module translates Discord interactions into provider-independent calls to Meeting Intelligence and renders Meeting Intelligence events back into persistent Discord threads.

Implemented now:

- guild-scoped `/meeting` slash command registration
- `/meeting start`, `/meeting stop`, `/meeting ask`, and `/meeting catchup`
- one persistent public Discord thread per Meeting
- durable Discord-thread-to-Meeting mapping in PGlite
- versioned Conclusion summary on Meeting stop
- provider-independent Follow-up lifecycle receipts
- explicit Discord user mentions for Jakob, Fabius, Julius, Philipp, and configured additional People
- bot-authored messages with restricted allowed mentions
- graceful Gateway shutdown

Not implemented in this slice:

- Discord voice connection and per-user audio capture
- transcription and utterance revision
- the production ReasoningModel Adapter
- `/meeting approve`, `/meeting reject`, and correction UI
- automatic wiring from Follow-up Execution to the running Discord bot

Until transcription and the production ReasoningModel Adapter are connected, `/meeting ask` and `/meeting catchup` correctly return insufficient evidence rather than producing unsupported claims.

## Discord Application Setup

Create separate Discord Applications for development and production. Suggested names:

- `Dayova Luma Dev`
- `Dayova Luma`

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Create or open the Application.
2. Open **Bot** and create/reset the bot token.
3. Put the token in the matching environment as `DISCORD_TOKEN`.
4. Copy the Application ID from **General Information** into `DISCORD_CLIENT_ID`.
5. Enable Discord Developer Mode, copy the target server ID, and set `DISCORD_GUILD_ID`.
6. Do not enable privileged Gateway intents. The current Adapter requests only `Guilds`.

The bot registers `/meeting` as a guild command at startup. Guild commands update immediately and are appropriate for the current private Dayova deployment. Discord documents command registration and guild scoping in its [Application Commands reference](https://docs.discord.com/developers/interactions/application-commands).

## Installation Scopes And Permissions

Install the Application to the server with these OAuth2 scopes:

- `bot`
- `applications.commands`

Grant only these bot permissions:

- View Channels
- Send Messages
- Create Public Threads
- Send Messages in Threads
- Read Message History

The resulting permission integer is `309237713920`. Read Message History lets Luma find a reserved thread after Discord has auto-archived it and verify bot-owned lifecycle markers during durable retry recovery. Luma does not ingest member message content in this slice. The Developer Portal installation builder can generate the install URL; using the builder avoids hand-editing OAuth2 URLs. Discord's current permission flags are documented in the [Permissions reference](https://docs.discord.com/developers/topics/permissions).

Do not grant Administrator, Manage Server, Manage Roles, Manage Webhooks, Manage Messages, or privileged intents for this slice.

## Environment

Required:

```dotenv
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
```

Recommended local settings:

```dotenv
LUMA_WORKSPACE_ID=workspace_dayova
LUMA_DEFAULT_WORKSPACE_TIMEZONE=Europe/Berlin
LUMA_PGLITE_DATA_DIR=.luma/pglite
```

`DISCORD_TOKEN` is a secret. Never commit it, paste it into issues, or reuse the same token across development and production.

## Running The Development Bot

```bash
cp .env.example .env
npm run dev
```

`npm run dev` builds TypeScript, loads `.env`, registers the guild command, connects the Discord Gateway, and prints a single connection message. Stop with `Ctrl+C`; Luma closes the Gateway and local database cleanly.

## Commands

### Start

```text
/meeting start title:"Product Meeting" language:"German and English"
```

Creates a public thread in the current text channel, persists the mapping, records a `meeting-started` Observation, and posts the first thread message.

Only one active Meeting is allowed per parent channel. Retrying start while a Meeting is active returns its existing thread instead of opening another one.

### Ask

```text
/meeting ask question:"What did we decide about the release?"
```

Resolves the active Meeting from the current thread or its parent channel and returns a private, evidence-aware answer. Known Discord user IDs are resolved to internal People so participant-specific Action Items can be selected.

### Catch Up

```text
/meeting catchup since_revision:4
```

Returns a private grounded update from the requested Meeting Revision. The revision defaults to `0` when omitted.

### Stop

```text
/meeting stop
```

Records a `meeting-ended` Observation, obtains a versioned Conclusion through Meeting Intelligence, posts the brief summary in the Meeting thread, and closes the active thread mapping.

## Follow-up Receipts

The Discord Module renders provider-independent `MeetingIntelligenceEvent` values. It supports:

- approval needed
- execution started
- execution succeeded
- partial success requiring attention
- failure and retry availability
- Action Item status changes
- final Meeting follow-up completion

External links are rendered from provider-neutral `ExternalReference` values. Discord IDs are resolved by the Identity Directory. Messages set `allowed_mentions.parse` to an empty list and explicitly allow only the resolved user IDs, preventing generated text from triggering `@everyone`, roles, or unintended users.

## Live Smoke Test

After the development Application is installed and `.env` is populated:

1. Run `npm run dev`.
2. Confirm `Luma Discord bot connected in development mode` appears.
3. Confirm `/meeting` appears in the configured server.
4. Run `/meeting start` in a normal text channel.
5. Confirm Luma creates a public thread and replies privately with its link.
6. Run `/meeting ask` in the thread and confirm it reports insufficient evidence.
7. Run `/meeting catchup` and confirm the response is private.
8. Run `/meeting stop` and confirm the Conclusion appears in the thread.
9. Restart the bot and confirm the `.luma/pglite` directory preserves prior thread mappings.

## Architecture

`DiscordTransport` is an owned Interface. The `discord.js` production Adapter and programmable test Adapter sit behind it. Discord SDK types do not enter Meeting Intelligence, domain models, Follow-up Execution, or provider capability Interfaces.

The Discord Module calls only:

```ts
meetingIntelligence.observe(...);
meetingIntelligence.query(...);
meetingIntelligence.conclude(...);
```

Voice transport will later produce transcription Observations through a separate transcription Module. It must not add audio or Discord SDK types to the Meeting Intelligence Interface.
