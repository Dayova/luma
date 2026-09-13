import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createLocalIntegrations } from "../../src/local-sandbox/integrations.js";
import { createContextSharingPolicy } from "../../src/app/context-sharing-policy.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";

const token = "dedicated-read-credential-12345";
const writeToken = "dedicated-write-credential-12345";
const teamId = "12345678-1234-4234-8234-123456789abc";

it("loads production catalogs with scoped founder sharing, revokes old scopes, and never persists credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luma-integrations-"));
  const connections = createLocalIntegrations({ directory });
  try {
    await connections.configure({ provider: "linear", token, teamId, writeToken });
    const env = connections.environment();
    expect(await connections.catalogs()).toHaveLength(1);
    expect(env["LINEAR_API_KEY"]).toBeUndefined();
    const policy = createContextSharingPolicy({
      path: env["LUMA_CONTEXT_SHARING_POLICY_PATH"]!,
      workspaceId: "luma-local-ai"
    });
    const request = {
      audience: { workspaceId: "luma-local-ai", personIds: [...dayovaFounderPersonIds] },
      provider: "linear" as const,
      credentialScopeId: env["LUMA_CONTEXT_LINEAR_CREDENTIAL_SCOPE_ID"]!,
      resource: teamId
    };
    expect(await policy.authorize(request)).toBe(true);
    expect(
      await policy.authorize({
        ...request,
        audience: { ...request.audience, personIds: ["guest"] }
      })
    ).toBe(false);
    expect(await policy.authorize({ ...request, resource: "another-team" })).toBe(false);
    const contents = await readFile(env["LUMA_CONTEXT_SHARING_POLICY_PATH"]!, "utf8");
    expect(contents).not.toContain(token);
    expect(contents).not.toContain(writeToken);
    expect((await stat(env["LUMA_CONTEXT_SHARING_POLICY_PATH"]!)).mode & 0o777).toBe(
      0o600
    );
    expect(JSON.stringify(connections.status())).not.toContain(token);
    connections.setWrites(true);
    expect(connections.environment()["LINEAR_API_KEY"]).toBe(writeToken);
    expect(connections.environment()["LUMA_CONTEXT_LINEAR_READONLY_API_KEY"]).toBe(token);
    await connections.remove("linear");
    expect(await policy.authorize(request)).toBe(false);
    expect(connections.environment()).toEqual({});
    expect(connections.status().writesEnabled).toBe(false);
  } finally {
    await connections.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("validates separate write configuration and constructs Notion and GitHub production readers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luma-integrations-"));
  const connections = createLocalIntegrations({ directory });
  try {
    expect(() => connections.setWrites(true)).toThrow("separate write");
    await expect(
      connections.configure({ provider: "linear", token, teamId, writeToken: token })
    ).rejects.toThrow("separate write");
    await expect(
      connections.configure({ provider: "notion", token, pageIds: [teamId], writeToken })
    ).rejects.toThrow("data source");
    await connections.configure({
      provider: "notion",
      token,
      pageIds: [teamId],
      writeToken,
      dataSourceId: teamId
    });
    await connections.configure({
      provider: "github",
      token,
      repositories: ["Dayova/luma"]
    });
    expect((await connections.catalogs()).length).toBeGreaterThanOrEqual(2);
    expect(connections.environment()["NOTION_API_TOKEN"]).toBeUndefined();
    connections.setWrites(true);
    expect(connections.environment()["NOTION_API_TOKEN"]).toBe(writeToken);
    expect(connections.environment()["NOTION_MEETINGS_DATA_SOURCE_ID"]).toBe(teamId);
  } finally {
    await connections.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("only verifies an actual source read and restores a working connection after configuration failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luma-integrations-"));
  let readable = false;
  let failRead = false;
  const connections = createLocalIntegrations({
    directory,
    catalogs: ({ env }) => {
      if (env["LUMA_CONTEXT_LINEAR_READONLY_API_KEY"] === "invalid-replacement-token")
        throw new Error("provider secret");
      return Promise.resolve([
        {
          id: "linear:test",
          search: () =>
            failRead
              ? Promise.reject(new Error("secret provider body"))
              : Promise.resolve({ sourceIds: ["issue"], complete: true, warnings: [] }),
          read: () =>
            Promise.resolve(
              readable
                ? {
                    id: "issue",
                    kind: "work-item",
                    title: "DAY-173",
                    content: "Awaiting confirmation",
                    version: "1",
                    updatedAt: "2026-09-13T10:00:00Z",
                    externalReference: {
                      providerId: "linear",
                      objectType: "work-item",
                      externalId: "DAY-173",
                      url: "https://linear.app/dayova/issue/DAY-173"
                    },
                    standing: "current",
                    authority: "source"
                  }
                : null
            )
        }
      ]);
    }
  });
  try {
    await connections.configure({ provider: "linear", token, teamId });
    expect(connections.status().providers[0]?.check).toBeNull();
    expect((await connections.check("linear", "DAY-173")).message).toContain(
      "not verified"
    );
    readable = true;
    expect(await connections.check("linear", "DAY-173")).toMatchObject({
      aiCalls: 0,
      sources: [{ title: "DAY-173", content: "Awaiting confirmation" }]
    });
    const revision = connections.revision();
    await expect(
      connections.configure({
        provider: "linear",
        token: "invalid-replacement-token",
        teamId
      })
    ).rejects.toThrow("configuration failed");
    expect(connections.revision()).toBe(revision);
    expect(connections.environment()["LUMA_CONTEXT_LINEAR_READONLY_API_KEY"]).toBe(token);
    failRead = true;
    await expect(connections.check("linear", "DAY-173")).rejects.toThrow(
      "Source read failed"
    );
    expect(connections.status().providers[0]?.check?.message).toContain("not verified");
    expect(JSON.stringify(connections.status())).not.toContain("secret provider body");
  } finally {
    await connections.close();
    await rm(directory, { recursive: true, force: true });
  }
});
