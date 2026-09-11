import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { corpusSchema } from "../../src/evaluation/provider-comparison/corpus.js";
import { meetingAnalysisSchema } from "../../src/ai/meeting-analysis-contract.js";
import {
  benchmarkSchema,
  gradeCase,
  type QualityCase,
  type SemanticReview
} from "../../src/evaluation/quality/grading.js";

const legacy = corpusSchema.parse(
  JSON.parse(readFileSync("evals/fixtures/provider-comparison.json", "utf8"))
);
const revised: QualityCase = {
  fixture: legacy.fixtures.find((f) => f.id === "revised-decision")!,
  groupId: "decision-reversal",
  cohort: "regression",
  split: "development",
  author: "agent",
  independentReview: null,
  rules: [
    {
      id: "no-inferred-objector",
      dimension: "attribution",
      severity: "critical",
      collection: "decisions",
      where: [],
      every: [{ field: "objectingParticipantIds", op: "set-equals", values: [] }],
      min: 1,
      max: 2
    }
  ],
  rubric: [
    {
      id: "supported-meaning",
      dimension: "grounding",
      severity: "critical",
      question:
        "Does every claim, including presuppositions in questions, have source support?"
    }
  ]
};

const old = JSON.parse(
  readFileSync("evals/results/2026-09-11/main-openai.json", "utf8")
) as {
  rows: { fixture: string; repetition: number; output: unknown }[];
};
const unsupportedObjection = meetingAnalysisSchema.parse(
  old.rows.find((r) => r.fixture === "revised-decision" && r.repetition === 1)!.output
);

describe("quality grading", () => {
  it("rejects the unsupported personal objection that passed the original live checklist", () => {
    const result = gradeCase(revised, unsupportedObjection);
    expect(result.automated.find((c) => c.id === "no-inferred-objector")).toMatchObject({
      passed: false,
      severity: "critical"
    });
    expect(result.verdict).toBe("failed");
  });
  it("keeps an automated pass pending and binds human review to the exact answer", () => {
    const corrected = structuredClone(unsupportedObjection);
    corrected.decisions.forEach((d) => {
      d.objectingParticipantIds = [];
    });
    const pending = gradeCase(revised, corrected);
    expect(pending.verdict).toBe("needs-review");
    const review: SemanticReview = {
      answerId: pending.answerId,
      reviewer: { id: "reviewer-test", kind: "human" },
      reviewedAt: "2026-09-11T18:00:00Z",
      judgments: [
        {
          rubricId: "supported-meaning",
          verdict: "pass",
          explanation: "The corrected answer agrees with the evidence.",
          evidenceIds: []
        }
      ]
    };
    expect(gradeCase(revised, corrected, review).verdict).toBe("passed");
    expect(() => gradeCase(revised, unsupportedObjection, review)).toThrow(/answer/);
    expect(
      gradeCase(revised, corrected, {
        ...review,
        reviewer: { id: "agent", kind: "agent" }
      }).verdict
    ).toBe("needs-review");
  });
  it("does not mistake a supported citation ID for supported question wording", () => {
    const c: QualityCase = {
      ...revised,
      fixture: legacy.fixtures.find((f) => f.id === "mixed-code-uncertainty")!,
      rules: []
    };
    const output = meetingAnalysisSchema.parse(
      old.rows.find((r) => r.fixture === c.fixture.id && r.repetition === 1)!.output
    );
    const pending = gradeCase(c, output);
    expect(pending.automated.every((a) => a.passed)).toBe(true);
    expect(pending.verdict).toBe("needs-review");
    const review: SemanticReview = {
      answerId: pending.answerId,
      reviewer: { id: "reviewer-test", kind: "human" },
      reviewedAt: "2026-09-11T18:00:00Z",
      judgments: [
        {
          rubricId: "supported-meaning",
          verdict: "fail",
          explanation:
            "The question asserts that the error is in the module; the source only says might.",
          evidenceIds: [`evidence:${c.fixture.id}:1`]
        }
      ]
    };
    expect(gradeCase(c, output, review).verdict).toBe("failed");
    const paraphrase = structuredClone(output);
    paraphrase.openQuestions[0]!.question =
      "Could use-auth-session be involved, or does the fault lie elsewhere?";
    expect(gradeCase(c, paraphrase).automated.every((a) => a.passed)).toBe(true);
    expect(() => gradeCase(c, paraphrase, review)).toThrow(/answer/);
  });
  it("rejects unknown grading fields before an empty selection could hide a broken rule", () => {
    const corpus = JSON.parse(
      readFileSync("evals/fixtures/provider-quality-v2.json", "utf8")
    ) as { cases: QualityCase[] };
    const c = corpus.cases.find((c) => c.fixture.id === "revised-decision")!;
    c.rules[0]!.every[0]!.field = "objectorsTypo";
    expect(() => benchmarkSchema.parse(corpus)).toThrow(/field/);
  });
  it("does not label self-authored synthetic cases as an independent holdout", () => {
    const corpus = JSON.parse(
      readFileSync("evals/fixtures/provider-quality-v2.json", "utf8")
    ) as { cases: QualityCase[] };
    corpus.cases[0]!.split = "holdout";
    corpus.cases[0]!.independentReview = {
      reviewerId: "someone",
      reviewedAt: "2026-09-11T18:00:00Z"
    };
    expect(() => benchmarkSchema.parse(corpus)).toThrow(/holdout/);
  });
  it("accepts differently worded commitments but rejects wrong owners, dates, omissions and duplicates", () => {
    const benchmark = benchmarkSchema.parse(
      JSON.parse(readFileSync("evals/fixtures/provider-quality-v2.json", "utf8"))
    );
    const c = benchmark.cases.find(
      (c) => c.fixture.id === "conditional-rollout-accepted"
    )!;
    const correct = meetingAnalysisSchema.parse({
      actionItems: [
        {
          stableKey: "checklist",
          description: "Prepare the release checklist; deployment remains undecided.",
          ownerId: "person_sam",
          dueDate: {
            originalPhrase: "18 September 2026",
            normalizedDate: "2026-09-18",
            confidence: "exact",
            timezone: "Europe/Berlin"
          },
          status: "confirmed",
          relatedDecisionIds: [],
          evidenceIds: ["evidence:conditional-rollout-accepted:17"],
          confidence: "high"
        }
      ],
      decisions: [],
      openQuestions: [],
      risks: [],
      followUpIntentions: []
    });
    expect(gradeCase(c, correct).automated.every((a) => a.passed)).toBe(true);
    const paraphrase = structuredClone(correct);
    paraphrase.actionItems[0]!.description =
      "Sam erstellt die Checkliste für den möglichen Rollout.";
    expect(gradeCase(c, paraphrase).automated.every((a) => a.passed)).toBe(true);
    for (const mutation of [
      "owner",
      "date",
      "omission",
      "duplicate",
      "citation"
    ] as const) {
      const wrong = structuredClone(correct);
      if (mutation === "owner") wrong.actionItems[0]!.ownerId = "person_alex";
      if (mutation === "date")
        wrong.actionItems[0]!.dueDate.normalizedDate = "2026-09-19";
      if (mutation === "omission") wrong.actionItems = [];
      if (mutation === "duplicate")
        wrong.actionItems.push(structuredClone(wrong.actionItems[0]!));
      if (mutation === "citation")
        wrong.actionItems[0]!.evidenceIds = ["evidence:conditional-rollout-accepted:2"];
      expect(gradeCase(c, wrong).verdict, mutation).toBe("failed");
    }
  });
});

it("permits a clearly conditional candidate offer without accepting it as a confirmed commitment", () => {
  const b = benchmarkSchema.parse(
    JSON.parse(readFileSync("evals/fixtures/provider-quality-v2.json", "utf8"))
  );
  const c = b.cases.find((c) => c.fixture.id === "conditional-rollout-unapproved")!;
  const output = meetingAnalysisSchema.parse({
    actionItems: [
      {
        stableKey: "conditional-offer",
        description:
          "Sam could prepare the checklist only if legal approves; no work or deadline is accepted.",
        ownerId: "person_sam",
        dueDate: {
          originalPhrase: null,
          normalizedDate: null,
          confidence: "unknown",
          timezone: "Europe/Berlin"
        },
        status: "candidate",
        relatedDecisionIds: [],
        evidenceIds: [`evidence:${c.fixture.id}:2`, `evidence:${c.fixture.id}:6`],
        confidence: "medium"
      }
    ],
    decisions: [],
    openQuestions: [],
    risks: [],
    followUpIntentions: []
  });
  expect(gradeCase(c, output).automated.every((a) => a.passed)).toBe(true);
  output.actionItems[0]!.status = "confirmed";
  expect(gradeCase(c, output).verdict).toBe("failed");
});
