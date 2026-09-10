import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";

const id = z.string().min(1);
const check = z
  .object({
    id,
    metric: z.enum([
      "grounding",
      "ownership",
      "modality",
      "decisions",
      "reconciliation",
      "retention",
      "relevant-current-recall",
      "stale-claim-inclusion",
      "context-use",
      "coverage"
    ]),
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
    operation: z.enum([
      "equals",
      "includes",
      "excludes",
      "length-at-most",
      "same-as",
      "set-equals"
    ]),
    expected: z.unknown(),
    note: z.string().optional()
  })
  .strict();
const step = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("observe"),
      id,
      sample: id,
      utterances: z.array(z.number().int().nonnegative()).min(1)
    })
    .strict(),
  z
    .object({
      type: z.literal("judge"),
      id,
      itemId: id,
      correction: z
        .object({
          status: z
            .enum(["candidate", "confirmed", "rejected", "superseded", "planned"])
            .optional(),
          ownerId: z.string().nullable().optional(),
          description: z.string().optional()
        })
        .strict()
    })
    .strict(),
  z.object({ type: z.literal("snapshot"), id }).strict(),
  z
    .object({
      type: z.literal("ask"),
      id,
      text: id,
      participantId: z.string().optional()
    })
    .strict(),
  z.object({ type: z.literal("conclude"), id }).strict(),
  z
    .object({
      type: z.literal("import"),
      id,
      text: id,
      catalog: z.enum(["exact", "unavailable"])
    })
    .strict(),
  z.object({ type: z.literal("reconciliation"), id }).strict()
]);
const missing = z
  .object({ id, metric: check.shape.metric, reason: id, acceptance: id })
  .strict();
export const corpusSchema = z
  .object({
    version: z.literal(2),
    annotationProvenance: id,
    referenceAt: z.string().datetime(),
    timezone: z.literal("Europe/Berlin"),
    fixtures: z
      .array(
        z
          .object({
            id,
            language: z.enum(["de", "en", "mixed"]),
            utterances: z.array(
              z
                .object({
                  speakerId: id,
                  text: id,
                  occurredAt: z.string().datetime().optional()
                })
                .strict()
            ),
            expected: z.object({ checks: z.array(id).min(1) }).strict(),
            steps: z.array(step).min(1),
            assertions: z.array(check),
            missing: z.array(missing)
          })
          .strict()
      )
      .min(1)
  })
  .strict();
export type MeetingCorpus = z.infer<typeof corpusSchema>;
export type CorpusFixture = MeetingCorpus["fixtures"][number];
export type SemanticCheck = z.infer<typeof check>;
export type Metric = SemanticCheck["metric"];

const confidence = z.enum(["low", "medium", "high"]);
const supported = { evidenceIds: z.array(id), confidence };
const dueDate = z
  .object({
    originalPhrase: z.string().nullable(),
    normalizedDate: z.string().nullable(),
    confidence: z.enum(["exact", "normalized", "ambiguous", "unknown"]),
    timezone: id
  })
  .strict();
export const batchSchema = z
  .object({
    actionItems: z.array(
      z
        .object({
          stableKey: id,
          description: id,
          ownerId: z.string().nullable(),
          dueDate,
          status: z.enum([
            "candidate",
            "confirmed",
            "planned",
            "in-progress",
            "blocked",
            "completed",
            "cancelled"
          ]),
          relatedDecisionIds: z.array(id),
          ...supported
        })
        .strict()
    ),
    decisions: z.array(
      z
        .object({
          stableKey: id,
          statement: id,
          rationale: z.array(z.string()),
          status: z.enum(["candidate", "confirmed", "rejected", "superseded"]),
          supportingParticipantIds: z.array(id),
          objectingParticipantIds: z.array(id),
          relatedTopicIds: z.array(id),
          ...supported
        })
        .strict()
    ),
    openQuestions: z.array(
      z
        .object({
          stableKey: id,
          question: id,
          raisedBy: z.string().nullable(),
          ...supported
        })
        .strict()
    ),
    risks: z.array(
      z
        .object({
          stableKey: id,
          statement: id,
          severity: z.enum(["low", "medium", "high", "unknown"]),
          mitigation: z.string().nullable(),
          ...supported
        })
        .strict()
    ),
    followUpIntentions: z.array(
      z
        .object({
          type: z.literal("create-work-item"),
          id,
          title: id,
          description: id,
          assigneeId: z.string().nullable(),
          mentionPersonIds: z.array(id),
          dueDate: z.string().nullable(),
          relatedMeetingItemIds: z.array(id),
          ...supported
        })
        .strict()
    )
  })
  .strict();
export const samplesSchema = z
  .object({
    version: z.literal(1),
    provenance: z.literal("agent-authored-synthetic; not a live provider recording"),
    model: z.literal("synthetic-programmable-v1"),
    samples: z.record(id, batchSchema)
  })
  .strict();
export type SampleArchive = z.infer<typeof samplesSchema>;

export async function loadCorpus(corpusPath: string, samplesPath: string) {
  const [corpusText, samplesText] = await Promise.all([
    readFile(corpusPath, "utf8"),
    readFile(samplesPath, "utf8")
  ]);
  const corpus = corpusSchema.parse(JSON.parse(corpusText) as unknown);
  const samples = samplesSchema.parse(JSON.parse(samplesText) as unknown);
  validateCoverage(corpus, samples);
  return {
    corpus,
    samples,
    corpusSha256: digest(corpusText),
    samplesSha256: digest(samplesText)
  };
}

export function validateCoverage(corpus: MeetingCorpus, samples: SampleArchive): void {
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
  };
  unique(
    corpus.fixtures.map((fixture) => fixture.id),
    "fixture ID"
  );
  for (const fixture of corpus.fixtures) {
    unique(
      fixture.steps.map((value) => value.id),
      `step ID in ${fixture.id}`
    );
    unique(fixture.expected.checks, `expected check in ${fixture.id}`);
    const represented = [...fixture.assertions, ...fixture.missing].map(
      (value) => value.id
    );
    unique(represented, `check ID in ${fixture.id}`);
    if (
      JSON.stringify([...represented].sort()) !==
      JSON.stringify([...fixture.expected.checks].sort())
    ) {
      throw new Error(
        `Every expected check must be measured or explicitly missing in ${fixture.id}`
      );
    }
    for (const entry of fixture.steps) {
      if (entry.type !== "observe") continue;
      if (!samples.samples[entry.sample])
        throw new Error(`Missing sample ${entry.sample}`);
      for (const index of entry.utterances) {
        if (!fixture.utterances[index])
          throw new Error(`Missing utterance ${fixture.id}:${index}`);
      }
    }
  }
}

export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
