# Canonical Decision Records in organizational recall

The read-only Decision context catalog projects the verified current content of
canonical records into ordinary Organizational Context. It receives only the owned
DecisionRecordCatalog capability. Production must supply the dedicated read-only
Notion reader, including current destination, original source and historical
authority grants for every actual recipient.

An active record with its original Human acceptance and responsibility proof is
current Human-confirmed knowledge, regardless of age. A pending successor is
visibly proposed and cannot suppress its active predecessor. Superseded and
reversed records are excluded from current answers and remain labeled in explicit
history. A newer proposal, an unaccepted speaker preference or provisional role
allocation does not become a Human decision. Invalid acceptance/authority proofs
withhold the record instead of upgrading its standing.

The projection includes the statement, actual status and disposition, evidenced
rationale/alternatives/consequences/objections, original source citations and
responsibility evidence. It omits the full signed archive and unneeded raw
conversation text. Missing rationale stays missing. Current source versions and
explicit predecessor references invalidate stale receipts and preserve lineage.
Known citations use the provider's exact-reference read; an arbitrary logical ID
cannot silently select a different record.

The retained Organizational Context history stays stored after an amendment or
permission revocation. Returning it still requires current source access and its
original recipient grant. This catalog currently exposes each page's latest signed
record revision and previously retrieved revisions. Retrieving older archive
revisions that were never previously observed requires the pending bounded native
history capability; this implementation does not claim that behavior yet.

The behavioral tests use real Organizational Context and PGlite with a programmable
external Decision reader. They cover current/historical selection, pending lineage,
Human authority, revocation, replay invalidation, preserved snapshots and bounded
incomplete discovery. Actual native-reader composition and the cross-provider
evaluation must pass before this catalog is considered deployed or complete.

## Background discovery and live answer reads

`createDecisionRecallRuntime` in `src/organizational-context/decision-recall-runtime.ts`
owns candidate discovery in the shared store. It takes `database`, `workspaceId`,
`catalogId`, the dedicated read-only `DecisionRecordCatalog`, and a current audience
callback. It returns `catalog`, `start`, `stop`, `syncOnce` and asynchronous `status`.
Main composition starts it after construction and drains it before closing the store.
It does not create a model client, create a separate database or write to Notion.

The default interval is five minutes. A complete discovery of at most 100 records
runs outside Ask, under a four-minute deadline. The latest candidate manifest stores
only original recipients, exact reference identities, bounded lexical terms and
source discovery metadata. It contains no raw conversation archive or answer text.
It is a replaceable discovery index; canonical records and retained Context history
remain elsewhere unchanged. A failed/incomplete refresh retains the previous index
and records its coverage failure. A process interrupted during refresh cannot label
that attempt successful after restart. The manifest's integrity and original
recipient scope are verified before it can supply candidate IDs.

Search makes no Notion requests. It reports partial background coverage even after
a successful refresh, is explicitly not ready before the first valid snapshot, and
reports stale discovery after fifteen minutes by default. Old candidate metadata
never authorizes old content: every selected source goes through the actual reader's
exact-reference, source, authority and optional Human review checks. The default
candidate bound is three, with lexical matches ranked before active-state ties.
Larger result sets and changes not yet discovered remain explicit omissions.

Each live read has a 4.5-second cancellation bound within Organizational Context's
unchanged five-second catalog and fifteen-second total budget. A provider outage,
revocation, deletion or ambiguous proof withholds the record; cached content is not
a fallback. Background discovery uses at most 156 starts from the shared 180-request
minute window, reserving 24 for foreground requests. The reserve reduces contention;
it does not guarantee latency when other foreground clients also consume capacity.
Original retained proof reads follow the same background priority where supported.

Stopping the runtime blocks new sync/search/read admission, aborts native discovery
and live reads, and drains admitted work before returning. Periodic runs coalesce;
manual `syncOnce` joins an active run. `status` reports activity, scheduling, coverage,
indexed count and the last attempt/success timestamps without source text or secrets.
An operator may call `syncOnce` after a known canonical change without making Ask
wait for a refresh.

Behavioral tests compose the actual native reader, source-backed authority, PGlite,
background index and Organizational Context against deterministic asynchronous
Notion responses and a simulated 180/minute window. They prove a 100-record refresh
stays outside Ask, candidate search makes zero provider calls, selected records are
read live, and foreground recall still works while a background refresh waits.
These tests establish request and deadline behavior, not measured live latency.
Unseen archive revisions remain the explicit pending history capability above.
