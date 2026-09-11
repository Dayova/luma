import type { ExternalReference, PersonId, WorkspaceId } from "../domain/model.js";
import type { KnowledgeStanding } from "../domain/knowledge-standing.js";

/** Actual recipients, including readers of a shared response. */
export type ContextAudience = { workspaceId: WorkspaceId; personIds: PersonId[] };
export type OrganizationalContextRequest = {
  audience: ContextAudience;
  subject: { type: "meeting" | "conversation"; id: string };
  purpose: "understand-discussion" | "answer-question" | "prepare-conclusion";
  /** Bounded literal discovery terms; empty skips discovery with partial coverage. */
  concepts: string[];
  time: { mode: "current" } | { mode: "history"; asOf?: string };
  limit: number;
  maxCharacters: number;
};
export type ContextSource = {
  id: string;
  kind: "knowledge-document" | "work-item" | "code-change" | "previous-meeting-item";
  title: string;
  content: string;
  version: string;
  updatedAt: string;
  externalReference: ExternalReference;
  /** Source metadata or Human Judgment, never guessed from recency. */
  standing: KnowledgeStanding;
  authority: "human-confirmed" | "source" | "ai-inference";
  effectiveAt?: string;
  /** Exact substantive equivalence asserted by an owned catalog; never authority. */
  equivalenceKey?: string;
  /** Explicit decision lineage, not a fuzzy topic match. */
  decisionKey?: string;
  /** IDs within this catalog; only human-confirmed current sources supersede. */
  supersedes?: string[];
};
/** Read-only audience-scoped capability. No writer is available here. */
export interface ContextCatalog {
  readonly id: string;
  /** Marks catalogs that depend on retained Luma understanding rather than external providers. */
  readonly dependencyKind?: "meeting";
  search(input: {
    audience: ContextAudience;
    /** Allows prior-state catalogs to exclude the current subject. */
    subject?: OrganizationalContextRequest["subject"];
    concepts: string[];
    limit: number;
  }): Promise<{ sourceIds: string[]; complete: boolean; warnings: string[] }>;
  /** Fresh readability AND authorization for every recipient; null means ineligible. */
  read(input: {
    audience: ContextAudience;
    subject?: OrganizationalContextRequest["subject"];
    sourceId: string;
  }): Promise<ContextSource | null>;
}
export type RetrievedContextSource = ContextSource & {
  catalogId: string;
  snapshotId: string;
  excerptTruncated: boolean;
  /** Equivalent copies are citations, not additional corroboration. */
  duplicates: Array<{
    catalogId: string;
    sourceId: string;
    externalReference: ExternalReference;
  }>;
};
export type OrganizationalContextBundle = {
  receiptId: string;
  sources: RetrievedContextSource[];
  retrieval: {
    complete: boolean;
    warnings: string[];
    considered: number;
    selected: number;
    characters: number;
  };
};
export interface OrganizationalContext {
  retrieve(request: OrganizationalContextRequest): Promise<OrganizationalContextBundle>;
  /** Check before committing, delivering, or replaying derived output. */
  requireCurrent(request: OrganizationalContextRequest, receiptId: string): Promise<void>;
}

/** Restricted proof capability; it cannot discover context or call prior-Meeting catalogs. */
export interface ExternalContextReceiptVerifier {
  requireCurrent(input: {
    originalRequest: OrganizationalContextRequest;
    receiptId: string;
    audience: ContextAudience;
  }): Promise<{ sources: RetrievedContextSource[] }>;
}
