# Shared meeting capture runtime

The main Luma server composes governed Notion imports and individually authorized
Granola accounts into the same LogicalMeetings, Meeting Intelligence, source ledger,
database and AI budget. Original captures remain immutable. Luma Synthesis is a
separate derived view with explicit source capabilities, coverage, citations and
Human judgments. A Granola Basic note never becomes a verbatim transcript.

Enable `LUMA_MEETING_CAPTURE_SYNTHESIS_ENABLED=1` with at least one configured
source. Notion uses the existing `NOTION_API_TOKEN` / `NOTION_MEETINGS_DATA_SOURCE_ID`
ingestion and separately granted read-only imported-source access. Its actual
Notion page remains the canonical anchor. Granola uses per-founder OAuth; enabling
the runtime alone neither starts OAuth consent nor shares personal meetings.

Publication requires a dedicated `LUMA_SYNTHESIS_NOTION_API_TOKEN`, the exact
`LUMA_SYNTHESIS_IMPORTED_MEETINGS_DATA_SOURCE_ID`, a reviewed
`LUMA_SYNTHESIS_CREDENTIAL_SCOPE_ID`, a stable `LUMA_SYNTHESIS_SIGNING_KEY` of at
least 32 bytes and `LUMA_CONTEXT_SHARING_POLICY_PATH`. The policy grants the exact
native anchor or Imported Records data source to all four founders. A database
grant covers only Luma-owned records after native parent, deterministic key,
original audience and signed meeting identity checks; it never grants unrelated
pages. Use the native `title` property ID. The Imported Records data source also
needs the rich-text `Luma Meeting ID` property for deterministic discovery.

`/meeting captures` lists currently shared logical meetings, including Granola-only
meetings. `/meeting synthesis` shows bounded pages with complete claim text.
`/meeting judge` records a confirmation, correction or rejection for an exact
revision and claim. `/meeting capture-link` binds or separates an exact source
revision after checking its current binding under the workspace lock. These
operations retain raw sources and previous Human judgments.

`/meeting publish` approves and publishes the selected synthesis revision. Existing
anchors receive only the owned Luma Synthesis section. Granola-only meetings get
one owned Imported Record, whose positive receipt becomes the canonical anchor.
`recover:true` checks an uncertain write for an exact existing result; it never
resends an uncertain mutation. A saved positive receipt survives a later local
anchor or source-access failure. This publication does not itself create Linear
tasks or settle Operational Outcome; that derived-work composition remains
separate tracked implementation work.

## Per-founder Granola connection

Set `LUMA_GRANOLA_OAUTH_ENABLED=1`, a fixed
`LUMA_GRANOLA_OAUTH_REDIRECT_URI` and `LUMA_GRANOLA_CREDENTIAL_KEY_PATH`. The key
file contains exactly 32 random bytes, is a private regular single-link file owned
by root or the runtime user, and must remain stable across restarts. Credentials
are encrypted in the shared database; tokens, codes and account details never
belong in logs or repository files. The key needs separately protected encrypted
recovery material in addition to the database backup.

The callback listener defaults to `127.0.0.1:3002`; an explicit IPv6 loopback is
also supported. Configure HTTPS forwarding for exactly the selected callback path.
Production preflight requires HTTPS, separate Notion/Granola listener ports and a
durable key path outside the application release and database. HTTP loopback is
accepted only for local development.

An authenticated founder command starts OAuth. The browser returns directly to
Luma; no code needs to be pasted into Discord. The callback is bound to the original
actor, state and connection. After login the owner must inspect and attest the
actual account and choose what may be shared. Other founders cannot attest or
disconnect that account. Reconnecting immediately retires the old grant, even if
the later login fails. Unknown token exchanges or refreshes require reconnection;
they are not silently resent.

The listener starts before Discord command admission. Capture intake starts after
the shared MI/FUE and Gateway are ready. Owner connection changes drain the old
source registry before replacing it. Shutdown pauses source intake, drains admitted
commands and callbacks while source verification remains available, then closes
capture access, credentials and the shared store. A failed or timed-out drain
retains the unclean store lease for recovery.

Deterministic tests exercise actual HTTP callbacks, encrypted OAuth storage,
native Discord commands, the shared server, governed source adapters and Notion
publication. They do not establish live account consent, provider schema
compatibility, source grants, model quality/cost, host recovery or deployment.
