import { startNotionMeetingNotesObservationServer } from "./notion-meeting-notes-observation-server.js";

const observationServer = await startNotionMeetingNotesObservationServer();
let stopping: Promise<void> | null = null;

const stop = (): Promise<void> => {
  stopping ??= observationServer.stop();
  return stopping;
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stop().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      }
    );
  });
}
