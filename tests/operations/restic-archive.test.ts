import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveAndVerifyBackup,
  type ResticCommand
} from "../../src/operations/restic-archive.js";
import {
  createFullStoreBackup,
  verifyFullStoreBackup
} from "../../src/persistence/full-store-backup.js";
import { openOwnedPgliteDatabase } from "../../src/persistence/store-ownership.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "luma-restic-"));
  roots.push(root);
  const directory = join(root, "cold");
  const scratchParent = join(root, "scratch");
  const remote = join(root, "external-repository-snapshot");
  await mkdir(scratchParent);
  const database = await openOwnedPgliteDatabase(join(root, "store"), "runtime");
  await database.exec(
    "CREATE TABLE durable_receipts (id text PRIMARY KEY, disposition text); INSERT INTO durable_receipts VALUES ('mutation','completed'), ('ai-charge','held');"
  );
  await database.close();
  const manifest = await createFullStoreBackup({
    dataDir: join(root, "store"),
    backupDir: directory,
    applicationRevision: "a".repeat(40)
  });
  let corruptDownload = false;
  let snapshots = 0;
  const snapshotId = "b".repeat(64);
  const restic: ResticCommand = async (args, options) => {
    // The programmable dependency is only the encrypted remote archive process;
    // inventory hashing, quarantine, and Postgres reads below use real files.
    if (args.includes("backup")) {
      if (!options?.cwd) throw new Error("Backup source missing");
      await cp(options.cwd, remote, {
        recursive: true,
        errorOnExist: true,
        force: false
      });
      snapshots++;
      return "";
    }
    if (args.includes("snapshots"))
      return JSON.stringify([{ id: snapshotId, tags: ["luma", manifest.backupId] }]);
    if (args.includes("restore")) {
      const target = args[args.indexOf("--target") + 1];
      if (!target || !args.includes(snapshotId)) throw new Error("Unbound restore");
      await cp(remote, target, { recursive: true, force: true });
      if (corruptDownload)
        await writeFile(
          join(target, "store", "unexpected-private-data"),
          "corrupt download"
        );
      return "";
    }
    throw new Error("Unsupported archive action");
  };
  return {
    directory,
    scratchParent,
    backupId: manifest.backupId,
    restic,
    snapshotId,
    corrupt: () => {
      corruptDownload = true;
    },
    snapshots: () => snapshots
  };
}

describe("encrypted off-host archive verification", () => {
  it("proves an exact downloaded snapshot with a complete isolated Postgres read and cleans only its verified temporary duplicates", async () => {
    const input = await fixture();
    expect(await archiveAndVerifyBackup(input)).toBe(input.snapshotId);
    expect(input.snapshots()).toBe(1);
    expect(await readdir(input.scratchParent)).toEqual([]);
    expect((await verifyFullStoreBackup(input.directory)).backupId).toBe(input.backupId);
  }, 15_000);

  it("retains failed artifacts and the original backup when remote bytes fail verification", async () => {
    const input = await fixture();
    input.corrupt();
    await expect(archiveAndVerifyBackup(input)).rejects.toThrow("integrity check failed");
    expect(input.snapshots()).toBe(1);
    expect(await readdir(input.scratchParent)).toHaveLength(1);
    expect((await verifyFullStoreBackup(input.directory)).backupId).toBe(input.backupId);
  }, 15_000);
});
