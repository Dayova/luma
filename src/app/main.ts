import { startServer } from "./server.js";

const app = await startServer();
let stopping = false;

async function stop(): Promise<void> {
  if (stopping) {
    return;
  }

  stopping = true;
  await app.stop();
}

process.once("SIGINT", () => {
  void stop().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void stop().finally(() => process.exit(0));
});
