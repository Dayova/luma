# Luma model evaluation v2

Benchmark: prompt-tuning-validation / 2026-09-12-v1. Mode: **live**. Provenance: **synthetic-development**.

Automated checks, human semantic review, and operational reliability are separate. An automated pass is never reported as a reviewed quality pass. Agent annotations cannot satisfy the human review requirement.

Cases: 8; scenario groups: 8; held-out cases: 0. Group counts do not establish representative sampling.

| Candidate       | Valid / planned | API/transport failures | Automated passes | Reviewed passes | Pending review | Observed critical failures |           Known token cost |
| --------------- | --------------: | ---------------------: | ---------------: | --------------: | -------------: | -------------------------: | -------------------------: |
| openai-original |           16/16 |                      0 |            13/16 |            0/16 |             16 |                          0 | $0.035604 (16/16 attempts) |
| openai-selected |           16/16 |                      0 |            16/16 |            0/16 |             16 |                          0 | $0.037169 (16/16 attempts) |

Missing usage is unknown, not free. Semantic dimensions without completed reviews are unassessed, not zero-error. JSON includes dimension/cohort summaries and latency; no overall model-quality winner is inferred.

## Matched comparisons

- openai-selected vs openai-original: 8 groups, 16 paired attempts, 0 missing pairs. Automatic difference: 18.8 percentage points; exploratory group-bootstrap 95% interval: 0.0 to 43.8. Reviewed quality difference: unavailable; reviewed 95% interval: unavailable.

Intervals resample whole scenario groups rather than individual repetitions. Reviewed intervals require complete human judgments for all valid paired answers. A saturated checklist can produce a zero-width interval while still missing real errors. Synthetic development data and historical regrades cannot establish a production-quality ranking.

## Reproduction

- Benchmark hash: 98774ca7dea6538bc62be498745d7cbcf99fca795b1c7e332aabf1ab8c18f3c2
- Plan hash: 968e98617cbf3de207b002868af59ba37958234a14c91bac20f2a71fe21f5920
- Source: f254f31e83f770de63e6fea6e58effea4331fb69
- Seed: 56; repetitions: 2; request cap: 32.
- Output cap: 8192; timeout: 60000 ms; provider profile: provider-comparison-v1.
- Provider profile retains the original comparison's reasoning and output modes; these are not equal reasoning-compute budgets. Verify model compatibility and prices before adding a future model.
- Keep review-packet.json separate from report.json while reviewing: the report exposes model identities. Text style can still reveal a model; this is metadata blinding, not guaranteed anonymity.
