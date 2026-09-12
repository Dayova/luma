"""Offline paired summaries from validated saved runs and complete AI rounds.

Run the documented eval:ai-review validation before this analysis. No API calls,
no human-label changes, and no overwrite of an existing output directory.
"""
import argparse
import hashlib
import json
import random
import statistics
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output-dir", required=True)
args = parser.parse_args()
root = Path("evals/results/2026-09-12-prompt-tuning")


def read(path):
    return json.loads(path.read_text())


def automatic(row):
    return row["status"] == "completed" and all(x["passed"] for x in row["grade"]["automated"])


def verdict(review):
    values = [j["verdict"] for j in review["judgments"]]
    return "fail" if "fail" in values else "uncertain" if "uncertain" in values else "pass"


def interval(differences):
    # Resample complete scenario groups, preserving both repetitions in a group.
    rng = random.Random(56)
    samples = sorted(statistics.mean(rng.choices(differences, k=len(differences))) for _ in range(10000))
    return [samples[249], samples[9749]]


runs = [read(root / stage / "combined.json") for stage in ["shared", "revision", "validation"]]
run = runs[-1]
rounds = [read(root / "ai-review" / f"reviewer-{name}.json") for name in ["a", "b"]]
review_summary = read(root / "ai-review" / "summary.json")
if any(r["packetHash"] != review_summary["packetHash"] for r in rounds):
    raise ValueError("Review packet mismatch")
if any(row["status"] not in ["completed", "error"] for r in runs for row in r["rows"]):
    raise ValueError("Incomplete dispatch coverage")
judges = {r["reviewer"]["id"]: {a["answerId"]: a for a in r["reviews"]} for r in rounds}
groups = {c["fixture"]["id"]: c["groupId"] for c in run["benchmark"]["cases"]}
by_candidate = {}
for model in run["models"]:
    label = model["label"]
    rows = [r for r in run["rows"] if r["candidate"] == label]
    valid = [r for r in rows if r["status"] == "completed"]
    costs = [r["response"]["estimatedUncachedCostUsd"] for r in rows if r["response"] and r["response"]["estimatedUncachedCostUsd"] is not None]
    latency = sorted(r["latencyMs"] for r in rows)
    by_candidate[label] = {
        "attempts": len(rows), "valid": len(valid), "automaticPasses": sum(map(automatic, rows)),
        "operationalFailures": [{"caseId": r["caseId"], "repetition": r["repetition"], "code": r["errorCode"], "response": r["response"]} for r in rows if r["status"] == "error"],
        "knownCostUsd": sum(costs) if costs else None, "knownCostAttempts": len(costs),
        "medianAttemptLatencyMs": statistics.median(latency),
        "p95AttemptLatencyMs": latency[(95 * len(latency) + 99) // 100 - 1],
        "medianValidLatencyMs": statistics.median(r["latencyMs"] for r in valid) if valid else None,
        "judges": {}
    }
    for judge, answers in judges.items():
        reviews = [answers[r["grade"]["answerId"]] for r in valid]
        dimensions = {}
        for review in reviews:
            for j in review["judgments"]:
                d = dimensions.setdefault(j["rubricId"], {"pass": 0, "fail": 0, "uncertain": 0})
                d[j["verdict"]] += 1
        by_candidate[label]["judges"][judge] = {
            "semantic": {v: sum(verdict(a) == v for a in reviews) for v in ["pass", "fail", "uncertain"]},
            "automaticAndSemanticPasses": sum(automatic(r) and verdict(answers[r["grade"]["answerId"]]) == "pass" for r in valid),
            "dimensions": dimensions
        }
comparisons = []
for provider in ["openai", "anthropic", "google", "deepseek"]:
    left = {(r["caseId"], r["repetition"]): r for r in run["rows"] if r["candidate"] == provider + "-original"}
    right = {(r["caseId"], r["repetition"]): r for r in run["rows"] if r["candidate"] == provider + "-selected"}
    if left.keys() != right.keys():
        raise ValueError("Unmatched validation arms")
    for judge, answers in judges.items():
        pairs = []
        blocks = {}
        for key, original in left.items():
            selected = right[key]
            def outcome(row):
                return "operational-error" if row["status"] == "error" else verdict(answers[row["grade"]["answerId"]])
            a, b = outcome(original), outcome(selected)
            pa, pb = automatic(original) and a == "pass", automatic(selected) and b == "pass"
            blocks.setdefault(groups[key[0]], []).append(int(pb) - int(pa))
            pairs.append({"caseId": key[0], "repetition": key[1], "originalSemantic": a, "selectedSemantic": b, "originalAutomaticAndAI": pa, "selectedAutomaticAndAI": pb})
        differences = [statistics.mean(values) for values in blocks.values()]
        comparisons.append({"provider": provider, "reviewer": judge, "groups": len(blocks), "pairs": pairs, "automaticAndAISuccessDifference": statistics.mean(differences), "exploratoryGroupBootstrap95": interval(differences), "improvedPairs": sum(not p["originalAutomaticAndAI"] and p["selectedAutomaticAndAI"] for p in pairs), "regressedPairs": sum(p["originalAutomaticAndAI"] and not p["selectedAutomaticAndAI"] for p in pairs)})
all_rows = [row for r in runs for row in r["rows"]]
known = [r["response"]["estimatedUncachedCostUsd"] for r in all_rows if r["response"] and r["response"]["estimatedUncachedCostUsd"] is not None]
result = {
    "version": 1, "validationPlanHash": run["planHash"], "packetHash": review_summary["packetHash"],
    "sourceFileSha256": {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [root / "validation/combined.json", root / "ai-review/reviewer-a.json", root / "ai-review/reviewer-b.json"]},
    "candidates": by_candidate, "comparisons": comparisons,
    "totalExperiment": {"attempts": len(all_rows), "knownCostUsd": sum(known), "knownCostAttempts": len(known)},
    "interpretation": "Selected minus original on eight synthetic scenario groups. Operational failures count as unsuccessful attempts; uncertain is not pass. Automatic-and-AI is provisional and never human quality. Intervals resample eight whole groups; correlated repetitions and subjective judgments do not establish production accuracy, equivalence, or a best-model ranking. No correction for multiple exploratory comparisons. Saved prices are uncached estimates, including conservative DeepSeek peak rates; missing usage is unknown and Codex costs are excluded."
}
out = Path(args.output_dir)
out.mkdir(parents=True, exist_ok=False)
(out / "comparison.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"directory": str(out), "total": result["totalExperiment"]}))
