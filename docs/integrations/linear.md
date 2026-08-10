# Linear WorkProvider

Linear is Luma's sole canonical provider for executable work. A Meeting Action
Item remains evidence-grounded domain state; a source-bound reconciliation
settlement may mutate Linear only after its current source, reconciliation,
authorization, and ownership state are valid. LUM-6, LUM-7, and LUM-8 remain
incomplete, so this document describes their implemented safety foundation,
not a completed production workflow.

## Setup

1. Create a Linear API key for the development environment.
2. Confirm that its user can access the Dayova team.
3. Add `LINEAR_API_KEY` and `LINEAR_TEAM_ID` to `.env`.
4. Start Luma and use the current Meeting flow to produce a proposal.
5. Use an approved, source-bound reconciliation settlement only when its
   ownership gate is satisfied.

```dotenv
LINEAR_API_KEY=
LINEAR_TEAM_ID=63c160e7-ab70-4ef9-9822-0f85590ebb7f
LINEAR_API_URL=https://api.linear.app/graphql
LUMA_LINEAR_PROVIDER_ID=linear
```

Use separate credentials for development and production. A personal API key is acceptable for the current private development bot; production should use a dedicated integration identity so authorship and revocation are unambiguous.

## Ownership Gate

No accepted Action Item may become canonical Linear work with a silently
guessed, accidentally missing, or falsely certain owner.

- `confirmed` ownership maps its Person through the Identity Directory to a
  Linear member UUID.
- Only a Human-explicit `intentionally-unassigned` decision may create work
  with a null assignee.
- `proposed` and `unresolved` ownership never create, update, or assign
  Linear work; Luma records the targeted clarification needed instead.
- A confirmed owner without a current Linear identity mapping also blocks
  creation rather than silently falling back to an unassigned issue.
- Generic `create-work-item` Intents are intentionally non-executable until
  they can carry this same durable attribution proof.

## Mapping

- Follow-up title becomes the Linear issue title.
- Description remains evidence-grounded Markdown.
- A permitted confirmed owner resolves through the Identity Directory to a
  Linear member UUID; a Human-intentionally-unassigned item passes `null`.
- `mentionPersonIds` resolve to Linear subscriber UUIDs.
- Due date is written as Linear's issue due date only when the associated
  source-bound operation is otherwise safe to execute.
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
- Confirmed owner has no Linear mapping: add or repair the internal Person's
  `linearUserId`; Luma will not silently create the issue unassigned.
- Ownership is proposed or unresolved: record a targeted Human ownership
  decision before attempting a create, update, or assignee mutation.
- Duplicate issue concern: do not remove the idempotency marker from generated descriptions.

The SDK is contained behind Luma's owned `LinearApi` facade and `WorkProvider` Interface.

## Dedicated least-privilege read-only catalog

`LinearReadOnlyWorkCatalog` is a separate production Adapter for an eventual
source-bound review surface. It is configured with `LINEAR_READONLY_API_KEY`
and `LINEAR_TEAM_ID`; it never reads or falls back to `LINEAR_API_KEY`, and it
does not accept a `WorkProvider` instance. Create the read-only key with only
Linear's **Read** permission.

The catalog implements only the existing read-only `WorkCatalog` operations:

- team-scoped text search is hard-capped at ten results, and an SDK response is
  sliced to that cap before any individual issue is hydrated;
- one issue may be fetched only after its opaque selector was returned by that
  catalog's bounded search; and
- no generic list, create, update, comment, assignment, or delete operation is
  exposed.

Before any Linear record becomes a `WorkItem` or reconciliation-facing data,
the read-only catalog rejects (rather than truncates) a title over 1,024 UTF-16
code units, a description over 64,000 UTF-16 code units, more than 50 labels,
or a label over 256 UTF-16 code units. It requests at most 51 labels so a
51st label proves the 50-label cap was exceeded. An oversized record produces a
typed read-only catalog error and no partial search result is retained.

Production construction accepts only the read-only credential configuration;
it has no injectable API object. The deterministic API-injection seam is
explicitly test-only and is not exported from Luma's package entrypoint, so a
writer-capable Linear adapter cannot be supplied to the production catalog by
structural typing.

This slice does not wire the catalog into the executable server or authorize a
native Notion agent. It is intentionally separate from the writer-capable
`LinearWorkProvider` used by approved Follow-up Execution.

## Read-only reconciliation catalog

Meeting Intelligence receives a narrowed `WorkCatalog` rather than a
writer-capable `WorkProvider`. It can search and retrieve canonical Linear work
to produce an evidence-backed reconciliation review, but it cannot create,
update, or comment on an issue. The review is obtained through Luma's
`action-item-reconciliation-review` Meeting query and remains a proposal until
Human Judgment resolves it. For an ownership-sensitive create or update,
Human Judgment must also confirm the owner or explicitly leave the work
unassigned. A safe create/update resolution produces a **suggested**
source-bound Follow-up Intent; its separate approval remains required by the
current implementation before execution can mutate Linear. The immutable
attempt history is available through
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

For the dedicated catalog, create a separate Read-permission key and run only
the bounded search smoke test:

```bash
set -a
source .env
set +a
LUMA_LIVE_LINEAR_READONLY_TESTS=1 pnpm exec vitest run tests/work/linear-read-only-work-catalog.live.test.ts
```
