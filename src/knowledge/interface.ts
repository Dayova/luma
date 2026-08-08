import type { ExternalReference, ExternalUser } from "../domain/model.js";

export type AccessPolicy = {
  visibility: "private" | "shared" | "public";
  authorizedPrincipalIds: string[];
};

export type ChangePage = {
  changes: KnowledgeDocument[];
  nextCursor: string | null;
};

export type KnowledgeQuery = {
  workspaceId: string;
  text: string;
  limit: number;
  permissionPrincipalId: string;
};

export type KnowledgeResult = {
  document: KnowledgeDocument;
  score: number;
};

export type KnowledgeDocument = {
  id: string;
  providerId: string;
  externalId: string;
  title: string;
  contentMarkdown: string;
  parentId: string | null;
  url: string;
  version: string;
  updatedAt: string;
  updatedBy: ExternalUser | null;
  permissions: AccessPolicy;
  metadata: Record<string, unknown>;
};

export type CreateDocumentInput = {
  title: string;
  contentMarkdown: string;
  parentId: string | null;
  participantProviderUserIds?: string[];
  idempotencyKey: string;
};

export type UpdateDocumentInput = {
  contentMarkdown: string;
  expectedVersion?: string;
  idempotencyKey: string;
};

export interface KnowledgeProvider {
  readonly providerId: string;
  readonly identityProviderId?: string;
  search(query: KnowledgeQuery): Promise<KnowledgeResult[]>;
  getDocument(id: string): Promise<KnowledgeDocument>;
  createDocument(input: CreateDocumentInput): Promise<ExternalReference>;
  /**
   * Optional positive-only recovery probe for a previously attempted create.
   * `null` means the provider cannot prove a document exists; it never grants
   * permission to repeat an indeterminate mutation automatically.
   */
  findCreatedDocumentByIdempotencyKey?(
    idempotencyKey: string
  ): Promise<ExternalReference | null>;
  updateDocument(id: string, input: UpdateDocumentInput): Promise<ExternalReference>;
  listChanges(cursor?: string): Promise<ChangePage>;
}
