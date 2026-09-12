import { runLocalServer } from "./lifecycle.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createPgliteDatabase } from "../persistence/db.js";
import { createLiveSandboxSession } from "./live-session.js";
import { startSandboxServer } from "./server.js";
import { livePage } from "./live-page.js";

async function main() {
  if (process.argv.length > 2)
    throw new Error(
      "Usage: pnpm local:ai. Enter the API key in the local page or set LUMA_LOCAL_OPENAI_API_KEY."
    );
  process.umask(0o077);
  // One stable store across checkouts/restarts; a new process cannot reset the test allowance.
  const directory = join(homedir(), ".luma", "local-ai");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const database = await createPgliteDatabase(join(directory, "store"));
  try {
    const apiKey = process.env["LUMA_LOCAL_OPENAI_API_KEY"];
    delete process.env["LUMA_LOCAL_OPENAI_API_KEY"];
    const session = await createLiveSandboxSession({
      database,
      discordDirectory: directory,
      ...(apiKey ? { apiKey } : {})
    });
    const server = await startSandboxServer({
      session,
      port: 59383,
      page: livePage,
      maxBodyBytes: 65536
    });
    console.log(
      `\nLuma with real AI: ${server.origin}\nInitial local allowance: USD 1 per Berlin calendar month; Discord is opt-in; no Linear or Notion writes.\nText and accounting persist in ${directory}. Keys stay in memory.\nNothing is sent to OpenAI until you submit an AI request. Ctrl+C stops the server.\n`
    );
    return server;
  } catch (error) {
    await database.close();
    throw error;
  }
}

runLocalServer(main);
