# Discord Bot Integration

## Current Capability

Discord is a first-class Luma conversation source and interaction surface in
the product direction. The current implementation is deliberately narrower:
it provides a persistent Meeting bot and a bounded read-only Context Ask
slice. It does not yet implement the complete Discord Ask → Verify →
Reconcile → Execute interaction model.

The Discord Module translates current Meeting interactions into
provider-independent calls to Meeting Intelligence and renders Meeting
Intelligence events back into persistent Discord threads.

Implemented now:

- guild-scoped `/meeting` slash command registration
- `/meeting start`, `/meeting note`, `/meeting approve`, `/meeting reject`, `/meeting stop`, `/meeting ask`, and `/meeting catchup`
- one persistent public Discord thread per Meeting
- durable Discord-thread-to-Meeting mapping in PGlite
- versioned Conclusion summary on Meeting stop
- provider-independent Follow-up lifecycle receipts
- typed German, English, or mixed-language notes as canonical Evidence
- deterministic provider-identity speaker attribution for typed Discord notes;
  speaker attribution remains distinct from Action Item ownership
- explicit approval before the currently implemented Meeting settlement path
- explicit Discord user mentions for Jakob, Fabius, Julius, Philipp, and configured additional People
- bot-authored messages with restricted allowed mentions
- graceful Gateway shutdown
- optional, disabled-by-default bounded `@Luma` Context Ask in reviewed public
  threads

Not implemented in this slice:

- Discord voice connection and per-user audio capture
- voice transcription, utterance revision, and correction UI
- bounded Discord Verify, Reconcile, and risk-authorized Execute interactions
- Discord voice identity/audio evidence spike; voiceprints and biometric
  recognition are not a default path

With OpenAI configured, typed notes are analyzed through the production ReasoningModel Adapter. Without it, Luma still persists the original note and reports that analysis is deferred rather than producing unsupported claims.

## LUM-4 Activation Gate

This guide describes the current code and its technical configuration; it is
not authorization to enable a live Dayova Discord collection surface. Do not
turn on Context Ask, Message Content, broad content capture, lifecycle
observation, cross-channel retrieval, or execution merely because the
following setup is available.

Before any live Discord content use, the LUM-4 owner must record decisions
for all of the following:

1. approved channel/role scope, deterministic capture boundaries, and
   participant notice or consent;
2. raw-text retention, deletion or redaction, tombstones, downtime gaps, and
   downstream invalidation;
3. retrieval permissions, roles, redaction, and audience intersection across
   Discord, Notion, Linear, and GitHub; and
4. explicit cross-source association rules that never auto-merge Discord
   conversations into Meeting Notes.

Message Content, technical allowlists, and a valid token are prerequisites,
not policy approval. Until the LUM-4 activation gate is satisfied (the owner
has recorded all four decisions and the required follow-up implementation is
delivered), use deterministic fixtures and programmable adapters only.

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
6. Leave privileged Gateway intents disabled for the standard Meeting bot. Only
   if the optional Context Ask configuration is deliberately enabled, turn on
   **Message Content Intent** under **Bot > Privileged Gateway Intents** (and
   obtain any Discord-required approval first). Context Ask then requests only
   `Guilds`, `GuildMessages`, and `MessageContent`; it does not request member,
   presence, reaction, or DM intents.

The bot registers `/meeting` as a guild command at startup. These technical
details apply only after the [LUM-4 activation gate](#lum-4-activation-gate)
is satisfied; they do not override it. Discord documents
command registration and guild scoping in its [Application Commands reference](https://docs.discord.com/developers/interactions/application-commands).

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

The resulting permission integer is `309237713920`. Read Message History lets Luma find a reserved thread after Discord has auto-archived it and verify bot-owned lifecycle markers during durable retry recovery. The standard Meeting bot does not ingest member message content. The optional Context Ask capability below is separately opt-in and bounded. The Developer Portal installation builder can generate the install URL; using the builder avoids hand-editing OAuth2 URLs. Discord's current permission flags are documented in the [Permissions reference](https://docs.discord.com/developers/topics/permissions).

Do not grant Administrator, Manage Server, Manage Roles, Manage Webhooks, or
Manage Messages. The standard Meeting bot slice uses no privileged intents.

For the optional Context Ask slice, `Message Content` is the one exception:
Discord applies it to both Gateway events and message-history reads. The bot
still needs only View Channels, Read Message History, and Send Messages in
Threads in the explicitly allowlisted channels. These technical bounds do not
lift the [LUM-4 activation gate](#lum-4-activation-gate).

## Environment

Required:

```dotenv
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
```

Optional bounded Context Ask (off unless the exact `1` flag is set):

```dotenv
LUMA_DISCORD_CONTEXT_ASK_ENABLED=0
LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS=
LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS=
LUMA_DISCORD_CONTEXT_ASK_MAX_MESSAGES=50
LUMA_DISCORD_CONTEXT_ASK_MAX_EVIDENCE_CHARS=32000
LUMA_DISCORD_CONTEXT_ASK_MIN_INTERVAL_MS=60000
```

An enabled Context Ask configuration needs an OpenAI key and every allowlist
variable. Invalid or incomplete values fail startup before the bot connects.

Recommended local settings:

```dotenv
LUMA_WORKSPACE_ID=workspace_dayova
LUMA_DEFAULT_WORKSPACE_TIMEZONE=Europe/Berlin
LUMA_PGLITE_DATA_DIR=.luma/pglite
```

`DISCORD_TOKEN` is a secret. Never commit it, paste it into issues, or reuse the same token across development and production. Before any live Discord rollout, follow the [credential-rotation runbook](../configuration/discord-token-rotation.md) and record only its non-secret proof on the rollout ticket.

## Running The Development Bot (After The Activation Gate)

```bash
cp .env.example .env
pnpm dev
```

`pnpm dev` builds TypeScript, loads `.env`, registers the guild command, connects the Discord Gateway, and prints a single connection message. Stop with `Ctrl+C`; Luma closes the Gateway and local database cleanly.

Do not use this command with a Dayova or shared Discord Application before the
[LUM-4 activation gate](#lum-4-activation-gate) is satisfied. Until then, use
the deterministic test suite and programmable adapters without Discord
credentials.

## Commands

### Start

```text
/meeting start title:"Product Meeting" language:"German and English"
```

Creates a public thread in the current text channel, persists the mapping, records a `meeting-started` Observation, and posts the first thread message.

Only one active Meeting is allowed per parent channel. Retrying start while a Meeting is active returns its existing thread instead of opening another one.

### Note

```text
/meeting note text:"Ich übernehme die release checklist bis Montag." language:"German and English"
```

Stores the exact typed text as an `utterance-committed` Observation with a
deterministic provider-identity speaker attribution for the Discord actor. It
preserves German, English, and mixed language and returns any evidence-grounded
Follow-up Intent IDs proposed by the ReasoningModel. Speaker attribution does
not by itself confirm who owns resulting work; a generic model-proposed
`create-work-item` Intent is intentionally non-executable until it carries the
same durable ownership proof as the source-bound reconciliation path.

### Approve

```text
/meeting approve intent_id:"intent_create_release_checklist"
```

Records explicit Human approval and attempts exactly that Intent. The current
source-bound settlement may mutate Linear only for confirmed mapped ownership,
or for a Human-explicit intentionally-unassigned decision with a null
assignee. Proposed or unresolved ownership never mutates Linear. Generic
model-created work Intents are deliberately rejected until they carry durable
ownership attribution. The bot posts an idempotent receipt and tags only the
relevant mapped People.

### Reject

```text
/meeting reject intent_id:"intent_create_release_checklist" reason:"Already tracked in DAY-180"
```

Records Human rejection and performs no provider mutation. Rejected Intents cannot later be approved without a new proposal.

### Ask

```text
/meeting ask question:"What did we decide about the release?"
```

Resolves the active Meeting from the current thread or its parent channel and returns a private, evidence-aware answer. Known Discord user IDs are resolved to internal People so participant-specific Action Items can be selected.

### Context Ask (opt-in)

The bounded implementation exists, but it is not currently authorized for
live Dayova content. The [LUM-4 activation gate](#lum-4-activation-gate) must
be satisfied before this section can be used as a rollout procedure.

In an allowlisted **public thread**, an allowlisted person can write:

```text
@Luma What did we decide about the release?
```

Luma captures current thread history from its beginning through the mention,
stores an immutable human-text conversation-evidence revision, and replies in
the same thread with a cited, read-only answer only when that boundary is
complete. The user mention
must be leading and exact; nonleading mentions, bots, webhooks, system
messages, private threads, DMs, and channels outside the reviewed scope are
ignored without capture.

The first slice does not retain later Discord edit/delete events. It does not
answer from a truncated boundary or one containing unreadable/non-text or
bot/webhook/system evidence. It never creates a Meeting, proposal, Intent,
Linear issue, Notion page, or any other Follow-up mutation. This is an
implemented bounded limitation, not a permanent statement that Discord
conversations cannot later feed the shared Evidence, reconciliation,
authorization, and execution core.

Replies use an anchor-derived [enforced Discord nonce](https://docs.discord.com/developers/resources/message#create-message), which deduplicates recent Gateway repeats within Discord's bounded nonce window. This tracer slice does not yet provide a durable Discord reply outbox for exactly-once delivery across an arbitrarily delayed restart.

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

## Development Smoke Test (After The Activation Gate)

Do not perform this while the [LUM-4 activation gate](#lum-4-activation-gate)
applies. Until it is satisfied, use the deterministic test suite and
programmable adapters without Discord credentials.

After the development Application is installed and `.env` is populated:

1. Run `pnpm dev`.
2. Confirm `Luma Discord bot connected in development mode` appears.
3. Confirm `/meeting` appears in the configured server.
4. Run `/meeting start` in a normal text channel.
5. Confirm Luma creates a public thread and replies privately with its link.
6. Run `/meeting note` in the thread and confirm the original note is saved.
7. Run `/meeting reject` for any proposed Intent and confirm it performs no
   provider mutation.
8. Run `/meeting catchup` and confirm the response is private.

Do not use this development smoke test to exercise approval, Linear, or Notion
mutations. Those require their own source-bound authorization and rollout
evidence outside this dormant Discord documentation path.

9. Run `/meeting stop` and confirm the Conclusion appears in the thread.
10. Restart the bot and confirm `.luma/pglite` preserves thread and execution records.

## Architecture

`DiscordTransport` is an owned Interface. The `discord.js` production Adapter and programmable test Adapter sit behind it. A separate Discord-owned conversation reader implements the provider-neutral `ConversationEvidenceSource` port for optional Context Ask. Discord SDK types do not enter Context Intelligence, Meeting Intelligence, domain models, Follow-up Execution, or provider capability Interfaces.

The Discord Module calls only:

```ts
meetingIntelligence.observe(...);
meetingIntelligence.query(...);
meetingIntelligence.conclude(...);
```

Voice transport will later produce transcription Observations through a separate transcription Module. It must not add audio or Discord SDK types to the Meeting Intelligence Interface.

Within the current bounded slice, Context Ask calls only:

```ts
contextIntelligence.inquire(...);
```

It has no path to Meeting Intelligence, Follow-up Execution, WorkProvider, or
KnowledgeProvider operations. A later Discord Verify, Reconcile, or Execute
capability must reuse the shared Luma core rather than bypassing it from the
Discord Adapter.
