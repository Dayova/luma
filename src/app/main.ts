import { LumaStartupCancelledError, startServer } from "./server.js";
import { startRuntimeHealthReporter } from "./runtime-health.js";

const startupCancellation = new AbortController();
let stopping: Promise<void> | undefined;
let stopHealth: (() => Promise<void>) | undefined;

function stopForSignal(): void {
  if (stopping) return;
  startupCancellation.abort();
  stopping = (async () => {
    const app = await startup.catch((error: unknown) => {
      if (error instanceof LumaStartupCancelledError) return undefined;
      throw error;
    });
    // Stop admission before waiting on health-file I/O. The app owns draining
    // already admitted operations and refuses a clean close if they stall.
    const stopApplication = app?.stop();
    await Promise.all([stopHealth?.(), stopApplication]);
  })().then(
    () => process.exit(0),
    () => {
      console.error(
        "Luma shutdown failed; preserve the store and inspect its ownership state before restarting."
      );
      process.exit(1);
    }
  );
}

// Register before initialization opens the owned store. Repeated signals must
// keep waiting for the same cleanup instead of restoring Node's default exit.
process.on("SIGINT", stopForSignal);
process.on("SIGTERM", stopForSignal);

const startup = startServer(process.env, {}, startupCancellation.signal);
try {
  const app = await startup;
  const healthPath = process.env["LUMA_RUNTIME_HEALTH_PATH"];
  if (healthPath && !startupCancellation.signal.aborted) {
    stopHealth = startRuntimeHealthReporter({
      path: healthPath,
      gatewayConnected: () => app.gatewayConnected()
    });
  }
} catch {
  if (stopping) {
    await stopping;
  } else {
    console.error(
      "Luma startup failed; inspect the protected configuration and store ownership before restarting."
    );
    process.exit(1);
  }
}
