import { describe, expect, it } from "vitest";
import {
  runScheduledBackup,
  type BackupReceipt,
  type MaintenancePort
} from "../../src/operations/maintenance.js";

function service() {
  let active = true;
  let resumeRequired = false;
  const failures = new Set<string>();
  const receipts: BackupReceipt[] = [];
  const uploads: Array<{ directory: string; backupId: string }> = [];
  const port: MaintenancePort = {
    now: () => new Date("2026-09-11T03:31:00.000Z"),
    serviceActive: () => Promise.resolve(active),
    rememberResume: () => {
      resumeRequired = true;
      return Promise.resolve();
    },
    stopService: () => {
      active = false;
      return Promise.resolve();
    },
    resumeService: () => {
      if (failures.has("restart")) return Promise.reject(new Error("restart failed"));
      active = true;
      resumeRequired = false;
      return Promise.resolve();
    },
    coldBackup: () => {
      if (active) return Promise.reject(new Error("active store cannot be backed up"));
      if (failures.has("copy")) return Promise.reject(new Error("copy failed"));
      return Promise.resolve({
        backupId: "f36c50ad-cfc3-4fae-89d1-6c4dad7bac27",
        createdAt: "2026-09-11T03:30:00.000Z",
        applicationRevision: "a".repeat(40),
        directory: "/private/test-backup"
      });
    },
    uploadAndVerify: (directory, backupId) => {
      uploads.push({ directory, backupId });
      if (!active) return Promise.reject(new Error("network work extended downtime"));
      if (failures.has("remote"))
        return Promise.reject(new Error("remote verification failed"));
      return Promise.resolve("b".repeat(64));
    },
    recordVerified: (receipt) => {
      receipts.push(receipt);
      return Promise.resolve();
    }
  };
  return {
    port,
    failures,
    receipts,
    uploads,
    active: () => active,
    resumeRequired: () => resumeRequired,
    stop: () => {
      active = false;
    }
  };
}

describe("scheduled full-store backup", () => {
  it("resumes the service before remote transfer and records only verified snapshots", async () => {
    const fixture = service();
    const receipt = await runScheduledBackup(fixture.port);
    expect(fixture.active()).toBe(true);
    expect(fixture.resumeRequired()).toBe(false);
    expect(fixture.receipts).toEqual([receipt]);
    expect(receipt.capturedAt).toBe("2026-09-11T03:30:00.000Z");
    expect(receipt.snapshotId).toBe("b".repeat(64));
    expect(fixture.uploads).toEqual([
      {
        directory: "/private/test-backup",
        backupId: "f36c50ad-cfc3-4fae-89d1-6c4dad7bac27"
      }
    ]);
  });

  it.each(["copy", "remote"])(
    "preserves runtime availability without claiming success after a %s failure",
    async (failure) => {
      const fixture = service();
      fixture.failures.add(failure);
      await expect(runScheduledBackup(fixture.port)).rejects.toThrow();
      expect(fixture.active()).toBe(true);
      expect(fixture.receipts).toEqual([]);
    }
  );

  it("leaves a failed restart pending for service-manager cleanup", async () => {
    const fixture = service();
    fixture.failures.add("restart");
    await expect(runScheduledBackup(fixture.port)).rejects.toThrow("restart failed");
    expect(fixture.resumeRequired()).toBe(true);
    expect(fixture.receipts).toEqual([]);
    fixture.failures.clear();
    await fixture.port.resumeService();
    expect(fixture.active()).toBe(true);
  });

  it("does not start an intentionally stopped or crashed service", async () => {
    const fixture = service();
    fixture.stop();
    await expect(runScheduledBackup(fixture.port)).rejects.toThrow("normally running");
    expect(fixture.active()).toBe(false);
    expect(fixture.resumeRequired()).toBe(false);
    expect(fixture.receipts).toEqual([]);
  });
});
