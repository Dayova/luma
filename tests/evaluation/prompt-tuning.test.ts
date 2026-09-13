import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createAIReviewPacket } from "../../src/evaluation/quality/ai-review.js";
import { expect, it } from "vitest";
import { benchmarkSchema, digest } from "../../src/evaluation/quality/grading.js";
import {
  modelSpecsSchema,
  runQualityEvaluation
} from "../../src/evaluation/quality/runner.js";
import {
  parseQualityRun,
  regradeQuality
} from "../../src/evaluation/quality/artifacts.js";
import {
  candidates,
  comparisonPayload,
  createComparisonReasoningModel,
  defaultLimits
} from "../../src/evaluation/provider-comparison/providers.js";
import { promptTuningEnvironment } from "../../src/evaluation/quality/prompt-tuning-profile.js";
import { requestForFixture } from "../../src/evaluation/provider-comparison/corpus.js";
const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8")) as unknown;
const benchmark = benchmarkSchema.parse(
  json("evals/experiments/prompt-tuning-2026-09-12/development.json")
);
const model = modelSpecsSchema.parse(json("evals/models/provider-quality.json"))[0]!;

it("binds each prompt variant to its request and refuses relabeling saved outputs", async () => {
  const run = await runQualityEvaluation({
    benchmark,
    models: [
      { ...model, label: "baseline" },
      {
        ...model,
        label: "tuned",
        promptInstructions: "A separately frozen experimental instruction."
      }
    ],
    env: {},
    live: false,
    maxRequests: 8,
    repeats: 1,
    seed: 56,
    gitRevision: "test"
  });
  const rows = run.rows.filter((r) => r.caseId === benchmark.cases[0]!.fixture.id);
  expect(new Set(rows.map((r) => r.requestHash)).size).toBe(2);
  expect(parseQualityRun(run)).toEqual(run);
  const changed = structuredClone(run);
  changed.models[1]!.promptInstructions = "A different request.";
  changed.planHash = digest({
    benchmarkHash: changed.benchmarkHash,
    models: changed.models,
    settings: changed.settings
  });
  expect(() => parseQualityRun(changed)).toThrow(/Request hash/);
  const replay = await regradeQuality(
    { ...benchmark, revision: "new-grader" },
    run,
    "regrade"
  );
  expect(replay.rows.map((r) => r.requestHash)).toEqual(
    run.rows.map((r) => r.requestHash)
  );
});

it("makes frozen prompt variants available to programmable model adapters", async () => {
  const observedVariants = new Set<boolean>();
  const run = await runQualityEvaluation({
    benchmark: { ...benchmark, cases: benchmark.cases.slice(0, 1) },
    models: [
      { ...model, label: "baseline" },
      { ...model, label: "tuned", promptInstructions: "Frozen experiment instruction." }
    ],
    env: { OPENAI_API_KEY: "test-only" },
    live: true,
    maxRequests: 2,
    repeats: 1,
    seed: 56,
    gitRevision: "test",
    modelFactory: (_candidate, _key, _onResponse, promptInstructions) => ({
      generateStructured: () => {
        observedVariants.add(promptInstructions !== undefined);
        return Promise.reject(new Error("No real provider request"));
      }
    })
  });
  expect(observedVariants).toEqual(new Set([false, true]));
  expect(new Set(run.rows.map((row) => row.requestHash)).size).toBe(2);
});

it.each(candidates)(
  "sends the selected instruction and unchanged task/schema through $id",
  async (candidate) => {
    const request = requestForFixture(benchmark.cases[0]!.fixture),
      prompt = "Frozen experiment instruction.";
    const expected = comparisonPayload(request, prompt);
    let captured: unknown;
    const adapter = createComparisonReasoningModel({
      candidate,
      apiKey: "test-only",
      limits: defaultLimits,
      promptInstructions: prompt,
      onResponse: () => {},
      transport: (_url, init) => {
        if (typeof init.body !== "string") throw new Error("Expected JSON body");
        captured = JSON.parse(init.body) as unknown;
        return Promise.resolve(new Response(null, { status: 503 }));
      }
    });
    await expect(adapter.generateStructured(request)).rejects.toThrow("http-503");
    const body = captured as Record<string, unknown>;
    const actual =
      candidate.id === "openai"
        ? body["instructions"]
        : candidate.id === "anthropic"
          ? body["system"]
          : candidate.id === "google"
            ? (body["systemInstruction"] as { parts: { text: string }[] }).parts[0]!.text
            : (body["messages"] as { content: string }[])[0]!.content;
    expect(actual).toBe(expected.instructions);
    expect(expected.input).toBe(comparisonPayload(request).input);
    expect(expected.hash).not.toBe(comparisonPayload(request).hash);
  }
);

it("keeps validation scenarios disjoint and refuses blank experimental instructions", () => {
  const validation = benchmarkSchema.parse(
    json("evals/experiments/prompt-tuning-2026-09-12/validation.json")
  );
  expect(validation.cases).toHaveLength(8);
  expect(
    validation.cases.every((v) => !benchmark.cases.some((c) => c.groupId === v.groupId))
  ).toBe(true);
  expect(() =>
    modelSpecsSchema.parse([{ ...model, promptInstructions: "  " }])
  ).toThrow();
});

it("reproduces frozen selections and blinds prompt variants in semantic review", () => {
  const root = "evals/experiments/prompt-tuning-2026-09-12";
  const selected = modelSpecsSchema.parse(json(`${root}/validation-models.json`));
  const selection = z
    .object({
      selected: z.array(
        z.object({
          provider: z.string(),
          candidate: z.string(),
          promptSha256: z.string()
        })
      )
    })
    .parse(json(`${root}/selection.json`));
  const developmentRuns = ["shared", "revision"].map((stage) =>
    parseQualityRun(json(`evals/results/2026-09-12-prompt-tuning/${stage}/combined.json`))
  );
  for (const entry of selection.selected) {
    const source = developmentRuns
      .flatMap((r) => r.models)
      .find((m) => m.label === entry.candidate)!;
    const target = selected.find((m) => m.label === `${entry.provider}-selected`)!;
    expect(target.promptInstructions).toBe(source.promptInstructions);
    expect(createHash("sha256").update(target.promptInstructions!).digest("hex")).toBe(
      entry.promptSha256
    );
  }
  const { packet } = createAIReviewPacket(
    developmentRuns[0]!,
    json("evals/context/luma-ai-review-2026-09-11.json"),
    json(`${root}/review-controls.json`)
  );
  // Two providers returned the same empty answer to one case; review it once.
  expect(packet.entries.length).toBe(20);
  expect(JSON.stringify(packet)).not.toContain("promptInstructions");
  expect(JSON.stringify(packet)).not.toContain("shared-v1");
  expect(JSON.stringify(packet)).not.toContain("expectations");
});

it.each([
  {},
  {
    LUMA_EVAL_GOOGLE_BACKEND: "developer",
    LUMA_EVAL_ANTHROPIC_OUTPUT: "native-schema",
    VERTEX_PROJECT_ID: "other-project"
  }
])("keeps the frozen experiment provider controls in preflight", async (environment) => {
  const env = {
    ...environment,
    VERTEX_API_KEY: "test-only",
    ANTHROPIC_API_KEY: "test-only"
  };
  const original = { ...env };
  const run = await runQualityEvaluation({
    benchmark,
    models: modelSpecsSchema
      .parse(json("evals/models/provider-quality.json"))
      .filter((m) => ["google", "anthropic"].includes(m.provider)),
    env: promptTuningEnvironment(env),
    live: false,
    maxRequests: 8,
    repeats: 1,
    seed: 56,
    gitRevision: "test"
  });
  expect(run.settings.googleEndpoint).toEqual({ backend: "vertex" });
  expect(run.settings.anthropicOutputMode).toBe("prompt-json");
  expect(run.rows.every((row) => row.status === "not-run")).toBe(true);
  expect(env).toEqual(original);
});
