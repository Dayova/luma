# Governed organizational context

Accepted for implementation under LUM-4. Retrieval is a provider-neutral owned
module with `retrieve` and `requireCurrent`. Meeting Intelligence and Context
Intelligence own their use of it; surfaces never orchestrate extraction stages.

The request names its actual recipient audience and a Meeting or conversation
subject. Read-only catalogs must enforce an explicit workspace/source sharing
grant and fresh readability for all recipients. A service token, an empty ACL,
a successful search, or a provider's hardcoded `shared` flag is not proof of a
human audience grant. Provider adapters must state the limits of their access
proof. Configuration changes and source revocation invalidate receipt replay.

Every successfully read source version is retained in the full Luma store. There
is no age-based deletion. Current retrieval excludes historical/superseded
versions, preserves old still-valid decisions, ranks Human-confirmed statements
ahead of unaccepted proposals, discloses conflicts, and treats mirrors as duplicate
citations rather than independent corroboration. Explicit historical queries can
retrieve prior observed versions after fresh source eligibility checks.

Returned excerpts and source scans are bounded and omissions are disclosed. Each
bundle has a durable receipt binding the workspace, recipient set, question scope,
discovery result, and exact source snapshots. Consumers must revalidate the
receipt before saving, delivering, or replaying derived output. A changed source,
new discovery result, removed catalog, or failed eligibility/read check invalidates
it. A provider outage never authorizes fallback to cached confidential content.

This module does not authorize external writes. Approved Follow-up Intents,
current source proofs, Human Judgment, and execution receipts remain mandatory
for canonical mutations. Wiring a caller must include derived-output receipt
persistence and replay checks; adding text to a prompt alone is insufficient.

## Imported Meeting leaf recall

The accepted-import recall catalog is owned by Meeting Intelligence persistence,
with no recursive calls to Meeting Intelligence or Organizational Context. It
requires original source-analysis audience grants, active Evidence and current
source admission for every item, and excludes the current subject. Stable source
identity includes the original grant identities so retained raw revisions cannot
inherit a later capture's permission. Independent Human text needs its own audience grant. External Organizational
Context dependencies use a restricted receipt verifier that checks original
recipient admission, exact source versions and current external discovery. It
cannot invoke a prior-Meeting catalog; multi-hop Meeting dependencies remain
withheld. See [bounded imported Meeting recall](../imported-meeting-recall.md)
for the coverage and evaluation limits.
