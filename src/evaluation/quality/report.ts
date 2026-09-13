import { z } from "zod";
import { gradeCase, semanticReviewSchema, type QualityCase } from "./grading.js";
import type { QualityRun, QualityRow } from "./runner.js";

export function prepareReviewPacket(run: QualityRun) {
  const unique = new Map<
    string,
    {
      answerId: string;
      caseId: string;
      occurredAt: string;
      timezone: string;
      language: string;
      utterances: QualityCase["fixture"]["utterances"];
      reference: string;
      rubric: QualityCase["rubric"];
      output: NonNullable<QualityRow["output"]>;
    }
  >();
  for (const row of run.rows) {
    if (row.status !== "completed" || !row.output) continue;
    const c = run.benchmark.cases.find((c) => c.fixture.id === row.caseId)!;
    const answerId = gradeCase(c, row.output).answerId;
    unique.set(answerId, {
      answerId,
      caseId: c.fixture.id,
      occurredAt: c.fixture.occurredAt,
      timezone: c.fixture.timezone,
      language: c.fixture.language,
      utterances: c.fixture.utterances,
      reference: c.fixture.manualReview,
      rubric: c.rubric,
      output: row.output
    });
  }
  return {
    version: 1,
    benchmarkHash: run.benchmarkHash,
    instructions:
      "Review the source and every answer field. Model identity and runtime metrics are withheld. Identical case/output pairs share one review. Use uncertain when the evidence or rubric does not resolve the judgment. Independent human review is required for a semantic pass; agent annotations remain provisional.",
    entries: [...unique.values()].sort((a, b) => a.answerId.localeCompare(b.answerId))
  };
}

export const reviewsSchema = z
  .object({ benchmarkHash: z.string(), reviews: z.array(semanticReviewSchema) })
  .strict();
export function applyReviews(run: QualityRun, input: unknown): QualityRun {
  const bundle = reviewsSchema.parse(input);
  if (bundle.benchmarkHash !== run.benchmarkHash)
    throw new Error("Review benchmark mismatch");
  const entries = prepareReviewPacket(run).entries;
  if (
    new Set(bundle.reviews.map((r) => r.answerId)).size !== bundle.reviews.length ||
    bundle.reviews.some((r) => !entries.some((e) => e.answerId === r.answerId))
  )
    throw new Error("Unknown or duplicate reviewed answer");
  const result = structuredClone(run);
  for (const row of result.rows) {
    if (row.status !== "completed" || !row.output) continue;
    const c = result.benchmark.cases.find((c) => c.fixture.id === row.caseId)!;
    const answerId = gradeCase(c, row.output).answerId;
    const review =
      bundle.reviews.find((r) => r.answerId === answerId) ??
      row.grade?.review ??
      undefined;
    row.grade = gradeCase(c, row.output, review);
  }
  return result;
}

const completed = (r: QualityRow) => r.status === "completed";
const dispatched = (r: QualityRow) => r.status === "completed" || r.status === "error";
const automaticPass = (r: QualityRow) =>
  completed(r) && r.grade !== null && r.grade.automated.every((a) => a.passed);
const reviewComplete = (r: QualityRow) =>
  r.status === "error" ||
  (r.grade?.review?.reviewer.kind === "human" &&
    r.grade.semantic.every((s) => s.verdict === "pass" || s.verdict === "fail"));
const median = (values: number[]) => {
  const v = [...values].sort((a, b) => a - b);
  const i = Math.floor(v.length / 2);
  return v.length ? (v.length % 2 ? v[i]! : (v[i - 1]! + v[i]!) / 2) : null;
};

export function summarizeRun(run: QualityRun) {
  return run.models.map((m) => {
    const rows = run.rows.filter((r) => r.candidate === m.label);
    const valid = rows.filter(completed);
    const costs = rows
      .filter(dispatched)
      .map((r) => r.response?.estimatedUncachedCostUsd)
      .filter((n): n is number => typeof n === "number");
    const latencies = rows
      .filter(dispatched)
      .flatMap((r) => (r.latencyMs === null ? [] : [r.latencyMs]))
      .sort((a, b) => a - b);
    const dimensions: Record<
      string,
      {
        automaticPassed: number;
        automaticAssessed: number;
        semanticPassed: number;
        semanticFailed: number;
        semanticPending: number;
      }
    > = {};
    for (const row of valid)
      if (row.grade) {
        for (const a of row.grade.automated) {
          const d = (dimensions[a.dimension] ??= {
            automaticPassed: 0,
            automaticAssessed: 0,
            semanticPassed: 0,
            semanticFailed: 0,
            semanticPending: 0
          });
          d.automaticAssessed++;
          if (a.passed) d.automaticPassed++;
        }
        for (const s of row.grade.semantic) {
          const d = (dimensions[s.dimension] ??= {
            automaticPassed: 0,
            automaticAssessed: 0,
            semanticPassed: 0,
            semanticFailed: 0,
            semanticPending: 0
          });
          if (s.verdict === "pass") d.semanticPassed++;
          else if (s.verdict === "fail") d.semanticFailed++;
          else d.semanticPending++;
        }
      }
    return {
      candidate: m.label,
      planned: rows.length,
      dispatched: rows.filter(dispatched).length,
      validOutputs: valid.length,
      operationalErrors: rows.filter((r) => r.status === "error").length,
      unrun: rows.filter((r) => !dispatched(r)).length,
      automaticPasses: rows.filter(automaticPass).length,
      reviewedPasses: valid.filter((r) => r.grade?.verdict === "passed").length,
      reviewedOutputs: valid.filter(reviewComplete).length,
      pendingReview: valid.filter((r) => !reviewComplete(r)).length,
      criticalFailures: valid.filter(
        (r) =>
          r.grade?.automated.some((a) => !a.passed && a.severity === "critical") ||
          r.grade?.semantic.some((s) => s.verdict === "fail" && s.severity === "critical")
      ).length,
      knownCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      knownCostAttempts: costs.length,
      medianValidLatencyMs: median(
        valid.flatMap((r) => (r.latencyMs === null ? [] : [r.latencyMs]))
      ),
      p95AttemptLatencyMs: latencies.length
        ? latencies[Math.ceil(0.95 * latencies.length) - 1]!
        : null,
      dimensions,
      cohorts: ["regression", "representative", "challenge"].map((cohort) => {
        const ids = new Set(
          run.benchmark.cases.filter((c) => c.cohort === cohort).map((c) => c.fixture.id)
        );
        const selected = rows.filter((r) => ids.has(r.caseId));
        return {
          cohort,
          cases: ids.size,
          planned: selected.length,
          automaticPasses: selected.filter(automaticPass).length,
          reviewedPasses: selected.filter((r) => r.grade?.verdict === "passed").length
        };
      })
    };
  });
}

/** Paired group resampling keeps repetitions and related variants in the same unit. No winner is inferred. */
export function compareCandidates(
  run: QualityRun,
  incumbent: string,
  challenger: string
) {
  if (
    incumbent === challenger ||
    !run.models.some((m) => m.label === incumbent) ||
    !run.models.some((m) => m.label === challenger)
  )
    throw new Error("Invalid comparison candidates");
  const blocks = new Map<string, { automatic: number[]; quality: number[] }>();
  let missingPairs = 0;
  let unreviewedPairs = 0;
  let pairedAttempts = 0;
  for (const c of run.benchmark.cases)
    for (let repetition = 1; repetition <= run.settings.repeats; repetition++) {
      const left = run.rows.find(
        (r) =>
          r.candidate === incumbent &&
          r.caseId === c.fixture.id &&
          r.repetition === repetition
      );
      const right = run.rows.find(
        (r) =>
          r.candidate === challenger &&
          r.caseId === c.fixture.id &&
          r.repetition === repetition
      );
      if (!left || !right || !dispatched(left) || !dispatched(right)) {
        missingPairs++;
        continue;
      }
      pairedAttempts++;
      const block = blocks.get(c.groupId) ?? { automatic: [], quality: [] };
      blocks.set(c.groupId, block);
      block.automatic.push(Number(automaticPass(right)) - Number(automaticPass(left)));
      if (reviewComplete(left) && reviewComplete(right))
        block.quality.push(
          Number(right.grade?.verdict === "passed") -
            Number(left.grade?.verdict === "passed")
        );
      else unreviewedPairs++;
    }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const differences = [...blocks.values()].map((b) => mean(b.automatic));
  const bootstrap = (differences: number[]): [number, number] | null => {
    if (differences.length < 2 || missingPairs > 0) return null;
    let state = run.settings.seed >>> 0;
    const samples: number[] = [];
    for (let sample = 0; sample < 2000; sample++) {
      let sum = 0;
      for (let i = 0; i < differences.length; i++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        sum += differences[Math.floor((state / 2 ** 32) * differences.length)]!;
      }
      samples.push(sum / differences.length);
    }
    samples.sort((a, b) => a - b);
    return [samples[49]!, samples[1949]!];
  };
  const quality =
    blocks.size > 0 && missingPairs === 0 && unreviewedPairs === 0
      ? [...blocks.values()].map((b) => mean(b.quality))
      : [];
  return {
    incumbent,
    challenger,
    metric: "automatic-case-success",
    groups: blocks.size,
    pairedAttempts,
    missingPairs,
    unreviewedPairs,
    automaticDifference: differences.length ? mean(differences) : null,
    interval95: bootstrap(differences),
    qualityDifference: quality.length ? mean(quality) : null,
    qualityInterval95: bootstrap(quality),
    interpretation:
      "Exploratory challenger-minus-incumbent differences, equally weighted by meeting group. Operational errors count as unsuccessful attempts; unrun pairs prevent an interval. Automatic checks are not semantic correctness. A narrow or zero bootstrap interval does not rule out unseen failure modes or establish equivalence. No automatic model promotion."
  };
}

export function renderQualityReport(run: QualityRun): string {
  const summaries = summarizeRun(run);
  const lines = [
    "# Luma model evaluation v2",
    "",
    `Benchmark: ${run.benchmark.id} / ${run.benchmark.revision}. Mode: **${run.mode}**. Provenance: **${run.benchmark.provenance}**.`,
    "",
    "Automated checks, human semantic review, and operational reliability are separate. An automated pass is never reported as a reviewed quality pass. Agent annotations cannot satisfy the human review requirement.",
    "",
    `Cases: ${run.benchmark.cases.length}; scenario groups: ${new Set(run.benchmark.cases.map((c) => c.groupId)).size}; held-out cases: ${run.benchmark.cases.filter((c) => c.split === "holdout").length}. Group counts do not establish representative sampling.`,
    "",
    "| Candidate | Valid / planned | API/transport failures | Automated passes | Reviewed passes | Pending review | Observed critical failures | Known token cost |",
    "|---|---:|---:|---:|---:|---:|---:|---:|"
  ];
  for (const s of summaries)
    lines.push(
      `| ${s.candidate} | ${s.validOutputs}/${s.planned} | ${s.operationalErrors} | ${s.automaticPasses}/${s.planned} | ${s.reviewedPasses}/${s.planned} | ${s.pendingReview} | ${s.criticalFailures} | ${s.knownCostUsd === null ? "unknown" : "$" + s.knownCostUsd.toFixed(6)} (${s.knownCostAttempts}/${s.dispatched} attempts) |`
    );
  lines.push(
    "",
    "Missing usage is unknown, not free. Semantic dimensions without completed reviews are unassessed, not zero-error. JSON includes dimension/cohort summaries and latency; no overall model-quality winner is inferred.",
    "",
    "## Matched comparisons",
    ""
  );
  for (const m of run.models.slice(1)) {
    const c = compareCandidates(run, run.models[0]!.label, m.label);
    lines.push(
      `- ${c.challenger} vs ${c.incumbent}: ${c.groups} groups, ${c.pairedAttempts} paired attempts, ${c.missingPairs} missing pairs. Automatic difference: ${c.automaticDifference === null ? "unmeasured" : (100 * c.automaticDifference).toFixed(1) + " percentage points"}; exploratory group-bootstrap 95% interval: ${c.interval95 ? c.interval95.map((n) => (100 * n).toFixed(1)).join(" to ") : "unavailable"}. Reviewed quality difference: ${c.qualityDifference === null ? "unavailable" : (100 * c.qualityDifference).toFixed(1) + " percentage points"}; reviewed 95% interval: ${c.qualityInterval95 ? c.qualityInterval95.map((n) => (100 * n).toFixed(1)).join(" to ") : "unavailable"}.`
    );
  }
  lines.push(
    "",
    "Intervals resample whole scenario groups rather than individual repetitions. Reviewed intervals require complete human judgments for all valid paired answers. A saturated checklist can produce a zero-width interval while still missing real errors. Synthetic development data and historical regrades cannot establish a production-quality ranking.",
    "",
    "## Reproduction",
    "",
    `- Benchmark hash: ${run.benchmarkHash}`,
    `- Plan hash: ${run.planHash}`,
    `- Source: ${run.gitRevision}`,
    `- Seed: ${run.settings.seed}; repetitions: ${run.settings.repeats}; request cap: ${run.settings.maxRequests}.`,
    `- Output cap: ${run.settings.limits.maxOutputTokens}; timeout: ${run.settings.limits.timeoutMs} ms; provider profile: ${run.settings.providerProfile}.`,
    "- Provider profile retains the original comparison's reasoning and output modes; these are not equal reasoning-compute budgets. Verify model compatibility and prices before adding a future model.",
    "- Keep review-packet.json separate from report.json while reviewing: the report exposes model identities. Text style can still reveal a model; this is metadata blinding, not guaranteed anonymity.",
    ""
  );
  return lines.join("\n");
}
