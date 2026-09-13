import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createStructuredWorkSharingAccess } from "../../src/app/structured-work-sharing.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";

it("rechecks exact protected Linear team/scope sharing without deriving it from service access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luma-structured-sharing-"));
  const path = join(directory, "sharing.json");
  try {
    const policy = {
      version: 1,
      workspaceId: "dayova",
      grants: [
        {
          provider: "linear",
          credentialScopeId: "structured-work",
          resources: ["team"],
          personIds: [...dayovaFounderPersonIds]
        }
      ]
    };
    await writeFile(path, JSON.stringify(policy), { mode: 0o600 });
    const access = await createStructuredWorkSharingAccess({
      workspaceId: "dayova",
      policyPath: path,
      credentialScopeId: "structured-work",
      teamId: "team"
    });
    const audience = { workspaceId: "dayova", personIds: [...dayovaFounderPersonIds] };
    expect(await access.authorize(audience)).toBe(true);
    expect(
      await access.authorize({ ...audience, personIds: [...audience.personIds, "guest"] })
    ).toBe(false);
    policy.grants[0]!.resources = ["another-team"];
    await writeFile(path, JSON.stringify(policy));
    expect(await access.authorize(audience)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
