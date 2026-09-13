# Review uncertain AI charges and resume accounting

Use this workflow when `/meeting usage` reports an accounting hold or an
unconfirmed charge. It records operator-verified USD charges locally; it does
not contact OpenAI, change the USD 30 cap, change model pricing, or retry a paid
request. A verified charge can exceed the local cap: the true amount is retained
and normal budget admission then refuses further requests in that period.
Historical charges stay in their original month and day.

The operator must inspect the actual provider receipt, billing export or support
confirmation and attest which request it resolves. A reference and SHA-256 of
that evidence are retained with the review. The tool cannot independently
authenticate an offline billing document. Missing usage, timeout, an absent bill
line or an empty provider response never establish a zero charge. Zero requires
affirmative provider confirmation of no charge.

## Establish the operator and stop the store

The CLI requires an existing, cleanly stopped store, its clean-close receipt and
exclusive ownership. It refuses an active owner, stale crash lease, quarantined
restore or missing receipt. Follow [backup and recovery](backup-restore.md) first
after an unclean crash. Never delete ownership metadata to enter maintenance.

Use the immutable release that includes LUM-52. Replace `RELEASE` below with its
actual full commit. Build before installing the release; do not build inside the
service account or store. Stop Luma and verify `inactive` before continuing. Take
and verify a full cold backup before changing accounting.

```sh
sudo systemctl stop luma.service
sudo systemctl is-active luma.service
sudo install -d -o root -g root -m 0700 /var/lib/luma-accounting
```

An administrator creates `/etc/luma/accounting-operators.json`, owned by root,
mode `0600`. It maps each founder’s distinct Unix login UID to that founder. Replace the
example UIDs below with the real host accounts. Invoke Node directly through
`sudo` from that personal account: the CLI requires effective root for store
access, but identifies the operator using sudo’s nonzero `SUDO_UID`. It refuses
a direct root session without a sudo invoker. Do not share a Unix login account
between founders or switch to a shared root shell before running these commands.

```json
{
  "operators": [
    { "localUid": 1001, "personId": "person_jakob" },
    { "localUid": 1002, "personId": "person_fabius" }
  ]
}
```

Allowed founder IDs are `person_jakob`, `person_fabius`, `person_julius` and
`person_philipp`. Request files cannot choose another operator. Preparation and
application must use the same policy-bound invoking account. The invoker UID
and founder ID are part of the immutable preparation and audit. Sudo supplies
`SUDO_UID`; do not set or forward it manually. This identifies a host account,
not a biometric human identity. Root administrators can forge environment
variables or rewrite the policy/datastore, so these records do not claim
protection from a hostile host administrator.

Every input and review file must be an absolute, regular file owned by root
with mode `0600`, without symlinks or shared hard links.
Inputs are limited to 64 KiB. Use an editor with `umask 077`; keep documents and
credentials out of command arguments, shell history and logs. Output must be a
fresh path outside the datastore. No command loads the production environment
file or initializes providers. Do not use `env -i` for this entrypoint: it would
remove sudo’s invocation identity. No other environment value authorizes an
accounting operation.

## Inspect and prepare one exact charge

Create `/var/lib/luma-accounting/selection.json` privately:

```json
{ "workspaceId": "workspace_dayova" }
```

```sh
sudo -- /usr/bin/node /opt/luma/releases/RELEASE/dist/src/app/ai-accounting-maintenance.js inspect /var/lib/luma/pglite /etc/luma/accounting-operators.json /var/lib/luma-accounting/selection.json /var/lib/luma-accounting/report-1.json
```

The private report lists sanitized request identities, provider identifiers,
estimated/verified amounts, unknown state, blocker status and the exact request
digest. It contains no prompts or answers. Each page has at most 100 requests;
use the returned `nextAfterReservationId` as `afterReservationId` in another
selection file to read the next page.

After reviewing provider evidence, create a private charge request. Replace the
illustrative UUID, digest, reference, evidence hash and amount with the exact
reviewed facts. Amounts are decimal USD strings, with up to nine decimal places.

```json
{
  "kind": "charge",
  "workspaceId": "workspace_dayova",
  "reservationId": "EXACT_REQUEST_UUID",
  "expectedRequestDigest": "EXACT_64_CHARACTER_REPORT_DIGEST",
  "verifiedAmountUsd": "0.015",
  "reason": "Matched this request to the identified provider billing receipt.",
  "evidence": {
    "kind": "provider-billing",
    "reference": "invoice-and-line-reference",
    "sha256": "SHA256_OF_THE_REVIEWED_BILLING_EVIDENCE"
  }
}
```

For a verified zero, set `verifiedAmountUsd` to `"0"` and evidence kind to
`"provider-confirmed-no-charge"`, with the positive provider confirmation as the
evidence. Do not include API credentials or entire billing documents in the JSON.

```sh
sudo -- /usr/bin/node /opt/luma/releases/RELEASE/dist/src/app/ai-accounting-maintenance.js prepare /var/lib/luma/pglite /etc/luma/accounting-operators.json /var/lib/luma-accounting/charge.json /var/lib/luma-accounting/prepared-charge.json
```

Preparation persists the exact immutable request, original accounting facts,
operator, evidence reference, amount and digest. It changes no charge or hold.
Live reservations are rejected; an expired reservation can be reconciled after
the owning process has cleanly stopped. Stale facts and a mismatched workspace
are rejected. Review the prepared output before authorizing application.

## Apply the reviewed preparation

Create a separate private approval file using only the returned preparation ID
and digest after reviewing the entire preparation:

```json
{
  "preparationId": "EXACT_PREPARATION_UUID",
  "digest": "EXACT_64_CHARACTER_PREPARATION_DIGEST",
  "reviewed": true
}
```

```sh
sudo -- /usr/bin/node /opt/luma/releases/RELEASE/dist/src/app/ai-accounting-maintenance.js apply /var/lib/luma/pglite /etc/luma/accounting-operators.json /var/lib/luma-accounting/approval-charge.json /var/lib/luma-accounting/applied-charge.json
```

The charge and its append-only audit commit in the same transaction. Original
estimates, provider facts and prior state remain in the preparation and audit.
Repeating the same approval returns the same audit; it cannot charge twice.
If a charge needs a later correction, inspect again and prepare a new reviewed
charge. The correction appends another audit and retains its predecessor.
The original workflow remains fenced from paid retry even after a verified zero.

If a command fails or output is lost, inspect again. An incomplete output file
is not a successful receipt. Use a fresh output filename to retry the same
approval. Changed request facts or intervening accounting decisions invalidate
the preparation; inspect and prepare a new review instead of editing its digest.

## Review resuming paid AI separately

Settling a charge does not clear the workspace block. Resolve every flagged
blocking request and confirm the configured model/tier/pricing problem has been
corrected. Unrelated unknown charges may remain; they continue counting against
the cap and their workflows cannot be retried.

Create an unblock request with `kind: "unblock"`, the workspace ID, a reason
describing the completed review, and the supporting evidence reference/hash
(the same evidence object shape as above). Run `prepare`, inspect its output,
then create and apply a separate approval exactly as for a charge.
Preparation/application reject unresolved blockers or live reservations. Any
intervening accounting decision or newly reported blocker invalidates an older
unblock preparation. Legacy workspace holds conservatively mark all unresolved
requests as blockers during migration.

The example maintenance commands run as root and can create root-owned Postgres
files and the clean-close receipt. After every maintenance command has finished
successfully and the adjacent ownership lease is absent, restore the stopped
store's ownership to its existing service account before backup or restart:

```sh
sudo chown -R luma:luma /var/lib/luma/pglite
```

Use only the verified store path and its established account; do not change
ownership of release code, private review files or another service's directory.
If maintenance failed uncleanly or a lease remains, follow the recovery runbook
instead of changing ownership to bypass it.

Take and verify a new cold backup, retaining the audit and preparation tables,
then start the service and inspect `/meeting usage`. Neither a reconciliation
nor an unblock relaxes price validation or budget admission. If the provider
again returns an unverified model or tier, the workspace will stop paid dispatch
again until that new discrepancy is reviewed.

```sh
sudo systemctl start luma.service
sudo systemctl status luma.service --no-pager
```
