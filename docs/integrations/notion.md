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
metadata-only change (such as `last_edited_time` or a URL refresh) does not
create a revision; an A → B → A content sequence does create three
chronological revisions. An unchanged source root moving to a different parent
page also creates a revision: that parent page is the external Operational
Outcome target and must remain immutably bound to the source revision.

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

An active source-bound Operational Outcome settlement also holds a durable
fence on its exact ledger head. A scan that encounters that fence reports the
retryable `source-execution-fenced` partial reason and neither records a newer
revision nor tombstones the root. Follow-up Execution releases the fence only
when Meeting Intelligence has accepted and durably completed its terminal
receipt; recovery rechecks and reacquires the current head before a resumed
provider mutation.

If a fenced scan does read a different upstream root, it records that durable
supersession on the held execution fence while retaining the immutable ledger
head. Follow-up Execution sees the signal before each Work/page mutation and
stops the stale settlement; source ingestion retries after terminal cleanup.
The boundary is intentionally local to observed source state: Notion does not
offer the source-version compare-and-swap that would fence an edit made after
the final verification read.

This remains mutation-free. Source import does not create Linear work or mutate
a Notion page. The reconciliation slice may only produce reviewable proposals
until Human Judgment and an approved Follow-up Intent authorize a later
execution.

## Webhook wake-up foundation (not activated)

LUM-29 adds an isolated observation seam for Notion webhooks. It is **not**
wired into `startServer`, Discord, an HTTP listener, an environment flag, or a
deployed Notion subscription. No verification token is read from environment or
stored by this repository.

When a future host explicitly composes it, the host must give
`NotionWebhookWakeUpIngress` the exact raw request bytes and a verified
subscription token. The ingress validates Notion's documented
`X-Notion-Signature` HMAC-SHA256 over those raw bytes, checks the configured
workspace (and optional subscription/integration IDs), accepts only normalized
Notion UUID page IDs before any provider read, and emits only one of:

- a bounded page wake-up for `page.created`, `page.content_updated`, or
  `page.properties_updated`; or
- a canonical reconciliation wake-up for `data_source.content_updated` on the
  configured Meetings data source.

It discards all webhook payload content. The resulting runtime re-fetches the
current page through `NotionMeetingNotesSource.refreshPage(...)`, proves that
the page is still in the configured canonical Meetings data source, and reuses
the same snapshot capture and observed-source ledger as a normal scan. A
direct refresh never infers a deletion or creates a tombstone. An unrelated,
trashed, or no-longer-canonical page is ignored; only a completed canonical
scan can establish source absence.

Duplicate/retried and out-of-order signals are coalesced by delivery and page.
A `data_source.content_updated` signal supersedes queued page reads with one
full scan. The direct page queue is bounded; overflow promotes the batch to a
single canonical scan and records overflow telemetry. The existing
`MeetingNotesSync` schedule remains mandatory: it is the recovery path for
missed events, not-ready/partial notes, terminal deletion races, endpoint
failures, and later edits. Runtime telemetry exposes only arrival/wake-up
times, bounded pending work, overflow, reconciliation success/partial failure,
and non-canonical lag; webhook history is never source Evidence.

The runtime receives a page refresher, `MeetingNotesIngestion`, and the
existing canonical reconciliation capability—but never a WorkProvider writer,
KnowledgeProvider writer, or Follow-up Execution capability. A behavioral
database test proves an authenticated wake-up can record an Observation receipt
with zero `follow_up_executions` rows.

Before activation, a host still needs a publicly reachable TLS endpoint,
explicit subscription configuration and one-time Notion verification-token
handoff, a dedicated secret store, production persistence/observability, and a
separate deployment review. Those are operational activation tasks, not a
license to enable canonical Notion writes or Discord execution.

## Source-bound native review core

`SourceBoundNativeReview` is a dormant, read-only core for a future native
Notion review surface. It receives only a trusted native run ID, an
authenticated provider actor, and an exact page identity. It does **not**
accept a Person ID, attendee identity, Meeting Note root, ledger revision,
content hash, model claim, or generic Linear request from that surface.

The core resolves the actor through `IdentityDirectory`, captures exactly one
provider-derived Meeting Note root for that requested page, records and
re-reads its immutable ledger revision, then drives the existing ingestion and
reconciliation seams. Its durable result is idempotent by native run ID and
contains only the mapped actor, source revision/hash, review IDs, and opaque
work lookup references. An unmapped/ambiguous actor, unreadable or ambiguous
page/root, incomplete source, or read-only catalog failure produces a durable
safe clarification and never a provider mutation.

This core is intentionally **not wired into the executable yet**. The current
server's ordinary Notion source and writer-derived Linear catalog do not prove
the three required deployment properties:

- trusted native ingress that authenticates the provider actor and exact page;
- direct, object-scoped read access to that exact page (not a broad source
  scan filtered after the fact); and
- a separately composed `LINEAR_READONLY_API_KEY` catalog, never
  `LINEAR_API_KEY` or a `WorkProvider` writer.

`createDormantSourceBoundNativeReview` now owns the safe, inject-only assembly
of the exact-page source, source ledger, workspace-scoped issued read-only
Linear catalog, immutable-source verifier, durable Operational Outcome marker
verifier, Meeting Intelligence, ingestion, and this core. It returns only
`review(...)`; it has no environment factory, server registration, OAuth flow,
provider SDK, or runtime export. Its catalog must be issued by the dedicated
read-only Linear factory, so a narrowed writer catalog cannot accidentally
enter this composition.

LUM-30 separately supplies the exact-page reader that this dormant composition
may receive. `createNotionObjectScopedMeetingNoteEvidenceReaderFromEnv` reads
only `LUMA_NATIVE_NOTION_READONLY_API_TOKEN` and
`LUMA_NATIVE_NOTION_PAGE_ID`; it never falls back to `NOTION_API_TOKEN` or a
data-source credential. It constructs only the three bounded Notion read
operations for that page, not the native-review composition or any ingress.
This explicit reader configuration therefore does not activate the server,
OAuth, browser/native agent, canonical write, or Discord behavior.

The exact-page source owns a fresh callback-scoped reader session for every
capture, so overlapping captures cannot share provider-derived block authority.
Production construction exposes no raw page, Markdown, or block-read methods:
the session is revoked as soon as its capture callback settles.

Do not enable this surface through an environment flag alone. Production
composition must supply evidence for all three properties first.

## Operational Outcome writeback

After an approved reconciliation settlement, Luma records its compact
Operational Outcome aggregate on the canonical Meeting Notes page. This is a
narrow, page-owned writeback: Luma appends its section when absent or replaces
only the exact Luma-owned section. It never replaces the whole page or treats
ordinary source content as writable.

Before materializing an aggregate, the executor confirms that the page belongs
to the settlement workspace and takes a durable page lease. This prevents two
workspaces from claiming the same Notion page and serializes concurrent
aggregate updates. The write uses a complete Markdown read and a durable
receipt. A known-safe, retryable Notion non-write leaves the settlement
`partially-succeeded` and recoverable. A known non-retryable no-write fails
without retaining the page lease, so a fresh Human-reviewed outcome can be
proposed. An indeterminate response retains its lease and requires a manual,
read-only exact-marker proof rather than an automatic replay or generic
unlock. The only no-probe release is a durable executor record made before
the Notion writer boundary or the adapter's explicit no-write receipt, each
of which proves that no page mutation started.

Every Luma outcome section carries an ownership marker whose payload, content,
and operation digests are verified against a successful durable settlement for
the same workspace, provider, and page. The Meeting Notes source strips a
section only after that proof. A missing verifier, malformed, duplicate,
edited, or merely checksum-valid but unverified marker makes the scan partial:
Luma records no source snapshot for that page and withholds complete-scan
tombstoning. This prevents Luma's own writeback from producing a synthetic
source revision and prevents an untrusted marker from being silently discarded.

If a later complete source scan tombstones the Meeting Notes root, the
corresponding reconciliation outcomes are stale. Luma invalidates their pending
or resumable settlements and does not write their aggregate during execution
or recovery.

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
