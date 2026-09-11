# LUM-53: calibrated evaluation and first challenge run

The original Luna 48/48 checklist result was insufficient evidence of perfect
meeting understanding. Regrading the **same saved answers** under evaluation v2.1
finds three unsupported personal objections: Luna falls to **45/48 automated
case passes**, without making another request. This supports strengthening the
grader; it does not establish another model as the best choice.

## Changes and evidence

The [new workflow](../configuration/provider-quality.md) keeps the 16 original
regression cases, adds eight challenge cases (24 cases in 23 scenario groups),
requires exact-answer human review for semantic quality, and supports saved model
manifests, reproducible request order, matched comparisons, group bootstrap
intervals, and versioned offline regrading. Models remain behind the existing
owned adapter. Production model selection and Meeting Intelligence are unchanged.

Calibration tests cover observed unsupported objections and uncertainty errors,
valid paraphrases, wrong owner/date/evidence, missing and duplicate actions, a
valid conditional candidate offer, stale reviews, and unsafe reuse of answers
when the source request changes. These are selected checks on the grader. Its
precision/recall against independently human-labeled answers remains unmeasured.

## Historical regrade: original 16 cases, three repetitions

All four providers had 48 dispatched attempts. The source reports and original
v1 scores remain available unchanged in `evals/results/2026-09-11/`.

| Model                            | Valid outputs | v1 automatic case passes | v2.1 automatic case passes | Operational errors | Pending human review |
| -------------------------------- | ------------: | -----------------------: | -------------------------: | -----------------: | -------------------: |
| OpenAI `gpt-5.6-luna`            |            48 |                       48 |                         45 |                  0 |                   48 |
| Anthropic `claude-sonnet-5`      |            45 |                       43 |                         43 |                  3 |                   45 |
| DeepSeek `deepseek-flash`        |            42 |                       42 |                         40 |                  6 |                   42 |
| Google Vertex `gemini-3.8-flash` |            38 |                       36 |                         33 |                 10 |                   38 |

The new attribution check rejects a personal objector invented during a collective
decision reversal: three Luna answers, two DeepSeek answers, and three Gemini
answers. A separate qualitative issue remains visible in Luna's
`mixed-code-uncertainty` answers: a question presupposes a suspected module error.
Its citation IDs exist, so automated citation checks do not resolve that issue.
The rubric requires semantic review of question presuppositions.

The generated historical report plans all 24 current cases and marks the eight
new cases × three repetitions **unrun for each candidate**. The table above uses
only the original 48 attempts. The expanded-plan report therefore has missing
matched pairs and withholds comparison intervals. None of its 173 valid answers
has a completed independent human review. Reviewed correctness is unmeasured,
not a score of zero percent.

Regrade cost: **zero new API requests**. Costs retained in historical reports refer
to the original run, not to processing the saved files.

## New challenge run: eight cases, one repetition

A separate 32-request run used all four existing provider credentials, seed 53,
4,096 maximum output tokens, 45-second timeout, no retries, and the original
comparison adapter profile. Google used Vertex Express; Anthropic used
`prompt-json` with the full shared contract and strict local validation. All
providers received identical task requests for each case. Provider reasoning
controls do not represent equal compute budgets.

| Model                   | Valid outputs / attempts | v2.1 automatic passes | Operational errors | Pending human review | Known estimated cost |
| ----------------------- | -----------------------: | --------------------: | -----------------: | -------------------: | -------------------: |
| Luna                    |                      8/8 |                     8 |                  0 |                    8 |            $0.018488 |
| Sonnet                  |                      8/8 |                     8 |                  0 |                    8 |            $0.215054 |
| DeepSeek Flash          |                      2/8 |                     2 |                  6 |                    2 |            $0.042380 |
| Gemini Flash via Vertex |                      8/8 |                     8 |                  0 |                    8 |            $0.096182 |

**Total known estimated cost: $0.37210385**, with usage recorded for all 32
attempts, including failed outputs. Prices are the original September 10 rates;
cache discounts and invoice adjustments are excluded. All six DeepSeek failures
returned `finishReason: length` at 4,096 output tokens. This demonstrates a
failure at this configured budget, not that a larger-budget DeepSeek run would
have worse semantic quality. There was no selective retry or expanded-budget
answer substitution. Latency includes local adapter/validation time; repository
verification also ran on this machine during the smoke test. Treat recorded
latencies as diagnostic observations, not an isolated performance benchmark.

The run also found a **grader false positive**. Sonnet recorded an explicitly
conditional checklist offer with `status: candidate`, no deadline, and wording
that denied acceptance of work. Revision `2026-09-11-v2` incorrectly counted
that as a committed action. Revision **`2026-09-11-v2.1`** allows a conditional
candidate while still rejecting a confirmed commitment. Its meaning remains
subject to the semantic rubric. A red/green calibration test and a replay test
cover this distinction.

The original live report retains its embedded v2 benchmark, Sonnet's original
7/8 automatic score, and all original answers. The v2.1 summary is an explicit
**historical regrade of those same 32 answers**, making no paid calls and altering
no answer. This correction was informed by development outputs; it is not an
independent holdout result.

Luna, Sonnet, and Gemini still saturate these eight automated examples. That is
useful regression coverage but **insufficient discrimination for choosing among
them**. Their zero-width automatic bootstrap intervals do not demonstrate
semantic equivalence. All 26 valid answers await independent human review.
Seven scenario groups and one repetition cannot characterize production
reliability or the frequency of rare failures.

## Reproduction and retained artifacts

- [Original challenge answers and embedded v2 benchmark](../../evals/results/2026-09-11-v2/challenge-original.json)
- [Challenge v2.1 summary](../../evals/results/2026-09-11-v2/challenge-summary.json)
- [Historical v2.1 summary](../../evals/results/2026-09-11-v2/historical-summary.json)
- [Original provider study](provider-comparison-2026-09-11.md)

The live run records parent revision `2713c9710cbd838f488bcb9dd8e79c23c300a4a2-dirty`:
it ran from the implementation worktree before its delivery commit. Dataset,
request, plan, and source-report hashes bind the retained experiment content;
the dirty revision is not claimed to be a clean source snapshot. Regrading adds
new hashes and explicitly retains source-report provenance.

To reproduce both summaries offline and export fresh blinded review packets:

```bash
pnpm eval:quality --legacy-reports=evals/results/2026-09-11/main-openai.json,evals/results/2026-09-11/main-anthropic.json,evals/results/2026-09-11/main-deepseek.json,evals/results/2026-09-11/main-google.json
pnpm eval:quality --regrade-report=evals/results/2026-09-11-v2/challenge-original.json --cohort=challenge
```

Use a fresh output directory for every invocation. Explicit regrading invalidates
prior semantic reviews because the grading case changed. A modified source request
cannot reuse a saved answer. Do not merge this development smoke test into the
original regression condition or report repeated outputs as new meetings.

## Remaining evidence needed

No further provider keys are needed for the implemented workflow. An actual
model-quality decision still needs authorized representative meeting excerpts,
independently reviewed expected meaning, blinded human judgments, and a frozen
holdout not used for prompt/grader tuning. The tool validates provenance fields
and group splits but cannot authenticate a human or prove that a dataset was
unseen. Human labels were not manufactured to fill that gap.

The implementation provides the repeatable path for evaluating a future model.
It does not supply independent human ground truth or replace LUM-46's end-to-end
retrieval and Meeting Intelligence validation. No production winner or model
promotion follows from these development results.

## Implementation verification

Formatting, lint, and TypeScript checks pass. All **45 focused evaluation tests**
pass, including the unchanged 28 provider-adapter tests. Offline CLI checks verify
preflight without dispatch, incompatible-mode rejection, overwrite protection,
exact-output replay, and absence of configured credential values from the
published artifacts.

The last full repository run had **808 passing tests, seven skipped opt-in live
tests, and one five-second timeout** in the unchanged imported-source verifier
suite. That suite passes independently (2 tests, including the timed-out test in
1.45 seconds). Two different existing database tests timed out in the preceding
full run; both suites pass independently (50 tests) and in the last full run.
Several other test processes were active on this Mac. There is no remaining
assertion failure observed, but neither full invocation was a clean green run.
Test timeouts and unrelated implementation files were not changed to mask this
host-load caveat.
