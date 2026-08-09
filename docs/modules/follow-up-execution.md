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
- An approved reconciliation resolves through one opaque
  `settle-operational-outcome` Intent. The executor derives its target and
  rendered content from current canonical Meeting State immediately before use;
  callers do not supply page Markdown or provider targets.
- A settlement writes a compact Luma-owned aggregate on its source page, rather
  than replacing the page or adding one standalone page section per candidate.
  A durable page lease serializes aggregate materialization, and a page can be
  owned by only one Luma workspace. Within Luma's supported one-process,
  one-PGlite-instance deployment, an executor-run mutex also rejects a second
  concurrent execute/recover request before it can share that durable lease.
  A future multi-process deployment must add database-level recovery fencing
  before sharing one database.
- Before the first Work or Operational Outcome provider boundary, a
  source-bound settlement atomically fences the exact observed-source ledger
  head it was approved against. Source sync consequently reports retryable
  partial coverage rather than advancing or tombstoning that root while the
  execution is active. The fence is released in the same durable transaction
  that completes the canonical receipt; an interrupted recovery must acquire
  the current head again before it can resume a provider write.
- If a blocked scan observes different upstream source material, it records a
  durable supersession signal on the held fence without promoting that material
  to the ledger head. The executor checks that signal immediately before Work
  and again before page writeback, so a known newer source suppresses the next
  provider mutation. A provider-level compare-and-swap would still be required
  to prove freshness against an edit that occurs after the final check itself.
- If the Notion writer proves that a retryable outcome write was not applied,
  its already settled work stage is retained and the result is
  `partially-succeeded` and recoverable. Recovery resumes only the pending
  outcome stage; it never repeats settled work mutations.
- A writer error that proves no page mutation occurred is a non-retryable
  failed result and releases its page lease so a fresh reviewed outcome can be
  proposed. An indeterminate provider result, by contrast, retains the lease
  and becomes `requires-manual-recovery`.
- Recovery of a manual Operational Outcome is normally a read-only exact-marker
  probe: it can complete and release the lease only when the persisted prepared
  aggregate is found byte-for-byte. The narrow no-probe exceptions are durable
  records made before the writer boundary or an adapter's explicit no-write
  receipt; either may discard a prepared aggregate and release its lease only
  because it proves no page mutation started. Recovery never rewrites an
  unknown page state or offers a generic unlock.
- Execution outcomes are normalized as succeeded, partially succeeded, failed,
  or requires-manual-recovery Observations.
- Discord rendering consumes provider-independent events emitted by Meeting Intelligence.

## Dependency Classification

- KnowledgeProvider: true external Adapter.
- WorkProvider: true external Adapter.
- CodeProvider: true external Adapter.
- MeetingIntelligence: in-process Module Interface.

## Current Implementation

The current implementation supports approved `create-work-item`,
`record-meeting`, and `settle-operational-outcome` paths. New generic
`update-knowledge` proposals are retained only as policy-rejected audit
records: Luma does not create or update a canonical Notion document until
LUM-11 provides a Human-selected target, exact region, and conflict policy.
For a historical generic document create whose outcome was already
indeterminate, or whose execution was interrupted while its reservation was
still held, `recoverClaimedIntent` may only use the same read-only exact
idempotency-marker probe and record that already-created document; it never
retries or creates a document. A settled reconciliation can create or link work
as approved, then records the compact page-owned Operational Outcome aggregate
on the canonical Notion source page. Its work and outcome stages have
independent durable state, and source freshness is rechecked before the outcome
write, so a known-not-applied Notion write remains resumable without repeating
a completed Linear mutation.

Exact GitHub pull-request and full commit URLs found in an immutable Action Item
source block are source-bound display provenance only. A new settlement freezes
that exact list in its durable plan before any provider boundary and renders it
under **GitHub implementation references (source-bound)**. It does not call
GitHub, search for related code, infer implementation status, or mutate a code
host; historical v1/v2 settlement plans continue to render no such links.

It supports `update-work-item` only when the active WorkProvider offers an
atomic conditional update; Linear does not, so its reconciliation updates remain
manual review. `comment-on-code-change` is explicitly rejected until Luma has
a write-capable CodeProvider. New executable work is written to Linear, Meeting
records and approved reconciliation outcomes are written to Notion, and
resulting external references are recorded on Meeting State. Discord renders
deterministic receipts; a live execution lease is never silently stolen after a
process interruption. A mapped Luma participant can run
`/meeting recover intent_id` for an approved Intent with a stranded execution
lease, a resumable Operational Outcome settlement, or a manual settlement.
That command performs only positive recovery probes: a resumable settlement
can finish its pending outcome stage, while a manual settlement can only prove
the exact prepared marker and release its lease. A durably provider-confirmed
prewrite interruption or adapter-confirmed no-write is the narrow exception:
it may abandon its uncalled write and release the lease. It never repeats a
completed work mutation or writes an unknown page state.
