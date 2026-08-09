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
  /**
   * Returns every internal Person bound to one provider account. Callers that
   * need authorization must reject zero or multiple results; a provider
   * account, display name, attendee entry, or model claim is never itself a
   * Person authorization.
   */
  findPeopleByProviderUserId(input: {
    workspaceId: WorkspaceId;
    providerId: string;
    providerUserId: string;
  }): Promise<PersonIdentity[]>;
  findPersonByDiscordUserId(input: {
    workspaceId: WorkspaceId;
    discordUserId: string;
  }): Promise<PersonIdentity | null>;
  getPeople(input: {
    workspaceId: WorkspaceId;
    personIds: PersonId[];
  }): Promise<PersonIdentity[]>;
}
