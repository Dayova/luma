# Meeting model evaluation v2

For a separate, Notion-grounded AI assessment of saved answers, use the
[independent semantic review](ai-semantic-review.md). The [first review results](../evaluations/independent-ai-review-2026-09-11.md) preserve automatic scores and human review gates.

LUM-53 strengthens the component evaluation behind the owned `ReasoningModel`
Interface. It preserves the [v1 regression corpus and reports](provider-comparison.md)
and adds calibrated grading, harder development cases, exact-answer review packets,
and reproducible comparisons between arbitrary model IDs on the four existing
providers. Production selection is unchanged. Meeting Intelligence reconciliation,
retrieval, persistence, and Human Judgment precedence remain the separate LUM-46
end-to-end evaluation scope.

## What is measured

The committed `evals/fixtures/provider-quality-v2.json` contains **24 synthetic
development cases in 23 scenario groups**: 16 original regression cases and eight
new challenge cases. A conditional commitment and its accepted variant share one
group. The new cases cover conditional approval, late scope-limited handoffs,
Berlin's daylight-saving boundary, same-name participants, historical quotations,
a correction to a quoted bot assertion, and an unidentified speaker. Even the
longer examples are short meeting excerpts, not full production conversations.

There are **zero representative real-meeting cases, zero independent holdout
cases, and zero completed human labels** in this repository. All committed case
expectations are agent-authored. A scenario group is a resampling unit, not proof
of independent real-world sampling. Passing this corpus does not establish the
best production model.

Each answer has three separate outcomes:

1. Operational success: the API returned locally valid structured output within
   the configured deadline and output budget. API, transport, truncation, and
   validation errors remain failed attempts; missing credentials and unrun cases
   remain unmeasured.
2. Automated checks: the original predicates plus selected exact owner, date,
   count, status, and evidence checks. A citation's existence does not prove its
   meaning. The calibration tests reject known false objectors, wrong owners and
   dates, omitted/duplicate commitments, and wrong evidence, while permitting
   alternative wording. These examples test selected grader failure modes, not
   the grader's overall precision or recall against human ground truth.
3. Human semantic review: source support, commitment/modality, participant
   attribution, important recall, duplication, and language/date/identifier
   fidelity. A quality pass requires every automated check and every semantic
   judgment to pass. Missing or uncertain judgments keep review pending. An
   agent annotation is provisional even if it says every answer is correct.

The automated rules intentionally leave semantic cases to review. For example,
a question can cite a real utterance yet falsely presuppose that a suspected bug
is proven. A valid citation ID cannot resolve that error. Keep solved cases as
regression guards; add separately versioned realistic cases instead of making
old scores look worse by silently changing their definition.

## Running and extending the candidate list

Use the same ignored `.env` keys and backend settings as
[the provider comparison](provider-comparison.md). For the existing tested setup,
Google uses Vertex and Anthropic uses `prompt-json` output enforcement. Those
settings must be explicit in `.env`; the defaults remain Developer API and
`native-schema`. The runner never silently changes a model or its output mode.

```bash
# Offline validation: no model requests.
pnpm eval:quality

# Eight challenge cases × four models × one repetition = 32 requests.
pnpm eval:quality --live --cohort=challenge --max-requests=32 --repeats=1 --seed=53

# All 24 development cases × four models × three repetitions = 288 requests.
pnpm eval:quality --live --max-requests=288 --repeats=3 --seed=53
```

`evals/models/provider-quality.json` records each candidate's label, provider,
exact requested model ID, uncached input/output USD per million tokens, pricing
URL, and date verified. The committed rates are the original September 10
comparison estimates, including Google's then-applicable promotional rates and
DeepSeek peak rates. Reverify them for every later comparison and hosting route.
Missing usage is unknown, not free; recorded estimates are not provider invoices.

When a new model appears, copy this file to an ignored `.luma/quality/models.json`
and retain the incumbent plus the challenger. Multiple entries may use the same
provider. Use a distinct label for each configuration. Labels do not affect the
prompt; the optional `promptInstructions` field explicitly overrides the shared
instruction for that candidate. It must be nonblank and at most 20,000 characters.
The complete output schema is still appended by the adapter. The manifest, plan
and per-row request hashes bind the exact instruction to its saved outputs.
Omitting the field preserves the original prompt and historical hashes. No additional API keys are needed for models accessible under the existing
four provider credentials.

```bash
pnpm eval:quality --models=.luma/quality/models.json
pnpm eval:quality --live --models=.luma/quality/models.json --max-requests=144 --repeats=3 --seed=53
```

The second command assumes two models and 24 cases. Preflight validates input
and coverage but cannot establish provider access or new-model API compatibility.
Run a bounded smoke test first. All models use the existing
`provider-comparison-v1` adapter profile: identical task Evidence and
schema, and the same prompt unless an explicit prompt variant is supplied, with provider-specific reasoning/output controls. A future model that
needs another API or reasoning control needs a separately versioned adapter
profile and validation, not just a renamed ID. These settings are not equal
reasoning-compute budgets. Changing the profile, output cap, timeout, or prompt
creates another experimental condition; do not pool those runs.

Cases and candidates are interleaved in reproducible seeded order for each
repetition. Reports retain requested and returned models, content/plan/request
hashes, profile, source revision, usage, and latency. Repetitions measure output
variability; related variants and repetitions are kept together when resampling
scenario groups. Repeating one case does not create new independent cases.

Bounds: up to eight candidate configurations, 100 cases, five repetitions, and
400 dispatched requests per run; default four requests. Output cap defaults to
4,096 (maximum 16,384), deadline 45 seconds (maximum 60), and serialized request
body 32,000 bytes. No retries or automatic answer repair. A request cap can leave
an incomplete comparison, which the report exposes. These bounds do not enforce
a dollar ceiling.

A live run exits 2 for any unfinished/failed attempt or failed automated check;
exit 0 still does **not** mean semantic quality passed. Preflight, offline regrade,
and review imports exit 0 when processing succeeds, even when the resulting
report contains failures or pending reviews. Invalid setup or artifacts exit 1.

## Controlled prompt tuning

The [September 12 experiment](../evaluations/prompt-tuning-2026-09-12.md) compares
four models before and after bounded prompt tuning. Its committed protocol,
development and validation cases, prompt snapshots, selection explanations and
manifests live in `evals/experiments/prompt-tuning-2026-09-12/`. These are synthetic
validation scenarios, not independent human holdout.

After `pnpm build`, the experiment-specific coordinator can validate a frozen
stage without dispatching requests:

```sh
node --env-file=.env dist/src/evaluation/quality/prompt-tuning-main.js validation
```

`shared`, `revision`, and `validation` are the three stages. Adding `--live`
dispatches the fixed stage only if its result directory does not already exist.
The committed experiment has already run; do not delete its results to rerun it.
For new research, create a separately versioned protocol and new output paths,
or use the general `eval:quality` CLI with a fresh model manifest. Do not rewrite
published fixtures, prompts, scores, or selections.

The coordinator runs one sequential lane per provider, at most four lanes at
once, and interleaves original/selected candidates in seeded order. Its fixed
limits are 8,192 output tokens, 60 seconds, 64,000 serialized request bytes and no
retries. It journals each dispatch and saves lane checkpoints before merging
validated rows without dropping failures. A coordinator exit of zero means
artifact processing finished, not that every response or semantic check passed.
Check the summaries. Interrupted stages require inspecting their journals;
never infer that an unrecorded response was unbilled.

Freeze prompts using development results before dispatching validation. Give each
model the same number of permitted revisions and calls; preserve rejected
variants and explain selection. Compare each selected prompt with a fresh original
arm under the same limits. Keep operational failures in the denominator and AI
review separate from human labels. The AI packet withholds prompt-variant text
and identities, judging both arms under the same source-grounding contract.

## Reviewing actual answers

Each new ignored `.luma/quality/<run>/` directory contains:

- `report.json`: full benchmark, configuration, outputs, grades, and metadata.
- `report.md` and `summary.json`: coverage, operational errors, automatic versus
  reviewed passes, critical failures, latency/cost, per-dimension/per-cohort
  summaries, and matched comparisons against the first model in the manifest.
- `dispatch.jsonl`: written before each network call; an interrupted attempt may
  be billed even if the report still says not-run.
- `review-packet.json`: source utterances, task context, rubric, agent-authored
  reference notes, and outputs, with model names, metrics, and scores withheld.
- `review-template.json`: exact-answer IDs and blank review fields. Empty fields
  are deliberately invalid, and initial verdicts are uncertain.

The directory uses private permissions; report checkpoints are atomic per file.
Always choose a fresh output directory. The packet deduplicates identical
case/output pairs across models and repetitions. Give the reviewer only the
packet and template; the main report exposes model identity. Writing style and
content can still reveal a model, so this is metadata blinding, not guaranteed
anonymity. Source evidence IDs use `evidence:<caseId>:<1-based utterance number>`.

An actual human fills their reviewer ID, UTC ISO review timestamp, each verdict
(`pass`, `fail`, or `uncertain`), an explanation, and supporting evidence IDs.
Reviewers should challenge the agent-authored reference if it contradicts the
source; resolve such disagreements before treating the rubric as gold. A failed
or uncertain criterion is not a reason to rewrite the answer or discard the row.

```bash
pnpm eval:quality --report=.luma/quality/RUN/report.json --reviews=.luma/quality/reviews.json
```

`reviews.json` has the template's `{benchmarkHash, reviews}` structure. Partial
review bundles are supported; missing judgments remain pending. Reimporting a
reviewed report preserves existing labels unless an explicit replacement for the
same answer is supplied. Reviews bind to the entire case and exact output hash.
Unknown answers/evidence, duplicate rubrics, and stale reviews are rejected.
Stored automated grades are always recomputed when loading a report.

`kind: "human"` and corpus reviewer IDs are **self-attestations**, not authenticated
identities. The software cannot prove that a human wrote a label or that a dataset
was unseen. Never fill those fields with agent work and call it independent
review. Agent review uses `kind: "agent"` and cannot satisfy a semantic pass. The
current format retains one active reviewer per answer; keep independent reviewer
copies for disagreement/adjudication rather than overwriting their evidence.

## Independent holdout and promotion decisions

For an actual production decision, recruit a domain reviewer and create a
separate private corpus from authorized, redacted meeting excerpts. Include
ordinary representative traffic and important rare cases. Cover real languages,
lengths, ambiguity, speaker uncertainty, and source distributions. Freeze the
case selection, expected meaning, rubric, and decision criteria before seeing
candidate answers. Do not choose difficult examples solely because Luna fails.

Use a distinct dataset ID/revision, `provenance: "human-reviewed-meetings"`, and
per-case `independentReview: {reviewerId, reviewedAt}` with a reviewer different
from the case author. Use `cohort: "representative"` for ordinary traffic and
`challenge` for selected stress cases. Assign related excerpts/variants to the
same `groupId`; groups cannot cross development and holdout. `split: "holdout"`
is rejected in the committed synthetic-development dataset. These are structural
checks, not a substitute for holding the private test data out of tuning.

```bash
pnpm eval:quality --corpus=.luma/quality/private-holdout.json --models=.luma/quality/models.json
# Explicit opt-in to send the supplied reviewed meeting data to the configured APIs.
pnpm eval:quality --live --allow-reviewed-data --corpus=.luma/quality/private-holdout.json --models=.luma/quality/models.json --max-requests=200
```

For each future challenger:

1. Freeze the incumbent, candidate profile, prices, dataset, and application
   acceptance criteria before running. Define what quality improvement or
   acceptable loss would justify a cost/latency change and which critical errors
   block promotion.
2. Run matched cases at fixed budgets. Diagnose operational failures separately;
   keep failed attempts in the task-success denominator. Do not quietly retry
   only the losing model or combine expanded-budget answers with the main run.
3. Review blinded answers and inspect critical failures and each cohort/dimension.
   Compare quality, reliability, latency, and cost rather than just one score.
4. The report computes challenger-minus-incumbent success differences with equal
   scenario-group weights. Exploratory 95% percentile bootstrap intervals resample
   whole groups (2,000 draws). A reviewed interval is unavailable until every valid
   paired answer has complete human judgments; errors count as unsuccessful
   attempts. Unrun pairs suppress intervals. Report uncertainty, including sample
   selection and grader uncertainty that the bootstrap cannot capture. A zero-width
   interval on a saturated or tiny test is not proof of equivalence. Comparing many
   challengers is exploratory; this tool does not correct for model-selection bias.
5. If the result cannot distinguish candidates, collect fresh independently
   labeled meetings. Choose sample size around the smallest meaningful effect;
   there is no universal sufficient case count. Once a holdout informs tuning,
   retire it into regression and obtain a fresh holdout. Finish end-to-end checks
   and a separately authorized production rollout before changing the default.

## Regrading the first comparison

This uses already saved answers, makes **zero API calls**, and writes new artifacts:

```bash
pnpm eval:quality --legacy-reports=evals/results/2026-09-11/main-openai.json,evals/results/2026-09-11/main-anthropic.json,evals/results/2026-09-11/main-deepseek.json,evals/results/2026-09-11/main-google.json
```

The importer requires compatible historical settings and exact request hashes.
All 16 old cases are checked under v2. The eight new cases stay unrun; their
expected answers are never invented. Source report hashes identify the originals.
Historical requests retain their old usage and latency and were **not** run in
the new seeded order. Regrading is diagnostic, not fresh independent validation.
See [the v2 results](../evaluations/provider-quality-v2-2026-09-11.md).

For a new grading revision of saved v2 answers, use an explicit regrade:

```bash
pnpm eval:quality --regrade-report=evals/results/2026-09-11-v2/challenge-original.json --cohort=challenge
```

This writes a new historical-regrade report, binds it to the source report hash,
and drops prior semantic labels. It reuses only answers whose task request hash
still matches; a changed utterance or prompt requires a new run. The original
embedded benchmark and scores remain in the source report. The committed corpus
is revision `2026-09-11-v2.1`, which fixes the conditional-candidate false positive
found during the first v2 development run.
