# Environment Configuration

This document defines Luma's environment variables and which Module owns each one.

Runtime code must keep provider configuration at Adapter seams. Meeting Intelligence must not read provider-specific environment variables, import provider SDKs, or depend on development-only tools such as `gh`.

## Loading Environment

For local development, copy:

```bash
cp .env.example .env
```

Then fill in the values you need. `.env` is ignored by git.

The current code does not auto-load `.env`; pass environment variables through your shell, test runner, process manager, or a future app bootstrap loader. For one-off shell usage:

```bash
set -a
source .env
set +a
```

## GitHub App Auth For Bot-authored Activity

Use GitHub App installation authentication for production. This is what makes GitHub show issues and comments as the App bot rather than a human user.

Minimum GitHub App repository permissions for the current WorkProvider:

- Metadata: read
- Issues: read and write

Required env:

```bash
GITHUB_REPOSITORY=Dayova/dayova-mvp
GITHUB_APP_ID=12345
GITHUB_APP_INSTALLATION_ID=67890
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
```

For env stores that dislike multiline values, use:

```bash
GITHUB_APP_PRIVATE_KEY_BASE64="$(base64 -i path/to/private-key.pem)"
```

If GitHub App credentials are present, the Adapter ignores `GITHUB_TOKEN` and uses an installation access token.

## GitHub CLI Shortcut

The GitHub CLI is acceptable for local development only. A `gh` token is user-authored, so issues/comments will appear as the GitHub user, not as the bot.

```bash
export GITHUB_TOKEN="$(gh auth token)"
export GITHUB_REPOSITORY="Dayova/dayova-mvp"
```

If this local repo has a GitHub remote, `GITHUB_REPOSITORY` can be derived:

```bash
export GITHUB_REPOSITORY="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
```

The primary GitHub Issues target for this workspace is `Dayova/dayova-mvp`. If this local repo has no GitHub remote, keep `GITHUB_REPOSITORY` set manually.

## Variables

| Variable                          | Required now    | Owner                        | Description                                                            |
| --------------------------------- | --------------- | ---------------------------- | ---------------------------------------------------------------------- |
| `NODE_ENV`                        | No              | App                          | Runtime mode. Defaults to `development`.                               |
| `LUMA_DEFAULT_WORKSPACE_TIMEZONE` | No              | App                          | Default workspace timezone. Defaults to `Europe/Berlin`.               |
| `DATABASE_URL`                    | No              | Persistence                  | Planned production PostgreSQL connection. Current tests use PGlite.    |
| `GITHUB_REPOSITORY`               | For live GitHub | GitHub Issues WorkProvider   | Target repository as `owner/repo`.                                     |
| `GITHUB_APP_ID`                   | Preferred       | GitHub Issues WorkProvider   | GitHub App ID used to sign a JWT for bot-authored activity.            |
| `GITHUB_APP_INSTALLATION_ID`      | Preferred       | GitHub Issues WorkProvider   | Installation ID for the target account/repository.                     |
| `GITHUB_APP_PRIVATE_KEY`          | Preferred       | GitHub Issues WorkProvider   | GitHub App private key PEM, with real or escaped newlines.             |
| `GITHUB_APP_PRIVATE_KEY_BASE64`   | Preferred       | GitHub Issues WorkProvider   | Base64 encoded private key PEM alternative.                            |
| `GITHUB_TOKEN`                    | Fallback only   | GitHub Issues WorkProvider   | User-authored local fallback. Can come from `gh auth token`.           |
| `GITHUB_API_BASE_URL`             | No              | GitHub Issues WorkProvider   | GitHub REST base URL. Defaults to `https://api.github.com`.            |
| `LUMA_GITHUB_WORK_PROVIDER_ID`    | No              | GitHub Issues WorkProvider   | Provider ID for Work external references. Defaults to `github-issues`. |
| `LUMA_GITHUB_USER_AGENT`          | No              | GitHub Issues WorkProvider   | User-Agent sent to GitHub REST.                                        |
| `LUMA_LIVE_GITHUB_TESTS`          | No              | Tests                        | Set to `1` to run non-mutating live GitHub WorkProvider tests.         |
| `LUMA_IDENTITY_PEOPLE_JSON`       | No              | Identity Directory           | JSON array mapping internal people to provider accounts.               |
| `LUMA_GITHUB_CODE_PROVIDER_ID`    | No              | GitHub CodeProvider          | Planned Code provider ID. GitHub Code is separate from Work.           |
| `CONFLUENCE_BASE_URL`             | Planned         | Confluence KnowledgeProvider | Atlassian Confluence base URL.                                         |
| `CONFLUENCE_EMAIL`                | Planned         | Confluence KnowledgeProvider | Atlassian account email for API auth.                                  |
| `CONFLUENCE_API_TOKEN`            | Planned         | Confluence KnowledgeProvider | Atlassian API token.                                                   |
| `CONFLUENCE_SPACE_KEY`            | Planned         | Confluence KnowledgeProvider | Space for meeting notes and knowledge updates.                         |
| `CONFLUENCE_PARENT_PAGE_ID`       | Planned         | Confluence KnowledgeProvider | Parent page for generated meeting records.                             |
| `LUMA_CONFLUENCE_PROVIDER_ID`     | Planned         | Confluence KnowledgeProvider | Provider ID for Knowledge external references.                         |
| `DISCORD_TOKEN`                   | Planned         | Discord Module               | Bot token.                                                             |
| `DISCORD_CLIENT_ID`               | Planned         | Discord Module               | Bot application/client ID.                                             |
| `DISCORD_GUILD_ID`                | Planned         | Discord Module               | Development guild for command registration.                            |
| `OPENAI_API_KEY`                  | Planned         | ReasoningModel Adapter       | Model provider credential.                                             |
| `LUMA_REASONING_MODEL_PROVIDER`   | Planned         | ReasoningModel Adapter       | Model provider selector.                                               |
| `LUMA_REASONING_MODEL_NAME`       | Planned         | ReasoningModel Adapter       | Concrete model name.                                                   |

## Current Live GitHub Validation

The live GitHub test is intentionally non-mutating. It searches the configured repository and validates that the Adapter returns provider-neutral `WorkItem` values.

Bot-authored validation:

```bash
export GITHUB_REPOSITORY="Dayova/dayova-mvp"
export GITHUB_APP_ID="12345"
export GITHUB_APP_INSTALLATION_ID="67890"
export GITHUB_APP_PRIVATE_KEY_BASE64="$(base64 -i path/to/private-key.pem)"
LUMA_LIVE_GITHUB_TESTS=1 npm test -- tests/work/github-issues-adapter.live.test.ts
```

User-authored local fallback:

```bash
export GITHUB_TOKEN="$(gh auth token)"
export GITHUB_REPOSITORY="Dayova/dayova-mvp"
LUMA_LIVE_GITHUB_TESTS=1 npm test -- tests/work/github-issues-adapter.live.test.ts
```

## Security Rules

- Do not commit `.env`.
- Do not log tokens or raw provider credentials.
- Do not put provider-specific env reads inside Meeting Intelligence.
- Do not make runtime application code depend on `gh`, MCP tools, or Codex plugins.
- Use provider-neutral `ExternalReference` values outside provider Adapters.
- Use GitHub App installation auth for production bot-authored activity.

## Identity Mapping

See `docs/configuration/identity.md` for the built-in Luma team mapping and the `LUMA_IDENTITY_PEOPLE_JSON` format.
