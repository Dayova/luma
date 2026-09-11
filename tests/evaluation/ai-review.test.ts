import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  parseQualityRun,
  regradeQuality
} from "../../src/evaluation/quality/artifacts.js";
import { benchmarkSchema, digest } from "../../src/evaluation/quality/grading.js";
import {
  createAIReviewPacket,
  validateAIReviewRound,
  summarizeAIReviews
} from "../../src/evaluation/quality/ai-review.js";
const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8")) as unknown;
async function inputs() {
  const b = benchmarkSchema.parse(json("evals/fixtures/provider-quality-v2.json"));
  const run = await regradeQuality(
    { ...b, cases: b.cases.filter((c) => c.cohort === "challenge") },
    json("evals/results/2026-09-11-v2/challenge-original.json"),
    "test"
  );
  const prepared = createAIReviewPacket(
    run,
    json("evals/context/luma-ai-review-2026-09-11.json"),
    json("evals/fixtures/ai-review-controls.json")
  );
  return { run, ...prepared };
}
it("creates blinded, content-bound review context without scores, reference answers or calibration labels", async () => {
  const { packet, controller } = await inputs();
  expect(packet.entries).toHaveLength(31);
  expect(controller.evaluationAnswerIds).toHaveLength(26);
  expect(controller.controls).toHaveLength(15);
  expect(JSON.stringify(packet)).not.toMatch(
    /gpt-5|claude-sonnet|gemini-3|deepseek-flash|automaticPasses|estimatedUncachedCostUsd|Control expectation withheld|independentReview/
  );
  expect(
    packet.context.principles.find((p) => p.id === "ownership")!.sourceIds
  ).toContain("ownership");
});
it("rejects fabricated review coverage, stale context, unknown Evidence and pretending to be human", async () => {
  const { packet } = await inputs();
  const round = {
    version: 1,
    packetHash: packet.packetHash,
    reviewer: {
      id: "judge",
      system: "Codex",
      model: "inherited-parent-model",
      freshContext: true,
      metadataBlinded: true
    },
    reviews: packet.entries.map((e) => ({
      answerId: e.answerId,
      reviewer: { id: "judge", kind: "agent" },
      reviewedAt: "2026-09-11T19:00:00Z",
      judgments: e.rubric.map((r) => ({
        rubricId: r.id,
        verdict: "uncertain",
        explanation: "Test annotation awaiting a real judgment.",
        evidenceIds: [] as string[]
      }))
    })),
    findings: []
  };
  expect(validateAIReviewRound(packet, round).reviews).toHaveLength(31);
  expect(() =>
    validateAIReviewRound(packet, { ...round, packetHash: "f".repeat(64) })
  ).toThrow();
  expect(() =>
    validateAIReviewRound(packet, { ...round, reviews: round.reviews.slice(1) })
  ).toThrow();
  const wrong = structuredClone(round);
  wrong.reviews[0]!.judgments[0]!.evidenceIds.push("not-an-evidence-id");
  expect(() => validateAIReviewRound(packet, wrong)).toThrow();
  const human = structuredClone(round);
  human.reviews[0]!.reviewer.kind = "human";
  expect(() => validateAIReviewRound(packet, human)).toThrow(/agent-attributed/);
});
it("reports AI disagreement and failed controls separately without converting agent labels to human passes", async () => {
  const { run, packet, controller } = await inputs();
  const make = (id: string, verdict: string) => ({
    version: 1,
    packetHash: packet.packetHash,
    reviewer: {
      id,
      system: "Codex",
      model: "inherited-parent-model",
      freshContext: true,
      metadataBlinded: true
    },
    reviews: packet.entries.map((e) => ({
      answerId: e.answerId,
      reviewer: { id, kind: "agent" },
      reviewedAt: "2026-09-11T19:00:00Z",
      judgments: e.rubric.map((r) => ({
        rubricId: r.id,
        verdict,
        explanation: "Test-only judgment.",
        evidenceIds: [] as string[]
      }))
    })),
    findings: []
  });
  const a = validateAIReviewRound(packet, make("a", "pass")),
    b = validateAIReviewRound(packet, make("b", "fail"));
  const before = JSON.stringify(run);
  const summary = summarizeAIReviews(run, packet, controller, [a, b]);
  expect(summary.agreement).toMatchObject({
    compared: 156,
    agreed: 0,
    disagreements: 156
  });
  expect(summary.reviewers.every((r) => !r.calibrationPassed)).toBe(true);
  expect(summary.candidates.every((c) => c.humanReviewedPasses === 0)).toBe(true);
  expect(summary.candidates[0]!.judges[0]!.semanticPasses).toBe(8);
  expect(summary.candidates[0]!.judges[1]!.semanticFailures).toBe(8);
  expect(JSON.stringify(run)).toBe(before);
  expect(parseQualityRun(run)).toEqual(run);
});

it("rejects a packet that changes source Evidence while retaining the original answer IDs", async () => {
  const { run, packet, controller } = await inputs();
  packet.entries.find((e) =>
    controller.evaluationAnswerIds.includes(e.answerId)
  )!.utterances[0]!.text = "A different unsupported source.";
  const { packetHash, ...content } = packet;
  expect(packetHash).toBe(controller.packetHash);
  packet.packetHash = digest(content);
  controller.packetHash = packet.packetHash;
  expect(() => summarizeAIReviews(run, packet, controller, [])).toThrow(
    /evaluated answers/
  );
});

it("rejects duplicate calibration labels and changed case rubrics", async () => {
  const { run, packet, controller } = await inputs();
  const duplicate = structuredClone(controller);
  duplicate.controls.push(duplicate.controls[0]!);
  expect(() => summarizeAIReviews(run, packet, duplicate, [])).toThrow(
    /calibration controller/
  );
  const changed = structuredClone(packet);
  changed.entries.find((e) =>
    controller.evaluationAnswerIds.includes(e.answerId)
  )!.rubric[0]!.question = "Different criterion";
  const { packetHash, ...content } = changed;
  expect(packetHash).toBe(packet.packetHash);
  changed.packetHash = digest(content);
  expect(() =>
    summarizeAIReviews(
      run,
      changed,
      { ...controller, packetHash: changed.packetHash },
      []
    )
  ).toThrow(/evaluated answers/);
});

it("reproduces the frozen independent review from saved answers and retains every judgment", async () => {
  const { run, packet, controller } = await inputs();
  const summary = summarizeAIReviews(run, packet, controller, [
    json("evals/results/2026-09-11-ai-review/reviewer-a.json"),
    json("evals/results/2026-09-11-ai-review/reviewer-b.json")
  ]);
  expect(summary).toEqual(json("evals/results/2026-09-11-ai-review/summary.json"));
});
