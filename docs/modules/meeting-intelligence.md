# Meeting Intelligence Module

## Responsibility

Meeting Intelligence owns the transformation from Meeting Observations to Evidence, grounded Meeting State, versioned Conclusions, provider-independent Follow-up Intents, and provider-independent receipt events.

## Public Interface

```ts
interface MeetingIntelligence {
  observe(input: ObserveMeeting): Promise<MeetingUpdate>;
  query(input: QueryMeeting): Promise<MeetingQueryResult>;
  conclude(input: ConcludeMeeting): Promise<MeetingConclusion>;
}
```

## Invariants

- Observations are idempotent by `observationId`.
- Evidence is stable, addressable, and version-aware.
- Factual Meeting Items require Evidence.
- Unknown Evidence references from the ReasoningModel Adapter are rejected.
- Revisions are monotonic.
- Human Judgment outranks AI inference.
- Transcript revisions preserve old utterance versions and reconsider affected Meeting Items.
- Conclusions are persisted by Meeting Revision and output options.

## Ordering

`observe` accepts and persists valid Observations first. It then performs bounded analysis for new or revised utterance Evidence. If analysis fails, Evidence remains accepted and analysis is deferred.

## Errors

The Interface reports domain errors such as invalid Observations and temporary analysis unavailability. It does not leak raw provider or model SDK errors.

## Performance Expectations

The current implementation analyzes only new/revised Evidence supplied to an `observe` call. It does not resend the whole transcript after every utterance.

## Dependency Classification

- Persistence: local-substitutable, PostgreSQL-compatible PGlite in tests.
- ReasoningModel: true external behind an owned port.
- Organizational Context: true external behind a provider-neutral port, not yet wired into analysis.
- Knowledge, Work, Code providers: true external Adapters behind capability Interfaces.

## Extension Points

- Add Observation types in `src/domain/model.ts` and reconcile them through `observe`.
- Add provider Adapters behind KnowledgeProvider, WorkProvider, and CodeProvider.
- Add model SDKs behind ReasoningModel.
- Add richer Organizational Context retrieval behind the OrganizationalContext Interface.

## Non-goals

- Discord command handling.
- Discord voice capture.
- Provider SDK imports in Meeting Intelligence.
- Agent framework state as canonical Meeting State.
- Direct Confluence, GitHub, Notion, or Linear mutation from AI output.

## Example

```ts
await meetingIntelligence.observe({
  workspace: { workspaceId: "workspace_luma", timezone: "Europe/Berlin" },
  observations: [utteranceCommitted]
});

const snapshot = await meetingIntelligence.query({
  workspaceId: "workspace_luma",
  meetingId: "meeting_product",
  query: { type: "snapshot" }
});
```
