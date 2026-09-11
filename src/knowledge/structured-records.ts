import type {
  StructuredRecord,
  StructuredRecordCreate,
  StructuredRecordSnapshot,
  StructuredWorkAudience
} from "../domain/structured-work.js";

/** Configured structured knowledge. No arbitrary page creation or generic document overwrite. */
export interface StructuredRecords {
  readonly providerId: string;
  inspect(input: {
    audience: StructuredWorkAudience;
    targetKey: string;
  }): Promise<StructuredRecordSnapshot>;
  requireCurrent(input: {
    audience: StructuredWorkAudience;
    snapshot: StructuredRecordSnapshot;
  }): Promise<void>;
  read(input: {
    audience: StructuredWorkAudience;
    targetKey: string;
    reference: StructuredRecord["reference"];
  }): Promise<StructuredRecord>;
  create(input: {
    audience: StructuredWorkAudience;
    draft: StructuredRecordCreate;
    expected: StructuredRecordSnapshot;
    operationId: string;
    /** Fresh immutable source/actor/owner proof after provider queue wait, before send. */
    requireCurrent(this: void): Promise<void>;
  }): Promise<StructuredRecord>;
  /** Absence is indeterminate, never authorization to repeat a possibly dispatched write. */
  findCreated(input: {
    audience: StructuredWorkAudience;
    draft: StructuredRecordCreate;
    operationId: string;
  }): Promise<StructuredRecord | null>;
}

/** Positive proof that the external mutation did not start. */
export class StructuredRecordNotAppliedError extends Error {}
