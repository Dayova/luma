import { z } from "zod";

export const backupReceiptSchema = z
  .object({
    format: z.literal("luma-offhost-backup-v1"),
    backupId: z.string().uuid(),
    applicationRevision: z.string().regex(/^[a-f0-9]{40}$/u),
    capturedAt: z.string().datetime(),
    verifiedAt: z.string().datetime(),
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict();
export type BackupReceipt = z.infer<typeof backupReceiptSchema>;

export type MaintenancePort = {
  serviceActive(): Promise<boolean>;
  rememberResume(): Promise<void>;
  stopService(): Promise<void>;
  resumeService(): Promise<void>;
  coldBackup(): Promise<{
    backupId: string;
    createdAt: string;
    applicationRevision: string;
    directory: string;
  }>;
  uploadAndVerify(directory: string, backupId: string): Promise<string>;
  recordVerified(receipt: BackupReceipt): Promise<void>;
  now(): Date;
};

/** Downtime covers only the exclusive cold copy; network work follows restart. */
export async function runScheduledBackup(port: MaintenancePort): Promise<BackupReceipt> {
  if (!(await port.serviceActive())) {
    throw new Error("Scheduled backup requires the normally running Luma service");
  }
  // A service-manager cleanup can resume after this process is interrupted. This
  // records intent before stop, and never removes the database's ownership lease.
  await port.rememberResume();
  let backup: Awaited<ReturnType<MaintenancePort["coldBackup"]>>;
  try {
    await port.stopService();
    backup = await port.coldBackup();
  } finally {
    await port.resumeService();
  }
  const snapshotId = await port.uploadAndVerify(backup.directory, backup.backupId);
  const receipt = backupReceiptSchema.parse({
    format: "luma-offhost-backup-v1",
    backupId: backup.backupId,
    applicationRevision: backup.applicationRevision,
    capturedAt: backup.createdAt,
    verifiedAt: port.now().toISOString(),
    snapshotId
  });
  await port.recordVerified(receipt);
  return receipt;
}
