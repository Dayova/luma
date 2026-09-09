import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
  ProductionPreflightError,
  validateProductionEnvironment,
  verifyProductionDiscordApplication
} from "./production-runtime.js";

const releaseDirectory = fileURLToPath(new URL("../../../", import.meta.url));

try {
  if (Number(process.versions.node.split(".")[0]) !== 24) {
    throw new ProductionPreflightError("This production release requires Node.js 24.");
  }
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === "--check-env-file" && arguments_.length === 2) {
    const path = arguments_[1] ?? "";
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== 0o600 ||
      (process.platform === "linux" && metadata.uid !== 0)
    ) {
      throw new ProductionPreflightError(
        "The production environment must be a regular mode-0600 file, owned by root on Linux."
      );
    }
    await validateProductionEnvironment(
      parseEnv(await readFile(path, "utf8")),
      releaseDirectory
    );
    console.log(
      "Production configuration passed offline checks; no runtime was started."
    );
  } else if (arguments_.length === 0) {
    if (process.platform !== "linux" || process.getuid?.() === 0) {
      throw new ProductionPreflightError(
        "Run this service on Linux as the dedicated non-root user."
      );
    }
    await validateProductionEnvironment(process.env, releaseDirectory);
    await verifyProductionDiscordApplication(process.env);
    // main installs shutdown handlers and starts the same tested Discord composition.
    await import("./main.js");
  } else {
    throw new ProductionPreflightError(
      "Usage: production-main.js [--check-env-file PATH]"
    );
  }
} catch (error) {
  console.error(
    error instanceof ProductionPreflightError
      ? error.message
      : "Production startup or preflight failed. Check the protected configuration and deployment runbook."
  );
  process.exitCode = 1;
}
