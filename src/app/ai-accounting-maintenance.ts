// This entrypoint loads no environment file, server, SDK or provider adapter.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  AiAccountingRecoveryError,
  createAiUsageReconciliation
} from "../ai/ai-usage-reconciliation.js";
import { dayovaFounderPersonIds } from "./founder-access.js";
import { openOwnedPgliteDatabase } from "../persistence/store-ownership.js";
import { runMigrations } from "../persistence/db.js";

const selectionSchema = z
  .object({
    workspaceId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/u),
    afterReservationId: z.string().uuid().optional()
  })
  .strict();

export function accountingOperatorFromPolicy(value: unknown, currentUid: number) {
  const policy = z
    .object({
      operators: z
        .array(
          z
            .object({
              localUid: z.number().int().nonnegative(),
              personId: z.enum(dayovaFounderPersonIds)
            })
            .strict()
        )
        .min(1)
        .max(4)
    })
    .strict()
    .parse(value);
  const matches = policy.operators.filter((operator) => operator.localUid === currentUid);
  if (matches.length !== 1)
    throw new AiAccountingRecoveryError("operator-not-authorized");
  return matches[0]!;
}

/** No symlinks, shared hard links, oversized files or broadly readable review inputs. */
export async function readAccountingInput(
  path: string,
  ownerUid: number
): Promise<unknown> {
  if (!isAbsolute(path))
    throw new AiAccountingRecoveryError("absolute-input-path-required");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== ownerUid ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > 65_536
    ) {
      throw new AiAccountingRecoveryError("private-owned-input-required");
    }
    return JSON.parse(await file.readFile("utf8")) as unknown;
  } finally {
    await file.close();
  }
}

export async function runAiAccountingMaintenance(args: string[]): Promise<void> {
  const [command, storePath, policyPath, inputPath, outputPath, ...extra] = args;
  if (
    !command ||
    !["inspect", "prepare", "apply"].includes(command) ||
    !storePath ||
    !policyPath ||
    !inputPath ||
    !outputPath ||
    extra.length
  ) {
    throw new AiAccountingRecoveryError(
      "usage-inspect-prepare-apply-store-policy-input-fresh-output"
    );
  }
  if (!isAbsolute(storePath) || !isAbsolute(outputPath))
    throw new AiAccountingRecoveryError("absolute-paths-required");
  // Refuse a nonexistent store before the ownership helper can create anything.
  const storeInfo = await lstat(storePath);
  if (!storeInfo.isDirectory() || storeInfo.isSymbolicLink())
    throw new AiAccountingRecoveryError("store-directory-required");
  const canonicalStore = await realpath(storePath);
  const canonicalOutput = resolve(
    await realpath(dirname(outputPath)),
    basename(outputPath)
  );
  const outputWithinStore = relative(canonicalStore, canonicalOutput);
  const outputWithinLease = relative(`${canonicalStore}.luma-owner`, canonicalOutput);
  if (
    !outputWithinStore ||
    (!outputWithinStore.startsWith(`..${sep}`) && outputWithinStore !== "..") ||
    !outputWithinLease ||
    (!outputWithinLease.startsWith(`..${sep}`) && outputWithinLease !== "..")
  )
    throw new AiAccountingRecoveryError("output-must-be-outside-store");
  const uid = process.geteuid?.();
  if (uid === undefined) throw new AiAccountingRecoveryError("unix-operator-required");
  const operator = accountingOperatorFromPolicy(
    await readAccountingInput(policyPath, 0),
    uid
  );
  const request = await readAccountingInput(inputPath, uid);
  // Acquire output exclusively before a mutation so an existing output can never
  // cause a successful operation to look unrecorded. Failure leaves an empty file.
  const output = await open(
    outputPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    const database = await openOwnedPgliteDatabase(
      canonicalStore,
      "accounting-maintenance"
    );
    try {
      await runMigrations(database);
      const recovery = createAiUsageReconciliation({ database, operator });
      let result: unknown;
      if (command === "inspect") {
        const selection = selectionSchema.parse(request);
        result = await recovery.inspect(
          selection.workspaceId,
          selection.afterReservationId
        );
      } else if (command === "prepare") {
        // Validation belongs to the owned operation, not the command parser.
        result = await recovery.prepare(
          request as Parameters<typeof recovery.prepare>[0]
        );
      } else {
        result = await recovery.apply(request as Parameters<typeof recovery.apply>[0]);
      }
      await output.writeFile(JSON.stringify(result, null, 2) + "\n");
      await output.sync();
    } finally {
      await database.close();
    }
  } finally {
    await output.close();
  }
  process.stdout.write(
    `AI accounting ${command} complete; review the private output file.\n`
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await runAiAccountingMaintenance(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      (error instanceof AiAccountingRecoveryError
        ? error.message
        : "AI accounting maintenance failed; inspect input permissions, the stopped-store state and private review files.") +
        "\n"
    );
    process.exitCode = 1;
  }
}
