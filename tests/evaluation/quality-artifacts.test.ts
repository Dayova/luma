import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { benchmarkSchema } from "../../src/evaluation/quality/grading.js";
import {
  parseQualityRun,
  regradeHistorical,
  regradeQuality
} from "../../src/evaluation/quality/artifacts.js";
import { summarizeRun } from "../../src/evaluation/quality/report.js";
const benchmark = benchmarkSchema.parse(
  JSON.parse(readFileSync("evals/fixtures/provider-quality-v2.json", "utf8"))
);
const reports = ["openai", "anthropic", "deepseek", "google"].map(
  (p) =>
    JSON.parse(readFileSync(`evals/results/2026-09-11/main-${p}.json`, "utf8")) as unknown
);
it("regrades actual answers without new calls, preserving errors and marking new cases unrun", async () => {
  const run = await regradeHistorical(benchmark, reports, "test");
  const luna = summarizeRun(run).find((s) => s.candidate === "openai-gpt-5-6-luna")!;
  expect(run.rows).toHaveLength(288);
  expect(luna).toMatchObject({
    validOutputs: 48,
    automaticPasses: 45,
    reviewedPasses: 0,
    pendingReview: 48,
    unrun: 24,
    criticalFailures: 3
  });
  expect(summarizeRun(run).find((s) => s.candidate.startsWith("google"))).toMatchObject({
    operationalErrors: 10,
    unrun: 24
  });
  expect(parseQualityRun(JSON.parse(JSON.stringify(run)))).toEqual(run);
});
it("recomputes stored scores and rejects mismatched request provenance or duplicate attempts", async () => {
  const run = await regradeHistorical(benchmark, reports, "test");
  const changed = structuredClone(run);
  const row = changed.rows.find(
    (r) => r.candidate.startsWith("openai") && r.caseId === "revised-decision"
  )!;
  row.grade!.verdict = "passed";
  row.grade!.automated = [];
  expect(
    parseQualityRun(changed).rows.find(
      (r) => r.candidate === row.candidate && r.caseId === row.caseId
    )!.grade!.verdict
  ).toBe("failed");
  changed.rows[0]!.requestHash = "f".repeat(64);
  expect(() => parseQualityRun(changed)).toThrow();
  const duplicate = structuredClone(run);
  duplicate.rows[0] = duplicate.rows[1]!;
  expect(() => parseQualityRun(duplicate)).toThrow();
  const wrong = structuredClone(reports) as { rows: { requestHash: string }[] }[];
  wrong[0]!.rows[0]!.requestHash = "f".repeat(64);
  await expect(regradeHistorical(benchmark, wrong, "test")).rejects.toThrow();
});

it("makes a new grading revision explicit and refuses replay after source Evidence changes", async () => {
  const original = await regradeHistorical(benchmark, reports, "test");
  const changed = structuredClone(benchmark);
  changed.revision += "-regrade-test";
  changed.cases[0]!.fixture.manualReview += " Additional review guidance.";
  const result = await regradeQuality(changed, original, "new-test");
  expect(result.benchmarkHash).not.toBe(original.benchmarkHash);
  expect(result.rows.filter((r) => r.status === "completed")).toHaveLength(173);
  expect(result.sourceReports).toHaveLength(1);
  changed.cases[0]!.fixture.utterances[0]!.text += " Actually the owner changed.";
  await expect(regradeQuality(changed, original, "new-test")).rejects.toThrow(/request/);
});

it("regrades the first challenge run without penalizing Sonnet's conditional candidate offer", async () => {
  const original = JSON.parse(
    readFileSync("evals/results/2026-09-11-v2/challenge-original.json", "utf8")
  ) as unknown;
  const old = parseQualityRun(original);
  expect(
    summarizeRun(old).find((s) => s.candidate.startsWith("anthropic"))!.automaticPasses
  ).toBe(7);
  const run = await regradeQuality(
    { ...benchmark, cases: benchmark.cases.filter((c) => c.cohort === "challenge") },
    original,
    "test"
  );
  expect(
    summarizeRun(run).find((s) => s.candidate.startsWith("anthropic"))
  ).toMatchObject({ automaticPasses: 8, pendingReview: 8, reviewedPasses: 0 });
  expect(run.rows.map((r) => r.output)).toEqual(old.rows.map((r) => r.output));
  expect(summarizeRun(run).find((s) => s.candidate.startsWith("deepseek"))).toMatchObject(
    { operationalErrors: 6, validOutputs: 2 }
  );
});
