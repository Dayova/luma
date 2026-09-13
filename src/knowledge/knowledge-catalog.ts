import type { ExternalReference, PersonId, WorkspaceId } from "../domain/model.js";
import type { KnowledgeStanding } from "../domain/knowledge-standing.js";

export type KnowledgeAudience = { workspaceId: WorkspaceId; personIds: PersonId[] };
export type ReadableKnowledgeDocument = {
  id: string;
  title: string;
  contentMarkdown: string;
  version: string;
  updatedAt: string;
  externalReference: ExternalReference;
  /** Explicit source metadata, not inferred from dates, prose or workflow completion. */
  standing?: KnowledgeStanding;
};

/** Audience-scoped reads only. It neither narrows nor exposes a KnowledgeProvider. */
export interface KnowledgeCatalog {
  readonly id: string;
  listDocumentIds(input: {
    audience: KnowledgeAudience;
    limit: number;
  }): Promise<{ documentIds: string[]; complete: boolean; warnings: string[] }>;
  readDocument(input: {
    audience: KnowledgeAudience;
    documentId: string;
  }): Promise<ReadableKnowledgeDocument | null>;
}
