# Luma model evaluation v2

Benchmark: prompt-tuning-validation / 2026-09-12-v1. Mode: **historical-regrade**. Provenance: **synthetic-development**.

Automated checks, human semantic review, and operational reliability are separate. An automated pass is never reported as a reviewed quality pass. Agent annotations cannot satisfy the human review requirement.

Cases: 8; scenario groups: 8; held-out cases: 0. Group counts do not establish representative sampling.

| Candidate          | Valid / planned | API/transport failures | Automated passes | Reviewed passes | Pending review | Observed critical failures |           Known token cost |
| ------------------ | --------------: | ---------------------: | ---------------: | --------------: | -------------: | -------------------------: | -------------------------: |
| openai-original    |           16/16 |                      0 |            13/16 |            0/16 |             16 |                          0 | $0.035604 (16/16 attempts) |
| openai-selected    |           16/16 |                      0 |            16/16 |            0/16 |             16 |                          0 | $0.037169 (16/16 attempts) |
| anthropic-original |           12/16 |                      4 |             8/16 |            0/16 |             12 |                          0 | $0.408370 (16/16 attempts) |
| anthropic-selected |            8/16 |                      8 |             7/16 |            0/16 |              8 |                          0 | $0.450326 (16/16 attempts) |
| deepseek-original  |           13/16 |                      3 |            12/16 |            0/16 |             13 |                          0 | $0.133899 (16/16 attempts) |
| deepseek-selected  |           14/16 |                      2 |            14/16 |            0/16 |             14 |                          0 | $0.135203 (16/16 attempts) |
| google-original    |           15/16 |                      1 |            15/16 |            0/16 |             15 |                          0 | $0.187276 (15/16 attempts) |
| google-selected    |           11/16 |                      5 |            11/16 |            0/16 |             11 |                          0 | $0.357823 (14/16 attempts) |

Missing usage is unknown, not free. Semantic dimensions without completed reviews are unassessed, not zero-error. JSON includes dimension/cohort summaries and latency; no overall model-quality winner is inferred.

## Matched comparisons

- openai-selected vs openai-original: 8 groups, 16 paired attempts, 0 missing pairs. Automatic difference: 18.8 percentage points; exploratory group-bootstrap 95% interval: 0.0 to 43.8. Reviewed quality difference: unavailable; reviewed 95% interval: unavailable.
- anthropic-original vs openai-original: 8 groups, 16 paired attempts, 0 missing pairs. Automatic difference: -31.3 percentage points; exploratory group-bootstrap 95% interval: -56.3 to -12.5. Reviewed quality difference: unavailable; reviewed 95% interval: unavailable.
- anthropic-selected vs openai-original: 8 groups, 16 paired attempts, 0 missing pairs. Automatic difference: -37.5 percentage points; exploratory group-bootstrap 95% interval: -62.5 to -6.3. Reviewed quality difference: unavailable; reviewed 95% interval: unavailable.
- deepseek-original vs openai-original: 8 groups, 16 paired attempts, 0 missing pairs. Automatic difference: -6.3 percentage points; exploratory group-bootstrap 95% interval: -43.8 to 31.3. Reviewed quality difference: unavailable; reviewed 95% interval: unavailable.
- deepseek-selected vs openai-original: 8 groups, 16 paired attempts, 0 missing pairs. Automatic difference: 6.3 percentage points; exploratory group-bootstrap 95% interval: -18.8 to 37.5. Reviewed quality difference: unavailable; reviewed 95% interval: unavailable.
- google-original vs openai-original: 8 groups, 16 paired attempts, 0 missing pairs. Automatic difference: 12.5 percentage points; exploratory group-bootstrap 95% interval: -12.5 to 43.8. Reviewed quality difference: unavailable; reviewed 95% interval: unavailable.
- google-selected vs openai-original: 8 groups, 16 paired attempts, 0 missing pairs. Automatic difference: -12.5 percentage points; exploratory group-bootstrap 95% interval: -43.8 to 12.5. Reviewed quality difference: unavailable; reviewed 95% interval: unavailable.

Intervals resample whole scenario groups rather than individual repetitions. Reviewed intervals require complete human judgments for all valid paired answers. A saturated checklist can produce a zero-width interval while still missing real errors. Synthetic development data and historical regrades cannot establish a production-quality ranking.

## Reproduction

- Benchmark hash: 98774ca7dea6538bc62be498745d7cbcf99fca795b1c7e332aabf1ab8c18f3c2
- Plan hash: 66e3d5b218dcaeb24cfe54d27d9c50435d830ac378301a89e85b052739c194c2
- Source: f254f31e83f770de63e6fea6e58effea4331fb69
- Seed: 56; repetitions: 2; request cap: 128.
- Output cap: 8192; timeout: 60000 ms; provider profile: provider-comparison-v1.
- Provider profile retains the original comparison's reasoning and output modes; these are not equal reasoning-compute budgets. Verify model compatibility and prices before adding a future model.
- Keep review-packet.json separate from report.json while reviewing: the report exposes model identities. Text style can still reveal a model; this is metadata blinding, not guaranteed anonymity.
