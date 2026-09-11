# Organizational context inside Meeting Intelligence

Meeting Intelligence owns retrieval before analysis. Its public interface stays
`observe`, `query`, and `conclude`. Production composition supplies an
`OrganizationalContext` and a `contextAudience` resolver for the workspace's actual
shared recipients. Attendance is not a sharing grant. Providing only one of these
dependencies is a configuration error.

Analysis receives bounded canonical prior state, original Meeting Evidence and
separately labeled external sources. Source citations include version, standing,
authority and retrieval coverage. External content is reference material, not an
instruction or new Meeting agreement. The deterministic reconciliation boundary
requires every proposal to cite the Meeting's own supplied Evidence as well as
any external references the model uses. Source-only proposals are rejected.

Before model dispatch and before persisting its result, Meeting Intelligence
revalidates the retrieval receipts and their exact configured audience. A changed
or inaccessible source discards the derived result without repeating the paid
request. The original accepted Observation remains durable. A later new
Observation can use fresh context and update an AI-derived item with the same
stable identity; Human-protected representations remain authoritative.

All newly derived items retain every supplied organizational receipt dependency,
including dependencies inherited from prior AI-derived state. A model cannot
remove this protection by omitting a context citation. Receipt-to-request
bindings are durable in `meeting_context_receipts`. Organizational snapshots,
Meeting Observations and revision history remain retained.

## Current views and execution

Snapshot, question, catch-up, participant brief and conclusion views verify their
dependencies and withhold the affected items when verification fails. Unrelated
Meeting evidence and independent Human items remain usable. `contextAvailability`
reports partial/unavailable coverage and the withheld count; grounded question
and conclusion text also carries an omission notice. Conclusion reuse is keyed
by the eligible projection so changing access cannot replay an older, broader
conclusion at the same canonical Meeting revision.

Query and conclusion results receive a final receipt check after asynchronous
reads and rendering. A failed check rebuilds the view once; continued source
churn returns only independent Meeting/Human items with an availability notice.
The executor follows related-item dependencies transitively, so an intent cannot
escape a revoked decision dependency through an intermediate Action Item.

Human confirmation or a partial correction retains the original dependency. It
cannot turn inaccessible source text into freely reusable Evidence. A complete
Human replacement of an item's statement becomes independently usable with its
own Human Evidence. In that case inherited external excerpts, rationale,
relationships, inferred owner and inferred deadline are not carried into the new
representation; explicitly corrected owner/date/status values remain. The prior
representation survives in revision history.

`createMeetingContextGuard` supplies the executor's separate
`requireIntentCurrent` boundary. It checks the canonical intent and related
items; recording a Meeting checks the aggregate items and follow-up intentions
included in the record. An approved intent whose dependencies are no longer
eligible cannot be reused to mutate providers. Reanalysis does not silently
rewrite an already approved or completed intent's payload or approval.

## Bounds and limitations

Prior state is limited to 40 items and 16,000 combined characters of item context
and cited Evidence. It carries at most eight inherited receipts, preventing
unbounded dependency chains from making later questions permanently unusable.
Omitted prior items are reflected in coverage. Organizational retrieval selects
up to eight sources and 12,000 characters using bounded literal concepts from
new Evidence and the Meeting title. Receipt validation is bounded to 20 distinct
receipts and a 15-second overall deadline; unverified dependencies fail closed.

Legacy constructors without organizational retrieval continue to analyze and
answer from the Meeting's own evidence and useful prior state. They explicitly
report that global retrieval is not configured. A temporary retrieval failure
uses no cached external fallback and can still analyze independent local
evidence. Partial source discovery is represented as partial context, not proof
that no other organizational knowledge exists. Successful bounded retrieval
does not emit a retryable `context-unavailable` error or make an accepted source
import appear rejected. Retrieval exceptions, withheld dependencies, and changed
receipt proofs keep their existing unavailable/deferred behavior.

Currentness is verified at each owned boundary, not through a distributed
transaction covering a provider, model, local database and Discord. Sources can
change after a completed check. Delivery and execution composition must keep its
own final checks; this integration does not claim an atomic cross-provider
snapshot or eliminate that interval.
