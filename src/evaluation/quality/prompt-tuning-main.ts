// Run from the repository root after pnpm build. Credentials stay in process.env.
// Each stage has a new output directory and an append-only dispatch journal.
import { z } from "zod";
import type { ModelSpec } from "./runner.js";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { parseQualityRun } from "./artifacts.js";
import { runQualityEvaluation, modelSpecsSchema } from "./runner.js";
import { benchmarkSchema, digest } from "./grading.js";
import { renderQualityReport, summarizeRun } from "./report.js";

const root = "evals/experiments/prompt-tuning-2026-09-12";
const resultRoot = "evals/results/2026-09-12-prompt-tuning";
const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;
const writeJson = async (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n");
const stage = z.enum(["shared", "revision", "validation"]).parse(process.argv[2]);
const live = process.argv[3] === "--live";
if (
  !["shared", "revision", "validation"].includes(stage) ||
  process.argv.length > 4 ||
  (process.argv[3] && !live)
) {
  throw new Error(
    "Usage: node --env-file=.env dist/src/evaluation/quality/prompt-tuning-main.js shared|revision|validation [--live]"
  );
}
const manifest =
  stage === "shared"
    ? "shared-models.json"
    : stage === "revision"
      ? "revision-models.json"
      : "validation-models.json";
const corpus = stage === "validation" ? "validation.json" : "development.json";
const frozen = [`${root}/protocol.json`, `${root}/${corpus}`, `${root}/${manifest}`];
if (stage === "validation") frozen.push(`${root}/selection.json`);
for (const path of frozen) {
  execFileSync("git", ["ls-files", "--error-unmatch", path], { stdio: "pipe" });
  execFileSync("git", ["diff", "--exit-code", "HEAD", "--", path], { stdio: "pipe" });
}
const protocol = z
  .object({
    development: z.object({ repetitions: z.number().int().min(1).max(5) }),
    validation: z.object({ repetitions: z.number().int().min(1).max(5) }),
    limits: z.object({
      maxOutputTokens: z.number(),
      timeoutMs: z.number(),
      maxInputBytes: z.number()
    })
  })
  .parse(await readJson(`${root}/protocol.json`));
const benchmark = benchmarkSchema.parse(await readJson(`${root}/${corpus}`));
const models = modelSpecsSchema.parse(await readJson(`${root}/${manifest}`));
const providers = ["openai", "anthropic", "google", "deepseek"];
const repeats =
  stage === "validation"
    ? protocol.validation.repetitions
    : protocol.development.repetitions;
const expectedModels = stage === "validation" ? 2 : 1;
if (
  models.length !== expectedModels * 4 ||
  providers.some((p) => models.filter((m) => m.provider === p).length !== expectedModels)
)
  throw new Error("Incomplete four-provider manifest");
const gitRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8"
}).trim();
const limits = protocol.limits;
const options = (laneModels: ModelSpec[]) => ({
  benchmark,
  models: laneModels,
  env: process.env,
  live: false,
  maxRequests: benchmark.cases.length * repeats * laneModels.length,
  repeats,
  seed: 56,
  gitRevision,
  limits
});
const preflight = await Promise.all(
  providers.map((p) =>
    runQualityEvaluation(options(models.filter((m) => m.provider === p)))
  )
);
if (preflight.some((r) => r.rows.some((row) => row.status === "missing-credential")))
  throw new Error("A provider credential is missing; no calls dispatched");
console.log(
  JSON.stringify({
    stage,
    live,
    planned: preflight.reduce((n, r) => n + r.rows.length, 0),
    limits,
    planHashes: preflight.map((r) => r.planHash)
  })
);
if (live) {
  await mkdir(resultRoot, { recursive: true });
  const out = `${resultRoot}/${stage}`;
  await mkdir(out); // Refuse accidental paid reruns, including an interrupted stage.
  const settled = await Promise.allSettled(
    providers.map(async (provider) => {
      const run = await runQualityEvaluation({
        ...options(models.filter((m) => m.provider === provider)),
        live: true,
        beforeRequest: (row) =>
          appendFile(
            `${out}/${provider}-dispatch.jsonl`,
            JSON.stringify({
              at: new Date().toISOString(),
              candidate: row.candidate,
              caseId: row.caseId,
              repetition: row.repetition,
              requestHash: row.requestHash
            }) + "\n"
          ),
        checkpoint: (run) => writeJson(`${out}/${provider}.json`, run)
      });
      await writeFile(`${out}/${provider}.md`, renderQualityReport(run));
      console.log(JSON.stringify({ stage, provider, summary: summarizeRun(run) }));
      return parseQualityRun(run);
    })
  );
  if (settled.some((r) => r.status === "rejected"))
    throw new Error(
      "One or more lanes could not finish; inspect saved checkpoints without replaying calls"
    );
  const runs = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  // Lanes are constructed above from identical inputs/settings, differing only in models/cap.
  const settings = {
    ...runs[0]!.settings,
    maxRequests: runs.reduce((n, r) => n + r.settings.maxRequests, 0)
  };
  const combined = parseQualityRun({
    ...runs[0]!,
    models,
    settings,
    mode: "historical-regrade",
    sourceReports: runs.map(digest),
    planHash: digest({ benchmarkHash: runs[0]!.benchmarkHash, models, settings }),
    rows: runs.flatMap((r) => r.rows)
  });
  await writeJson(`${out}/combined.json`, combined);
  await writeJson(`${out}/summary.json`, summarizeRun(combined));
  await writeFile(`${out}/combined.md`, renderQualityReport(combined));
}
