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
model-derived claim is labelled inferred; it cannot confirm an owner, create work
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

## Remaining LUM-35 delivery work

This commit establishes and tests the MI/source path. The same issue still needs
the approved `publish-meeting-synthesis` Follow-up Intent and provider writer,
bound to the exact synthesis revision, source set and recipient audience. A
verified existing Notion Meeting Note is the original canonical anchor. Without
one, the writer must upsert a single configured Imported Meeting Record with a
deterministic external marker; it must not create a native Meeting Notes block.
The writer owns only Luma Synthesis, with Operational Outcome retained separately.

The main runtime still needs Granola scheduling, source/MI composition and a
founder-facing synthesis/review projection on the unified runtime branch. Live
individual OAuth/account attestation and real MCP output-shape compatibility
validation remain separate activation prerequisites. No personal connection,
provider write, canonical page or production deployment is activated by these tests.
