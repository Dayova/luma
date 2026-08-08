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

## Ownership Rule

- **Linear** owns executable work. Approved `create-work-item` Follow-up Intents create Linear issues.
- **Notion** owns Meeting records, decisions, and organizational knowledge. Approved `record-meeting` Follow-up Intents create pages in the Meetings data source.
- **GitHub** owns code, pull requests, reviews, and CI. The Linear integration may expose synced GitHub Issues as a compatibility surface; Luma does not create a second task independently.
- **Discord** owns the live Meeting interaction and receipt surface.

This implements the task-pipeline decisions in DAY-39, GitHub #20, and DAY-175.

## Linear Setup

Create an API key in Linear workspace settings under **Security & access > API**, then set:

```dotenv
LINEAR_API_KEY=lin_api_...
LINEAR_TEAM_ID=63c160e7-ab70-4ef9-9822-0f85590ebb7f
LUMA_LINEAR_PROVIDER_ID=linear
```

The key's Linear user must be able to read and create issues in the Dayova team. Follow-up Execution resolves internal assignee and mention IDs to Linear member UUIDs. The Adapter adds mentioned People as subscribers and stores an idempotency marker in the issue description.

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

`Name` must be the title property. `Attendees` must be a People property. Follow-up Execution maps Meeting participants to Notion user IDs before creating a Meeting record. The page contains the Conclusion summary, decisions, Action Items, open questions, risks, provenance revision, and an idempotency marker.

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

| Variable                               | Required        | Owner                    | Purpose                                                                   |
| -------------------------------------- | --------------- | ------------------------ | ------------------------------------------------------------------------- |
| `NODE_ENV`                             | No              | App                      | `development`, `test`, or `production`; defaults to development.          |
| `LUMA_DEFAULT_WORKSPACE_TIMEZONE`      | No              | App                      | Defaults to `Europe/Berlin`; used for relative dates.                     |
| `LUMA_WORKSPACE_ID`                    | No              | App                      | Defaults to `workspace_dayova`.                                           |
| `LUMA_PGLITE_DATA_DIR`                 | No              | Persistence              | Durable local database directory; defaults to `.luma/pglite`.             |
| `DATABASE_URL`                         | Planned         | Persistence              | Future production PostgreSQL connection.                                  |
| `LINEAR_API_KEY`                       | With Linear     | Linear WorkProvider      | API credential for issue reads and mutations.                             |
| `LINEAR_TEAM_ID`                       | With Linear     | Linear WorkProvider      | Team receiving approved work items.                                       |
| `LINEAR_API_URL`                       | No              | Linear WorkProvider      | Defaults to `https://api.linear.app/graphql`.                             |
| `LUMA_LINEAR_PROVIDER_ID`              | No              | Linear WorkProvider      | External reference namespace; defaults to `linear`.                       |
| `NOTION_API_TOKEN`                     | With Notion     | Notion KnowledgeProvider | Internal integration secret.                                              |
| `NOTION_MEETINGS_DATA_SOURCE_ID`       | With Notion     | Notion KnowledgeProvider | Parent data source for approved Meeting records.                          |
| `NOTION_MEETINGS_TITLE_PROPERTY`       | No              | Notion KnowledgeProvider | Defaults to `Name`.                                                       |
| `NOTION_MEETINGS_ATTENDEES_PROPERTY`   | No              | Notion KnowledgeProvider | Defaults to `Attendees`.                                                  |
| `LUMA_NOTION_PROVIDER_ID`              | No              | Notion KnowledgeProvider | External reference namespace; defaults to `notion`.                       |
| `LUMA_NOTION_MEETING_SYNC_INTERVAL_MS` | No              | Meeting Notes source     | Full canonical source scan interval in milliseconds; defaults to `60000`. |
| `OPENAI_API_KEY`                       | For analysis    | ReasoningModel           | OpenAI API credential.                                                    |
| `LUMA_REASONING_MODEL_PROVIDER`        | No              | ReasoningModel           | `openai` by default; `disabled` defers analysis.                          |
| `LUMA_REASONING_MODEL_NAME`            | No              | ReasoningModel           | Defaults to `gpt-5.6-luna`.                                               |
| `DISCORD_TOKEN`                        | For bot         | Discord Adapter          | Secret Gateway and REST token.                                            |
| `DISCORD_CLIENT_ID`                    | For bot         | Discord Adapter          | Discord Application ID.                                                   |
| `DISCORD_GUILD_ID`                     | For bot         | Discord Adapter          | Server receiving guild-scoped commands.                                   |
| `LUMA_IDENTITY_PEOPLE_JSON`            | No              | Identity Directory       | Extends or overrides built-in provider identities.                        |
| `GITHUB_REPOSITORY`                    | GitHub only     | GitHub Adapter           | Target as `owner/repo`.                                                   |
| `GITHUB_APP_ID`                        | GitHub App auth | GitHub Adapter           | App identity used for JWT auth.                                           |
| `GITHUB_APP_INSTALLATION_ID`           | GitHub App auth | GitHub Adapter           | Installation receiving access tokens.                                     |
| `GITHUB_APP_PRIVATE_KEY`               | GitHub App auth | GitHub Adapter           | PEM with real or escaped newlines.                                        |
| `GITHUB_APP_PRIVATE_KEY_BASE64`        | Alternative     | GitHub Adapter           | Single-line alternative to the PEM variable.                              |
| `GITHUB_TOKEN`                         | Local fallback  | GitHub Adapter           | User-attributed token, optionally from `gh`.                              |
| `LUMA_GITHUB_CODE_PROVIDER_ID`         | Planned         | GitHub CodeProvider      | Separate GitHub code-context namespace.                                   |
| `LUMA_LIVE_LINEAR_TESTS`               | No              | Tests                    | Set to `1` for non-mutating live validation.                              |
| `LUMA_LIVE_NOTION_TESTS`               | No              | Tests                    | Set to `1` for non-mutating live validation.                              |
| `LUMA_LIVE_GITHUB_TESTS`               | No              | Tests                    | Set to `1` for the GitHub compatibility smoke test.                       |

## Security Rules

- Never commit `.env`, provider keys, private-key files, or copied tokens.
- Rotate a credential immediately if it appears in chat, an issue, a page, or a log.
- Do not log provider request headers or complete environment objects.
- Keep development and production credentials separate.
- Grant only the provider access documented for the active capability.
- Keep SDKs, MCP tools, CLIs, and provider IDs out of Meeting Intelligence domain state.
- External mutations require an approved Follow-up Intent and use a durable idempotency key.

See `docs/configuration/identity.md` for the built-in Person mappings.
