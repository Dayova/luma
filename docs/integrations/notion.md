# Notion KnowledgeProvider

Notion is Luma's canonical provider for Meeting records, decisions, and durable organizational knowledge. It does not own executable work.

## Setup

1. Create a Notion internal integration for the environment.
2. Grant read, insert, and update content capabilities.
3. Open the Dayova Meetings data source and connect the integration.
4. Set the token and data-source ID in `.env`.

```dotenv
NOTION_API_TOKEN=
NOTION_MEETINGS_DATA_SOURCE_ID=3982e872-28bf-8080-bf00-000b188b90d6
NOTION_MEETINGS_TITLE_PROPERTY=Name
NOTION_MEETINGS_ATTENDEES_PROPERTY=Attendees
LUMA_NOTION_PROVIDER_ID=notion
LUMA_NOTION_MEETING_SYNC_INTERVAL_MS=60000
```

The configured schema expects `Name` as a title property and `Attendees` as a People property.

## Meeting Record

An approved `record-meeting` Intent writes one page containing:

- Conclusion summary and detail
- decisions and their current status
- Action Items, owner state, and due-date state
- open questions and risks
- Meeting Revision and approved Intent provenance
- an execution idempotency marker

Meeting participants resolve through the Identity Directory to Notion user IDs and populate `Attendees`. Original speech stays canonical in Luma's Evidence store; the Notion record is a concluded representation, not a replacement transcript source.

## Idempotency

The Notion API does not accept a caller idempotency key for page creation. Luma writes a visible, unobtrusive `Luma execution key` line and searches pages in the configured data source before creating another page. The durable local execution record provides the first retry barrier.

## Troubleshooting

- `object_not_found`: share the Meetings data source with the integration and verify its ID.
- Validation error for `Name`: configure the actual title-property name.
- Validation error for `Attendees`: configure a People property or remove that property only in a custom deployment.
- Missing attendee: confirm the Person has a Notion user ID and that the user is visible to the integration.

The Notion SDK is contained behind Luma's owned `NotionApi` facade and `KnowledgeProvider` Interface.

## Meeting Notes source

The read-only `NotionMeetingNotesSource` imports raw Notion AI Meeting Notes
from the configured canonical Meetings data source. It is deliberately separate
from the generic `KnowledgeProvider`: Meeting Notes lifecycle, transcript
completeness, and observed revisions are source concerns rather than generic
document semantics.

The source:

- pins the Notion API to `2026-03-11`;
- cursor-enumerates the configured data source instead of using the
  attendee-scoped Meeting Notes query as its primary feed;
- orders that enumeration by immutable creation time, so edits do not reorder
  cursor pages mid-scan; callers must drain `nextCursor` before treating a
  reconciliation as complete;
- waits for `notes_ready`, then recursively reads the summary, notes/action
  items, and transcript blocks and retrieves page Markdown with transcript
  inclusion;
- uses the root Meeting Notes block ID as the stable source identity;
- persists an immutable raw snapshot before any model analysis; and
- records `complete`, `not-ready`, or explicit `partial` states. A truncated
  Markdown response, unknown blocks, missing transcript, or unreadable section
  is never presented as complete original-speech Evidence.

`scan(...)` reports a `partialReasons` array as well as its completeness state.
A non-null `nextCursor` deliberately makes that one scan page partial; an
unreadable page or transient Meeting Note read is recorded there without
creating a synthetic source revision. If Notion reports its query result limit,
the source returns a non-retryable `source-enumeration-incomplete` reason rather
than claiming workspace coverage. Narrow or partition the canonical source
before relying on a complete reconciliation.

The source stores **Luma-observed** source revisions. It cannot reconstruct
Notion UI history or every intermediate edit that happened before a fetch. A
metadata-only change (such as `last_edited_time`) does not create a revision;
an A → B → A content sequence does create three chronological revisions.

`MeetingNotesIngestion` consumes a persisted observed source revision and
submits a provider-neutral `meeting-imported-from-source` Observation through
Luma's public Meeting Intelligence Interface. It records source-section
Evidence and turns explicit unchecked/checked source Action Item blocks into
Imported Action Item Candidates. Their original wording, modal language,
source-block reference, source revision, and owner/deadline uncertainty remain
intact; they are not silently promoted to confirmed work.
Recognized work-item mentions retain the configured WorkProvider identity with
their opaque external identifier, so identically named items cannot collide
across providers.

When a relative deadline identifies one calendar date, ingestion normalizes it
from an offset-bearing meeting or capture instant in the workspace timezone.
Offset-less or insufficient source timing remains explicitly ambiguous rather
than depending on the host machine timezone.

Each import carries an explicit source-section manifest. Meeting Intelligence
accepts the source Observation, its manifest-bound Evidence, and its revised
candidate state in one short database transaction. An unavailable Action Items
section is retained as partial source state rather than treated as deletion of
the last readable candidates; review uses the latest readable source revision,
not arrival order.

The source Observation also carries a flattened immutable Action Item block
manifest. A candidate can only cite a declared Notion block whose exact text
and completion state match its source Evidence.

Meeting Intelligence independently re-derives a candidate's language,
modality, owner wording, and mentioned work identifiers from that exact block
text, then binds identifiers to the declared source WorkProvider. It rejects self-asserted stronger semantics,
unbound project/component hints, or a document reference that does not match
the Notion source identity.

In the executable, `MeetingNotesSync` cursor-drains this source on startup and
at the configured interval. It deliberately replays unchanged ledger revisions:
the ledger capture and Meeting Intelligence delivery are separate durable steps,
so a process interruption after capture must not drop a source revision. A
ledger-backed source verifier admits only the byte-for-byte deterministic
projection of a persisted revision; a structurally valid payload submitted
directly to Meeting Intelligence is rejected.

After—and only after—a complete, fully readable cursor drain, the Notion source
compares the observed Meeting Notes roots with immutable ledger heads. A root
that is absent becomes a new immutable `removed` tombstone revision and is
delivered through the same verifier and ingestion path. That removes its current
Action Item Candidates and invalidates suggested reconciliation Intents; an
already approved Intent is stopped at execution with a stale-source receipt.
Tombstones replay idempotently until delivered. Partial enumeration, a
permission error, or an unreadable Meeting Note never implies deletion: those
remain unavailable/partial source states and preserve the last readable
candidates.

This remains mutation-free. Source import does not create Linear work or mutate
a Notion page. The reconciliation slice may only produce reviewable proposals
until Human Judgment and an approved Follow-up Intent authorize a later
execution.

## Non-mutating Live Test

```bash
set -a
source .env
set +a
LUMA_LIVE_NOTION_TESTS=1 pnpm test -- tests/knowledge/notion-knowledge-provider.live.test.ts
```

## Meeting Notes source live proof

Use a dedicated standard Notion connection with `read_content` access to the
canonical Meetings data source and a known `notes_ready` Meeting Notes block
that has a calendar attendee, summary, notes/action items, and transcript. The
test drains data-source cursors, then rereads the target page to prove
idempotency. It is read-only; it never calls an insertion, update, or delete
API.

```bash
set -a
source .env
set +a
LUMA_LIVE_NOTION_MEETING_NOTES_TESTS=1 \
LUMA_NOTION_LIVE_MEETING_NOTES_BLOCK_ID=<root-meeting-notes-block-id> \
pnpm test -- tests/knowledge/notion-meeting-notes-source.live.test.ts
```
