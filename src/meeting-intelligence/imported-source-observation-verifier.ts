import type { MeetingImportedFromSource, WorkspaceConfig } from "../domain/model.js";

/**
 * Verifies that an imported source Observation was derived from a durable,
 * provider-neutral source snapshot. Meeting Intelligence owns this narrow
 * port; Knowledge adapters supply the concrete ledger-backed implementation.
 */
export interface ImportedSourceObservationVerifier {
  verify(input: {
    workspace: WorkspaceConfig;
    observation: MeetingImportedFromSource;
  }): Promise<ImportedSourceObservationVerification>;
}

export type ImportedSourceObservationVerification =
  | { status: "verified" }
  | { status: "rejected"; message: string; retryable: false }
  | { status: "unavailable"; message: string; retryable: true };

export const rejectUnverifiedImportedSource: ImportedSourceObservationVerifier = {
  verify: () =>
    Promise.resolve({
      status: "rejected",
      message:
        "Imported source Observations require a durable source-verification adapter.",
      retryable: false
    })
};
