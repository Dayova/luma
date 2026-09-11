# AI usage and the exploratory budget

Jakob set a provisional **USD 30 per calendar month** for Luma's runtime AI
usage, shared by the four founders. The default month follows Europe/Berlin.
This is the current operating ceiling while the team learns from actual use,
not a target to spend or a permanent financial commitment. Hosting, capture
subscriptions, ChatGPT/Codex subscriptions, taxes and currency conversion are
separate. The cap never increases automatically.

The decision and ongoing exploration context live in the
[operating brief](https://app.notion.com/p/3d52e87228bf817c9c67e015df3ddf23).
[LUM-44](https://linear.app/dayova/issue/LUM-44) tracks implementation.

## What a founder sees

Use `/meeting usage` without an active Meeting, or `@Luma usage` / `@Luma status`
in an enabled Context Ask thread. These responses do not call a model or capture
conversation content. Founder admission and the existing source/channel opt-in
rules still apply.

The view distinguishes estimated spend from reservations for running requests
and unknown charges. Warnings appear at 80% and 90% of the configured allowance
($24 and $27 at the initial cap). If the next bounded request cannot fit, Luma
explains the limit and applicable reset or recovery action without another AI
call. A request can therefore be refused slightly before the displayed spend
reaches the cap.

Provider billing quota, temporary rate limits, timeouts, missing configuration
and oversized requests have different explanations. The local Discord cooldown
also replies to an eligible request instead of silently dropping it. These
messages contain no raw provider diagnostics or credentials.

When a note is saved but its analysis is deferred, the response says both things.
Original Evidence remains available. Do not resubmit the same note to force
analysis: duplicate Observations do not re-run it. Automatic Decision processing
can retry a retained attempt only when the provider was definitely not called,
with at most three attempts for the exact source batch and a fresh permission
check. Budget refusals wait for the actual reset; unknown charges remain held.
Monthly rollover does not authorize proposed external writes. Deterministic
queries and already saved information remain usable independently of AI spend.

## Accounting and admission

The executable application supplies one durable usage controller to Meeting
analysis, capture synthesis, Context Ask, Decision processing, structured work
and native Notion review. Reservations are transactional and shared across
concurrent callers. The ledger records request/workflow identities, capability,
model, price version and token counts; it does not store prompt bodies or source
text for telemetry.

Each call reserves a conservative cost before dispatch, including bounded output
and input containing instructions, schema and Evidence. SDK retries are disabled;
requests have an explicit timeout and output ceiling. The workflow attempt and
spend ceilings also survive restart. Unknown outcomes retain their reservation
instead of being counted as free; late positive usage can settle them.

Provider-reported token counts support a **calculated cost estimate**, not an
invoice. Cached input and cache writes are separate, and reasoning tokens are
already part of output tokens. Never add reasoning to output again. Missing or
invalid usage is unknown. The current price table covers Standard short-context
`gpt-5.6-luna`; an unpriced model fails admission rather than receiving a zero
price. A model change requires a reviewed price table and quality evidence.

If a returned model, pricing tier or usage count contradicts the reservation,
the workspace stops paid dispatch until an operator reconciles the accounting.
Restart and monthly rollover do not clear this condition. Preserve the ledger,
compare the provider receipt and billing facts, and resolve the mismatch before
clearing the hold. Use the [audited accounting recovery workflow](../operations/ai-accounting-recovery.md)
over the cleanly stopped store. It requires verified per-request billing evidence
and a separate explicit review before unblocking paid AI. Unknown charges are
never silently released, and reconciliation never retries the original paid work.

Application estimates cannot establish an atomic provider billing ceiling. Use
a dedicated Luma provider project, verify its existing consumption, and set its
monthly spend limit as an additional deployment control. Provider enforcement
can lag. A fresh local ledger does not prove the provider account has spent zero,
and unrelated workloads must not share an untracked allowance. This change does
not configure a live project, buy credits or enable collection. See the
[provider spend-limit documentation](https://developers.openai.com/api/docs/guides/spend-limits).

## Configuration

| Variable                     | Default         | Purpose                                                                 |
| ---------------------------- | --------------- | ----------------------------------------------------------------------- |
| `LUMA_AI_MONTHLY_LIMIT_USD`  | `30`            | Shared monthly admission ceiling; `0` pauses paid dispatch.             |
| `LUMA_AI_DAILY_LIMIT_USD`    | Unset           | Optional additional daily ceiling.                                      |
| `LUMA_AI_BUDGET_TIMEZONE`    | `Europe/Berlin` | Calendar boundaries for this ledger.                                    |
| `LUMA_AI_WORKFLOW_LIMIT_USD` | `0.25`          | Maximum estimated spend for one logical workflow.                       |
| `LUMA_AI_MAX_INPUT_TOKENS`   | `100000`        | Conservative input-token upper bound, not a character-to-token average. |
| `LUMA_AI_MAX_OUTPUT_TOKENS`  | `8192`          | Maximum total output tokens, including reasoning.                       |
| `LUMA_AI_TIMEOUT_MS`         | `60000`         | Per-request timeout; no automatic SDK retry.                            |

Limit changes are explicit operator configuration under the owner's budget
decision. Keep the ledger with the durable application database and include it
in backups. Changing the workspace identity, timezone or discarding the store is
not a valid way to reset usage.

## Initial cost estimate

Plan **USD 5–15/month initially** for all four founders using the current model
and text workflows. This is a planning range, not measured consumption. Prices
were checked on 11 September 2026 against the
[official pricing table](https://developers.openai.com/api/docs/pricing) and
[Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna):
per million tokens, Standard short-context input is $0.20, cached input $0.02,
cache writes $0.25 and output $1.20.

For a transparent example, assume 400 Context Asks per month at 10,000 input and
4,000 total output tokens each, plus 100 analysis calls at 20,000 input and 8,000
total output tokens. Pricing all input at the conservative $0.25/M rate and adding
a 25% experimentation allowance gives:

```text
Ask:      (10,000 × $0.25 + 4,000 × $1.20) / 1,000,000 = $0.0073
Analysis: (20,000 × $0.25 + 8,000 × $1.20) / 1,000,000 = $0.0146
Month:    (400 × $0.0073 + 100 × $0.0146) × 1.25       = $5.475
```

All counts and token sizes are assumptions across the whole team. The allowance
does not predict an actual retry rate. Analysis runs for newly analyzable Evidence
batches, so one Meeting can cause multiple calls. Current Meeting query,
catch-up and conclusion are deterministic; they do not each add a model request.
Longer context, more revisions, greater reasoning usage or a model upgrade can
consume the $30 allowance. New audio, paid tools or source services require a new
estimate.

Notion's own Custom Agent credits are separate from these Luma API calls. Native
Notion review remains disabled until its access and separate billing arrangement
are established; enabling the MCP endpoint does not bring provider agent charges
under Luma's local ledger.

After roughly two weeks of actual use, compare the usage breakdown with provider
billing and useful workflow outcomes. Inspect uncertain/failed work and quality
before changing the cap or routing. This is an exploration review checkpoint, not a
scheduled automation or a claim that live cost reconciliation has run.
