import { startServer } from "./server.js";

const app = await startServer();
let stopping: Promise<void> | undefined;

function stop(): Promise<void> {
  stopping ??= app.stop();
  return stopping;
}

function stopForSignal(): void {
  void stop().then(
    () => process.exit(0),
    () => {
      console.error(
        "Luma shutdown failed; preserve the store and inspect its ownership state before restarting."
      );
      process.exit(1);
    }
  );
}

process.once("SIGINT", stopForSignal);
process.once("SIGTERM", stopForSignal);
