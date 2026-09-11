# Explicit source knowledge status

Notion and Linear context can now preserve an explicit source lifecycle state:
`current`, `proposed`, `disputed`, `superseded`, or `historical`. Ordinary retrieval
excludes superseded and historical sources, ranks current sources ahead of newer
proposals, and keeps proposal/dispute labels on any selected excerpts. Eligible
history requests retain access to earlier material. Nothing is deleted because
of its age.

For Notion, the exact optional property **Luma knowledge state** must be a native
select or status property with one of those five names (case-insensitive). An
existing property with an empty, unsupported or malformed value withholds the
page instead of assuming it is current. The adapter reads this metadata before
and after the complete Markdown read, and binds it into the source revision.

For Linear, use one exact label `luma:knowledge:current`,
`luma:knowledge:proposed`, `luma:knowledge:disputed`,
`luma:knowledge:superseded`, or `luma:knowledge:historical`. Multiple distinct
labels in this namespace or an unknown value withhold that source. Ordinary
workflow states such as Done and ordinary labels such as proposed are not
knowledge-state declarations.

Sources without this explicit metadata remain current **source records**. That
means the current readable provider record, not a Human-confirmed decision or
an endorsement of every statement in its body. Status, recency, document title,
assignee and completion never grant Human authority, create supersession links,
or replace an explicit decision-authority proof. A document containing mixed
old and current claims still needs an approved canonical correction or a
separately evidenced decision overlay; page-level status does not resolve that
ambiguity automatically.

These are optional conventions that require deliberate source metadata. This
implementation does not add properties or labels to live sources or change any
existing source status. It introduces no provider writes or new permissions.
Every read and historical replay still checks current source eligibility for
all recipients. A metadata-only change invalidates retained context receipts,
including when the provider edit timestamp is unchanged. Revocation prevents
retained historical material from being replayed.

The representation uses native [Notion page property values](https://developers.notion.com/reference/page-property-values)
and [Linear issue labels](https://linear.app/docs/labels). The names and mapping
above are Luma's owned conventions, not built-in provider authority guarantees.
