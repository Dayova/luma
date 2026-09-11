# Production Discord runtime

This package runs one founders-only Discord service on an always-on Linux host
with systemd and persistent local storage. It does not provision a host, pay for
hosting, create a production Discord application, or prove that Luma is live.
The runtime includes Discord Meeting analysis and bounded Context Ask, with
optional governed retrieval from explicitly shared Notion pages, Linear work,
and GitHub code. This is not the complete agreed Luma product: Granola,
multi-capture synthesis, cross-Meeting recall, polls, and native review still
have separate acceptance work. The isolated Notion observer stays dormant.

## Runtime and ownership

Use Node.js 24 at `/usr/bin/node`, pnpm 11.12.0 for building, and `flock` from
util-linux at `/usr/bin/flock`. Pin the exact application commit for each release.
The application opens outbound Discord/OpenAI connections; this service needs
no inbound listener, public domain, or TLS endpoint. It has no HTTP readiness
endpoint. Do not configure a hosting HTTP health check against an invented port.
The optional operations profile uses a private local Gateway-health receipt and
an independent systemd timer instead; see
[unattended operations](unattended-operations.md) for daily encrypted off-host
backup verification, failure alerts, and external host-loss monitoring.

`/opt/luma/releases/<commit>` holds immutable application releases;
`/opt/luma/current` selects one release. `/var/lib/luma/pglite` holds the durable
PGlite database and `/etc/luma/production.env` holds secrets outside releases.
`DATABASE_URL` does not select a production PostgreSQL adapter. Use a persistent
local disk, one service process, and one host owner. No autoscaling, overlapping
rolling deployments, second observer of the same source, or shared-volume
replicas. The systemd launcher also holds `/var/lib/luma/runtime.lock` for its
entire lifetime. Never invoke `pnpm start` separately against this live store.

Full-store maintenance adds its own owner lease and restored-store quarantine.
The release must include those protections and a successful isolated restore
proof before it stores production history. Follow the
[full-store maintenance runbook](backup-restore.md) for the exact backup,
verification, and restoration commands.

## Prepare the host and release

Install Node.js 24, Corepack/pnpm 11.12.0, git, and util-linux through the host's
trusted package/vendor process. Check their actual versions and absolute paths.
Build as an ordinary deployment user in a fresh checkout of the reviewed exact
commit; do not build as the service user in its data directory or copy a laptop
`.env` into the checkout.

```sh
node --version
pnpm --version
git status --short
git rev-parse HEAD
pnpm install --frozen-lockfile
pnpm verify
pnpm build
```

`pnpm verify` must have passed for the combined release. The TypeScript build
creates `dist/src/app/production-main.js`. Keep the matching `node_modules`,
`package.json`, `pnpm-lock.yaml`, `dist`, and `deploy` content together; pnpm's
internal dependency symlinks must remain intact. Copy the complete prepared
checkout, excluding `.git`, `.env*`, `.luma`, and other local credentials, into a
new release directory. Never update an installed release in place. Record the
40-character commit in `<release>/REVISION`. Make the installed release and its
parents root-owned and unwritable by `luma`.

For a fresh host, run these administrative setup commands once:

```sh
sudo useradd --system --home-dir /var/lib/luma --shell /usr/sbin/nologin luma
sudo install -d -o root -g root -m 0755 /opt/luma/releases /etc/luma
sudo install -d -o luma -g luma -m 0700 /var/lib/luma
```

If the user already exists, inspect that dedicated account instead of recreating
it. Store any off-host backups in an access-controlled location outside the
service's writable data disk. Hosting and backup storage are outside the USD 30
AI budget and require an actual selected host/account.

## Configure the production identity and source scope

Start with `deploy/production.env.example`. Enter production secrets directly
into the host's protected secret store/file, not a chat, command argument, shell
history, service unit, or repository. Install the completed environment file as
`root:root`, mode `0600`. systemd reads it before dropping privileges; the service
does not need permission to read the file itself. Keep `/etc/luma` traversable so
the launcher can inspect its metadata. The environment file is data, never a
shell script: do not `source` it or enable shell tracing. Use only literal,
unquoted `KEY=value` lines, blank lines, and whole-line `#` comments. Values must
not contain whitespace, quotes, backslashes, `#`, `$`, or backticks; no multiline
values, interpolation, `export`, inline comments, or duplicate keys. The preflight
enforces this common Node/systemd parser subset. Current Discord/OpenAI tokens
fit this format; do not escape an incompatible future value silently.

Before first activation, verify these existing product requirements:

- Use a separate production Discord application and token. The launcher rejects
  the known development application and verifies that the token belongs to the
  configured application before registering commands or connecting the Gateway.
- Enable **Server Members Intent** under **Bot > Privileged Gateway Intents** on
  that application and obtain Discord's approval where required. Startup checks
  this approval even with Context Ask disabled. No environment flag bypasses it.
- Match the configured guild and all four founder identities. Review actual
  human readers, including Team/Admin role holders, for each allowed parent.
  `allgemein`, `gäste`, and `team-off-topic` are absent from the initial scope.
  Luma verifies fresh owner, administrator, role, and channel-overwrite permissions
  against a complete API member list. The current proof supports at most 999
  members including bots; a full 1,000-member page, incomplete data, or an API
  failure blocks channel work and publication rather than using cached readers.
  Private threads are unsupported. See
  [current reader verification](../integrations/discord.md#current-reader-verification).
- Give the production bot only the channel permissions needed for the approved
  surface: View Channel, Read Message History, Send Messages, Create Public
  Threads, and Send Messages in Threads. Administrator is unnecessary. The
  development bot's current role grants do not give it private team-channel
  access and are not evidence of the production bot's access.
- For Context Ask, complete participant notice and source participation approval,
  additionally enable Message Content intent on the production application, then set
  `LUMA_DISCORD_CONTEXT_ASK_ENABLED=1`. Only explicit founder invocations in public
  threads under configured private parents are eligible. Channel names are
  descriptive; IDs are configurable and must be reviewed when scope changes.
- Configure the production OpenAI key and the shared USD 30 Europe/Berlin monthly
  cap. Set that cap to `0` to pause paid AI while retaining notes and non-AI status;
  the launcher accepts only the approved range `0` through `30`.
  No separate observer process may create another independent spending
  ledger for that same budget. Usage records are estimates based on actual token
  reporting; reconcile with the provider bill.

The template contains empty dedicated read-only organizational credential
fields; collection remains disabled. To activate it, configure the
[organizational sharing policy and catalogs](../configuration/organizational-context.md).
Install the policy as `root:luma`, mode `0640`, so the service can read it without
being able to modify it. Provider source readability and permission for the full
four-founder audience are separate requirements. Notion/Linear writer and
personal capture credentials are not implied by this configuration. Do not
inject observer/native-review variables into this service. The launcher
intentionally rejects that mixed topology.

Run the offline preflight against the installed release:

```sh
sudo /usr/bin/node /opt/luma/releases/<commit>/dist/src/app/production-main.js \
  --check-env-file /etc/luma/production.env
```

It checks configuration without opening a database, calling providers, changing
Discord, or making an AI request. Passing it does not prove credentials, live
permissions, a restore, or production readiness. Runtime startup additionally
performs the read-only Discord application check. Errors print controlled
messages and never configuration values or raw provider errors.

## Install and activate

Install the reviewed unit and select the prepared release while the service is
stopped. Replace `<commit>` with the verified literal release commit in these
commands; do not run the angle-bracket placeholders as shell syntax.

```sh
sudo systemctl stop luma.service
sudo systemctl is-active luma.service
sudo install -o root -g root -m 0644 /opt/luma/releases/<commit>/deploy/luma.service \
  /etc/systemd/system/luma.service
sudo ln -s /opt/luma/releases/<commit> /opt/luma/current.next
sudo mv -Tf /opt/luma/current.next /opt/luma/current
sudo systemctl daemon-reload
sudo systemctl enable --now luma.service
sudo systemctl status luma.service --no-pager
sudo journalctl -u luma.service --since '5 minutes ago' --no-pager
```

The first `stop`/`is-active` may report an absent unit on a fresh host; establish
that no older Luma process owns the intended data directory before continuing.
For an existing service, `is-active` must report `inactive` before switching.
Do not run the sequence blindly past a failed stop. If `current.next` already
exists, inspect and resolve that previous deployment attempt before proceeding.

`Type=simple` means systemd's `active` state initially proves process creation,
not a ready Discord connection. Look for the application's production connection
message, then run the live checks below. No readiness or external uptime monitor
is installed by this package. Set the chosen host's process-failure alert to
Jakob when the host is provisioned; validate one alert deliberately. The service
restarts failed processes with a delay and stops retrying after five failures
within five minutes. Investigate failures before `systemctl reset-failed luma`.

## Prove the limited release

Use an explicitly approved test thread and founder actor. Establish all of:

- A Meeting command and, when enabled, `@Luma` Context Ask produce a source-bound
  answer; `/meeting usage` remains useful without paying for another AI call.
- A nonfounder and an excluded channel cannot access retained Meeting state.
  These checks must not publish private history into a broader channel.
- The failure/status cases for exhausted budget and unavailable AI have already
  passed deterministic release tests. Do not consume USD 30 just to exhaust the
  real provider account. Verify the live status surface and configuration.
- A supervised restart preserves the Meeting, approved judgments, usage state,
  and follow-up receipts. Run a full backup and an isolated restore verification
  before calling the production persistence gate complete.

Record exact release, channel scope, runtime start/stop, restore result, and live
smoke-test outcome. Never include tokens or captured conversation bodies in the
deployment record. The service can report AI failures while alive; if the host
or Gateway is unavailable, a separate host alert is required.

## Update and rollback

Build and validate the next exact release separately. Run its offline preflight.
Stop the service explicitly, verify it is inactive, and use the full-store
maintenance commands to make and verify a fresh backup. A deliberate
`systemctl stop` suppresses the unit's automatic restart for this maintenance
window. Do not take a file copy while the store is live or clear an ownership
lease merely because a process does not appear in one PID listing.

Switch `current` atomically while stopped, then start and repeat the startup and
live checks. Preserve both release directories and the data directory.
Application rollback follows the same stop/switch/start sequence and keeps the
existing datastore **only when the older release is compatible with its current
schema and durable state**. Migrations run at startup; never assume an arbitrary
older commit is compatible. Prefer a forward fix when compatibility is unproven.

A database restoration is a separate recovery procedure, not a rollback shortcut.
Never reset, delete, overwrite, or replace the live store to make a binary start.
Restore only into a fresh quarantined directory, verify it offline, fence the old
owner, and reconcile external mutation outcomes before any deliberate activation.
Restoring an older copy without reconciliation can replay already-completed
external operations. Keep the original stopped store until recovery is proven.
