# Logical Meeting Decision evidence

Automatic Decision consideration now has an actual governed capture source, including
Granola Basic enhanced notes. `createLogicalMeetingDecisionEvidenceSource` reads the
accepted Logical Meeting capture set and its immutable source grants. It never
constructs a raw Meeting, imports a generated summary as speech, or calls MI query
recursively. Generated Granola material remains `provider-derived`; original transcript
material remains `human` with an unknown author unless the original source proves one.
Attendees and the note creator do not identify an utterance's speaker.

The source admits at most eight positive capture bindings and 100 evidence entries,
with 32,000 characters per material and a 64,000-character combined budget. Oversized
material is withheld, never silently truncated. The full provider archive remains
retained. A current source requires an accepted synthesis revision, exact descriptors
and bytes, original and current audiences, unchanged authorization scopes, exact
binding membership, and the current Human judgment head. Empty, ambiguous, removed,
unadmitted, or unprocessed captures are refused. Source receipts retain the original
recipient set and hashes independently of Decision requests; missing legacy receipts
cannot be guessed.

Human capture reviews are separate original typed observations with their real author,
exact affected derived claim, original source citations and current same-material
citations. Their purpose is `capture-synthesis-review`. Neither confirmation nor
attribution supplies business-decision acceptance or stakeholder consultation. A
rejected/corrected claim conservatively blocks later automatic candidates using that
material unless they explicitly cite the exact current correction. Such candidates
remain visible as needing clarification; original material, feedback, and inference
are retained. Separate exact owner acceptance through the Decision workflow remains
available when the candidate itself satisfies the current source and authority proof.
That later exact business acceptance can override automatic clarification, with both
Human judgments retained; its candidate hash cannot authorize changed content.

Retained historical reads use a distinct read-only capability: original receipts and
recipients remain mandatory, while changed wording may be historical if the capture
still has the same positive binding and current original authorization scope. Deleted,
excluded, rebound, reconsented, or inaccessible material cannot be disclosed through
history. A current execution still requires exact current wording and judgment state.

## Runtime connection

Construct the adapter with the shared database and `captureRuntime.configuration`.
Dispatch logical subjects to this source explicitly; revision values begin with the
exported `LOGICAL_CAPTURE_DECISION_REVISION_PREFIX` for retained-source dispatch.
Use the adapter for both the explicit and processed-source owned ports.
`source.resolveMeeting({workspaceId, meetingId, audience})` resolves either an actual
Logical Meeting or a bound imported Meeting to one current positively bound Logical
Meeting, without querying MI recursively or mutating capture membership. It verifies
all imported source heads, refuses ambiguous connections, and proves the accepted
original/current material and review scope before returning the ID. When capture
processing is enabled, subscribe the logical event once and suppress duplicate legacy
imported-MI processing for the same source. Native candidate views should resolve their
bound imported Meeting through this seam so they read that same automatic batch.

Before capture intake starts, call `captureRuntime.connectProcessedSource(handler)`
with the durable automatic queue's Logical Meeting handler. MI calls this notification
after accepted or replayed source/Human review observations and fresh source proof,
including an accepted observation whose later preparation was deferred. The event
contains workspace, actual Logical Meeting ID, observation ID, revision, and content
hash only. The queue must own durable coalescing and retry behavior; the callback
awaits enqueue, never runs detached. Queue failures preserve source acceptance and
report retryable context unavailability. Replay retries notification without paid
synthesis or Decision detection. No automatic recording authority is implied by intake.
