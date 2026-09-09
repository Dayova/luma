import { describe, expect, it } from "vitest";
import { createWorkspaceAccessPolicy } from "../../src/access/workspace-access-policy.js";
import {
  createIdentityDirectoryFromEnv,
  createLumaTeamIdentityDirectory
} from "../../src/identity/static-identity-directory.js";

const authorizedPersonIds = [
  "person_jakob",
  "person_fabius",
  "person_philipp",
  "person_julius"
];

describe("workspace access policy", () => {
  it.each([
    ["779381502311137301", "person_jakob"],
    ["726409024894926869", "person_fabius"],
    ["1492911575806251219", "person_philipp"],
    ["1376219174723911841", "person_julius"]
  ])("admits founder account %s", async (providerUserId, personId) => {
    const policy = createWorkspaceAccessPolicy({
      workspaceId: "workspace_dayova",
      authorizedPersonIds,
      identityDirectory: createLumaTeamIdentityDirectory()
    });
    await expect(
      policy.authorize({
        workspaceId: "workspace_dayova",
        providerId: "discord",
        providerUserId
      })
    ).resolves.toMatchObject({ personId });
  });

  it("rejects ambiguous founder mappings, additional People, and unmapped accounts", async () => {
    const policy = createWorkspaceAccessPolicy({
      workspaceId: "workspace_dayova",
      authorizedPersonIds,
      identityDirectory: createIdentityDirectoryFromEnv({
        LUMA_IDENTITY_PEOPLE_JSON: JSON.stringify([
          { personId: "person_guest", displayName: "Guest", discordUserId: "guest" },
          {
            personId: "person_collision",
            displayName: "Collision",
            discordUserId: "779381502311137301"
          }
        ])
      })
    });
    for (const providerUserId of ["guest", "unmapped", "779381502311137301"]) {
      await expect(
        policy.authorize({
          workspaceId: "workspace_dayova",
          providerId: "discord",
          providerUserId
        })
      ).resolves.toBeNull();
    }
  });

  it("fails closed when identity lookup is unavailable", async () => {
    const policy = createWorkspaceAccessPolicy({
      workspaceId: "workspace_dayova",
      authorizedPersonIds,
      identityDirectory: {
        ...createLumaTeamIdentityDirectory(),
        findPeopleByProviderUserId: () =>
          Promise.reject(new Error("private identity error"))
      }
    });
    await expect(
      policy.authorize({
        workspaceId: "workspace_dayova",
        providerId: "discord",
        providerUserId: "779381502311137301"
      })
    ).resolves.toBeNull();
  });

  it("does not admit a founder into another workspace or an empty authorized set", async () => {
    for (const input of [
      { workspaceId: "workspace_elsewhere", authorizedPersonIds },
      { workspaceId: "workspace_dayova", authorizedPersonIds: [] }
    ]) {
      const policy = createWorkspaceAccessPolicy({
        ...input,
        identityDirectory: createLumaTeamIdentityDirectory()
      });
      await expect(
        policy.authorize({
          workspaceId: "workspace_dayova",
          providerId: "discord",
          providerUserId: "779381502311137301"
        })
      ).resolves.toBeNull();
    }
  });
});
