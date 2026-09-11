# Canonical Decision Records in Notion

`createNotionDecisionRecords` implements the owned DecisionRecords capability
against one configured Notion data source. The Decision Intelligence module
remains responsible for source interpretation, actual decision authority,
reconciliation and approving a provider-independent execution plan. The adapter
does not turn a page title, vote count or requester identity into authority.

Each write stage sends at most one native Notion mutation. Creating a successor
starts with a **pending** record. A later stage retires its predecessor and links
the successor; only then may another stage activate it. The execution module
must persist each receipt before continuing. Amendments retain the existing
record identity and append a revision. Prior decisions and their source evidence
are retained, including when superseded or reversed.

The page displays the current statement, disposition, status, rationale,
alternatives, consequences, objections and source links. Evidence and revision
history are folded into a Notion toggle. A stable `Decision DR-…` title identifies
the page; the current wording is in the body, so an amendment needs only one
atomic exact-region operation. Content outside the owned region is preserved.

The adapter requires the canonical data source ID, write integration token, a
stable protected signing key of at least 32 bytes, and current authorization
callbacks for the destination, every retained original source and each retained
authority snapshot's own source. If a revision includes supplemental original Human
reviews, `authorizeRetainedHumanReview` must independently verify each retained
review's original actor, source and audience. Missing review authorization withholds
that archive. Every actual
recipient must belong to each revision's original audience and retain source
access. The source callback must verify access, deletion and exclusion without
requiring old wording to equal the latest wording: old eligible evidence is
history. Destination access alone cannot authorize disclosure of private source
evidence. Include the protected signing key in the host's encrypted recovery
material; never put it in Notion or logs.

Toggle child blocks use native tab indentation and prose escapes Notion's special
characters. Only plain empty lines are normalized when verifying the readable
region; the complete signed archive and all nonempty text still have to match.
The exact reread section remains the old region used for a subsequent update.

Plain statement/context text and text inside owned bullets escape leading `-`,
`+` and ordered-list markers. Inline punctuation remains ordinary prose, so a
provider round trip cannot reinterpret a claim as a nested list.

The prelaunch v1 format defines canonical object-key order by UTF-16 code units,
independent of locale or ICU. This replaces the earlier locale-dependent local
prototype before any live canonical writes; synthetic fixtures are regenerated.
The reader does not guess legacy collation or silently re-sign an incompatible
archive. Future signed-format changes need explicit versioning and retained-history
migration rather than changing this byte contract in place.

The signed archive binds the workspace, data source and complete revision history.
Tampering inside the owned region, moving a record, duplicate record identities,
incomplete discovery, unknown pages or revoked grants withhold the catalog and
block writes. Signing proves Luma's stored operation history, not that an AI
interpretation is correct. Human edits can be made outside the owned region;
changing the record itself requires a fresh reviewed operation.

Discovery is bounded to 100 records, ten pages and a four-minute operation deadline.
Owned history is bounded to 100 revisions and 180 KB; reaching a bound stops the
operation without pruning history. Increasing these limits requires an explicit
implementation change. The native SDK has retries disabled. The owned scheduler
retries only safe reads, at most twice after an overload or transient server response,
and honors `Retry-After`. A dispatched mutation is never retried. A timeout after
dispatch is **unknown**, and `findWritten` only accepts the exact latest signed
operation and expected result; it never repeats a write. A proven prewrite refusal
is distinct from an uncertain send.

`createNotionDecisionRecordCatalog` exposes only the owned read-only catalog port
using `readOnlyApiToken`; its transport has no mutation methods. Use a dedicated
read-only Notion integration. `read` resolves an arbitrary logical or provider ID
against complete discovery and refuses ambiguity. `readReference` reads an exact
previously verified provider reference, including exact parent and current source
grants, without scanning unrelated records. Known immutable catalog snapshots are
checked against complete ID listings and exact full Markdown plus native heads;
timestamps alone never prove unchanged content.

The native Decision writer, reader and governed ownership-page reader share a
per-credential scheduler. It admits at most four concurrent requests and 180 starts
in a sliding 60-second window. Background discovery is limited to 156 starts,
reserving 24 for foreground reads and writes; it carries that priority through
retained Notion authority reads too. Notion currently documents 180 requests/minute for
non-Business/Enterprise connections and 600 for Business/Enterprise, with additional
workspace limits. The conservative local window covers either plan; independent
processes and other integrations can still consume provider capacity. Native fetch
is aborted on a four-second request timeout or the overall deadline. Queued work is
cancelled at the deadline and cannot start a late mutation.

Within each complete pass, exact retained source, authority and Human review proofs
are deduplicated and freshly checked after the records are read. Nothing is cached
across operations. Creating a record reuses one pre-create discovery for recovery
and duplicate detection, rechecks all exact catalog bytes and current grants before
dispatch, then verifies the exact native page returned by a successful create. A
lost acknowledgement still needs complete positive recovery. The caller's exact
source/authority guard and destination grant run after a queued wait; if their own
reads consume the remaining window, the scheduler waits and runs the proof again.

Deterministic native SDK tests with a simulated 180-request service window and
asynchronous responses establish these request counts when all records share one
retained source and authority snapshot:

| Operation                                        | Decision connection requests | Ownership connection requests |
| ------------------------------------------------ | ---------------------------: | ----------------------------: |
| Discover 100 records                             |                          302 |                             3 |
| Revalidate that complete snapshot                |                          202 |                             3 |
| Create the 100th record from 99 existing records |                          503 |                            18 |
| Read one known reference                         |                            3 |                             3 |

The create count includes a real current authority guard. Distinct retained sources
or authority snapshots add their own fresh proof reads. These are request-count and
queue/deadline regressions, not measurements of live Notion latency. High contention,
large source histories or repeated overload can still hit the bounded deadline and
produce a visible refusal or unknown outcome rather than weaken authorization.

The deterministic tests exercise the pinned SDK request shape, stale targets,
retained history, source and destination revocation, interrupted writes, lineage,
idempotency and deadlines. Live Notion Markdown round-trip normalization and the
configured destination/source grants still require deployment proof. This adapter
does not activate a source or compose the main runtime by itself.

Native contracts: [creating pages](https://developers.notion.com/reference/post-page),
[updating page Markdown](https://developers.notion.com/reference/update-page-markdown),
[enhanced Markdown](https://developers.notion.com/guides/data-apis/enhanced-markdown)
and [request limits](https://developers.notion.com/reference/request-limits).
The implementation uses API version `2026-03-11` and pinned SDK 5.23.1.
