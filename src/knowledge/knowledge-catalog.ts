import type { ExternalReference, PersonId, WorkspaceId } from "../domain/model.js";

export type KnowledgeAudience = { workspaceId: WorkspaceId; personIds: PersonId[] };
export type ReadableKnowledgeDocument = {
  id: string;
  title: string;
  contentMarkdown: string;
  version: string;
  updatedAt: string;
  externalReference: ExternalReference;
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
