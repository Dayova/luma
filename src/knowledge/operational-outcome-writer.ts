import type {
  ActionItemOwnershipAttribution,
  ActionItemReconciliationOutcome,
  ExternalReference
} from "../domain/model.js";

/**
 * The immutable source target captured by Follow-up Execution while the
 * reconciliation source is still current. Callers never provide this target.
 */
export type OperationalOutcomeTarget = {
  workspaceId: string;
  providerId: string;
  page: ExternalReference & { objectType: "document" };
  sourceObjectId: string;
  sourceRevision: number;
  sourceContentHash: string;
};

/** One durable reconciliation result rendered inside a page-owned outcome. */
export type OperationalOutcomeEntry = {
  settlementIntentId: string;
  source: {
    sourceObjectId: string;
    sourceRevision: number;
    sourceContentHash: string;
  };
  /** Never omit responsibility state: blank would look falsely settled. */
  ownership: ActionItemOwnershipAttribution;
  resolution: ActionItemReconciliationOutcome;
  /** Provider-neutral work-item links (Linear, GitHub Issues, or another WorkProvider). */
  workReferences: ExternalReference[];
  knowledgeReferences: ExternalReference[];
  githubReferences: ExternalReference[];
  unresolved: string[];
};

/**
 * Structured, deterministic facts for the one Luma-owned compact outcome
 * section on a source page. Entries are aggregated so recovering an earlier
 * settlement can never replace a later reconciliation outcome.
 */
export type OperationalOutcome = {
  formatVersion: 1;
  /**
   * Random, durable write capability generated after the page lease is held.
   * It prevents a user from pre-seeding a future checksum-valid aggregate and
   * having an interrupted write falsely accepted as Luma-owned progress.
   */
  operationToken: string;
  scope: {
    workspaceId: string;
    providerId: string;
    pageExternalId: string;
  };
  entries: OperationalOutcomeEntry[];
};

/**
 * Read-only ownership check used by source ingestion before it strips an
 * outcome marker from canonical Meeting Note material. A checksum alone is
 * never proof that an arbitrary page section was produced by Luma.
 */
export interface OperationalOutcomeMarkerVerifier {
  isOwned(input: {
    workspaceId: string;
    providerId: string;
    pageExternalId: string;
    payloadDigest: string;
    contentDigest: string;
    operationDigest: string;
  }): Promise<boolean>;
}

export type OperationalOutcomeReceipt = {
  externalReference: ExternalReference;
  status: "inserted" | "replaced" | "already-current";
  payloadDigest: string;
  contentDigest: string;
  operationDigest: string;
};

/**
 * The Adapter proved that a write did not reach the provider. Only this
 * explicit error may be retried automatically; all other failures are
 * treated as indeterminate external side effects.
 */
export class OperationalOutcomeWriteNotAppliedError extends Error {
  constructor(
    message: string,
    readonly retryable = true
  ) {
    super(message);
    this.name = "OperationalOutcomeWriteNotAppliedError";
  }
}

/**
 * A provider-neutral capability for exactly one Luma-owned Operational
 * Outcome section on an existing source document. It deliberately does not
 * expose whole-document replacement or arbitrary Markdown updates.
 */
export interface OperationalOutcomeWriter {
  readonly providerId: string;
  upsert(input: {
    target: OperationalOutcomeTarget;
    outcome: OperationalOutcome;
    idempotencyKey: string;
  }): Promise<OperationalOutcomeReceipt>;
  /**
   * Positive-only recovery. A null result never permits an indeterminate
   * mutation to be repeated automatically.
   */
  findWrittenOutcome(input: {
    target: OperationalOutcomeTarget;
    outcome: OperationalOutcome;
    idempotencyKey: string;
  }): Promise<OperationalOutcomeReceipt | null>;
}
