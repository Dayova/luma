import type {
  DecisionAudience,
  DecisionWriteReceipt,
  DecisionWriteStage
} from "../domain/decision-records.js";
import type { DecisionRecordCatalog } from "./decision-record-catalog.js";

/** Canonical configured knowledge target; every operation verifies the entire actual audience. */
export interface DecisionRecords extends DecisionRecordCatalog {
  /** One bounded external mutation per stage. No follow-on mutation inside this call. */
  write(
    this: void,
    input: {
      audience: DecisionAudience;
      stage: DecisionWriteStage;
      operationId: string;
      /** Rechecks the immutable approved source and authority after any provider queue wait. */
      requireCurrent(this: void): Promise<void>;
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
