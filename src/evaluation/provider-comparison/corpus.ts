import { z } from "zod";
import type {
  MeetingAnalysisProposalBatch,
  StructuredReasoningRequest
} from "../../ai/reasoning-model.js";
import { comparisonPromptVersion } from "./providers.js";

const conditionSchema = z.discriminatedUnion("op", [
  z
    .object({
      field: z.string(),
      op: z.literal("equals"),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()])
    })
    .strict(),
  z
    .object({
      field: z.string(),
      op: z.literal("includes-any"),
      values: z.array(z.string().min(1)).min(1)
    })
    .strict(),
  z
    .object({
      field: z.string(),
      op: z.literal("not-in"),
      values: z.array(z.string()).min(1)
    })
    .strict()
]);
const checkSchema = z
  .object({
    id: z.string().min(1),
    dimension: z.enum([
      "ownership",
      "modality",
      "decision",
      "deadline",
      "recall",
      "grounding"
    ]),
    collection: z.enum([
      "actionItems",
      "decisions",
      "openQuestions",
      "risks",
      "followUpIntentions"
    ]),
    where: z.array(conditionSchema),
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative()
  })
  .strict()
  .refine((check) => check.max >= check.min);
export const corpusSchema = z
  .object({
    version: z.literal(1),
    provenance: z.literal("agent-authored-synthetic-not-human-labeled"),
    fixtures: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9-]+$/),
            language: z.enum(["de", "en", "mixed"]),
            occurredAt: z.string().datetime(),
            timezone: z.literal("Europe/Berlin"),
            utterances: z
              .array(
                z
                  .object({ speakerId: z.string().min(1), text: z.string().min(1) })
                  .strict()
              )
              .min(1),
            checks: z.array(checkSchema).min(1),
            manualReview: z.string().min(1)
          })
          .strict()
      )
      .min(1)
  })
  .strict()
  .superRefine((corpus, ctx) => {
    if (new Set(corpus.fixtures.map((f) => f.id)).size !== corpus.fixtures.length)
      ctx.addIssue({ code: "custom", message: "Duplicate fixture ID" });
    for (const fixture of corpus.fixtures)
      if (new Set(fixture.checks.map((c) => c.id)).size !== fixture.checks.length)
        ctx.addIssue({ code: "custom", message: "Duplicate check ID" });
  });
export type Corpus = z.infer<typeof corpusSchema>;
export type Fixture = Corpus["fixtures"][number];
export type CheckResult = {
  id: string;
  dimension: string;
  passed: boolean;
  matched: number;
  expectedMin: number;
  expectedMax: number;
};

export function requestForFixture(
  fixture: Fixture
): StructuredReasoningRequest<MeetingAnalysisProposalBatch> {
  return {
    workspaceId: "workspace_synthetic_evaluation",
    meetingId: `meeting_${fixture.id}`,
    purpose: "understand-discussion",
    promptVersion: comparisonPromptVersion,
    schemaName: "MeetingAnalysisProposalBatch",
    context: [],
    evidence: fixture.utterances.map((u, index) => ({
      evidenceId: `evidence:${fixture.id}:${index + 1}`,
      source: "transcript",
      sourceObjectId: `utterance_${index + 1}`,
      sourceVersion: "1",
      participantId: u.speakerId,
      excerpt: u.text,
      startedAtMs: Date.parse(fixture.occurredAt) + index * 10_000,
      endedAtMs: Date.parse(fixture.occurredAt) + index * 10_000 + 9_000
    })),
    input: { revision: 1, timezone: fixture.timezone, languagePolicy: "meeting-majority" }
  };
}

/** Transparent, limited predicates. Passing is not a semantic correctness verdict. */
export function scoreProposal(
  fixture: Fixture,
  value: MeetingAnalysisProposalBatch
): CheckResult[] {
  return fixture.checks.map((check) => {
    const matched = value[check.collection].filter((item) =>
      check.where.every((condition) => {
        const field = condition.field
          .split(".")
          .reduce<unknown>(
            (current, key) =>
              current && typeof current === "object"
                ? (current as Record<string, unknown>)[key]
                : undefined,
            item
          );
        if (condition.op === "equals") return field === condition.value;
        if (condition.op === "not-in")
          return typeof field === "string" && !condition.values.includes(field);
        const haystack =
          typeof field === "string"
            ? field.toLocaleLowerCase("en")
            : Array.isArray(field)
              ? field
                  .filter((v): v is string => typeof v === "string")
                  .join(" ")
                  .toLocaleLowerCase("en")
              : "";
        return condition.values.some((needle) =>
          haystack.includes(needle.toLocaleLowerCase("en"))
        );
      })
    ).length;
    return {
      id: check.id,
      dimension: check.dimension,
      matched,
      expectedMin: check.min,
      expectedMax: check.max,
      passed: matched >= check.min && matched <= check.max
    };
  });
}
