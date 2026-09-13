// This operator-only entrypoint has no server, environment loader, or SDK import.
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import {
  accountingInvokingUid,
  accountingOperatorFromPolicy,
  readAccountingInput
} from "./ai-accounting-maintenance.js";
import { createCrashRecoveryRehearsal } from "../persistence/full-store-backup.js";

try {
  const [policyPath, planPath, ...extra] = process.argv.slice(2);
  if (process.platform !== "linux" || !policyPath || !planPath || extra.length)
    throw new Error("Invalid crash rehearsal invocation");
  const operator = accountingOperatorFromPolicy(
    await readAccountingInput(policyPath, 0),
    accountingInvokingUid(process.getuid?.(), process.env["SUDO_UID"])
  );
  const plan = z
    .object({
      fencedImageDir: z.string().refine(isAbsolute),
      restoreDir: z.string().refine(isAbsolute),
      applicationRevision: z.string().regex(/^[a-f0-9]{40}$/u),
      fencing: z
        .object({
          recordId: z.string().min(1).max(200),
          originalOwnerFenced: z.literal(true),
          automaticRestartsDisabled: z.literal(true)
        })
        .strict()
    })
    .strict()
    .parse(await readAccountingInput(planPath, 0));
  // An administrator creates this separate offline image root after fencing the
  // original volume. Never accept the live runtime directory as a crash image.
  const image = await realpath(plan.fencedImageDir);
  const imageRoot = await realpath("/var/lib/luma-crash-images");
  const imageRootInfo = await lstat(imageRoot);
  if (
    !imageRootInfo.isDirectory() ||
    imageRootInfo.uid !== 0 ||
    (imageRootInfo.mode & 0o777) !== 0o700
  )
    throw new Error("The crash image root must be private and root owned");
  const subpath = relative(imageRoot, image);
  if (!subpath || subpath === ".." || subpath.startsWith(`..${sep}`))
    throw new Error("A separate fenced crash image is required");
  const result = await createCrashRecoveryRehearsal({ ...plan, fencedImageDir: image });
  process.stdout.write(
    JSON.stringify({
      status: "crash-rehearsal-readable-in-quarantine",
      operatorPersonId: operator.personId,
      recordId: plan.fencing.recordId,
      ...result
    }) + "\n"
  );
} catch {
  console.error(
    "Crash rehearsal failed. Preserve the original lease and image; inspect the reviewed fencing record. No runtime promotion was performed."
  );
  process.exitCode = 1;
}
