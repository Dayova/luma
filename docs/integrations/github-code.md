# GitHub code context

`createGitHubCodeProvider` implements the read-only `CodeProvider` port for pull
requests, immutable commits, recent repository events, and bounded code search.
It is separate from the GitHub Issues compatibility writer and does not create
issues, comments, reviews, or other external mutations. The audience-authorized
`createGitHubContextCatalog` adapts it to organizational retrieval; application
composition must supply the actual workspace audience grant before using it in
a shared answer.

## Credential and repository boundary

Use a separately provisioned fine-grained token restricted to the selected
repositories with **Metadata: read**, **Contents: read**, and **Pull requests:
read**. Set these variables for `createGitHubCodeProviderFromEnv`:

```dotenv
LUMA_GITHUB_CODE_READONLY_TOKEN=<secret supplied by deployment>
LUMA_GITHUB_CODE_CREDENTIAL_SCOPE_ID=dayova-code-reader
LUMA_GITHUB_CODE_REPOSITORIES=Dayova/luma,Dayova/dayova-mvp
```

The credential scope ID is a stable deployment binding, not a token value or a
permission claim. The adapter never falls back to `GITHUB_TOKEN`, GitHub Issues
credentials, or all repositories visible to a credential. Every operation checks
the explicit repository allowlist and issues only GET requests. Provisioning a
read-only credential remains necessary; observing API readability cannot prove
that a token lacks write permissions.

`readScope` states which credential binding and repositories were configured. It
does **not** assert that every founder can read them or authorize sharing their
contents. The organizational context composition must independently authorize
the actual response audience and recheck that grant before delivery or replay.

Optional variables are `LUMA_GITHUB_CODE_PROVIDER_ID` (default `github-code`),
`LUMA_GITHUB_CODE_API_BASE_URL` and `LUMA_GITHUB_CODE_WEB_BASE_URL` for explicitly
trusted GitHub Enterprise origins. Both origins require HTTPS; credentials,
query strings and fragments in configured URLs are rejected. Redirects and
provider-supplied pagination links outside the exact requested resource are
rejected. Access tokens and raw provider error bodies are never included in
adapter errors.

## Evidence and coverage

The catalog requires an `authorize` callback receiving the workspace, every
actual recipient, provider ID, credential scope ID and repository. It checks
this live grant before and after discovery and each evidence read. Its catalog
ID includes the credential scope ID so retained snapshots cannot silently cross
credential bindings. Do not reuse a credential scope ID for a different trust
boundary. A denied or revoked grant returns no evidence.

Discovery makes at most six repository/phrase searches by default (configurable
from one to twenty), with explicit partial coverage. Source IDs encode the
repository, immutable commit, blob, path and line range. `read` calls
`getCurrentCodeExcerpt` to fetch those exact bytes again and recheck the current
default head; it does not reuse search snippets or cached file contents. Deleted,
unreadable or changed sources are ineligible. Receipt checks therefore fail
closed after a head change, even when that change touched another file. Historical
snapshots remain in organizational storage; the catalog does not delete them.

Context Ask and Meeting Intelligence derive up to eight distinct literal terms
from at most 8,000 input characters before discovery, removing common English
and German question words while preserving names such as `monthlyLimitUsd`,
`Dayova/luma`, and `LUM-4`. The original question and Meeting Evidence remain
unchanged. This is bounded keyword discovery, without semantic expansion or
translation; the catalog's request limits can omit later terms. A question with
no useful terms skips external searches, returns explicit partial coverage, and
can still use its current conversation evidence. Persisted answers bind the
derived terms as well as the original question, audience, sources and receipt.

This catalog currently discovers code excerpts. PR, commit and event methods
are available through the CodeProvider capability but are not silently included
in catalog searches or claimed as complete implementation-status knowledge.

- `getPullRequest` reads metadata twice around bounded files, commits and reviews
  and rejects a changed source. It reports head/base SHAs, `updatedAt`, and
  `observedAt`. Requested review teams and unverified linked work relationships
  are explicit coverage gaps. The API returns at most 250 PR commits and 3,000
  changed files; configured page limits can be lower.
- `getCommit` accepts a full immutable commit SHA only. An unlinked Git author
  remains `null`; author names or emails are not turned into account identities.
- `searchCode` accepts a literal phrase within one allowlisted repository, not
  arbitrary GitHub search qualifiers. It resolves the qualified default branch,
  reads matching file bytes at that commit, verifies the Git blob hash, and
  returns an immutable commit/path/line citation. Search-result SHAs are blob
  identities, not commit identities. Search snippets never become evidence.
  The default branch and head are rechecked before returning results. Changed
  heads, branch switches or invalid bytes fail closed; stale index entries,
  unreadable files, binary files and file limits produce explicit omissions.
- `getRecentActivity` reports witnessed push tips, opened/merged pull requests,
  and published releases with provider event timestamps. A push tip is not every
  commit in the push. The Events API exposes at most 300 events from the past
  30 days and can lag 30 seconds to six hours. This is not a full activity log.

Coverage envelopes are deliberately conservative. Code search is a bounded
default-branch index with no freshness guarantee; an empty result is not proof
that relevant code does not exist. A source changing after a completed read is
still possible; there is no atomic snapshot spanning GitHub and Discord.

Default bounds are three pages, 40 requests per operation, 20 requested code
matches, 128,000 bytes per file, 2,000,000 bytes per HTTP response, 10 seconds per
request and 30 seconds for the whole operation. Limits are configurable through
the constructor within hard bounds. Rate limits are surfaced with available
retry timing; the adapter does not retry, sleep through rate limits, or claim a
failed read is complete. Failure to establish final currentness rejects the
operation even if some earlier subreads succeeded.

## Validation and API references

Deterministic HTTP tests exercise public methods, including allowlist rejection,
foreign links and redirects, pagination bounds, stale default branches, forged
blob bytes, partial coverage, cancellation and rate-limit errors:

```sh
pnpm exec vitest run tests/code/github-code-provider.test.ts
pnpm exec vitest run tests/organizational-context/github-catalog.test.ts
pnpm exec vitest run tests/context-intelligence/github-retrieval.test.ts
```

The adapter uses REST API version `2026-03-10`. Protocol behavior was checked
against GitHub's official documentation:

- [Search code](https://docs.github.com/en/rest/search/search#search-code)
- [Get a commit](https://docs.github.com/en/rest/commits/commits#get-a-commit)
- [Get repository content](https://docs.github.com/en/rest/repos/contents#get-repository-content)
- [List PR files](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files)
- [List PR commits](https://docs.github.com/en/rest/pulls/pulls#list-commits-on-a-pull-request)
- [List repository events](https://docs.github.com/en/rest/activity/events#list-repository-events)
- [GitHub event types](https://docs.github.com/en/rest/using-the-rest-api/github-event-types)
