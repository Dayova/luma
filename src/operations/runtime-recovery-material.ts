import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual
} from "node:crypto";
import { z } from "zod";
import { parseProductionEnvironmentFile } from "../app/production-runtime.js";
import {
  openOwnedPgliteDatabase,
  RESTORE_QUARANTINE_FILE
} from "../persistence/store-ownership.js";
import { verifyGranolaOAuthRecovery } from "../granola/oauth-store.js";
import type { LumaDatabase } from "../persistence/db.js";

const role = z.enum([
  "production-environment",
  "sharing-policy",
  "authority-policy",
  "granola-key",
  "structured-work-targets"
]);
type Role = z.infer<typeof role>;
const names: Record<Role, string> = {
  "production-environment": "production.env",
  "sharing-policy": "sharing-policy.json",
  "authority-policy": "authority-policy.json",
  "granola-key": "granola.key",
  "structured-work-targets": "structured-work-targets.json"
};
const policyKeys = {
  "sharing-policy": "LUMA_CONTEXT_SHARING_POLICY_PATH",
  "authority-policy": "LUMA_DECISION_AUTHORITY_POLICY_PATH",
  "granola-key": "LUMA_GRANOLA_CREDENTIAL_KEY_PATH",
  "structured-work-targets": "LUMA_STRUCTURED_WORK_TARGETS_PATH"
} as const;
const hex = z.string().regex(/^[a-f0-9]{64}$/u);
const manifestSchema = z
  .object({
    format: z.literal("luma-runtime-recovery-v1"),
    backupId: z.string().uuid(),
    workspaceId: z.string().min(1).max(512),
    files: z
      .array(
        z
          .object({
            role,
            originalPath: z.string().refine(isAbsolute),
            bytes: z.number().int().min(1).max(65_536),
            sha256: hex
          })
          .strict()
      )
      .min(1)
      .max(5),
    authentication: z
      .object({
        algorithm: z.literal("scrypt-hmac-sha256-v1"),
        salt: hex,
        tag: hex
      })
      .strict()
  })
  .strict();
export type RuntimeRecoveryManifest = z.infer<typeof manifestSchema>;
type ProofInput = {
  directory: string;
  backupId: string;
  /** The repository password remains separately held; it is never archived here. */
  authenticationSecret: Uint8Array;
};
const unavailable = () =>
  new Error(
    "Runtime recovery material is missing, changed, unprotected, or could not be authenticated"
  );
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const payload = (manifest: RuntimeRecoveryManifest) => ({
  format: manifest.format,
  backupId: manifest.backupId,
  workspaceId: manifest.workspaceId,
  files: manifest.files
});

async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !isAbsolute(path) ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.geteuid?.() ||
    (info.mode & 0o777) !== 0o700 ||
    (await realpath(path)) !== path
  )
    throw unavailable();
}
/** Bounded descriptor read, checking both its identity and the pathname after the read. */
async function privateFile(
  path: string,
  sourceRole?: Role,
  sourceOwnerUid?: number
): Promise<Buffer> {
  if (
    sourceOwnerUid !== undefined &&
    (!Number.isSafeInteger(sourceOwnerUid) || sourceOwnerUid < 0)
  )
    throw unavailable();
  if (!isAbsolute(path) || (await realpath(path)) !== path) throw unavailable();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer | undefined;
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      ![
        0,
        process.geteuid?.(),
        ...(sourceRole &&
        sourceRole !== "production-environment" &&
        sourceOwnerUid !== undefined
          ? [sourceOwnerUid]
          : [])
      ].includes(before.uid) ||
      (sourceRole === "sharing-policy" || sourceRole === "structured-work-targets"
        ? (before.mode & 0o022) !== 0
        : sourceRole === "granola-key" || sourceRole === "authority-policy"
          ? (before.mode & 0o077) !== 0
          : (before.mode & 0o777) !== 0o600) ||
      before.size < 1 ||
      before.size > 65_536
    )
      throw unavailable();
    bytes = Buffer.alloc(65_537);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat(),
      current = await lstat(path);
    if (
      bytesRead !== before.size ||
      bytesRead > 65_536 ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.mode !== after.mode ||
      before.nlink !== after.nlink ||
      before.uid !== after.uid ||
      (await realpath(path)) !== path
    )
      throw unavailable();
    return Buffer.from(bytes.subarray(0, bytesRead));
  } finally {
    bytes?.fill(0);
    await file.close();
  }
}
function selected(env: NodeJS.ProcessEnv, productionEnvPath: string) {
  const workspaceId = env["LUMA_WORKSPACE_ID"];
  if (!workspaceId?.trim()) throw unavailable();
  const enabled = (name: string) => {
    const value = env[name];
    if (value !== undefined && value !== "0" && value !== "1") throw unavailable();
    return value === "1";
  };
  const decision = enabled("LUMA_DISCORD_DECISION_RECORDS_ENABLED"),
    synthesis = enabled("LUMA_MEETING_CAPTURE_SYNTHESIS_ENABLED"),
    granola = enabled("LUMA_GRANOLA_OAUTH_ENABLED"),
    context = enabled("LUMA_ORGANIZATIONAL_CONTEXT_ENABLED"),
    structured = enabled("LUMA_DISCORD_STRUCTURED_WORK_ENABLED");
  for (const key of [
    "LUMA_DECISION_RECORDS_SIGNING_KEY",
    "LUMA_SYNTHESIS_SIGNING_KEY",
    "LUMA_STRUCTURED_WORK_SIGNING_KEY"
  ])
    if (env[key] !== undefined && Buffer.byteLength(env[key]) < 32) throw unavailable();
  if (
    (decision &&
      (Buffer.byteLength(env["LUMA_DECISION_RECORDS_SIGNING_KEY"] ?? "") < 32 ||
        !env[policyKeys["authority-policy"]])) ||
    (synthesis && Buffer.byteLength(env["LUMA_SYNTHESIS_SIGNING_KEY"] ?? "") < 32) ||
    (structured &&
      (Buffer.byteLength(env["LUMA_STRUCTURED_WORK_SIGNING_KEY"] ?? "") < 32 ||
        !env[policyKeys["structured-work-targets"]])) ||
    ((decision || synthesis || context || structured) &&
      !env[policyKeys["sharing-policy"]]) ||
    (granola && !env[policyKeys["granola-key"]])
  )
    throw unavailable();
  const result: Array<{ role: Role; originalPath: string }> = [
    { role: "production-environment", originalPath: productionEnvPath }
  ];
  for (const [kind, key] of Object.entries(policyKeys) as Array<
    [keyof typeof policyKeys, string]
  >) {
    const path = env[key];
    if (path !== undefined) {
      if (!isAbsolute(path)) throw unavailable();
      result.push({ role: kind, originalPath: path });
    }
  }
  if (new Set(result.map((file) => file.originalPath)).size !== result.length)
    throw unavailable();
  return { workspaceId, files: result };
}
function validateContent(kind: Role, bytes: Buffer, workspaceId: string): void {
  if (kind === "granola-key" && bytes.length !== 32) throw unavailable();
  if (
    kind === "sharing-policy" ||
    kind === "authority-policy" ||
    kind === "structured-work-targets"
  ) {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      !("workspaceId" in value) ||
      value.workspaceId !== workspaceId
    )
      throw unavailable();
  }
}
async function authenticationTag(
  secret: Uint8Array,
  manifest: RuntimeRecoveryManifest
): Promise<Buffer> {
  if (!secret.length || secret.length > 65_536) throw unavailable();
  // A memory-hard derivation avoids exposing a cheap password-guessing oracle in a local manifest.
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      secret,
      Buffer.from(manifest.authentication.salt, "hex"),
      32,
      { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, result) => (error ? reject(unavailable()) : resolve(result))
    );
  });
  try {
    return createHmac("sha256", key)
      .update("luma-runtime-recovery-v1\n")
      .update(JSON.stringify(payload(manifest)))
      .digest();
  } finally {
    key.fill(0);
  }
}
/** Offline operations preflight; validates local inputs without opening persistence. */
export async function validateRuntimeRecoveryInputs(
  productionEnvPath: string,
  sourceOwnerUid?: number
): Promise<void> {
  let environment: Buffer | undefined;
  try {
    environment = await privateFile(productionEnvPath);
    const selection = selected(
      parseProductionEnvironmentFile(environment.toString("utf8")),
      productionEnvPath
    );
    for (const file of selection.files.slice(1)) {
      const bytes = await privateFile(file.originalPath, file.role, sourceOwnerUid);
      try {
        validateContent(file.role, bytes, selection.workspaceId);
      } finally {
        bytes.fill(0);
      }
    }
  } catch {
    throw unavailable();
  } finally {
    environment?.fill(0);
  }
}
/** Cold-copy companion only: this never opens the live database or changes source files. */
export async function captureRuntimeRecoveryMaterial(
  input: ProofInput & {
    productionEnvPath: string;
    /** Fixed production service account, resolved by the operations host adapter. */
    sourceOwnerUid?: number;
  }
): Promise<RuntimeRecoveryManifest> {
  const originals: Array<{ role: Role; originalPath: string; bytes: Buffer }> = [];
  try {
    z.string().uuid().parse(input.backupId);
    await privateDirectory(input.directory);
    const environment = await privateFile(input.productionEnvPath);
    originals.push({
      role: "production-environment",
      originalPath: input.productionEnvPath,
      bytes: environment
    });
    const selection = selected(
      parseProductionEnvironmentFile(environment.toString("utf8")),
      input.productionEnvPath
    );
    for (const file of selection.files.slice(1))
      originals.push({
        ...file,
        bytes: await privateFile(file.originalPath, file.role, input.sourceOwnerUid)
      });
    for (const file of originals)
      validateContent(file.role, file.bytes, selection.workspaceId);
    const manifest: RuntimeRecoveryManifest = {
      format: "luma-runtime-recovery-v1",
      backupId: input.backupId,
      workspaceId: selection.workspaceId,
      files: originals.map((file) => ({
        role: file.role,
        originalPath: file.originalPath,
        bytes: file.bytes.length,
        sha256: hash(file.bytes)
      })),
      authentication: {
        algorithm: "scrypt-hmac-sha256-v1",
        salt: randomBytes(32).toString("hex"),
        tag: "0".repeat(64)
      }
    };
    manifest.authentication.tag = (
      await authenticationTag(input.authenticationSecret, manifest)
    ).toString("hex");
    const directory = join(input.directory, "recovery");
    await mkdir(directory, { mode: 0o700 });
    for (const file of originals)
      await writeFile(join(directory, names[file.role]), file.bytes, {
        flag: "wx",
        mode: 0o600
      });
    // Recheck the whole selected original set after writing. Partial or moving sets cannot become success.
    for (const file of originals) {
      const current = await privateFile(
        file.originalPath,
        file.role,
        input.sourceOwnerUid
      );
      try {
        if (!current.equals(file.bytes)) throw unavailable();
      } finally {
        current.fill(0);
      }
    }
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest) + "\n", {
      flag: "wx",
      mode: 0o600
    });
    await verifyRuntimeRecoveryMaterial({ ...input, expected: manifest });
    return manifest;
  } catch {
    throw unavailable();
  } finally {
    for (const file of originals) file.bytes.fill(0);
  }
}
/** Verify local and exact-downloaded bundles against independently held repository authentication. */
export async function verifyRuntimeRecoveryMaterial(
  input: ProofInput & {
    expected?: RuntimeRecoveryManifest;
  }
): Promise<RuntimeRecoveryManifest> {
  try {
    const directory = join(input.directory, "recovery");
    await privateDirectory(input.directory);
    await privateDirectory(directory);
    const manifestBytes = await privateFile(join(directory, "manifest.json"));
    let manifest: RuntimeRecoveryManifest;
    try {
      manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
    } finally {
      manifestBytes.fill(0);
    }
    const tag = await authenticationTag(input.authenticationSecret, manifest);
    try {
      if (!timingSafeEqual(tag, Buffer.from(manifest.authentication.tag, "hex")))
        throw unavailable();
    } finally {
      tag.fill(0);
    }
    if (
      manifest.backupId !== input.backupId ||
      new Set(manifest.files.map((file) => file.role)).size !== manifest.files.length ||
      (input.expected && JSON.stringify(manifest) !== JSON.stringify(input.expected))
    )
      throw unavailable();
    const actual = (await readdir(directory)).sort();
    if (
      JSON.stringify(actual) !==
      JSON.stringify(
        ["manifest.json", ...manifest.files.map((file) => names[file.role])].sort()
      )
    )
      throw unavailable();
    let environment: NodeJS.ProcessEnv | undefined;
    for (const file of manifest.files) {
      const bytes = await privateFile(join(directory, names[file.role]));
      try {
        if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
          throw unavailable();
        validateContent(file.role, bytes, manifest.workspaceId);
        if (file.role === "production-environment")
          environment = parseProductionEnvironmentFile(bytes.toString("utf8"));
      } finally {
        bytes.fill(0);
      }
    }
    const production = manifest.files.find(
      (file) => file.role === "production-environment"
    );
    if (!environment || !production) throw unavailable();
    const selection = selected(environment, production.originalPath);
    if (
      selection.workspaceId !== manifest.workspaceId ||
      JSON.stringify(selection.files) !==
        JSON.stringify(
          manifest.files.map(({ role, originalPath }) => ({ role, originalPath }))
        )
    )
      throw unavailable();
    return manifest;
  } catch {
    throw unavailable();
  }
}
async function hasRetainedRows(database: LumaDatabase, table: string): Promise<boolean> {
  const exists = (
    await database.query<{ table_name: string | null }>(
      "SELECT to_regclass($1)::text AS table_name",
      [`public.${table}`]
    )
  ).rows[0]?.table_name;
  return (
    !!exists &&
    (
      await database.query<{ present: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM ${table}) AS present`
      )
    ).rows[0]?.present === true
  );
}
/** Quarantined, local read only: no migrations, account activation, token refresh, source or model calls. */
export async function verifyRestoredRuntimeRecovery(
  input: ProofInput & {
    restoreDir: string;
    expected?: RuntimeRecoveryManifest;
  }
): Promise<{ granolaConnections: number }> {
  let key: Buffer | undefined;
  try {
    const manifest = await verifyRuntimeRecoveryMaterial(input);
    const environment = await privateFile(
      join(input.directory, "recovery", names["production-environment"])
    );
    let env: NodeJS.ProcessEnv;
    try {
      env = parseProductionEnvironmentFile(environment.toString("utf8"));
    } finally {
      environment.fill(0);
    }
    if (manifest.files.some((file) => file.role === "granola-key"))
      key = await privateFile(join(input.directory, "recovery", names["granola-key"]));
    // Establish this backup's quarantine before acquiring any store lease.
    await privateDirectory(input.restoreDir);
    const quarantine = await privateFile(join(input.restoreDir, RESTORE_QUARANTINE_FILE));
    try {
      const marker = z
        .object({
          format: z.literal("luma-isolated-restore-v1"),
          backupId: z.string().uuid(),
          applicationRevision: z.string().regex(/^[a-f0-9]{40}$/u)
        })
        .strict()
        .parse(JSON.parse(quarantine.toString("utf8")));
      if (marker.backupId !== input.backupId) throw unavailable();
    } finally {
      quarantine.fill(0);
    }
    const database = await openOwnedPgliteDatabase(
      input.restoreDir,
      "isolated-restore-verification"
    );
    let granolaConnections: number;
    try {
      if (
        (await hasRetainedRows(database, "decision_write_stages")) &&
        (Buffer.byteLength(env["LUMA_DECISION_RECORDS_SIGNING_KEY"] ?? "") < 32 ||
          !env[policyKeys["authority-policy"]] ||
          !env[policyKeys["sharing-policy"]])
      )
        throw unavailable();
      if (
        (await hasRetainedRows(database, "meeting_synthesis_publications")) &&
        (Buffer.byteLength(env["LUMA_SYNTHESIS_SIGNING_KEY"] ?? "") < 32 ||
          !env[policyKeys["sharing-policy"]])
      )
        throw unavailable();
      if (
        (await hasRetainedRows(database, "structured_work_requests")) &&
        (Buffer.byteLength(env["LUMA_STRUCTURED_WORK_SIGNING_KEY"] ?? "") < 32 ||
          !env[policyKeys["structured-work-targets"]] ||
          !env[policyKeys["sharing-policy"]])
      )
        throw unavailable();
      granolaConnections = await verifyGranolaOAuthRecovery({
        database,
        workspaceId: manifest.workspaceId,
        ...(key ? { encryptionKey: key } : {})
      });
    } finally {
      await database.close();
    }
    await verifyRuntimeRecoveryMaterial({ ...input, expected: manifest });
    return { granolaConnections };
  } catch {
    throw unavailable();
  } finally {
    key?.fill(0);
  }
}
