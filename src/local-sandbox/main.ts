import { resolve } from "node:path";
import { loadCorpus } from "../../evals/corpus.js";
import { evaluateCorpus } from "../../evals/runner.js";
import { createSandboxSession } from "./session.js";
import { startSandboxServer } from "./server.js";

async function main() {
  if (process.argv.length > 2)
    throw new Error("Usage: pnpm local. No credentials or configuration are needed.");
  const { corpus, samples } = await loadCorpus(
    resolve("evals/fixtures/meeting-corpus.json"),
    resolve("evals/fixtures/meeting-samples.json")
  );
  const session = await createSandboxSession(corpus, samples);
  let server;
  try {
    server = await startSandboxServer({
      session,
      evaluate: () => evaluateCorpus(corpus, samples)
    });
  } catch (error) {
    await session.close();
    throw error;
  }
  const running = server;
  console.log(
    `\nLuma local sandbox: ${running.origin}\nFree offline mode. Real Luma core; synthetic AI and provider fixtures.\nNo .env or production store loaded. Ctrl+C stops and clears the sandbox.\n`
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void running.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Local sandbox failed");
  process.exitCode = 1;
});
