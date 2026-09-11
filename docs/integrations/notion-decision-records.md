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
callbacks for the destination and every retained original source. Every actual
recipient must belong to each revision's original audience and retain source
access. The source callback must verify access, deletion and exclusion without
requiring old wording to equal the latest wording: old eligible evidence is
history. Destination access alone cannot authorize disclosure of private source
evidence. Include the protected signing key in the host's encrypted recovery
material; never put it in Notion or logs.

The signed archive binds the workspace, data source and complete revision history.
Tampering inside the owned region, moving a record, duplicate record identities,
incomplete discovery, unknown pages or revoked grants withhold the catalog and
block writes. Signing proves Luma's stored operation history, not that an AI
interpretation is correct. Human edits can be made outside the owned region;
changing the record itself requires a fresh reviewed operation.

Discovery is bounded to 100 records, ten pages and a 15-second operation deadline.
Owned history is bounded to 100 revisions and 180 KB; reaching a bound stops the
operation without pruning history. Increasing these limits requires an explicit
implementation change. Provider retries are disabled. A timeout after dispatch
is **unknown**, and `findWritten` only accepts the exact latest signed operation
and expected result; it never repeats a write. A proven prewrite refusal is
distinct from an uncertain send.

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
