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
stalled cleanup cannot retain an admitted request indefinitely. A credential callback supplies an authorized OAuth token with its expiry. The
OAuth manager below refreshes credentials and replaces the MCP session before
expiry, while checking the live local grant before and after every read. There is
no credential discovery or fallback to local Granola/other-app sessions.

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

## Per-founder OAuth and secure credentials

`granolaOAuthConnectionsFromEnv` creates the owner-authenticated connection manager
without making a network request. Startup configuration is:

- `LUMA_GRANOLA_OAUTH_ENABLED=1`
- `LUMA_GRANOLA_CREDENTIAL_KEY_PATH`: absolute path to a separate 32-byte random key
- `LUMA_GRANOLA_OAUTH_REDIRECT_URI`: fixed HTTPS callback; loopback HTTP is accepted
  for local development only

The key must be a regular single-link file owned by root or the runtime user,
without symlinks or group/other permissions (for example mode `0600`). It must be
retained separately from the database and restored with it. The
[unattended backup](../operations/unattended-operations.md) includes its exact
bytes in the encrypted runtime recovery bundle and proves decryption on an
isolated restore before reporting success. Keep the independently held repository
password recovery material as well. Wrong keys and corrupted
credential rows fail startup. Never print it, put it in source control, or replace
it casually: it decrypts retained credentials. The existing owned Luma database
stores AES-256-GCM ciphertext with workspace and founder identities authenticated
as associated data. Source archives and SQL logs contain no plaintext OAuth token,
refresh token, PKCE verifier or authorization code.

The manager exposes these owner actions through a caller-supplied
`authorizeOwner(actor)` capability. That capability must resolve the actually
authenticated Dayova actor to exactly one of the four founders; a form field,
OAuth response, account name or attendee cannot select the owner.

1. `begin({actor})` checks the founder, discovers the official pinned OAuth
   metadata, registers a public client and returns an authorization URL with a
   random expiring state and S256 PKCE challenge. The callback URI is deployment
   configuration, not supplied by a browser request.
2. `complete({actor,callbackUrl})` requires the same authenticated founder, exact
   callback/state/issuer, and a single-use attempt. It exchanges the code and
   stores the encrypted credential, but does not admit a capture. Denied consent
   consumes the attempt without a token request.
3. `inspect({actor})` probes only the advertised read tools and account-info tool.
   It returns the provider's account/workspace text and its exact fingerprint to
   that founder. The UI must render this untrusted text as text, never HTML, and
   must not log callback URLs or private account data.
4. `attest({actor,connectionId,accountFingerprint,choices})` rechecks the account
   and records the owner's selected founder audience and meeting eligibility.
   Automatic internal-meeting selection defaults off. `configure` subsequently
   updates the owner's exact inclusions/exclusions and audience while preserving
   the original opt-in identity; retained captures still enforce their original
   recipients. Reconnecting creates a new connection and opt-in identity instead
   of inheriting old source grants.
5. `disconnect({actor})` disables local access and removes usable credentials.
   Even an initialized MCP client is denied on its next read. This is local
   disconnection; Granola has not advertised a browser-OAuth revocation endpoint
   in the metadata used here. The founder may also remove consent in Granola.

The transport verifies Granola's protected-resource metadata and exact advertised
issuer/endpoints, then uses authorization-code and refresh-token grants for the
`mcp` resource with `offline_access`. All requests use fixed HTTPS origins, reject
redirects, bound response size and time, and abort the actual request. Cleanup
cannot hold shutdown open. Metadata and primary behavior were checked against the
[official Granola MCP guidance](https://docs.granola.ai/help-center/sharing/integrations/mcp)
and the provider's public metadata on 11 September 2026; no account was connected.

Refresh claims are durable before dispatch, refreshes are joined for concurrent
clients, and rotated tokens are saved before reuse. An uncertain exchange or
rotation requires reconnection rather than replaying a possibly consumed token.
Interrupted claims remain visibly incomplete after restart. `status()` exposes
only owner/connection IDs, phase and safe failure codes. `stop()` stops admission
and drains all admitted OAuth and managed MCP work before the common database
can close. A concurrent owner disconnect cannot be overwritten by a refresh.

## Runtime composition and remaining work

`createGranolaCaptureIngestionRuntime` accepts the existing owned database,
workspace ID, policy, and up to four separately constructed MCP clients. It
returns `start`, `stop`, `syncOnce`, content-free `status`, the guarded sources and
LogicalMeetings. Periodic discovery defaults to five minutes and ten captures per
connection. It serializes runs, rotates known addresses, exposes partial coverage
and failures, and stops admission before draining the active run and reporting.
No second AI budget or standalone source store is created.

The OAuth manager supplies `policy` and `connections()` directly to this runtime.
Main composition must refresh its connection registry after attestation,
configuration or disconnect and must drain the capture scheduler before the OAuth
manager and shared database. Server/Discord owner entry and browser callback
handling belong to the unified main runtime; this module does not open a separate
unauthenticated listener. Live consent, account attestation and compatibility
validation of actual provider output remain activation steps. No personal source,
OAuth registration, provider mutation or production service was activated during
implementation. LUM-34/LUM-35 still require their connected-runtime delivery.

Deterministic tests exercise actual HTTP metadata/registration/token/MCP handling,
PKCE and owner/state binding, explicit account attestation, encryption/recreation,
per-founder isolation, refresh rotation, unknown outcomes, stopped/revoked access
and ingestion that archives an included work capture while withholding a private
capture. They use only synthetic provider responses and tokens.

## Founder onboarding in Discord

When the main runtime composes `createDiscordGranolaRuntime` and Granola OAuth
is enabled, `/granola` is registered alongside the existing native Meeting
commands. All replies are ephemeral and every command requires the unique
founder identity and current founder-only Discord channel audience.

1. `/granola connect` starts the authenticated founder's browser login and returns
   a personal authorization link. The fixed browser callback completes the
   exchange and binds it to that original actor. No code needs to be pasted back
   into Discord. Login alone never admits a meeting.
2. `/granola inspect` reads the actual connected account and workspace from the
   provider. Long account information remains available with `page:<N>`. It is
   shown only to the initiating owner. Account text is untrusted information, not
   a permission instruction. The local review receipt stores only the account
   fingerprint, connection, actor and timestamp, never account text or tokens.
3. `/granola attest confirm_account:true sharing:four-founders` explicitly confirms
   the inspected account/workspace and permits eligible captures to be shared
   with Jakob, Fabius, Philipp and Julius. The account review expires after ten
   minutes, and the manager rechecks its exact fingerprint before accepting it.
   With no source choices, nothing is selected. The optional choices are:
   - `include_urls`: comma-separated exact `https://notes.granola.ai/d/<ID>` links.
   - `exclude_urls`: exact links that must remain excluded; exclusions take priority.
   - `internal_meetings:true`: opt in to automatic captures with only explicitly
     mapped founders. Unknown attendees remain excluded. This needs explicit
     `founder_emails`, for example
     `Jakob=jakob@example.com,Fabius=fabius@example.com`, including the owner and at
     least one other founder. Provider names never create identity mappings.
4. `/granola status` shows the owner's connection, current source choices and
   Basic capability limitation. Long lists are available through `page`.
   The optional owned `sourceStatus(connectionId)` port reports only that owner's
   actual intake state, scheduled retry status and safe failure codes. The source
   scheduler tracks each connection separately: another owner's completed scan
   cannot make this connection look checked, and interruption never completes a
   first scan. Budget
   blocking points to `/meeting usage`; unsupported provider output and unknown
   AI outcomes remain explicit. Missing health is shown as unavailable, never as
   a successful scan. The snapshot is rechecked at final delivery.
   `/granola configure sharing:four-founders` changes only supplied choices and
   preserves omitted included/excluded lists, founder mappings and the automatic
   capture setting. A concurrent policy change rejects the command instead of
   restoring older private exclusions. The literal `none` clears a supplied list. Inspect the account
   again if the ten-minute review has expired.
5. `/granola disconnect` disables the local connection, clears credentials and
   refreshes the active source registry. Existing shared captures remain retained;
   a previously initialized client can no longer read through the old grant.
   Granola's own authorization can be revoked separately in its account settings.

The owned app-facing factory receives the shared database/workspace, real OAuth
manager, callback host's `begin`, and the shared registry refresh callback. It
never chooses an actor from provider text or HTTP query parameters. Attestation,
configuration and disconnect complete their registry refresh within the admitted
Discord command; shutdown waits for that command. Exact owner, account fingerprint,
connection and policy are checked again at the actual native reply boundary.
No account consent, source activation or real external write is performed by the
native test suite, which programs HTTP provider responses and uses a local callback.

### Derived actions and canonical outcomes

Capture synthesis action claims enter the existing Meeting Intelligence review
workflow with an explicit `capture-synthesis` source identity. They are not imported
Notion Meeting Notes. Source material, binding, original recipients and synthesis
revision remain independently verifiable; historical candidates remain stored.
Read projections withhold candidates from capture sets whose original source proof
is no longer current.

`/meeting actions meeting_id:<logical ID>` shows canonical work reconciliation,
including Granola-only meetings. When details are missing, a founder uses
`/meeting judge choice:resolve-action` with the exact synthesis revision and claim,
`modality:commitment` or `request`, a `due_date` in YYYY-MM-DD form (or `none`), and
either a founder `owner` or `intentionally_unassigned:true`. These details are
retained as Human evidence and shown in the synthesis publication. A claim
correction clears its prior action details; unresolved contradictions continue to
block settlement. Partial Basic coverage stays visible.

The action review's `accept` choice records a Human reconciliation resolution and
creates a suggested Follow-up Intent. `choice:execute` with its exact intent and
synthesis revision explicitly approves execution. Luma first requires an existing
positive canonical synthesis publication and rechecks its native signed region and
current sharing grant. Work creation/update and the compact Operational Outcome use
that same canonical Notion record. `choice:recover` preserves the existing positive
or unknown provider-result rules; it never grants permission to blindly recreate
work. Source changes or revoked access before dispatch block writes; a positive
work receipt is retained even when the final Notion outcome must wait for recovery.

Before any live publication, the v1 synthesis wire format now fixes JSON object-key
ordering by UTF-16 code units and escapes prose list markers. This replaces local
prototype locale-dependent bytes; it does not guess legacy collations or silently
re-sign incompatible historical archives. Later signed-format changes require an
explicit version and retained-history migration.
