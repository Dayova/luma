# Follow-up Execution Module

## Responsibility

Follow-up Execution consumes approved provider-independent Follow-up Intents and maps them to the configured provider capability. It records the outcome back into Meeting Intelligence as a `follow-up-execution-recorded` Observation.

## Public Interface

```ts
interface FollowUpExecution {
  execute(input: ExecuteFollowUpInput): Promise<ExecuteFollowUpResult>;
  recover(input: ExecuteFollowUpInput): Promise<ExecuteFollowUpResult>;
}
```

## Invariants

- Execution uses a canonical tuple idempotency key over workspace, Meeting,
  Intent, and operation; delimiters inside IDs cannot collide.
- An Intent must have an explicit Human approval before execution.
- Provider mutations are performed through capability Interfaces, not direct SDK calls.
- Durable execution reservations and completed results are stored in the Luma database.
- A retryable provider failure records an auditable failed receipt; a
  non-retryable safety failure (for example a stale work version) requires a
  fresh Human-reviewed proposal rather than direct re-approval.
- A stranded execution can only be recovered through a positive provider
  idempotency-marker lookup. Recovery never repeats the provider mutation; an
  unproven outcome becomes `requires-manual-recovery`.
- Execution outcomes are normalized as succeeded, partially succeeded, or failed Observations.
- Discord rendering consumes provider-independent events emitted by Meeting Intelligence.

## Dependency Classification

- KnowledgeProvider: true external Adapter.
- WorkProvider: true external Adapter.
- CodeProvider: true external Adapter.
- MeetingIntelligence: in-process Module Interface.

## Current Implementation

The current implementation supports approved `create-work-item`, `record-meeting`,
and `update-knowledge` paths. It supports `update-work-item` only when the active
WorkProvider offers an atomic conditional update; Linear does not, so its
reconciliation updates remain manual review. `comment-on-code-change` is
explicitly rejected until Luma has a write-capable CodeProvider. New executable
work is written to Linear, Meeting records are written to Notion, and resulting
external references are recorded on Meeting State. Discord renders deterministic
receipts; a live execution lease is never silently stolen after a process
interruption. A mapped Luma participant can run `/meeting recover intent_id`
for an approved Intent with a stranded execution lease. That command performs
only the positive recovery probe and records either the recovered reference or
the manual-inspection outcome.
