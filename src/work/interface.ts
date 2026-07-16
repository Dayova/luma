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

export interface WorkProvider {
  readonly providerId: string;
  readonly identityProviderId?: string;
  searchWorkItems(query: WorkQuery): Promise<WorkItem[]>;
  getWorkItem(id: string): Promise<WorkItem>;
  createWorkItem(input: CreateWorkItemInput): Promise<ExternalReference>;
  updateWorkItem(id: string, input: UpdateWorkItemInput): Promise<ExternalReference>;
  addComment(id: string, body: string): Promise<void>;
}
