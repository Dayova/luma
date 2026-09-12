import { z } from "zod";
import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel
} from "../../ai/reasoning-model.js";
import { meetingAnalysisSchema } from "../../ai/meeting-analysis-contract.js";
import { requestForFixture } from "../provider-comparison/corpus.js";
import {
  candidates,
  candidateKey,
  googleEndpoint,
  anthropicOutputMode,
  comparisonPayload,
  createComparisonReasoningModel,
  ComparisonError,
  defaultLimits,
  type Candidate,
  type Limits,
  type ResponseFacts
} from "../provider-comparison/providers.js";
import {
  benchmarkSchema,
  digest,
  gradeCase,
  type Benchmark,
  type Grade
} from "./grading.js";

export const modelSpecSchema = z
  .object({
    label: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
    provider: z.enum(["openai", "anthropic", "google", "deepseek"]),
    model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/),
    inputRate: z.number().finite().nonnegative(),
    outputRate: z.number().finite().nonnegative(),
    pricing: z.string().url().startsWith("https://"),
    promptInstructions: z
      .string()
      .min(1)
      .max(20000)
      .refine((value) => value.trim().length > 0, "Blank prompt")
      .optional(),
    pricingVerifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  })
  .strict();
export const modelSpecsSchema = z
  .array(modelSpecSchema)
  .min(1)
  .max(8)
  .refine(
    (ms) => new Set(ms.map((m) => m.label)).size === ms.length,
    "Duplicate model labels"
  );
export type ModelSpec = z.infer<typeof modelSpecSchema>;
export type QualityRow = {
  candidate: string;
  caseId: string;
  repetition: number;
  requestHash: string;
  status: "not-run" | "missing-credential" | "request-limit" | "completed" | "error";
  latencyMs: number | null;
  errorCode: string | null;
  response: ResponseFacts | null;
  output: MeetingAnalysisProposalBatch | null;
  grade: Grade | null;
};
export type QualityRun = {
  version: 2;
  benchmark: Benchmark;
  benchmarkHash: string;
  models: ModelSpec[];
  mode: "preflight" | "live" | "historical-regrade";
  sourceReports: string[];
  createdAt: string;
  gitRevision: string;
  planHash: string;
  settings: {
    seed: number;
    repeats: number;
    maxRequests: number;
    limits: Limits;
    googleEndpoint: ReturnType<typeof googleEndpoint>;
    anthropicOutputMode: ReturnType<typeof anthropicOutputMode>;
    providerProfile: "provider-comparison-v1";
  };
  rows: QualityRow[];
};
type Options = {
  benchmark: Benchmark;
  models: ModelSpec[];
  env: NodeJS.ProcessEnv;
  live: boolean;
  maxRequests: number;
  repeats: number;
  seed: number;
  gitRevision: string;
  limits?: Limits;
  beforeRequest?: (row: QualityRow) => Promise<void>;
  checkpoint?: (run: QualityRun) => Promise<void>;
  modelFactory?: (
    candidate: Candidate,
    key: string,
    onResponse: (facts: ResponseFacts) => void
  ) => ReasoningModel;
};

function candidateFor(m: ModelSpec): Candidate {
  return {
    ...candidates.find((c) => c.id === m.provider)!,
    model: m.model,
    inputRate: m.inputRate,
    outputRate: m.outputRate,
    pricing: m.pricing
  };
}

/** Same cases, grouped repetitions, and seeded candidate order. No credential values enter the plan. */
export async function runQualityEvaluation(options: Options): Promise<QualityRun> {
  const benchmark = benchmarkSchema.parse(options.benchmark);
  const models = modelSpecsSchema.parse(options.models);
  if (
    !Number.isSafeInteger(options.maxRequests) ||
    options.maxRequests < 1 ||
    options.maxRequests > 400 ||
    !Number.isSafeInteger(options.repeats) ||
    options.repeats < 1 ||
    options.repeats > 5 ||
    !Number.isSafeInteger(options.seed) ||
    benchmark.cases.length > 100
  )
    throw new ComparisonError("invalid-quality-run-options");
  const limits = options.limits ?? defaultLimits;
  if (
    ![limits.maxOutputTokens, limits.timeoutMs, limits.maxInputBytes].every(
      (v) => Number.isSafeInteger(v) && v > 0
    ) ||
    limits.maxOutputTokens > 16_384 ||
    limits.timeoutMs > 60_000 ||
    limits.maxInputBytes > 100_000
  )
    throw new ComparisonError("invalid-quality-limits");
  const settings: QualityRun["settings"] = {
    seed: options.seed,
    repeats: options.repeats,
    maxRequests: options.maxRequests,
    limits,
    googleEndpoint: googleEndpoint(options.env),
    anthropicOutputMode: anthropicOutputMode(options.env),
    providerProfile: "provider-comparison-v1"
  };
  const benchmarkHash = digest(benchmark);
  const run: QualityRun = {
    version: 2,
    benchmark,
    benchmarkHash,
    models,
    mode: options.live ? "live" : "preflight",
    sourceReports: [],
    createdAt: new Date().toISOString(),
    gitRevision: options.gitRevision,
    planHash: digest({ benchmarkHash, models, settings }),
    settings,
    rows: []
  };
  const orderedCases = [...benchmark.cases].sort((a, b) =>
    digest({ seed: options.seed, id: a.fixture.id }).localeCompare(
      digest({ seed: options.seed, id: b.fixture.id })
    )
  );
  for (let repetition = 1; repetition <= options.repeats; repetition++)
    for (const c of orderedCases) {
      const orderedModels = [...models].sort((a, b) =>
        digest({
          seed: options.seed,
          id: c.fixture.id,
          repetition,
          model: a.label
        }).localeCompare(
          digest({ seed: options.seed, id: c.fixture.id, repetition, model: b.label })
        )
      );
      for (const m of orderedModels)
        run.rows.push({
          candidate: m.label,
          caseId: c.fixture.id,
          repetition,
          requestHash: comparisonPayload(
            requestForFixture(c.fixture),
            m.promptInstructions
          ).hash,
          status: candidateKey(candidateFor(m), options.env)
            ? "not-run"
            : "missing-credential",
          latencyMs: null,
          errorCode: null,
          response: null,
          output: null,
          grade: null
        });
    }
  await options.checkpoint?.(run);
  let dispatched = 0;
  if (options.live)
    for (const row of run.rows) {
      if (row.status === "missing-credential") continue;
      if (dispatched >= options.maxRequests) {
        row.status = "request-limit";
        continue;
      }
      const c = benchmark.cases.find((c) => c.fixture.id === row.caseId)!;
      const modelSpec = models.find((m) => m.label === row.candidate)!;
      const candidate = candidateFor(modelSpec);
      const key = candidateKey(candidate, options.env)!;
      const onResponse = (facts: ResponseFacts) => {
        row.response = facts;
      };
      const model =
        options.modelFactory?.(candidate, key, onResponse) ??
        createComparisonReasoningModel({
          candidate,
          apiKey: key,
          ...(modelSpec.promptInstructions === undefined
            ? {}
            : { promptInstructions: modelSpec.promptInstructions }),
          limits,
          googleEndpoint: settings.googleEndpoint,
          anthropicOutputMode: settings.anthropicOutputMode,
          onResponse
        });
      await options.beforeRequest?.(row);
      dispatched++;
      const start = performance.now();
      try {
        const result = await model.generateStructured<MeetingAnalysisProposalBatch>(
          requestForFixture(c.fixture)
        );
        row.output = meetingAnalysisSchema.parse(result.value);
        row.grade = gradeCase(c, row.output);
        row.status = "completed";
      } catch (error) {
        row.status = "error";
        row.output = null;
        row.grade = null;
        row.errorCode =
          error instanceof ComparisonError ? error.code : "evaluation-error";
      }
      row.latencyMs = Math.round(performance.now() - start);
      await options.checkpoint?.(run);
    }
  await options.checkpoint?.(run);
  return run;
}
