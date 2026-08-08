# Action Item Reconciliation — Design It Twice

LUM-3 turns an Imported Action Item Candidate into one reviewable outcome against
canonical Linear work. The candidate retains its source Evidence and remains a
proposal; this slice performs no provider mutation.

## Constraints

- `MeetingIntelligence` remains the deep Module with only `observe`, `query`,
  and `conclude` as its public Interface.
- A source sync must consume LUM-2 snapshots through `observe`, not expose
  Notion blocks or call a public extraction pipeline.
- Linear is a true external dependency. Reconciliation receives a read-only
  Work Catalog Adapter; creation and updates remain unavailable by type.
- PGlite is local-substitutable persistence. It retains candidates, canonical
  search receipts, prior mappings, and immutable review proposals.
- Every candidate resolves to exactly one of `link-existing`,
  `update-existing`, `create-new`, `reject-not-work`, or
  `needs-clarification`.
- A `create-new` proposal requires a completed canonical work search. Partial
  source content, an unavailable catalog, a retrieval failure, or an ambiguous
  match must resolve to `needs-clarification`.

An illustrative constraint, rather than a chosen design, is:

```ts
await meetingIntelligence.observe({ workspace, observations: [sourceFact] });
const review = await meetingIntelligence.query({
  workspaceId: workspace.workspaceId,
  meetingId: sourceFact.meetingId,
  query: { type: "action-item-reconciliation-review" }
});
```

## Design 1 — exposed reconciliation pipeline

Expose `extractCandidates`, `searchWork`, `rankMatches`, and `reconcile` as
separate functions. This makes the individual steps convenient, but puts
ordering, idempotency, evidence persistence, and no-create-before-search rules
in every caller. It is shallow: the caller must learn the implementation
pipeline to use it correctly. Rejected.

## Design 2 — source reducer only

Let a source adapter write candidates directly into a Meeting projection and
leave all work lookup to a later UI or worker. This keeps ingestion simple but
splits matching policy and evidence history across callers. It cannot guarantee
that every proposed creation has a recorded canonical search. Rejected.

## Design 3 — public flexible reconciliation Module

Expose a generic `ActionItemReconciler.reconcile({ candidates, catalog,
policies })` Interface. This supports many future sources and Work providers,
but makes callers responsible for passing the correct candidate history,
permission scope, and persistence context. It is flexible at the cost of a
second orchestration seam beside Meeting Intelligence. Rejected for the first
wedge; its useful internal ideas are retained.

## Design 4 — durable reconciliation inside Meeting Intelligence

Add a provider-neutral source Observation and a focused review Query. The
Implementation persists source Evidence and candidates, performs all catalog
searches and retrievals through a read-only Work Catalog, ranks candidates
deterministically, and retains the resulting review record in Meeting State.

```ts
interface MeetingIntelligence {
  observe(input: ObserveMeeting): Promise<MeetingUpdate>;
  query(input: QueryMeeting): Promise<MeetingQueryResult>;
  conclude(input: ConcludeMeeting): Promise<MeetingConclusion>;
}
```

The source Adapter only maps an observed snapshot to a source Observation. A
Notion Custom Agent, Discord, or future dashboard only queries the review. The
Implementation hides candidate extraction, source completeness gating, query
normalization, exact identifier resolution, work hydration, prior-mapping
lookup, deterministic ranking, tie handling, and audit receipts.

This is the selected design. It has the most leverage: one small Interface
gives every future surface the same evidence, duplicate-prevention, and safety
rules. It keeps locality in Meeting Intelligence and prevents callers from
accidentally using a writer-capable Linear Adapter.

## Selected invariants

- Candidate IDs are revision-specific while lineage keys remain stable across
  source revisions; identical wording alone never merges two source blocks.
- Original modality, owner state, deadline phrase, source block, source
  revision, and Evidence survive in the review record.
- Exact work identifiers and prior mappings outrank text similarity. A tie or
  conflict is clarified rather than chosen arbitrarily.
- A Work Catalog failure is represented as a reviewable clarification, never a
  raw Linear error or a `create-new` fallback.
- This slice only proposes changes. A later approved Follow-up Intent performs
  the actual Linear mutation.
