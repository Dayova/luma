import { createHash } from "node:crypto";
import { z } from "zod";
import { meetingAnalysisSchema } from "../../ai/meeting-analysis-contract.js";
import {
  corpusSchema,
  scoreProposal,
  type Fixture
} from "../provider-comparison/corpus.js";

const id = z.string().min(1).max(160);
const severity = z.enum(["critical", "major", "minor"]);
const dimension = z.enum([
  "ownership",
  "modality",
  "decision",
  "deadline",
  "recall",
  "grounding",
  "attribution",
  "format"
]);
const condition = z.discriminatedUnion("op", [
  z
    .object({
      field: id,
      op: z.literal("equals"),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()])
    })
    .strict(),
  z
    .object({
      field: id,
      op: z.enum(["set-equals", "contains-all", "not-in"]),
      values: z.array(z.string())
    })
    .strict()
]);
const rule = z
  .object({
    id,
    dimension,
    severity,
    collection: z.enum([
      "actionItems",
      "decisions",
      "openQuestions",
      "risks",
      "followUpIntentions"
    ]),
    where: z.array(condition),
    every: z.array(condition),
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative()
  })
  .strict()
  .refine((r) => r.max >= r.min, "Invalid count range");
const rubric = z
  .object({ id, dimension, severity, question: z.string().min(1) })
  .strict();
const fields: Record<z.infer<typeof rule>["collection"], string[]> = {
  actionItems: [
    "stableKey",
    "description",
    "ownerId",
    "dueDate.originalPhrase",
    "dueDate.normalizedDate",
    "dueDate.confidence",
    "dueDate.timezone",
    "status",
    "relatedDecisionIds",
    "evidenceIds",
    "confidence"
  ],
  decisions: [
    "stableKey",
    "statement",
    "rationale",
    "status",
    "supportingParticipantIds",
    "objectingParticipantIds",
    "relatedTopicIds",
    "evidenceIds",
    "confidence"
  ],
  openQuestions: ["stableKey", "question", "raisedBy", "evidenceIds", "confidence"],
  risks: [
    "stableKey",
    "statement",
    "severity",
    "mitigation",
    "evidenceIds",
    "confidence"
  ],
  followUpIntentions: [
    "id",
    "type",
    "title",
    "description",
    "assigneeId",
    "mentionPersonIds",
    "dueDate",
    "relatedMeetingItemIds",
    "evidenceIds",
    "confidence",
    "bodyMarkdown",
    "externalReference.providerId",
    "externalReference.externalId",
    "externalReference.objectType",
    "externalReference.url"
  ]
};
export const qualityCaseSchema = z
  .object({
    fixture: z.custom<Fixture>(
      (value) =>
        corpusSchema.safeParse({
          version: 1,
          provenance: "agent-authored-synthetic-not-human-labeled",
          fixtures: [value]
        }).success
    ),
    groupId: id,
    cohort: z.enum(["regression", "representative", "challenge"]),
    split: z.enum(["development", "holdout"]),
    author: id,
    independentReview: z
      .object({ reviewerId: id, reviewedAt: z.string().datetime() })
      .strict()
      .nullable(),
    rules: z.array(rule),
    rubric: z.array(rubric).min(1)
  })
  .strict()
  .superRefine((c, ctx) => {
    const ids = [...c.rules, ...c.rubric].map((r) => r.id);
    if (
      new Set(ids).size !== ids.length ||
      ids.some(
        (id) => id === "schema" || id === "citations-exist" || id.startsWith("legacy:")
      )
    )
      ctx.addIssue({ code: "custom", message: "Duplicate rule or rubric IDs" });
    if (
      (c.split === "holdout" && !c.independentReview) ||
      c.author === c.independentReview?.reviewerId
    )
      ctx.addIssue({
        code: "custom",
        message: "Holdout requires independent review attestation"
      });
    for (const r of c.rules)
      for (const condition of [...r.where, ...r.every])
        if (!fields[r.collection].includes(condition.field))
          ctx.addIssue({ code: "custom", message: "Unknown grading field" });
  });
export type QualityCase = z.infer<typeof qualityCaseSchema>;
export const benchmarkSchema = z
  .object({
    version: z.literal(2),
    id,
    revision: id,
    provenance: z.enum(["synthetic-development", "human-reviewed-meetings"]),
    cases: z.array(qualityCaseSchema).min(1)
  })
  .strict()
  .superRefine((b, ctx) => {
    if (new Set(b.cases.map((c) => c.fixture.id)).size !== b.cases.length)
      ctx.addIssue({ code: "custom", message: "Duplicate case IDs" });
    const groups = new Map<string, string>();
    for (const c of b.cases) {
      if (groups.has(c.groupId) && groups.get(c.groupId) !== c.split)
        ctx.addIssue({
          code: "custom",
          message: "A meeting group cannot cross development and holdout"
        });
      groups.set(c.groupId, c.split);
      if (b.provenance === "synthetic-development" && c.split === "holdout")
        ctx.addIssue({
          code: "custom",
          message: "Synthetic development cases are not independent holdouts"
        });
      if (b.provenance === "human-reviewed-meetings" && !c.independentReview)
        ctx.addIssue({ code: "custom", message: "Missing human review attestation" });
    }
  });
export type Benchmark = z.infer<typeof benchmarkSchema>;
export type Assessment = {
  id: string;
  dimension: string;
  severity: "critical" | "major" | "minor";
  passed: boolean;
};
export const semanticReviewSchema = z
  .object({
    answerId: z.string().regex(/^[a-f0-9]{64}$/),
    reviewer: z.object({ id, kind: z.enum(["human", "agent"]) }).strict(),
    reviewedAt: z.string().datetime(),
    judgments: z.array(
      z
        .object({
          rubricId: id,
          verdict: z.enum(["pass", "fail", "uncertain"]),
          explanation: z.string().min(1),
          evidenceIds: z.array(id)
        })
        .strict()
    )
  })
  .strict();
export type SemanticReview = z.infer<typeof semanticReviewSchema>;
export type Grade = {
  answerId: string;
  automated: Assessment[];
  semantic: {
    id: string;
    dimension: string;
    severity: "critical" | "major" | "minor";
    verdict: "pending" | "pass" | "fail" | "uncertain";
  }[];
  review: SemanticReview | null;
  verdict: "failed" | "needs-review" | "passed";
};

/** Canonical digests bind labels to case content and output, independent of model identity. */
export function digest(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, child]) => [k, canonical(child)])
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function matches(item: unknown, c: z.infer<typeof condition>): boolean {
  const value = c.field
    .split(".")
    .reduce<unknown>(
      (v, key) =>
        v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined,
      item
    );
  if (c.op === "equals") return value === c.value;
  if (c.op === "not-in") return typeof value === "string" && !c.values.includes(value);
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return false;
  return c.op === "contains-all"
    ? c.values.every((v) => value.includes(v))
    : new Set(value).size === new Set(c.values).size &&
        c.values.every((v) => value.includes(v));
}

export function gradeCase(
  c: QualityCase,
  output: unknown,
  review?: SemanticReview
): Grade {
  const answerId = digest({ case: c, output });
  const known = new Set(
    c.fixture.utterances.map((_, i) => `evidence:${c.fixture.id}:${i + 1}`)
  );
  if (review) {
    semanticReviewSchema.parse(review);
    if (review.answerId !== answerId)
      throw new Error("Review does not match this answer and case");
    if (
      new Set(review.judgments.map((j) => j.rubricId)).size !== review.judgments.length ||
      review.judgments.some(
        (j) =>
          !c.rubric.some((r) => r.id === j.rubricId) ||
          j.evidenceIds.some((e) => !known.has(e))
      )
    )
      throw new Error("Review contains unknown or duplicate rubric/evidence references");
  }
  const semantic: Grade["semantic"] = c.rubric.map((r) => ({
    id: r.id,
    dimension: r.dimension,
    severity: r.severity,
    verdict:
      review?.reviewer.kind === "human"
        ? (review.judgments.find((j) => j.rubricId === r.id)?.verdict ?? "pending")
        : "pending"
  }));
  const parsed = meetingAnalysisSchema.safeParse(output);
  if (!parsed.success)
    return {
      answerId,
      automated: [
        { id: "schema", dimension: "format", severity: "critical", passed: false }
      ],
      semantic,
      review: review ?? null,
      verdict: "failed"
    };
  const automated: Assessment[] = scoreProposal(c.fixture, parsed.data).map((check) => ({
    id: `legacy:${check.id}`,
    dimension: check.dimension,
    severity: "major",
    passed: check.passed
  }));
  automated.push({
    id: "citations-exist",
    dimension: "grounding",
    severity: "critical",
    passed: Object.values(parsed.data)
      .flat()
      .every((item) => item.evidenceIds.every((e) => known.has(e)))
  });
  for (const r of c.rules) {
    const selected = parsed.data[r.collection].filter((item) =>
      r.where.every((condition) => matches(item, condition))
    );
    automated.push({
      id: r.id,
      dimension: r.dimension,
      severity: r.severity,
      passed:
        selected.length >= r.min &&
        selected.length <= r.max &&
        selected.every((item) => r.every.every((condition) => matches(item, condition)))
    });
  }
  return {
    answerId,
    automated,
    semantic,
    review: review ?? null,
    verdict:
      automated.some((a) => !a.passed) || semantic.some((s) => s.verdict === "fail")
        ? "failed"
        : semantic.every((s) => s.verdict === "pass")
          ? "passed"
          : "needs-review"
  };
}
