import { runLocalServer } from "./lifecycle.js";
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
      port: 58099,
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
  return running;
}

runLocalServer(main);
