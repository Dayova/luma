import { mkdtemp, writeFile, chmod, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createContextSharingPolicy,
  type ContextSharingPolicyDocument
} from "../../src/app/context-sharing-policy.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "luma-context-policy-"));
  directories.push(directory);
  const path = join(directory, "sharing.json");
  const document: ContextSharingPolicyDocument = {
    version: 1,
    workspaceId: "dayova",
    grants: [
      {
        provider: "github-code",
        credentialScopeId: "reader-1",
        resources: ["Dayova/luma"],
        personIds: [...dayovaFounderPersonIds]
      }
    ]
  };
  await writeFile(path, JSON.stringify(document), { mode: 0o600 });
  const policy = createContextSharingPolicy({ path, workspaceId: "dayova" });
  const request = {
    audience: { workspaceId: "dayova", personIds: [...dayovaFounderPersonIds] },
    provider: "github-code" as const,
    credentialScopeId: "reader-1",
    resource: "Dayova/luma"
  };
  return { path, document, policy, request, directory };
}
describe("live explicit organizational sharing policy", () => {
  it("authorizes only the exact workspace, credential, source and full recipient audience", async () => {
    const { policy, request } = await setup();
    await policy.validate();
    expect(await policy.authorize(request)).toBe(true);
    expect(await policy.authorize({ ...request, resource: "Dayova/private" })).toBe(
      false
    );
    expect(
      await policy.authorize({ ...request, credentialScopeId: "other-reader" })
    ).toBe(false);
    expect(
      await policy.authorize({
        ...request,
        audience: { ...request.audience, workspaceId: "other" }
      })
    ).toBe(false);
    expect(
      await policy.authorize({
        ...request,
        audience: { ...request.audience, personIds: ["guest"] }
      })
    ).toBe(false);
  });
  it("takes revocation and narrower recipient grants into account without restarting", async () => {
    const { path, document, policy, request } = await setup();
    expect(await policy.authorize(request)).toBe(true);
    document.grants[0]!.personIds = ["person_jakob"];
    await writeFile(path, JSON.stringify(document));
    expect(await policy.authorize(request)).toBe(false);
    expect(
      await policy.authorize({
        ...request,
        audience: { ...request.audience, personIds: ["person_jakob"] }
      })
    ).toBe(true);
    document.grants = [];
    await writeFile(path, JSON.stringify(document));
    expect(await policy.authorize(request)).toBe(false);
  });
  it("fails closed on a missing, writable or malformed policy without exposing its contents", async () => {
    const { path, policy, request } = await setup();
    await chmod(path, 0o666);
    expect(await policy.authorize(request)).toBe(false);
    await expect(policy.validate()).rejects.toThrow("protected sharing-policy");
    await chmod(path, 0o600);
    await writeFile(path, "SECRET");
    await expect(policy.validate()).rejects.not.toThrow("SECRET");
    expect(await policy.authorize(request)).toBe(false);
    await rm(path);
    expect(await policy.authorize(request)).toBe(false);
  });
  it("rejects a symlinked policy", async () => {
    const { directory, path, request } = await setup();
    const link = join(directory, "link.json");
    await symlink(path, link);
    expect(
      await createContextSharingPolicy({ path: link, workspaceId: "dayova" }).authorize(
        request
      )
    ).toBe(false);
  });
});
