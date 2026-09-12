import { z } from "zod";
import { meetingAnalysisSchema } from "../../ai/meeting-analysis-contract.js";
import { requestForFixture } from "../provider-comparison/corpus.js";
import {
  comparisonPayload,
  comparisonPromptVersion,
  type GoogleEndpoint
} from "../provider-comparison/providers.js";
import {
  benchmarkSchema,
  digest,
  gradeCase,
  semanticReviewSchema,
  type Benchmark
} from "./grading.js";
import { modelSpecsSchema, runQualityEvaluation, type QualityRun } from "./runner.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const natural = z.number().int().nonnegative();
const facts = z
  .object({
    returnedModel: z.string().nullable(),
    responseId: z.string().nullable(),
    finishReason: z.string().nullable(),
    usage: z
      .object({
        inputTokens: natural,
        outputTokens: natural,
        reasoningTokens: natural.nullable()
      })
      .strict()
      .nullable(),
    estimatedUncachedCostUsd: z.number().finite().nonnegative().nullable()
  })
  .strict();
const limits = z
  .object({
    maxOutputTokens: z.number().int().min(1).max(16384),
    timeoutMs: z.number().int().min(1).max(60000),
    maxInputBytes: z.number().int().min(1).max(100000)
  })
  .strict();
const endpoint = z
  .union([
    z.object({ backend: z.literal("developer") }).strict(),
    z
      .object({
        backend: z.literal("vertex"),
        projectId: z
          .string()
          .regex(/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]+)$/)
          .optional()
      })
      .strict()
  ])
  .transform((value): GoogleEndpoint =>
    value.backend === "vertex"
      ? { backend: "vertex", ...(value.projectId ? { projectId: value.projectId } : {}) }
      : value
  );
const outputMode = z.enum(["native-schema", "prompt-json"]);
const settingsSchema = z
  .object({
    seed: z.number().int().safe(),
    repeats: z.number().int().min(1).max(5),
    maxRequests: z.number().int().min(1).max(400),
    limits,
    googleEndpoint: endpoint,
    anthropicOutputMode: outputMode,
    providerProfile: z.literal("provider-comparison-v1")
  })
  .strict();
const attempt = z.object({
  repetition: z.number().int().min(1).max(5),
  requestHash: hash,
  status: z.enum([
    "not-run",
    "missing-credential",
    "request-limit",
    "completed",
    "error"
  ]),
  latencyMs: natural.nullable(),
  errorCode: z
    .string()
    .regex(/^[a-z0-9-]{1,100}$/)
    .nullable(),
  response: facts.nullable(),
  output: meetingAnalysisSchema.nullable()
});
const savedRun = z
  .object({
    version: z.literal(2),
    benchmark: benchmarkSchema,
    benchmarkHash: hash,
    models: modelSpecsSchema,
    mode: z.enum(["preflight", "live", "historical-regrade"]),
    sourceReports: z.array(hash),
    createdAt: z.string().datetime(),
    gitRevision: z.string(),
    planHash: hash,
    settings: settingsSchema,
    rows: z.array(
      attempt
        .extend({ candidate: z.string(), caseId: z.string(), grade: z.unknown() })
        .strict()
    )
  })
  .strict();

/** Reports are data. Never trust a serialized grade; recompute it and validate its attached review. */
export function parseQualityRun(input: unknown): QualityRun {
  const run = savedRun.parse(input);
  if (
    run.benchmarkHash !== digest(run.benchmark) ||
    run.planHash !==
      digest({
        benchmarkHash: run.benchmarkHash,
        models: run.models,
        settings: run.settings
      })
  )
    throw new Error("Run content hash mismatch");
  if (
    run.rows.length !==
    run.models.length * run.benchmark.cases.length * run.settings.repeats
  )
    throw new Error("Incomplete run plan");
  if ((run.mode === "historical-regrade") !== run.sourceReports.length > 0)
    throw new Error("Invalid source provenance");
  const seen = new Set<string>();
  const rows = run.rows.map((row) => {
    const c = run.benchmark.cases.find((c) => c.fixture.id === row.caseId);
    const identity = JSON.stringify([row.candidate, row.caseId, row.repetition]);
    if (
      !c ||
      !run.models.some((m) => m.label === row.candidate) ||
      row.repetition > run.settings.repeats ||
      seen.has(identity)
    )
      throw new Error("Unknown or duplicate attempt");
    seen.add(identity);
    if (
      row.requestHash !==
      comparisonPayload(
        requestForFixture(c.fixture),
        run.models.find((m) => m.label === row.candidate)!.promptInstructions
      ).hash
    )
      throw new Error("Request hash mismatch");
    if (row.status === "completed") {
      if (!row.output || row.errorCode !== null || row.latencyMs === null)
        throw new Error("Invalid completed attempt");
      const savedReview = z
        .object({ review: semanticReviewSchema.nullable() })
        .passthrough()
        .parse(row.grade).review;
      return { ...row, grade: gradeCase(c, row.output, savedReview ?? undefined) };
    }
    if (
      row.output !== null ||
      row.grade !== null ||
      (row.status === "error"
        ? row.errorCode === null || row.latencyMs === null
        : row.errorCode !== null || row.latencyMs !== null || row.response !== null)
    )
      throw new Error("Invalid unfinished or failed attempt");
    return { ...row, grade: null };
  });
  if (
    run.mode === "preflight" &&
    rows.some((r) => r.status === "completed" || r.status === "error")
  )
    throw new Error("Preflight cannot contain live answers");
  if (
    run.mode === "live" &&
    rows.filter((r) => r.status === "completed" || r.status === "error").length >
      run.settings.maxRequests
  )
    throw new Error("Request cap exceeded");
  return { ...run, rows };
}

const legacySchema = z.object({
  version: z.literal(1),
  mode: z.literal("live"),
  promptVersion: z.literal(comparisonPromptVersion),
  corpusProvenance: z.literal("agent-authored-synthetic-not-human-labeled"),
  pricingVerifiedAt: z.string(),
  limits: limits.extend({
    maxRequests: natural,
    repeats: z.number().int().min(1).max(5)
  }),
  googleEndpoint: endpoint,
  anthropicOutputMode: outputMode,
  candidateConfig: z
    .array(
      z.object({
        id: z.enum(["openai", "anthropic", "google", "deepseek"]),
        model: z.string(),
        inputRate: z.number(),
        outputRate: z.number(),
        pricing: z.string()
      })
    )
    .min(1),
  rows: z.array(
    attempt.extend({ provider: z.string(), model: z.string(), fixture: z.string() })
  )
});

/** Offline reinterpretation of the same requests. New cases stay unrun; old scores/files stay untouched. */
export async function regradeHistorical(
  benchmark: Benchmark,
  inputs: unknown[],
  gitRevision: string
): Promise<QualityRun> {
  if (!inputs.length || inputs.length > 8)
    throw new Error("Expected one to eight source reports");
  benchmark = benchmarkSchema.parse(benchmark);
  if (benchmark.provenance !== "synthetic-development")
    throw new Error("Legacy synthetic answers cannot populate human meeting data");
  const reports = inputs.map((r) => legacySchema.parse(r));
  const first = reports[0]!;
  const profile = (r: typeof first) => ({
    limits: r.limits,
    googleEndpoint: r.googleEndpoint,
    anthropicOutputMode: r.anthropicOutputMode
  });
  if (reports.some((r) => digest(profile(r)) !== digest(profile(first))))
    throw new Error("Historical settings differ; regrade these runs separately");
  const label = (provider: string, model: string) =>
    `${provider}-${model.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
  const models = modelSpecsSchema.parse(
    reports.flatMap((r) =>
      r.candidateConfig.map((c) => ({
        label: label(c.id, c.model),
        provider: c.id,
        model: c.model,
        inputRate: c.inputRate,
        outputRate: c.outputRate,
        pricing: c.pricing,
        pricingVerifiedAt: r.pricingVerifiedAt
      }))
    )
  );
  const run = await runQualityEvaluation({
    benchmark,
    models,
    env: {
      LUMA_EVAL_GOOGLE_BACKEND: first.googleEndpoint.backend,
      ...(first.googleEndpoint.backend === "vertex" && first.googleEndpoint.projectId
        ? { VERTEX_PROJECT_ID: first.googleEndpoint.projectId }
        : {}),
      LUMA_EVAL_ANTHROPIC_OUTPUT: first.anthropicOutputMode
    },
    live: false,
    maxRequests: 400,
    repeats: first.limits.repeats,
    seed: 0,
    gitRevision,
    limits: {
      maxOutputTokens: first.limits.maxOutputTokens,
      timeoutMs: first.limits.timeoutMs,
      maxInputBytes: first.limits.maxInputBytes
    }
  });
  run.mode = "historical-regrade";
  run.sourceReports = inputs.map(digest);
  for (const row of run.rows) row.status = "not-run";
  const seen = new Set<string>();
  for (const report of reports)
    for (const old of report.rows) {
      if (
        !report.candidateConfig.some(
          (c) => c.id === old.provider && c.model === old.model
        )
      )
        throw new Error("Unknown historical model");
      const candidate = label(old.provider, old.model);
      const row = run.rows.find(
        (r) =>
          r.candidate === candidate &&
          r.caseId === old.fixture &&
          r.repetition === old.repetition
      );
      const id = JSON.stringify([candidate, old.fixture, old.repetition]);
      if (!row || row.requestHash !== old.requestHash || seen.has(id))
        throw new Error("Historical request mismatch or duplicate");
      seen.add(id);
      Object.assign(row, {
        status: old.status,
        latencyMs: old.latencyMs,
        errorCode: old.errorCode,
        response: old.response,
        output: old.output,
        grade:
          old.status === "completed" && old.output
            ? gradeCase(
                benchmark.cases.find((c) => c.fixture.id === old.fixture)!,
                old.output
              )
            : null
      });
    }
  return parseQualityRun(run);
}

/** Explicit new grading revision for saved v2 answers; prior reviews cannot carry over. */
export async function regradeQuality(
  benchmark: Benchmark,
  input: unknown,
  gitRevision: string
): Promise<QualityRun> {
  const source = parseQualityRun(input);
  benchmark = benchmarkSchema.parse(benchmark);
  if (benchmark.provenance !== source.benchmark.provenance)
    throw new Error("Cannot relabel source provenance");
  const endpoint = source.settings.googleEndpoint;
  const run = await runQualityEvaluation({
    benchmark,
    models: source.models,
    env: {
      LUMA_EVAL_GOOGLE_BACKEND: endpoint.backend,
      ...(endpoint.backend === "vertex" && endpoint.projectId
        ? { VERTEX_PROJECT_ID: endpoint.projectId }
        : {}),
      LUMA_EVAL_ANTHROPIC_OUTPUT: source.settings.anthropicOutputMode
    },
    live: false,
    maxRequests: source.settings.maxRequests,
    repeats: source.settings.repeats,
    seed: source.settings.seed,
    limits: source.settings.limits,
    gitRevision
  });
  run.mode = "historical-regrade";
  run.sourceReports = [digest(input)];
  for (const row of run.rows) {
    row.status = "not-run";
    const old = source.rows.find(
      (r) =>
        r.candidate === row.candidate &&
        r.caseId === row.caseId &&
        r.repetition === row.repetition
    );
    if (!old) continue;
    if (old.requestHash !== row.requestHash)
      throw new Error("Changed request cannot reuse a saved answer");
    Object.assign(row, {
      status: old.status,
      latencyMs: old.latencyMs,
      errorCode: old.errorCode,
      response: old.response,
      output: old.output,
      grade: old.output
        ? gradeCase(
            benchmark.cases.find((c) => c.fixture.id === row.caseId)!,
            old.output
          )
        : null
    });
  }
  return parseQualityRun(run);
}
