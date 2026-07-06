import { describe, expect, it } from "vitest";
import {
  createIdentityDirectoryFromEnv,
  createLumaTeamIdentityDirectory,
  renderGitHubMentions
} from "../../src/identity/static-identity-directory.js";

describe("IdentityDirectory", () => {
  it("resolves the Luma team GitHub mentions", async () => {
    const identityDirectory = createLumaTeamIdentityDirectory();

    const mentions = await renderGitHubMentions({
      identityDirectory,
      workspaceId: "workspace_luma",
      personIds: ["person_fabius", "person_jakob", "person_julius", "person_philipp"]
    });

    expect(mentions).toEqual([
      "@Gamius00",
      "@FleetAdmiralJakob",
      "@juliusdietrich2407-lab",
      "@PhilippSchossig"
    ]);
  });

  it("can load additional people from environment JSON", async () => {
    const identityDirectory = createIdentityDirectoryFromEnv({
      LUMA_IDENTITY_PEOPLE_JSON: JSON.stringify([
        {
          personId: "person_other",
          displayName: "Other Person",
          githubLogin: "OtherGitHubLogin",
          languagePreference: "en"
        }
      ])
    });

    const mentions = await renderGitHubMentions({
      identityDirectory,
      workspaceId: "workspace_luma",
      personIds: ["person_other"]
    });

    expect(mentions).toEqual(["@OtherGitHubLogin"]);
  });
});
