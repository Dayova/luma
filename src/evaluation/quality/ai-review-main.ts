import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { parseQualityRun } from "./artifacts.js";
import { createAIReviewPacket, summarizeAIReviews } from "./ai-review.js";

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

async function main() {
  const { values } = parseArgs({
    options: {
      report: { type: "string" },
      context: { type: "string" },
      controls: { type: "string" },
      reviews: { type: "string", multiple: true },
      "output-dir": { type: "string" },
      help: { type: "boolean" }
    }
  });
  if (values.help) {
    console.log(
      "pnpm eval:ai-review --report=PATH [--context=PATH] [--controls=PATH] [--reviews=ROUND.json (repeatable)] [--output-dir=NEW_DIRECTORY]\nOffline only. Without reviews, prepares a blinded packet. Give reviewers packet.json only; controller.json contains hidden calibration labels. With reviews, validates complete coverage and produces an additional AI summary without changing original scores."
    );
    return;
  }
  if (!values.report) throw new Error("A quality report is required");
  const run = parseQualityRun(await readJson(values.report));
  const { packet, controller } = createAIReviewPacket(
    run,
    await readJson(values.context ?? "evals/context/luma-ai-review-2026-09-11.json"),
    await readJson(values.controls ?? "evals/fixtures/ai-review-controls.json")
  );
  const rounds = await Promise.all((values.reviews ?? []).map(readJson));
  const summary = rounds.length
    ? summarizeAIReviews(run, packet, controller, rounds)
    : undefined;
  // Validate first. A new directory prevents overwriting a frozen packet or completed review.
  const directory = resolve(values["output-dir"] ?? `.luma/ai-review/${randomUUID()}`);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const write = (name: string, value: unknown) =>
    writeFile(resolve(directory, name), JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600
    });
  await write("packet.json", packet);
  await write("controller.json", controller);
  if (summary) await write("summary.json", summary);
  console.log(
    JSON.stringify(
      {
        directory,
        packetHash: packet.packetHash,
        evaluatedAnswers: controller.evaluationAnswerIds.length,
        reviewRounds: rounds.length,
        agreement: summary?.agreement,
        calibration: summary?.reviewers.map((r) => ({
          reviewer: r.id,
          correct: r.calibrationCorrect,
          checks: r.calibrationChecks
        }))
      },
      null,
      2
    )
  );
}
main().catch(() => {
  console.error(
    "AI review could not finish. Check the report, context, controls, complete matching reviews, and a new output directory. No provider requests are made."
  );
  process.exitCode = 1;
});
