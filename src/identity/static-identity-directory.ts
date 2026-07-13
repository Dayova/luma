import type { PersonId, WorkspaceId } from "../domain/model.js";
import type { IdentityDirectory, PersonIdentity } from "./interface.js";

export type StaticIdentityDirectoryInput = {
  people: PersonIdentity[];
};

export function createStaticIdentityDirectory(
  input: StaticIdentityDirectoryInput
): IdentityDirectory {
  const peopleById = new Map(input.people.map((person) => [person.personId, person]));
  const peopleByDiscordUserId = new Map(
    input.people
      .filter((person): person is PersonIdentity & { discordUserId: string } =>
        Boolean(person.discordUserId)
      )
      .map((person) => [person.discordUserId, person])
  );

  return {
    getPerson({ personId }) {
      return Promise.resolve(peopleById.get(personId) ?? null);
    },
    findPersonByDiscordUserId({ discordUserId }) {
      return Promise.resolve(peopleByDiscordUserId.get(discordUserId) ?? null);
    },
    getPeople({ personIds }) {
      return Promise.resolve(
        personIds
          .map((personId) => peopleById.get(personId))
          .filter((person): person is PersonIdentity => Boolean(person))
      );
    }
  };
}

export function createLumaTeamIdentityDirectory(): IdentityDirectory {
  return createStaticIdentityDirectory({
    people: lumaTeamPeople
  });
}

export function createIdentityDirectoryFromEnv(
  env: NodeJS.ProcessEnv = process.env
): IdentityDirectory {
  const peopleJson = env["LUMA_IDENTITY_PEOPLE_JSON"];

  if (!peopleJson) {
    return createLumaTeamIdentityDirectory();
  }

  const configuredPeople = parsePeopleJson(peopleJson);
  const people = new Map(lumaTeamPeople.map((person) => [person.personId, person]));

  for (const person of configuredPeople) {
    people.set(person.personId, person);
  }

  return createStaticIdentityDirectory({
    people: [...people.values()]
  });
}

export const lumaTeamPeople: PersonIdentity[] = [
  {
    personId: "person_fabius",
    displayName: "Fabius Schurig",
    discordUserId: "726409024894926869",
    discordUsername: "gamius_official",
    githubLogin: "Gamius00",
    githubUserId: null,
    atlassianAccountId: null,
    notionUserId: null,
    linearUserId: null,
    languagePreference: "auto"
  },
  {
    personId: "person_jakob",
    displayName: "Jakob Rössner",
    discordUserId: "779381502311137301",
    discordUsername: "fleetadmiraljakob",
    githubLogin: "FleetAdmiralJakob",
    githubUserId: null,
    atlassianAccountId: null,
    notionUserId: null,
    linearUserId: null,
    languagePreference: "auto"
  },
  {
    personId: "person_julius",
    displayName: "Julius",
    discordUserId: "1376219174723911841",
    discordUsername: "juliusd1234_18271",
    githubLogin: "juliusdietrich2407-lab",
    githubUserId: null,
    atlassianAccountId: null,
    notionUserId: null,
    linearUserId: null,
    languagePreference: "auto"
  },
  {
    personId: "person_philipp",
    displayName: "Philipp",
    discordUserId: "1492911575806251219",
    discordUsername: "philipp_54277",
    githubLogin: "PhilippSchossig",
    githubUserId: null,
    atlassianAccountId: null,
    notionUserId: null,
    linearUserId: null,
    languagePreference: "auto"
  }
];

export async function resolveGitHubLogin(input: {
  identityDirectory: IdentityDirectory | undefined;
  workspaceId: WorkspaceId;
  personId: PersonId | null;
}): Promise<string | null> {
  if (!input.identityDirectory || !input.personId) {
    return null;
  }

  const person = await input.identityDirectory.getPerson({
    workspaceId: input.workspaceId,
    personId: input.personId
  });

  return person?.githubLogin ?? null;
}

export async function renderGitHubMentions(input: {
  identityDirectory: IdentityDirectory | undefined;
  workspaceId: WorkspaceId;
  personIds: PersonId[];
}): Promise<string[]> {
  if (!input.identityDirectory) {
    return [];
  }

  const people = await input.identityDirectory.getPeople({
    workspaceId: input.workspaceId,
    personIds: unique(input.personIds)
  });

  return people
    .map((person) => person.githubLogin)
    .filter((login): login is string => Boolean(login))
    .map((login) => `@${login}`);
}

export async function renderDiscordMentions(input: {
  identityDirectory: IdentityDirectory | undefined;
  workspaceId: WorkspaceId;
  personIds: PersonId[];
}): Promise<string[]> {
  const mentions = await resolveDiscordMentions(input);
  return mentions.map((mention) => mention.content);
}

export type DiscordMention = {
  content: string;
  userId: string;
};

export async function resolveDiscordMentions(input: {
  identityDirectory: IdentityDirectory | undefined;
  workspaceId: WorkspaceId;
  personIds: PersonId[];
}): Promise<DiscordMention[]> {
  if (!input.identityDirectory) {
    return [];
  }

  const people = await input.identityDirectory.getPeople({
    workspaceId: input.workspaceId,
    personIds: unique(input.personIds)
  });

  return people
    .map((person) => person.discordUserId)
    .filter((discordUserId): discordUserId is string => Boolean(discordUserId))
    .map((discordUserId) => ({
      content: `<@${discordUserId}>`,
      userId: discordUserId
    }));
}

function unique(values: PersonId[]): PersonId[] {
  return [...new Set(values)];
}

function parsePeopleJson(value: string): PersonIdentity[] {
  const parsed = JSON.parse(value) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error("LUMA_IDENTITY_PEOPLE_JSON must be a JSON array");
  }

  return parsed.map((person) => parsePersonIdentity(person));
}

function parsePersonIdentity(value: unknown): PersonIdentity {
  if (!value || typeof value !== "object") {
    throw new Error("Each identity entry must be an object");
  }

  const candidate = value as Record<string, unknown>;
  const personId = readRequiredString(candidate, "personId");
  const displayName = readRequiredString(candidate, "displayName");

  return {
    personId,
    displayName,
    discordUserId: readNullableString(candidate, "discordUserId"),
    discordUsername: readNullableString(candidate, "discordUsername"),
    githubLogin: readNullableString(candidate, "githubLogin"),
    githubUserId: readNullableString(candidate, "githubUserId"),
    atlassianAccountId: readNullableString(candidate, "atlassianAccountId"),
    notionUserId: readNullableString(candidate, "notionUserId"),
    linearUserId: readNullableString(candidate, "linearUserId"),
    languagePreference: readLanguagePreference(candidate["languagePreference"])
  };
}

function readRequiredString(
  value: Record<string, unknown>,
  key: keyof PersonIdentity
): string {
  const result = value[key];

  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`${String(key)} must be a non-empty string`);
  }

  return result;
}

function readNullableString(
  value: Record<string, unknown>,
  key: keyof PersonIdentity
): string | null {
  const result = value[key];

  if (result === undefined || result === null || result === "") {
    return null;
  }

  if (typeof result !== "string") {
    throw new Error(`${String(key)} must be a string or null`);
  }

  return result;
}

function readLanguagePreference(value: unknown): PersonIdentity["languagePreference"] {
  return value === "de" || value === "en" || value === "auto" ? value : "auto";
}
