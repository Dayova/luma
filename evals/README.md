# Meeting product evaluation

Run `pnpm eval:meeting` from the repository root. It builds and consumes the
versioned `fixtures/meeting-corpus.json` and `fixtures/meeting-samples.json`, then
writes a JSON report to stdout. `pnpm eval:meeting --output /absolute/report.json`
creates a new report with mode 0600 and refuses to overwrite an existing one.
No API key, provider credentials, production data directory, or network request
is used. `pnpm verify` exercises the same corpus through the evaluation tests.

The evaluation calls the real public Meeting Intelligence `observe`, `query`,
and `conclude` interfaces using fresh in-memory PGlite. Only the model and
read-only Work Catalog are programmable. Synthetic imported-source verification
is an explicit test adapter; this does not prove a real Notion ledger or an
external integration. There is no provider-write adapter in this runner.

The four original source fixtures and named expectations are retained. The new
structured proposal samples and additional assertions are agent-authored
synthetic annotations, **not human-labeled or live model output**. They evaluate
observable domain behavior and strict source-anchored regression expectations.
Matching a reference sample does not measure a model's ability to produce it.
Human review can add accepted paraphrases or richer annotations in a versioned
corpus change; a model cannot rewrite its own expected answers.

Measured scenarios cover German, English and mixed wording, ownership and
uncertainty, relative dates with a fixed Berlin reference date, unapproved work,
Human-corrected ownership (Jakob owns Luma despite a provisional CTO title),
retained old valid decisions, current versus superseded or unaccepted choices,
explicit history, bounded scoped answers, and canonical-work reconciliation
including a catalog outage. Mutation tests inject wrong owners, erased modality,
fabricated implementation claims, and obsolete current answers and require the
scorer to fail. An absent output cannot pass a negative assertion.

Every named expectation must have either an executable assertion or a specific
`missing` capability entry. Normal evaluation exits nonzero for measured
regressions. `pnpm eval:meeting:complete` additionally fails for any missing
capability and currently **must fail**. The report's `productReadiness` remains
`not-demonstrated` while gaps exist; a green deterministic CI run is not a
production-readiness claim.

Current missing evaluation adapters cover code-context linkage, cross-Meeting
recall, cross-provider ranking, duplicate context, revoked/deleted sources
through derived views, and bounded organizational input/output with explicit
coverage limits. These entries specify the scenario an actual retrieval adapter
must demonstrate. They must only become executable assertions once that real
public capability exists; replacing `missing` with a hardcoded pass is invalid.

The report records exact corpus and sample hashes, sample provenance, model and
prompt versions, fixed workspace configuration, each observed result, per-check
outcomes, and usage. Relevant-current recall and stale-claim inclusion are
reported separately for their annotated facts. Input/context characters are
measured independently and are not tokens. Zero context does not count as an
optimization or a retrieval success. No aggregate score blends these measures.

Live provider quality and billed token usage remain **unmeasured**. There is no
paid mode hidden behind an environment variable; this command cannot spend the
production AI allowance. A future explicitly requested live run needs a scoped
fixture selection, durable budget reservation and hard cap through the existing
AI budget port, and immutable request/response records with model/configuration,
usage, returned model and prompt/source hashes. It must score against unchanged
annotations and report unavailable provider results separately. Live source
permissions, provider correctness, deployment operation, and subjective product
quality require their own evidence; deterministic replay does not substitute
for them.
