# Independent AI semantic review

AI review supplements the automatic checks and human review in `eval:quality`. It judges the saved answers, with their original source utterances and output contract, against a frozen, cited product brief. It makes no provider requests and never changes the production model, original outputs, automatic scores, or human labels.

## Prepare a review

Start with a validated quality report. To reproduce the September 11 challenge review from committed artifacts:

```sh
pnpm eval:quality --regrade-report=evals/results/2026-09-11-v2/challenge-original.json --cohort=challenge --output-dir=.luma/quality/reproduce-ai-review
pnpm eval:ai-review --report=.luma/quality/reproduce-ai-review/report.json --output-dir=.luma/ai-review/new-packet
```

Directories must be new. The second command produces `packet.json` and `controller.json`. Give reviewers **only `packet.json`**. The controller contains control labels and separates evaluated answers from calibration answers. The packet hides candidate identities, prices, scores, case-author reference notes, and control labels. It includes the original output contract, exact utterances, complete outputs, six semantic criteria, and a Notion-grounded requirements brief. Every review is bound to its complete packet hash.

For another product revision, supply `--context=PATH` and `--controls=PATH`. Freeze them before inspecting the candidate results. Record source URLs, retrieval time, page edit metadata, content hashes, the sections read, and requirements that apply only to the larger pipeline. Keep private full-page snapshots out of Git. Notion context helps the judge understand Luma; it does not give the candidate retroactive knowledge or tools.

## Reviewer procedure

Use fresh capable-model sessions with no earlier discussion, results, model names, controller, or other review. Ask two reviewers to inspect the same packet independently; reverse answer order for the second. Provide these instructions:

> Review every answer against every supplied criterion, using its source utterances as Evidence and the product principles as interpretation context. Preserve uncertainty, modality, ownership, corrections, resolved questions, dates, and technical identifiers. Accept equivalent paraphrases. Distinguish an answer error from a questionable rubric or a capability the supplied schema/pipeline cannot express. Proposed follow-up intentions are not executed writes. Do not assume organization facts, source retrieval, or tools unavailable in the candidate contract. Return one JSON round conforming to `aiReviewRoundSchema`, with agent attribution, the exact packet hash, a judgment and explanation for every answer/criterion, valid Evidence IDs, and findings linked to product principle IDs. Use `uncertain` when the source does not settle the interpretation. Do not inspect other files or reviews.

`aiReviewRoundSchema` is exported by `src/evaluation/quality/ai-review.ts`. A round includes `version: 1`, `packetHash`, `reviewer` (`id`, `system`, `model`, `freshContext`, `metadataBlinded`), `reviews` and `findings`. Each review has `answerId`, `reviewer: {id, kind: "agent"}`, `reviewedAt`, and `judgments: [{rubricId, verdict, explanation, evidenceIds}]`. Verdicts are `pass`, `fail`, or `uncertain`. Findings contain `answerId`, `kind` (`answer-error`, `rubric-concern`, or `capability-gap`), `rubricId`, `explanation`, `evidenceIds`, and `principleIds`. Evidence IDs are `evidence:<caseId>:<one-based utterance index>`.

Record the actual model identity when the runtime exposes it. Otherwise record that it is unknown or inherited; do not invent an API model ID. Freshness and blinding fields are procedural attestations, not proof of filesystem isolation. Reviewers sharing a model family can share bias. For stronger provider independence, repeat this procedure with a capable model from another provider and preserve that provenance separately.

## Validate and compare

```sh
pnpm eval:ai-review --report=.luma/quality/reproduce-ai-review/report.json --reviews=evals/results/2026-09-11-ai-review/reviewer-a.json --reviews=evals/results/2026-09-11-ai-review/reviewer-b.json --output-dir=.luma/ai-review/reproduced-summary
```

This validates complete, unique coverage, source/rubric references, unchanged source evidence and output content, context hashes, and agent attribution before creating files. `summary.json` reports each reviewer's pass/fail/uncertain counts, critical failures, operational failures, controls, per-answer attribution, and disagreements. The controller is regenerated from the supplied control fixture, and its expected labels have a separate calibration hash. Hashes detect mismatch; they do not authenticate authorship. Review timestamps and model identities are self-reported.

A semantic pass requires all criteria to pass; any failure makes that answer fail; otherwise it is uncertain. Calibration failures are retained visibly. Existing human pass counts remain unchanged. Do not silently merge agent opinions into human labels, count uncertain as correct, or select a winner across unmatched case coverage. Agreement across correlated rubric judgments is descriptive, not an accuracy estimate.

For a new candidate, keep the model inputs, budget profile, corpus revision, reviewer context, and grading rules fixed. Review the incumbent's and candidate's outputs together under anonymous IDs; inspect matched cases and operational performance separately. Resolve material disagreements with human source review. Add genuinely new, human-reviewed held-out meetings and fresh hidden controls before using the benchmark for a deployment decision. Once published or used for tuning, these synthetic cases and controls are development data, not an unseen test set.
