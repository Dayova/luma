// No production environment or application server import. Provider credentials
// are separated from the runtime and are read only by the selected operation.
import { runLinuxOperations } from "../operations/linux-operations.js";

try {
  if (process.argv.length !== 3)
    throw new Error("Usage: operations-main <check|backup|resume|monitor>");
  await runLinuxOperations(process.argv[2] ?? "");
} catch {
  console.error(
    "Luma operations failed. Check the private operations configuration, service ownership, and latest verified backup receipt. No unverified success was recorded."
  );
  process.exitCode = 1;
}
