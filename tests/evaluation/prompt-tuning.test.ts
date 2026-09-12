import { readFileSync } from "node:fs";
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
