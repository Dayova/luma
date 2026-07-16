import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPgliteDatabase } from "../../src/persistence/db.js";

describe("PGlite persistence", () => {
  it("creates missing parent directories for a durable database path", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "luma-pglite-"));
    const dataDir = join(temporaryRoot, "missing-parent", "pglite");

    try {
      const database = await createPgliteDatabase(dataDir);

      await expect(database.query("SELECT 1 AS ready")).resolves.toMatchObject({
        rows: [{ ready: 1 }]
      });
      await database.close();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
