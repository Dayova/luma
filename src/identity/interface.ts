import type { PersonId, WorkspaceId } from "../domain/model.js";

export type PersonIdentity = {
  personId: PersonId;
  displayName: string;
  discordUserId: string | null;
  discordUsername: string | null;
  githubLogin: string | null;
  githubUserId: string | null;
  atlassianAccountId: string | null;
  notionUserId: string | null;
  linearUserId: string | null;
  languagePreference: "de" | "en" | "auto";
};

export type IdentityLookup = {
  workspaceId: WorkspaceId;
  personId: PersonId;
};

export interface IdentityDirectory {
  getPerson(input: IdentityLookup): Promise<PersonIdentity | null>;
  findPersonByDiscordUserId(input: {
    workspaceId: WorkspaceId;
    discordUserId: string;
  }): Promise<PersonIdentity | null>;
  getPeople(input: {
    workspaceId: WorkspaceId;
    personIds: PersonId[];
  }): Promise<PersonIdentity[]>;
}
