import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { candidates, ComparisonError, defaultLimits } from "./providers.js";
import { corpusSchema } from "./corpus.js";
import { renderReport, runComparison, type Report } from "./runner.js";

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean", default: false },
      providers: { type: "string" },
      "max-requests": { type: "string", default: "4" },
      repeats: { type: "string", default: "1" },
      fixtures: { type: "string" },
      "max-output-tokens": { type: "string", default: "4096" },
      "output-dir": { type: "string" },
      help: { type: "boolean", default: false }
    }
  });
  if (values.help) {
    console.log(
      "pnpm eval:providers [--live] [--providers=openai,anthropic,google,deepseek] [--max-requests=4] [--repeats=1] [--fixtures=case-id,...] [--max-output-tokens=4096] [--output-dir=PATH]\nDefault: offline preflight. Live sends only the committed synthetic corpus. No production sources or provider writes. Credentials come from environment / local .env."
    );
    return;
  }
  const ids = values.providers?.split(",") ?? candidates.map((c) => c.id);
  if (
    ids.some((id) => !candidates.some((c) => c.id === id)) ||
    new Set(ids).size !== ids.length
  )
    throw new ComparisonError("invalid-providers");
  const selected = candidates.filter((c) => ids.includes(c.id));
  const corpus = corpusSchema.parse(
    JSON.parse(
      await readFile("evals/fixtures/provider-comparison.json", "utf8")
    ) as unknown
  );
  if (values.fixtures !== undefined) {
    const fixtureIds = values.fixtures.split(",");
    if (
      new Set(fixtureIds).size !== fixtureIds.length ||
      fixtureIds.some((id) => !corpus.fixtures.some((f) => f.id === id))
    )
      throw new ComparisonError("invalid-fixtures");
    corpus.fixtures = corpus.fixtures.filter((f) => fixtureIds.includes(f.id));
  }
  const maxOutputTokens = Number(values["max-output-tokens"]);
  if (
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > 16_384
  )
    throw new ComparisonError("invalid-output-limit");
  const directory = resolve(
    values["output-dir"] ??
      `.luma/provider-comparison/${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Refuse to overwrite a previous run or mix its dispatch journal into this run.
  await writeFile(resolve(directory, "dispatch.jsonl"), "", { flag: "wx", mode: 0o600 });
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
    /* Running a packaged checkout without Git remains possible. */
  }
  const checkpoint = async (report: Report) => {
    for (const [name, text] of [
      ["report.json", JSON.stringify(report, null, 2) + "\n"],
      ["report.md", renderReport(report)]
    ]) {
      const path = resolve(directory, name!);
      await writeFile(path + ".tmp", text!, { mode: 0o600 });
      await rename(path + ".tmp", path);
    }
  };
  const report = await runComparison({
    corpus,
    env: process.env,
    live: values.live,
    maxRequests: Number(values["max-requests"]),
    limits: { ...defaultLimits, maxOutputTokens },
    repeats: Number(values.repeats),
    selected,
    gitRevision,
    checkpoint,
    beforeRequest: async (row) => {
      await appendFile(
        resolve(directory, "dispatch.jsonl"),
        JSON.stringify({
          at: new Date().toISOString(),
          provider: row.provider,
          model: row.model,
          fixture: row.fixture,
          repetition: row.repetition,
          requestHash: row.requestHash,
          state: "dispatched-usage-may-be-unknown"
        }) + "\n",
        { mode: 0o600 }
      );
      console.log(`Evaluating ${row.provider}: ${row.fixture} (${row.repetition})`);
    }
  });
  console.log(renderReport(report));
  console.log(`Artifacts: ${directory}`);
  if (values.live && report.rows.some((row) => row.status !== "completed"))
    process.exitCode = 2;
}

main().catch(() => {
  console.error(
    "Provider comparison could not finish. Check arguments, corpus, output directory, and the saved dispatch/report files. Provider error bodies and credentials are intentionally omitted."
  );
  process.exitCode = 1;
});
