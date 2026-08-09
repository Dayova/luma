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
  and content hash. Replay retrieves that historic revision rather than
  recapturing or re-answering.
- Stored answers are replayed only if their subject, boundary, and supporting
  Evidence still exactly match the persisted source revision.
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
calling the answerer when history is truncated, unreadable, non-text, or
contains bot, webhook, or system messages. Capturing a current snapshot does
not promise future edit/deletion event retention; that needs its own consent
and retention slice. The OpenAI adapter requests `store: false`; that does not
replace channel consent or change Luma's own durable evidence retention.

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
