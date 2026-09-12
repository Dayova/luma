# Test Luma locally before deployment

No hosting purchase is needed to run Luma on your Mac. Choose the free offline
sandbox or the opt-in real-AI mode below. Deployment and paid hosting remain deferred.

## Start

Use Node.js 24+ and the repository's pnpm version:

```bash
pnpm install --frozen-lockfile
pnpm local
```

Open `http://127.0.0.1:58099`. Keep the terminal running. Ctrl+C closes the server and
discards its temporary database. Restarting begins with an empty sandbox.
Dependency installation may download packages; the running sandbox uses no
external service and has no paid mode or credential configuration.

The sandbox does not read `.env`, use an existing Luma database, register Discord
commands, or construct a live AI or external write adapter. Every fresh sample
gets a separate Meeting within the sandbox. Switching samples retains previous
sandbox records until exit; this ephemeral test data is separate from Luma's
production history-retention policy. All browser tabs share this local session.

## Keep the pages available on macOS

```bash
pnpm local:up
pnpm local:status
# When finished:
pnpm local:down
```

`local:up` builds and starts both pages through the current user's launchd session:
free offline mode at `http://127.0.0.1:58099` and real AI/Discord testing at
`http://127.0.0.1:59383`. Closing this chat, a browser tab, or the launching terminal
does not stop them. Stop with `local:down`. After logout or reboot, run `local:up`
again; these services are not installed to start automatically at login. They do
not keep the Mac awake, and a sleeping Mac cannot answer Discord messages.

Stop existing foreground servers before `local:up`. Ports are fixed and never
silently change. Running `local:up` again checks the existing services; it does not
restart them or change their keys. To apply code changes, use `local:down`, then
`local:up`. Logs and service definitions live in `~/.luma/local-services`.
A crashed service is deliberately not restarted automatically. Inspect the log,
preserve any store lease for recovery, then use down/up after recovery. Do not
delete a lease based on a missing PID alone.

## Five-minute walkthrough

1. Load **Jakob owns Luma · human correction**. Read the sample utterance and the
   proposed action. The AI proposal is prerecorded synthetic data.
2. Change the action owner or confirm it. Inspect the state and receipt.
3. Use **Run next step** to advance the labeled scenario. This fixture includes a
   Human correction to Jakob followed by a conflicting synthetic model proposal.
   Jakob's Human-confirmed ownership must survive that proposal.
4. Click **Replay last event**. The receipt should identify duplicate observations;
   actions should not multiply. Ask **My action items** and inspect the evidence.
5. Load **A tentative proposal**. Confirm or reject it and ask what was decided.
   Rejection must not erase the original evidence. Try an unrelated question:
   the bounded meeting interpreter must not invent an answer.
6. Load **Current versus historical decisions**, advance its steps, and compare
   the current decisions with **Decision history**. Superseded knowledge should
   remain available as history.
7. Click **Run offline checks**. Expand a scenario to compare each expectation
   with the observed result. Download the complete JSON report if useful.

Fixture dates are fixed and displayed with their Berlin timezone. They are not
relative to the day on which you open the sandbox. **Conclude meeting** invokes
the real conclusion operation; the full result appears in the operation receipt.
Confirming an item cannot execute external work in this sandbox.

## Real AI mode

```bash
pnpm local:ai
```

Open `http://127.0.0.1:59383`. Enter an OpenAI API key in the password field and
click **Use key for this session**. Connecting loads the key but makes no provider
request. **Analyze with real AI** sends your pasted text to the production OpenAI
ReasoningModel adapter; **Ask with real AI** uses real Context Intelligence and
the OpenAI ContextAnswerer. There are no synthetic AI responses in this mode.
The existing model is `gpt-5.6-luna`; unpriced model overrides are not accepted.

You can also explicitly export `LUMA_LOCAL_OPENAI_API_KEY` before starting. The
launcher does not load `.env`, the production store or existing Discord tokens.
The key remains in process memory and is omitted from logs, receipts, browser
storage and the database. Disconnect removes the session key. Re-enter it after
restarting. Do not put the key into a conversation, a tracked file or a shell
command saved in history. A key with access and usable API billing is required
for an actual provider response; this command does not buy credits.

Paste up to 12,000 characters of German, English or mixed conversation, or use
**Insert example**. Pasted names are text supplied by you, not verified speaker
identities. Relative dates use the submission time and Europe/Berlin. Inspect
the extracted actions, decisions, risks and questions; use Human corrections to
confirm/reject items or specify owners. Those corrections are free and their
original instructions become evidence for later AI questions. Ask is scoped to
the selected pasted source and corrections, without organizational catalogs,
web search, or previous AI answers treated as Human evidence.

The initial **USD 1 per Berlin calendar month** local allowance uses Luma's
durable budget implementation, with at most USD 0.05 reserved per workflow and
one paid attempt. The page shows estimated spent, pending and uncertain amounts,
request count, model, limit and reset time. Costs are calculated from reported
tokens and configured rates; they are not a provider invoice. Unknown charges
remain held. A failed or unchanged repeated question cannot silently cause
another paid attempt. An unchanged successful question reuses its saved answer.
Explicitly analyzing again creates another meeting and can incur another charge.

The local store is fixed at `~/.luma/local-ai/store`, shared across checkouts, so
restarting or switching branches cannot reset the allowance. Source text,
corrections, model-derived state and usage remain on this Mac after exit; no age
purge is introduced. The page lists the most recent 50 meetings. Only one process
may own the store. Stop it cleanly with Ctrl+C. A crash retains the ownership
lease and requires the existing audited store-recovery procedure; do not delete
the store or lease to bypass accounting. The page intentionally has no budget
reset button.

This isolated local ledger does not aggregate a future separate production
instance or another app. Count its usage within the agreed USD 30 total when
production is enabled; do not run two independent USD 30 budgets. The USD 1
local allowance is a conservative initial test allocation, not an increase of
the overall allowance. Discord testing below shares this same budget; Linear and
Notion write adapters are not composed.
Opening a stored meeting, replaying accepted source Evidence and concluding
operate on retained state without paid AI; replay does not retry failed analysis.

Provider credentials/quota, rate limits, oversized requests, malformed/citation
errors and exhausted/uncertain budgets surface in the page or operation receipt.
Source text remains available after analysis failure. No automatic provider
retries or background corpus runs spend the allowance. The free corpus remains
available separately through `pnpm local` or `pnpm eval:meeting:complete`.

The adapters use structured Responses with `store: false` and the existing token
reservation/accounting implementation. That setting is not a Zero Data Retention
guarantee. See the [OpenAI spending-controller guidance](https://developers.openai.com/cookbook/articles/per_run_spending_controller_responses_api#limits-and-other-costs)
for the distinction between application estimates, uncertain charges and
provider-side costs.

## What still needs a connected test

The offline mode is an interactive core test harness, not an open-ended local AI
assistant. The opt-in Discord mode below uses the production command handlers. Model proposals and provider responses in
the broader corpus are synthetic; correct replay does not prove a real model
will understand your meetings. The freeform field uses the existing bounded
Meeting query interpreter, not the live organizational Context Ask model.

The offline corpus also exercises real governed retrieval and provider parsers
with synthetic transports. It does not verify Discord event delivery, actual
Notion/Linear/Granola permissions, live model quality or billing, successful
external writes, or persistence across a process restart. Separate automated
tests cover additional budgets, workflows and recovery behavior; the sandbox is
not an all-product certification.

Real-AI mode establishes a place to judge actual model output on your examples;
its deterministic adapter tests do not substitute for a successful live response.
The next integration acceptance step is running the actual bot **locally**
against configured test sources. That also needs no paid hosting. Discord event
delivery, real Notion/Linear/Granola permissions, external writes and production
recovery remain separate checks. A fully offline live model would require a local
model adapter; none is implemented here. The founder/source permission checks
and AI cap remain applicable to a connected bot run.

For command-line verification without the browser:

```bash
pnpm eval:meeting:complete
pnpm verify
```

The first command covers the declared deterministic corpus. The second runs
formatting, lint, type checks and the behavioral suite. Opt-in live tests remain
skipped unless their explicit prerequisites are supplied. A green offline result
is a reason to proceed to controlled live testing, not a deployment claim.

## Test in Discord from the local AI page

This is an opt-in connection to the existing development application, using the
same runtime and Discord command handlers as deployment. It is not a simulated
Discord bot. The page never connects automatically, including after a restart.
The founders' general agreement is already recorded; this setup still verifies
the actual current channel audience on every admitted interaction.

Create `~/.luma/local-ai/discord.env` with private file permissions (0600):

```dotenv
DISCORD_TOKEN=<development bot token>
DISCORD_CLIENT_ID=<development application ID>
DISCORD_GUILD_ID=<server ID>
LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS=<founder-only text channel ID>
```

The local launcher reads only these four settings. Production credentials,
feature flags and database paths from another `.env` are never inherited.
Do not commit this private file. This Mac is configured for **Dayova Luma Dev**
(application `1526147284822392952`) and **team-chat-development**
(`1519252320343425135`), not `allgemein`, guests, or voice channels.

1. In the development application's **Bot** settings enable **Server Members
   Intent** and **Message Content Intent**. Member access establishes which
   humans can read the channel; Message Content enables bounded mentioned questions.
2. Give that development bot View Channel, Send Messages, Read Message History,
   Create Public Threads, and Send Messages in Threads in the configured channel.
   The four founders must be the only human readers. No Administrator grant is needed.
3. On the local page, click **Check Discord setup**. It checks credentials,
   intents and current founder-only audience before registering any commands.
4. Load your OpenAI key and click **Start Discord bot**. The key stays in memory;
   Discord and browser AI calls share one durable **$1 monthly budget**. Without
   a key, slash commands can retain notes and report deferred analysis; mentioned
   AI questions are disabled. Loading/removing a key stops the bot; start again
   to apply the new configuration.
5. In `team-chat-development`, use `/meeting start` with a test title. In the
   resulting thread use `/meeting note` with a short test note, then begin a
   message with `@Dayova Luma Dev` followed by a question. Use `/meeting usage`
   for usage and `/meeting stop` to conclude. The browser's **Refresh status and
   usage** button shows updated shared accounting. Discord meetings remain in
   Discord; the browser meeting picker lists pasted local meetings only.
6. Click **Stop Discord bot** when finished. Closing the tab alone leaves it
   running. `pnpm local:down` stops both pages and the bot cleanly.

The bot can post replies and meeting threads in the selected channel. No Notion,
Linear, Granola or GitHub connections are loaded; canonical external writes,
continuous chat collection and voice capture are not enabled. A mentioned question
reads its bounded thread through that mention. Stored Discord meeting/evidence
state lives in `~/.luma/local-ai/discord-store`; its shared AI accounting remains
in `~/.luma/local-ai/store`. Preserve both stores together for backup/recovery.
Limit errors use the normal Discord status responses rather than silent failure.

Live acceptance still requires the Discord permission setup and an API key. A
passing offline or programmable-adapter test does not establish successful live
Discord delivery or real model quality.
