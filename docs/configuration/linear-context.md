# Linear organizational context

`createLinearContextCatalog` adapts the issued `LinearReadOnlyWorkCatalog` to
governed Organizational Context. It cannot accept a writer catalog, a structural
copy carrying its public brand, or a writer narrowed to read methods. The runtime
must provide an explicit sharing authorization callback for the actual audience,
credential scope, team, and each returned issue. Token readability alone is not a
grant to the four founders or any other recipient.

`createLinearContextCatalogFromEnv` requires all three dedicated settings:

| Setting                                   | Meaning                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `LUMA_CONTEXT_LINEAR_READONLY_API_KEY`    | Dedicated Linear API key constrained to read permission.                                                                              |
| `LUMA_CONTEXT_LINEAR_TEAM_ID`             | Exact Linear team available to this context catalog.                                                                                  |
| `LUMA_CONTEXT_LINEAR_CREDENTIAL_SCOPE_ID` | Stable operator-assigned identity for that credential's sharing scope. Change it when replacing the credential or changing its scope. |

There is no fallback to `LINEAR_API_KEY`, `LINEAR_READONLY_API_KEY`, or
`LINEAR_TEAM_ID`. Constructing this adapter does not itself enable a runtime
surface; its host must compose it with governed retrieval and enforce receipt
validation before saving, delivering, or replaying derived output.

Search checks the workspace and team grant before and after provider I/O, checks
each issue grant, and rechecks accumulated issue IDs before disclosure. It makes
at most one bounded search per distinct concept (up to twenty concepts), returns
at most ten IDs, and always reports incomplete discovery: the existing read-only
reader does not expose pagination or prove exhaustive results, and archived work
may be absent. A provider error discards accumulated IDs and produces a generic
availability warning without provider diagnostics.

A retained source ID binds the issue UUID and identifier. Every read, including
after restart, repeats a bounded identifier search to admit the exact UUID to the
underlying reader, then fetches the issue afresh and verifies both identities.
Audience grants are checked around those reads. Missing search results, revoked
grants, moves to another team, identity changes, and failures make the source
ineligible; retained text is not a fallback. Source changes alter its version and
invalidate previously derived receipts through Organizational Context.

The content preserves the title, original description, normalized work state,
due date, and labels from the latest tracker record. The reader exposes normalized
state rather than Linear's custom workflow-state name. Its source authority is
`source` and its standing is `current`, meaning current tracker data. A title,
assignee, status, or label never becomes a Human-confirmed Decision, accepted
Ownership Attribution, or supersession instruction. Assignee contact details are
not included in retrieved text. Prior observed records remain retained under the
governed history and current-authorization rules.
