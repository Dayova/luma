# Canonical Decision Records

LUM-36 owns explicit Decision recording behind Meeting Intelligence's existing
`observe`, `query` and `conclude` facade. A typed Conversation subject is an actual
Conversation, never a fabricated Meeting. Existing Meeting callers retain their
interfaces. The configured Decision module privately shares its canonical approved
intents with Follow-up Execution; Discord does not orchestrate source capture,
interpretation, canonical search, authority resolution or provider write stages.

## Evidence, authority and permission

An authenticated founder's explicit recording instruction authorizes documentation.
It does not make that requester the decision-maker. The interpretation must cite
current original evidence and the accountable owner's Human acceptance. Poll votes,
provider summaries, provisional job titles, preferences and unresolved proposals
cannot establish that authority. Project ownership and evidenced delegation outrank
generic confirmed scope; conflicting ownership or missing required stakeholder
evidence produces a visible clarification. Strong objections require Human resolution
before adoption. Pause/discard remain dispositions, separate from record lifecycle.

The core retains exact source revisions, original recipient sets, authority revisions,
request observations, corrections and immutable request/intent history. It never
deletes these by age. Source capture, current audience/actor admission, ownership
source and complete canonical catalog are checked before interpretation or approval.
Every query and execution replay rechecks source and authority access. Returned known
references retain the observed versions; a fresh readable canonical page may have
advanced meanwhile, and is not represented as the original receipt's current version.

Conversation capture uses the exact bounded original instruction and current verified
author identities. Only dynamic native poll results/expiry are excluded from its
authorization hash. Original raw source hashes remain unchanged. Actual Meeting
capture uses active canonical Evidence, original speech and deterministic Human
speaker attribution, with the existing imported/context receipt guards. A configured
`MeetingDecisionSourceAudience` must prove both original and current recipients and
return a stable grant identity. Attendance alone does not admit readers. Without that
grant capability, actual Meeting recording fails closed.

Imported Meetings can instead supply the owned `meetingEvidenceSource` adapter.
It reconstructs bounded original Evidence from the accepted import, immutable source
ledger and original source-analysis receipts. Only recipients admitted by every source
receipt may receive it, and every read rechecks the current exact provider source and
sharing grant. It does not include generated Meeting analysis or borrowed context.
Imported transcript sections retain original wording with unknown authors; names,
attendees and provider summaries do not establish that an owner accepted a decision.
Without separate grounded Human acceptance, recording returns clarification.

The imported source adapter's `authorizeRetained` is only for historical reads. It
reconstructs the exact original source/audience and checks live source permissions.
Changed wording may remain eligible history while the same original sections and
blocks remain present. Removal, exclusion, reparenting to another page, erased text,
missing immutable proof or revoked grants withhold that history. This does not change
the exact current-source proof required for execution or infer any legacy reader grant.

## Reconciliation and durable execution

The interpreter proposes create, link, amend, supersede, reverse, reject or clarify.
The core validates bounded schemas, evidence membership, selected existing targets,
current authority and lifecycle. A link must match the actual decision statement.
An amendment cannot silently change the statement; replacement preserves history.
Related work/implementation references must already occur in verified evidence or
canonical records. Recording never creates work, spends money, or turns a poll into a
binding Decision.

Approved intents are loaded by canonical request/intent ID. Provider writes never use
caller-supplied plans. A durable catalog fence serializes writes across the configured
provider and remains held after an uncertain or partial write. Each stage is persisted
before sending, with an exact operation ID and positive receipt before any next stage.
Supersession/reversal first creates a **pending** successor, then retires and links the
predecessor, then activates the successor. A partial saga is never advertised as a new
active decision. Known references remain visible through source-guarded status reads,
including when a crash interrupted the outer execution receipt.

Duplicate commands do not rerun paid interpretation; conflicting reuse of an
observation ID is rejected. Interrupted interpretation requires a fresh explicit
instruction. An uncertain provider write is never resent, even if a read finds nothing.
Explicit recovery accepts only an exact positive receipt for the uncertain stage. It
may continue never-attempted stages, or retry a stage whose provider proved it refused
before sending. A current target mismatch instead requires a fresh review. Human
candidate corrections revoke previous unexecuted intents; after execution begins an
explicit canonical update/replacement is required.

## Composition and validation

Configure `createMeetingIntelligence({ decisionIntelligence: ... })` with the owned
source, responsibility, bounded interpreter, DecisionRecords capability, access policy
and explicit audience. Pass that same Meeting Intelligence instance into ordinary
`createFollowUpExecution`. The scoped factory overloads preserve legacy Meeting use.
The real Notion/model/authority adapters and Discord command composition are separate
implementation slices, not implied by these ports or their programmable tests.

The focused PGlite tests cover both real Meeting and Conversation subjects, owner vs
requester authority, incomplete catalogs, proposal/poll refusal, Human corrections,
link/no-op, audience/source/authority revocation, duplicate/restart behavior, uncertain
positive-only recovery and partial pending/retire/activate settlement. They do not
claim a live Notion mutation, Discord command, configured responsibility source, or
production deployment has been verified.
