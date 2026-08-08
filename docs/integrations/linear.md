# Linear WorkProvider

Linear is Luma's canonical provider for executable work. A Meeting Action Item remains evidence-grounded domain state; only an explicitly approved `create-work-item` or `update-work-item` Follow-up Intent mutates Linear.

## Setup

1. Create a Linear API key for the development environment.
2. Confirm that its user can access the Dayova team.
3. Add `LINEAR_API_KEY` and `LINEAR_TEAM_ID` to `.env`.
4. Start Luma and use `/meeting note` to produce a proposal.
5. Use `/meeting approve intent:<id>` to execute it.

```dotenv
LINEAR_API_KEY=
LINEAR_TEAM_ID=63c160e7-ab70-4ef9-9822-0f85590ebb7f
LINEAR_API_URL=https://api.linear.app/graphql
LUMA_LINEAR_PROVIDER_ID=linear
```

Use separate credentials for development and production. A personal API key is acceptable for the current private development bot; production should use a dedicated integration identity so authorship and revocation are unambiguous.

## Mapping

- Follow-up title becomes the Linear issue title.
- Description remains evidence-grounded Markdown.
- `assigneeId` resolves through the Identity Directory to a Linear member UUID.
- `mentionPersonIds` resolve to Linear subscriber UUIDs.
- Due date is written as Linear's issue due date.
- Provider references store Linear's human issue identifier (for example `LUM-3`) as
  `externalId` and its human URL separately. The adapter keeps its provider lookup
  identifier internal.
- Linear state types normalize to provider-independent Work statuses.

## Idempotency

Linear issue creation has no caller-supplied idempotency key. Luma appends a `luma-idempotency-key:` marker to the description and searches the configured team for that marker before creating an issue. Follow-up Execution also persists the completed execution result locally.

## Pipeline Boundary

Linear owns the task. GitHub #20 describes the migration and DAY-39 is the canonical Linear decision. Where Linear's GitHub integration creates a synced GitHub Issue, that Issue is a compatibility mirror rather than a second task. Code branches, commits, pull requests, review, and CI still belong in GitHub.

## Troubleshooting

- `LINEAR_API_KEY is required`: one Linear variable is set but the credential is missing.
- `LINEAR_TEAM_ID is required`: copy the Dayova team UUID, not its short key.
- Assignee is empty: verify the internal Person has a `linearUserId` and that the user belongs to the workspace.
- Duplicate issue concern: do not remove the idempotency marker from generated descriptions.

The SDK is contained behind Luma's owned `LinearApi` facade and `WorkProvider` Interface.

## Read-only reconciliation catalog

Meeting Intelligence receives a narrowed `WorkCatalog` rather than a
writer-capable `WorkProvider`. It can search and retrieve canonical Linear work
to produce an evidence-backed reconciliation review, but it cannot create,
update, or comment on an issue. The review is obtained through Luma's
`action-item-reconciliation-review` Meeting query and remains a proposal until
Human Judgment resolves it. A create/update resolution produces a **suggested**
Follow-up Intent; its separate approval remains required before execution can
mutate Linear. The immutable attempt history is available through
`action-item-reconciliation-history` for audit.

When a read of the Linear catalog is retryable, Meeting Intelligence schedules
the next read automatically with durable exponential backoff: one minute at
first, growing to a one-hour cap. A Human
`refresh-action-item-reconciliation` Judgment deliberately bypasses that
cooldown for the current review. Neither automatic retries nor Human refreshes
gain a write capability.

Linear's public update mutation has no server-side version precondition. Luma
therefore does not turn a due-date mismatch into an executable Linear update:
it remains a `needs-clarification` review for a human to apply in Linear. Luma
only emits executable tracker updates for a provider that advertises an atomic
conditional-update capability; it never falls back to an unconditional write.

An exact source mention such as `LUM-3` is provider-qualified before it enters
reconciliation. Matching never treats an unqualified identifier from a second
provider as the same work item.

## Non-mutating Live Test

```bash
set -a
source .env
set +a
LUMA_LIVE_LINEAR_TESTS=1 pnpm test -- tests/work/linear-work-provider.live.test.ts
```
