import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../src/ai/reasoning-model.js";
import type { MeetingState, MeetingObservation } from "../src/domain/model.js";
import { createMeetingIntelligence } from "../src/meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase, type LumaDatabase } from "../src/persistence/db.js";
import type { WorkCatalog, WorkItem } from "../src/work/interface.js";
import {
  batchSchema,
  digest,
  validateCoverage,
  type CorpusFixture,
  type MeetingCorpus,
  type SampleArchive
} from "./corpus.js";
import { importedObservation } from "./imported-source.js";
import { score, summarize, type CheckResult } from "./scorer.js";

type RequestRecord = {
  sampleId: string;
  promptVersion: string;
  schema: string;
  input: Record<string, unknown>;
  evidenceExcerpts: (string | undefined)[];
  context: string[];
  inputCharacters: number;
  contextCharacters: number;
  contextEntries: number;
};

class ReplayModel implements ReasoningModel {
  sampleId = "";
  readonly requests: RequestRecord[] = [];
  constructor(private readonly archive: SampleArchive) {}
  generateStructured<T>(
    request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    const sample = this.archive.samples[this.sampleId];
    if (!sample) return Promise.reject(new Error(`No sample selected: ${this.sampleId}`));
    const batch: MeetingAnalysisProposalBatch = batchSchema.parse(
      structuredClone(sample)
    );
    for (const item of [
      ...batch.actionItems,
      ...batch.decisions,
      ...batch.openQuestions,
      ...batch.risks,
      ...batch.followUpIntentions
    ]) {
      item.evidenceIds = item.evidenceIds.map((reference) => {
        if (!reference.startsWith("$")) return reference;
        const evidence = request.evidence[Number(reference.slice(1))];
        if (!evidence)
          throw new Error(
            `Sample ${this.sampleId} references absent Evidence ${reference}`
          );
        return evidence.evidenceId;
      });
    }
    this.requests.push({
      sampleId: this.sampleId,
      promptVersion: request.promptVersion,
      schema: request.schemaName,
      input: structuredClone(request.input),
      evidenceExcerpts: request.evidence.map((reference) => reference.excerpt),
      context: [...request.context],
      inputCharacters: JSON.stringify(request).length,
      contextCharacters: request.context.reduce((sum, value) => sum + value.length, 0),
      contextEntries: request.context.length
    });
    return Promise.resolve({
      value: batch as T,
      metadata: {
        provider: "synthetic",
        model: this.archive.model,
        promptVersion: request.promptVersion
      }
    });
  }
}

function projection(state: MeetingState) {
  return {
    state,
    actions: Object.fromEntries(state.actionItems.map((item) => [item.id, item])),
    decisions: Object.fromEntries(state.decisions.map((item) => [item.id, item])),
    claims: [
      ...state.actionItems.map((item) => item.id),
      ...state.decisions.map((item) => item.id),
      ...state.openQuestions.map((item) => item.id),
      ...state.risks.map((item) => item.id)
    ].sort(),
    claimTexts: [
      ...state.actionItems.map((item) => item.description),
      ...state.decisions.map((item) => item.statement),
      ...state.openQuestions.map((item) => item.question),
      ...state.risks.map((item) => item.statement)
    ].sort(),
    sourceExcerpts: [
      ...state.actionItems,
      ...state.decisions,
      ...state.openQuestions,
      ...state.risks
    ].flatMap((item) => item.provenance.evidence.map((reference) => reference.excerpt)),
    followUpStatuses: state.followUpIntentions.map((intent) => intent.status),
    externalWorkReferences: state.actionItems.flatMap((item) => item.externalReferences)
  };
}

async function runFixture(
  database: LumaDatabase,
  fixture: CorpusFixture,
  corpus: MeetingCorpus,
  samples: SampleArchive
) {
  const workspaceId = `eval:${fixture.id}`;
  const meetingId = `meeting:${fixture.id}`;
  const workspace = { workspaceId, timezone: corpus.timezone };
  const model = new ReplayModel(samples);
  let catalogMode: "exact" | "unavailable" = "exact";
  let catalogReads = 0;
  const item: WorkItem = {
    id: "eval-work",
    providerId: "linear",
    externalId: "LUM-3",
    title: "Finish LUM-3 source import",
    description: "Jakob will finish LUM-3 source import by 2026-09-11.",
    status: "planned",
    assignees: [],
    dueDate: "2026-09-11",
    labels: [],
    projectId: null,
    parentId: null,
    url: "https://example.invalid/LUM-3",
    updatedAt: corpus.referenceAt
  };
  const catalog: WorkCatalog = {
    providerId: "linear",
    supportsConditionalUpdates: true,
    searchWorkItems: () => {
      catalogReads += 1;
      return catalogMode === "unavailable"
        ? Promise.reject(new Error("Synthetic catalog outage"))
        : Promise.resolve([item]);
    },
    getWorkItem: () => {
      catalogReads += 1;
      return Promise.resolve(item);
    }
  };
  const intelligence = createMeetingIntelligence({
    database,
    reasoningModel: model,
    now: () => new Date(corpus.referenceAt),
    workCatalogs: [catalog],
    importedSourceObservationVerifier: {
      verify: () => Promise.resolve({ status: "verified" })
    }
  });
  const outputs: Record<string, unknown> = {};
  const updates = [];
  for (const step of fixture.steps) {
    switch (step.type) {
      case "observe": {
        model.sampleId = step.sample;
        const observations: MeetingObservation[] = step.utterances.map((index) => {
          const utterance = fixture.utterances[index];
          if (!utterance) throw new Error("Missing validated Utterance");
          const occurredAt = utterance.occurredAt ?? corpus.referenceAt;
          return {
            type: "utterance-committed",
            observationId: `${step.id}:${index}`,
            workspaceId,
            meetingId,
            occurredAt,
            observedAt: occurredAt,
            utteranceId: `${step.id}:${index}`,
            version: 1,
            speaker: {
              status: "attributed",
              personId: utterance.speakerId,
              confidence: "deterministic",
              basis: "provider-identity"
            },
            startedAt: occurredAt,
            endedAt: occurredAt,
            originalText: utterance.text,
            language: fixture.language
          };
        });
        const update = await intelligence.observe({ workspace, observations });
        outputs[step.id] = update;
        updates.push(update);
        break;
      }
      case "judge": {
        const update = await intelligence.observe({
          workspace,
          observations: [
            {
              type: "human-judgment-recorded",
              observationId: step.id,
              workspaceId,
              meetingId,
              occurredAt: corpus.referenceAt,
              observedAt: corpus.referenceAt,
              participantId: "person_jakob",
              judgment: {
                kind: "correct",
                meetingItemId: step.itemId,
                correction: {
                  ...(step.correction.status !== undefined
                    ? { status: step.correction.status }
                    : {}),
                  ...(step.correction.ownerId !== undefined
                    ? { ownerId: step.correction.ownerId }
                    : {}),
                  ...(step.correction.description !== undefined
                    ? { description: step.correction.description }
                    : {})
                }
              }
            }
          ]
        });
        outputs[step.id] = update;
        updates.push(update);
        break;
      }
      case "snapshot": {
        const result = await intelligence.query({
          workspaceId,
          meetingId,
          query: { type: "snapshot" }
        });
        if (result.type !== "snapshot") throw new Error("Expected snapshot");
        outputs[step.id] = projection(result.state);
        break;
      }
      case "ask": {
        const result = await intelligence.query({
          workspaceId,
          meetingId,
          query: {
            type: "freeform",
            text: step.text,
            ...(step.participantId ? { participantId: step.participantId } : {})
          }
        });
        if (result.type !== "freeform") throw new Error("Expected grounded answer");
        outputs[step.id] = result.answer;
        break;
      }
      case "conclude":
        outputs[step.id] = await intelligence.conclude({ workspaceId, meetingId });
        break;
      case "import": {
        catalogMode = step.catalog;
        const update = await intelligence.observe({
          workspace,
          observations: [
            importedObservation(workspaceId, meetingId, step.text, corpus.referenceAt)
          ]
        });
        outputs[step.id] = update;
        updates.push(update);
        break;
      }
      case "reconciliation": {
        const result = await intelligence.query({
          workspaceId,
          meetingId,
          query: { type: "action-item-reconciliation-review" }
        });
        if (result.type !== "action-item-reconciliation-review")
          throw new Error("Expected reconciliation review");
        outputs[step.id] = result.reviews;
        break;
      }
    }
  }
  outputs["requests"] = model.requests;
  outputs["catalogReads"] = catalogReads;
  const checks = fixture.assertions.map((check) => score(check, outputs));
  checks.push(
    ...fixture.missing.map((check): CheckResult => ({
      id: check.id,
      metric: check.metric,
      status: "missing",
      expected: check.acceptance,
      actual: null,
      note: check.reason
    }))
  );
  // Acceptance errors must never disappear behind a failed/missing semantic path.
  const errors = updates.flatMap((update) => update.errors);
  checks.push({
    id: "observations-accepted-without-errors",
    metric: "coverage",
    status: errors.length === 0 ? "passed" : "failed",
    expected: [],
    actual: errors
  });
  return {
    id: fixture.id,
    checks,
    outputs,
    contextUse: {
      requests: model.requests.length,
      inputCharacters: model.requests.reduce(
        (sum, request) => sum + request.inputCharacters,
        0
      ),
      contextCharacters: model.requests.reduce(
        (sum, request) => sum + request.contextCharacters,
        0
      ),
      contextEntries: model.requests.reduce(
        (sum, request) => sum + request.contextEntries,
        0
      )
    }
  };
}

export async function evaluateCorpus(corpus: MeetingCorpus, samples: SampleArchive) {
  validateCoverage(corpus, samples);
  const database = await createPgliteDatabase();
  try {
    const fixtures = [];
    for (const fixture of corpus.fixtures)
      fixtures.push(await runFixture(database, fixture, corpus, samples));
    const checks = fixtures.flatMap((fixture) => fixture.checks);
    const recall = checks.filter(
      (check) => check.metric === "relevant-current-recall" && check.status !== "missing"
    );
    const stale = checks.filter(
      (check) => check.metric === "stale-claim-inclusion" && check.status !== "missing"
    );
    const observedStale = stale.filter((check) => typeof check.actual === "string");
    const metrics = Object.fromEntries(
      [...new Set(checks.map((check) => check.metric))].map((metric) => [
        metric,
        summarize(checks.filter((check) => check.metric === metric))
      ])
    );
    return {
      reportVersion: 1,
      mode: "deterministic-synthetic-replay",
      corpusVersion: corpus.version,
      corpusSha256: digest(JSON.stringify(corpus)),
      samplesSha256: digest(JSON.stringify(samples)),
      annotationProvenance: corpus.annotationProvenance,
      model: {
        name: samples.model,
        provenance: samples.provenance,
        liveQuality: "unmeasured",
        promptVersions: [
          ...new Set(
            fixtures.flatMap((fixture) => {
              const requests = fixture.outputs["requests"] as RequestRecord[];
              return requests.map((request) => request.promptVersion);
            })
          )
        ]
      },
      configuration: {
        referenceAt: corpus.referenceAt,
        timezone: corpus.timezone,
        persistence: "fresh-in-memory-PGlite",
        externalProviders: "synthetic-read-only",
        fixtures: fixtures.map((fixture) => fixture.id)
      },
      usage: {
        paidRequests: 0,
        inputTokens: null,
        outputTokens: null,
        actualCostUsd: 0,
        note: "Character counts are measured separately; no live token usage or quality is inferred."
      },
      summary: summarize(checks),
      metrics,
      knowledgeSelection: {
        scope:
          "Annotated facts in this corpus's scoped Meeting answers; not organization-wide retrieval",
        relevantCurrentRecall: {
          recalled: recall.filter((check) => check.status === "passed").length,
          relevant: recall.length,
          ratio: recall.length
            ? recall.filter((check) => check.status === "passed").length / recall.length
            : null
        },
        staleClaimInclusion: {
          included: observedStale.filter((check) => check.status === "failed").length,
          annotatedStaleOrUnaccepted: stale.length,
          unobserved: stale.length - observedStale.length,
          ratio: observedStale.length
            ? observedStale.filter((check) => check.status === "failed").length /
              observedStale.length
            : null
        },
        contextUse: {
          inputCharacters: fixtures.reduce(
            (sum, fixture) => sum + fixture.contextUse.inputCharacters,
            0
          ),
          additionalContextCharacters: fixtures.reduce(
            (sum, fixture) => sum + fixture.contextUse.contextCharacters,
            0
          ),
          additionalContextEntries: fixtures.reduce(
            (sum, fixture) => sum + fixture.contextUse.contextEntries,
            0
          ),
          note: "Zero additional context means no retrieval was demonstrated; it is not a quality improvement. Character counts are not token counts."
        }
      },
      productReadiness: checks.some((check) => check.status !== "passed")
        ? "not-demonstrated"
        : "only-declared-corpus-demonstrated",
      fixtures
    };
  } finally {
    await database.close();
  }
}
