import type { DecisionAuthoritySnapshot } from "../domain/decision-records.js";

/** Shared deterministic scope authority; recording permission never substitutes for it. */
export function decisionScopeOwnership(
  snapshot: DecisionAuthoritySnapshot,
  scopeId: string
) {
  const grants = snapshot.grants.filter(
    (grant) =>
      grant.scopeId === scopeId &&
      grant.standing === "current" &&
      grant.kind !== "provisional-role" &&
      grant.evidence.length > 0
  );
  const priority = (kind: string) =>
    kind === "delegation" ? 3 : kind === "project-ownership" ? 2 : 1;
  const highest = Math.max(0, ...grants.map((grant) => priority(grant.kind)));
  const selected = grants.filter((grant) => priority(grant.kind) === highest);
  const owners = [...new Set(selected.map((grant) => grant.personId))];
  if (owners.length !== 1)
    return "Current responsibility evidence does not establish one unambiguous accountable decision-maker.";
  if (
    selected.some(
      (grant) =>
        grant.kind === "delegation" &&
        (!grant.delegatedBy ||
          !snapshot.grants.some(
            (parent) =>
              parent.personId === grant.delegatedBy &&
              parent.scopeId === grant.scopeId &&
              parent.standing === "current" &&
              parent.kind !== "provisional-role" &&
              parent.kind !== "delegation"
          ))
    )
  )
    return "The delegation does not have current authority evidence.";
  return { owner: owners[0]!, grants: selected };
}
