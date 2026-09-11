import { z } from "zod";
import { runtimeHealthSchema } from "../app/runtime-health.js";
import { backupReceiptSchema } from "./maintenance.js";

/** Matches the complete stop/copy/verify/resume bound in luma-backup.service. */
export const BACKUP_SERVICE_TIMEOUT_MS = 60 * 60_000;

export const healthProblemSchema = z.enum([
  "runtime-unavailable",
  "gateway-disconnected",
  "backup-overdue",
  "backup-failed",
  "storage-low"
]);
export type HealthProblem = z.infer<typeof healthProblemSchema>;
export const alertStateSchema = z
  .object({
    format: z.literal("luma-health-alert-v1"),
    problems: z.array(healthProblemSchema),
    notifiedAt: z.string().datetime()
  })
  .strict();
export type AlertState = z.infer<typeof alertStateSchema>;

export function assessOperationalHealth(input: {
  now: Date;
  service: { active: boolean; mainPid: number };
  runtimeReceipt: unknown;
  backupReceipt: unknown;
  backupFailed?: boolean;
  freeBytes?: number;
  /** A matching live backup service and protected resume marker are required. */
  maintenanceStartedAt?: string;
}): HealthProblem[] {
  const problems: HealthProblem[] = [];
  if (input.backupFailed) problems.push("backup-failed");
  if (
    input.freeBytes !== undefined &&
    (!Number.isFinite(input.freeBytes) || input.freeBytes < 2 * 1024 ** 3)
  ) {
    problems.push("storage-low");
  }
  const runtime = runtimeHealthSchema.safeParse(input.runtimeReceipt);
  const currentTime = input.now.getTime();
  const maintenanceAge = input.maintenanceStartedAt
    ? currentTime - Date.parse(input.maintenanceStartedAt)
    : Infinity;
  const plannedColdCopy =
    maintenanceAge >= 0 && maintenanceAge < BACKUP_SERVICE_TIMEOUT_MS;
  const runtimeAge = runtime.success
    ? currentTime - Date.parse(runtime.data.checkedAt)
    : Infinity;
  if (
    !plannedColdCopy &&
    (!input.service.active ||
      !runtime.success ||
      runtime.data.pid !== input.service.mainPid ||
      runtimeAge < 0 ||
      runtimeAge > 90_000)
  ) {
    problems.push("runtime-unavailable");
  } else if (!plannedColdCopy && runtime.success && !runtime.data.gatewayConnected) {
    problems.push("gateway-disconnected");
  }
  const backup = backupReceiptSchema.safeParse(input.backupReceipt);
  const backupAge = backup.success
    ? currentTime - Date.parse(backup.data.capturedAt)
    : Infinity;
  if (
    !backup.success ||
    backupAge < 0 ||
    backupAge > 36 * 60 * 60 * 1_000 ||
    Date.parse(backup.data.verifiedAt) > currentTime ||
    Date.parse(backup.data.verifiedAt) < Date.parse(backup.data.capturedAt)
  ) {
    problems.push("backup-overdue");
  }
  return problems;
}

export async function deliverHealthStatus(input: {
  problems: HealthProblem[];
  previous: unknown;
  now: Date;
  send(message: string): Promise<void>;
  record(state: AlertState): Promise<void>;
  heartbeat(): Promise<void>;
}): Promise<void> {
  const previous = alertStateSchema.safeParse(input.previous);
  const changed =
    !previous.success ||
    JSON.stringify(previous.data.problems) !== JSON.stringify(input.problems);
  const remind =
    previous.success &&
    input.problems.length > 0 &&
    input.now.getTime() - Date.parse(previous.data.notifiedAt) >= 6 * 60 * 60 * 1_000;
  if ((changed && (previous.success || input.problems.length > 0)) || remind) {
    const descriptions: Record<HealthProblem, string> = {
      "runtime-unavailable":
        "Luma is stopped, starting, or no longer reporting current health.",
      "gateway-disconnected": "Luma is running but its Discord Gateway is disconnected.",
      "backup-overdue":
        "Luma has no verified off-host backup captured within the last 36 hours.",
      "backup-failed":
        "Luma's latest scheduled backup failed. The last verified backup has been preserved.",
      "storage-low":
        "Luma has less than 2 GiB of free space for its store or backup verification."
    };
    await input.send(
      input.problems.length === 0
        ? "Luma operations recovered: runtime, Discord Gateway, and off-host backup checks are healthy."
        : input.problems.map((problem) => descriptions[problem]).join("\n")
    );
    // Failed delivery remains retryable. State never claims a notification sent.
    await input.record({
      format: "luma-health-alert-v1",
      problems: input.problems,
      notifiedAt: input.now.toISOString()
    });
  } else if (!previous.success) {
    await input.record({
      format: "luma-health-alert-v1",
      problems: input.problems,
      notifiedAt: input.now.toISOString()
    });
  }
  // A monitor outside this VPS detects loss of the host, timer, or alert sender.
  // An unhealthy check deliberately does not renew that external lease.
  if (input.problems.length === 0) await input.heartbeat();
}
