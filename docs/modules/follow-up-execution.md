# Follow-up Execution Module

## Responsibility

Follow-up Execution consumes approved provider-independent Follow-up Intents and maps them to the configured provider capability. It records the outcome back into Meeting Intelligence as a `follow-up-execution-recorded` Observation.

## Public Interface

```ts
interface FollowUpExecution {
  execute(input: ExecuteFollowUpInput): Promise<ExecuteFollowUpResult>;
}
```

## Invariants

- Execution uses an idempotency key shaped as `workspaceId:meetingId:intentId:operation`.
- An Intent must have an explicit Human approval before execution.
- Provider mutations are performed through capability Interfaces, not direct SDK calls.
- Durable execution reservations and completed results are stored in the Luma database.
- Failed attempts remain retryable; successful retries reuse provider idempotency markers.
- Execution outcomes are normalized as succeeded, partially succeeded, or failed Observations.
- Discord rendering consumes provider-independent events emitted by Meeting Intelligence.

## Dependency Classification

- KnowledgeProvider: true external Adapter.
- WorkProvider: true external Adapter.
- CodeProvider: true external Adapter.
- MeetingIntelligence: in-process Module Interface.

## Current Implementation

The current implementation supports approved `create-work-item`, `update-work-item`, `record-meeting`, and `update-knowledge` paths. New executable work is written to Linear, Meeting records are written to Notion, and resulting external references are recorded on Meeting State. Discord renders deterministic receipts and can safely retry failed executions across process restarts.
