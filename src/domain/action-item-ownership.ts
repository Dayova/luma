import type { ActionItem, ActionItemOwnershipAttribution } from "./model.js";

/**
 * Only these two durable states can authorize a canonical-work mutation.
 * `confirmed` carries a real Person who must still map to the target provider;
 * `intentionally-unassigned` is an explicit Human decision, never a fallback.
 */
export function ownershipCanMutateCanonicalWork(
  ownership: ActionItemOwnershipAttribution
): boolean {
  return (
    ownership.status === "confirmed" || ownership.status === "intentionally-unassigned"
  );
}

/** Compare the ownership value as a domain discriminated union, not JSON. */
export function sameActionItemOwnership(
  left: ActionItemOwnershipAttribution,
  right: ActionItemOwnershipAttribution
): boolean {
  switch (left.status) {
    case "confirmed":
      return (
        right.status === "confirmed" &&
        right.ownerPersonId === left.ownerPersonId &&
        right.confidence === left.confidence &&
        right.basis === left.basis
      );
    case "proposed":
      return (
        right.status === "proposed" &&
        right.proposedOwnerPersonId === left.proposedOwnerPersonId &&
        right.confidence === left.confidence &&
        right.basis === left.basis
      );
    case "intentionally-unassigned":
      return right.status === "intentionally-unassigned" && right.basis === left.basis;
    case "unresolved":
      return (
        right.status === "unresolved" &&
        right.reason === left.reason &&
        right.likelyOwnerPersonId === left.likelyOwnerPersonId
      );
  }
}

/** Legacy owner IDs remain proposals until Human Judgment confirms ownership. */
export function actionItemOwnership(item: ActionItem): ActionItemOwnershipAttribution {
  if (item.ownership) return item.ownership;
  return item.ownerId
    ? {
        status: "proposed",
        proposedOwnerPersonId: item.ownerId,
        confidence: "low",
        basis: "inferred-assignment"
      }
    : {
        status: "unresolved",
        reason: "no-owner-stated",
        likelyOwnerPersonId: null
      };
}
