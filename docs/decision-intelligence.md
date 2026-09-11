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

### Literal Human review of an imported decision

The owned Decision facade retains an authenticated Meeting recording instruction as
separate Human Evidence. It never attributes imported transcript sections to that
requester. The interpreter may use a literal first-person decision from the owner
immediately; a generic request to record a discussion cannot supply missing owner
acceptance, including when a model incorrectly cites that instruction.

A later `decision-candidate-accepted` Observation binds the exact `reviewToken`
returned by `query` and retains the literal confirmation. It does not call the
model again. The canonical proof preserves the original audience, actor identity,
source hashes, observation and exact accepted candidate content separately under
`authority.humanReviews`. A later correction cannot reuse acceptance of different
content. Source, audience, identity and ownership checks still gate every read and
execution stage; the original imported source remains byte-for-byte unchanged.

`createDecisionHumanReviewAccess` supplies an independent retained review grant for
canonical record readers. An ownership-page grant does not grant access to a Human
review. Provider composition must require that additional proof for every retained
review; archives without Human reviews remain compatible. The native bound-Meeting recording, paginated candidate review and exact-token
acceptance commands are documented in
[integrations/discord-decision-records.md](integrations/discord-decision-records.md).

## Automatic candidates from processed evidence

LUM-38 adds a factual `decision-source-processed` Observation for an actual Meeting or
bounded Conversation. MI captures the accepted original material through
`ProcessedDecisionEvidenceSource`; there is no fabricated Human requester or Meeting.
Imported and directly captured Meeting adapters expose `captureProcessed` with the
same original/current audience and evidence proofs as explicit recording. The Conversation adapter reads `createProcessedConversationSources` admissions and
recaptures through the governed Ask source; it does not require a recording command.
Context Intelligence persists the exact original audience and complete ledger revision
before AI work. Only these immutable admissions are eligible, never a legacy raw
snapshot with guessed recipients. Current author mappings must agree with originally
attributed authors; unknown original authors remain unknown. Reads and retained-history
checks never write the ledger, rerun Ask or include generated/retrieved answer text.

One durable batch binds the exact original source revision, content, admission and
recipients. The module retains up to 20 candidates, their modality, classification
confidence, source-backed authority assessment and proposed reconciliation. Read them
with `query({query:{type:'automatic-decision-candidates',batchId}, ...})` or conclude
with `batchId`. Individual request IDs use existing query, correction, acceptance and
Follow-up Execution. A later automatic inference cannot replace a retained Human
correction or acceptance in that scope. Separate Human acceptance keeps imported
speaker attribution and original speech unchanged.

Automatic processing defaults to review only. Missing responsibility or canonical
catalog context does not erase supported candidates; the result identifies incomplete
coverage and cannot approve recording. The production OpenAI detector shares the
explicit interpreter's native client, grounding checks and durable AI budget. It has
no tools, SDK retries or response storage. Confidence never supplies ownership,
Human acceptance or recording permission. Original tentative wording, provisional
titles, polls and unresolved objections cannot pass the automatic approval gates.
Failed/interrupted analysis remains visible, including shared budget refusal. Replaying
the same processed source does not repeat model work or uncertain provider writes;
changed Evidence cannot reuse the same Observation ID.

An optional `DecisionStandingPolicy` independently proves original authenticated
Human standing authorization. Each grant binds a source version, literal instruction,
original audience, accountable owner and scope, permitted actions/modalities/
dispositions, and validity window. The current actor mapping, actual ownership,
original source grant, current catalog and exact policy proof gate recording. They
are rechecked at execution stages and read/recovery boundaries. A missing, revoked,
ambiguous, expanded or expired grant leaves the candidate for explicit review.
Explicit Human instructions continue to use their existing authorization path.

Several candidates in the same scope stay fully visible for joint review; their
relationships are not silently settled automatically. Distinct scopes may settle in
sequence only when every intervening catalog change exactly matches this batch's
positive durable receipts. Any other change or uncertain stage stops further automatic
writes. Available successful/unknown receipts remain visible; candidates whose current
context cannot be proven retain visible request IDs and a clear review reason while
their stale text and references are withheld. No later scope triggers a new paid
interpretation implicitly.

The core and owned source/model adapters do not by themselves enable production
processing, authorize a standing policy or configure a source connection. Runtime
composition binds `createMeetingNotesIngestion({onProcessedSource})` and
`createContextIntelligence({onProcessedSource})` to durable background processing.
The callbacks emit accepted original source IDs/revisions and no approval. Imported
notification failure preserves accepted Evidence and reports a retryable partial
result; duplicate imports can deliver the same notification again. Context admissions
coalesce identical source revisions and audiences independently of inquiry IDs.
Feed a stable event ID into MI's `decision-source-processed` Observation; actual source
capture, policy validation, detection and execution remain owned by MI. Composition
must also supply current policy proofs; these callbacks never create a policy. Tests
exercise public MI and actual SDK serialization with deterministic provider responses;
they do not claim live provider access or a paid model evaluation.
