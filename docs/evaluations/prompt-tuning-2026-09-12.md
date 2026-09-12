# Controlled prompt tuning — 12 September 2026

This experiment tests whether better instructions improve Luma's meeting proposals across four model configurations. It preserves the original results and production behavior. The report separates operational success, automatic checks, independent AI opinions, and human review.

## Frozen design

[Protocol](../../evals/experiments/prompt-tuning-2026-09-12/protocol.json) and both corpora were committed at `7e527af` before any development call. Each model received the same shared prompt and one adaptive revision capped at 250 added words, tested on four development scenarios once per variant. The revisions add 92–109 words. Selection prioritized operational/automatic failures, then the coordinating agent's source-grounded semantic errors and omissions, retaining the shared prompt on ties. This is bounded tuning, not a search for each model's optimal prompt.

The [selection record](../../evals/experiments/prompt-tuning-2026-09-12/selection.json) and validation manifest were committed at `f254f31` before any validation dispatch. Luna, Sonnet and DeepSeek selected the shared instruction; Google selected its revision. Each selected instruction is compared with the exact original instruction on eight newly authored scenarios, twice each: 16 attempts per arm/model, 128 validation calls plus 32 development calls. All calls use 8,192 output tokens, 60 seconds, 64,000 serialized request bytes and no retries. Four provider lanes run concurrently, each sequential, with seeded interleaving of the two arms. Provider reasoning settings remain medium/adaptive-medium/MEDIUM/high as in the original adapter profile; equal token limits do not equalize reasoning compute.

The scenarios cover an uncertain cause with accepted investigation, collective decision revision with explicit personal dissent, an unidentified accepted owner beside a known owner, resolved deadlines with separate unresolved launch/budget questions, undecided work need, a Berlin midnight/daylight-saving boundary, quoted hostile instructions, and partial scope acceptance. Cases and scoring rules are not edited after validation outputs appear.

These are synthetic validation cases written by the same coordinator who writes the prompts. The shared instruction explicitly assumes Europe/Berlin and is not a validated prompt for every workspace timezone. The freeze prevents tuning on validation outputs; it does not create independent human holdout or representative production traffic. The source families overlap intentionally with development. Both repetitions of a case are correlated. The component receives utterances and the output contract, empty additional context and no retrieval tools. This does not test full meetings, Notion retrieval, reconciliation, persistence, approved execution, or audio transcription.

## Validation: usable outputs, automatic checks and runtime

All denominators below are **16 attempted responses per arm**. Each cell shows original → selected prompt. Automatic success requires a usable answer and all automatic checks; it is not a semantic or human-quality pass. Median latency includes failed attempts. Costs include all attempts with known usage, including unusable outputs.

| Model configuration            | Usable answers | Automatic passes | Median attempt latency | Known uncached cost |
| ------------------------------ | -------------: | ---------------: | ---------------------: | ------------------: |
| GPT-5.6 Luna                   |        16 → 16 |          13 → 16 |        11.27 → 11.12 s |   $0.0356 → $0.0372 |
| Claude Sonnet 5 / prompt JSON  |         12 → 8 |            8 → 7 |        15.79 → 14.25 s |   $0.4084 → $0.4503 |
| Gemini 3.8 Flash / Vertex      |        15 → 11 |          15 → 11 |        14.36 → 30.33 s |   $0.1873 → $0.3578 |
| DeepSeek Flash / high thinking |        13 → 14 |          12 → 14 |        26.88 → 25.55 s |   $0.1339 → $0.1352 |

Google's cost coverage is 15/16 original and 14/16 selected attempts; the three HTTP 429 responses have unknown usage. Other validation arms have usage for all 16 attempts. Total known provider cost across development and validation is **$2.10463835 for 156/160 attempts**, using the saved rates below. Four rate-limit responses across the experiment lack usage. These totals exclude Codex work and review resources.

Luna's original prompt left dates unnormalized in three responses despite meeting-date context; the selected prompt passed those checks in both repetitions. Sonnet's original arm had three `unknown-evidence` failures and one `invalid-json-or-schema`; selected had eight `invalid-json-or-schema` failures. Its remaining automatic failures involve date normalization and omissions. These are concrete model-plus-adapter results, not proof that all Sonnet deployments behave this way. The saved error category does not identify each underlying schema violation.

Google's selected arm had three `MAX_TOKENS` responses, each spending most recorded output tokens on reasoning, plus two HTTP 429 responses; original had one HTTP 429. DeepSeek had three original and two selected `length` failures. Failed answers were not repaired or retried. The difference between Google development and validation illustrates why a single successful tuning round cannot establish reliability. Seeded arm order reduces ordering bias but does not eliminate service variability or small-sample noise.

The [raw validation report](../../evals/results/2026-09-12-prompt-tuning/validation/combined.json) retains all 128 attempts and exact metadata. Lane reports compare each provider's original and selected arms. The combined generic report also contains cross-model comparisons; the experiment's primary comparisons are the within-provider pairs shown here.

## Development selection

All 30 valid development responses passed the automatic checks; two attempts failed operationally. The source review still found omitted dependencies, unsupported personal stance, stronger causal claims in titles, and reopened answered questions. The detailed coordinator judgments remain separate from independent AI and human labels.

- Luna's revision restored support availability but introduced personal supporter attribution from meeting-state reporting. Shared was retained under the frozen rubric interpretation.
- Sonnet's revision fixed the short collective-decision case but retained other stance errors and asked whether support was promised after the source explicitly said it was not. Shared was retained.
- Google had one HTTP 429 in shared and none in revision, so the first selection criterion chose revision. This does not establish that prompting fixed the rate limit. Unsupported stance remained in the revision's long case.
- DeepSeek's revision fixed several semantic errors in its three completed cases, but one case spent all 8,192 tokens on reasoning and ended with `length`, without a usable answer. Shared completed all four and was retained.

The development quoted-example wording (“Nein, derzeit gibt es keinen beschlossenen Migrationsbedarf”) permits disagreement about whether a future need question remains open. Coordinator recall judgments on it were marked uncertain and did not decide selection. The fresh validation counterpart explicitly distinguishes undecided need from a decision that work is unnecessary.

## Cost basis

The [pricing audit](../../evals/experiments/prompt-tuning-2026-09-12/pricing-audit.json) rechecked the public rates on September 12 without changing the frozen manifests. Saved estimates use uncached USD per million tokens: Luna 0.20/1.20, Sonnet 2/10, Google global standard promotional 0.75/3.75, and DeepSeek conservative peak 0.30/1.20. DeepSeek's published Saturday rates are half the saved peak estimate. Unknown response usage is unknown cost, not zero, and cached input can reduce actual billing. Evaluation totals exclude Codex reviewer/implementation resources and are not invoices.

Sources: [Luna pricing](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Vertex pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing), [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/).

## Reproduction and scope

The [configuration guide](../configuration/provider-quality.md#controlled-prompt-tuning) describes prompt variants and the experiment coordinator. Exact model manifests, prompt snapshots, request hashes, dispatch journals, lane reports and combined reports are committed under `evals/experiments/prompt-tuning-2026-09-12/` and `evals/results/2026-09-12-prompt-tuning/`. The coordinator refuses an existing stage directory, including an interrupted one, to prevent accidental paid replay. Earlier reports and production prompts are unchanged.

The runner supports an optional per-candidate `promptInstructions`. It keeps the task data and complete output schema fixed and binds the instruction to plan/request hashes. Omitting it reproduces historical hashes. Fresh anonymous AI review uses the existing six-criterion rubric and frozen Notion brief under the common original contract; candidate prompt text is withheld to avoid revealing the arm. Human labels remain untouched.
