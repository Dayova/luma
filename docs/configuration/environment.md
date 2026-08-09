# Environment Configuration

Provider configuration belongs at Adapter boundaries. Meeting Intelligence never reads provider credentials or imports provider SDK types.

## Local Setup

```bash
cp .env.example .env
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

`.env` is ignored by git. `pnpm dev` builds the application and loads it with Node's `--env-file=.env` support. Configure separate `.env` values and separate provider Applications for development and production.

The Discord variables are required to start the executable bot. Linear, Notion, and OpenAI are optional capability groups: omitting a whole group leaves that capability unavailable. Setting only part of a group fails startup with the missing variable name.

## System Ownership And Current Write Gate

- **Linear** is the sole canonical system for executable work.
- **Notion** is canonical knowledge and holds the raw Meeting Note source
  record. Luma preserves that source and adds only a compact, marker-owned
  Operational Outcome during an authorized source-bound settlement.
- **GitHub** is canonical implementation evidence: code, pull requests,
  reviews, and CI. Synced GitHub Issues are compatibility mirrors, not a
  second task system.
- **Discord** is live collaboration, a first-class conversation source, and a
  Luma interaction surface.
- **Luma** owns context, Evidence, attribution, reconciliation,
  authorization, idempotent execution, identity mapping, auditability, and
  lifecycle.

The current source-bound Linear settlement gate is deliberately strict:

- `confirmed` ownership may map its Person through the Identity Directory to a
  Linear assignee;
- only a Human-explicit `intentionally-unassigned` ownership decision may
  create work with a `null` assignee;
- `proposed` and `unresolved` ownership never create, update, or assign
  canonical work, and require targeted clarification instead;
- generic `create-work-item` Intents are currently rejected until they carry
  the same durable ownership proof.

LUM-6, LUM-7, and LUM-8 remain incomplete; this gate describes the safety
contract for their current foundation, not a claim that the full settlement
wedge is finished.

## Linear Setup

Create an API key in Linear workspace settings under **Security & access > API**, then set:

```dotenv
LINEAR_API_KEY=lin_api_...
LINEAR_TEAM_ID=63c160e7-ab70-4ef9-9822-0f85590ebb7f
LUMA_LINEAR_PROVIDER_ID=linear
```

The key's Linear user must be able to read and create issues in the Dayova
team. For a permitted source-bound settlement, Follow-up Execution resolves a
**confirmed** internal owner to a Linear member UUID. It never falls back to an
unassigned issue when that mapping is missing; only a Human-explicit
intentionally-unassigned decision permits a null assignee. The Adapter adds
mentioned People as subscribers and stores an idempotency marker in the issue
description.

Use a development key for the development bot and a production integration identity for production. Do not put the key in Discord, Linear issues, Notion pages, logs, or commits.

## Notion Setup

Create a Notion internal integration, copy its secret, and connect it to the Dayova **Meetings** data source. The integration needs permission to read content, insert content, and update content. Then set:

```dotenv
NOTION_API_TOKEN=ntn_...
NOTION_MEETINGS_DATA_SOURCE_ID=3982e872-28bf-8080-bf00-000b188b90d6
NOTION_MEETINGS_TITLE_PROPERTY=Name
NOTION_MEETINGS_ATTENDEES_PROPERTY=Attendees
LUMA_NOTION_PROVIDER_ID=notion
LUMA_NOTION_MEETING_SYNC_INTERVAL_MS=60000
```

`Name` must be the title property. `Attendees` must be a People property. The
configured source is used to discover and read raw Notion Meeting Notes, not
to replace them with a second final Meeting record. The in-progress
Notion-to-Linear settlement wedge writes its compact Luma-owned Operational
Outcome to the original source note; it does not rewrite transcript, summary,
or source Action Items.

If Notion returns `object_not_found`, reconnect the integration to the Meetings data source and verify that the data-source ID, rather than a page URL fragment from another database, is configured.

## OpenAI Setup

```dotenv
OPENAI_API_KEY=sk-...
LUMA_REASONING_MODEL_PROVIDER=openai
LUMA_REASONING_MODEL_NAME=gpt-5.6-luna
```

The OpenAI SDK sits behind Luma's owned `ReasoningModel` Interface. The Adapter uses the Responses API with strict Structured Outputs. `gpt-5.6-luna` is the default cost-sensitive model; override it per environment when a different quality/cost point is required.

When `OPENAI_API_KEY` is absent, Luma still persists original Evidence and reports analysis as deferred. Set `LUMA_REASONING_MODEL_PROVIDER=disabled` to make that behavior explicit.

## Discord Setup

```dotenv
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
```

See `docs/integrations/discord.md` for Application creation, installation permissions, command behavior, and smoke testing. Never reuse the development token in production.

### Optional bounded Context Ask

Discord Context Ask is deliberately off by default. It is the currently
implemented, read-only `@Luma question` slice in specifically reviewed
**public threads**, not a Meeting command and not a server-wide listener. It
is a bounded implementation limitation, not Luma's permanent product
boundary: Verify, Reconcile, and Execute remain future shared-core work.
Enable it only after the
Application's **Message Content** privileged Gateway intent has been enabled
(and approved if Discord requires it for the Application):

```dotenv
LUMA_DISCORD_CONTEXT_ASK_ENABLED=1
LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS=123456789012345678
LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS=779381502311137301
LUMA_DISCORD_CONTEXT_ASK_MAX_MESSAGES=50
LUMA_DISCORD_CONTEXT_ASK_MAX_EVIDENCE_CHARS=32000
LUMA_DISCORD_CONTEXT_ASK_MIN_INTERVAL_MS=60000
```

All three limits are hard-validated. The channel and user allowlists are
mandatory; an incomplete attempted enablement fails before the Discord Gateway
connects. Luma captures only text history ending at the triggering mention. A
truncated, unreadable, non-text, bot, webhook, or system message produces an
explicit incomplete boundary and no model answer. Captures are immutable Luma
evidence even if Discord messages later change or disappear; this slice does
not subscribe to edit/deletion retention events.

## GitHub App Setup

The GitHub Issues WorkProvider remains available for compatibility and testing. It is not the default runtime WorkProvider after DAY-39. GitHub code access remains a separate CodeProvider concern.

For bot-authored GitHub activity:

```dotenv
GITHUB_REPOSITORY=Dayova/dayova-mvp
GITHUB_APP_ID=
GITHUB_APP_INSTALLATION_ID=
GITHUB_APP_PRIVATE_KEY_BASE64=
```

Required GitHub App repository permissions are Metadata read and Issues read/write. For a local user-authored fallback only:

```bash
export GITHUB_TOKEN="$(gh auth token)"
export GITHUB_REPOSITORY="Dayova/dayova-mvp"
```

## Variable Reference

| Variable                                            | Required         | Owner                    | Purpose                                                                    |
| --------------------------------------------------- | ---------------- | ------------------------ | -------------------------------------------------------------------------- |
| `NODE_ENV`                                          | No               | App                      | `development`, `test`, or `production`; defaults to development.           |
| `LUMA_DEFAULT_WORKSPACE_TIMEZONE`                   | No               | App                      | Defaults to `Europe/Berlin`; used for relative dates.                      |
| `LUMA_WORKSPACE_ID`                                 | No               | App                      | Defaults to `workspace_dayova`.                                            |
| `LUMA_PGLITE_DATA_DIR`                              | No               | Persistence              | Durable local database directory; defaults to `.luma/pglite`.              |
| `DATABASE_URL`                                      | Planned          | Persistence              | Future production PostgreSQL connection.                                   |
| `LINEAR_API_KEY`                                    | With Linear      | Linear WorkProvider      | API credential for issue reads and mutations.                              |
| `LINEAR_TEAM_ID`                                    | With Linear      | Linear WorkProvider      | Team receiving approved work items.                                        |
| `LINEAR_API_URL`                                    | No               | Linear WorkProvider      | Defaults to `https://api.linear.app/graphql`.                              |
| `LUMA_LINEAR_PROVIDER_ID`                           | No               | Linear WorkProvider      | External reference namespace; defaults to `linear`.                        |
| `NOTION_API_TOKEN`                                  | With Notion      | Notion KnowledgeProvider | Internal integration secret.                                               |
| `NOTION_MEETINGS_DATA_SOURCE_ID`                    | With Notion      | Notion KnowledgeProvider | Parent data source for raw Notion Meeting Notes.                           |
| `NOTION_MEETINGS_TITLE_PROPERTY`                    | No               | Notion KnowledgeProvider | Defaults to `Name`.                                                        |
| `NOTION_MEETINGS_ATTENDEES_PROPERTY`                | No               | Notion KnowledgeProvider | Defaults to `Attendees`.                                                   |
| `LUMA_NOTION_PROVIDER_ID`                           | No               | Notion KnowledgeProvider | External reference namespace; defaults to `notion`.                        |
| `LUMA_NOTION_MEETING_SYNC_INTERVAL_MS`              | No               | Meeting Notes source     | Full canonical source scan interval in milliseconds; defaults to `60000`.  |
| `OPENAI_API_KEY`                                    | For analysis     | ReasoningModel           | OpenAI API credential.                                                     |
| `LUMA_REASONING_MODEL_PROVIDER`                     | No               | ReasoningModel           | `openai` by default; `disabled` defers analysis.                           |
| `LUMA_REASONING_MODEL_NAME`                         | No               | ReasoningModel           | Defaults to `gpt-5.6-luna`.                                                |
| `DISCORD_TOKEN`                                     | For bot          | Discord Adapter          | Secret Gateway and REST token.                                             |
| `DISCORD_CLIENT_ID`                                 | For bot          | Discord Adapter          | Discord Application ID.                                                    |
| `DISCORD_GUILD_ID`                                  | For bot          | Discord Adapter          | Server receiving guild-scoped commands.                                    |
| `LUMA_DISCORD_CONTEXT_ASK_ENABLED`                  | No; exact `1`    | Discord Context Ask      | Enables the separately scoped, read-only thread Ask runtime.               |
| `LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS`       | With Context Ask | Discord Context Ask      | Comma-separated parent-channel allowlist for public threads.               |
| `LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS` | With Context Ask | Discord Context Ask      | Comma-separated Discord-user allowlist for mentions.                       |
| `LUMA_DISCORD_CONTEXT_ASK_MAX_MESSAGES`             | With Context Ask | Discord Context Ask      | Bounded captured messages, default `50`, hard ceiling `500`.               |
| `LUMA_DISCORD_CONTEXT_ASK_MAX_EVIDENCE_CHARS`       | With Context Ask | Discord Context Ask      | Bounded captured text, default `32000`, hard ceiling `64000`.              |
| `LUMA_DISCORD_CONTEXT_ASK_MIN_INTERVAL_MS`          | With Context Ask | Discord Context Ask      | Per-user/per-thread admission interval, `1000`–`3600000`, default `60000`. |
| `LUMA_IDENTITY_PEOPLE_JSON`                         | No               | Identity Directory       | Extends or overrides built-in provider identities.                         |
| `GITHUB_REPOSITORY`                                 | GitHub only      | GitHub Adapter           | Target as `owner/repo`.                                                    |
| `GITHUB_APP_ID`                                     | GitHub App auth  | GitHub Adapter           | App identity used for JWT auth.                                            |
| `GITHUB_APP_INSTALLATION_ID`                        | GitHub App auth  | GitHub Adapter           | Installation receiving access tokens.                                      |
| `GITHUB_APP_PRIVATE_KEY`                            | GitHub App auth  | GitHub Adapter           | PEM with real or escaped newlines.                                         |
| `GITHUB_APP_PRIVATE_KEY_BASE64`                     | Alternative      | GitHub Adapter           | Single-line alternative to the PEM variable.                               |
| `GITHUB_TOKEN`                                      | Local fallback   | GitHub Adapter           | User-attributed token, optionally from `gh`.                               |
| `LUMA_GITHUB_CODE_PROVIDER_ID`                      | Planned          | GitHub CodeProvider      | Separate GitHub code-context namespace.                                    |
| `LUMA_LIVE_LINEAR_TESTS`                            | No               | Tests                    | Set to `1` for non-mutating live validation.                               |
| `LUMA_LIVE_NOTION_TESTS`                            | No               | Tests                    | Set to `1` for non-mutating live validation.                               |
| `LUMA_LIVE_GITHUB_TESTS`                            | No               | Tests                    | Set to `1` for the GitHub compatibility smoke test.                        |

## Security Rules

- Never commit `.env`, provider keys, private-key files, or copied tokens.
- Rotate a credential immediately if it appears in chat, an issue, a page, or a log.
- Before a live Discord rollout, complete the [Discord credential-rotation
  runbook](discord-token-rotation.md); it intentionally records only non-secret
  rotation proof.
- Do not log provider request headers or complete environment objects.
- Keep development and production credentials separate.
- Grant only the provider access documented for the active capability.
- Keep SDKs, MCP tools, CLIs, and provider IDs out of Meeting Intelligence domain state.
- The current Meeting settlement implementation requires an approved,
  source-bound Follow-up Intent and a durable idempotency key. Product policy
  may later allow an authorized explicit write instruction for safe,
  unambiguous operations; that broader authorization path is not implemented
  by the bounded Context Ask slice.

See `docs/configuration/identity.md` for the built-in Person mappings.
