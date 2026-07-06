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

  it("stores the visible Discord usernames while leaving numeric Discord IDs unset", async () => {
    const identityDirectory = createLumaTeamIdentityDirectory();

    const people = await identityDirectory.getPeople({
      workspaceId: "workspace_luma",
      personIds: ["person_jakob", "person_fabius", "person_julius", "person_philipp"]
    });

    expect(
      people.map((person) => ({
        personId: person.personId,
        discordUserId: person.discordUserId,
        discordUsername: person.discordUsername
      }))
    ).toEqual([
      {
        personId: "person_jakob",
        discordUserId: null,
        discordUsername: "fleetadmiraljakob"
      },
      {
        personId: "person_fabius",
        discordUserId: null,
        discordUsername: "gamius_official"
      },
      {
        personId: "person_julius",
        discordUserId: null,
        discordUsername: "juliusd1234_18271"
      },
      {
        personId: "person_philipp",
        discordUserId: null,
        discordUsername: "philipp_54277"
      }
    ]);
  });

  it("can load additional people from environment JSON", async () => {
    const identityDirectory = createIdentityDirectoryFromEnv({
      LUMA_IDENTITY_PEOPLE_JSON: JSON.stringify([
        {
          personId: "person_other",
          displayName: "Other Person",
          discordUsername: "other_discord",
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
