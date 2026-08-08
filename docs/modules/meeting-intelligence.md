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
- Human Judgment outranks AI inference: a confirmed, rejected, or corrected
  Meeting Item remains Human-authoritative across later fresh model analyses.
- Speaker Attribution and Ownership Attribution are separate, Evidence-grounded
  claims. A speaker claim answers who produced an Utterance; an ownership claim
  answers who, if anyone, is responsible for an Action Item. Neither a source
  speaker label nor a participant mention is sufficient to collapse the two.
- Source Attribution Claims preserve original wording, basis, confidence, and
  Evidence immutably. A Human Attribution Resolution is a durable overlay that
  determines the effective result and outranks later inference without
  rewriting the source claim.
- No accepted Action Item may leave Meeting Intelligence with a silently
  guessed, silently missing, or falsely certain owner. Effective ownership is
  explicitly `confirmed`, `proposed`, `intentionally-unassigned`, or `unresolved`.
- Linear assignment is a hard safety gate: only `confirmed` ownership may map
  to a Linear user, and only explicitly `intentionally-unassigned` ownership may create work
  without an assignee. `proposed` and `unresolved` ownership require targeted
  clarification and cannot produce an automatic Linear work mutation.
- Transcript revisions preserve old utterance versions and reconsider affected Meeting Items.
- Conclusions are persisted by Meeting Revision and output options.
- Imported Meeting Note source revisions retain their source Evidence and
  Action Item Candidates without treating Notion-generated text as confirmed
  work.
- Imported source Evidence must exactly match the source-section manifest and
  source-derived candidate block references; an immutable Action Item block
  manifest proves the exact source text and completion state; source acceptance
  is atomic.
- Production imported-source acceptance also requires a provider-neutral
  verifier. The Notion implementation compares the entire Observation with the
  deterministic projection of the immutable observed-source ledger revision;
  a self-consistent caller-supplied payload is not trusted as source evidence.
- A `removed` imported-source revision is only emitted after a complete,
  readable provider scan confirms its root is absent. It is a candidate
  invalidation boundary, not an unavailable-read state: pre-removal candidates
  cannot become current again without a later readable source revision. It also
  invalidates every pending or resumable reconciliation settlement for that
  candidate; execution rechecks current source state before mutation and records
  a stale-source receipt instead of writing an obsolete outcome.
- Imported candidates reconcile through a read-only Work Catalog after source
  acceptance. The durable review records a canonical-search receipt, matching
  signals, source and work Evidence, and one immutable proposal outcome without
  mutating a provider. The current review view derives collisions rather than
  rewriting proposal history. Retryable catalog-read failures append a later
  attempt with durable exponential backoff beginning at one minute and capped
  at one hour; an explicit Human refresh bypasses that cooldown.
- A participant can resolve a current reconciliation proposal through a
  `human-judgment-recorded` Observation. That Human Judgment is Evidence and
  outranks automatic matching. Each resolution produces one suggested, opaque
  `settle-operational-outcome` Follow-up Intent, never a direct provider write
  or caller-supplied page target or Markdown.

## Ordering

`observe` accepts and persists valid Observations first. It then performs
bounded analysis for new or revised utterance Evidence, followed by
reconciliation of imported Action Item candidates against configured read-only
Work Catalogs outside the source acceptance transaction. Durable reviews commit
in a short follow-up transaction. This ordering gives model analysis an exact
revision fence before any slow catalog I/O. Each stage advances the Meeting
Revision. If catalog work or analysis fails, accepted Evidence remains durable
and reconciliation is represented as a reviewable clarification.

Model calls happen outside database transactions. Before model output is saved,
Meeting Intelligence verifies that the Meeting is still at the exact Revision
the model analyzed. If a new Observation, source revision, or Human Judgment
arrived in the meantime, it discards the stale model result rather than
rebasing it over canonical state.

Attribution assessment remains inside Meeting Intelligence. Source Adapters
submit provider-neutral Evidence and Observations; callers may record Human
Judgment, but never orchestrate speaker extraction, owner inference, Linear
account mapping, or the clarification workflow.

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
- Map persisted source revisions to provider-neutral source Observations before
  they enter `observe`; source Adapters do not expose their provider SDK types
  to the Module.
- Add provider Adapters behind KnowledgeProvider, WorkProvider, and CodeProvider.
- Query imported Action Item proposals with
  `{ type: "action-item-reconciliation-review" }` for the current effective
  view, or `{ type: "action-item-reconciliation-history" }` for immutable
  attempts; callers never orchestrate source extraction, work searches,
  ranking, or provider writes.
- Submit source attribution through provider-neutral Observations and correct it
  through Human Judgment. Adapters and callers never turn a display label,
  pronunciation guess, or participant mention directly into a confirmed Person
  or Linear assignee.
- Add model SDKs behind ReasoningModel.
- Add richer Organizational Context retrieval behind the OrganizationalContext Interface.

## Non-goals

- Discord command handling.
- Discord voice capture.
- Provider SDK imports in Meeting Intelligence.
- Agent framework state as canonical Meeting State.
- Direct Confluence, GitHub, Notion, or Linear mutation from AI output.
- Treating a source speaker label, a suggested owner, or an unresolved owner as
  a confirmed Linear assignee.

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

const reconciliation = await meetingIntelligence.query({
  workspaceId: "workspace_luma",
  meetingId: "meeting_product",
  query: { type: "action-item-reconciliation-review" }
});
```
