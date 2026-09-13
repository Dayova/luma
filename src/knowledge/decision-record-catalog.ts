import type {
  CanonicalDecisionRecord,
  DecisionAudience,
  DecisionCatalogSnapshot
} from "../domain/decision-records.js";
import type { ExternalReference } from "../domain/model.js";

/** Read-only canonical Decision capability. Every read checks original and current recipients. */
export interface DecisionRecordCatalog {
  readonly providerId: string;
  readonly history?: DecisionRecordHistoryCatalog;
  discover(
    this: void,
    input: {
      audience: DecisionAudience;
      limit: number;
      signal?: AbortSignal;
      priority?: "background";
    }
  ): Promise<DecisionCatalogSnapshot>;
  requireCurrent(
    this: void,
    input: {
      audience: DecisionAudience;
      snapshot: DecisionCatalogSnapshot;
      signal?: AbortSignal;
    }
  ): Promise<void>;
  /** Untrusted logical/provider identifier: resolve uniquely against a complete catalog. */
  read(
    this: void,
    input: { audience: DecisionAudience; recordId: string; signal?: AbortSignal }
  ): Promise<CanonicalDecisionRecord | null>;
  /** Exact opaque reference previously supplied by this capability; never a logical-ID shortcut. */
  readReference(
    this: void,
    input: {
      audience: DecisionAudience;
      reference: ExternalReference;
      signal?: AbortSignal;
    }
  ): Promise<CanonicalDecisionRecord | null>;
}

/** A signed immutable revision, read through its live canonical page and original grants. */
export type DecisionRecordHistoricalRevision = {
  revisionId: string;
  ordinal: number;
  /** Revision recording time; legacy archives may lack it. Never infer from effective time. */
  recordedAt: string | null;
  record: CanonicalDecisionRecord;
};
export interface DecisionRecordHistoryCatalog {
  /** Shares one bounded native scan with current discovery; no archive reaches ordinary reconciliation. */
  discover(
    this: void,
    input: {
      audience: DecisionAudience;
      limit: number;
      historyLimit: number;
      signal?: AbortSignal;
      priority?: "background";
    }
  ): Promise<{
    current: DecisionCatalogSnapshot;
    revisions: DecisionRecordHistoricalRevision[];
    complete: boolean;
  }>;
  readReference(
    this: void,
    input: {
      audience: DecisionAudience;
      reference: ExternalReference;
      revisionId: string;
      asOf?: string;
      signal?: AbortSignal;
    }
  ): Promise<DecisionRecordHistoricalRevision | null>;
}
