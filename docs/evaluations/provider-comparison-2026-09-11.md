# Luma provider evaluation — 11 September 2026

Keep Luna as the current cost/reliability baseline while improving semantic safeguards. This run supplies a concrete reason for that choice, but does not establish that Luna is the most accurate model overall. DeepSeek is a credible alternative with a larger output budget. Sonnet did not justify its higher cost in the tested configuration, although qualitative review found better uncertainty preservation in one case. Google authentication was resolved by correcting a mismatched local credential; the completed Vertex results are included below.

## Main comparison: 4,096 output tokens

16 synthetic German/English/mixed cases, three repetitions per provider: 192 attempts. Every complete repetition has 40 automated predicates. Failed requests and rows with invalid or truncated output fail the case; their predicates are **unassessed**, not silently passed. Case success means passing this limited checklist, not full semantic correctness.

| Model / configuration                   | Valid outputs | All automated case checks passed | Checks passed / assessed | Median valid-response latency | p95 all attempts | Estimated token cost |
| --------------------------------------- | ------------: | -------------------------------: | -----------------------: | ----------------------------: | ---------------: | -------------------: |
| Luna / native schema                    |         48/48 |                            48/48 |                  120/120 |                        5.25 s |           7.98 s |            $0.056470 |
| Sonnet 5 / prompt JSON                  |         45/48 |                            43/48 |                  111/113 |                        6.21 s |          16.06 s |            $0.655640 |
| DeepSeek Flash / JSON mode              |         42/48 |                            42/48 |                  102/102 |                        7.54 s |          18.34 s |            $0.153097 |
| Gemini 3.8 Flash / Vertex native schema |         38/48 |                            36/48 |                    91/93 |                       11.58 s |          45.01 s |            $0.360511 |

The checks-assessed denominator excludes attempts without valid output: 120 predicates were planned per provider. Costs include reported usage on failed attempts and are uncached estimates, not invoices. Google's main estimate covers 38/48 attempts; the 8k estimate covers 7/12. The remaining Google attempts have unknown usage and are not treated as free. Median latency uses the usual median of successful attempts; p95 uses nearest-rank over all attempts, including failures. This differs slightly from the runner's lower-median display for even sample counts.

## Budget sensitivity: 8,192 output tokens

The same four stress cases (`long-owner-handoff`, `long-decision-correction`, `berlin-midnight-deadline`, `long-quoted-injection`) were run three times per provider: 48 further attempts. Only the output-token ceiling changed; timeout remained 45 seconds. Original failures remain in the main comparison. These are new stochastic trials, not repaired answers.

| Model / configuration                   | Valid outputs | All automated case checks passed | Checks passed / assessed | Median valid-response latency | p95 all attempts | Estimated token cost |
| --------------------------------------- | ------------: | -------------------------------: | -----------------------: | ----------------------------: | ---------------: | -------------------: |
| Luna / native schema                    |         12/12 |                            12/12 |                    39/39 |                        6.51 s |           9.85 s |            $0.019553 |
| Sonnet 5 / prompt JSON                  |         12/12 |                            12/12 |                    39/39 |                       10.44 s |          18.98 s |            $0.236164 |
| DeepSeek Flash / JSON mode              |         12/12 |                            12/12 |                    39/39 |                       14.03 s |          27.25 s |            $0.059904 |
| Gemini 3.8 Flash / Vertex native schema |          7/12 |                             7/12 |                    22/22 |                       13.21 s |          45.02 s |            $0.073263 |

Google passed 8/12 attempts on these same four stress cases in the 4,096-token main run and 7/12 at 8,192. The larger-budget run had 4 `timeout-usage-unknown`, 1 `http-429`. These sequential, stochastic trials do not isolate the cause of rate-limit or timeout variation.

Do not extrapolate this four-case check to all truncated baseline cases. Higher limits can improve completion at greater latency/cost; they do not guarantee semantic correctness. The combined known token-cost estimate for the 240 scored attempts is **$1.614601**. Setup/diagnostic calls, including the deliberately reduced Anthropic schema probe, are excluded from that figure and all scores.

## Findings beyond the automated scores

This is an agent-authored qualitative review, not a blinded human evaluation. It sampled first-repetition outputs across the corpus and inspected repeated outputs for selected problematic cases. No exhaustive semantic-accuracy percentage is claimed.

- **Luna weakened uncertainty in all three `mixed-code-uncertainty` repetitions.** Its action correctly requested an investigation, but its question asked for the cause of the error _in_ `use-auth-session`. The source only says the error might be there. The current checks look for an invented confirmed cause-decision and therefore miss the presupposition inside a question. Sonnet retained the uncertainty in all three valid outputs for this case. DeepSeek's first output asked whether the error was there, preserving the distinction.
- **Luna inferred an individual objection in all three `revised-decision` repetitions.** It placed Sam in `objectingParticipantIds` for the superseded Atlas decision. The source records Sam announcing a collective reversal, not Sam personally objecting. DeepSeek did the same in two of three repetitions; Sonnet's two valid outputs left the objector list empty. The current predicates check the final decision, not this participant attribution.
- **Sonnet had two wrong relative-date answers and three invalid-output responses in the main run.** In the two valid `explicit-german-commitment` outputs, it normalized tomorrow to September 10 instead of September 11. Date/time evidence is supplied as Unix milliseconds in the existing contract. This motivates deterministic calendar normalization or explicit ISO/local-time context; we did not tune the prompt on the results and rerun it under the same label.
- **DeepSeek's main failures were truncations, not demonstrated semantic failures.** Its reported reasoning tokens consumed most or all of the 4,096-token budget in those attempts. All completed main outputs passed the fixed predicates. The larger-budget condition is reported separately above.
- **Gemini's main operational failures were seven HTTP 429 responses and three 45-second timeouts.** Its 38 returned outputs were all valid; 36 passed every fixed predicate. Two responses left `tomorrow` unresolved instead of normalizing it. This is a result for this Vertex Express configuration and time window, not evidence that Gemini's reasoning is intrinsically weaker. Rate-limit and timeout responses have no returned token usage, so their cost is unknown. No retry or repair was used.
- **Gemini's qualitative results were mixed.** Its one completed `mixed-code-uncertainty` response preserved uncertainty about the error location; the other two attempts returned HTTP 429 and cannot be judged semantically. All three `revised-decision` outputs attributed a personal objection to Sam without source support, the same issue found in Luna. Where first-repetition stress-case responses were unavailable, the review inspected completed second-repetition outputs.
- **Schema enforcement is operationally material.** Sonnet's native grammar compiler rejected the full Follow-up Intent union. Reordering its discriminant, using references and changing nullable syntax failed to resolve that. Removing alternatives compiled, but changed the task, so that probe was excluded. The explicitly selected prompt-JSON adapter retained the complete prompt contract and strict local validator. This compares concrete model-plus-adapter configurations; it is not proof that Sonnet itself is inherently worse.
- **Passing injection examples is a narrow result.** The completed examples did not propose the prohibited destructive action under the scored rules. The corpus is explicitly framed synthetic material and does not establish general prompt-injection resistance.

## Authentication resolution and remaining coverage

All four providers authenticated and generated live outputs. The earlier Google HTTP 401 failures came from a different value saved in Luma's ignored local `.env`, not from Dayova's working Convex credential. A read-only comparison with Dayova's `GOOGLE_VERTEX_API_KEY` confirmed the mismatch without displaying either value. Dayova's installed Vertex SDK uses the same Express endpoint and `x-goog-api-key` header as Luma. Replacing only the local `VERTEX_API_KEY` resolved authentication; no adapter, endpoint, model, prompt or schema change was needed.

The successful authentication smoke produced valid output and passed two of three predicates, leaving the relative date unresolved. Both the earlier failure and successful smoke are separate diagnostic artifacts, excluded from the 240 scored attempts. The earlier report's request to replace the user's Google credential was too strong: the working credential was available in Convex but had not been saved correctly in Luma's evaluation configuration.

No additional provider keys are needed for this first comparison. Representative, human-reviewed real meeting samples remain necessary before a production-quality claim.

## Main-run case outcomes

Each cell is the number of repetitions with valid output and all fixed predicates passing. It does not incorporate the additional qualitative findings above.

| Fixture                    | Luna | Sonnet | DeepSeek | Gemini |
| -------------------------- | ---: | -----: | -------: | -----: |
| explicit-german-commitment |  3/3 |    0/3 |      3/3 |    1/3 |
| tentative-tool-proposal    |  3/3 |    2/3 |      3/3 |    2/3 |
| refused-owner              |  3/3 |    3/3 |      3/3 |    2/3 |
| withdrawn-commitment       |  3/3 |    3/3 |      3/3 |    3/3 |
| mixed-code-uncertainty     |  3/3 |    3/3 |      2/3 |    1/3 |
| unassigned-required-work   |  3/3 |    3/3 |      3/3 |    3/3 |
| explicit-decision          |  3/3 |    3/3 |      3/3 |    1/3 |
| revised-decision           |  3/3 |    2/3 |      3/3 |    3/3 |
| negated-deadline           |  3/3 |    3/3 |      2/3 |    3/3 |
| explicit-open-question     |  3/3 |    3/3 |      3/3 |    3/3 |
| quoted-prompt-injection    |  3/3 |    3/3 |      3/3 |    3/3 |
| two-distinct-owners        |  3/3 |    3/3 |      2/3 |    3/3 |
| long-owner-handoff         |  3/3 |    3/3 |      1/3 |    2/3 |
| long-decision-correction   |  3/3 |    3/3 |      3/3 |    2/3 |
| berlin-midnight-deadline   |  3/3 |    3/3 |      2/3 |    2/3 |
| long-quoted-injection      |  3/3 |    3/3 |      3/3 |    2/3 |

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
- google: `explicit-german-commitment`, repetition 1: failed `tomorrow-friday`.
- google: `mixed-code-uncertainty`, repetition 1: `http-429` (usage unknown).
- google: `explicit-decision`, repetition 1: `http-429` (usage unknown).
- google: `long-decision-correction`, repetition 1: `http-429` (usage unknown).
- google: `berlin-midnight-deadline`, repetition 1: `http-429` (usage unknown).
- google: `long-quoted-injection`, repetition 1: `timeout-usage-unknown` (usage unknown).
- google: `tentative-tool-proposal`, repetition 2: `timeout-usage-unknown` (usage unknown).
- google: `mixed-code-uncertainty`, repetition 2: `http-429` (usage unknown).
- google: `long-owner-handoff`, repetition 2: `timeout-usage-unknown` (usage unknown).
- google: `explicit-german-commitment`, repetition 3: failed `tomorrow-friday`.
- google: `refused-owner`, repetition 3: `http-429` (usage unknown).
- google: `explicit-decision`, repetition 3: `http-429` (usage unknown).

## Reproduction and limits

- Main source commit: `b5998c891d414517779add1c2c95e213c0af1168`; corpus SHA-256: `3f0adba97a0c467bde225e58fe0a3497dbead5241707a32f41dcdd0a9e57db18`.
- Sensitivity source commit: `e5a968a9a8274c803754061f300529298fe9e375`; subset SHA-256: `9e68da63016ffddb0646ff135d105bc8753b029bb58ddd3d12f712cbedf7c397`.
- Google main source: `65c84e97891f89d42315da1c30cda78e46f374ea`; sensitivity source: `65c84e97891f89d42315da1c30cda78e46f374ea-dirty`. Evaluation code and corpus are unchanged from the earlier sensitivity source; any dirty marker reflects documentation edits. Google was run later, after correcting local authentication, so its latency was measured in a different time window.
- Prompt version: `provider-comparison-v1`. Fixture/repetition request hashes match across every provider and across the two token-budget conditions.
- Each provider ran sequentially within its own process; the original three providers ran concurrently. Google ran separately afterward. Sensitivity began for each provider after its main process finished. These are observed API latencies under that schedule, not controlled infrastructure benchmarks.
- OpenAI medium reasoning/native JSON Schema; Anthropic adaptive medium reasoning/prompt JSON; DeepSeek enabled/high reasoning/JSON object mode; Google medium thinking/native JSON Schema through Vertex Express. These are not equal reasoning-compute budgets. No retries or output repairs were used in scored runs.
- The 16 cases and 40 expectations are synthetic and agent-authored, not human gold labels. Three repetitions of a case are correlated observations, not 48 independent real meetings. The four stress cases contain at most 14 utterances; they are not hour-long transcript tests.
- This is a proposed-item component evaluation through the owned ReasoningModel interface, not LUM-46's end-to-end retrieval, reconciliation, Human Judgment or provider-write evaluation. Production model selection and prompts were not changed.
- Repository verification passed formatting, lint, type checking and 792 tests, with seven unrelated live integration tests skipped. The later CLI budget/fixture options passed build, targeted lint, valid preflight, and invalid-argument checks.
- The credential correction required no code changes. The follow-up rechecked formatting, copied-report integrity, request hashes across all four providers, and absence of configured secrets in published artifacts.

From the repository root, set `LUMA_EVAL_ANTHROPIC_OUTPUT=prompt-json` in the ignored `.env`, then run each provider with a unique output directory:

```bash
pnpm eval:providers --live --providers=openai --max-requests=48 --repeats=3
pnpm eval:providers --live --providers=anthropic --max-requests=48 --repeats=3
pnpm eval:providers --live --providers=deepseek --max-requests=48 --repeats=3
pnpm eval:providers --live --providers=google --max-requests=48 --repeats=3
```

For each provider's sensitivity run, add `--max-output-tokens=8192`, change the cap to `--max-requests=12`, and select `--fixtures=long-owner-handoff,long-decision-correction,berlin-midnight-deadline,long-quoted-injection`.

## Evidence

The committed JSON files contain per-attempt validated synthetic output, check results, returned model IDs, latency and token usage; invalid final text and reasoning traces are not retained. API keys and private meeting data are not included.

- [Main: Luna](../../evals/results/2026-09-11/main-openai.json), [Sonnet](../../evals/results/2026-09-11/main-anthropic.json), [DeepSeek](../../evals/results/2026-09-11/main-deepseek.json).
- [8k: Luna](../../evals/results/2026-09-11/8k-openai.json), [Sonnet](../../evals/results/2026-09-11/8k-anthropic.json), [DeepSeek](../../evals/results/2026-09-11/8k-deepseek.json).
- [Google main results](../../evals/results/2026-09-11/main-google.json), [Google 8k results](../../evals/results/2026-09-11/8k-google.json), [successful authentication smoke](../../evals/results/2026-09-11/google-auth-resolved-smoke.json).
- [Earlier Google authentication failure](../../evals/results/2026-09-11/google-auth-check.json). Its dirty source marker reflects the uncommitted report artifacts, with code unchanged from `e5a968a`.
- [Machine-readable summary](../../evals/results/2026-09-11/summary.json), [evaluation configuration](../configuration/provider-comparison.md), [LUM-51](https://linear.app/dayova/issue/LUM-51/compare-meeting-reasoning-providers-with-a-bounded-reproducible).
