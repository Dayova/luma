# Granola Basic capture source

The Granola source reads the official MCP endpoint through a separate authorized
connection for each participating founder. It discovers bounded recent metadata,
applies an explicit organizational inclusion policy, archives eligible note
material as immutable Capture Revisions, and passes verified descriptors to the
existing LogicalMeetings module. It does not call a model or mutate a provider.

## Verified provider boundary

As checked on 11 September 2026, the [Granola MCP help
page](https://docs.granola.ai/help-center/sharing/integrations/mcp) documents
Streamable HTTP at `https://mcp.granola.ai/mcp`, per-user OAuth, and the
`get_account_info`, `list_meetings`, and `get_meetings` read tools. Basic has a
30-day recent-history window; transcripts and some other tools require paid
plans. Current documentation says personal access can include notes shared with
the user in their active workspace. Older owned-only descriptions must not be
used as a sharing guarantee. Luma does not request transcript, folder, natural
language query, API-key, or paid integration capabilities.

The help page does not publish stable argument/output schemas. The adapter checks
live `tools/list` for compatible `limit` and `meeting_ids` inputs. Its bounded
XML-like list/get decoder follows the format shown in the original
[Honcho Granola integration](https://honcho.dev/docs/v3/guides/granola), while
rejecting incomplete/duplicate wrappers and unrecognized shapes. Participant,
notes and summary sections must be distinct top-level fields; nested or
overlapping section markup cannot establish meeting eligibility. This is a
conservative compatibility implementation, not a claim of live account testing.
A changed schema or unsupported provider result produces an explicit failure;
it never becomes an empty successful scan or invented Evidence.

The HTTP client implements JSON and SSE responses, protocol negotiation, session
headers, read deadlines and byte limits using the
[MCP Streamable HTTP contract](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).
It accepts only the three named read tools. It follows no redirects, executes no
server-initiated requests and returns content-free errors. The same deadline
bounds stream cancellation, including failed responses and notifications; a
stalled cleanup cannot retain an admitted request indefinitely. A credential callback
supplies an already authorized OAuth token with its expiry. The token stays in
memory for one session; expiry or authorization failure requires a fresh session.
There is no credential discovery or fallback to local Granola/other-app sessions.

## Opt-in and eligibility

`createGranolaPolicy({path, workspaceId})` reads a protected absolute JSON file on
each check. The file must be a regular, single-link file owned by root or the
runtime user, with no group/other write permission and no symlink. Its format is:

```json
{
  "version": 1,
  "workspaceId": "workspace_dayova",
  "connections": []
}
```

Each connection entry requires `connectionId`, `ownerPersonId`, `optInId`, an
`accountFingerprint`, `enabled`, `audiencePersonIds`, `includedMeetingIds`, and
`excludedMeetingIds`. The fingerprint is produced by
`granolaAccountFingerprint` from the exact account-info response attested during
that user's connection setup. It binds both the connected account and its active
workspace without guessing fields in an undocumented response. Changing either
requires a newly attested connection policy. The original opt-in ID/fingerprint
and exact recipient set are retained alongside each admitted revision.

Only the four founders can be policy owners or recipients; the owner must be a
recipient. Nothing is imported automatically by default. Exact inclusion IDs
provide the explicit import fallback, including IDs outside the current discovery
page when the provider still permits reading them. Exclusions and disabled
connections take precedence. Known source IDs are revisited for exclusions even
when a recent scan omits them. Personal raw notes are never archived just to make
an organizational exclusion decision.

An owner may separately opt into `automaticInternalMeetings: true` with a
`participantDirectory` of `{email, personId}` entries. This rule accepts only
metadata whose reported participants all resolve through that declared founder
directory, include the owner, and contain at least two distinct founders. Unknown,
external, ambiguous or unparseable participants stay excluded. Eligibility is
rechecked against the fetched material. This is an explicit policy heuristic,
not proof that a personal conversation was company business. An owner can always
exclude a particular meeting. Names and text matching do not grant access.

`readCurrent` is the only content-returning archive interface. It requires the
actual recipients to be a subset of both the immutable original audience and the
current grant; verifies the exact account/workspace before and after the provider
read; compares the current source bytes and ledger head; and rechecks the policy.
A widened policy cannot rewrite an unchanged capture's original audience. Revoked,
changed or unavailable material remains stored but cannot be replayed as current.
These are boundary checks, not an atomic transaction with Granola.

## Revision and Evidence behavior

Unchanged canonical material returns the original revision and Logical Meeting
binding. Changed note material creates one later immutable revision. Capture
addresses include the per-user connection ID, so the same provider ID returned
through two founders' connections remains two captures. Dates are retained in
original provider form; an unknown timezone/end time is not guessed. Participant
metadata used for inclusion does not become a speaker identity or a cross-provider
matching identity.

Basic note material is `provider-derived`; raw transcript and speaker identity
capabilities are explicitly unavailable. The adapter never claims exact speech
or synthesizes a merged transcript. Enhanced notes require recognizable note or
summary sections; otherwise availability is not-ready. Coverage remains partial
because the history window, discovery bound and metadata limitations are real.
A missing item in a recent page never means provider deletion. The core already
supports richer capabilities; a future adapter can supply them without replacing
the shared Meeting model.

## Runtime composition and remaining work

`createGranolaCaptureIngestionRuntime` accepts the existing owned database,
workspace ID, policy, and up to four separately constructed MCP clients. It
returns `start`, `stop`, `syncOnce`, content-free `status`, the guarded sources and
LogicalMeetings.
Periodic discovery defaults to five minutes and ten captures per connection.
It serializes whole sync runs, rotates through known addresses, exposes partial
coverage/failure counts, and stops admission before awaiting an active run. The
composition owner must await `stop()` before closing the database. Reporting callbacks
are also awaited inside the admitted run; asynchronous status writes cannot
outlive a clean stop. No second AI
budget or standalone source store is created.

The runtime seam is implemented but is not yet installed in `startServer`.
One-time per-user OAuth onboarding, account/workspace attestation, a live supported
shape check, and main-server scheduling/health composition remain pending. No
personal connection has been activated by this change. Logical capture identity
and Human binding reuse LUM-33; downstream multi-capture synthesis and canonical
Notion Imported Meeting Records remain LUM-35 work. This slice does not complete
that broader product promise.

Deterministic tests exercise the real HTTP client through decoding, archive and
LogicalMeetings, plus replay/revision behavior, personal exclusion, original
sharing fences, per-connection isolation, policy races, current source changes,
protocol failures and shutdown draining. The HTTP provider responses and OAuth
credential are synthetic; there are no live reads, paid calls or external writes.
