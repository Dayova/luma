# Test Luma locally before deployment

No hosting purchase is needed to run Luma on your Mac. Start with the free offline
sandbox; real AI and provider integration quality need a separate connected test.
Deployment and paid activation remain deferred until you choose to proceed.

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

After this walkthrough, the next useful acceptance step is running the actual
bot **locally** against explicitly configured test sources. That still needs no
paid hosting. AI APIs may charge per use even when Luma runs on your Mac; this
sandbox does not enable them. A fully free live-model test would require a
supported local model adapter or an available provider free allowance, neither
of which is implemented or assumed here. Existing credentials are not silently
reused. The founder/source permission checks and AI cap remain applicable to a
connected local run.

For command-line verification without the browser:

```bash
pnpm eval:meeting:complete
pnpm verify
```

The first command covers the declared deterministic corpus. The second runs
formatting, lint, type checks and the behavioral suite. Opt-in live tests remain
skipped unless their explicit prerequisites are supplied. A green offline result
is a reason to proceed to controlled live testing, not a deployment claim.
