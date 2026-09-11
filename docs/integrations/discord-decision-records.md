# Explicit Decision Records in Discord

The founder can ask Luma to record an agreed decision in an enabled public thread:

- `@Luma create a decision record based on the discussion above`
- `@Luma update the existing decision based on what we just decided`
- `@Luma record this decision`
- `@Luma Bitte dokumentiere diese Entscheidung.`

For an unbound Conversation, only an original leading mention from an admitted founder routes to this capability.
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

## Imported Meeting decisions and Human review

In an existing founder-only thread, first attach the exact imported Notion page
with `/meeting bind`. Then use `/decision-record meeting instruction:<literal
instruction>`. An optional `target_record` selects an existing canonical record for
an explicit update. This uses that real imported Meeting; it creates no Meeting
or Conversation to stand in for the source.

An explicit owner decision such as `Ich entscheide: Luma bleibt intern bei uns vier
Gründern. Bitte festhalten.` can be recorded immediately when the source and
current ownership evidence support it. A generic instruction to record an
unattributed discussion retains a candidate instead. The requester's identity is
never attached to the imported transcript.

Use `/decision-record status request_id:<id> page:<number>` to read every part of
that candidate. The last page includes its exact review token. The accountable
owner can use `/decision-record accept request_id:<id> review_token:<token>
confirmation:<literal confirmation>` to confirm and record it. This retains a
separate original Human observation and does not call AI again. Missing scope,
objections or unresolved qualifications still need clarification; accepting a
candidate does not erase them.

For imported Meeting commands, omit `source_message`; the current thread binding
selects the source. Include `source_message` to address an existing Conversation
request instead. Status and recovery preserve both workflows. A changed binding,
source, audience or owner withholds the old response and blocks execution.

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

The main server composes the real Conversation source, governed Notion authority,
canonical Notion Decision Records adapter and OpenAI interpreter into the same
scoped MI and Follow-up Execution facades. It uses the existing database, Gateway,
observed-source ledger and USD30 monthly AI budget. The ordinary shutdown drain
waits for admitted decision work and final delivery. It can run independently of
conversation Ask, Meeting analysis and Notion Meeting imports.

The following additional settings are mandatory when enabling the capability:

```dotenv
LUMA_DECISION_RECORDS_NOTION_API_TOKEN=<dedicated-decision-writer>
LUMA_DECISION_RECORDS_DATA_SOURCE_ID=<canonical-notion-data-source-uuid>
LUMA_DECISION_RECORDS_CREDENTIAL_SCOPE_ID=<reviewed-writer-scope>
LUMA_DECISION_RECORDS_SIGNING_KEY=<stable-protected-key-at-least-32-bytes>
LUMA_DECISION_AUTHORITY_POLICY_PATH=/etc/luma/decision-authority.json
LUMA_CONTEXT_SHARING_POLICY_PATH=/etc/luma/context-sharing.json
LUMA_CONTEXT_NOTION_READONLY_API_TOKEN=<dedicated-read-only-token>
LUMA_CONTEXT_NOTION_CREDENTIAL_SCOPE_ID=<reviewed-read-scope>
LUMA_CONTEXT_NOTION_PAGE_IDS=<exact-reviewed-pages-including-ownership>
OPENAI_API_KEY=<shared-ai-account>
```

Use the existing protected sharing-policy format to grant the exact Decision
Records data-source ID under the writer scope to all four founder Person IDs.
Grant the exact ownership page and Decision Records data source under the separate
read-only scope to that same original audience. The Notion integration itself must have access to the selected
data source. Every record's actual parent and retained source grants are checked
at use time. A configured writer token alone never authorizes disclosure.

The [authority mapping](notion-decision-authority.md) is a protected `0600` regular
file with the actual ownership page ID, original Markdown SHA-256 and literal
Human evidence for each responsibility grant. It must be updated from reviewed
source evidence when that page changes. The authority reader does not promote
provisional role titles or elapsed meeting dates. Keep the stable signing key with
encrypted host recovery material; changing it makes existing signed records
unverifiable. Never place credentials or keys in the source page or repository.

Configuration validation happens before database allocation or Gateway connection.
Missing scopes, incomplete founder access, malformed IDs and absent credentials
fail startup. Unavailable current source/destination/authority evidence refuses
recording before an AI call or canonical mutation. Budget exhaustion is visible
without another paid call. Live source access, native Notion round-trip, production
secrets and host recovery still need deployment verification.

This path handles explicit Conversation and imported-Meeting recording instructions.
The same main runtime also implements [automatic source review](#automatic-source-review)
when explicitly configured, including admitted LogicalMeeting captures. Candidate
recognition alone grants no permission to record a decision.

The same runtime includes [background Decision recall](../decision-record-recall.md).
Discovery uses the dedicated read-only credential and never invokes the writer.
The index refreshes every five minutes; a question checks at most three selected
records live within the existing context deadline. Cold, stale or incomplete
discovery is exposed as partial coverage. Revoked original-source or recipient
access withholds a record even when its indexed terms remain locally retained.
The index drains before the shared database closes.

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

# Automatic source review

`LUMA_AUTOMATIC_DECISIONS_ENABLED=1` connects accepted Conversation Ask material and imported Meeting revisions to a durable Decision candidate queue in the main app. It requires the existing four-founder Decision Records configuration and uses the same monthly AI budget. Source ingestion remains independent from background interpretation. A source notification is retained before ingestion or Ask returns; repeated notifications for the same current evidence are coalesced by Meeting Intelligence.

Use `/decision-record candidates source_message:<original-message-id>` in the original Conversation, or `/decision-record candidates` in the bound imported Meeting thread. Optional `candidate` and `page` selections expose the full retained review and exact acceptance token. Every delivery rechecks the source, original audience and current channel binding. Queue, interruption and budget failures produce deterministic status text without requiring an AI response.

Enabling source review does not grant standing permission to create or amend records. Candidates require the ordinary exact Human acceptance unless a separate current Human standing policy authorizes the operation. An interrupted model attempt is retained and is not silently charged again at restart. The main app stops background admission immediately during shutdown and drains admitted work before closing persistence.

## LogicalMeeting addresses

`/decision-record meeting`, `candidates`, `status`, `accept`, and `recover`
accept an optional `meeting_id` from `/meeting captures`. This directly addresses
an already admitted LogicalMeeting, including Granola-only captures, from a
configured founder-only parent channel or its eligible thread. No synthetic
Meeting or thread binding is created. `meeting_id` and `source_message` are
mutually exclusive.

The main runtime resolves that exact ID through the owned current capture/source
proof for all four founders. The bot rechecks the same resolved identity, original
source access, founder audience and actual channel at response delivery. Replies
include `Meeting ID (meeting_id)` alongside the original request ID; carry both
into later status, acceptance or recovery commands.

On an existing imported Meeting thread, `candidates` uses its current proven
LogicalMeeting queue when available. Status, acceptance and recovery without an
explicit `meeting_id` continue to address the original imported request subject.
They never silently retarget old request IDs to a different LogicalMeeting.
The imported binding and capture resolution are both checked again at delivery.

### Automatic analysis recovery

A refusal proved to occur before an AI request was sent is retained with its next
retry time. The queue resumes it after restart, rechecking the exact original
source, audience, ownership and standing permission. Monthly or daily budget
refusals wait until their calendar reset; other unsent refusals use bounded
backoff. Each original source batch permits at most three total attempts.

`/decision-record candidates` stays read-only and displays the failure and retry
time. After repairing configuration or raising the existing budget, an admitted
founder may use the same command with `retry:true` for an earlier attempt. This
does not authorize recording or bypass the shared budget. Replaying the same
interaction does not consume another attempt. Unknown or dispatched attempts,
including legacy batches without a durable unsent proof, are never repeated by
this option or the scheduler. Check `/meeting usage` and the retained result
before starting a new explicit request.
