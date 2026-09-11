# Bounded recall from imported Meetings

Luma can use accepted, source-bound Meeting understanding as Organizational
Context in another Meeting or a Context Ask. The leaf catalog reads the owned
Meeting store directly. It never calls `MI.query`, a context guard, another
prior-Meeting catalog, a model, or a provider writer. Public surfaces continue to use
`observe`, `query`, `conclude`, or Context Intelligence `inquire`.

The runtime composes `createImportedMeetingContextCatalog` with the main database
and the same `ImportedSourceAnalysisAccess` used for authorized transcript
analysis. Enabling the catalog is not a new source grant. The imported source
configuration and exact-page grants described in
[imported Meeting understanding](imported-meeting-understanding.md) still apply.

Every returned item requires immutable original source-analysis receipts for
that Meeting, an actual recipient set contained in every original audience,
active canonical Evidence, and a fresh proof of every original source revision
and current sharing policy. Source IDs bind the exact original receipt identities.
A newer raw capture therefore cannot authorize retained excerpts of its older
capture through the Organizational Context history path. Changed source content,
exclusion, loss of access, or a concurrent Human change invalidates delivery and
replay; retained history is not deleted.

The projection includes decisions, action items, questions, and risks. Original
speech remains unchanged in the supporting Evidence. Candidate choices stay
proposed; objections stay disputed; superseded/completed records are omitted from
ordinary current retrieval. A confirmed model proposal remains AI inference until
an explicit Human Judgment confirms it. Human status/confirmation overlays outrank
inference. A Human rejection removes the item from recall, including retained
history. An independently rewritten Human statement needs its own original
sharing admission and is withheld here. Speaker names never confirm an owner.
No Decision Record, approval, or completed external action is fabricated.

The current Meeting is excluded from both fresh discovery and retained reads.
Search scans at most 20 matching Meetings and 100 items per Meeting, then returns
at most 100 discoveries. The enclosing retrieval service applies its own smaller
source/excerpt budget and deadlines. Coverage is always explicitly partial;
there is no age cutoff. Source capture time and actual Human revision time are
used instead of read/replay time, so repeated reads do not make old claims newer.

Normal imported analysis can also cite Notion/Linear/GitHub context. The leaf
uses a restricted `ExternalContextReceiptVerifier` owned by Organizational Context
for those dependencies. Composition supplies only external provider catalogs and
the exported prior-Meeting catalog identity. The verifier checks the stored
original request and audience, current external catalog membership, exact source
versions, current grants, and the original external discovery state. Cited
external Evidence must exactly match the originally selected source bytes.

The verifier never calls a prior-Meeting catalog. A receipt containing prior-Meeting
source material, unavailable prior-Meeting reads, or nonempty/failed prior-Meeting
discovery is withheld. An explicitly empty prior-Meeting search can be skipped
because it contributed no borrowed text; external discovery and source proofs
are still revalidated, including receipts with no selected external sources.
New external discovery, changed versions, or lost grants invalidate recall.
Multi-hop Meeting dependencies need a separate bounded graph proof and remain
excluded. Direct Discord utterances without durable original audience grants,
legacy imported items without grants, and inactive or mismatched Evidence are
also withheld. Direct Discord historical capture admission and Granola ingestion
remain separate capabilities.

The version-five evaluation creates real immutable Notion-shaped captures,
accepts and analyzes them through Meeting Intelligence with external context,
records Human Judgment,
and asks a separate conversation using the real leaf and Context Intelligence.
It checks original source links, old valid ownership, exclusion of unrelated
Meetings, persisted replay, revocation at replay/final delivery, and unchanged
retained snapshots. Only source transport and model proposals are synthetic;
there are no network requests or paid calls. This measures the accepted-import
recall path, not live Notion transport or subjective model quality.
