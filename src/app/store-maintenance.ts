// Deliberately independent of app/server and process.env: no live provider can
// connect, poll, spend money, or execute a Follow-up during a restore rehearsal.
import {
  createFullStoreBackup,
  restoreFullStoreBackup,
  verifyFullStoreBackup,
  verifyIsolatedRestoredStore
} from "../persistence/full-store-backup.js";

const [command, first, second, revision, ...extra] = process.argv.slice(2);
try {
  if (extra.length > 0) throw new Error("Unexpected maintenance arguments");
  if (command === "backup" && first && second && revision) {
    const manifest = await createFullStoreBackup({
      dataDir: first,
      backupDir: second,
      applicationRevision: revision
    });
    process.stdout.write(
      JSON.stringify({
        status: "backup-verified",
        backupId: manifest.backupId,
        files: manifest.files.length,
        bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0)
      }) + "\n"
    );
  } else if (command === "verify-backup" && first && !second) {
    const manifest = await verifyFullStoreBackup(first);
    process.stdout.write(
      JSON.stringify({ status: "backup-verified", backupId: manifest.backupId }) + "\n"
    );
  } else if (command === "restore" && first && second && !revision) {
    const manifest = await restoreFullStoreBackup({
      backupDir: first,
      restoreDir: second
    });
    process.stdout.write(
      JSON.stringify({ status: "restored-in-quarantine", backupId: manifest.backupId }) +
        "\n"
    );
  } else if (command === "verify-restore" && first && !second) {
    const result = await verifyIsolatedRestoredStore(first);
    process.stdout.write(
      JSON.stringify({ status: "isolated-restore-readable", ...result }) + "\n"
    );
  } else {
    throw new Error(
      "Usage: store-maintenance backup <store> <fresh-backup> <40-char-revision> | verify-backup <backup> | restore <backup> <fresh-restore> | verify-restore <restore>"
    );
  }
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : "Store maintenance failed") + "\n"
  );
  process.exitCode = 1;
}
