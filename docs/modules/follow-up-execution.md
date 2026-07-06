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
- Provider mutations are performed through capability Interfaces, not direct SDK calls.
- Execution outcomes are normalized as succeeded, partially succeeded, or failed Observations.
- Discord rendering consumes provider-independent events emitted by Meeting Intelligence.

## Dependency Classification

- KnowledgeProvider: true external Adapter.
- WorkProvider: true external Adapter.
- CodeProvider: true external Adapter.
- MeetingIntelligence: in-process Module Interface.

## Current Implementation

The current implementation supports a tracer-bullet create-work-item path through WorkProvider and records the resulting external reference on the related Action Item. It includes in-instance idempotency; durable execution idempotency storage remains a later slice.
