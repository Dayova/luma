# Unattended single-VPS operations

On stop, Luma immediately refuses new Discord work and cancels scheduled source
ingestion. It waits for admitted commands, Context Ask requests, final source and
audience checks, replies, and active ingestion before closing the store. A
90-second drain failure exits unsuccessfully without a clean-close receipt or
lease removal; the 120-second systemd hard stop remains the final bound. Do not
clear the lease to make a scheduled backup proceed. Follow the crash-recovery
procedure instead. An AI provider response received after its request timeout
does not perform detached accounting writes; its possible charge stays held for
explicit reconciliation.

The repository includes a daily cold-backup job and an independent health timer.
They are deployment artifacts; adding them to Git does not install or activate
them. This profile uses the documented Linux systemd layout, one PGlite owner,
Node.js 24, util-linux `flock`, and restic at `/usr/bin/restic`. Install a reviewed
restic release through the host's trusted package process and record its version
in the host acceptance record. The implementation follows restic's documented
[backup](https://restic.readthedocs.io/en/stable/040_backup.html),
[restore](https://restic.readthedocs.io/en/stable/050_restore.html), and
[JSON scripting](https://restic.readthedocs.io/en/stable/075_scripting.html) interfaces.

## What happens automatically after activation

At 03:30 Europe/Berlin each day, with up to five minutes of scheduling jitter,
`luma-backup.service` records that Luma was running, stops it gracefully, and
takes the existing complete cold backup under the same kernel lock as the
runtime. The cold-backup command independently requires the clean-close receipt
and exclusive store lease. The job restarts Luma before uploading anything.
There is a short planned Discord outage while the cold copy is made; a single
embedded store cannot take this cold backup while it is open. Measure that
pause on the selected host during acceptance.

The archive uses an encrypted restic repository in a separately hosted
S3-compatible bucket. A unique backup UUID binds the snapshot. The job downloads
that exact snapshot to a fresh directory, verifies every manifest hash and byte
count against the local original, makes a quarantined restore, and opens and
serializes every public Postgres table with no live providers or migrations.
The cold copy also contains a private `recovery/` bundle: exact
`/etc/luma/production.env`, every referenced Decision authority and context sharing
policy, the protected `LUMA_STRUCTURED_WORK_TARGETS_PATH` mapping, and the separately
configured 32-byte Granola credential key. Runtime Decision, synthesis and Structured
Work signing keys remain in the exact environment copy. Only these explicit file
selectors are followed; arbitrary paths mentioned in source material are never read.
Backup and restored bundle files use mode `0600` inside mode-`0700` directories;
source files retain their existing permissions. Referenced source files must be
owned by root or the fixed `luma` service account; the operations adapter resolves
that account locally. The environment copy still comes from root-owned
`/etc/luma/production.env`. Unprotected inputs, symlinks,
shared hard links, invalid sizes, missing referenced files and concurrent changes
are refused. The operations `check` validates these inputs without opening a store.

The recovery manifest binds the backup UUID, workspace, original file paths,
lengths and hashes. A randomly salted, memory-hard scrypt derivation from the
protected repository password file authenticates it with HMAC-SHA256. Keep the
original password file bytes in independent recovery custody, including when
rotating repository credentials; the password is never included in the bundle.
Restic encrypts the entire bundle off host. Source files and their private copies
are never put into subprocess arguments, runtime environment variables for a
child process, health messages or logs.

After the exact download comparison, the verifier establishes the matching
quarantine marker before acquiring a restore lease, then decrypts every retained
Granola credential using the restored key and its original workspace/founder
authenticated data. This is a local proof: no OAuth, refresh, personal source,
Discord or AI call occurs. A retained credential still requires its original key
when OAuth is disabled. Retained Decision write stages, synthesis publications and
Structured Work requests also require their signing key and policy/mapping files,
even when their native feature is disabled. Missing/wrong keys, corrupted
credentials or altered downloaded material fail the backup without advancing its
verified receipt. The original store and its ownership metadata are untouched.
Only after all of this succeeds does it advance
`/var/lib/luma-operations/verified-backup.json`. Backup age uses capture time,
so slowly verifying an old backup cannot make it current.

Successful temporary download/rehearsal copies and that job's local cold copy
are removed after verification. The encrypted remote snapshots and canonical
knowledge/history remain retained. No remote `forget`, `prune`, expiry, or automatic
reservation clearing occurs. Before the next backup stops the service, it keeps
the newest failed local `cold-<UUID>` attempt for inspection and removes older
managed cold copies. The new attempt may add one more copy if it fails. Symlinks,
ordinary files and unrelated directories are untouched.

The service manager runs resume cleanup on failures and interruption. Cleanup
starts only a service for which the job created a durable resume marker. An
intentionally stopped service is not started by the timer. A stale cooperative
lease is never deleted: if a process crashed during store work, restart remains
blocked and needs the recovery procedure below. The cleanup is a best-effort
restart; the independent monitor establishes actual health.

Every two minutes, `luma-health.service` checks:

- A private local health receipt, at most 90 seconds old, from systemd's actual
  runtime PID. The running app updates it every 15 seconds, using the Discord
  client's current Gateway readiness rather than process existence alone.
- A verified off-host backup captured within 36 hours, with sensible timestamps.
- The last backup unit's failure result, so a failed daily attempt is reported
  promptly even while yesterday's verified backup is still within its age limit.
- At least 2 GiB free on both the runtime and backup verification filesystems.

A protected resume marker plus a currently running backup unit grants at most
one hour of planned maintenance grace for the runtime check, matching the backup
service's full stop/copy/verify/resume timeout. The backup age
and free-space checks still apply. A stale marker or a failed backup process
does not suppress an outage.

Failures and recovery send fixed operational messages to a configured Discord
webhook, with all mentions disabled and no source data, provider errors, paths,
or credentials. Unchanged failures are silent for six hours before a reminder.
Failed delivery is retried at the next check; the state is not advanced first.
Before every notification, including recovery, raw Discord REST reads verify the
actual webhook ID/server/channel, the bot token's production application, and
the current complete channel audience. This uses the same two-snapshot founder
identity and effective-permission proof as content replies. The destination
must be a text parent within `LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS`; channel
names and webhook URLs do not establish audience. The webhook binding is read
again and permissions rechecked just before sending. Changed bindings, guests
with access (including administrators), ambiguous identities, incomplete member
lists, unavailable credentials, and API failures all block the alert without
marking it delivered. Discord cannot make separate permission reads and posting
one atomic action; no stale positive proof is cached between notifications.
The binding comes from Discord's documented
[webhook-with-token read](https://docs.discord.com/developers/resources/webhook#get-webhook-with-token);
`wait=true` requests server confirmation for the eventual post.
These notifications use a separate webhook so they still work when the bot's
Gateway is down, using the protected production token only for REST audience
verification. There is no second Gateway connection. A Discord REST outage or
lost read permission also prevents the webhook alert; the independent external
monitor remains the fallback.

Healthy checks also ping a private endpoint on an independent monitoring
service. Configure that service to alert the founders through an independent
delivery route after a missing heartbeat (suggested interval two minutes,
grace five minutes). This external monitor detects a dead VPS, stopped timer,
broken configuration, or inability to send alerts; a process on the VPS cannot
report that its entire host has disappeared. Verify this route before launch.

## Protected configuration and activation

The host, off-host storage location/account, and external heartbeat service must
be selected and accessible before activation. Their charges are outside the
USD 30 AI cap. A URL in configuration does not itself prove a different
physical failure domain. Review the actual bucket location, access controls,
encryption recovery, storage costs, and heartbeat notification recipients.

Create these new private directories as root; inspect an existing path before
changing anything. This profile uses a separate directory from the older manual
`/var/backups/luma` runbook, so its ownership is left alone.

```sh
sudo install -d -o root -g root -m 0700 /var/lib/luma-operations /var/backups/luma-operations
```

Install a completed `deploy/operations.example.json` as
`/etc/luma/operations.json`, root-owned mode `0600`. All inputs must be regular,
single-link files; symlinked inputs are rejected. Enter secrets privately in the
host's secret store, never a shell argument, repository, or chat. The JSON file
selects:

- `resticRepository`: `s3:https://STORAGE_ENDPOINT/BUCKET/luma`. Local repositories
  and loopback endpoints are refused. This version deliberately supports only
  S3-compatible off-host storage.
- `resticPasswordFile`: an absolute root-owned mode-0600 file with a unique
  repository password. Store a recovery copy outside this VPS. Losing it makes
  the encrypted backups unrecoverable.
- `s3CredentialsFile`: a root-owned mode-0600 JSON file containing
  `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, optionally `AWS_SESSION_TOKEN`
  and `AWS_DEFAULT_REGION`. Use dedicated bucket-scoped credentials; arrange
  renewal if the chosen credentials expire. The runner passes only these
  credentials and the repository/password-file settings to restic.
- `alertWebhookUrl`: the Discord webhook created in the reviewed founder-only
  operations destination, which must be an allowed runtime text parent. Its URL
  is a credential. No webhook or message is
  created by this code before activation.
- `healthyHeartbeatUrl`: the private HTTPS success endpoint issued by the
  external monitor. It receives an empty GET with no runtime or source details.

Initialize the empty encrypted repository once using restic's setup process,
with protected environment/file inputs. The recurring job does not initialize,
repair, unlock, forget, or prune a repository on its own. Repository lock or
credential failures preserve the last successful receipt.

The runtime environment must use these exact paths for this operations profile:
`LUMA_PGLITE_DATA_DIR=/var/lib/luma/pglite` and
`LUMA_RUNTIME_HEALTH_PATH=/var/lib/luma/runtime-health.json`.
The operations preflight checks the root-owned production file but never loads
its credentials into subprocesses. Alert delivery uses that protected file's
production bot token, application/server IDs, and current founder identity
mappings for fresh REST verification; none are printed. The release symlink must resolve to
`/opt/luma/releases/<40-character-commit>`, whose `REVISION` file matches it.

Run the offline check first:

```sh
sudo /usr/bin/node /opt/luma/current/dist/src/app/operations-main.js check
```

It validates local configuration, referenced recovery material and secret-file protection, without contacting
storage, Discord, or the heartbeat service. It does not prove credentials work.
Install the four reviewed units before the first manually triggered real
backup. The following commands are host activation steps, not development
verification; execute them only on the selected configured production host.

```sh
sudo install -o root -g root -m 0644 /opt/luma/current/deploy/luma-backup.service /opt/luma/current/deploy/luma-backup.timer /opt/luma/current/deploy/luma-health.service /opt/luma/current/deploy/luma-health.timer /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/luma.service /etc/systemd/system/luma-backup.service /etc/systemd/system/luma-health.service /etc/systemd/system/luma-backup.timer /etc/systemd/system/luma-health.timer
sudo systemctl daemon-reload
sudo systemctl start luma-backup.service
sudo systemctl start luma-health.service
```

Verify the private backup receipt, the remote snapshot, resumed Gateway health,
and the external monitor's accepted heartbeat. Exercise an actual missing-ping
alert and recovery. Record backup UUID, release, restic version, snapshot ID,
capture/verification time, service outage duration, and operator. No source text
or secrets belong in that record. Only then enable recurring timers:

```sh
sudo systemctl enable --now luma-backup.timer luma-health.timer
sudo systemctl list-timers luma-backup.timer luma-health.timer
```

Before a deliberate extended maintenance window, stop the timers and pause the
external monitor with a bounded maintenance window. Resume and verify them
afterward. Never alter the runtime release symlink during a backup or recovery
job. Failed backup artifacts can consume space; inspect them after the alert
and preserve useful recovery evidence before deleting only redundant copies.
Plan disk capacity for the live store plus a cold backup, downloaded backup,
and isolated restore at once.

## Unclean crash rehearsal

A crashed owner can leave both uncertain external outcomes and an unreleased
lease. The runtime and scheduler refuse to steal that lease. An authorized
founder must fence the original owner, disable all automatic starts, and
establish that the old process cannot access the volume. A missing PID or old
timestamp is not sufficient. Preserve a complete immutable offline image of
that volume, including adjacent ownership metadata, before further work.

The `crash-rehearsal-main.js` command works on a separate private image under
`/var/lib/luma-crash-images`, never on the original runtime store. Prepare that
root-owned mode-0700 directory and copy the fenced image there using the host's
volume-copy procedure. Keep the original lease and all original bytes intact.
Use the distinct-founder Unix-account policy from
[AI accounting recovery](ai-accounting-recovery.md). Create a reviewed root-owned
mode-0600 JSON plan with this shape:

```json
{
  "fencedImageDir": "/var/lib/luma-crash-images/INCIDENT/pglite",
  "restoreDir": "/var/lib/luma-rehearsal/FRESH-INCIDENT-REHEARSAL",
  "applicationRevision": "FULL_40_CHARACTER_COMMIT_ID",
  "fencing": {
    "recordId": "INCIDENT_RECORD",
    "originalOwnerFenced": true,
    "automaticRestartsDisabled": true
  }
}
```

These booleans record an operator-established fact; the software cannot fence a
different host by inspecting a file. Invoke from that founder's own Unix account:

```sh
sudo /usr/bin/node /opt/luma/releases/FULL_40_CHARACTER_COMMIT_ID/dist/src/app/crash-rehearsal-main.js /etc/luma/accounting-operators.json /etc/luma/crash-rehearsal-plan.json
```

The command inventories the original image, copies it into a fresh quarantined
directory, checks every byte and that the image stayed unchanged, then lets
embedded Postgres recover and reads every public table. It reports the operator,
incident record, image digest, and table counts. Only a successful Postgres close
creates a clean-close receipt on the rehearsal copy. The original image and
original lease remain unchanged. A failed or partial rehearsal stays quarantined.
An image with a genuine clean-close receipt is also accepted, covering an
interrupted backup whose lease was left behind after the runtime had closed.
Its original receipt and lease are likewise preserved; the runtime still does
not automatically clear that lease.

This is a recovery rehearsal, not live promotion. It runs no migrations, provider
calls, Follow-ups, or accounting resets. Review unresolved external mutations
and AI charges through positive provider evidence before any separate controlled
cutover, as described in [backup and restore](backup-restore.md). Restoring an
older backup cannot know which writes occurred after its capture.

Automated tests kill a real isolated Postgres process with `SIGKILL`, recover its
committed records into quarantine, and prove the original lease, Human Judgment,
unknown external disposition, and held AI charge remain intact. This synthetic
test does not substitute for a crash/restore rehearsal on the actual host and
storage filesystem. No real host or source-owner migration has been performed.
