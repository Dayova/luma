# Multi-capture Luma Synthesis

The LUM-35 synthesis path consumes the exact active capture set of one Logical
Meeting. It preserves each provider's original archive and references it from a
separate, immutable derived revision. It does not combine source material into a
purported transcript or make a derived decision a canonical Decision Record.

## Intake and current source material

`createMeetingCaptureIngestion` turns a LogicalMeetings result into a deterministic
`meeting-capture-set-observed` Observation. The public caller still uses
Meeting Intelligence's `observe` Interface. The Observation contains capture IDs,
source revisions and hashes, with no caller-supplied notes or synthesis text.
MI checks the full current binding set, obtains the actual recipient audience,
and reads every capture through `MeetingCaptureAccess`. An inaccessible capture
withholds the synthesis; it is not silently omitted from a comparison.

The production Granola Adapter delegates to its protected original-audience,
account/workspace and live-material reader. Its opaque authorization scope changes
with the consenting connection/account grant. The Notion Adapter verifies the
exact current source-ledger projection, requires the original imported-source MI
receipt, and reuses the dedicated live source/sharing capability before returning
archive sections. Notion canonical source ingestion must therefore precede its
delivery into the multi-capture path. A broader audience cannot inherit a prior
synthesis or a prior source grant.

The Granola scheduler's `onResolved` delivery runs inside the owned sync operation.
Replays still reach MI to recover an undispatched attempt, while the source-set
and Observation identities prevent duplicate paid synthesis. The scheduler waits
for downstream synthesis before completing its run or clean shutdown. Main
runtime composition must supply this callback and the same reasoning/budget
instance used by the other Meeting workflows.

## Derived claims and Human Judgment

Claims retain stable identities, individual material citations and confidence.
Conflicting claims remain separate with reciprocal conflict references. Every
later synthesis must retain the known unresolved conflict graph, including
conflicts between inferred claims. Missing counterpart evidence withholds that
new synthesis and preserves the prior revision; model omission is not treated as
resolution. Existing counterpart claims retain reciprocal edges even if the
model forgets the flags.
Every model-derived claim is labelled inferred; it cannot confirm an owner, create work
or authorize an external mutation. Exact quotations are a separate field and
must be exact substrings of material explicitly marked verbatim/original speech.
Basic enhanced notes cannot satisfy that condition. Ordinary model claim text
cannot use double-quotation delimiters as a way around the quotation check.

`capture-synthesis-judgment-recorded` records an explicit participant's confirmation,
rejection or correction of a current claim. The participant must be in the current
authorized audience and the expected synthesis revision must match. Its immutable
history and effective text survive later provider/model revisions. Human-dependent
claims cannot follow a removed/rebound capture or a replacement authorization
scope into a new synthesis automatically; that case remains unavailable for
review instead of transferring private context or overwriting Human authority.

`query({ type: "capture-synthesis" })` returns a guarded snapshot or explicit
not-configured/not-produced/unavailable state. It rechecks original recipients,
current source bytes, authorization scopes and binding before delivery. Historical
source and synthesis revisions remain retained. These are read/currentness checks,
not an atomic transaction with an external provider.

## Cost and revisions

The OpenAI Adapter supports the bounded structured synthesis proposal through the
existing durable AI budget and reports its costs as `meeting-capture-synthesis`.
Monthly limits and provider errors retain the existing safe operational codes.
Only a proven undispatched attempt can automatically retry the same source set.
A dispatched or uncertain attempt is retained and cannot silently repeat a paid
request. Source changes create a new candidate synthesis revision; unchanged
material does not. Model output is discarded when current source, grant or binding
proof changes in flight. A separately accepted Human revision is never overwritten
by a stale model result.

The source proof is repeated after the durable paid-attempt claim and before any
source text reaches the model. Revocation during database admission therefore
prevents disclosure and safely releases the undispatched attempt.

## Approved canonical publication

`conclude` and the guarded capture-synthesis query expose a suggested
`publish-meeting-synthesis` Follow-up Intent for the exact derived revision, source
set and recipient audience. An existing `follow-up-intent-approved` Observation
from an admitted founder authorizes that revision. Callers cannot supply a body or
destination. A stale revision, wider audience, revoked source or conflicting
physical-page lease prevents dispatch.

`createFollowUpExecution({ meetingSynthesisWriter, ... })` executes and recovers
these Intents through the same public MI facade. The production
`createNotionMeetingSynthesisWriter` requires a protected stable signing key,
Notion token, workspace ID, Imported Meetings data-source ID, and an authorization
capability for both exact pages and that data source. The data source needs its
title property (default `Name`) and a rich-text key property (default
`Luma Meeting ID`). Main-runtime composition supplies this writer and the current
founder sharing policy; the writer creates no schema or sharing grants itself.

A verified existing Notion Meeting Note is reused. Without one, the writer queries
a deterministic Logical Meeting key and creates one ordinary Imported Meeting
Record. It never creates a native Meeting Notes block or modifies source captures.
Only the signed `Luma Synthesis` region is appended or exactly replaced. Existing
Human text, original notes and separately owned Operational Outcome content stay
outside that region. Contradictions, Human authority, source links and raw/derived
capabilities remain visible; publication itself does not approve canonical
Decisions or execute work. Previous derived revisions remain in local history.

The durable operation plan precedes dispatch. A lost response leaves an uncertain
operation; recovery only accepts an exact signed positive receipt and never
resends an unproven mutation. A positive provider response is retained before
local bookkeeping. The resulting reference is then projected into LogicalMeetings'
canonical anchor, so a new facade instance and downstream consumers use that same
page. A conflicting existing anchor is preserved for manual review. A local
anchor failure can recover from the saved positive receipt without another write.
Publication metadata changes do not trigger paid analysis of unchanged captures.

The Notion Adapter uses the actual SDK without retries, bounded HTTP reads that
abort the actual request, and the shared physical-page lease used by Operational
Outcome publication. Signed Markdown uses native toggle indentation and tolerates
Notion's removal of empty lines. Literal source markers cannot be interpreted as
owned-region boundaries. Unknown provider outcomes remain visible for recovery.

## Remaining runtime delivery

The unified main runtime still needs Granola scheduling, source/MI and publication
composition, and a founder-facing synthesis/review projection. Live individual
OAuth/account attestation and real MCP output-shape compatibility validation remain
activation prerequisites. No personal connection, provider write, canonical page
or production deployment is activated by these tests.
