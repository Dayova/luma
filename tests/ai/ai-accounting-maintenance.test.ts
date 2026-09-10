import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accountingOperatorFromPolicy,
  readAccountingInput,
  runAiAccountingMaintenance
} from "../../src/app/ai-accounting-maintenance.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import {
  CLEAN_CLOSE_FILE,
  openOwnedPgliteDatabase,
  RESTORE_QUARANTINE_FILE
} from "../../src/persistence/store-ownership.js";

describe("private stopped-store accounting maintenance", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "luma-accounting-cli-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("authorizes exactly one founder bound to the real local UID", () => {
    const policy = { operators: [{ localUid: 1001, personId: "person_jakob" }] };
    expect(accountingOperatorFromPolicy(policy, 1001)).toEqual(policy.operators[0]);
    expect(() => accountingOperatorFromPolicy(policy, 1002)).toThrow(
      "operator-not-authorized"
    );
    expect(() =>
      accountingOperatorFromPolicy(
        { operators: [...policy.operators, ...policy.operators] },
        1001
      )
    ).toThrow("operator-not-authorized");
    expect(() =>
      accountingOperatorFromPolicy(
        { operators: [{ localUid: 1001, personId: "guest" }] },
        1001
      )
    ).toThrow();
  });

  it("reads only private files owned by the expected Unix account", async () => {
    const path = join(root, "input.json");
    const uid = process.geteuid!();
    await writeFile(path, JSON.stringify({ workspaceId: "dayova" }), { mode: 0o600 });
    expect(await readAccountingInput(path, uid)).toEqual({ workspaceId: "dayova" });
    await expect(readAccountingInput(path, uid + 1)).rejects.toThrow(
      "private-owned-input-required"
    );
    await chmod(path, 0o644);
    await expect(readAccountingInput(path, uid)).rejects.toThrow(
      "private-owned-input-required"
    );
    await chmod(path, 0o600);
    await symlink(path, join(root, "alias.json"));
    await expect(readAccountingInput(join(root, "alias.json"), uid)).rejects.toThrow();
    await link(path, join(root, "shared.json"));
    await expect(readAccountingInput(path, uid)).rejects.toThrow(
      "private-owned-input-required"
    );
    await expect(readAccountingInput("relative.json", uid)).rejects.toThrow(
      "absolute-input-path-required"
    );
  });

  it("requires an existing cleanly stopped owner and refuses quarantined recovery stores", async () => {
    const store = join(root, "store");
    const active = await createPgliteDatabase(store);
    await expect(
      openOwnedPgliteDatabase(store, "accounting-maintenance")
    ).rejects.toThrow("Store is owned");
    await active.close();
    const stopped = await openOwnedPgliteDatabase(store, "accounting-maintenance");
    await stopped.close();
    await rm(join(store, CLEAN_CLOSE_FILE));
    await expect(
      openOwnedPgliteDatabase(store, "accounting-maintenance")
    ).rejects.toThrow();
    await writeFile(join(store, RESTORE_QUARANTINE_FILE), "{}");
    await expect(
      openOwnedPgliteDatabase(store, "accounting-maintenance")
    ).rejects.toThrow("quarantined");
  });

  it("rejects missing stores and output inside the datastore before opening it", async () => {
    const missing = join(root, "missing");
    await expect(
      runAiAccountingMaintenance([
        "inspect",
        missing,
        join(root, "policy"),
        join(root, "input"),
        join(root, "out")
      ])
    ).rejects.toThrow();
    const store = join(root, "store");
    const active = await createPgliteDatabase(store);
    await active.close();
    await expect(
      runAiAccountingMaintenance([
        "inspect",
        store,
        join(root, "policy"),
        join(root, "input"),
        join(store, "out")
      ])
    ).rejects.toThrow("output-must-be-outside-store");
  });
});
