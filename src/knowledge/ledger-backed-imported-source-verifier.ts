import type { MeetingImportedFromSource } from "../domain/model.js";
import type {
  ImportedSourceObservationVerifier,
  ImportedSourceObservationVerification
} from "../meeting-intelligence/imported-source-observation-verifier.js";
import {
  observedMeetingNoteToObservation,
  type IngestObservedMeetingNoteInput
} from "./meeting-notes-ingestion.js";
import type { ObservedSourceLedger } from "./observed-source-ledger.js";

export type CreateLedgerBackedImportedSourceVerifierInput = {
  ledger: ObservedSourceLedger;
  workItemProviderId?: string;
  implementationReferenceProviderId?: string;
};

/**
 * Admits only exact deterministic projections of snapshots already captured
 * by the immutable observed-source ledger. It deliberately knows no Notion
 * SDK types; the verifier works against the provider-neutral ledger contract.
 */
export function createLedgerBackedImportedSourceVerifier(
  input: CreateLedgerBackedImportedSourceVerifierInput
): ImportedSourceObservationVerifier {
  const workItemProviderId = (input.workItemProviderId ?? "linear").trim();
  const implementationReferenceProviderId = (
    input.implementationReferenceProviderId ?? "github-code"
  ).trim();

  if (workItemProviderId.length === 0) {
    throw new Error("Imported source verification requires a WorkProvider identity");
  }

  if (implementationReferenceProviderId.length === 0) {
    throw new Error(
      "Imported source verification requires an implementation reference provider identity"
    );
  }

  return {
    async verify({ workspace, observation }) {
      try {
        const source = observation.source;
        const snapshot = await input.ledger.get({
          workspaceId: workspace.workspaceId,
          source: {
            providerId: source.providerId,
            sourceKind: source.sourceKind,
            sourceObjectId: source.sourceObjectId
          },
          revision: source.sourceRevision
        });

        if (!snapshot) {
          return rejected(
            "The imported source revision is absent from the observed-source ledger."
          );
        }

        const expected = observedMeetingNoteToObservation(
          {
            workspace,
            source: {
              ...snapshot,
              change: "unchanged"
            }
          } satisfies IngestObservedMeetingNoteInput,
          workItemProviderId,
          implementationReferenceProviderId
        );

        return sameCanonicalObservation(expected, observation)
          ? { status: "verified" }
          : rejected(
              "The imported source Observation does not match the immutable ledger revision."
            );
      } catch (error) {
        return {
          status: "unavailable",
          message: `The observed-source ledger could not be read: ${errorMessage(error)}`,
          retryable: true
        };
      }
    }
  };
}

function rejected(message: string): ImportedSourceObservationVerification {
  return { status: "rejected", message, retryable: false };
}

function sameCanonicalObservation(
  expected: MeetingImportedFromSource,
  observed: MeetingImportedFromSource
): boolean {
  return canonicalJson(expected) === canonicalJson(observed);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
