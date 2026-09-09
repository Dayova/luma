import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import {
  CLEAN_CLOSE_FILE,
  RESTORE_QUARANTINE_FILE,
  acquireStoreOwnership,
  canonicalStorePath,
  openOwnedPgliteDatabase,
  pathExists
} from "./store-ownership.js";

const entryPath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !isAbsolute(path) &&
      !path.includes("\\") &&
      !path.split("/").some((part) => part === "" || part === "." || part === ".."),
    "Unsafe backup entry path"
  );
const fileEntry = z
  .object({
    path: entryPath,
    bytes: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
const manifestSchema = z
  .object({
    format: z.literal("luma-full-store-v1"),
    backupId: z.string().uuid(),
    createdAt: z.string().datetime(),
    applicationRevision: z.string().regex(/^[a-f0-9]{40}$/),
    sourceDataDir: z.string().refine(isAbsolute),
    nodeVersion: z.string(),
    directories: z.array(entryPath),
    files: z.array(fileEntry).min(1)
  })
  .strict();
export type FullStoreBackupManifest = z.infer<typeof manifestSchema>;

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Enumerate every physical file, including tables unknown to this application version. */
async function inventory(
  root: string
): Promise<Pick<FullStoreBackupManifest, "files" | "directories">> {
  const files: FullStoreBackupManifest["files"] = [];
  const directories: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = join(directory, name);
      const path = relative(root, absolute);
      entryPath.parse(path);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink())
        throw new Error("Symlinks are not supported in a cold store backup");
      if (stat.isDirectory()) {
        directories.push(path);
        await visit(absolute);
      } else if (stat.isFile() && stat.nlink === 1) {
        files.push({ path, bytes: stat.size, sha256: await hashFile(absolute) });
      } else {
        throw new Error("Cold store contains a special file or shared hard link");
      }
    }
  }
  await visit(root);
  return { files, directories };
}

async function readManifest(backupDir: string): Promise<FullStoreBackupManifest> {
  const path = join(backupDir, "manifest.json");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) {
    throw new Error("Invalid or oversized backup manifest");
  }
  const raw = await readFile(path, "utf8");
  const expectedHash = await readFile(join(backupDir, "manifest.sha256"), "utf8");
  if (createHash("sha256").update(raw).digest("hex") !== expectedHash.trim()) {
    throw new Error("Backup manifest integrity check failed");
  }
  const manifest = manifestSchema.parse(JSON.parse(raw));
  const paths = [...manifest.directories, ...manifest.files.map((entry) => entry.path)];
  if (new Set(paths).size !== paths.length) throw new Error("Duplicate backup entries");
  return manifest;
}

function assertSeparate(left: string, right: string): void {
  for (const [outer, inner] of [
    [left, right],
    [right, left]
  ]) {
    if (outer === undefined || inner === undefined) throw new Error("Missing path");
    const path = relative(outer, inner);
    if (path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path))) {
      throw new Error("Store, backup and restore paths must be separate, never nested");
    }
  }
}

async function copyInventory(
  source: string,
  destination: string,
  entries: Pick<FullStoreBackupManifest, "files" | "directories">
): Promise<void> {
  for (const path of entries.directories) {
    await mkdir(join(destination, path), { mode: 0o700 });
  }
  for (const file of entries.files) {
    await copyFile(join(source, file.path), join(destination, file.path), 1);
  }
}

/** Cold-only: neither opens Postgres nor contacts any provider. */
export async function createFullStoreBackup(input: {
  dataDir: string;
  backupDir: string;
  applicationRevision: string;
}): Promise<FullStoreBackupManifest> {
  z.string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(input.applicationRevision);
  const source = await canonicalStorePath(input.dataDir);
  const destination = await canonicalStorePath(input.backupDir);
  assertSeparate(source, destination);
  if (!(await pathExists(source))) throw new Error("Source store does not exist");
  const lease = await acquireStoreOwnership(source);
  try {
    if (await pathExists(join(source, RESTORE_QUARANTINE_FILE))) {
      throw new Error("A restore rehearsal cannot become a production backup");
    }
    const closeReceipt = z
      .object({
        format: z.literal("luma-clean-close-v1"),
        closedAt: z.string().datetime()
      })
      .strict()
      .parse(JSON.parse(await readFile(join(source, CLEAN_CLOSE_FILE), "utf8")));
    void closeReceipt;
    if (!(await pathExists(join(source, "PG_VERSION"))))
      throw new Error("Source is not a PGlite store");
    const entries = await inventory(source);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await mkdir(destination, { mode: 0o700 }); // Existing destinations always fail.
    const payload = join(destination, "store");
    await mkdir(payload, { mode: 0o700 });
    await copyInventory(source, payload, entries);
    const copied = await inventory(payload);
    if (JSON.stringify(entries) !== JSON.stringify(copied))
      throw new Error("Copied store integrity check failed");
    const manifest: FullStoreBackupManifest = {
      format: "luma-full-store-v1",
      backupId: randomUUID(),
      createdAt: new Date().toISOString(),
      applicationRevision: input.applicationRevision,
      sourceDataDir: source,
      nodeVersion: process.version,
      ...entries
    };
    const raw = JSON.stringify(manifest, null, 2) + "\n";
    await writeFile(join(destination, "manifest.json"), raw, { flag: "wx", mode: 0o600 });
    await writeFile(
      join(destination, "manifest.sha256"),
      createHash("sha256").update(raw).digest("hex") + "\n",
      { flag: "wx", mode: 0o600 }
    );
    return manifest;
  } finally {
    await lease.release();
  }
}

export async function verifyFullStoreBackup(
  backupDir: string
): Promise<FullStoreBackupManifest> {
  const backup = await canonicalStorePath(backupDir);
  const manifest = await readManifest(backup);
  const payload = join(backup, "store");
  if ((await lstat(payload)).isSymbolicLink())
    throw new Error("Backup payload cannot be a symlink");
  const actual = await inventory(payload);
  if (
    JSON.stringify(actual) !==
    JSON.stringify({ files: manifest.files, directories: manifest.directories })
  ) {
    throw new Error(
      "Backup payload integrity check failed (missing, extra, or changed content)"
    );
  }
  return manifest;
}

/** Restore only to a fresh directory. The quarantine marker blocks normal app startup. */
export async function restoreFullStoreBackup(input: {
  backupDir: string;
  restoreDir: string;
}): Promise<FullStoreBackupManifest> {
  const backup = await canonicalStorePath(input.backupDir);
  const destination = await canonicalStorePath(input.restoreDir);
  assertSeparate(backup, destination);
  const manifest = await verifyFullStoreBackup(backup);
  assertSeparate(manifest.sourceDataDir, destination);
  const lease = await acquireStoreOwnership(destination);
  try {
    await mkdir(destination, { mode: 0o700 });
    // Quarantine exists even when a later copy fails. It is never a CLI toggle.
    await writeFile(
      join(destination, RESTORE_QUARANTINE_FILE),
      JSON.stringify({
        format: "luma-isolated-restore-v1",
        backupId: manifest.backupId,
        applicationRevision: manifest.applicationRevision
      }),
      { flag: "wx", mode: 0o600 }
    );
    if (manifest.files.some((file) => file.path === RESTORE_QUARANTINE_FILE)) {
      throw new Error("Backup unexpectedly contains a restored-store marker");
    }
    await copyInventory(join(backup, "store"), destination, manifest);
    const actual = await inventory(destination);
    actual.files = actual.files.filter((entry) => entry.path !== RESTORE_QUARANTINE_FILE);
    if (
      JSON.stringify(actual) !==
      JSON.stringify({ files: manifest.files, directories: manifest.directories })
    ) {
      throw new Error("Restored store integrity check failed");
    }
    return manifest;
  } finally {
    await lease.release();
  }
}

/** No migrations or provider configuration: open only the quarantined copy and count every public table. */
export async function verifyIsolatedRestoredStore(restoreDir: string): Promise<{
  tables: { table: string; rows: string }[];
}> {
  const database = await openOwnedPgliteDatabase(
    restoreDir,
    "isolated-restore-verification"
  );
  try {
    const tables = await database.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    const counts: { table: string; rows: string }[] = [];
    for (const { tablename } of tables.rows) {
      const quoted = '"' + tablename.replaceAll('"', '""') + '"';
      const result = await database.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count,
           COALESCE(SUM(octet_length(to_jsonb(t)::text)), 0)::text AS verified_row_bytes
         FROM ${quoted} t`
      );
      counts.push({ table: tablename, rows: result.rows[0]?.count ?? "0" });
    }
    return { tables: counts };
  } finally {
    await database.close();
  }
}
