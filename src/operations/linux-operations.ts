import { execFile } from "node:child_process";
import { pruneOldColdCopies } from "./cold-copy-retention.js";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  statfs,
  writeFile
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { verifyFullStoreBackup } from "../persistence/full-store-backup.js";
import { archiveAndVerifyBackup } from "./restic-archive.js";
import { assessOperationalHealth, deliverHealthStatus } from "./health-monitor.js";
import { runScheduledBackup, type BackupReceipt } from "./maintenance.js";
import { parseProductionEnvironmentFile } from "../app/production-runtime.js";
import { pathExists } from "../persistence/store-ownership.js";
import {
  operationsWebhookUrlSchema,
  sendOperationsDiscordAlert
} from "./discord-alert.js";

const execute = promisify(execFile);
const stateDirectory = "/var/lib/luma-operations";
const backupDirectory = "/var/backups/luma-operations";
const runtimeDirectory = "/var/lib/luma";
const configurationPath = "/etc/luma/operations.json";
const resumePath = join(stateDirectory, "resume.json");
const receiptPath = join(stateDirectory, "verified-backup.json");
const healthStatePath = join(stateDirectory, "alert-state.json");
const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  });

export const operationsConfigSchema = z
  .object({
    // One deliberately narrow backend; local repositories cannot prove off-host backup.
    resticRepository: z.string().refine((value) => {
      if (!value.startsWith("s3:https://")) return false;
      try {
        const url = new URL(value.slice(3));
        return (
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname.length > 1 &&
          !["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname) &&
          !url.hostname.endsWith(".localhost")
        );
      } catch {
        return false;
      }
    }),
    resticPasswordFile: z.string().refine(isAbsolute),
    s3CredentialsFile: z.string().refine(isAbsolute),
    alertWebhookUrl: operationsWebhookUrlSchema,
    healthyHeartbeatUrl: httpsUrl
  })
  .strict();
type OperationsConfig = z.infer<typeof operationsConfigSchema>;

async function readPrivateFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !isAbsolute(path) ||
      !info.isFile() ||
      info.uid !== 0 ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > 65_536
    ) {
      throw new Error("Operations inputs must be private root-owned regular files");
    }
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65_536)
      return null;
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function command(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  } = {}
): Promise<string> {
  try {
    const result = await execute(file, args, {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ...options.env },
      timeout: options.timeout ?? 150_000,
      maxBuffer: 2 * 1024 * 1024,
      ...(options.cwd ? { cwd: options.cwd } : {})
    });
    return result.stdout;
  } catch {
    // Neither subprocess stderr nor argv belongs in journal: credentials and
    // private paths can appear in provider/CLI diagnostics.
    throw new Error("An operations subprocess failed; no verified success was recorded");
  }
}

async function serviceStatus(unit = "luma.service") {
  const output = await command("/usr/bin/systemctl", [
    "show",
    unit,
    "--property=ActiveState,MainPID,Result",
    "--no-pager"
  ]);
  const fields: Record<string, string> = {};
  for (const line of output.trim().split("\n")) {
    const [key, value] = line.split("=", 2);
    if (key && value !== undefined) fields[key] = value;
  }
  return {
    active: fields["ActiveState"] === "active",
    running: ["active", "activating"].includes(fields["ActiveState"] ?? ""),
    failed: Boolean(fields["Result"]) && fields["Result"] !== "success",
    mainPid: Number(fields["MainPID"] ?? 0)
  };
}

async function resticEnvironment(config: OperationsConfig): Promise<NodeJS.ProcessEnv> {
  const credentials = z
    .object({
      AWS_ACCESS_KEY_ID: z.string().min(1),
      AWS_SECRET_ACCESS_KEY: z.string().min(1),
      AWS_SESSION_TOKEN: z.string().min(1).optional(),
      AWS_DEFAULT_REGION: z.string().min(1).optional()
    })
    .strict()
    .parse(JSON.parse(await readPrivateFile(config.s3CredentialsFile)));
  if (!(await readPrivateFile(config.resticPasswordFile)).trim())
    throw new Error("Restic password is empty");
  return {
    ...credentials,
    RESTIC_REPOSITORY: config.resticRepository,
    RESTIC_PASSWORD_FILE: config.resticPasswordFile
  };
}

async function resumeService(): Promise<void> {
  if (!(await pathExists(resumePath))) return;
  const record: unknown = JSON.parse(await readPrivateFile(resumePath));
  z.object({ format: z.literal("luma-resume-v1"), createdAt: z.string().datetime() })
    .strict()
    .parse(record);
  await command("/usr/bin/systemctl", ["start", "luma.service"]);
  if (!(await serviceStatus()).active) throw new Error("The Luma service did not resume");
  await rm(resumePath);
}

async function backup(config: OperationsConfig): Promise<BackupReceipt> {
  // Validate every protected input and release before stopping the runtime.
  const env = await resticEnvironment(config);
  const release = await realpath("/opt/luma/current");
  const revision = (await readFile(join(release, "REVISION"), "utf8")).trim();
  z.string()
    .regex(/^[a-f0-9]{40}$/u)
    .parse(revision);
  if (release !== `/opt/luma/releases/${revision}`)
    throw new Error("The selected release is not immutable");
  // Root-owned maintenance directories are validated before this entrypoint.
  // Prune before downtime, retaining the newest failed attempt for inspection.
  await pruneOldColdCopies(backupDirectory);
  return runScheduledBackup({
    now: () => new Date(),
    serviceActive: async () => (await serviceStatus()).active,
    rememberResume: async () => {
      await writeFile(
        resumePath,
        JSON.stringify({ format: "luma-resume-v1", createdAt: new Date().toISOString() }),
        { flag: "wx", mode: 0o600 }
      );
    },
    stopService: async () => {
      await command("/usr/bin/systemctl", ["stop", "luma.service"]);
      if ((await serviceStatus()).active)
        throw new Error("The Luma service is still active");
    },
    resumeService,
    coldBackup: async () => {
      const directory = join(backupDirectory, `cold-${randomUUID()}`);
      // The same kernel lock as the service prevents a concurrent service start.
      // The maintenance entrypoint independently requires the clean-close receipt
      // and cooperative store lease. No production environment is loaded.
      await command(
        "/usr/bin/flock",
        [
          "--nonblock",
          "--no-fork",
          join(runtimeDirectory, "runtime.lock"),
          "/usr/bin/node",
          join(release, "dist/src/app/store-maintenance.js"),
          "backup",
          join(runtimeDirectory, "pglite"),
          directory,
          revision
        ],
        { timeout: 10 * 60_000 }
      );
      const manifest = await verifyFullStoreBackup(directory);
      return { ...manifest, directory };
    },
    uploadAndVerify: async (directory, backupId) => {
      const snapshotId = await archiveAndVerifyBackup({
        directory,
        backupId,
        scratchParent: backupDirectory,
        restic: (args, options = {}) =>
          command("/usr/bin/restic", args, { ...options, env })
      });
      await rm(directory, { recursive: true });
      return snapshotId;
    },
    recordVerified: (receipt) => atomicJson(receiptPath, receipt)
  });
}

async function boundedRequest(url: string, init: RequestInit): Promise<void> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
    redirect: "error"
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error("Operational notification was not accepted");
}

async function monitor(
  config: OperationsConfig,
  runtimeEnv: NodeJS.ProcessEnv
): Promise<void> {
  const filesystems = await Promise.all(
    [runtimeDirectory, backupDirectory].map((directory) => statfs(directory))
  );
  const maintenance = z
    .object({ format: z.literal("luma-resume-v1"), createdAt: z.string().datetime() })
    .strict()
    .safeParse(await readOptionalJson(resumePath));
  const backupService = await serviceStatus("luma-backup.service");
  const maintenanceRunning = maintenance.success && backupService.running;
  const problems = assessOperationalHealth({
    now: new Date(),
    service: await serviceStatus(),
    runtimeReceipt: await readOptionalJson(join(runtimeDirectory, "runtime-health.json")),
    backupReceipt: await readOptionalJson(receiptPath),
    backupFailed: backupService.failed,
    freeBytes: Math.min(
      ...filesystems.map((filesystem) => filesystem.bavail * filesystem.bsize)
    ),
    ...(maintenance.success && maintenanceRunning
      ? { maintenanceStartedAt: maintenance.data.createdAt }
      : {})
  });
  await deliverHealthStatus({
    problems,
    now: new Date(),
    previous: await readOptionalJson(healthStatePath),
    record: (state) => atomicJson(healthStatePath, state),
    send: (message) =>
      sendOperationsDiscordAlert({
        webhookUrl: config.alertWebhookUrl,
        runtimeEnv,
        message
      }),
    heartbeat: () => boundedRequest(config.healthyHeartbeatUrl, { method: "GET" })
  });
  if (problems.length) throw new Error("Luma operational health requires attention");
}

export async function runLinuxOperations(commandName: string): Promise<void> {
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new Error("Operations require Linux and the protected root service");
  if (!["backup", "resume", "monitor", "check"].includes(commandName))
    throw new Error("Unknown operations command");
  for (const directory of [stateDirectory, backupDirectory]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== 0 ||
      (info.mode & 0o777) !== 0o700
    )
      throw new Error("Operations directories must be private and root owned");
  }
  // Stop cleanup must work even if backup credentials became invalid mid-run.
  if (commandName === "resume") {
    await resumeService();
    return;
  }
  const config = operationsConfigSchema.parse(
    JSON.parse(await readPrivateFile(configurationPath))
  );
  const runtimeEnv = parseProductionEnvironmentFile(
    await readPrivateFile("/etc/luma/production.env")
  );
  if (
    runtimeEnv["LUMA_PGLITE_DATA_DIR"] !== join(runtimeDirectory, "pglite") ||
    runtimeEnv["LUMA_RUNTIME_HEALTH_PATH"] !==
      join(runtimeDirectory, "runtime-health.json")
  ) {
    throw new Error(
      "This operations profile requires the documented runtime data and health paths"
    );
  }
  if (commandName === "check") {
    await resticEnvironment(config);
    return;
  }
  if (commandName === "backup") await backup(config);
  else await monitor(config, runtimeEnv);
}
