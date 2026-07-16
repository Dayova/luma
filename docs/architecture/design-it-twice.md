# Design It Twice: Meeting Intelligence

The chosen Module is Meeting Intelligence. Its Interface must accept meeting observations, answer grounded queries, and create versioned conclusions without exposing transcript extraction, model prompting, context retrieval, reconciliation, or provider execution orchestration to callers.

## Constraints

- Discord is the primary meeting surface, but Discord SDK concepts must not leak into Meeting Intelligence.
- Notion is the canonical Knowledge provider for Meeting records and decisions.
- Linear is the canonical Work provider; synced GitHub Issues are compatibility mirrors.
- GitHub remains the Code provider for PRs, commits, repositories, files, and implementation status.
- Original German, English, and mixed-language speech is canonical Evidence.
- Every factual Meeting Item must retain provenance.
- Valid Evidence acceptance must survive model, context, or provider failure.
- Follow-up execution requires approved provider-independent Follow-up Intents.
- Persistence must support idempotent Observations, monotonic Revisions, transcript correction, and later external activity.

## Candidate A: Exposed Processing Pipeline

### Public Interface

```ts
extractTopics(observations);
extractDecisions(topics, evidence);
extractActionItems(decisions, evidence);
retrieveContext(concepts);
generateSummary(state);
createFollowUpPlan(summary);
```

### Example Usage

Callers would receive transcript Observations, call each extraction function, call context retrieval, reconcile outputs, and persist state.

### Invariants

Each function would need evidence validation and ordering rules. Callers would need to know which function invalidates which later output.

### Ordering Constraints

Extraction must happen after evidence creation, context before conflict detection, follow-up planning after reconciliation, and summary after item status updates.

### Error Behaviour

Partial failures are difficult to express because every caller must decide whether evidence acceptance is independent from analysis failure.

### Dependency Categories

- In-process: deterministic validation
- True external: model provider
- True external: Knowledge, Work, and Code providers
- Local-substitutable: database

### Internal Implementation

The implementation is thin. Most orchestration lives in Discord, future dashboard code, or jobs.

### Depth, Leverage, Locality

Depth is low because callers learn the full processing order. Leverage is poor because each caller repeats orchestration. Locality is weak because evidence validation and failure policy spread across callers.

### Testability

Tests would either couple to many small functions or re-create the whole pipeline at every call site.

### Operational Complexity

Retries, duplicate extraction, revisions, and late Observations become caller concerns.

### Weak Points

This directly violates the core rule: callers orchestrate internal Meeting Intelligence stages.

## Candidate B: In-process Stateful Meeting Session

### Public Interface

```ts
const session = await meetingSessions.open(workspaceId, meetingId);
await session.observe(observation);
await session.analyze();
await session.answer(query);
await session.finish();
```

### Example Usage

Discord opens a session when a Meeting starts and keeps the session object alive while the voice call runs.

### Invariants

The session owns live state while process memory is warm. Durable invariants still need persistence behind it.

### Ordering Constraints

Callers must open, use, and close sessions in the right order. Recovery after process restart requires special handling.

### Error Behaviour

Model failure can be represented on the session, but process failure risks losing unflushed state unless every method persists.

### Dependency Categories

- In-process: session state
- Local-substitutable: persistence if added behind session
- True external: model and providers

### Internal Implementation

The session can hide some orchestration, but durability and concurrency are awkward.

### Depth, Leverage, Locality

Depth is medium. Leverage is good for live Discord, but weaker for later jobs, dashboard reads, and external activity after the call. Locality is split between session lifecycle and durable persistence.

### Testability

Tests can call session methods, but restart, retry, and out-of-order Observation behaviour need extra seams.

### Operational Complexity

Harder to scale across workers and restarts. Meeting follow-up after a live session ends feels bolted on.

### Weak Points

It optimizes the live call more than the durable organizational memory.

## Candidate C: Pure Reducer

### Public Interface

```ts
const result = reduceMeetingState(previousState, observations, analysisProposal);
```

### Example Usage

Jobs and callers append Observations, call model/context systems externally, then feed proposals into a reducer.

### Invariants

The reducer can enforce deterministic evidence validation, item lifecycle rules, and revision monotonicity.

### Ordering Constraints

Callers must still decide when to retrieve context, call models, retry analysis, and persist.

### Error Behaviour

Reducer errors can be clean domain errors. Analysis failure is still outside the Module.

### Dependency Categories

- In-process: reducer
- True external: model and providers outside the reducer
- Local-substitutable: persistence outside the reducer

### Internal Implementation

The reducer is deep for reconciliation but shallow for Meeting Intelligence as a product.

### Depth, Leverage, Locality

Depth is high for deterministic state transitions but low for the whole Meeting Intelligence responsibility. Leverage is partial. Locality is mixed because orchestration still lives outside.

### Testability

Reducer tests are stable, but end-to-end behaviour through `observe`, `query`, and `conclude` remains untested unless another Module wraps it.

### Operational Complexity

Lower than Candidate A, but still leaves workflow coordination and persistence semantics outside the main seam.

### Weak Points

It is a good internal implementation shape, not a sufficient public architecture.

## Candidate D: Durable Deep Meeting Intelligence Module

### Public Interface

```ts
interface MeetingIntelligence {
  observe(input: ObserveMeeting): Promise<MeetingUpdate>;
  query(input: QueryMeeting): Promise<MeetingQueryResult>;
  conclude(input: ConcludeMeeting): Promise<MeetingConclusion>;
}
```

### Example Usage

Discord, future dashboard code, provider sync jobs, and follow-up execution all submit Observations or queries through the same Interface.

### Invariants

The Module owns Observation idempotency, Evidence persistence, proposal validation, deterministic reconciliation, revision monotonicity, transcript correction, Human Judgment precedence, and conclusion versioning.

### Ordering Constraints

Callers only submit facts. The Module decides when to persist evidence, call the ReasoningModel Adapter, retrieve Organizational Context, reconcile proposals, defer analysis, and commit a new Revision.

### Error Behaviour

Valid Evidence can be accepted even when analysis is deferred. Public errors are domain errors, not raw infrastructure errors.

### Dependency Categories

- Local-substitutable: PostgreSQL-compatible persistence
- True external: ReasoningModel provider Adapter
- True external: Organizational Context retrieval, backed by Knowledge/Work/Code capability Adapters
- In-process: deterministic reconciliation and date normalization

### Internal Implementation

Internally it can use reducers, schema validators, prompt builders, bounded analysis windows, and reconciliation routines without exposing them.

### Depth, Leverage, Locality

Depth is high: three calls exercise substantial behaviour. Leverage is high because Discord, dashboard, jobs, and provider syncs share the same semantics. Locality is strong because meeting state semantics are concentrated in one Module.

### Testability

Behavioural tests use the same Interface as callers, with deterministic Adapters for true external dependencies and realistic persistence.

### Operational Complexity

The Module is more demanding to implement, but it keeps retries, concurrency, corrections, and deferred analysis in one place.

### Weak Points

This Module can grow too large unless internal seams stay private and are justified by real variation.

## Decision

Choose Candidate D.

Candidate C is useful inside the implementation, but Candidate D is the product-level Module. The public Interface stays small, and the implementation owns the durable evidence-first workflow that would otherwise leak into every caller.
