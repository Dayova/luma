import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const CLEAN_CLOSE_FILE = ".luma-clean-close.json";
export const RESTORE_QUARANTINE_FILE = ".luma-restore-quarantine.json";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

/** Resolve aliases before selecting the one adjacent lease; reject a symlink store. */
export async function canonicalStorePath(path: string): Promise<string> {
  if (!path || path.includes("://"))
    throw new Error("A local filesystem store is required");
  const absolute = resolve(path);
  if (dirname(absolute) === absolute)
    throw new Error("Filesystem root cannot be a store");
  async function resolveParent(path: string): Promise<string> {
    if (await pathExists(path)) return realpath(path);
    return join(await resolveParent(dirname(path)), basename(path));
  }
  const parent = await resolveParent(dirname(absolute));
  const canonical = join(parent, basename(absolute));
  if (await pathExists(canonical)) {
    const info = await lstat(canonical);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Store must be a real directory, not a symlink");
    }
  }
  return canonical;
}

/**
 * Atomic cooperative lease on a local, single-host filesystem. Never expires:
 * process/PID scans are not evidence that a crashed owner stopped using a volume.
 * All runtime and maintenance entrypoints must use this protocol.
 */
export async function acquireStoreOwnership(dataDir: string): Promise<{
  dataDir: string;
  release(): Promise<void>;
}> {
  const canonical = await canonicalStorePath(dataDir);
  await mkdir(dirname(canonical), { recursive: true, mode: 0o700 });
  const leaseDir = `${canonical}.luma-owner`;
  try {
    await mkdir(leaseDir, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(
        "Store is owned or was not cleanly closed; automatic lease recovery is forbidden"
      );
    }
    throw error;
  }
  const token = randomUUID();
  await writeFile(
    join(leaseDir, "owner.json"),
    JSON.stringify({ token, pid: process.pid }),
    {
      flag: "wx",
      mode: 0o600
    }
  );
  let released = false;
  return {
    dataDir: canonical,
    async release() {
      if (released) return;
      const owner = await readFile(join(leaseDir, "owner.json"), "utf8");
      if (owner !== JSON.stringify({ token, pid: process.pid })) {
        throw new Error(
          "Store ownership changed; refusing to remove another owner's lease"
        );
      }
      await rm(leaseDir, { recursive: true });
      released = true;
    }
  };
}

export async function openOwnedPgliteDatabase(
  dataDir: string,
  purpose: "runtime" | "isolated-restore-verification"
): Promise<PGlite> {
  const lease = await acquireStoreOwnership(dataDir);
  let database: PGlite | undefined;
  try {
    await mkdir(lease.dataDir, { recursive: true, mode: 0o700 });
    const quarantined = await pathExists(join(lease.dataDir, RESTORE_QUARANTINE_FILE));
    if (quarantined !== (purpose === "isolated-restore-verification")) {
      throw new Error(
        quarantined
          ? "Restored store is quarantined; live application startup is forbidden"
          : "Isolated verification requires a quarantined restored store"
      );
    }
    await rm(join(lease.dataDir, CLEAN_CLOSE_FILE), { force: true });
    database = new PGlite(lease.dataDir);
    await database.waitReady;
  } catch (error) {
    // If Postgres did not start, do not manufacture a clean-close receipt.
    if (database) await database.close();
    await lease.release();
    throw error;
  }
  const close = database.close.bind(database);
  let closing: Promise<void> | undefined;
  database.close = () => {
    closing ??= (async () => {
      await close();
      // Receipt follows successful PGlite close, never a process scan or timeout.
      await writeFile(
        join(lease.dataDir, CLEAN_CLOSE_FILE),
        JSON.stringify({
          format: "luma-clean-close-v1",
          closedAt: new Date().toISOString()
        }),
        { flag: "wx", mode: 0o600 }
      );
      await lease.release();
    })();
    return closing;
  };
  return database;
}
