import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createGranolaPolicy } from "../../src/granola/policy.js";
const document = {
  version: 1,
  workspaceId: "dayova",
  connections: [
    {
      connectionId: "jakob",
      ownerPersonId: "person_jakob",
      optInId: "owner-attestation",
      accountFingerprint: `sha256:${"1".repeat(64)}`,
      enabled: true,
      audiencePersonIds: ["person_jakob"],
      includedMeetingIds: [] as string[],
      excludedMeetingIds: [] as string[]
    }
  ]
};
describe("Granola per-user opt-in policy", () => {
  it("defaults to no automatic import and rereads current exclusions without widening recipients", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luma-granola-policy-"));
    const path = join(directory, "policy.json");
    try {
      await writeFile(path, JSON.stringify(document), { mode: 0o600 });
      const policy = createGranolaPolicy({ path, workspaceId: "dayova" });
      expect(await policy.read("jakob")).toMatchObject({
        automaticInternalMeetings: false,
        includedMeetingIds: []
      });
      const changed = structuredClone(document);
      changed.connections[0]!.excludedMeetingIds = ["private"];
      await writeFile(path, JSON.stringify(changed));
      expect((await policy.read("jakob")).excludedMeetingIds).toEqual(["private"]);
      await expect(policy.read("fabius")).rejects.toThrow("policy-withheld");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("refuses writable, symlinked, cross-workspace and non-founder policy grants", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luma-granola-policy-"));
    const path = join(directory, "policy.json");
    try {
      await writeFile(path, JSON.stringify(document), { mode: 0o666 });
      const { chmod } = await import("node:fs/promises");
      await chmod(path, 0o666);
      await expect(
        createGranolaPolicy({ path, workspaceId: "dayova" }).read("jakob")
      ).rejects.toThrow();
      await chmod(path, 0o600);
      const link = join(directory, "link.json");
      await symlink(path, link);
      await expect(
        createGranolaPolicy({ path: link, workspaceId: "dayova" }).read("jakob")
      ).rejects.toThrow();
      await expect(
        createGranolaPolicy({ path, workspaceId: "other" }).read("jakob")
      ).rejects.toThrow();
      await writeFile(
        path,
        JSON.stringify({
          ...document,
          connections: [{ ...document.connections[0], audiencePersonIds: ["guest"] }]
        })
      );
      await expect(
        createGranolaPolicy({ path, workspaceId: "dayova" }).read("jakob")
      ).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
