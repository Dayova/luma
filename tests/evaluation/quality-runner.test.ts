import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { benchmarkSchema } from "../../src/evaluation/quality/grading.js";
import {
  runQualityEvaluation,
  type ModelSpec
} from "../../src/evaluation/quality/runner.js";
import type { MeetingAnalysisProposalBatch } from "../../src/ai/reasoning-model.js";

const benchmark = benchmarkSchema.parse(
  JSON.parse(readFileSync("evals/fixtures/provider-quality-v2.json", "utf8"))
);
const models: ModelSpec[] = [
  {
    label: "incumbent",
    provider: "openai",
    model: "gpt-5.6-luna",
    inputRate: 0.2,
    outputRate: 1.2,
    pricing: "https://example.com/rates",
    pricingVerifiedAt: "2026-09-11"
  },
  {
    label: "challenger",
    provider: "openai",
    model: "future-test-model",
    inputRate: 1,
    outputRate: 2,
    pricing: "https://example.com/rates",
    pricingVerifiedAt: "2026-09-11"
  }
];
const empty: MeetingAnalysisProposalBatch = {
  actionItems: [],
  decisions: [],
  openQuestions: [],
  risks: [],
  followUpIntentions: []
};
it("plans matched, reproducible trials for multiple models from one provider without paid calls", async () => {
  const options = {
    benchmark,
    models,
    env: { OPENAI_API_KEY: "test-key" },
    live: false,
    maxRequests: 4,
    repeats: 3,
    seed: 17,
    gitRevision: "test"
  };
  const a = await runQualityEvaluation(options);
  const b = await runQualityEvaluation(options);
  expect(a.planHash).toBe(b.planHash);
  expect(a.rows).toHaveLength(144);
  expect(a.rows.every((r) => r.grade === null)).toBe(true);
  expect(
    new Set(
      a.rows.filter((r) => r.caseId === "revised-decision").map((r) => r.requestHash)
    ).size
  ).toBe(1);
  const shuffled = await runQualityEvaluation({ ...options, seed: 18 });
  expect(shuffled.planHash).not.toBe(a.planHash);
});
it("retains operational failures, capped cases and semantic review requirements separately", async () => {
  let calls = 0;
  const report = await runQualityEvaluation({
    benchmark,
    models,
    env: { OPENAI_API_KEY: "test-key" },
    live: true,
    maxRequests: 2,
    repeats: 1,
    seed: 17,
    gitRevision: "test",
    modelFactory: () => ({
      generateStructured<T>() {
        calls++;
        if (calls === 1) return Promise.reject(new Error("private transport detail"));
        return Promise.resolve({
          value: empty as T,
          metadata: { provider: "test", model: "test", promptVersion: "test" }
        });
      }
    })
  });
  expect(calls).toBe(2);
  expect(report.rows.filter((r) => r.status === "error")).toHaveLength(1);
  expect(report.rows.filter((r) => r.status === "request-limit")).toHaveLength(46);
  expect(report.rows.some((r) => r.grade?.verdict === "passed")).toBe(false);
  expect(JSON.stringify(report)).not.toContain("private transport detail");
  expect(JSON.stringify(report)).not.toContain("test-key");
});
