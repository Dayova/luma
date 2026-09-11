import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureRuntimeRecoveryMaterial,
  validateRuntimeRecoveryInputs,
  verifyRuntimeRecoveryMaterial,
  verifyRestoredRuntimeRecovery
} from "../../src/operations/runtime-recovery-material.js";
import {
  createFullStoreBackup,
  restoreFullStoreBackup
} from "../../src/persistence/full-store-backup.js";
import {
  CLEAN_CLOSE_FILE,
  openOwnedPgliteDatabase
} from "../../src/persistence/store-ownership.js";
import { createGranolaOAuthStore } from "../../src/granola/oauth-store.js";
import { recoveryMaterialFixture } from "./recovery-material-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "luma-recovery-material-")));
  roots.push(root);
  const directory = join(root, "cold");
  await mkdir(directory, { mode: 0o700 });
  return {
    root,
    directory,
    backupId: String(randomUUID()),
    ...(await recoveryMaterialFixture(root))
  };
}
describe("authenticated runtime recovery material", () => {
  it("retains exact runtime secrets, selected policies and a separate key in private files bound to the backup", async () => {
    const f = await fixture();
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Network forbidden"));
    await validateRuntimeRecoveryInputs(f.productionEnvPath);
    const original = await captureRuntimeRecoveryMaterial(f);
    expect(original.files.map((file) => file.role)).toEqual([
      "production-environment",
      "sharing-policy",
      "authority-policy",
      "granola-key",
      "structured-work-targets"
    ]);
    expect(await readFile(join(f.directory, "recovery", "production.env"), "utf8")).toBe(
      f.environment
    );
    expect(await readFile(join(f.directory, "recovery", "granola.key"))).toEqual(f.key);
    expect((await lstat(join(f.directory, "recovery"))).mode & 0o777).toBe(0o700);
    for (const file of await readdir(join(f.directory, "recovery")))
      expect((await lstat(join(f.directory, "recovery", file))).mode & 0o777).toBe(0o600);
    expect(await verifyRuntimeRecoveryMaterial({ ...f, expected: original })).toEqual(
      original
    );
    expect(JSON.stringify(original)).not.toContain("private-bot-token");
    expect(JSON.stringify(original)).not.toContain(f.key.toString("base64"));
    expect(network).not.toHaveBeenCalled();
  });
  it("verifies an authenticated recovery bundle after the original host files are unavailable", async () => {
    const f = await fixture();
    const expected = await captureRuntimeRecoveryMaterial(f);
    for (const path of [
      f.productionEnvPath,
      f.keyPath,
      f.authorityPath,
      f.sharingPath,
      f.structuredPath
    ])
      await rm(path);
    expect(await verifyRuntimeRecoveryMaterial({ ...f, expected })).toEqual(expected);
  });
  it("preserves supported read-only key and protected sharing-policy inputs while making their copies private", async () => {
    const f = await fixture();
    await chmod(f.keyPath, 0o400);
    await chmod(f.sharingPath, 0o644);
    await chmod(f.structuredPath, 0o644);
    await captureRuntimeRecoveryMaterial(f);
    expect((await lstat(f.keyPath)).mode & 0o777).toBe(0o400);
    expect((await lstat(f.sharingPath)).mode & 0o777).toBe(0o644);
    for (const name of [
      "granola.key",
      "sharing-policy.json",
      "structured-work-targets.json"
    ])
      expect((await lstat(join(f.directory, "recovery", name))).mode & 0o777).toBe(0o600);
  });
  it("refuses a non-quarantined directory before touching its ownership metadata", async () => {
    const f = await fixture();
    await captureRuntimeRecoveryMaterial(f);
    const liveDirectory = join(f.root, "original-store");
    await mkdir(liveDirectory, { mode: 0o700 });
    await writeFile(join(liveDirectory, "original-bytes"), "unchanged", { mode: 0o600 });
    const before = await readdir(f.root);
    await expect(
      verifyRestoredRuntimeRecovery({ ...f, restoreDir: liveDirectory })
    ).rejects.toThrow("Runtime recovery material");
    expect(await readdir(f.root)).toEqual(before);
    expect(await readdir(liveDirectory)).toEqual(["original-bytes"]);
    expect(await readFile(join(liveDirectory, "original-bytes"), "utf8")).toBe(
      "unchanged"
    );
  });
  it.each([
    "granola.key",
    "production.env",
    "authority-policy.json",
    "sharing-policy.json",
    "structured-work-targets.json"
  ])("rejects an omitted or altered %s from the captured bundle", async (name) => {
    const f = await fixture();
    await captureRuntimeRecoveryMaterial(f);
    const path = join(f.directory, "recovery", name),
      original = await readFile(path);
    await writeFile(path, Buffer.from("altered material"));
    await expect(verifyRuntimeRecoveryMaterial(f)).rejects.toThrow(
      "Runtime recovery material"
    );
    await writeFile(path, original);
    await rm(path);
    await expect(verifyRuntimeRecoveryMaterial(f)).rejects.toThrow(
      "Runtime recovery material"
    );
  });
  it.each(["wrong-password", "wrong-backup", "changed-manifest", "extra-file"])(
    "rejects %s without exposing source bytes",
    async (change) => {
      const f = await fixture();
      await captureRuntimeRecoveryMaterial(f);
      if (change === "wrong-password") f.authenticationSecret = Buffer.alloc(48, 1);
      if (change === "wrong-backup") f.backupId = randomUUID();
      if (change === "changed-manifest") {
        const path = join(f.directory, "recovery", "manifest.json");
        const raw = await readFile(path, "utf8");
        await writeFile(
          path,
          raw.replace('"workspaceId":"dayova"', '"workspaceId":"another"')
        );
      }
      if (change === "extra-file")
        await writeFile(join(f.directory, "recovery", "unexpected-secret"), "secret", {
          mode: 0o600
        });
      const message = await verifyRuntimeRecoveryMaterial(f).then(
        () => "",
        (error: unknown) => (error instanceof Error ? error.message : "not-an-error")
      );
      expect(message).toContain("Runtime recovery material");
      expect(message).not.toMatch(
        /private-bot-token|private-ai-token|decision-secret|credential\.key/u
      );
    }
  );
  it.each([
    "symlink",
    "hard-link",
    "public-file",
    "short-key",
    "long-key",
    "missing-policy"
  ])("refuses %s before reporting recovery capture success", async (change) => {
    const f = await fixture();
    if (change === "symlink") {
      await rm(f.keyPath);
      await symlink(f.sharingPath, f.keyPath);
    }
    if (change === "hard-link") {
      await link(f.keyPath, join(f.root, "another-key"));
    }
    if (change === "public-file") await chmod(f.keyPath, 0o644);
    if (change === "short-key") await writeFile(f.keyPath, Buffer.alloc(31));
    if (change === "long-key") await writeFile(f.keyPath, Buffer.alloc(33));
    if (change === "missing-policy") await rm(f.authorityPath);
    await expect(validateRuntimeRecoveryInputs(f.productionEnvPath)).rejects.toThrow(
      "Runtime recovery material"
    );
    await expect(captureRuntimeRecoveryMaterial(f)).rejects.toThrow(
      "Runtime recovery material"
    );
  });
  it("refuses enabled capabilities whose signing key or referenced material was omitted", async () => {
    const f = await fixture();
    for (const environment of [
      "LUMA_WORKSPACE_ID=dayova\nLUMA_GRANOLA_OAUTH_ENABLED=1\n",
      "LUMA_WORKSPACE_ID=dayova\nLUMA_DISCORD_DECISION_RECORDS_ENABLED=1\n",
      "LUMA_WORKSPACE_ID=dayova\nLUMA_MEETING_CAPTURE_SYNTHESIS_ENABLED=1\n",
      "LUMA_WORKSPACE_ID=dayova\nLUMA_DISCORD_STRUCTURED_WORK_ENABLED=1\n"
    ]) {
      await writeFile(f.productionEnvPath, environment);
      await expect(validateRuntimeRecoveryInputs(f.productionEnvPath)).rejects.toThrow(
        "Runtime recovery material"
      );
    }
  });
  it.each(["missing", "wrong-workspace", "writable"])(
    "refuses %s Structured Work mapping inputs",
    async (mode) => {
      const f = await fixture();
      if (mode === "missing") await rm(f.structuredPath);
      if (mode === "wrong-workspace")
        await writeFile(
          f.structuredPath,
          JSON.stringify({ version: 1, workspaceId: "another", targets: [] })
        );
      if (mode === "writable") await chmod(f.structuredPath, 0o666);
      await expect(validateRuntimeRecoveryInputs(f.productionEnvPath)).rejects.toThrow(
        "Runtime recovery material"
      );
      await expect(captureRuntimeRecoveryMaterial(f)).rejects.toThrow(
        "Runtime recovery material"
      );
    }
  );
  it("refuses an original policy that changes while the private bundle is being captured", async () => {
    const f = await fixture();
    let changes = 0;
    // Real concurrent source editing continues across the asynchronous authentication
    // and copy work; no helper call order or fake file result is asserted.
    const changing = setInterval(() => {
      writeFileSync(
        f.authorityPath,
        JSON.stringify({ workspaceId: "dayova", revision: ++changes })
      );
    }, 5);
    try {
      await expect(captureRuntimeRecoveryMaterial(f)).rejects.toThrow(
        "Runtime recovery material"
      );
      expect(changes).toBeGreaterThan(0);
    } finally {
      clearInterval(changing);
    }
  });
});

describe("isolated Granola credential recovery", () => {
  it.each([
    "valid",
    "missing-key",
    "wrong-key",
    "corrupt-row",
    "foreign-workspace",
    "retained-signing-key",
    "retained-structured-key",
    "retained-structured-targets"
  ])(
    "verifies %s using only the restored store and authenticated material",
    async (mode) => {
      const f = await fixture();
      const source = join(f.root, "store");
      const database = await openOwnedPgliteDatabase(source, "runtime");
      const store = await createGranolaOAuthStore({
        database,
        workspaceId: mode === "foreign-workspace" ? "another" : "dayova",
        encryptionKey: f.key
      });
      await store.update("person_jakob", () => ({
        ownerPersonId: "person_jakob",
        connectionId: "synthetic-connection",
        phase: "connected",
        clientId: "synthetic-client",
        attempt: null,
        tokens: {
          accessToken: "synthetic-access-secret",
          refreshToken: "synthetic-refresh-secret",
          expiresAt: "2027-01-01T00:00:00Z"
        },
        policy: null,
        lastFailure: null
      }));
      if (mode === "corrupt-row")
        await database.exec("UPDATE granola_oauth_connections SET ciphertext='corrupt'");
      if (mode === "retained-signing-key")
        await database.exec(
          "CREATE TABLE decision_write_stages(id text); INSERT INTO decision_write_stages VALUES ('retained')"
        );
      if (mode.startsWith("retained-structured"))
        await database.exec(
          "CREATE TABLE structured_work_requests(id text); INSERT INTO structured_work_requests VALUES ('retained')"
        );
      await database.close();
      await rm(f.directory, { recursive: true });
      const manifest = await createFullStoreBackup({
        dataDir: source,
        backupDir: f.directory,
        applicationRevision: "a".repeat(40)
      });
      f.backupId = manifest.backupId;
      if (mode === "missing-key")
        await writeFile(
          f.productionEnvPath,
          f.environment
            .split("\n")
            .filter((line) => !line.startsWith("LUMA_GRANOLA_CREDENTIAL_KEY_PATH="))
            .join("\n")
        );
      if (mode === "wrong-key") await writeFile(f.keyPath, Buffer.alloc(32, 1));
      if (mode === "retained-signing-key")
        await writeFile(
          f.productionEnvPath,
          f.environment
            .split("\n")
            .filter((line) => !line.startsWith("LUMA_DECISION_RECORDS_SIGNING_KEY="))
            .join("\n")
        );
      if (mode.startsWith("retained-structured"))
        await writeFile(
          f.productionEnvPath,
          f.environment
            .split("\n")
            .filter(
              (line) =>
                !line.startsWith(
                  mode === "retained-structured-key"
                    ? "LUMA_STRUCTURED_WORK_SIGNING_KEY="
                    : "LUMA_STRUCTURED_WORK_TARGETS_PATH="
                )
            )
            .join("\n")
        );
      const expected = await captureRuntimeRecoveryMaterial(f);
      const restoreDir = join(f.root, "rehearsal");
      await restoreFullStoreBackup({ backupDir: f.directory, restoreDir });
      const originalCloseReceipt = await readFile(join(source, CLEAN_CLOSE_FILE));
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Network forbidden"));
      if (mode === "valid")
        expect(
          await verifyRestoredRuntimeRecovery({ ...f, restoreDir, expected })
        ).toEqual({ granolaConnections: 1 });
      else
        await expect(
          verifyRestoredRuntimeRecovery({ ...f, restoreDir, expected })
        ).rejects.toThrow("Runtime recovery material");
      expect(network).not.toHaveBeenCalled();
      await expect(openOwnedPgliteDatabase(restoreDir, "runtime")).rejects.toThrow(
        "quarantined"
      );
      expect((await lstat(source)).isDirectory()).toBe(true);
      expect(await readFile(join(source, CLEAN_CLOSE_FILE))).toEqual(
        originalCloseReceipt
      );
      expect(await readdir(f.root)).not.toContain("store.luma-owner");
    },
    20_000
  );
});
