# Meeting and organizational retrieval product evaluation

Run `pnpm eval:meeting` from the repository root. It builds and consumes the
versioned `fixtures/meeting-corpus.json` and `fixtures/meeting-samples.json`, then
writes a JSON report to stdout. `pnpm eval:meeting --output /absolute/report.json`
creates a new report with mode 0600 and refuses to overwrite an existing one.
No API key, provider credentials, production data directory, or network request
is used. `pnpm verify` exercises the same corpus through the evaluation tests.

The evaluation calls the real public Meeting Intelligence `observe`, `query`,
and `conclude` interfaces, plus Context Intelligence `inquire` and delivery
revalidation backed by the real Organizational Context implementation. All use
fresh in-memory PGlite. Only external models and read-only catalogs are
programmable. Synthetic imported-source verification is an explicit test adapter;
this does not prove a real Notion ledger or an external integration. There is no
provider-write adapter in this runner.

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

Ten additional retrieval scenarios exercise:

- Old still-valid Human-confirmed ownership ahead of a newer unaccepted CTO
  proposal, with superseded facts excluded from current answers.
- Equivalent sources across normalized catalogs consuming one context entry,
  with duplicate references preserved as citations and no extra authority.
- Revocation for one of the four recipients or provider deletion denying cached
  answers, final delivery and fresh derived claims. Stored evidence hashes must
  remain unchanged; retaining a snapshot does not grant permission to disclose it.
- A source revoked while the model is running producing a non-deliverable cached
  result; replay cannot rerun the model or release that answer.
- New source discovery invalidating an old receipt; a fresh inquiry sees the
  newly discovered source with its original disputed status.
- Bounded source excerpts and Discord output, explicit truncation/omission,
  partial external search and an honest no-configured-catalogs result.
- A current revised decision and an exact historical query retrieving the old
  retained revision, visibly marked historical and excluding future revisions.

Every Context operation recreates both services from persisted state. The
`selected-evidence-echo-v1` adapter echoes only the evidence actually selected by
the core, including standing and authority. It never reads expected assertions.
This measures selection, provenance and invalidation behavior; it does **not**
measure whether a live model understands a proposal or produces a good answer.
Mutation tests change source standing/content, remove revocation/deletion or
new-discovery events, disable the midflight change and relax excerpt budgets.
They require the corresponding quality and invalidation assertions to fail.

Every named expectation must have an executable assertion, a validated
`coveredBy` link to an executable retrieval scenario, or a specific `missing`
capability entry. Linked checks are counted once. Normal evaluation exits nonzero for measured
regressions. `pnpm eval:meeting:complete` additionally fails for any missing
capability. The report's `productReadiness` remains `not-demonstrated` while gaps
exist, and becomes `only-declared-corpus-demonstrated` when all declared checks
pass. A green deterministic run is not a production-readiness claim.

The version-four corpus adds a real GitHub CodeProvider/catalog/Context Ask
scenario, using deterministic HTTP responses and original literal code bytes.
The transport honors the actual search phrase instead of returning every fixture.
It verifies pinned citations, unchanged questions, persisted replay, head-change
refusal without another model call, source grant revocation and retained snapshots.
Mutation tests remove matching code, the head change and revocation and require
the corresponding checks to fail. This runs actual adapters but no live network;
its source/evidence selection is reported separately from normalized catalogs.

The version-six corpus closes the previously missing provider-standing check
through the actual Notion knowledge parser, signed Decision reader, Linear work
parser and GitHub PR HTTP adapter composed with Context Ask. Synthetic external
responses contain an older accepted founder Decision, a superseded Notion page,
a completed Linear task still labeled proposed, and a newer draft PR. It measures
the accepted Decision's first-place ranking, exclusion of superseded material,
explicit proposal/source labels, partial discovery coverage, revoked replay and
delivery, and preserved snapshots. Lower-ranked proposals can remain labeled
context; the evidence-echo answerer does not pretend to measure live reasoning
about policy. Mutation cases change provider states, remove Human acceptance and
omit revocation, requiring the corresponding checks to fail.

`crossProviderSelection` reports this real-adapter coverage separately from the
normalized-catalog fixtures. All I/O responses and the answerer are deterministic;
no live provider calls, paid requests, live quality or deployment readiness are
inferred. The original historical/current Meeting fixtures remain separate.

The version-five corpus adds accepted imported Meeting recall: real immutable
source admission and Meeting Intelligence analysis, Human confirmation, the owned
prior-Meeting leaf, and Context Ask in a separate conversation. Its annotations
check old still-valid ownership, original links, exclusion of unrelated Meetings,
persisted replay, grant revocation and retained history. Mutation tests alter the
source statement, Human confirmation and revocation event and require failures.
The source reader and model remain deterministic external adapters; the scenario also cites an external source through the restricted nonrecursive
receipt proof. No direct Discord historical grants, live Notion transport, or
multi-hop Meeting dependency proof is claimed. See
[the bounded catalog contract](../docs/imported-meeting-recall.md).

The report records exact corpus and sample hashes, sample provenance, model and
prompt versions, fixed workspace configuration, each observed result, per-check
outcomes, and usage. Relevant-current recall and stale-claim inclusion are
reported separately for their annotated facts, with scoped Meeting answers and
organizational selection reported as separate populations. Input/context
characters are measured independently and are not tokens. Prior Meeting state
may appear in model input independently of additional context. No assertion
requires zero context, and smaller context does not count as a quality
improvement. The bounded scenario checks retrieved excerpts and the actual
Discord response limit; total serialized input is recorded separately because
metadata and original conversation evidence also consume input. This does not
assert a whole-prompt token limit. No aggregate score blends these measures.

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
