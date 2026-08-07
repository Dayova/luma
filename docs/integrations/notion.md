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

This is an ingestion foundation only. It does not yet submit source data to
Meeting Intelligence, create Linear work, or mutate a Notion page. The later
reconciliation slice must consume persisted source snapshots through Luma's
public Meeting Intelligence interface and keep Notion-generated action items as
proposals pending Human Judgment.

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
