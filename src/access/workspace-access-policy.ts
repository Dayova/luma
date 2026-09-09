import type { PersonId, WorkspaceId } from "../domain/model.js";
import type { IdentityDirectory, PersonIdentity } from "../identity/interface.js";

/** Provider authentication belongs to the ingress; mapping alone grants no access. */
export interface WorkspaceAccessPolicy {
  authorize(input: {
    workspaceId: WorkspaceId;
    providerId: string;
    providerUserId: string;
  }): Promise<PersonIdentity | null>;
}

export function createWorkspaceAccessPolicy(input: {
  workspaceId: WorkspaceId;
  authorizedPersonIds: readonly PersonId[];
  identityDirectory: IdentityDirectory;
}): WorkspaceAccessPolicy {
  const authorizedPersonIds = new Set(input.authorizedPersonIds);

  return {
    async authorize(actor) {
      if (actor.workspaceId !== input.workspaceId || !actor.providerUserId.trim()) {
        return null;
      }

      try {
        const people = await input.identityDirectory.findPeopleByProviderUserId(actor);
        const person = people.length === 1 ? people[0] : undefined;
        return person && authorizedPersonIds.has(person.personId) ? person : null;
      } catch {
        return null;
      }
    }
  };
}
