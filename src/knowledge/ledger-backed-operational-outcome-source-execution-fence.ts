import type { LumaDatabase } from "../persistence/db.js";
import type { OperationalOutcomeTarget } from "./operational-outcome-writer.js";
import {
  releaseObservedSourceExecutionFencesForSettlement,
  type ObservedSourceExecutionFenceAcquisition,
  type ObservedSourceExecutionFenceHeldCurrent,
  type ObservedSourceExecutionFenceExpectedHead,
  type ObservedSourceExecutionFenceOwner,
  type ObservedSourceLedger
} from "./observed-source-ledger.js";

/**
 * Provider-neutral serialization boundary between an approved source revision
 * and the external Operational Outcome mutation derived from it.
 */
export interface OperationalOutcomeSourceExecutionFence {
  acquire(input: {
    target: OperationalOutcomeTarget;
    owner: ObservedSourceExecutionFenceOwner;
    now: Date;
  }): Promise<ObservedSourceExecutionFenceAcquisition>;
  /**
   * Fails closed unless this exact execution still holds an uninvalidated
   * fence for the immutable source head it intends to mutate from.
   */
  verifyHeldCurrent(input: {
    target: OperationalOutcomeTarget;
    owner: ObservedSourceExecutionFenceOwner;
  }): Promise<OperationalOutcomeSourceExecutionFenceCurrentness>;
  /**
   * Runs inside Follow-up Execution's terminal-receipt transaction, so a
   * source cannot advance until Meeting Intelligence accepted the receipt.
   */
  releaseAfterReceipt(input: {
    database: Pick<LumaDatabase, "query">;
    workspaceId: string;
    meetingId: string;
    intentId: string;
  }): Promise<void>;
}

export type OperationalOutcomeSourceExecutionFenceCurrentness =
  | { status: "current" }
  | { status: "superseded"; message: string }
  | { status: "unavailable"; message: string };

export type CreateLedgerBackedOperationalOutcomeSourceExecutionFenceInput = {
  ledger: Pick<
    ObservedSourceLedger,
    "acquireExecutionFence" | "verifyExecutionFenceHeldCurrent"
  >;
};

/** Adapts the observed-source ledger without leaking provider SDK types. */
export function createLedgerBackedOperationalOutcomeSourceExecutionFence(
  input: CreateLedgerBackedOperationalOutcomeSourceExecutionFenceInput
): OperationalOutcomeSourceExecutionFence {
  return {
    acquire({ target, owner, now }) {
      return input.ledger.acquireExecutionFence({
        workspaceId: target.workspaceId,
        source: {
          providerId: target.providerId,
          sourceKind: "meeting-note",
          sourceObjectId: target.sourceObjectId
        },
        expected: expectedHead(target),
        owner,
        now
      });
    },
    async verifyHeldCurrent({ target, owner }) {
      try {
        const currentness = await input.ledger.verifyExecutionFenceHeldCurrent({
          workspaceId: target.workspaceId,
          source: {
            providerId: target.providerId,
            sourceKind: "meeting-note",
            sourceObjectId: target.sourceObjectId
          },
          expected: expectedHead(target),
          owner
        });

        return operationalOutcomeFenceCurrentness(currentness);
      } catch (error) {
        return {
          status: "unavailable",
          message: `Luma could not verify its held source execution fence: ${errorMessage(error)}`
        };
      }
    },
    releaseAfterReceipt({ database, workspaceId, meetingId, intentId }) {
      return releaseObservedSourceExecutionFencesForSettlement({
        database,
        workspaceId,
        meetingId,
        intentId
      });
    }
  };
}

function operationalOutcomeFenceCurrentness(
  currentness: ObservedSourceExecutionFenceHeldCurrent
): OperationalOutcomeSourceExecutionFenceCurrentness {
  if (currentness.status === "current") {
    return currentness;
  }

  if (currentness.status === "superseded") {
    return {
      status: "superseded",
      message: currentness.supersession
        ? "A blocked canonical source scan observed a newer source state while this execution held its fence."
        : "The observed-source ledger current head no longer matches this approved Operational Outcome settlement."
    };
  }

  return {
    status: "unavailable",
    message:
      "Luma could not prove this execution still owns the source fence for its approved source head."
  };
}

function expectedHead(
  target: OperationalOutcomeTarget
): ObservedSourceExecutionFenceExpectedHead {
  return {
    revision: target.sourceRevision,
    contentHash: target.sourceContentHash
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
