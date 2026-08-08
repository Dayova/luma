import type { OperationalOutcomeTarget } from "./operational-outcome-writer.js";
import type {
  ObservedSourceLedger,
  ObservedSourceSnapshot
} from "./observed-source-ledger.js";

/**
 * Provider-neutral source-currentness port for the narrow window between an
 * approved reconciliation and its Operational Outcome write. The caller owns
 * the immutable target; this port only says whether the ledger still proves
 * that exact source revision current.
 */
export interface OperationalOutcomeSourceCurrentnessVerifier {
  verifyCurrent(
    target: OperationalOutcomeTarget
  ): Promise<OperationalOutcomeSourceCurrentness>;
}

export type OperationalOutcomeSourceCurrentness =
  | { status: "current" }
  | { status: "superseded"; message: string }
  | { status: "unavailable"; message: string };

export type CreateLedgerBackedOperationalOutcomeSourceCurrentnessVerifierInput = {
  ledger: Pick<ObservedSourceLedger, "get">;
};

/**
 * Reads the ledger's current head rather than an immutable historical
 * revision. Missing or unreadable ledger state never grants permission to
 * write an Operational Outcome.
 */
export function createLedgerBackedOperationalOutcomeSourceCurrentnessVerifier(
  input: CreateLedgerBackedOperationalOutcomeSourceCurrentnessVerifierInput
): OperationalOutcomeSourceCurrentnessVerifier {
  return {
    async verifyCurrent(target) {
      try {
        const head = await input.ledger.get({
          workspaceId: target.workspaceId,
          source: {
            providerId: target.providerId,
            sourceKind: "meeting-note",
            sourceObjectId: target.sourceObjectId
          }
        });

        if (!head) {
          return {
            status: "unavailable",
            message:
              "The observed-source ledger has no current head for this Operational Outcome target."
          };
        }

        if (head.snapshot.lifecycle === "removed") {
          return {
            status: "superseded",
            message:
              "The observed-source ledger records that this Operational Outcome source root was removed."
          };
        }

        if (!sameCurrentOperationalOutcomeSource(target, head)) {
          return {
            status: "superseded",
            message:
              "The observed-source ledger current head no longer matches this Operational Outcome target."
          };
        }

        return { status: "current" };
      } catch (error) {
        return {
          status: "unavailable",
          message: `The observed-source ledger could not be read: ${errorMessage(error)}`
        };
      }
    }
  };
}

function sameCurrentOperationalOutcomeSource(
  target: OperationalOutcomeTarget,
  head: ObservedSourceSnapshot
): boolean {
  return (
    head.source.providerId === target.providerId &&
    head.source.sourceKind === "meeting-note" &&
    head.source.sourceObjectId === target.sourceObjectId &&
    head.revision === target.sourceRevision &&
    head.contentHash === target.sourceContentHash
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
