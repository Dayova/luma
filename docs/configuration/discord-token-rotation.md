# Discord credential rotation

Use this runbook before the first live rollout of a Discord Application. A
Discord token is a bearer credential: anyone holding it can act as that bot.

This procedure deliberately records no token value, token fragment, token hash,
request header, or secret-store screenshot. It belongs in the live-rollout
checklist, not in an issue comment or chat transcript.

## Emergency response

If a token appears, or may have appeared, in chat, an issue, a page, a log, a
screen recording, or any other unapproved location, do not wait for a rollout
window. Immediately stop or disable every consumer of that credential, reset
the token in the Discord Developer Portal, and replace it only in approved
secret storage. Keep the bot disabled until the replacement has passed the
safe deployment and close-out steps below. A reset invalidates the old token;
never test or try to restore it.

The planned-window procedure below applies only when there is no suspected
exposure—for example, rotating an unpublished local development credential
before it is used for a first live rollout.

## Release gate

Do not enable a live Discord rollout until all of the following are true:

- The current token was generated during the approved rollout window or after
  the most recent suspected exposure.
- It exists only in the deployment secret store or the intended ignored local
  environment file; it is absent from Git, GitHub, Linear, logs, screenshots,
  and copied command history.
- The prior token has been invalidated by Discord's reset operation.
- An authenticated bot start was verified in the intended environment.
- The operator recorded non-secret proof on the rollout ticket: UTC start and
  finish, environment/deployment identifier, Discord Application identifier,
  and pass/fail result.
- GitHub secret-scanning and Dependabot security controls were checked, and a
  non-secret repository-history/alert audit found no credential exposure.

Keep development and production Applications—and their tokens—separate. Do not
rotate a working development token merely because a future production rollout
is planned; rotate the credential for the environment that will be enabled.

## Preconditions

1. For a planned rotation, open an approved rollout window and identify the
   exact Discord Application and target environment. Confirm that the operator
   may reset that Application's bot token in the Discord Developer Portal.
2. Confirm the secret-storage destination is available before resetting the
   token. For local development this is an ignored `.env`; for a deployment it
   is that deployment's approved secret store.
3. Stop or drain the current bot process if it uses the credential being
   replaced. A reset invalidates the old token immediately; there is no safe
   rollback to it.
4. Prepare the non-secret rollout record on the tracking ticket. Do not paste
   a credential into the ticket while preparing it.

## Rotate and deploy

1. In the Discord Developer Portal, open the intended Application, choose
   **Bot**, and reset the token. Treat the newly displayed value as secret
   material from the moment it appears.
2. Put the new value directly into only the approved secret destination as
   `DISCORD_TOKEN`. A production deployment must inject that secret into its
   process; an ignored `.env` is for local development only. Do not place the
   value in a shell command, commit, issue, pull request, document, terminal
   capture, or chat.
3. Restart the intended bot deployment. The startup configuration must include
   the matching `DISCORD_CLIENT_ID` and `DISCORD_GUILD_ID`; Luma fails closed
   when that credential group is incomplete.
4. Verify the expected authenticated connection in the approved environment.
   If the deployment starts the Luma server, be aware that normal startup also
   registers guild commands. Perform that validation only in the approved
   target guild and record the result without copying logs that might contain
   sensitive configuration.
5. Confirm the old credential cannot be used by relying on Discord's reset
   invalidation. Never retain or test the old token after reset.

## Failure handling

If the new token cannot authenticate or the deployment fails:

1. Keep the affected bot stopped or disabled.
2. Diagnose only from non-secret configuration names and provider error codes;
   never print the environment or request headers.
3. If another credential is needed, reset again and repeat this runbook with
   the newly generated token. Do not attempt to restore the invalidated token.
4. Leave the rollout ticket open and mark the validation failed. Do not enable
   live user traffic until a fresh rotation and successful validation are
   recorded.

## Close-out proof

Before closing the rollout blocker, attach or comment only the following
non-secret facts:

- operator and UTC timestamps;
- Discord Application ID and deployment/environment identifier;
- confirmation that the previous token was reset and the replacement is in the
  approved secret store;
- authenticated-start result and any safe, minimal smoke-check result;
- GitHub secret-scanning and Dependabot status, plus the reviewer who checked
  them;
- the result of a non-secret repository-history/alert audit. Use GitHub's
  security alerts and tracked-file/ignore-policy review; never pass a token to
  a command, search tool, or log while performing this audit.

Do not include a token value, partial value, QR code, screenshot of the token,
or hash/fingerprint that could help correlate or recover it.
