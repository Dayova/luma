# Source-backed Decision authority

`createNotionDecisionAuthority` implements the owned DecisionAuthority port using an
issued read-only Notion KnowledgeCatalog. A raw integration token, narrowed writer,
page title, inferred job role or Meeting date is not authority evidence.

The runtime supplies the existing governed catalog, shared database, workspace,
explicit founder recipient IDs and an absolute `policyPath`. The policy is a regular
file, owned by root or the service user, mode `0600`, with no symlink/hardlink and a
64 KB bound. It is reread on every current authority check. Policy errors are reported
without file contents or provider payloads.

The JSON policy has `schemaVersion: 1`, `workspaceId`, the exact canonical Notion
`documentId`, the lower-case SHA-256 of its original UTF-8 Markdown as `contentHash`,
and `grants`. `decisionAuthorityContentHash(markdown)` computes that value without
normalizing source text. Each grant has:

- `id`, `personId` and `scopeId`, using explicit internal identities.
- `kind`: `project-ownership`, `delegation`, `confirmed-scope`, or `provisional-role`.
- `standing`: `current`, `provisional`, or `superseded`.
- `excerpt`: exact, uniquely occurring original source text supporting that mapping.
- `delegatedBy`: the explicit delegator's Person ID or `null`.
- `consultedPersonIds`: explicitly required affected stakeholders, or an empty array.

The mapping is a reviewed configuration interpretation of source evidence. It never
updates the Notion page or upgrades a provisional title based on elapsed time. For
the current Dayova guidance, Jakob's explicit Luma project ownership is distinct from
the broader provisional COO/CTO/finance/marketing role ideas. A newly held Meeting
does not itself finalize those ideas. When source wording or mapping changes, execution
requires a fresh matching authority snapshot; the operator reviews and updates the
mapping from actual Human evidence.

The adapter verifies the whole actual audience through the catalog, exact page
identity, content hash, and each literal excerpt. Source and policy are reread before
and after retaining the snapshot. A durable authority snapshot contains the exact
source reference/version, mapping-bound revision, content hash, grants and excerpts;
its original audience is retained separately in the full Luma store. A four-minute
operation bound includes queue waits in the shared per-credential Notion scheduler;
each native fetch has a four-second timeout. Retained authority checks also respect
the caller's earlier cancellation deadline. Once an in-flight catalog read settles
after that deadline, it cannot start another authority-stage read, persist a late
snapshot, or return a result. The scheduler uses Notion's conservative 180-request
sliding minute window, bounds active requests to four, and retries only safe reads
under documented overload responses. See the [Decision adapter capacity contract](notion-decision-records.md).

`requireCurrent` is the execution fence: it demands the same current source and
mapping snapshot. `authorizeRetainedAuthority` is exclusively for historical reads,
including canonical Notion Decision archives. It requires a matching original stored
snapshot, an original recipient grant, and a fresh governed read of the source page.
Old eligible wording remains readable; deletion, exclusion, revoked permission,
unrecognized/forged snapshots and expanded readers do not. Never use retained read
authorization to approve or execute a new decision.

Tests use the real governed Notion catalog with deterministic native read responses,
protected temporary files and PGlite. They cover source changes, provisional roles,
original audience restrictions, current/revoked historical access, corrupted mappings
and a permission change during retention. No source is activated, policy file installed,
Notion page mutated, or production ownership conclusion inferred by these tests.
