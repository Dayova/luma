# Luma model evaluation v2

Benchmark: prompt-tuning-development / 2026-09-12-v1. Mode: **historical-regrade**. Provenance: **synthetic-development**.

Automated checks, human semantic review, and operational reliability are separate. An automated pass is never reported as a reviewed quality pass. Agent annotations cannot satisfy the human review requirement.

Cases: 4; scenario groups: 4; held-out cases: 0. Group counts do not establish representative sampling.

| Candidate | Valid / planned | API/transport failures | Automated passes | Reviewed passes | Pending review | Observed critical failures | Known token cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| openai-revision-v2 | 4/4 | 0 | 4/4 | 0/4 | 4 | 0 | $0.007089 (4/4 attempts) |
| anthropic-revision-v2 | 4/4 | 0 | 4/4 | 0/4 | 4 | 0 | $0.094860 (4/4 attempts) |
| deepseek-revision-v2 | 3/4 | 1 | 3/4 | 0/4 | 3 | 0 | $0.026301 (4/4 attempts) |
| google-revision-v2 | 4/4 | 0 | 4/4 | 0/4 | 4 | 0 | $0.069142 (4/4 attempts) |

Missing usage is unknown, not free. Semantic dimensions without completed reviews are unassessed, not zero-error. JSON includes dimension/cohort summaries and latency; no overall model-quality winner is inferred.

## Matched comparisons

- anthropic-revision-v2 vs openai-revision-v2: 4 groups, 4 paired attempts, 0 missing pairs. Automatic difference: 0.0 percentage points; exploratory group-bootstrap 95% interval: 0.0 to 0.0. Reviewed quality difference: unavailable; reviewed 95% interval: unavailable.
- deepseek-revision-v2 vs openai-revision-v2: 4 groups, 4 paired attempts, 0 missing pairs. Automatic difference: -25.0 percentage points; exploratory group-bootstrap 95% interval: -75.0 to 0.0. Reviewed quality difference: unavailable; reviewed 95% interval: unavailable.
- google-revision-v2 vs openai-revision-v2: 4 groups, 4 paired attempts, 0 missing pairs. Automatic difference: 0.0 percentage points; exploratory group-bootstrap 95% interval: 0.0 to 0.0. Reviewed quality difference: unavailable; reviewed 95% interval: unavailable.

Intervals resample whole scenario groups rather than individual repetitions. Reviewed intervals require complete human judgments for all valid paired answers. A saturated checklist can produce a zero-width interval while still missing real errors. Synthetic development data and historical regrades cannot establish a production-quality ranking.

## Reproduction

- Benchmark hash: ee9cd1f5c48c106f40c6788c7949422da7d3242e95ea967305e4477eca35b5ef
- Plan hash: 9b801fdeba13de75c50c25590435f48f298ecfcce05e9ff11ec9967c3a20e217
- Source: 860c8d55f305a5249ba3d1fe06c504856937bd04
- Seed: 56; repetitions: 1; request cap: 16.
- Output cap: 8192; timeout: 60000 ms; provider profile: provider-comparison-v1.
- Provider profile retains the original comparison's reasoning and output modes; these are not equal reasoning-compute budgets. Verify model compatibility and prices before adding a future model.
- Keep review-packet.json separate from report.json while reviewing: the report exposes model identities. Text style can still reveal a model; this is metadata blinding, not guaranteed anonymity.
