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
