import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { loadCorpus } from "./corpus.js";
import { evaluateCorpus } from "./runner.js";
import { reportExitCode } from "./scorer.js";

async function main() {
  const args = process.argv.slice(2);
  const requireComplete = args.includes("--require-complete");
  const outputIndex = args.indexOf("--output");
  const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  const remaining = args.filter(
    (_, index) => outputIndex < 0 || (index !== outputIndex && index !== outputIndex + 1)
  );
  if (
    (outputIndex >= 0 && (!output || output.startsWith("--"))) ||
    remaining.some((arg) => arg !== "--require-complete")
  ) {
    throw new Error(
      "Usage: pnpm eval:meeting [--require-complete] [--output report.json]. This command never calls a paid provider."
    );
  }
  const loaded = await loadCorpus(
    resolve("evals/fixtures/meeting-corpus.json"),
    resolve("evals/fixtures/meeting-samples.json")
  );
  const report = await evaluateCorpus(loaded.corpus, loaded.samples);
  const serialized = `${JSON.stringify({ ...report, fileHashes: { corpusSha256: loaded.corpusSha256, samplesSha256: loaded.samplesSha256 } }, null, 2)}\n`;
  if (output)
    await writeFile(resolve(output), serialized, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
  else process.stdout.write(serialized);
  process.exitCode = reportExitCode(
    report.fixtures.flatMap((fixture) => fixture.checks),
    requireComplete
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Evaluation failed"}\n`
  );
  process.exitCode = 1;
});
