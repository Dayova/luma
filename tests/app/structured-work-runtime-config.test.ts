import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readStructuredWorkTargetPolicy,
  structuredWorkRuntimeConfig,
  validateStructuredWorkFounderScope
} from "../../src/app/structured-work-runtime.js";
import { createLumaTeamIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import { createWorkspaceAccessPolicy } from "../../src/access/workspace-access-policy.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";
import { verifyProductionDiscordApplication } from "../../src/app/production-runtime.js";
const env: NodeJS.ProcessEnv = {
  LUMA_DISCORD_STRUCTURED_WORK_ENABLED: "1",
  LUMA_DISCORD_STRUCTURED_WORK_PARENT_CHANNEL_IDS: "100000000000000001",
  LUMA_DISCORD_STRUCTURED_WORK_ALLOWED_DISCORD_USER_IDS:
    "779381502311137301,726409024894926869,1492911575806251219,1376219174723911841",
  LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: "100000000000000001",
  LUMA_STRUCTURED_WORK_TARGETS_PATH: "/protected/targets.json",
  LUMA_CONTEXT_SHARING_POLICY_PATH: "/protected/sharing.json",
  LUMA_STRUCTURED_WORK_NOTION_CREDENTIAL_SCOPE_ID: "tables-write",
  LUMA_STRUCTURED_WORK_LINEAR_CREDENTIAL_SCOPE_ID: "validation-work",
  LINEAR_TEAM_ID: "team",
  LINEAR_API_KEY: "test-only",
  OPENAI_API_KEY: "test-only",
  LUMA_STRUCTURED_WORK_NOTION_API_TOKEN: "test-only",
  LUMA_STRUCTURED_WORK_SIGNING_KEY: "test-only-signing-key-at-least-32-bytes"
};
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
describe("structured work startup configuration", () => {
  it("requires Message Content approval for structured source capture even when Ask is off", async () => {
    const configured = {
      ...env,
      DISCORD_TOKEN: "test-only",
      DISCORD_CLIENT_ID: "999999999999999999",
      LUMA_DISCORD_CONTEXT_ASK_ENABLED: "0"
    };
    const fetchApplication =
      (flags: number): typeof fetch =>
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ id: configured.DISCORD_CLIENT_ID, flags }))
        );
    await expect(
      verifyProductionDiscordApplication(configured, fetchApplication(1 << 15))
    ).rejects.toThrow("Message Content");
    await expect(
      verifyProductionDiscordApplication(
        configured,
        fetchApplication((1 << 15) | (1 << 19))
      )
    ).resolves.toBeUndefined();
  });
  it("is off until separately enabled; enabling Ask cannot authorize compound writes", () => {
    expect(
      structuredWorkRuntimeConfig({ LUMA_DISCORD_CONTEXT_ASK_ENABLED: "1" })
    ).toBeUndefined();
    expect(
      structuredWorkRuntimeConfig({ ...env, LUMA_DISCORD_STRUCTURED_WORK_ENABLED: "0" })
    ).toBeUndefined();
    expect(structuredWorkRuntimeConfig(env)?.discord.parentChannelIds).toEqual([
      "100000000000000001"
    ]);
  });
  it.each([
    "LUMA_STRUCTURED_WORK_TARGETS_PATH",
    "LUMA_CONTEXT_SHARING_POLICY_PATH",
    "LUMA_STRUCTURED_WORK_NOTION_CREDENTIAL_SCOPE_ID",
    "LUMA_STRUCTURED_WORK_LINEAR_CREDENTIAL_SCOPE_ID",
    "LINEAR_TEAM_ID",
    "LINEAR_API_KEY",
    "OPENAI_API_KEY",
    "LUMA_STRUCTURED_WORK_NOTION_API_TOKEN",
    "LUMA_STRUCTURED_WORK_SIGNING_KEY",
    "LUMA_DISCORD_STRUCTURED_WORK_PARENT_CHANNEL_IDS",
    "LUMA_DISCORD_STRUCTURED_WORK_ALLOWED_DISCORD_USER_IDS"
  ])("refuses missing %s before runtime resources are acquired", (key) => {
    expect(() => structuredWorkRuntimeConfig({ ...env, [key]: "" })).toThrow();
  });
  it.each([
    { LUMA_DISCORD_STRUCTURED_WORK_ENABLED: "true" },
    { LUMA_STRUCTURED_WORK_TARGETS_PATH: "relative.json" },
    { LUMA_CONTEXT_SHARING_POLICY_PATH: "relative.json" },
    { LUMA_STRUCTURED_WORK_SIGNING_KEY: "short" },
    { LUMA_DISCORD_STRUCTURED_WORK_PARENT_CHANNEL_IDS: "100000000000000099" }
  ])("rejects unsafe configuration %j", (change) => {
    expect(() => structuredWorkRuntimeConfig({ ...env, ...change })).toThrow();
  });
  it("requires all four actual uniquely mapped founders", async () => {
    const config = structuredWorkRuntimeConfig(env)!,
      identityDirectory = createLumaTeamIdentityDirectory(),
      workspaceId = "workspace_dayova";
    const accessPolicy = createWorkspaceAccessPolicy({
      workspaceId,
      identityDirectory,
      authorizedPersonIds: dayovaFounderPersonIds
    });
    await expect(
      validateStructuredWorkFounderScope({
        config,
        workspaceId,
        identityDirectory,
        accessPolicy
      })
    ).resolves.toBeUndefined();
    for (const ids of [
      ["779381502311137301"],
      [...config.discord.allowedDiscordUserIds.slice(0, 3), "777777777777777777"]
    ])
      await expect(
        validateStructuredWorkFounderScope({
          config: {
            ...config,
            discord: { ...config.discord, allowedDiscordUserIds: ids }
          },
          workspaceId,
          identityDirectory,
          accessPolicy
        })
      ).rejects.toThrow();
  });
  it("loads a protected exact workspace/table mapping and refuses schema ambiguity, foreign workspaces and writable links", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luma-structured-config-"));
    directories.push(directory);
    const path = join(directory, "targets.json");
    const policy = {
      version: 1,
      workspaceId: "workspace_dayova",
      targets: [
        {
          key: "hypotheses",
          label: "Hypotheses",
          dataSourceId: "8fd29131-8312-411d-a833-f320f1afbfaf",
          titleField: "hypothesis",
          fields: {
            hypothesis: { property: "Hypothesis", type: "text", required: true }
          },
          authorizedPersonIds: [...dayovaFounderPersonIds]
        }
      ]
    };
    await writeFile(path, JSON.stringify(policy), { mode: 0o600 });
    expect(await readStructuredWorkTargetPolicy(path, "workspace_dayova")).toEqual(
      policy
    );
    await expect(
      readStructuredWorkTargetPolicy(path, "another-workspace")
    ).rejects.toThrow();
    for (const target of [
      { ...policy.targets[0], authorizedPersonIds: ["guest"] },
      { ...policy.targets[0], sourceProperty: "Hypothesis" },
      { ...policy.targets[0], defaults: { missing: { type: "text", value: "bad" } } }
    ]) {
      await writeFile(path, JSON.stringify({ ...policy, targets: [target] }));
      await expect(
        readStructuredWorkTargetPolicy(path, "workspace_dayova")
      ).rejects.toThrow();
    }
    await writeFile(
      path,
      JSON.stringify({ ...policy, targets: [...policy.targets, ...policy.targets] })
    );
    await expect(
      readStructuredWorkTargetPolicy(path, "workspace_dayova")
    ).rejects.toThrow();
    await writeFile(path, JSON.stringify(policy));
    await chmod(path, 0o666);
    await expect(
      readStructuredWorkTargetPolicy(path, "workspace_dayova")
    ).rejects.toThrow();
    await chmod(path, 0o600);
    await symlink(path, join(directory, "link.json"));
    await expect(
      readStructuredWorkTargetPolicy(join(directory, "link.json"), "workspace_dayova")
    ).rejects.toThrow();
  });
});
