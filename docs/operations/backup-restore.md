# Full-store cold backup and isolated restore

Luma retains approved knowledge and source history by default. Backups do not
expire or purge data because it is old. This runbook backs up the entire PGlite
directory, including unknown future tables, source revisions, Evidence, Human
Judgments, execution reservations and receipts, prepared Operational Outcomes,
source fences, identity bindings, Context Ask receipts, and AI accounting.
Provider credentials and the separate production environment file are not part
of the database backup. Recover those through the production secret store.

## Supported ownership boundary

Use a local filesystem volume with **one Luma process on one host**. Do not mount
the store in a second application, worker, replica, sidecar, or network/shared
filesystem. Every database open must go through Luma's ownership-aware database
factory. A legacy binary or direct PGlite opener does not participate in the
protocol. Before deploying this version over a legacy store, stop all old
processes, disable automatic restarts, and establish exclusive volume ownership.

The database factory and maintenance commands acquire the same atomic adjacent
`<canonical-store-path>.luma-owner` directory. The lease never expires or gets
stolen based on a PID, a timeout, or a process scan. A successful PGlite close
writes `.luma-clean-close.json` inside the store and then releases the lease.
Opening the database removes that receipt before Postgres starts. Cold backup
requires both exclusive ownership and the clean-close receipt. A process crash,
failed shutdown, unmanaged/legacy store, or active owner therefore blocks backup.

A service-manager restart alone cannot clear a lease left by an unclean crash.
Do not delete a lease because a PID looks absent. If an abnormal shutdown leaves
a lease, fence the original host/service and its automatic restarts; detach the
volume from all other consumers. Preserve an immutable copy of that entire volume
before deliberate recovery. An operator must establish that no former process
can access the volume, then recover Postgres on a private copy and close it
successfully using the current factory. Do not fabricate a clean-close receipt.
The [unattended operations package](unattended-operations.md) supplies daily cold
backup scheduling, verified encrypted off-host delivery, health alerts, and an
explicit quarantined crash-image rehearsal. It never clears the original lease
or performs automatic crash promotion or failover.

## Cold backup

1. Record the current release's complete Git commit ID and the absolute durable
   store path. Use that release's already-built, immutable installation with its
   locked dependency versions. Build it as the deployment user before installing
   the release; the service account must not build or modify installed code.
2. Stop the application through its service manager and wait for graceful shutdown
   to finish. Disable any timer, orchestrator, or restart policy that can reopen
   the volume during the maintenance window. Keep the volume attached only to the
   stopped service's host. Application-level execution reservations may remain
   unresolved; preserve them rather than clearing them.
3. An administrator first prepares the private destination parents once. If a
   parent already exists, inspect its owner and contents before changing it;
   never change another service's directory ownership.

```sh
sudo install -d -o luma -g luma -m 0700 /var/backups/luma /var/lib/luma-rehearsal
```

Run the command as the service account, using a **fresh**, private destination
outside the database directory. Never load the production `.env` for these
commands. The entrypoint imports no application server or live provider.

```sh
sudo -u luma env -i PATH=/usr/bin:/bin /usr/bin/node /opt/luma/releases/FULL_40_CHARACTER_COMMIT_ID/dist/src/app/store-maintenance.js backup /var/lib/luma/pglite /var/backups/luma/RELEASE-TIMESTAMP FULL_40_CHARACTER_COMMIT_ID
sudo -u luma env -i PATH=/usr/bin:/bin /usr/bin/node /opt/luma/releases/FULL_40_CHARACTER_COMMIT_ID/dist/src/app/store-maintenance.js verify-backup /var/backups/luma/RELEASE-TIMESTAMP
```

Substitute the actual release ID and timestamp; placeholders are not valid
arguments. Existing or nested destinations are rejected. Symlinks, shared hard
links, and special files inside the store are rejected. Copies include all files
and directories, and SHA-256 plus byte counts are verified before completion.
`manifest.json` records the format, application revision, source path, Node
version, and complete inventory. `manifest.sha256` detects an accidentally
changed manifest. These hashes detect corruption; they are not a cryptographic
signature against someone who can rewrite both the data and manifest.

These commands use the absolute immutable release path and a cleared environment;
they never read `/etc/luma/production.env`. They run outside the application's
systemd sandbox, whose writable scope intentionally excludes backup storage.

An incomplete command is not a valid backup. Keep its failure output and choose a
new destination after resolving the cause. Do not overwrite an existing artifact.
A successful command releases its lease; the application can then resume on the
original store after the operator restores the service's normal policy.

4. Copy the completed private backup to durable off-host storage under Dayova's
   access controls and encryption policy; verify it again after transfer. Local
   copies alone do not protect against losing the host or volume. This tool does
   not provision storage or upload company data automatically.
5. Record the backup ID, release revision, storage location, verification result,
   and operator in the release record. Never include source text or secrets.

## Isolated restore rehearsal

Use the same application revision and dependency lock as the backup first. A
newer version may require a separate migration rehearsal. Choose a fresh directory
outside both the source store and backup artifact. Run in an isolated environment
with no provider credentials and no outbound network access. Do not start Luma's
application server or point its service at this directory.

```sh
sudo -u luma env -i PATH=/usr/bin:/bin /usr/bin/node /opt/luma/releases/FULL_40_CHARACTER_COMMIT_ID/dist/src/app/store-maintenance.js restore /var/backups/luma/RELEASE-TIMESTAMP /var/lib/luma-rehearsal/RESTORE-TIMESTAMP
sudo -u luma env -i PATH=/usr/bin:/bin /usr/bin/node /opt/luma/releases/FULL_40_CHARACTER_COMMIT_ID/dist/src/app/store-maintenance.js verify-restore /var/lib/luma-rehearsal/RESTORE-TIMESTAMP
```

Restore verifies every manifest entry and rejects missing, additional, or changed
payload files before restoring. It refuses an existing destination. It writes a
quarantine marker before copying, verifies the copied bytes, and leaves that
marker in place. Normal application startup refuses a quarantined store. There
is intentionally no environment variable or maintenance flag to enable live
providers or remove quarantine.

`verify-restore` opens only the quarantined copy. It runs no migrations, loads no
provider configuration, polls no source, starts no Discord connection, and executes
no Follow-up. It reads and serializes every row of every public table inside embedded Postgres
(including out-of-line values), and reports only table names/counts without source
contents. Check those counts and the
backup manifest against the release record. Counts alone do not prove business
correctness: the automated behavioral rehearsal additionally demonstrates retained
source revisions and Human Judgment, intact prepared execution/billing state, and
that retrying completed work does not create it a second time.

Recheck the immutable backup with `verify-backup` after the rehearsal. Opening the
restore copy naturally changes its Postgres files; the archive remains immutable.
Record the readable-table result and behavioral test result with the backup ID.

## A real recovery is a separate controlled cutover

Do not promote a rehearsal while the original service can write or reconnect.
Fence the original instance, stop all automatic restarts, preserve both original
and restored copies, and review external writes and AI charges since the backup.
A backup cannot know about provider mutations completed after its capture. The
restored ledger can prevent repeats only for receipts it actually contains.
Reconcile later or indeterminate writes through positive provider evidence and
explicit recovery; never reset reservations, source fences, or prepared digests
just to make the application start. Unknown AI charges remain held.

After that reconciliation, a controlled cutover can remove quarantine from the
selected recovery copy while it remains offline, restore production secrets from
the secret store, verify founder identities/channel audience, and assign that
volume to exactly one current runtime. Keep the old instance fenced. This manual
promotion is not part of the rehearsal CLI and requires a recorded operational
recovery decision. Take and verify a new cold backup after a successful recovery.
