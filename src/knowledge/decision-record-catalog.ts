import type {
  CanonicalDecisionRecord,
  DecisionAudience,
  DecisionCatalogSnapshot
} from "../domain/decision-records.js";
import type { ExternalReference } from "../domain/model.js";

/** Read-only canonical Decision capability. Every read checks original and current recipients. */
export interface DecisionRecordCatalog {
  readonly providerId: string;
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
