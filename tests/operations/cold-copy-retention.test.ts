import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pruneOldColdCopies } from "../../src/operations/cold-copy-retention.js";

describe("failed cold-copy retention", () => {
  it("bounds repeated failures while retaining the newest attempt and unrelated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "luma-cold-retention-"));
    const managed = (index: number) =>
      `cold-00000000-0000-0000-0000-${String(index).padStart(12, "0")}`;
    try {
      await mkdir(join(root, "manual-backup"));
      await mkdir(join(root, "cold-inspection"));
      await writeFile(join(root, "manual-backup", "keep"), "retained");
      await symlink(join(root, "manual-backup"), join(root, managed(90)));
      await writeFile(join(root, managed(91)), "not a directory");
      for (const index of [1, 2, 3]) {
        const path = join(root, managed(index));
        await mkdir(path);
        await writeFile(join(path, "failure"), String(index));
        await utimes(path, index, index);
      }
      await pruneOldColdCopies(root);
      expect((await readdir(root)).sort()).toEqual(
        ["manual-backup", "cold-inspection", managed(3), managed(90), managed(91)].sort()
      );
      expect(await readFile(join(root, "manual-backup", "keep"), "utf8")).toBe(
        "retained"
      );
      expect(await readFile(join(root, managed(3), "failure"), "utf8")).toBe("3");
      await mkdir(join(root, managed(4)));
      await utimes(join(root, managed(4)), 4, 4);
      await pruneOldColdCopies(root);
      expect((await readdir(root)).sort()).toEqual(
        ["manual-backup", "cold-inspection", managed(4), managed(90), managed(91)].sort()
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
