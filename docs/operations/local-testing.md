# Test Luma locally before deployment

No hosting purchase is needed to run Luma on your Mac. Choose the free offline
sandbox or the opt-in real-AI mode below. Deployment and paid hosting remain deferred.

## Start

Use Node.js 24+ and the repository's pnpm version:

```bash
pnpm install --frozen-lockfile
pnpm local
```

Open the `http://127.0.0.1:<port>` address printed in the terminal. A free port is
chosen automatically. Keep the terminal running. Ctrl+C closes the server and
discards its temporary database. Restarting begins with an empty sandbox.
Dependency installation may download packages; the running sandbox uses no
external service and has no paid mode or credential configuration.

The sandbox does not read `.env`, use an existing Luma database, register Discord
commands, or construct a live AI or external write adapter. Every fresh sample
gets a separate Meeting within the sandbox. Switching samples retains previous
sandbox records until exit; this ephemeral test data is separate from Luma's
production history-retention policy. All browser tabs share this local session.

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

Open its printed loopback URL. Enter an OpenAI API key in the password field and
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
the overall allowance. No external write/provider account adapters are composed.
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

This is an interactive core test harness, not the production Discord interface
or an open-ended local AI assistant. Model proposals and provider responses in
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
