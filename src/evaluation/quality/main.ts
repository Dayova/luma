import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { benchmarkSchema } from "./grading.js";
import { modelSpecsSchema, runQualityEvaluation, type QualityRun } from "./runner.js";
import { parseQualityRun, regradeHistorical, regradeQuality } from "./artifacts.js";
import {
  applyReviews,
  compareCandidates,
  prepareReviewPacket,
  renderQualityReport,
  summarizeRun
} from "./report.js";
import { defaultLimits } from "../provider-comparison/providers.js";

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean", default: false },
      "allow-reviewed-data": { type: "boolean", default: false },
      corpus: { type: "string" },
      models: { type: "string" },
      cohort: { type: "string" },
      "max-requests": { type: "string" },
      repeats: { type: "string" },
      seed: { type: "string" },
      "max-output-tokens": { type: "string" },
      "timeout-ms": { type: "string" },
      "legacy-reports": { type: "string" },
      report: { type: "string" },
      "regrade-report": { type: "string" },
      reviews: { type: "string" },
      "output-dir": { type: "string" },
      help: { type: "boolean", default: false }
    }
  });
  if (values.help) {
    console.log(`pnpm eval:quality [--live] [--models=PATH] [--corpus=PATH] [--cohort=regression|representative|challenge] [--max-requests=4] [--repeats=1] [--seed=53] [--max-output-tokens=4096] [--timeout-ms=45000] [--output-dir=PATH]
Offline regrade: --legacy-reports=PATH,PATH [--corpus=PATH]
Offline review: --report=PATH [--reviews=PATH]
New grading revision: --regrade-report=PATH --corpus=PATH
Default: offline preflight. Live uses existing provider credentials and owned endpoints. Human meeting corpora require --allow-reviewed-data. No source collection or production changes. Every run gets a fresh artifact directory.`);
    return;
  }
  const historical = values["legacy-reports"] !== undefined;
  const loading = values.report !== undefined;
  const revising = values["regrade-report"] !== undefined;
  const runFlags = [
    "models",
    "max-requests",
    "repeats",
    "seed",
    "max-output-tokens",
    "timeout-ms"
  ] as const;
  if (
    Number(historical) + Number(loading) + Number(revising) > 1 ||
    ((historical || loading || revising) &&
      (values.live ||
        values["allow-reviewed-data"] ||
        runFlags.some((k) => values[k] !== undefined))) ||
    (loading && (values.corpus !== undefined || values.cohort !== undefined)) ||
    (values.reviews !== undefined && !loading)
  )
    throw new Error("Incompatible run modes");
  let gitRevision = "unknown";
  try {
    gitRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (
      execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
        encoding: "utf8"
      }).trim()
    )
      gitRevision += "-dirty";
  } catch {
    /* A packaged checkout may not have Git metadata. */
  }
  const benchmark = loading
    ? undefined
    : benchmarkSchema.parse(
        await readJson(values.corpus ?? "evals/fixtures/provider-quality-v2.json")
      );
  if (values.cohort !== undefined) {
    if (!["regression", "representative", "challenge"].includes(values.cohort))
      throw new Error("Invalid cohort");
    benchmark!.cases = benchmark!.cases.filter((c) => c.cohort === values.cohort);
    benchmarkSchema.parse(benchmark);
  }
  if (
    values.live &&
    benchmark!.provenance === "human-reviewed-meetings" &&
    !values["allow-reviewed-data"]
  )
    throw new Error("Reviewed data requires explicit live opt-in");
  const options =
    loading || historical || revising
      ? undefined
      : {
          benchmark: benchmark!,
          models: modelSpecsSchema.parse(
            await readJson(values.models ?? "evals/models/provider-quality.json")
          ),
          env: process.env,
          live: false,
          maxRequests: Number(values["max-requests"] ?? 4),
          repeats: Number(values.repeats ?? 1),
          seed: Number(values.seed ?? 53),
          gitRevision,
          limits: {
            ...defaultLimits,
            maxOutputTokens: Number(values["max-output-tokens"] ?? 4096),
            timeoutMs: Number(values["timeout-ms"] ?? 45000)
          }
        };
  // Complete offline validation before creating files or dispatching a paid request.
  let run = loading
    ? parseQualityRun(await readJson(values.report!))
    : revising
      ? await regradeQuality(
          benchmark!,
          await readJson(values["regrade-report"]!),
          gitRevision
        )
      : historical
        ? await regradeHistorical(
            benchmark!,
            await Promise.all(values["legacy-reports"]!.split(",").map(readJson)),
            gitRevision
          )
        : await runQualityEvaluation(options!);
  if (values.reviews) run = applyReviews(run, await readJson(values.reviews));
  const directory = resolve(
    values["output-dir"] ??
      `.luma/quality/${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(resolve(directory, "dispatch.jsonl"), "", { flag: "wx", mode: 0o600 });
  const write = async (name: string, value: unknown) => {
    const path = resolve(directory, name);
    await writeFile(
      path + ".tmp",
      typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
      { mode: 0o600 }
    );
    await rename(path + ".tmp", path);
  };
  const checkpoint = async (current: QualityRun) => {
    await write("report.json", current);
    await write("report.md", renderQualityReport(current));
    await write("summary.json", {
      version: 2,
      benchmarkHash: current.benchmarkHash,
      planHash: current.planHash,
      mode: current.mode,
      sourceReports: current.sourceReports,
      candidates: summarizeRun(current),
      comparisons: current.models
        .slice(1)
        .map((m) => compareCandidates(current, current.models[0]!.label, m.label))
    });
  };
  if (values.live)
    run = await runQualityEvaluation({
      ...options!,
      live: true,
      checkpoint,
      beforeRequest: async (row) => {
        await appendFile(
          resolve(directory, "dispatch.jsonl"),
          JSON.stringify({
            at: new Date().toISOString(),
            candidate: row.candidate,
            caseId: row.caseId,
            repetition: row.repetition,
            requestHash: row.requestHash,
            state: "dispatched-usage-may-be-unknown"
          }) + "\n",
          { mode: 0o600 }
        );
        console.log(`Evaluating ${row.candidate}: ${row.caseId} (${row.repetition})`);
      }
    });
  await checkpoint(run);
  const packet = prepareReviewPacket(run);
  await write("review-packet.json", packet);
  await write("review-template.json", {
    benchmarkHash: run.benchmarkHash,
    reviews: packet.entries.map((e) => ({
      answerId: e.answerId,
      reviewer: { id: "", kind: "human" },
      reviewedAt: "",
      judgments: e.rubric.map((r) => ({
        rubricId: r.id,
        verdict: "uncertain",
        explanation: "",
        evidenceIds: []
      }))
    }))
  });
  console.log(renderQualityReport(run));
  console.log(`Artifacts: ${directory}`);
  if (
    values.live &&
    run.rows.some(
      (r) => r.status !== "completed" || r.grade?.automated.some((a) => !a.passed)
    )
  )
    process.exitCode = 2;
}
main().catch(() => {
  console.error(
    "Quality evaluation could not finish. Check arguments, corpus/model schemas, matched report hashes, reviews, and output directory. Existing artifacts and the dispatch journal may contain partial progress. Provider bodies and credentials are omitted."
  );
  process.exitCode = 1;
});
