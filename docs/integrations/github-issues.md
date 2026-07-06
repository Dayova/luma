# GitHub Issues WorkProvider

Luma supports GitHub Issues as the current Work provider through `createGitHubIssuesWorkProvider`.

## Runtime Configuration

Use GitHub App installation authentication for production. That is the path that makes issues and comments appear as the bot, similar to Codex/ChatGPT, Claude, or Vercel bot accounts.

```ts
import { createGitHubIssuesWorkProviderFromEnv } from "luma";

const workProvider = createGitHubIssuesWorkProviderFromEnv();
```

Required environment for bot-authored GitHub activity:

```bash
GITHUB_REPOSITORY=owner/repo
GITHUB_APP_ID=12345
GITHUB_APP_INSTALLATION_ID=67890
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
```

Or use a base64-encoded private key:

```bash
GITHUB_APP_PRIVATE_KEY_BASE64="$(base64 -i path/to/private-key.pem)"
```

Required GitHub App repository permissions:

- Metadata: read
- Issues: read and write

## Local User-authored Fallback

A PAT or `gh auth token` works for local development, but GitHub will attribute issue/comment authorship to that user. Do not use this for production bot-authored activity.

```bash
export GITHUB_TOKEN="$(gh auth token)"
export GITHUB_REPOSITORY="owner/repo"
```

If the current repo has a GitHub remote, derive `GITHUB_REPOSITORY` with:

```bash
export GITHUB_REPOSITORY="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
```

Optional environment:

- `GITHUB_API_BASE_URL`: defaults to `https://api.github.com`.
- `LUMA_GITHUB_WORK_PROVIDER_ID`: defaults to `github-issues`.
- `LUMA_GITHUB_USER_AGENT`: defaults to `luma-meeting-intelligence`.

## Auth Flow

With GitHub App envs configured, the Adapter:

1. Signs a short-lived RS256 JWT with `GITHUB_APP_ID` and the private key.
2. Calls `POST /app/installations/{installation_id}/access_tokens`.
3. Uses the returned installation access token for issue search, creation, updates, and comments.
4. Caches the installation token until shortly before expiry.

## Idempotency

GitHub Issues does not provide native issue-creation idempotency. The Adapter writes a hidden marker into generated issue bodies:

```md
<!-- luma-idempotency-key: workspace:meeting:intent:execute -->
```

Before creating an issue, the Adapter searches the configured repository for that marker. If it finds an existing issue, it returns that issue reference instead of creating a duplicate.

## Mapping

- GitHub issue number maps to `WorkItem.externalId`.
- GitHub assignee login maps to `ExternalUser.username`.
- GitHub labels map to `WorkItem.labels`.
- `closed` issues map to `completed`, unless `state_reason` is `not_planned`, which maps to `cancelled`.
- Open issues with `blocked`, `planned`, or `backlog` labels map to those statuses. Other open issues map to `active`.
- GitHub has no native issue due date; the Adapter stores generated due-date metadata in the issue body.

## Capability Separation

This Adapter implements the WorkProvider Interface only. GitHub PRs, commits, files, reviews, releases, and implementation status belong to the separate CodeProvider Interface.

## Live Test

The live test is non-mutating and skipped by default:

Bot-authored:

```bash
LUMA_LIVE_GITHUB_TESTS=1 \
GITHUB_REPOSITORY=owner/repo \
GITHUB_APP_ID=12345 \
GITHUB_APP_INSTALLATION_ID=67890 \
GITHUB_APP_PRIVATE_KEY_BASE64="$(base64 -i path/to/private-key.pem)" \
npm test -- tests/work/github-issues-adapter.live.test.ts
```

User-authored fallback:

```bash
LUMA_LIVE_GITHUB_TESTS=1 \
GITHUB_TOKEN="$(gh auth token)" \
GITHUB_REPOSITORY=owner/repo \
npm test -- tests/work/github-issues-adapter.live.test.ts
```

If this command fails with `no git remotes found`, set `GITHUB_REPOSITORY` manually or add a GitHub remote to the local repo.
