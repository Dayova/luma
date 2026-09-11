# Founder review in Discord

Luma's Discord review surface uses the existing Meeting Intelligence `query`
and `observe` interactions. It records Human Judgment against immutable source
claims and review IDs. It does not run its own extraction, search Linear, or
create a second Meeting or task database.

For an already ingested Notion Meeting Note, use an existing thread under an
approved founder-only parent:

1. `/meeting bind source_page:<Notion page URL or UUID>` attaches that thread to
   the original imported Meeting. The page must resolve to one accepted Meeting
   Note root. Ambiguous pages, missing ingestion, unavailable source access, and
   an existing different binding are refused. A binding does not grant source
   access or associate two captures.
   The thread is a post-meeting review session: binding keeps it ended and does
   not start a live Meeting. `/meeting note` and `/meeting stop` therefore do not
   apply; use Ask and the review commands for the retained capture.
2. `/meeting review` shows original wording and modality, exact source revision,
   ownership and claim ID, canonical search coverage and targets, proposal,
   Human resolution, and Follow-up status. Long material remains available on
   numbered pages; `review_id` narrows the view to one exact review.
3. `/meeting owner claim_id:<claim> choice:<choice>` records a confirmed founder,
   intentionally unassigned ownership, or unresolved ownership. Confirming an
   owner requires selecting a Discord user uniquely mapped to an admitted
   founder. The source speaker or a name in a sentence is not an assignment.
   A new ownership resolution can produce a new immutable review ID; inspect it
   before deciding the work outcome.
4. `/meeting reconcile review_id:<review> choice:<choice>` resolves that proposal.
   Link/update choices accept only target IDs hydrated in the displayed review;
   new work requires a completed zero-result canonical search and sufficient
   source semantics, deadline, and ownership. Missing facts stay unresolved.
   `execute:true` explicitly authorizes the described canonical work operation
   and its compact Operational Outcome on the original Meeting Note, then uses
   the existing approval/execution flow in the same command. With `execute`
   omitted or false the decision is saved for `/meeting approve` later.
5. `/meeting refresh review_id:<review>` requests a new canonical-work read for
   a retryable catalog failure or a Human-resolved settlement that failed or
   requires manual recovery. It cannot silently replace an unresolved proposal
   or a successful settlement. Follow the returned clarification if refresh is
   not eligible. Edited source content enters through normal source ingestion.
6. `/meeting recover intent_id:<intent>` resumes a partial or stranded execution
   using its durable receipts. A completed Linear stage is not repeated merely
   because writing the original Note failed. An indeterminate provider mutation
   still needs positive recovery evidence.

Every command requires the existing unique authenticated founder admission and
fresh Discord audience proof. Imported Meeting binding, queries, Human decisions,
execution dispatch, source-derived publications, and the actual final slash-command
reply also require the configured imported-source access capability. Without it,
retained imported data is not exposed through a newly attached thread. The runtime
composes that capability only when canonical Meeting Notes ingestion and the
dedicated exact-page read-only source access are both configured, using the same
source ledger and explicit all-founder sharing policy as Meeting analysis. Bot token access,
a stored binding, and an old response do not grant access. Existing source and
execution guards remain responsible for each external provider stage.

No live Discord commands or bindings are created by running the tests. Native
Notion review parity and real-source Activity proof remain part of LUM-5;
canonical document patching and durable `knowledgeReferences` remain LUM-11 and
therefore keep the full LUM-6 acceptance open. This surface exposes the existing
source-bound settlement foundation; it does not claim those missing capabilities.

## Logical capture and synthesis review

With `createDiscordCaptureReviewRuntime` composed into the bot's `captureReview`
input, founders can also reach Logical Meetings with no Notion Meeting Note,
including Granola Basic captures:

- `/meeting captures` lists five retained Logical Meetings per page, withholding
  any row whose current source or original sharing with all four founders cannot
  be verified. Use it in an approved parent channel to list across meetings.
  `meeting_id:<ID>` shows exact capture IDs, source revisions, binding status,
  provider capabilities and the canonical reference. `page` exposes longer views.
- `/meeting synthesis meeting_id:<ID>` displays the current derived revision,
  full claim wording, source citations, Human authority, unresolved contradictions,
  coverage and publication status. Long claims and quotations span numbered pages.
  Provider-derived notes never become verbatim transcript evidence.
- `/meeting judge revision:<N> claim_id:<ID> choice:confirm|correct|reject`
  records an authenticated founder's Human Judgment. `correct` also needs `text`.
  The exact displayed synthesis revision is required; an older revision cannot
  approve or overwrite a newer judgment.
- `/meeting publish revision:<N>` explicitly approves and executes the current
  synthesis publication Intent through Meeting Intelligence and Follow-up
  Execution. The command accepts neither an arbitrary body nor a publication
  target. `recover:true` checks an uncertain write using retained positive evidence
  and never resends it. Successful publication exposes the same canonical anchor
  through Logical Meetings after restart.
- `/meeting capture-link capture_id:<ID> meeting_id:<ID> revision:<source revision>
choice:bind|separate` records an explicit Human binding. `bind` joins the target
  Logical Meeting; `separate` excludes the capture from the named Logical Meeting
  and lets the owned binding module create a separate identity when necessary.
  Both groups must have current source access for all founders. The exact source
  revision, content hash and prior binding are checked again under the shared
  workspace lock; a queued command cannot overwrite a newer capture or Human
  binding. Original capture
  revisions remain immutable. Source ingestion wakes Meeting Intelligence after
  an accepted binding; a budget/source failure leaves the Human binding retained
  and synthesis pending or unavailable, without discarding prior judgments.

The optional `meeting_id` defaults to this thread's existing imported Meeting
binding. Resolution uses the actual imported source identities and persisted
capture membership; it neither invents a Logical Meeting ID nor joins captures.
An ambiguous mapping requires choosing a Logical Meeting from the shared list.
The original `/meeting review`, ownership and reconciliation paths retain their
original imported Meeting binding.

The private review factory receives the owned database, workspace, Logical
Meetings, live capture access, final Meeting Intelligence and Follow-up Execution
facades, and the four founder Person IDs. The existing bot admission and live
Discord audience checks wrap every operation. Exact source projection, original
account scope and current audience checks run again immediately before the native
reply. Source capabilities and all paginated content remain withheld after a grant
or source change. This composition does not activate a personal Granola connection,
change source policy, or publish anything merely by listing or reviewing it.
