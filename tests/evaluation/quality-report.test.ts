import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  benchmarkSchema,
  type SemanticReview
} from "../../src/evaluation/quality/grading.js";
import {
  runQualityEvaluation,
  type ModelSpec
} from "../../src/evaluation/quality/runner.js";
import {
  prepareReviewPacket,
  applyReviews,
  summarizeRun,
  compareCandidates
} from "../../src/evaluation/quality/report.js";

const full = benchmarkSchema.parse(
  JSON.parse(readFileSync("evals/fixtures/provider-quality-v2.json", "utf8"))
);
const benchmark = {
  ...full,
  cases: full.cases.filter((c) => c.fixture.id === "tentative-tool-proposal")
};
const models: ModelSpec[] = ["incumbent", "challenger"].map((label) => ({
  label,
  provider: "openai",
  model: label === "incumbent" ? "gpt-5.6-luna" : "future-model",
  inputRate: 1,
  outputRate: 2,
  pricing: "https://example.com",
  pricingVerifiedAt: "2026-09-11"
}));
async function completedRun() {
  return runQualityEvaluation({
    benchmark,
    models,
    env: { OPENAI_API_KEY: "hidden-key" },
    live: true,
    maxRequests: 6,
    repeats: 3,
    seed: 17,
    gitRevision: "test",
    modelFactory: () => ({
      generateStructured<T>() {
        return Promise.resolve({
          value: {
            actionItems: [],
            decisions: [],
            openQuestions: [],
            risks: [],
            followUpIntentions: []
          } as T,
          metadata: { provider: "test", model: "test", promptVersion: "test" }
        });
      }
    })
  });
}
it("exports source and answer for review without model identity, scores, cost or timing", async () => {
  const run = await completedRun();
  const packet = prepareReviewPacket(run);
  expect(packet.entries).toHaveLength(1); // identical answers share a label; repetitions remain in statistics
  expect(JSON.stringify(packet)).not.toMatch(
    /gpt-5|future-model|incumbent|challenger|latencyMs|estimatedUncachedCostUsd|automated/
  );
  expect(packet.entries[0]!.utterances[0]!.text).toContain("Atlas");
  expect(summarizeRun(run)[0]).toMatchObject({
    automaticPasses: 3,
    reviewedPasses: 0,
    pendingReview: 3
  });
});
it("applies output-bound labels and rejects stale or foreign review packets", async () => {
  const run = await completedRun();
  const packet = prepareReviewPacket(run);
  const entry = packet.entries[0]!;
  const review: SemanticReview = {
    answerId: entry.answerId,
    reviewer: { id: "test-human", kind: "human" },
    reviewedAt: "2026-09-11T18:00:00Z",
    judgments: entry.rubric.map((r) => ({
      rubricId: r.id,
      verdict: "pass",
      explanation: "Reviewed against source for this test.",
      evidenceIds: []
    }))
  };
  const reviewed = applyReviews(run, {
    benchmarkHash: run.benchmarkHash,
    reviews: [review]
  });
  expect(summarizeRun(reviewed)[0]).toMatchObject({
    reviewedPasses: 3,
    pendingReview: 0
  });
  expect(() =>
    applyReviews(run, { benchmarkHash: "wrong", reviews: [review] })
  ).toThrow();
  expect(() =>
    applyReviews(run, {
      benchmarkHash: run.benchmarkHash,
      reviews: [{ ...review, answerId: "f".repeat(64) }]
    })
  ).toThrow();
  expect(summarizeRun(run)[0]!.pendingReview).toBe(3);
});
it("does not count repeated outputs as independent meetings or call an unreviewed tie a quality win", async () => {
  const comparison = compareCandidates(await completedRun(), "incumbent", "challenger");
  expect(comparison).toMatchObject({
    groups: 1,
    pairedAttempts: 3,
    automaticDifference: 0,
    qualityDifference: null,
    interval95: null
  });
});

it("keeps related variants together and provides reviewed intervals only after every semantic judgment", async () => {
  const variants = structuredClone(
    full.cases.filter((c) => c.groupId === "conditional-rollout")
  );
  const run = await runQualityEvaluation({
    benchmark: { ...full, cases: variants },
    models,
    env: { OPENAI_API_KEY: "test-key" },
    live: true,
    maxRequests: 12,
    repeats: 3,
    seed: 17,
    gitRevision: "test",
    modelFactory: () => ({
      generateStructured<T>() {
        return Promise.resolve({
          value: {
            actionItems: [],
            decisions: [],
            openQuestions: [],
            risks: [],
            followUpIntentions: []
          } as T,
          metadata: { provider: "test", model: "test", promptVersion: "test" }
        });
      }
    })
  });
  expect(compareCandidates(run, "incumbent", "challenger")).toMatchObject({
    groups: 1,
    pairedAttempts: 6,
    qualityInterval95: null
  });
  const separateGroups = structuredClone(run);
  separateGroups.benchmark.cases[1]!.groupId = "separate-test-meeting";
  const packet = prepareReviewPacket(separateGroups);
  const reviewed = applyReviews(separateGroups, {
    benchmarkHash: separateGroups.benchmarkHash,
    reviews: packet.entries.map((e) => ({
      answerId: e.answerId,
      reviewer: { id: "test-human", kind: "human" },
      reviewedAt: "2026-09-11T18:00:00Z",
      judgments: e.rubric.map((r) => ({
        rubricId: r.id,
        verdict: "pass",
        explanation: "Test-only annotation to exercise aggregation.",
        evidenceIds: []
      }))
    }))
  });
  expect(compareCandidates(reviewed, "incumbent", "challenger")).toMatchObject({
    groups: 2,
    qualityDifference: 0,
    qualityInterval95: [0, 0]
  });
  reviewed.rows[0]!.status = "request-limit";
  expect(compareCandidates(reviewed, "incumbent", "challenger")).toMatchObject({
    missingPairs: 1,
    interval95: null,
    qualityInterval95: null,
    qualityDifference: null
  });
});
