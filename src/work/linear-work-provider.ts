import { LinearClient, type Issue } from "@linear/sdk";
import type { ExternalReference } from "../domain/model.js";
import type { UpdateWorkItemInput, WorkItem, WorkProvider } from "./interface.js";

const IDEMPOTENCY_MARKER_PREFIX = "luma-idempotency-key:";

export type LinearApiIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string;
  stateType: string;
  stateName: string;
  assignee: {
    id: string;
    displayName: string;
    email: string;
  } | null;
  dueDate: string | null;
  labels: string[];
  projectId: string | null;
  parentId: string | null;
  url: string;
  updatedAt: string;
};

export type LinearCreateIssueInput = {
  teamId: string;
  title: string;
  description: string;
  assigneeId: string | null;
  subscriberIds: string[];
  dueDate: string | null;
  labelNames: string[];
};

export type LinearUpdateIssueInput = {
  teamId: string;
  title?: string;
  description?: string;
  status?: WorkItem["status"];
  assigneeId?: string | null;
  dueDate?: string | null;
};

export interface LinearApi {
  searchIssues(input: {
    teamId: string;
    text: string;
    limit: number;
  }): Promise<LinearApiIssue[]>;
  findIssueByIdempotencyKey(input: {
    teamId: string;
    idempotencyKey: string;
  }): Promise<LinearApiIssue | null>;
  getIssue(id: string): Promise<LinearApiIssue>;
  createIssue(input: LinearCreateIssueInput): Promise<LinearApiIssue>;
  updateIssue(id: string, input: LinearUpdateIssueInput): Promise<LinearApiIssue>;
  addComment(id: string, body: string): Promise<void>;
}

export type LinearWorkProviderConfig = {
  teamId: string;
  apiKey?: string;
  apiUrl?: string;
  providerId?: string;
  api?: LinearApi;
};

export class LinearWorkProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LinearWorkProviderError";
    this.code = code;
  }
}

export function createLinearWorkProvider(config: LinearWorkProviderConfig): WorkProvider {
  const providerId = config.providerId ?? "linear";
  const api = config.api ?? createLinearSdkApi(config);

  return {
    providerId,
    identityProviderId: "linear",
    searchWorkItems: async (query) =>
      (
        await api.searchIssues({
          teamId: config.teamId,
          text: query.text,
          limit: query.limit
        })
      ).map((issue) => toWorkItem(issue, providerId)),
    getWorkItem: async (id) => toWorkItem(await api.getIssue(id), providerId),
    async createWorkItem(input) {
      const existing = await api.findIssueByIdempotencyKey({
        teamId: config.teamId,
        idempotencyKey: input.idempotencyKey
      });

      if (existing) {
        return toExternalReference(existing, providerId);
      }

      const issue = await api.createIssue({
        teamId: config.teamId,
        title: input.title,
        description: withIdempotencyMarker(input.description, input.idempotencyKey),
        assigneeId: input.assigneeProviderUserId,
        subscriberIds: unique(input.mentionProviderUserIds),
        dueDate: input.dueDate,
        labelNames: input.labels
      });
      return toExternalReference(issue, providerId);
    },
    async findCreatedWorkItemByIdempotencyKey(idempotencyKey) {
      const existing = await api.findIssueByIdempotencyKey({
        teamId: config.teamId,
        idempotencyKey
      });
      return existing ? toExternalReference(existing, providerId) : null;
    },
    async updateWorkItem(id, input) {
      const issue = await api.updateIssue(id, toLinearUpdateInput(config.teamId, input));
      return toExternalReference(issue, providerId);
    },
    addComment: (id, body) => api.addComment(id, body)
  };
}

export function createLinearWorkProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env
): WorkProvider {
  const apiKey = requireEnv(env, "LINEAR_API_KEY");
  const teamId = requireEnv(env, "LINEAR_TEAM_ID");
  const config: LinearWorkProviderConfig = { apiKey, teamId };
  const apiUrl = nonBlank(env["LINEAR_API_URL"]);
  const providerId = nonBlank(env["LUMA_LINEAR_PROVIDER_ID"]);

  if (apiUrl) {
    config.apiUrl = apiUrl;
  }

  if (providerId) {
    config.providerId = providerId;
  }

  return createLinearWorkProvider(config);
}

function createLinearSdkApi(config: LinearWorkProviderConfig): LinearApi {
  if (!config.apiKey) {
    throw new LinearWorkProviderError(
      "linear-api-key-missing",
      "LINEAR_API_KEY is required for the Linear WorkProvider"
    );
  }

  return new LinearSdkApi(
    new LinearClient({
      apiKey: config.apiKey,
      ...(config.apiUrl ? { apiUrl: config.apiUrl } : {})
    })
  );
}

class LinearSdkApi implements LinearApi {
  constructor(private readonly client: LinearClient) {}

  async searchIssues(input: {
    teamId: string;
    text: string;
    limit: number;
  }): Promise<LinearApiIssue[]> {
    const result = await this.client.searchIssues(input.text, {
      teamId: input.teamId,
      first: input.limit,
      includeArchived: false
    });
    return Promise.all(
      result.nodes.map(async (issue) =>
        this.toApiIssue(await this.client.issue(issue.id))
      )
    );
  }

  async findIssueByIdempotencyKey(input: {
    teamId: string;
    idempotencyKey: string;
  }): Promise<LinearApiIssue | null> {
    const result = await this.client.issues({
      first: 1,
      filter: {
        team: { id: { eq: input.teamId } },
        description: {
          contains: `${IDEMPOTENCY_MARKER_PREFIX} ${input.idempotencyKey}`
        }
      }
    });
    const issue = result.nodes[0];
    return issue ? this.toApiIssue(issue) : null;
  }

  async getIssue(id: string): Promise<LinearApiIssue> {
    return this.toApiIssue(await this.client.issue(id));
  }

  async createIssue(input: LinearCreateIssueInput): Promise<LinearApiIssue> {
    const labelIds = await this.resolveLabelIds(input.labelNames);
    const payload = await this.client.createIssue({
      teamId: input.teamId,
      title: input.title,
      description: input.description,
      ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
      ...(input.subscriberIds.length > 0 ? { subscriberIds: input.subscriberIds } : {}),
      ...(input.dueDate ? { dueDate: input.dueDate } : {}),
      ...(labelIds.length > 0 ? { labelIds } : {})
    });
    const issue = payload.issue ? await payload.issue : null;

    if (!payload.success || !issue) {
      throw new LinearWorkProviderError(
        "linear-issue-create-failed",
        "Linear did not return the created issue"
      );
    }

    return this.toApiIssue(issue);
  }

  async updateIssue(id: string, input: LinearUpdateIssueInput): Promise<LinearApiIssue> {
    const update: Parameters<LinearClient["updateIssue"]>[1] = {};

    if (input.title !== undefined) {
      update.title = input.title;
    }

    if (input.description !== undefined) {
      update.description = input.description;
    }

    if (input.assigneeId !== undefined) {
      update.assigneeId = input.assigneeId;
    }

    if (input.dueDate !== undefined) {
      update.dueDate = input.dueDate;
    }

    if (input.status !== undefined) {
      update.stateId = await this.resolveStateId(input.teamId, input.status);
    }

    const payload = await this.client.updateIssue(id, update);
    const issue = payload.issue ? await payload.issue : null;

    if (!payload.success || !issue) {
      throw new LinearWorkProviderError(
        "linear-issue-update-failed",
        "Linear did not return the updated issue"
      );
    }

    return this.toApiIssue(issue);
  }

  async addComment(id: string, body: string): Promise<void> {
    const payload = await this.client.createComment({ issueId: id, body });

    if (!payload.success) {
      throw new LinearWorkProviderError(
        "linear-comment-create-failed",
        "Linear did not create the comment"
      );
    }
  }

  private async resolveLabelIds(labelNames: string[]): Promise<string[]> {
    if (labelNames.length === 0) {
      return [];
    }

    const labels = await this.client.issueLabels({
      first: 100,
      filter: { name: { in: unique(labelNames) } }
    });
    return labels.nodes.map((label) => label.id);
  }

  private async resolveStateId(
    teamId: string,
    status: WorkItem["status"]
  ): Promise<string> {
    const states = await this.client.workflowStates({
      first: 100,
      filter: { team: { id: { eq: teamId } } }
    });
    const expectedType = linearStateType(status);
    const state = states.nodes.find((candidate) => candidate.type === expectedType);

    if (!state) {
      throw new LinearWorkProviderError(
        "linear-state-not-found",
        `Linear team ${teamId} has no ${expectedType} workflow state`
      );
    }

    return state.id;
  }

  private async toApiIssue(issue: Issue): Promise<LinearApiIssue> {
    const [assignee, state, labels] = await Promise.all([
      issue.assignee ?? Promise.resolve(undefined),
      issue.state ?? Promise.resolve(undefined),
      issue.labels({ first: 100 })
    ]);

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      stateType: state?.type ?? "backlog",
      stateName: state?.name ?? "Backlog",
      assignee: assignee
        ? {
            id: assignee.id,
            displayName: assignee.displayName,
            email: assignee.email
          }
        : null,
      dueDate: optionalString(issue.dueDate as unknown),
      labels: labels.nodes.map((label) => label.name),
      projectId: issue.projectId ?? null,
      parentId: issue.parentId ?? null,
      url: issue.url,
      updatedAt: issue.updatedAt.toISOString()
    };
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toLinearUpdateInput(
  teamId: string,
  input: UpdateWorkItemInput
): LinearUpdateIssueInput {
  return {
    teamId,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined
      ? {
          description: withIdempotencyMarker(input.description, input.idempotencyKey)
        }
      : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.assigneeProviderUserId !== undefined
      ? { assigneeId: input.assigneeProviderUserId }
      : {}),
    ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {})
  };
}

function toWorkItem(issue: LinearApiIssue, providerId: string): WorkItem {
  return {
    id: issue.id,
    providerId,
    externalId: issue.identifier,
    title: issue.title,
    description: issue.description,
    status: normalizeLinearStatus(issue),
    assignees: issue.assignee
      ? [
          {
            id: issue.assignee.id,
            displayName: issue.assignee.displayName,
            username: issue.assignee.email
          }
        ]
      : [],
    dueDate: issue.dueDate,
    labels: issue.labels,
    projectId: issue.projectId,
    parentId: issue.parentId,
    url: issue.url,
    updatedAt: issue.updatedAt
  };
}

function toExternalReference(
  issue: LinearApiIssue,
  providerId: string
): ExternalReference {
  return {
    providerId,
    objectType: "work-item",
    externalId: issue.identifier,
    url: issue.url,
    version: issue.updatedAt
  };
}

function normalizeLinearStatus(issue: LinearApiIssue): WorkItem["status"] {
  if (issue.labels.some((label) => label.toLowerCase() === "blocked")) {
    return "blocked";
  }

  switch (issue.stateType) {
    case "triage":
    case "backlog":
      return "backlog";
    case "unstarted":
      return "planned";
    case "started":
      return "active";
    case "completed":
      return "completed";
    case "canceled":
    case "duplicate":
      return "cancelled";
    default:
      return "planned";
  }
}

function linearStateType(status: WorkItem["status"]): string {
  switch (status) {
    case "backlog":
      return "backlog";
    case "planned":
      return "unstarted";
    case "active":
    case "blocked":
      return "started";
    case "completed":
      return "completed";
    case "cancelled":
      return "canceled";
  }
}

function withIdempotencyMarker(description: string, idempotencyKey: string): string {
  return `${description.trim()}\n\n<!-- ${IDEMPOTENCY_MARKER_PREFIX} ${idempotencyKey} -->`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = nonBlank(env[key]);

  if (!value) {
    throw new LinearWorkProviderError(
      "linear-config-incomplete",
      `${key} is required for the Linear WorkProvider`
    );
  }

  return value;
}

function nonBlank(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
