# GitHub Issues WorkProvider

Luma supports GitHub Issues as the current Work provider through `createGitHubIssuesWorkProvider`.

## Runtime Configuration

```ts
import { createGitHubIssuesWorkProvider } from "luma";

const workProvider = createGitHubIssuesWorkProvider({
  token: process.env.GITHUB_TOKEN!,
  owner: "owner",
  repo: "repo"
});
```

Or:

```ts
const workProvider = createGitHubIssuesWorkProviderFromEnv();
```

Required environment:

- `GITHUB_TOKEN`: a token that can read and write issues for the configured repository.
- `GITHUB_REPOSITORY`: `owner/repo`.

Optional environment:

- `GITHUB_API_BASE_URL`: defaults to `https://api.github.com`.
- `LUMA_GITHUB_WORK_PROVIDER_ID`: defaults to `github-issues`.
- `LUMA_GITHUB_USER_AGENT`: defaults to `luma-meeting-intelligence`.

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

```bash
LUMA_LIVE_GITHUB_TESTS=1 \
GITHUB_TOKEN=... \
GITHUB_REPOSITORY=owner/repo \
npm test -- tests/work/github-issues-adapter.live.test.ts
```
