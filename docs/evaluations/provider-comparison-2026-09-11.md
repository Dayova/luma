# Luma provider evaluation — 11 September 2026

Keep Luna as the current cost/reliability baseline while improving semantic safeguards. This run supplies a concrete reason for that choice, but does not establish that Luna is the most accurate model overall. DeepSeek is a credible alternative with a larger output budget. Sonnet did not justify its higher cost in the tested configuration, although qualitative review found better uncertainty preservation in one case. Google could not be evaluated because authentication failed.

## Main comparison: 4,096 output tokens

16 synthetic German/English/mixed cases, three repetitions per provider: 144 attempts. Every complete repetition has 40 automated predicates. Rows with invalid or truncated output fail the case; their predicates are **unassessed**, not silently passed. Case success means passing this limited checklist, not full semantic correctness.

| Model / configuration      | Valid outputs | All automated case checks passed | Checks passed / assessed | Median valid-response latency | p95 all attempts | Estimated token cost |
| -------------------------- | ------------: | -------------------------------: | -----------------------: | ----------------------------: | ---------------: | -------------------: |
| Luna / native schema       |         48/48 |                            48/48 |                  120/120 |                        5.25 s |           7.98 s |            $0.056470 |
| Sonnet 5 / prompt JSON     |         45/48 |                            43/48 |                  111/113 |                        6.21 s |          16.06 s |            $0.655640 |
| DeepSeek Flash / JSON mode |         42/48 |                            42/48 |                  102/102 |                        7.54 s |          18.34 s |            $0.153097 |

The checks-assessed denominator excludes invalid outputs: 120 predicates were planned per provider. Costs include reported usage on failed attempts and are uncached estimates, not invoices. Median latency uses the usual median of successful attempts; p95 uses nearest-rank over all attempts, including failures. This differs slightly from the runner's lower-median display for even sample counts.

## Budget sensitivity: 8,192 output tokens

The same four stress cases (`long-owner-handoff`, `long-decision-correction`, `berlin-midnight-deadline`, `long-quoted-injection`) were run three times per provider: 36 further attempts. Only the output-token ceiling changed; timeout remained 45 seconds. Original failures remain in the main comparison. These are new stochastic trials, not repaired answers.

| Model / configuration      | Valid outputs | All automated case checks passed | Checks passed / assessed | Median valid-response latency | p95 all attempts | Estimated token cost |
| -------------------------- | ------------: | -------------------------------: | -----------------------: | ----------------------------: | ---------------: | -------------------: |
| Luna / native schema       |         12/12 |                            12/12 |                    39/39 |                        6.51 s |           9.85 s |            $0.019553 |
| Sonnet 5 / prompt JSON     |         12/12 |                            12/12 |                    39/39 |                       10.44 s |          18.98 s |            $0.236164 |
| DeepSeek Flash / JSON mode |         12/12 |                            12/12 |                    39/39 |                       14.03 s |          27.25 s |            $0.059904 |

Do not extrapolate this four-case check to all truncated baseline cases. Higher limits can improve completion at greater latency/cost; they do not guarantee semantic correctness. The combined known token-cost estimate for the 180 scored attempts is **$1.180827**. Setup/diagnostic calls, including the deliberately reduced Anthropic schema probe, are excluded from that figure and all scores.

## Findings beyond the automated scores

This is an agent-authored qualitative review, not a blinded human evaluation. It sampled first-repetition outputs across the corpus and inspected repeated outputs for selected problematic cases. No exhaustive semantic-accuracy percentage is claimed.

- **Luna weakened uncertainty in all three `mixed-code-uncertainty` repetitions.** Its action correctly requested an investigation, but its question asked for the cause of the error _in_ `use-auth-session`. The source only says the error might be there. The current checks look for an invented confirmed cause-decision and therefore miss the presupposition inside a question. Sonnet retained the uncertainty in all three valid outputs for this case. DeepSeek's first output asked whether the error was there, preserving the distinction.
- **Luna inferred an individual objection in all three `revised-decision` repetitions.** It placed Sam in `objectingParticipantIds` for the superseded Atlas decision. The source records Sam announcing a collective reversal, not Sam personally objecting. DeepSeek did the same in two of three repetitions; Sonnet's two valid outputs left the objector list empty. The current predicates check the final decision, not this participant attribution.
- **Sonnet had two wrong relative-date answers and three invalid-output responses in the main run.** In the two valid `explicit-german-commitment` outputs, it normalized tomorrow to September 10 instead of September 11. Date/time evidence is supplied as Unix milliseconds in the existing contract. This motivates deterministic calendar normalization or explicit ISO/local-time context; we did not tune the prompt on the results and rerun it under the same label.
- **DeepSeek's main failures were truncations, not demonstrated semantic failures.** Its reported reasoning tokens consumed most or all of the 4,096-token budget in those attempts. All completed main outputs passed the fixed predicates. The larger-budget condition is reported separately above.
- **Schema enforcement is operationally material.** Sonnet's native grammar compiler rejected the full Follow-up Intent union. Reordering its discriminant, using references and changing nullable syntax failed to resolve that. Removing alternatives compiled, but changed the task, so that probe was excluded. The explicitly selected prompt-JSON adapter retained the complete prompt contract and strict local validator. This compares concrete model-plus-adapter configurations; it is not proof that Sonnet itself is inherently worse.
- **Passing injection examples is a narrow result.** The completed examples did not propose the prohibited destructive action under the scored rules. The corpus is explicitly framed synthetic material and does not establish general prompt-injection resistance.

## Authentication and remaining coverage

OpenAI, Anthropic and DeepSeek authenticated and generated live outputs. The supplied Google credential failed on Vertex (HTTP 401, API-key/principal authentication error) and in a separate Developer API diagnostic (HTTP 400, invalid API key). Query-string transport did not resolve Vertex authentication either. A final recheck at 16:43 UTC also returned HTTP 401; its separate diagnostic artifact is linked below and excluded from the 180 scored attempts. The configured Google slot remains `gemini-3.8-flash` through Vertex; it was not replaced with another model or hosting route in a scored run.

A working Vertex authorization/Express key is still needed, with `VERTEX_PROJECT_ID` for the project-scoped route. Use the API **key string**, not its display name or key ID. No additional vendor accounts are necessary to complete this first comparison. Representative, human-reviewed real meeting samples are the next data requirement before a production-quality claim.

## Main-run case outcomes

Each cell is the number of repetitions with valid output and all fixed predicates passing. It does not incorporate the additional qualitative findings above.

| Fixture                    | Luna | Sonnet | DeepSeek |
| -------------------------- | ---: | -----: | -------: |
| explicit-german-commitment |  3/3 |    0/3 |      3/3 |
| tentative-tool-proposal    |  3/3 |    2/3 |      3/3 |
| refused-owner              |  3/3 |    3/3 |      3/3 |
| withdrawn-commitment       |  3/3 |    3/3 |      3/3 |
| mixed-code-uncertainty     |  3/3 |    3/3 |      2/3 |
| unassigned-required-work   |  3/3 |    3/3 |      3/3 |
| explicit-decision          |  3/3 |    3/3 |      3/3 |
| revised-decision           |  3/3 |    2/3 |      3/3 |
| negated-deadline           |  3/3 |    3/3 |      2/3 |
| explicit-open-question     |  3/3 |    3/3 |      3/3 |
| quoted-prompt-injection    |  3/3 |    3/3 |      3/3 |
| two-distinct-owners        |  3/3 |    3/3 |      2/3 |
| long-owner-handoff         |  3/3 |    3/3 |      1/3 |
| long-decision-correction   |  3/3 |    3/3 |      3/3 |
| berlin-midnight-deadline   |  3/3 |    3/3 |      2/3 |
| long-quoted-injection      |  3/3 |    3/3 |      3/3 |

## Main-run failures

- anthropic: `explicit-german-commitment`, repetition 1: failed `tomorrow-friday`.
- anthropic: `explicit-german-commitment`, repetition 2: failed `tomorrow-friday`.
- anthropic: `revised-decision`, repetition 2: `invalid-json-or-schema` (end_turn).
- anthropic: `explicit-german-commitment`, repetition 3: `invalid-json-or-schema` (end_turn).
- anthropic: `tentative-tool-proposal`, repetition 3: `invalid-json-or-schema` (end_turn).
- deepseek: `long-owner-handoff`, repetition 1: `incomplete-or-refused` (length).
- deepseek: `two-distinct-owners`, repetition 2: `incomplete-or-refused` (length).
- deepseek: `berlin-midnight-deadline`, repetition 2: `incomplete-or-refused` (length).
- deepseek: `mixed-code-uncertainty`, repetition 3: `incomplete-or-refused` (length).
- deepseek: `negated-deadline`, repetition 3: `incomplete-or-refused` (length).
- deepseek: `long-owner-handoff`, repetition 3: `incomplete-or-refused` (length).

## Reproduction and limits

- Main source commit: `b5998c891d414517779add1c2c95e213c0af1168`; corpus SHA-256: `3f0adba97a0c467bde225e58fe0a3497dbead5241707a32f41dcdd0a9e57db18`.
- Sensitivity source commit: `e5a968a9a8274c803754061f300529298fe9e375`; subset SHA-256: `9e68da63016ffddb0646ff135d105bc8753b029bb58ddd3d12f712cbedf7c397`.
- Prompt version: `provider-comparison-v1`. Fixture/repetition request hashes match across every provider and across the two token-budget conditions.
- Each provider ran sequentially within its own process; different providers ran concurrently. Sensitivity began for each provider after its main process finished. These are observed API latencies under that schedule, not controlled infrastructure benchmarks.
- OpenAI medium reasoning/native JSON Schema; Anthropic adaptive medium reasoning/prompt JSON; DeepSeek enabled/high reasoning/JSON object mode. These are not equal reasoning-compute budgets. No retries or output repairs were used in scored runs.
- The 16 cases and 40 expectations are synthetic and agent-authored, not human gold labels. Three repetitions of a case are correlated observations, not 48 independent real meetings. The four stress cases contain at most 14 utterances; they are not hour-long transcript tests.
- This is a proposed-item component evaluation through the owned ReasoningModel interface, not LUM-46's end-to-end retrieval, reconciliation, Human Judgment or provider-write evaluation. Production model selection and prompts were not changed.
- Repository verification passed formatting, lint, type checking and 792 tests, with seven unrelated live integration tests skipped. The later CLI budget/fixture options passed build, targeted lint, valid preflight, and invalid-argument checks.

From the repository root, set `LUMA_EVAL_ANTHROPIC_OUTPUT=prompt-json` in the ignored `.env`, then run each provider with a unique output directory:

```bash
pnpm eval:providers --live --providers=openai --max-requests=48 --repeats=3
pnpm eval:providers --live --providers=anthropic --max-requests=48 --repeats=3
pnpm eval:providers --live --providers=deepseek --max-requests=48 --repeats=3
```

For each provider's sensitivity run, add `--max-output-tokens=8192`, change the cap to `--max-requests=12`, and select `--fixtures=long-owner-handoff,long-decision-correction,berlin-midnight-deadline,long-quoted-injection`.

## Evidence

The committed JSON files contain per-attempt validated synthetic output, check results, returned model IDs, latency and token usage; invalid final text and reasoning traces are not retained. API keys and private meeting data are not included.

- [Main: Luna](../../evals/results/2026-09-11/main-openai.json), [Sonnet](../../evals/results/2026-09-11/main-anthropic.json), [DeepSeek](../../evals/results/2026-09-11/main-deepseek.json).
- [8k: Luna](../../evals/results/2026-09-11/8k-openai.json), [Sonnet](../../evals/results/2026-09-11/8k-anthropic.json), [DeepSeek](../../evals/results/2026-09-11/8k-deepseek.json).
- [Final Google authentication check](../../evals/results/2026-09-11/google-auth-check.json). Its dirty source marker reflects the uncommitted report artifacts, with code unchanged from `e5a968a`.
- [Machine-readable summary](../../evals/results/2026-09-11/summary.json), [evaluation configuration](../configuration/provider-comparison.md), [LUM-51](https://linear.app/dayova/issue/LUM-51/compare-meeting-reasoning-providers-with-a-bounded-reproducible).
