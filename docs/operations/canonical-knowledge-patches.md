# Canonical knowledge patches

LUM-11 supports an explicit founder instruction to update one existing canonical
Notion document from a current source-bound settlement. The selected document can
be a handbook, decision page, or another canonical page; it need not be the
original Meeting Note. Luma never searches for or guesses a write target.

In the founder-only thread bound to the imported Meeting:

1. Use `/meeting review` and resolve its source reconciliation with
   `/meeting reconcile` and `execute:false`. Confirm ownership first if the
   reviewed settlement also changes work. A knowledge-only outcome may explicitly
   reject creating work.
2. Use `/meeting patch` with the resulting `intent_id`, the existing canonical
   `page_id`, `expected` (the exact existing Markdown region), and `replacement`
   (the complete approved replacement of that region). This command **authorizes
   and executes both the selected settlement and its exact patch**; no second
   approval command is necessary. Each Discord region is bounded to 6,000
   characters. The owned Meeting Interface accepts up to 20,000 characters.
3. Luma records the completed canonical document reference in the original
   Meeting's Operational Outcome `knowledgeReferences`. Its normal Discord
   Execution Record reports success, a partial result, a conflict, or uncertainty.

Only an authorized founder in a currently allowed destination can submit this
command. The existing imported-source access and freshness checks apply before
approval, execution, and delivery. The patch is a durable Human Judgment and
becomes immutable when accepted. A later changed request cannot retarget it.
Execution callers supply only workspace, Meeting, and Intent identity; page IDs
and Markdown are loaded from the canonical approved proposal.

The production capability uses the existing `NOTION_API_TOKEN` and
`LUMA_NOTION_PROVIDER_ID`; the selected existing page must be shared with that
integration. Observation-only and read-only context credentials are not used for
writes. The server composes this capability with the existing Notion Operational
Outcome writer. No schedule performs a canonical patch automatically.

Before sending, Luma holds the same durable physical-page lease used by
Operational Outcome writes, reads page metadata/complete Markdown/metadata, and
requires a stable readable page plus exactly one occurrence of the expected
region. Truncated content, unknown blocks, page-ID aliases, an empty replacement,
a whole-page region, missing matches, and duplicate matches cannot be used to
send a patch. Edits outside the selected region before this read are preserved.
Luma commits the approved request, random operation token, before/after content
digests, request digest, and an executing stage before the provider boundary.

The adapter calls the real Notion Markdown API `update_content` operation with
one `content_updates` item, `replace_all_matches:false`, and
`allow_deleting_content:false`. It never uses `replace_content`, deletion,
fuzzy matching, retargeting, or automatic merging. Notion's deletion flag protects
child pages/databases; it is not a page-version compare-and-swap. The exact region
must still match when Notion applies the request. External writers can change the
page between checks; a page version read alone does not provide an atomic lock.

A successful or interrupted send is proven only by a complete reread whose full
Markdown digest equals the exact prepared result. A transport acknowledgement
alone is insufficient. No audit marker is appended to the approved prose. This
proves the approved resulting content, not exclusive authorship if an external
writer independently made the identical edit. Notion normalization or unrelated
edits after an uncertain send may therefore prevent automatic positive proof.

Use `/meeting recover intent_id:...` for an interrupted execution. A positive
reread records the canonical reference and permits only the unfinished Operational
Outcome stage to continue, after fresh source checks. An unchanged page is not
negative proof: unknown writes retain the target lease and require manual
recovery, without sending the patch again. Known conflicts release the target
lease and require a fresh source review and patch proposal. Completed work and
knowledge references survive later Outcome failures. History is retained.

The implementation has deterministic adapter and public-Interface tests. Live
proof still requires a founder-selected source and target page shared with the
production integration; no live page was changed as part of implementation.

Provider contracts:
[retrieve page Markdown](https://developers.notion.com/reference/retrieve-page-markdown)
and [update page Markdown](https://developers.notion.com/reference/update-page-markdown),
API version `2026-03-11`, pinned SDK `@notionhq/client` 5.23.1.
