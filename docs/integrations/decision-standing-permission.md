# Founder permission for automatic Decision recording

Automatic detection can produce reviewable candidates without a standing permission.
It may record a candidate automatically only when the existing Decision Intelligence
checks prove the original Human decision, current scope ownership, reconciliation,
source and destination audience, and a current permission for that exact recording
class. AI confidence, advisory polls and provisional titles grant neither permission
nor decision-making authority.

The native control is `/decision-record automatic`. It is available in the configured
Decision Record parent channels and their supported public threads. A bound Meeting
is not required.

- `action:enable scope:luma class:new-decisions sharing:four-founders` authorizes
  creating or linking records of the issuer's final decisions and accepted proposals.
  It does not authorize changing an existing record.
- `class:decisions-and-corrections` also permits an evidenced amendment, supersession
  or reversal. The owner must explicitly support that action in the decision source.
- `action:status scope:luma` reads only the issuer's permission for that exact scope.
- `action:disable scope:luma` revokes only the issuer's permission. It preserves
  prior instructions, Decision Records, and history.

`luma` is an example of an exact scope key in the configured, source-backed ownership
mapping. Enabling requires current documented ownership of the supplied scope.
This control cannot designate another founder or confer ownership. Disable remains
available after ownership changes, provided the issuer and current command channel
remain authorized. Permission lasts until changed or disabled; every actual use
revalidates it. An unrelated ownership-document revision does not itself revoke the
permission when current ownership is freshly proven unchanged.

The two enable choices are required native options, not inferred consent from chat.
The confirmation receipt identifies the exact class, scope, owner, four recipients,
grant ID and original interaction ID. Discord does not provide a durable message
permalink for an ephemeral slash input: the receipt honestly links its **origin
channel**, while Luma retains the exact immutable typed input. No fabricated source
message or synthetic Meeting is created. Replies are ephemeral with mentions disabled.

## Runtime composition

`createDecisionStandingPolicy` in `src/decision-intelligence/standing-permission.ts`
uses the shared database, `WorkspaceAccessPolicy`, exact four-founder audience,
actual source-backed `DecisionAuthority`, and `DecisionPermissionSourceAccess`.
It implements the existing `DecisionStandingPolicy.read/requireCurrent` port and
adds the native `command` control and `stop` drain. Compose the same instance as
the automatic Decision configuration's `policy` and the existing Discord Decision
runtime's optional `standingPolicy`. No default grant is created by constructing it.

`createDiscordDecisionPermissionSourceAccess` receives the existing transport's
`resolveChannel` method, identity directory and access policy. The transport's
optional `requiredHumanReaderIds` invokes the existing raw REST live-audience proof:
all original four human readers must be present and able to read, and every other
human reader must pass founder authorization. Missing members, guest administrators,
incomplete permissions, changed identity mappings or a moved origin boundary withhold
the permission. No second Gateway client is opened.

The native Human instruction, original boundary, original ownership snapshot and
exact grant are immutable in `decision_standing_instructions`. A separate
`decision_standing_heads` row selects the latest instruction for each owner/scope.
Both updates commit in one shared-store transaction. An old interaction replay is
read-only; native Discord snowflake issuance order prevents a delayed earlier enable
from undoing a later disable. Changing any options under the same interaction ID is
refused. Changing the class produces a new grant and invalidates the old one.

Every grant use verifies the original retained bytes, exact current head, actor,
audience and current ownership. Discovery deduplicates identical origin proofs only
within one bounded pass, followed by a fresh complete-pass proof and final head check.
It supports at most 20 active owner/scope permissions. Historical instructions are
retained. Source/API read failures make a grant unavailable; they never authorize it.
Provider permissions and local revocation cannot be atomically locked across services;
the final checks are fresh provider reads, not an atomic cross-service transaction.

Stop new bot and automatic-source admission, then drain native delivery and the
automatic Decision processing queue before calling the permission service's `stop`;
close the shared database afterward. The service drains admitted
operations and refuses new ones after stop. The normal shared-store backup includes
both tables; there is no new secret or policy file. Existing Decision ownership,
source-sharing and destination credentials remain necessary for execution/recovery.

This slice provides the real native control and durable adapter. Main runtime
composition is a separate integration step; no production permission or source is
enabled by these code changes or tests.
