import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publishRuntimeHealth } from "../../src/app/runtime-health.js";
import {
  assessOperationalHealth,
  deliverHealthStatus,
  type AlertState,
  type HealthProblem
} from "../../src/operations/health-monitor.js";
import { operationsConfigSchema } from "../../src/operations/linux-operations.js";

const now = new Date("2026-09-11T12:00:00.000Z");
const runtime = {
  format: "luma-runtime-health-v1",
  pid: 1234,
  checkedAt: now.toISOString(),
  gatewayConnected: true
};
const backup = {
  format: "luma-offhost-backup-v1",
  backupId: "f36c50ad-cfc3-4fae-89d1-6c4dad7bac27",
  applicationRevision: "a".repeat(40),
  snapshotId: "b".repeat(64),
  capturedAt: "2026-09-11T03:30:00.000Z",
  verifiedAt: "2026-09-11T03:35:00.000Z"
};

describe("operational health", () => {
  it("bounds planned maintenance grace while still alerting on backup failures and low disk", () => {
    const input = {
      now,
      service: { active: false, mainPid: 0 },
      runtimeReceipt: null,
      backupReceipt: backup,
      maintenanceStartedAt: "2026-09-11T11:59:00.000Z"
    };
    expect(assessOperationalHealth(input)).toEqual([]);
    expect(
      assessOperationalHealth({
        ...input,
        maintenanceStartedAt: "2026-09-11T11:49:59.000Z"
      })
    ).toEqual(["runtime-unavailable"]);
    expect(
      assessOperationalHealth({
        ...input,
        maintenanceStartedAt: "2026-09-11T12:00:01.000Z"
      })
    ).toEqual(["runtime-unavailable"]);
    expect(
      assessOperationalHealth({ ...input, backupFailed: true, freeBytes: 1000 })
    ).toEqual(["backup-failed", "storage-low"]);
  });
  it("requires a fresh receipt from the actual running PID and a current backup capture", () => {
    const input = {
      now,
      service: { active: true, mainPid: 1234 },
      runtimeReceipt: runtime,
      backupReceipt: backup
    };
    expect(assessOperationalHealth(input)).toEqual([]);
    expect(
      assessOperationalHealth({ ...input, service: { active: true, mainPid: 5678 } })
    ).toEqual(["runtime-unavailable"]);
    expect(
      assessOperationalHealth({
        ...input,
        runtimeReceipt: { ...runtime, checkedAt: "2026-09-11T11:58:29.000Z" }
      })
    ).toEqual(["runtime-unavailable"]);
    expect(
      assessOperationalHealth({
        ...input,
        runtimeReceipt: { ...runtime, checkedAt: "2026-09-11T12:00:01.000Z" }
      })
    ).toEqual(["runtime-unavailable"]);
    expect(
      assessOperationalHealth({
        ...input,
        runtimeReceipt: { ...runtime, gatewayConnected: false }
      })
    ).toEqual(["gateway-disconnected"]);
    expect(
      assessOperationalHealth({
        ...input,
        backupReceipt: {
          ...backup,
          capturedAt: "2026-09-09T23:59:59.000Z",
          verifiedAt: now.toISOString()
        }
      })
    ).toEqual(["backup-overdue"]);
    expect(
      assessOperationalHealth({
        ...input,
        backupReceipt: { ...backup, verifiedAt: "2026-09-12T00:00:00.000Z" }
      })
    ).toEqual(["backup-overdue"]);
  });

  it("reports absent/corrupt receipts without inventing a healthy startup", () => {
    expect(
      assessOperationalHealth({
        now,
        service: { active: false, mainPid: 0 },
        runtimeReceipt: null,
        backupReceipt: {}
      })
    ).toEqual(["runtime-unavailable", "backup-overdue"]);
  });

  it("deduplicates unchanged alerts, reminds at six hours, and announces recovery", async () => {
    let state: AlertState | null = null;
    const messages: string[] = [];
    let heartbeats = 0;
    async function check(problems: HealthProblem[], time = now) {
      await deliverHealthStatus({
        problems,
        previous: state,
        now: time,
        send: (message) => {
          messages.push(message);
          return Promise.resolve();
        },
        record: (value) => {
          state = value;
          return Promise.resolve();
        },
        heartbeat: () => {
          heartbeats++;
          return Promise.resolve();
        }
      });
    }
    await check(["gateway-disconnected"]);
    await check(["gateway-disconnected"]);
    expect(messages).toHaveLength(1);
    expect(heartbeats).toBe(0);
    await check(["gateway-disconnected"], new Date(now.getTime() + 6 * 60 * 60_000));
    expect(messages).toHaveLength(2);
    await check([]);
    expect(messages.at(-1)).toContain("recovered");
    expect(heartbeats).toBe(1);
    await check([]);
    expect(messages).toHaveLength(3);
    expect(heartbeats).toBe(2);
  });

  it("retries failed delivery and never pings the external monitor after that failure", async () => {
    let recorded = false;
    let pinged = false;
    await expect(
      deliverHealthStatus({
        problems: ["backup-overdue"],
        previous: null,
        now,
        send: () => Promise.reject(new Error("webhook down")),
        record: () => {
          recorded = true;
          return Promise.resolve();
        },
        heartbeat: () => {
          pinged = true;
          return Promise.resolve();
        }
      })
    ).rejects.toThrow("webhook down");
    expect(recorded).toBe(false);
    expect(pinged).toBe(false);
  });

  it("publishes a private atomic health receipt without source data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luma-health-"));
    const path = join(directory, "health.json");
    try {
      await publishRuntimeHealth(path, true, now);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        ...runtime,
        pid: process.pid
      });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await publishRuntimeHealth(path, false, now);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        ...runtime,
        pid: process.pid,
        gatewayConnected: false
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses local backup repositories and non-Discord alert destinations", () => {
    const config = {
      resticRepository: "s3:https://storage.example.test/bucket/luma",
      resticPasswordFile: "/etc/luma/password",
      s3CredentialsFile: "/etc/luma/s3.json",
      alertWebhookUrl:
        "https://discord.com/api/webhooks/123456789012345678/private-token",
      healthyHeartbeatUrl: "https://monitor.example.test/private-ping"
    };
    expect(operationsConfigSchema.safeParse(config).success).toBe(true);
    expect(
      operationsConfigSchema.safeParse({ ...config, resticRepository: "/local/backup" })
        .success
    ).toBe(false);
    expect(
      operationsConfigSchema.safeParse({
        ...config,
        alertWebhookUrl: "https://example.test/upload"
      }).success
    ).toBe(false);
    expect(
      operationsConfigSchema.safeParse({
        ...config,
        healthyHeartbeatUrl: "http://example.test/ping"
      }).success
    ).toBe(false);
  });
});
