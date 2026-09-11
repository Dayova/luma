# Advisory founder consultations

Luma can publish an explicitly instructed advisory poll in a reviewed founder
thread without binding that Conversation to a Meeting. `/consultation start`
selects an existing founder source message, purpose, exact question and 2–10
alternatives (separated by `|`, at most 55 characters each). `hours` defaults to
24, with Discord's 1–768 hour range. `owner` names an accountable founder when
established; an omitted owner remains unknown. `replaces` explicitly links a
replacement to the retained original consultation. The authenticated command is
the Human authorization for this exact plan; no additional approval command is
needed. Ask remains read-only and cannot publish a poll.

The source is a complete, bounded capture ending at the selected original
message. It includes surrounding discussion and at most ten captured poll
candidates. Ordinary founder messages do not need a leading Luma mention for
this command; the separate Ask entrypoint still does. Missing content, unsupported
messages, partial history and inaccessible sources refuse publication. No AI
model runs on the consultation path, including capture, publication, results,
closure and recovery. The model usage limit therefore does not prevent these
operational commands.

Context owns the canonical Conversation consultation, immutable original plan,
source proof, four intended founders and approved provider-neutral Follow-up
Intent. Follow-up Execution loads this intent by workspace, typed Conversation
subject and ID. It persists a claim before calling the provider, then records a
context-neutral receipt in the Conversation ledger. No synthetic Meeting,
Meeting Observation or Decision Record is created. Exact repeated requests reuse
the stored operation; equivalent commands at the same source return the original
consultation. A different command cannot bypass an uncertain publication in the
same discussion. Explicit replacements retain the original record and history.

Publication uses the existing Discord Gateway's REST transport, with automatic
network/server-error mutation retries disabled. Every provider operation verifies
fresh source access, complete founder-only channel audience, exact application,
original recipients and the configured role's actual identity and membership.
Display names never authorize a role or channel. The role notification is in the
poll message with an exact allowed role mention. A matching open founder or Luma
poll can be reused without a repeated mention. An existing matching poll whose
closing state is unknown blocks a new publication. Native limits, ambiguous
matches and incomplete bounded searches fail closed.

The receipt contains the canonical consultation ID and original source message
ID. Use both in the same thread:

- `/consultation status` reads the exact stored positive publication reference
  and retains a new advisory tally observation. Unknown counts remain unknown;
  provisional and finalized results are distinguished. Recent Human reasoning
  is shown separately from counts.
- `/consultation recover operation:Publication` probes for exact positive
  evidence of the original uncertain operation. Absence is not proof of failure;
  Luma does not repost or repeat the role mention. If publication was positively
  refused before a write, that operation remains refused; a new explicit
  replacement is a new instruction.
- `/consultation close` explicitly authorizes closing a positively recorded Luma
  poll. Repeated requests, including from another founder, attach to the same
  closure intent. Human-created polls cannot be closed by this command.
- `/consultation recover operation:Closure` reads the original stored poll and
  records success only when closure is positively established. It never repeats
  the close mutation after an uncertain response.
- `/consultation judgment` retains a Human choice and rationale independently of
  poll results. A judgment by the explicitly selected owner is labeled as such;
  other founder comments remain founder opinions. Neither creates a Decision
  Record nor authorizes spending, work items, contracts or code changes.

The original full source hash remains retained for audit. Fresh publication and
lifecycle authorization uses a second hash that ignores only dynamic aggregate
poll results and expiry. Wording, authors, original message IDs, reply boundaries,
completeness and all other source facts must still match. Source deletion, changed
wording or lost audience access withholds old publication/results at the final
reply boundary. Historical snapshots and receipts are retained; no age-based
source deletion runs. Discord does not provide an atomic permission-check/send
transaction, so the final fresh proof bounds, but cannot eliminate, that provider
race.

A native poll may exist even when Discord did not verify the intended role
notification. The receipt exposes `incomplete` or `unknown` notification status;
Luma does not fix it by republishing or pinging repeatedly. A founder can inspect
the existing poll. Poll winners, expiry and aggregate counts establish neither
quorum, unanimous founder participation nor decision authority. Objections and
Human reasoning remain relevant; heavily disputed ideas should ordinarily be
paused or discarded under the founders' guidance.

## Activation

Set these in the protected production environment after verifying the actual
IDs. No live publication occurs merely from enabling the command.

```dotenv
LUMA_DISCORD_CONSULTATION_ENABLED=1
LUMA_DISCORD_TEAM_ROLE_ID=<exact-reviewed-role-id>
LUMA_DISCORD_CONSULTATION_PARENT_CHANNEL_IDS=<reviewed-internal-text-parent-ids>
LUMA_DISCORD_CONSULTATION_ALLOWED_DISCORD_USER_IDS=<all-four-unique-founder-discord-ids>
```

Parents must be a subset of `LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS`. The four
configured users must exactly match the canonical founder identity mappings;
missing or ambiguous identities stop startup. The same bot requires Discord's
Message Content and Guild Members privileged intents to capture ordinary source
messages and prove the complete live audience. Ask has its own opt-in scope and
is not required. The command registers on the configured guild using the shared
Gateway, store, identity policy and lifecycle. It requires no additional bot,
model API key or worker process.

Deterministic tests exercise real PGlite reopen/recovery, the composed server
commands, SDK command mapping, source capture and the provider's REST behavior.
They do not prove live role settings, privileged intent activation, Discord
permissions, or an actual successful production poll. No live poll, role mention,
vote or provider account change is part of those tests.
