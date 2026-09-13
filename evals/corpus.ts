import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { decisionRecordContentSchema } from "../src/domain/decision-record-schemas.js";

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
const source = z
  .object({
    id,
    kind: z.enum([
      "knowledge-document",
      "work-item",
      "code-change",
      "previous-meeting-item"
    ]),
    title: id,
    content: id,
    version: id,
    updatedAt: z.string().datetime(),
    externalReference: z
      .object({
        providerId: id,
        objectType: z.enum([
          "document",
          "work-item",
          "pull-request",
          "commit",
          "comment",
          "project",
          "other"
        ]),
        externalId: id,
        url: z.string().url()
      })
      .strict(),
    standing: z.enum(["current", "proposed", "disputed", "superseded", "historical"]),
    authority: z.enum(["human-confirmed", "source", "ai-inference"]),
    effectiveAt: z.string().datetime().optional(),
    decisionKey: id.optional(),
    supersedes: z.array(id).optional()
  })
  .strict();
const catalogChange = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("revoke"), catalogId: id, sourceId: id, personId: id })
    .strict(),
  z.object({ type: z.literal("delete"), catalogId: id, sourceId: id }).strict(),
  z.object({ type: z.literal("replace"), catalogId: id, source }).strict()
]);
const retrievalStep = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("inquire"),
      id,
      inquiryId: id,
      time: z
        .discriminatedUnion("mode", [
          z.object({ mode: z.literal("current") }).strict(),
          z
            .object({
              mode: z.literal("history"),
              asOf: z.string().datetime().optional()
            })
            .strict()
        ])
        .optional(),
      duringAnswer: catalogChange.optional()
    })
    .strict(),
  z.object({ type: z.literal("require-current"), id, inquiryId: id }).strict(),
  z.object({ type: z.literal("change"), id, change: catalogChange }).strict(),
  z.object({ type: z.literal("retained-snapshots"), id }).strict()
]);
const retrievalFixture = z
  .object({
    id,
    question: id,
    recipients: z.array(id).length(4),
    limits: z
      .object({
        limit: z.number().int().positive(),
        maxCharacters: z.number().int().positive()
      })
      .strict(),
    catalogs: z.array(z.object({ id, complete: z.boolean() }).strict()),
    sources: z.array(
      z.object({ catalogId: id, source, readableBy: z.array(id).min(1) }).strict()
    ),
    expected: z.object({ checks: z.array(id).min(1) }).strict(),
    steps: z.array(retrievalStep).min(1),
    assertions: z.array(check),
    missing: z.array(missing)
  })
  .strict();
export const corpusSchema = z
  .object({
    version: z.literal(6),
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
            missing: z.array(missing),
            coveredBy: z.array(z.object({ id, fixtureId: id }).strict()).default([])
          })
          .strict()
      )
      .min(1),
    retrievalFixtures: z.array(retrievalFixture).min(1),
    crossProviderFixtures: z
      .array(
        z
          .object({
            id,
            question: id,
            canonicalRecord: decisionRecordContentSchema,
            notion: z.object({ content: id, standing: source.shape.standing }).strict(),
            linear: z.object({ content: id, standing: source.shape.standing }).strict(),
            github: z
              .object({
                content: id,
                state: z.enum(["draft", "open", "closed", "merged"])
              })
              .strict(),
            revokeBeforeReplay: z.boolean(),
            expected: z.object({ checks: z.array(id).min(1) }).strict(),
            assertions: z.array(check).min(1)
          })
          .strict()
      )
      .min(1),
    importedMeetingFixtures: z
      .array(
        z
          .object({
            id,
            question: id,
            statement: id,
            confirm: z.boolean(),
            revokeBeforeReplay: z.boolean(),
            expected: z.object({ checks: z.array(id).min(1) }),
            assertions: z.array(check).min(1)
          })
          .strict()
      )
      .min(1),
    githubFixtures: z
      .array(
        z
          .object({
            id,
            question: id,
            repository: id,
            path: id,
            content: id,
            recipients: z.array(id).min(1),
            changeHeadBeforeReplay: z.boolean(),
            revokeBeforeFresh: z.boolean(),
            expected: z.object({ checks: z.array(id).min(1) }).strict(),
            assertions: z.array(check).min(1)
          })
          .strict()
      )
      .min(1)
  })
  .strict();
export type MeetingCorpus = z.infer<typeof corpusSchema>;
export type CorpusFixture = MeetingCorpus["fixtures"][number];
export type RetrievalFixture = MeetingCorpus["retrievalFixtures"][number];
export type ImportedMeetingFixture = MeetingCorpus["importedMeetingFixtures"][number];
export type GitHubFixture = MeetingCorpus["githubFixtures"][number];
export type CrossProviderFixture = MeetingCorpus["crossProviderFixtures"][number];
export type CatalogChange = z.infer<typeof catalogChange>;
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
    [
      ...corpus.fixtures,
      ...corpus.retrievalFixtures,
      ...corpus.githubFixtures,
      ...corpus.crossProviderFixtures,
      ...corpus.importedMeetingFixtures
    ].map((fixture) => fixture.id),
    "fixture ID"
  );
  for (const fixture of corpus.fixtures) {
    unique(
      fixture.steps.map((value) => value.id),
      `step ID in ${fixture.id}`
    );
    unique(fixture.expected.checks, `expected check in ${fixture.id}`);
    const represented = [
      ...fixture.assertions,
      ...fixture.missing,
      ...fixture.coveredBy
    ].map((value) => value.id);
    unique(represented, `check ID in ${fixture.id}`);
    if (
      JSON.stringify([...represented].sort()) !==
      JSON.stringify([...fixture.expected.checks].sort())
    ) {
      throw new Error(
        `Every expected check must be measured or explicitly missing in ${fixture.id}`
      );
    }
    for (const link of fixture.coveredBy) {
      const target = [
        ...corpus.retrievalFixtures,
        ...corpus.githubFixtures,
        ...corpus.crossProviderFixtures,
        ...corpus.importedMeetingFixtures
      ].find((value) => value.id === link.fixtureId);
      if (!target?.assertions.some((value) => value.id === link.id))
        throw new Error(
          `Missing executable retrieval coverage ${link.id} in ${link.fixtureId}`
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
  for (const fixture of corpus.retrievalFixtures) {
    unique(fixture.recipients, `recipient in ${fixture.id}`);
    unique(
      fixture.catalogs.map((value) => value.id),
      `catalog in ${fixture.id}`
    );
    unique(
      fixture.sources.map((value) => `${value.catalogId}:${value.source.id}`),
      `source in ${fixture.id}`
    );
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
    )
      throw new Error(
        `Every expected retrieval check must be measured or explicitly missing in ${fixture.id}`
      );
    for (const entry of fixture.sources) {
      if (!fixture.catalogs.some((catalog) => catalog.id === entry.catalogId))
        throw new Error(`Unknown catalog ${entry.catalogId} in ${fixture.id}`);
    }
  }
  for (const fixture of [
    ...corpus.githubFixtures,
    ...corpus.importedMeetingFixtures,
    ...corpus.crossProviderFixtures
  ]) {
    if ("recipients" in fixture) unique(fixture.recipients, `recipient in ${fixture.id}`);
    unique(fixture.expected.checks, `expected check in ${fixture.id}`);
    unique(
      fixture.assertions.map((check) => check.id),
      `assertion in ${fixture.id}`
    );
    if (
      JSON.stringify([...fixture.expected.checks].sort()) !==
      JSON.stringify(fixture.assertions.map((check) => check.id).sort())
    )
      throw new Error(`Every adapter expected check must be executable in ${fixture.id}`);
  }
}

export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
