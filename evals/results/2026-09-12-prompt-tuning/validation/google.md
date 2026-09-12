# Luma model evaluation v2

Benchmark: prompt-tuning-validation / 2026-09-12-v1. Mode: **live**. Provenance: **synthetic-development**.

Automated checks, human semantic review, and operational reliability are separate. An automated pass is never reported as a reviewed quality pass. Agent annotations cannot satisfy the human review requirement.

Cases: 8; scenario groups: 8; held-out cases: 0. Group counts do not establish representative sampling.

| Candidate       | Valid / planned | API/transport failures | Automated passes | Reviewed passes | Pending review | Observed critical failures |           Known token cost |
| --------------- | --------------: | ---------------------: | ---------------: | --------------: | -------------: | -------------------------: | -------------------------: |
| google-original |           15/16 |                      1 |            15/16 |            0/16 |             15 |                          0 | $0.187276 (15/16 attempts) |
| google-selected |           11/16 |                      5 |            11/16 |            0/16 |             11 |                          0 | $0.357823 (14/16 attempts) |

Missing usage is unknown, not free. Semantic dimensions without completed reviews are unassessed, not zero-error. JSON includes dimension/cohort summaries and latency; no overall model-quality winner is inferred.

## Matched comparisons

- google-selected vs google-original: 8 groups, 16 paired attempts, 0 missing pairs. Automatic difference: -25.0 percentage points; exploratory group-bootstrap 95% interval: -56.3 to 6.3. Reviewed quality difference: unavailable; reviewed 95% interval: unavailable.

Intervals resample whole scenario groups rather than individual repetitions. Reviewed intervals require complete human judgments for all valid paired answers. A saturated checklist can produce a zero-width interval while still missing real errors. Synthetic development data and historical regrades cannot establish a production-quality ranking.

## Reproduction

- Benchmark hash: 98774ca7dea6538bc62be498745d7cbcf99fca795b1c7e332aabf1ab8c18f3c2
- Plan hash: 8964804cf188d6f724f39b4e553c7e989421639c62c8fc1b34a126312468d7f8
- Source: f254f31e83f770de63e6fea6e58effea4331fb69
- Seed: 56; repetitions: 2; request cap: 32.
- Output cap: 8192; timeout: 60000 ms; provider profile: provider-comparison-v1.
- Provider profile retains the original comparison's reasoning and output modes; these are not equal reasoning-compute budgets. Verify model compatibility and prices before adding a future model.
- Keep review-packet.json separate from report.json while reviewing: the report exposes model identities. Text style can still reveal a model; this is metadata blinding, not guaranteed anonymity.
