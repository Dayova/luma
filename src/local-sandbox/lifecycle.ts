/** Install shutdown handling before initialization can acquire the durable store. */
export function runLocalServer(start: () => Promise<{ close(): Promise<void> }>) {
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= startup
      .then((server) => server.close())
      .then(
        () => {
          process.exitCode = 0;
        },
        () => {
          process.exitCode = 1;
        }
      );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const startup = start();
  void startup.catch(() => {
    console.error(
      "Local startup failed. Check the protected service log, occupied ports, and store ownership. Never delete the store or lease to reset it."
    );
    process.exitCode = 1;
  });
}
