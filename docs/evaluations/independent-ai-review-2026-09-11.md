# Independent AI review — 11 September 2026

Two fresh Codex reviewers found semantic problems that the automatic v2.1 checks did not catch. This strengthens the evaluation, but it does not establish a production winner. Both reviewers used the current task's inherited model; the runtime did not provide a verified API model identifier. They were separate sessions with no prior conversation, not reviewers from two independent model providers.

## Scope and product grounding

Each reviewer judged all **26 valid answers** from the eight-case challenge run across OpenAI, Anthropic, Google and DeepSeek, plus five blinded calibration answers. Each answer received all six semantic judgments: **186 judgments per reviewer**, including 30 control judgments. Candidate names, prices, automatic scores, case-author reference notes and expected control labels were withheld. Reviewer A read answers in sorted anonymous order, B in reverse order. They did not exchange findings before finishing. The shared filesystem was available, so blinding was instructed rather than enforced by access isolation.

The frozen [context brief](../../evals/context/luma-ai-review-2026-09-11.json) synthesizes selected relevant sections from Luma's Notion requirements. The organizational objective and evidence rules come from the [Luma overview](https://www.notion.so/39f2e87228bf81bcbce2d45921dd4e18). The distinction between the person speaking and the person accepting work comes from [Speaker Attribution & Ownership Reliability](https://www.notion.so/3b62e87228bf8128ab4bf3ba6b0c5b40). Proposal, decision and reversal semantics come from [Decision Intelligence](https://www.notion.so/3d52e87228bf81f98d79c1233431c8bd). Authority, practical clarification and safe execution constraints come from [Operating Decisions & Pilot Gates](https://www.notion.so/3d52e87228bf817c9c67e015df3ddf23). Repository context and architecture decisions were also checked when preparing the brief.

This is a bounded synthesis, not an audit of every Notion page. Source edit timestamps, retrieval time and raw text hashes are recorded; Notion marked these pages unverified and did not report truncation/unknown-block counts. The brief and controls are agent-authored, not human gold. Notion was reviewer context only: candidates received the original utterances and output contract, empty additional context and no retrieval tools. Current production capabilities must not be inferred from this component test's limitations or from dated status notes in Notion.

## Results

An answer passes only when every semantic criterion passes. One failure makes it fail; otherwise an unresolved criterion makes it uncertain. These are raw AI opinions, separate from the unchanged automatic results and human labels.

| Saved candidate  | Valid / attempted | Reviewer A: pass / fail / uncertain | Reviewer B: pass / fail / uncertain |
| ---------------- | ----------------: | ----------------------------------: | ----------------------------------: |
| GPT-5.6 Luna     |             8 / 8 |                           7 / 0 / 1 |                           7 / 0 / 1 |
| Claude Sonnet 5  |             8 / 8 |                           4 / 3 / 1 |                           4 / 3 / 1 |
| Gemini 3.8 Flash |             8 / 8 |                           6 / 1 / 1 |                           6 / 1 / 1 |
| DeepSeek Flash   |             2 / 8 |                           1 / 0 / 1 |                           1 / 1 / 0 |

DeepSeek's six earlier output-limit failures remain operational failures; they have no valid answer to judge. Its two-answer semantic result is not comparable to an eight-answer score. The first three models had passed all eight automatic checks. No human-reviewed passes were added. The separate 173 historical answers were not reviewed in this round.

Both reviewers matched **15/15 expected calibration labels across five controls**: a correct commitment, an equivalent paraphrase, an incorrect owner, a duplicated task and an unsupported causal assumption. Those three deliberately bad controls are not failures by evaluated models. The controls are simple and correlated; passing them does not establish judge accuracy. They are now published development data and should be replaced for future blinded calibration.

The reviewers agreed on **149/156 real-answer rubric judgments (95.5%)**, with seven disagreements retained verbatim. These correlated judgments are not 156 independent experiments or an accuracy estimate. Same-model reviewers may share mistakes or favor outputs from their own model family.

## Findings worth acting on

The coordinating agent inspected the cited source/output pairs after both reviews were complete; this interpretation is not a third independent vote.

- **Sonnet reopens settled questions in both rollout cases.** The source explicitly calls 18 September a board wish date. The answer asks whether it is a firm deadline or a wish. In the accepted variant, the later firm deadline applies only to checklist writing, not deployment. Both reviewers mark the resulting date ambiguity as a failure.
- **Sonnet adds a purpose to a follow-up title.** The source discusses daylight saving to resolve when a `clock.ts` test is due. The proposed ticket title makes daylight saving the subject of the test. Both reviewers flag unsupported scope; the date itself is correct.
- **Gemini strengthens an undecided statement.** “No decided migration need” becomes “no current need for migration.” Both reviewers flag the lost qualification. The answer correctly avoids creating a migration task.
- **The version question exposes an ambiguous fixture.** “Yesterday's build” answers a version question, but the source does not settle whether a precise version identifier is still needed. All three complete candidates receive one uncertain answer here, including Luna. Clarify the fixture with an explicit acceptance or rejection of that answer before treating this as a scored distinction.
- **DeepSeek's extra identity question is disputed.** One reviewer considers “who owns this?” plus “was it Jo?” redundant; the other leaves it uncertain. Keep the disagreement for human adjudication.
- **The schema conflates commitment and owner resolution.** Both reviewers identify the same representation gap in an unidentified-speaker case. A definite spoken commitment can have an unresolved owner. Preserving that distinction in prose with a null owner is not automatically an answer failure. A proposed follow-up also does not prove that any external write occurred.

Some failures are marked critical because the existing rubric labels source support or commitment fidelity critical. That is criterion severity, not a separately assessed real-world incident severity. Do not equate a proposed title error with an executed unauthorized mutation.

## Reuse and limitations

The [review procedure](../configuration/ai-semantic-review.md) prepares frozen packets and validates review rounds for future candidates. [Raw reviewer A](../../evals/results/2026-09-11-ai-review/reviewer-a.json), [raw reviewer B](../../evals/results/2026-09-11-ai-review/reviewer-b.json) and the [summary](../../evals/results/2026-09-11-ai-review/summary.json) retain explanations, source references, exact answer IDs, calibration outcomes and all disagreements. Packet hash: `ac421c4865814da1bffd006154e117b4b6a5934ad0886eab9f45a86894a582a9`.

For a future model, review its answers beside the incumbent under the same frozen conditions, add a capable judge from another provider for stronger model diversity, and use human adjudication plus genuinely unseen meeting cases before a deployment decision. This round reused saved outputs and made no new paid provider evaluation requests; the Codex reviews themselves still used the current session's resources. No additional credentials or production model change were needed.
