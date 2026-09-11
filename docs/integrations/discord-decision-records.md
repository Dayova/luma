# Explicit Decision Records in Discord

The founder can ask Luma to record an agreed decision in an enabled public thread:

- `@Luma create a decision record based on the discussion above`
- `@Luma update the existing decision based on what we just decided`
- `@Luma record this decision`
- `@Luma Bitte dokumentiere diese Entscheidung.`

Only an original leading mention from an admitted founder routes to this capability.
Questions, quoted instructions, bot messages and guest messages do not authorize a
write. Enabling conversation Ask does not enable Decision Records. The source is
bounded through the instruction message; subsequent messages require a new request.
The conversation does not need a Meeting binding and no synthetic Meeting is created.

The Discord edge forwards the exact instruction to the subject-aware Meeting
Intelligence `observe` Interface. That owned module captures the original source,
interprets the decision, checks source-backed authority and the canonical target,
and returns an approved Follow-up Intent only when the request is justified. The
edge invokes Follow-up Execution with that intent and renders the source-guarded
canonical request. It never extracts a decision, chooses its authority or writes a
provider directly.

An explicit recording instruction does not prove that the underlying decision was
accepted or that its requester owns the topic. Tentative statements, missing
rationale, unresolved objections and ambiguous existing targets retain their actual
standing. Clarification does not cause a canonical write. Poll wording and aggregate
results remain advisory; generated poll text is not attributed to a Human. Raw
German, English and mixed-language wording is retained unchanged.

## Scope and configuration

The shared Discord runtime accepts these independently reviewed settings:

```dotenv
LUMA_DISCORD_DECISION_RECORDS_ENABLED=1
LUMA_DISCORD_DECISION_RECORDS_PARENT_CHANNEL_IDS=<founder-only-text-parent-ids>
LUMA_DISCORD_DECISION_RECORDS_ALLOWED_DISCORD_USER_IDS=<the-four-founder-user-ids>
LUMA_DISCORD_DECISION_RECORDS_MAX_MESSAGES=50
LUMA_DISCORD_DECISION_RECORDS_MAX_EVIDENCE_CHARS=32000
LUMA_DISCORD_DECISION_RECORDS_MIN_INTERVAL_MS=60000
```

Every selected parent must also be in the common Discord parent allowlist. Native
capture checks live channel readership, and the Decision Evidence adapter separately
maps each Human author to one current admitted founder. The configured source
audience is retained with the original immutable capture. Freshness checks read the
same original revision and re-read the live boundary without mutating the ledger or
calling a model. Changed text, boundary, author identity or access invalidates the
proof. Poll result and expiry changes alone do not rewrite the original capture or
supply decision authority.

The main runtime also requires the configured canonical Decision Records target,
current source-backed ownership and the budgeted interpreter. Those dependencies
must be supplied to the scoped MI and Follow-up Execution facades; a Discord feature
flag alone does not provide them. There is one Gateway client and the ordinary
shutdown drain waits for admitted decision work and final delivery.

## Receipts, replay and recovery

The response includes the canonical request ID, original source message ID, current
state and known record links. Keep those identifiers if a later check is necessary:

- `/decision-record status source_message:<original-message-id> request_id:<request-id>`
  reads the retained request without another interpretation or write.
- `/decision-record recover source_message:<original-message-id> request_id:<request-id>`
  checks an uncertain operation for an exact existing write. It does not resend an
  uncertain mutation.

Replay uses the original message-derived observation identity. The owned durable
request and Follow-up Execution records prevent duplicate interpretation and writes.
If execution throws after a possible success, the edge still tries a fresh canonical
query so a known receipt is not hidden. If that proof fails, the old private result
is withheld. A final query and current actor/channel check run again at the actual
Discord delivery boundary; a correction cannot authorize delivery of old wording.
Dynamic mentions are disabled in all replies.

## Reading retained Decision history

`ConversationDecisionEvidenceSource.authorizeRetained` is a read/projection check
for a canonical record's original source. It reconstructs the exact original
source from the immutable ledger revision and checks its admitted audience, then
reads the complete current Conversation boundary and current author identities.
The requested reader set must be a nonempty subset of the original recipients.

Edited wording, edit timestamps, renamed labels and advisory poll changes do not
erase the retained history. Deleted or excluded source messages, erased text,
removed polls, changed authors, moved source boundaries, missing original captures
or revoked access deny the read. The native instruction anchor must still belong
to the admitted leading-mention surface. The read check never updates the ledger
or authorizes another write; `requireCurrent` continues to demand the exact current
execution source. Retained statements and poll counts keep their original meaning
and standing.
