import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCrashRecoveryRehearsal,
  createFullStoreBackup
} from "../../src/persistence/full-store-backup.js";
import {
  openOwnedPgliteDatabase,
  pathExists,
  CLEAN_CLOSE_FILE,
  RESTORE_QUARANTINE_FILE
} from "../../src/persistence/store-ownership.js";

describe("unclean crash recovery rehearsal", () => {
  it("also preserves a genuine clean-close receipt when interrupted maintenance left a lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "luma-maintenance-crash-"));
    const image = join(root, "image");
    try {
      const database = await openOwnedPgliteDatabase(image, "runtime");
      await database.exec(
        "CREATE TABLE receipts (id text); INSERT INTO receipts VALUES ('completed');"
      );
      await database.close();
      const receipt = await readFile(join(image, CLEAN_CLOSE_FILE), "utf8");
      await mkdir(`${image}.luma-owner`);
      await writeFile(
        join(`${image}.luma-owner`, "owner.json"),
        "interrupted-backup-owner"
      );
      const result = await createCrashRecoveryRehearsal({
        fencedImageDir: image,
        restoreDir: join(root, "rehearsal"),
        applicationRevision: "a".repeat(40),
        fencing: {
          recordId: "fenced-maintenance-copy",
          originalOwnerFenced: true,
          automaticRestartsDisabled: true
        }
      });
      expect(result.tables).toContainEqual({ table: "receipts", rows: "1" });
      expect(await readFile(join(image, CLEAN_CLOSE_FILE), "utf8")).toBe(receipt);
      expect(await readFile(join(`${image}.luma-owner`, "owner.json"), "utf8")).toBe(
        "interrupted-backup-owner"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
  it("recovers a killed Postgres process only in quarantine and preserves the original lease and indeterminate records", async () => {
    const root = await mkdtemp(join(tmpdir(), "luma-crash-"));
    const image = join(root, "image");
    const restored = join(root, "rehearsal");
    const lease = `${image}.luma-owner`;
    await mkdir(lease);
    const owner = JSON.stringify({ token: "original-owner", pid: 12345 });
    await writeFile(join(lease, "owner.json"), owner);
    // The external dependency is a real independent embedded Postgres process.
    // A committed record and unresolved execution hold survive a real SIGKILL;
    // no helper creates a clean-close receipt to make this image acceptable.
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { PGlite } from "@electric-sql/pglite";
      const db = new PGlite(process.argv[1]);
      await db.waitReady;
      await db.exec("CREATE TABLE retained_history (id text PRIMARY KEY, state text); INSERT INTO retained_history VALUES ('human-judgment','confirmed'), ('external-mutation','unknown'), ('ai-charge','held'); CHECKPOINT;");
      process.stdout.write("READY\\n");
      setInterval(() => {}, 1000);
    `,
        image
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    try {
      let ready = "";
      for await (const chunk of child.stdout) {
        ready += String(chunk);
        if (ready.includes("READY\n")) break;
      }
      expect(ready).toContain("READY\n");
      const closed = once(child, "exit");
      child.kill("SIGKILL");
      await closed;
      expect(await pathExists(join(image, CLEAN_CLOSE_FILE))).toBe(false);
      await expect(openOwnedPgliteDatabase(image, "runtime")).rejects.toThrow(
        "automatic lease recovery is forbidden"
      );
      await expect(
        createFullStoreBackup({
          dataDir: image,
          backupDir: join(root, "invalid-backup"),
          applicationRevision: "a".repeat(40)
        })
      ).rejects.toThrow();
      const result = await createCrashRecoveryRehearsal({
        fencedImageDir: image,
        restoreDir: restored,
        applicationRevision: "a".repeat(40),
        fencing: {
          recordId: "synthetic-owner-process-confirmed-exited",
          originalOwnerFenced: true,
          automaticRestartsDisabled: true
        }
      });
      expect(result.tables).toContainEqual({ table: "retained_history", rows: "3" });
      expect(await readFile(join(lease, "owner.json"), "utf8")).toBe(owner);
      expect(await pathExists(join(image, CLEAN_CLOSE_FILE))).toBe(false);
      expect(await pathExists(join(restored, RESTORE_QUARANTINE_FILE))).toBe(true);
      await expect(openOwnedPgliteDatabase(restored, "runtime")).rejects.toThrow(
        "quarantined"
      );
      const database = await openOwnedPgliteDatabase(
        restored,
        "isolated-restore-verification"
      );
      try {
        expect(
          (await database.query("SELECT * FROM retained_history ORDER BY id")).rows
        ).toEqual([
          { id: "ai-charge", state: "held" },
          { id: "external-mutation", state: "unknown" },
          { id: "human-judgment", state: "confirmed" }
        ]);
      } finally {
        await database.close();
      }
      await expect(
        createCrashRecoveryRehearsal({
          fencedImageDir: image,
          restoreDir: restored,
          applicationRevision: "a".repeat(40),
          fencing: {
            recordId: "repeat",
            originalOwnerFenced: true,
            automaticRestartsDisabled: true
          }
        })
      ).rejects.toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, "exit");
        child.kill("SIGKILL");
        await stopped;
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
