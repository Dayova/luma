import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  restoreFullStoreBackup,
  verifyFullStoreBackup,
  verifyIsolatedRestoredStore
} from "../persistence/full-store-backup.js";

export type ResticCommand = (
  args: string[],
  options?: { cwd?: string; timeout?: number }
) => Promise<string>;

/** A successful upload alone is insufficient: download that exact snapshot and
 * prove both the full manifest and every Postgres table on a quarantined copy. */
export async function archiveAndVerifyBackup(input: {
  directory: string;
  backupId: string;
  scratchParent: string;
  restic: ResticCommand;
}): Promise<string> {
  const original = await verifyFullStoreBackup(input.directory);
  if (original.backupId !== input.backupId)
    throw new Error("The captured backup identity changed");
  await input.restic(
    ["--json", "--quiet", "backup", ".", "--tag", "luma", "--tag", input.backupId],
    { cwd: input.directory, timeout: 20 * 60_000 }
  );
  const snapshots = z
    .array(
      z.object({ id: z.string().regex(/^[a-f0-9]{64}$/u), tags: z.array(z.string()) })
    )
    .length(1)
    .parse(
      JSON.parse(await input.restic(["--json", "snapshots", "--tag", input.backupId]))
    );
  const snapshot = snapshots[0]!;
  if (!snapshot.tags.includes(input.backupId))
    throw new Error("The uploaded snapshot identity is unverified");
  await mkdir(input.scratchParent, { recursive: true, mode: 0o700 });
  const restored = await mkdtemp(join(input.scratchParent, "download-"));
  const rehearsal = join(input.scratchParent, `rehearsal-${randomUUID()}`);
  await input.restic(["--quiet", "restore", snapshot.id, "--target", restored], {
    timeout: 20 * 60_000
  });
  const manifest = await verifyFullStoreBackup(restored);
  if (JSON.stringify(manifest) !== JSON.stringify(original))
    throw new Error("The downloaded backup differs from the captured store");
  await restoreFullStoreBackup({ backupDir: restored, restoreDir: rehearsal });
  await verifyIsolatedRestoredStore(rehearsal);
  // Remove only this invocation's verified duplicates. Remote snapshots and
  // canonical history stay retained without age expiry. Failed copies remain.
  await rm(rehearsal, { recursive: true });
  await rm(restored, { recursive: true });
  return snapshot.id;
}
