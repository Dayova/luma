# Comparing meeting reasoning providers

LUM-51 provides a bounded **component evaluation** of the `ReasoningModel`
Interface. It compares proposed Meeting Items before deterministic Meeting
Intelligence reconciliation. It is separate from LUM-46's end-to-end product,
retrieval and Human Judgment evaluation. Production provider selection is not
changed by installing or running this command.

## Run

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm eval:providers
```

The default is an offline preflight. It validates the synthetic corpus and
writes a report with credential availability and planned coverage. No requests
are sent and no model quality scores are generated.

Configure any available keys in the ignored local `.env` or process environment:

| Candidate           | Environment variable                   |
| ------------------- | -------------------------------------- |
| OpenAI Luna         | `OPENAI_API_KEY`                       |
| Anthropic Sonnet    | `ANTHROPIC_API_KEY`                    |
| Google Gemini Flash | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) |
| DeepSeek Flash      | `DEEPSEEK_API_KEY`                     |

Keys must be usable API credentials with access to the named model. Browser/chat
subscriptions do not supply these credentials to this command. The program does
not create accounts, enable billing, change provider quotas, or read production
meeting stores. Do not commit credentials.

Start with a four-request smoke comparison: one case per configured provider.

```bash
pnpm eval:providers --live --max-requests=4
```

A full single repetition of the 16 cases across four providers takes at most 64
requests. Three repetitions take at most 192:

```bash
pnpm eval:providers --live --max-requests=64
pnpm eval:providers --live --max-requests=192 --repeats=3
```

Select fewer providers if only some credentials are available:

```bash
pnpm eval:providers --live --providers=anthropic,google --max-requests=32
```

Requests are sequential, ordered by repetition, fixture, then provider. This
keeps limited runs on comparable cases instead of exhausting one provider's
whole corpus first. A cap may still leave unequal coverage; compare matching
fixture/repetition pairs. A live run exits 2 when any case is missing, unrun,
limited, or failed; exit 0 means all requested cases produced validated output,
**not** that semantic checks passed. Invalid setup exits 1.

For a separately reported budget-sensitivity run, select fixed fixtures and raise
only the output limit (maximum 16,384). For example, each selected provider gets
three repetitions of the four stress cases:

```bash
pnpm eval:providers --live --providers=deepseek --max-requests=12 --repeats=3 --max-output-tokens=8192 --fixtures=long-owner-handoff,long-decision-correction,berlin-midnight-deadline,long-quoted-injection
```

Keep these results separate from the 4,096-token run. A truncated response remains
a failure in the original condition, even if the larger-budget run completes.

## Anthropic schema compilation compatibility

The live Sonnet 5 API rejected this full contract with a compiled-grammar-size
error. Reordering the discriminant, factoring references, and rewriting nullable
unions did not resolve it. Removing the Follow-up Intent union did, but that
changes the task and is unsuitable for evaluation.

Set `LUMA_EVAL_ANTHROPIC_OUTPUT=prompt-json` to explicitly omit native output
schema enforcement for Anthropic. The full original contract remains in the
identical shared prompt and strict local validator; no fields, follow-up types,
checks or reasoning settings are removed. Invalid JSON, schema violations and
unknown citations remain failures; there is no automatic repair or fallback.
The default remains `native-schema` for reproducibility. Reports record the mode.

This compares deployable adapter configurations, not identical native decoding
constraints across vendors. Report this difference alongside any quality/cost
result. Diagnostic schema variants are never pooled into scored evaluation runs.

## Google through Vertex

To evaluate the same `gemini-3.8-flash` model through Vertex, use:

```dotenv
LUMA_EVAL_GOOGLE_BACKEND=vertex
VERTEX_API_KEY=
VERTEX_PROJECT_ID=
```

Put the key in the ignored local `.env`. Leave `VERTEX_PROJECT_ID` empty for
an Express mode key; for a project-scoped Vertex authorization key, set the
Google Cloud project ID or number. Both routes use the global endpoint.
This adapter accepts API keys, not service-account JSON files or OAuth tokens.
The default backend remains `developer`, using `GEMINI_API_KEY`/`GOOGLE_API_KEY`.
Selecting Vertex never falls back to a Developer API key or a different model.

Vertex receives the identical Evidence, prompt, native schema, medium thinking
setting, output-token cap and timeout as the Developer API candidate. Tests
compare the complete outbound bodies across both routes. Reports identify the
backend, Express/project scope and applicable pricing source, and retain the
returned model version. A key with no access to the requested model produces an
explicit failure; the command does not substitute a weaker model or prompt.

This preserves the evaluation design, but does not establish identical outputs
across hosting routes. Latency, quotas, safety behavior and billing can differ.
Treat a Vertex result as a result for Gemini served through Vertex. Live access
must still be verified before claiming the integration works. Google's published
global introductory input/output rates match the Developer API rates used here;
account-specific credits and discounts are excluded.

- [Vertex Gemini 3.8 Flash model and thinking settings](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash)
- [Vertex Express API routes](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/express-mode/api-reference)
- [Vertex pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)

## Bounds and accounting

Each request has a 32,000-byte serialized body limit, a default of 4,096 maximum output tokens,
a 45-second deadline, and no automatic retries. The CLI defaults to four total
requests, accepts at most 200, and allows one to five repetitions. These are
request/token limits, not a hard USD billing cap; use the provider's own account
spend controls when a financial ceiling is required.

Reports include latency, returned model/version, response ID, completion status,
reported token usage, and an uncached cost estimate. Google thinking tokens are
included in billable output; Anthropic cache-read/write inputs are included in
total input. Missing or malformed usage remains unknown. Timeout and HTTP
failures may still incur charges. Reported usage survives schema/citation
validation failures and incomplete outputs.

Prices were checked on 10 September 2026. Estimates deliberately do not apply
cache discounts, use DeepSeek peak prices, and use Google's promotional price
through 31 December 2026. They are not invoices or claims of identical token
counts between providers. Reverify the candidate rate table before later runs.

## Fairness and interpretation

All candidates receive the same serialized Evidence, workspace timezone, language
policy, instructions and full JSON schema. The schema and instructions are
shared with the production OpenAI adapter; the comparison adds an identical
JSON-schema instruction for all candidates so DeepSeek's JSON mode receives the
same contract. This is a comparison prompt, not a byte-identical replay of
production requests. Expected checks and manual rubrics are never sent.

| Candidate          | API                       | Reasoning                          | Output enforcement                     |
| ------------------ | ------------------------- | ---------------------------------- | -------------------------------------- |
| `gpt-5.6-luna`     | OpenAI Responses          | medium                             | strict JSON Schema                     |
| `claude-sonnet-5`  | Anthropic Messages        | adaptive, medium effort            | JSON Schema                            |
| `gemini-3.8-flash` | Google generateContent    | medium                             | JSON Schema                            |
| `deepseek-flash`   | DeepSeek Chat Completions | enabled, high (its medium mapping) | JSON object mode plus local validation |

These settings do not establish equal reasoning compute. Anthropic/Google receive
a native schema with string/array minimum and format constraints omitted for
compatibility; all original constraints remain in the shared prompt and local
validator. Invalid output is an error, never silently repaired or retried.

The 16 cases and their expected predicates are **agent-authored synthetic data,
not human-labeled evaluation ground truth**. They cover commitments, explicit
refusals, withdrawn offers, speculative proposals, corrected Decisions,
relative/negated deadlines, unresolved ownership, code identifiers, open
questions, quoted prompt injection, and mixed-language ownership separation.
Four additional stress cases cover longer distracting conversations, late owner
and decision corrections, a Berlin/UTC midnight boundary, and quoted attacks.
There are 40 automated predicates per full repetition.

Automated checks count matching fields, statuses and lexical alternatives. They
can miss nuanced errors or reject valid paraphrases. Citation-ID validation
proves that an ID exists, not that its sentence supports the claim. Every case
has a manual-review rubric; inspect raw outputs against it before choosing a
provider. No external model grades its own competitor and no automatic winner is
reported. Include human-labeled, representative samples and matched repetitions
before making a production quality/cost decision. Retrieval quality, full
conversation answering and provider writes are outside this component evaluation.

## Artifacts

Every run creates a new ignored `.luma/provider-comparison/<run>/` directory:

- `report.md`: coverage, failures, automated-check counts, latency and cost summary.
- `report.json`: per-case outputs, checks, configuration, source commit and hashes.
- `dispatch.jsonl`: written before each attempt; interrupted attempts may be billed.

Reports are checkpointed after each result. An existing output directory with a
dispatch journal cannot be reused, preventing accidental overwrite. Prompt text,
API keys, provider error bodies and reasoning traces are excluded from reports;
validated synthetic proposal text is retained for review. Interrupted journal
entries must be reconciled with provider usage before interpreting total cost.

## API and price references

- [OpenAI Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Google generateContent API](https://ai.google.dev/api/generate-content)
- [Google Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- [Google pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [DeepSeek JSON output](https://api-docs.deepseek.com/guides/json_mode/)
- [DeepSeek thinking controls](https://api-docs.deepseek.com/guides/thinking_mode/)
- [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/)
