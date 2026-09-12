# Luma model evaluation v2

Benchmark: prompt-tuning-development / 2026-09-12-v1. Mode: **live**. Provenance: **synthetic-development**.

Automated checks, human semantic review, and operational reliability are separate. An automated pass is never reported as a reviewed quality pass. Agent annotations cannot satisfy the human review requirement.

Cases: 4; scenario groups: 4; held-out cases: 0. Group counts do not establish representative sampling.

| Candidate | Valid / planned | API/transport failures | Automated passes | Reviewed passes | Pending review | Observed critical failures | Known token cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| deepseek-revision-v2 | 3/4 | 1 | 3/4 | 0/4 | 3 | 0 | $0.026301 (4/4 attempts) |

Missing usage is unknown, not free. Semantic dimensions without completed reviews are unassessed, not zero-error. JSON includes dimension/cohort summaries and latency; no overall model-quality winner is inferred.

## Matched comparisons


Intervals resample whole scenario groups rather than individual repetitions. Reviewed intervals require complete human judgments for all valid paired answers. A saturated checklist can produce a zero-width interval while still missing real errors. Synthetic development data and historical regrades cannot establish a production-quality ranking.

## Reproduction

- Benchmark hash: ee9cd1f5c48c106f40c6788c7949422da7d3242e95ea967305e4477eca35b5ef
- Plan hash: 623f8b8aee8fcdd0e63e29b529be36681303e1498f879363525f2418a7bcd033
- Source: 860c8d55f305a5249ba3d1fe06c504856937bd04
- Seed: 56; repetitions: 1; request cap: 4.
- Output cap: 8192; timeout: 60000 ms; provider profile: provider-comparison-v1.
- Provider profile retains the original comparison's reasoning and output modes; these are not equal reasoning-compute budgets. Verify model compatibility and prices before adding a future model.
- Keep review-packet.json separate from report.json while reviewing: the report exposes model identities. Text style can still reveal a model; this is metadata blinding, not guaranteed anonymity.
