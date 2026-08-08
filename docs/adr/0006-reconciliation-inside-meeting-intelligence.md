# Reconciliation Inside Meeting Intelligence

Accepted. Imported source candidates enter Luma as provider-neutral Observations
and reconciliation against canonical work is owned by the durable Meeting
Intelligence Implementation. Review surfaces obtain durable outcomes through
`query`; they do not orchestrate extraction, Linear search, ranking, or
proposal persistence. A read-only Work Catalog seam keeps this slice unable to
mutate Linear, while later approved Follow-up Intents retain ownership of
external writes. This preserves evidence, idempotency, and Human Judgment
rules in one deep Module rather than duplicating them in Notion, Discord, and
future surfaces.

Implementation follows ADR 0005: source acceptance is short and atomic, while
Work Catalog search and retrieval happen after that transaction. A second short
transaction records the immutable review proposal and hydrated work Evidence
only if the candidate is still current. A catalog failure is a durable,
retryable `needs-clarification` proposal, never a fallback mutation. Automatic
retries use a persisted exponential backoff from one minute up to one hour; an
explicit Human refresh bypasses that delay. A later duplicate source Observation
can append a new attempt after the catalog recovers. Current review queries derive cross-candidate conflicts from the
immutable proposal history instead of rewriting past outcomes, so a source
supersession automatically restores a surviving proposal.

Human Judgment resolves a current proposal through the same public `observe`
interface. It is durable Evidence and may produce a local, **suggested**
Follow-up Intent for a create or update; only the separate approval and
Follow-up Execution flow can mutate a provider.
