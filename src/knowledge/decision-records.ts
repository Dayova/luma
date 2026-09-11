import type {
  CanonicalDecisionRecord,
  DecisionAudience,
  DecisionCatalogSnapshot,
  DecisionWriteReceipt,
  DecisionWriteStage
} from "../domain/decision-records.js";

/** Canonical configured knowledge target; every operation verifies the entire actual audience. */
export interface DecisionRecords {
  readonly providerId: string;
  discover(
    this: void,
    input: {
      audience: DecisionAudience;
      limit: number;
    }
  ): Promise<DecisionCatalogSnapshot>;
  requireCurrent(
    this: void,
    input: {
      audience: DecisionAudience;
      snapshot: DecisionCatalogSnapshot;
    }
  ): Promise<void>;
  read(
    this: void,
    input: {
      audience: DecisionAudience;
      recordId: string;
    }
  ): Promise<CanonicalDecisionRecord | null>;
  /** One bounded external mutation per stage. No follow-on mutation inside this call. */
  write(
    this: void,
    input: {
      audience: DecisionAudience;
      stage: DecisionWriteStage;
      operationId: string;
    }
  ): Promise<DecisionWriteReceipt>;
  /** Exact positive evidence only. Absence never authorizes another uncertain write. */
  findWritten(
    this: void,
    input: {
      audience: DecisionAudience;
      stage: DecisionWriteStage;
      operationId: string;
    }
  ): Promise<DecisionWriteReceipt | null>;
}
export class DecisionWriteNotAppliedError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}
