import type { ExternalReference, ExternalUser } from "../domain/model.js";

export type WorkQuery = {
  workspaceId: string;
  text: string;
  limit: number;
};

export type WorkItem = {
  id: string;
  providerId: string;
  externalId: string;
  title: string;
  description: string;
  status: "backlog" | "planned" | "active" | "blocked" | "completed" | "cancelled";
  assignees: ExternalUser[];
  dueDate: string | null;
  labels: string[];
  projectId: string | null;
  parentId: string | null;
  url: string;
  updatedAt: string;
};

export type CreateWorkItemInput = {
  title: string;
  description: string;
  assigneeProviderUserId: string | null;
  mentionProviderUserIds: string[];
  dueDate: string | null;
  labels: string[];
  idempotencyKey: string;
};

export type UpdateWorkItemInput = {
  title?: string;
  description?: string;
  status?: WorkItem["status"];
  assigneeProviderUserId?: string | null;
  dueDate?: string | null;
  idempotencyKey: string;
};

/** A provider-owned compare-and-swap update. `null` means the expected version changed. */
export type ConditionalUpdateWorkItemInput = UpdateWorkItemInput & {
  expectedUpdatedAt: string;
};

/**
 * The read-only work capability used by Meeting Intelligence. Keeping this
 * separate from WorkProvider makes reconciliation unable to mutate a tracker.
 */
export interface WorkCatalog {
  readonly providerId: string;
  readonly identityProviderId?: string;
  /**
   * True only when the matching writer can perform a provider-owned
   * compare-and-swap update. Reconciliation uses this capability to keep an
   * unsafe tracker update reviewable instead of producing an executable write.
   */
  readonly supportsConditionalUpdates?: boolean;
  searchWorkItems(query: WorkQuery): Promise<WorkItem[]>;
  getWorkItem(id: string): Promise<WorkItem>;
}

export interface WorkProvider extends WorkCatalog {
  createWorkItem(input: CreateWorkItemInput): Promise<ExternalReference>;
  /**
   * Optional positive-only recovery probe for a previously attempted create.
   * `null` is indeterminate rather than proof that another create is safe.
   */
  findCreatedWorkItemByIdempotencyKey?(
    idempotencyKey: string
  ): Promise<ExternalReference | null>;
  updateWorkItem(id: string, input: UpdateWorkItemInput): Promise<ExternalReference>;
  /**
   * Optional because not every tracker exposes server-side optimistic concurrency.
   * Follow-up Execution never falls back to an unconditional update for a
   * reconciliation-derived intent.
   */
  updateWorkItemIfCurrent?(
    id: string,
    input: ConditionalUpdateWorkItemInput
  ): Promise<ExternalReference | null>;
  addComment(id: string, body: string): Promise<void>;
}

/**
 * Narrows a writer-capable provider before it enters Meeting Intelligence.
 * The returned object deliberately exposes no external mutation methods.
 */
export function toWorkCatalog(provider: WorkProvider): WorkCatalog {
  return {
    providerId: provider.providerId,
    ...(provider.identityProviderId
      ? { identityProviderId: provider.identityProviderId }
      : {}),
    supportsConditionalUpdates: typeof provider.updateWorkItemIfCurrent === "function",
    searchWorkItems: (query) => provider.searchWorkItems(query),
    getWorkItem: (id) => provider.getWorkItem(id)
  };
}
