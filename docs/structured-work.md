# Compound structured knowledge and work

This implements the owned core, production provider/model/source adapters and native Discord ingress for [LUM-39](https://linear.app/dayova/issue/LUM-39/p1-execute-compound-discord-commands-across-structured-notion-records), following the [canonical compound-operation contract](https://app.notion.com/p/3d52e87228bf81839c2cda777f8c419e).

An authenticated explicit command can authorize a configured Structured Record and
its validation work together. The public Interface stays `observe`, `query`, and
`conclude` on Meeting Intelligence. The request selects a configured semantic table
alias and preserves the exact original actor, instruction and bounded Conversation or actual imported Meeting.
Questions, quoted commands and negated instructions do not enter this Execute path.
The provider/model implementations never receive authority from inferred job titles.

The public query returns the exact proposed fields/work scope, clarification or
approved intent, and one set of per-target outcomes. The approved intent is
executable only by its canonical request and intent IDs. No caller supplies a
replacement execution payload. Original source material and partial outcomes remain
in the same shared database; no synthetic Meeting is created.

## Composition

Pass `structuredWork: StructuredWorkConfiguration` to `createMeetingIntelligence`.
It requires an original-source capture/currentness adapter, the bounded
`StructuredWorkInterpreter`, `StructuredRecords`, the actual `WorkProvider`, the
shared identity/access policy and original audience, and explicit operator-configured
target aliases/authorized people. The model sees only provider-neutral schema,
record and work snapshots. `structuredWorkInterpretationSchema` rejects invented
output structure; owned validation checks all fields, options, evidence IDs,
selected identities and ownership before constructing an approved intent.

The Linear destination additionally requires `workAuthorization`. The production
`createStructuredWorkSharingAccess` factory reads the existing protected sharing
policy against an exact credential scope and team on every check. Service-token
visibility does not itself authorize disclosure to the source audience. The original
work scope is immutable, and its grant is rechecked before discovery/model input,
every write, receipt query and replay.

`createFollowUpExecution({ database, meetingIntelligence })` discovers the owned
module and accepts `{ workspace, subject, structuredWorkRequestId, intentId }`.
Normal execution and positive-only recovery use the same durable plan.

The native Discord ingress and owned application factory are composed in the main
server with its existing MI, Follow-up Execution, Linear provider, database and AI
budget. Actual main-runtime tests exercise both requested mutations, replay, source
revocation, exhausted budget and shutdown. No table, token, command or schedule has
been activated by these local tests, and this document does not claim deployment.

## Native commands and main-runtime factory

Enable this separate capability with `LUMA_DISCORD_STRUCTURED_WORK_ENABLED=1`.
Set `LUMA_DISCORD_STRUCTURED_WORK_PARENT_CHANNEL_IDS` to a subset of the common
Discord parent scope and `LUMA_DISCORD_STRUCTURED_WORK_ALLOWED_DISCORD_USER_IDS`
to exactly the four currently and uniquely mapped founder accounts. Optional
`MAX_MESSAGES` and `MAX_EVIDENCE_CHARS` settings under the same
prefix use the bounded Conversation capture defaults. Enabling Ask alone never
activates writes. The existing single Gateway client supplies the separate
`structured-work` capture purpose and requires Message Content intent.

Post the actual explicit instruction with a leading @Luma mention in an admitted
thread, for example: “Add this hypothesis to our Hypotheses table and create a
Linear task to validate it.” This directly starts the owned compound workflow and
returns one source-thread receipt. Name a configured target alias or its full label
in the table clause. Missing or multiple target matches produce a focused
clarification before source analysis, model calls or writes. A target mentioned only
in the task clause does not select the table. Current provider schema, source and
owner checks still run inside MI; the literal name does not grant authority.

The exact original anchor must remain unchanged between the Gateway event and
source admission. Repeated events and later slash retries use the same durable
operation identity. Native mentions use the existing founder-only channel proof,
separate capability scope, rate limit and shared AI budget. There is no second
Gateway or autonomous polling loop. Receipt delivery rechecks current source and
recipient access, with all mentions disabled.

The explicit commands remain available for choosing a target or viewing recovery:

- `/structured-work request source_message:<original-message-id> target:hypotheses`
  selects a configured table alias. The author must be the person who wrote the
  original instruction. The edge reads the exact instruction; no second pasted
  wording or extra approval is required. Knowledge and work still reconcile inside
  MI, and missing owner/context produces a retained preview and clarification.
- Add `meeting:true` to use this thread's existing `/meeting bind` imported Meeting
  as additional original evidence. The actual Meeting binding and its current
  imported grants are checked; imported speaker labels never establish an owner.
- Optional `work_item:<exact-Linear-id>` selects a known existing task, including
  an archived task. It cannot be silently replaced by model output.
- `/structured-work status source_message:<id> request_id:<returned-id> [meeting:true]
page:<number>` exposes every preview field, uncertainty and per-target result in
  bounded ephemeral pages. The source audience and retained state are rechecked
  immediately before the reply. Original full details remain in the shared store.
- `/structured-work recover` with the same address performs read-only positive
  recovery. It never resends an unknown write. After positive recovery of the first
  target, repeating the same `request` continues any already-approved pending
  second target. The same source and selection retain one request ID across new
  slash interactions and process restarts, so this does not repeat inference.

The optional explicit commands take a source message ID, available through Discord's **Copy Message ID** action with Developer Mode enabled. The direct mention flow needs no copied ID. Conceptual questions and quoted/negated instructions
remain outside this command's execution admission. Requests and status replies are
founder-only and ephemeral, with mentions disabled; there is no guest support mode.

`structuredWorkRuntimeConfig(env)` validates presence and safe scope before resource
allocation. `validateStructuredWorkFounderScope(...)` verifies the live identity
mapping. Required production values are:

- `LUMA_STRUCTURED_WORK_TARGETS_PATH`: absolute protected JSON mapping below.
- `LUMA_STRUCTURED_WORK_NOTION_API_TOKEN`,
  `LUMA_STRUCTURED_WORK_NOTION_CREDENTIAL_SCOPE_ID`, and
  `LUMA_STRUCTURED_WORK_SIGNING_KEY` (at least 32 bytes).
- Existing `LINEAR_API_KEY` and `LINEAR_TEAM_ID`, plus
  `LUMA_STRUCTURED_WORK_LINEAR_CREDENTIAL_SCOPE_ID` for the exact work-sharing grant.
- Existing `OPENAI_API_KEY` and `LUMA_CONTEXT_SHARING_POLICY_PATH`. Both destination
  grants must explicitly cover all four original recipients. Notion row access is
  also proved against the exact configured parent by the native adapter.

The protected target file is a versioned, workspace-bound document. This example
selects existing schema; deploying it never creates schema or new status options:

```json
{
  "version": 1,
  "workspaceId": "workspace_dayova",
  "targets": [
    {
      "key": "hypotheses",
      "label": "Product Hypotheses & Validation",
      "dataSourceId": "8fd29131-8312-411d-a833-f320f1afbfaf",
      "titleField": "hypothesis",
      "fields": {
        "hypothesis": { "property": "Hypothesis", "type": "text", "required": true },
        "evidence": { "property": "Evidence so far", "type": "text" },
        "status": { "property": "Status", "type": "choice", "required": true }
      },
      "defaults": { "status": { "type": "choice", "value": "To validate" } },
      "sourceProperty": "Source",
      "ownerProperty": "Owner",
      "authorizedPersonIds": [
        "person_jakob",
        "person_fabius",
        "person_julius",
        "person_philipp"
      ]
    }
  ]
}
```

This is an example mapping, not an activated configuration. The file must be a
single-link regular file owned by the effective user or root, at most 65,536 bytes,
with no group/world write permission; symlinks are refused. Aliases, data sources,
property mappings, defaults and founder authorities are validated without guessing.
A changed file immediately withholds current requests until deliberate restart and
reconciliation. Preserve this file and the env signing key with the existing
recovery bundle while retained requests may need recovery, even if ingress is off.

`createStructuredWorkRuntime({config, env, workspaceId, database, ledger,
conversationEvidenceSource, importedSourceAccess?, identityDirectory, accessPolicy,
work, budget, limits, model})` receives the existing store, source reader, exact
configured Linear `WorkProvider`, shared budget and identity policy. It returns:

- `configuration`, passed as `structuredWork` to the single `createMeetingIntelligence`.
- `discord({meetingIntelligence, execution})`, passed as `structuredWork` to the
  existing Discord bot after its normal `createFollowUpExecution` is created.
- `stop()`, called after bot/transport drain and before closing the shared database.
  Bounded provider/model calls may return while an already-started currentness
  proof is settling. The factory refuses late proof admission and drains those
  original proof promises before permitting store closure.

The factory creates no separate store, Gateway, scheduler or model budget. Stop
and drain the existing bot/transport before closing the shared database; their
admitted command promises include source checks, approved execution and final
receipts. True external factories may be supplied for deterministic integration
tests; runtime behavior still flows through the actual MI/FUE implementation.

## Actual model and original sources

`createOpenAIStructuredWorkInterpreter({ apiKey, budget, limits, model })` uses the
existing priced model default and the same durable budget as Ask and Meeting
analysis. It sends a closed strict Responses schema, no tools, `store: false`,
the standard tier and no SDK retries. A bounded field key/value array is converted
into owned semantic fields only after validating field types/options, citations,
people and existing reconciliation identities. An invalid output settles reported
usage and approves nothing. Budget/quota/timeout reasons stay visible through MI.

Large complete catalogs use OpenAI's [native input-token count](https://developers.openai.com/api/docs/guides/token-counting)
when the conservative UTF-8 byte bound exceeds the configured token limit. The
exact model, original input, instructions and strict output schema are identical
for counting and generation. The shared budget reserves the entire permitted
input plus output allowance before either disclosure; original access is proved
before counting and again after its network wait. An invalid/excessive count,
lost access, exhausted budget or timeout starts no generation. Inputs above a
1 MiB serialized bound are refused before counting. Small requests keep the local
byte bound and need no extra network call. No context is truncated, no model or
monthly cap is changed, and actual generation usage still settles the reservation.
The native SDK regression retains all 396 issues in a synthetic complete catalog;
it does not establish the live token count, latency or answer quality of Dayova's
current catalog.
The native schema follows the [official Structured Outputs contract](https://developers.openai.com/api/docs/guides/structured-outputs), checked 2026-09-11.

MI supplies a final disclosure guard. The shared AI request helper runs it after
durable budget reservation and before the SDK call. Revocation at that boundary
settles a proved undispatched attempt at zero cost. A timeout before dispatch
cannot later call the model when a delayed proof completes; a timeout after
actual dispatch keeps its possible charge unknown. The retained original command
still prevents an automatic repeat paid interpretation.

`createStructuredWorkEvidenceSource({ conversation, importedMeetings? })` composes
the existing original Conversation and imported-source proof implementations. Its
Conversation capture purpose is `structured-work`; the current anchor must retain
its exact leading @Luma command and original admitted Human author. Original raw
captures are retained in the shared Observed Source Ledger, with current unique
identity mappings and exact original audience. Poll tally/expiry changes may evolve;
changed original wording, options, authors, boundaries or grants cannot authorize
the old plan. No Decision record or synthetic Meeting is created by this reuse.

An actual Meeting request includes `instructionSubject`, selecting the original
command Conversation separately. The stored `source` keeps the imported Meeting's
original revision, hashes, provenance and unattributed original speech untouched;
`source.instructionSource` retains the complete authenticated command capture.
Both audiences must match and both current proofs are rechecked before model
input, write, query and replay. Imported speaker labels and generated summaries
never establish an owner. The command thread must itself contain independently
proved Human acceptance, otherwise the candidate preview asks for clarification.
Provider record bodies retain both distinct sets of original evidence.

Native routing must pass only the current authenticated message, complete bounded
capture and actual selected Meeting; it must never manufacture an instruction
from a displayed title or a model answer. It must revalidate the selected Meeting
binding and current destination audience immediately before rendering private
receipts, as the existing Decision/consultation ingress does. Work authorization
must use the protected sharing factory for the exact configured Linear scope/team
and be supplied to MI; enabling a token or channel alone does not grant access.

## Reconciliation and ownership

Knowledge and work reconcile independently. Existing/new, new/existing, both
existing and both new all retain exactly one pair of references. Complete discovery
is bounded to 100 configured Notion rows and 1,000 non-archived Linear issues across
all workflow states. An incomplete/larger result withholds execution. Completed
and canceled tasks remain reconciliation context; they cannot silently disappear
and cause a replacement task. A command may explicitly select `workItemId`; that
identity is read directly even when outside ordinary discovery, including an
archived task. It cannot be silently replaced by the interpreter. Ordinary discovery
does not claim to enumerate archived Linear issues.

The actual Linear adapter uses bounded native GraphQL pages for the exact
team, its non-archived issues and the nested fields Luma needs. It verifies the
selected team is actually readable, every returned issue belongs to it, and both
issue and label connections are complete. The generic fuzzy search is not evidence of complete absence. This
bounded catalog approach is appropriate only while the selected table/team fits
the limit; larger scopes require a separate bounded candidate-index/reconciliation
design before enabling the feature there.

Only original authenticated Human Evidence can establish ownership. A direct
commitment, or an owner's explicit "should I validate" question immediately
confirmed by another admitted Human, is accepted. Mere mentions and polls cannot
assign work. Missing/ambiguous provider identity refuses creation. Intentionally
unassigned work requires a literal Human instruction; it is not a null fallback.
The original ownership evidence and unique provider mapping are rechecked before
execution and replay. These deterministic forms are deliberately bounded; other
wording returns a targeted ownership clarification rather than guessed assignment.
This gate applies to new work and work updates. Linking an existing task makes no
assignment and retains its current owner; unresolved ownership does not block that
link or force an owner onto a separately created knowledge record.

## Linear discovery bounds

Compound discovery does not use the SDK's lazy per-issue relationship fetches.
A 100-issue native fixture produces one HTTP request per complete pass, including
assignee, state, labels, project and parent. Labels have an explicit 51-result
probe; more than 50 labels or a further label page withholds completeness. Issue
discovery follows at most ten 100-issue pages to the shared 1,000-issue bound;
incomplete, repeated or inconsistent pages remain unavailable. This keeps each
100-issue page below the documented 10,000-point single-query ceiling under
Linear's published complexity formula. Exact named archived work continues through
the provider's direct reference read; ordinary discovery includes all workflow
states but excludes archived issues.

The query uses a scoped SDK transport with a 15-second abort deadline, no retries
and rejected redirects. HTTP-200 GraphQL partial errors, rate limits, malformed
fields, duplicate identities, foreign teams and missing pagination proof withhold
the catalog. Existing source/owner/work-grant fences still run for every pass and
immediately before a create. A faster read never substitutes for a current proof.

This follows Linear's [custom query and rate-limit guidance](https://linear.app/developers/rate-limiting)
and [GraphQL error/archived-resource contract](https://linear.app/developers/graphql),
checked 2026-09-11. The API-key request allowance is shared by the authenticated
user, including their other keys. The test establishes request counts and behavior
under delayed native responses; it does not claim a measured live-service latency.

## Native Notion capability

`createNotionStructuredRecords` resolves configured aliases to exact native data
sources. It reads the current schema and validates semantic field mappings to
title/text, choice, number, boolean, URL and date properties. Choice options must
already exist. It never creates a property, option, table or ad-hoc page. Configured
initial defaults remain fixed for a new record, so a request to validate a hypothesis
cannot invent a successful validation result.

Separate configured `Source`, `Owner` and related-work properties cannot be
overwritten through inferred fields. A current unique Notion identity maps the
confirmed owner. Source Evidence is written into the new page body and the
configured source property. A known Linear reference is included where the schema
supports it. Relations require their own verified target-resolution capability and
are not inferred from page titles or raw model IDs in this slice.

The parent data source and every existing row require current permission for the
complete original audience. The adapter has a 240-second operation bound, uses
the shared Notion request scheduler and 4-second native request cancellation, and
disables SDK mutation retries. It repeats exact source/owner/schema/table checks
after queue waits and immediately before the single create dispatch.

The native [data-source schema read](https://developers.notion.com/reference/retrieve-a-data-source)
and [page property update](https://developers.notion.com/reference/patch-page)
contracts were checked on 2026-09-11. Native property updates expose no conditional
version argument. Existing records can be read/reused. An explicit compound update
produces `manual-application-required` with the existing record links, exact reviewed
versions and labeled changed values (`before` / `after`). The request retains its
original Evidence and interpretation, creates no approved write Intent, and executes
neither half of the bundle. Replaying it neither writes nor pays for another model
call. The caller applies the reviewed changes in the provider; Luma does not claim
that this happened. Linear updates likewise require its optional actual conditional
update capability; the current native Linear provider does not advertise one.

Record updates contain only supplied, schema-validated fields. Omitted properties
remain unchanged, and creation defaults are never injected into an update. Work
updates need the same authenticated ownership proof as creation before Luma offers
an applicable update proposal. A create-if-absent instruction cannot authorize an
inferred overwrite; the two imperative clauses explicitly distinguish creating,
updating and linking. Conceptual, quoted or negated examples stay outside Execute.
Quoted hypothesis content remains valid inside an actual instruction, including
escaped delimiters, but it cannot select a destination or introduce another
imperative clause. A model's `link` classification cannot hide a requested update:
proposed fields, task text and any requested assignment must already match the
selected record. Otherwise Luma asks for a corrected update proposal. A proposed
update with no changed values reports that no change is needed instead of issuing
an empty manual action.

Retained previews can contain any row supplied to the model, so they require the
original knowledge credential/target scope, current original-audience access to
every contributing knowledge row and continued membership of the original work
catalog. A new credential scope cannot revive an older preview. Legacy requests
without the original knowledge scope remain withheld. Before any provider stage
has progressed, the complete original snapshots must also remain exact at final
disclosure, including every manual proposal's selected version. Changed data needs
a new reviewed request; no stored preview is silently rewritten. After actual
execution, receipt reads preserve original input access while allowing Luma's own
known changes. These checks apply to initial delivery, status, conclusion and replay.

## Durable execution and recovery

Meeting Intelligence stores the exact model-attempt admission before inference.
Duplicate commands never pay for another inference. Safe classified AI budget,
quota and timeout outcomes remain visible, with original Evidence retained.

Follow-up Execution serializes Luma-owned bundles against the selected provider
pair. It persists the immutable external payload and in-flight claim before each
possible mutation, then persists the positive receipt before the next stage.
The default order is Notion then Linear; an explicitly configured reverse order
uses the same safety rules. A linked existing object is an independent successful
stage. A completed pair records both external references alongside the shared
source, enabling either counterpart to be traced through that canonical request.

Unknown dispatch outcomes never authorize a resend. Notion recovery requires one
exact signed operation marker plus the current expected properties and owner.
Linear recovery requires the original idempotency marker, exact created title/body,
assignee and identity. Missing, changed or ambiguous results stay unknown. A lost
Linear acknowledgement cannot repeat a successful Notion create. The reverse
direction is tested as well. A local success-settlement failure retains a known
reference in an unknown state where persistence remains available.

`recover` performs read-only positive probes. If it proves an interrupted stage,
the already-approved `execute` call may continue any remaining unattempted stage;
no new approval is implied. If the current source/actor/owner grant cannot be
verified, the private response is withheld and the durable outcomes are retained.
This is staged execution, not an atomic distributed transaction. Concurrent changes
made directly in a provider remain subject to that provider's read/write semantics.

## Design comparison and verification

Two designs were compared before freezing the Interface: a caller-visible generic
operation bundle/stage engine, and a typed source-bound request with private stages
behind Meeting Intelligence. The latter keeps semantic reconciliation, validation,
idempotency and recovery inside the deepest Module. Callers submit the desired
outcome and render the owned receipt rather than coordinating provider steps.

Behavioral tests cross actual MI/FUE with PGlite and the actual Linear provider,
and exercise the native Notion SDK via a deterministic HTTP fixture. They cover the
provided feedback/assignment/acceptance conversation, all existing/new combinations,
reverse ordering, source/schema/owner refusal, initial-state preservation,
durable-claim failures, known-reference preservation, command replay and uncertain
acknowledgements. No live source writes or paid model calls are used.
