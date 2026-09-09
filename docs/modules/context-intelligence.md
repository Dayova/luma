# Context Intelligence Module

## Responsibility

Context Intelligence answers a bounded question from immutable conversation
evidence. It owns capture, durable source revisioning, Evidence validation,
answer generation, and idempotent replay beneath one read-only operation.

It is adjacent to Meeting Intelligence, not an extension of it. A Discord
thread does not become a synthetic Meeting merely because someone asks a
question about it.

## Public Interface

```ts
interface ContextIntelligence {
  inquire(input: ContextInquiry): Promise<ContextInquiryResult>;
}
```

The first supported subject is an explicitly selected `conversation-thread`.
Its caller supplies a stable inquiry ID, a question, and an anchor message. The
module—not the caller—captures and persists the bounded source revision before
asking its owned `ContextAnswerer` port.

## Invariants

- An inquiry ID is idempotent only for the exact original question and subject.
- A successful answer is bound to a specific immutable conversation revision
  and content hash. Replay revalidates the current bounded source before reusing
  that answer; it never reruns the Answerer for a completed inquiry.
- Stored answers are replayed only if their subject, boundary, and supporting
  Evidence still exactly match both the persisted source revision and a fresh
  eligible capture. Changed, removed, partial, or unreadable history blocks replay.
- The persisted result carries a SHA-256 corruption check; replay rejects a
  changed result rather than silently strengthening its wording or provenance.
- Facts, answers, and inferences are grounded in captured available Evidence. Inferences
  additionally carry confidence.
- Discord Ask rendering keeps facts and inferences visibly separate, includes
  confidence and captured Discord Evidence for each claim, and omits a claim
  that has no available supporting Evidence rather than presenting it as fact.
- Explicitly deleted messages remain visible as deleted evidence, but their
  text is never sent to the answerer and they cannot support a claim.
- A partial conversation boundary does not reach the answerer. It yields an
  insufficient-evidence result with the capture limitations made explicit.
- Context Ask has no Knowledge, Work, Follow-up, or provider-write capability.

## Current Boundary

The optional Discord runtime is disabled unless an operator explicitly enables
it with an allowlisted parent-channel set and Discord-user set. It listens only
for a leading `@Luma` mention from those users in public threads below those
parents; it never captures server-wide history, DMs, private threads, or a
thread after the triggering mention.

The runtime needs Discord's privileged Message Content intent because the
mention-only exception does not expose surrounding history. It bounds both
message count and captured text, and marks the result incomplete rather than
calling the answerer when history is truncated, unreadable, non-text, or contains
unknown bot, webhook, or system messages. Plain text messages from the currently
connected Luma bot are excluded with their IDs and author identity recorded and
a visible coverage note. They never become Human Evidence. They still count
toward scan limits; polls and other unsupported content remain incomplete even
when posted by Luma. This permits repeated questions in the same thread.

Completed answers are persisted before the final freshness check, so a source
edit during reasoning blocks publication without causing a duplicate paid run.
Before sending an evidence-derived Discord answer, the adapter rereads its exact
boundary, current anchor question, and bot reading permission, then rechecks the
configured channel scope. A change or loss of access produces a fixed recovery
message without old claims. These are bounded observations immediately before
delivery; Discord offers no atomic snapshot-and-send transaction.

Each new mention captures current history up to that mention. Approved captures
and their history are retained by default; failed freshness checks do not delete
them or infer deletion from an unavailable read. Continuous edit/delete event
retention, organization-wide ranking, and cross-provider retrieval remain
separate work. They are not required to ask about the current selected thread.
The OpenAI adapter requests `store: false`; this does not replace participant
notice or change Luma's durable evidence retention.

## Dependencies

- `ConversationEvidenceSource` is a provider-neutral capture port.
- `ObservedSourceLedger` is the shared immutable evidence ledger. Conversation
  records are distinct from Meeting Notes and cannot be tombstoned or fenced.
- `ContextAnswerer` is an owned read-only reasoning port. The OpenAI adapter is
  a boundary adapter and does not define Context state.
- Persistence is PostgreSQL-compatible PGlite in tests.

## Non-goals

- Converting conversations into Meeting Observations.
- Thread-wide Discord capture without explicit content-access policy.
- Context-aware provider writes, approval, reconciliation, or Follow-up
  execution.
- Inferring that an unread or absent Discord message was deleted.
