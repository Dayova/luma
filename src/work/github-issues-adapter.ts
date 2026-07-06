import { z } from "zod";
import type { ExternalReference, ExternalUser } from "../domain/model.js";
import type {
  CreateWorkItemInput,
  UpdateWorkItemInput,
  WorkItem,
  WorkProvider,
  WorkQuery
} from "./interface.js";

const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const IDEMPOTENCY_MARKER_PREFIX = "luma-idempotency-key:";

const githubUserSchema = z
  .object({
    id: z.number(),
    login: z.string()
  })
  .passthrough();

const githubLabelSchema = z.union([
  z.string(),
  z
    .object({
      name: z.string()
    })
    .passthrough()
]);

const githubIssueSchema = z
  .object({
    id: z.number(),
    number: z.number(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.union([z.literal("open"), z.literal("closed")]),
    state_reason: z.string().nullable().optional(),
    html_url: z.string(),
    updated_at: z.string(),
    assignees: z.array(githubUserSchema).default([]),
    labels: z.array(githubLabelSchema).default([])
  })
  .passthrough();

const githubSearchIssuesSchema = z
  .object({
    items: z.array(githubIssueSchema)
  })
  .passthrough();

type GitHubIssue = z.output<typeof githubIssueSchema>;
type GitHubLabel = z.output<typeof githubLabelSchema>;
type GitHubUser = z.output<typeof githubUserSchema>;

export type GitHubIssuesWorkProviderConfig = {
  token: string;
  owner: string;
  repo: string;
  apiBaseUrl?: string;
  providerId?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
};

export class GitHubIssuesAdapterError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(input: {
    code: string;
    message: string;
    status: number | null;
    retryable: boolean;
  }) {
    super(input.message);
    this.name = "GitHubIssuesAdapterError";
    this.code = input.code;
    this.status = input.status;
    this.retryable = input.retryable;
  }
}

export function createGitHubIssuesWorkProvider(
  config: GitHubIssuesWorkProviderConfig
): WorkProvider {
  const adapter = new GitHubIssuesAdapter(config);

  return {
    searchWorkItems: (query) => adapter.searchWorkItems(query),
    getWorkItem: (id) => adapter.getWorkItem(id),
    createWorkItem: (input) => adapter.createWorkItem(input),
    updateWorkItem: (id, input) => adapter.updateWorkItem(id, input),
    addComment: (id, body) => adapter.addComment(id, body)
  };
}

export function createGitHubIssuesWorkProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env
): WorkProvider {
  const token = env["GITHUB_TOKEN"];
  const repository = env["GITHUB_REPOSITORY"];

  if (!token) {
    throw new GitHubIssuesAdapterError({
      code: "missing-github-token",
      message: "GITHUB_TOKEN is required to configure GitHub Issues WorkProvider",
      status: null,
      retryable: false
    });
  }

  if (!repository) {
    throw new GitHubIssuesAdapterError({
      code: "missing-github-repository",
      message: "GITHUB_REPOSITORY must be set as owner/repo",
      status: null,
      retryable: false
    });
  }

  const [owner, repo] = repository.split("/");

  if (!owner || !repo) {
    throw new GitHubIssuesAdapterError({
      code: "invalid-github-repository",
      message: "GITHUB_REPOSITORY must be set as owner/repo",
      status: null,
      retryable: false
    });
  }

  const config: GitHubIssuesWorkProviderConfig = {
    token,
    owner,
    repo
  };
  const apiBaseUrl = env["GITHUB_API_BASE_URL"];
  const providerId = env["LUMA_GITHUB_WORK_PROVIDER_ID"];
  const userAgent = env["LUMA_GITHUB_USER_AGENT"];

  if (apiBaseUrl) {
    config.apiBaseUrl = apiBaseUrl;
  }

  if (providerId) {
    config.providerId = providerId;
  }

  if (userAgent) {
    config.userAgent = userAgent;
  }

  return createGitHubIssuesWorkProvider(config);
}

class GitHubIssuesAdapter implements WorkProvider {
  private readonly token: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly apiBaseUrl: string;
  private readonly providerId: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: GitHubIssuesWorkProviderConfig) {
    this.token = config.token;
    this.owner = config.owner;
    this.repo = config.repo;
    this.apiBaseUrl = config.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL;
    this.providerId = config.providerId ?? "github-issues";
    this.userAgent = config.userAgent ?? "luma-meeting-intelligence";
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async searchWorkItems(query: WorkQuery): Promise<WorkItem[]> {
    const githubQuery = `repo:${this.owner}/${this.repo} is:issue ${query.text}`;
    const result = await this.request(
      `/search/issues?q=${encodeURIComponent(githubQuery)}&per_page=${query.limit}`,
      {
        method: "GET",
        schema: githubSearchIssuesSchema
      }
    );

    return result.items.map((issue) => this.toWorkItem(issue));
  }

  async getWorkItem(id: string): Promise<WorkItem> {
    const issue = await this.getIssue(id);
    return this.toWorkItem(issue);
  }

  async createWorkItem(input: CreateWorkItemInput): Promise<ExternalReference> {
    const existing = await this.findExistingIssueByIdempotencyKey(input.idempotencyKey);

    if (existing) {
      return this.toExternalReference(existing);
    }

    const issue = await this.request(`/repos/${this.owner}/${this.repo}/issues`, {
      method: "POST",
      schema: githubIssueSchema,
      body: {
        title: input.title,
        body: renderIssueBody(input),
        assignees: input.assigneeProviderUserId ? [input.assigneeProviderUserId] : [],
        labels: input.labels
      }
    });

    return this.toExternalReference(issue);
  }

  async updateWorkItem(
    id: string,
    input: UpdateWorkItemInput
  ): Promise<ExternalReference> {
    const body: Record<string, unknown> = {};

    if (input.title !== undefined) {
      body["title"] = input.title;
    }

    if (input.description !== undefined || input.dueDate !== undefined) {
      body["body"] = renderUpdatedIssueBody(input);
    }

    if (input.status !== undefined) {
      body["state"] =
        input.status === "completed" || input.status === "cancelled" ? "closed" : "open";
    }

    if (input.assigneeProviderUserId !== undefined) {
      body["assignees"] = input.assigneeProviderUserId
        ? [input.assigneeProviderUserId]
        : [];
    }

    const issue = await this.request(
      `/repos/${this.owner}/${this.repo}/issues/${parseIssueNumber(id)}`,
      {
        method: "PATCH",
        schema: githubIssueSchema,
        body
      }
    );

    return this.toExternalReference(issue);
  }

  async addComment(id: string, body: string): Promise<void> {
    await this.request(
      `/repos/${this.owner}/${this.repo}/issues/${parseIssueNumber(id)}/comments`,
      {
        method: "POST",
        schema: z.unknown(),
        body: {
          body
        }
      }
    );
  }

  private async getIssue(id: string): Promise<GitHubIssue> {
    return this.request(
      `/repos/${this.owner}/${this.repo}/issues/${parseIssueNumber(id)}`,
      {
        method: "GET",
        schema: githubIssueSchema
      }
    );
  }

  private async findExistingIssueByIdempotencyKey(
    idempotencyKey: string
  ): Promise<GitHubIssue | null> {
    const marker = `${IDEMPOTENCY_MARKER_PREFIX} ${idempotencyKey}`;
    const githubQuery = `repo:${this.owner}/${this.repo} is:issue "${marker}"`;
    const result = await this.request(
      `/search/issues?q=${encodeURIComponent(githubQuery)}&per_page=1`,
      {
        method: "GET",
        schema: githubSearchIssuesSchema
      }
    );

    return result.items[0] ?? null;
  }

  private async request<Schema extends z.ZodTypeAny>(
    path: string,
    options: {
      method: "GET" | "POST" | "PATCH";
      schema: Schema;
      body?: Record<string, unknown>;
    }
  ): Promise<z.output<Schema>> {
    const requestInit: RequestInit = {
      method: options.method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": this.userAgent,
        "X-GitHub-Api-Version": GITHUB_API_VERSION
      }
    };

    if (options.body) {
      requestInit.body = JSON.stringify(options.body);
    }

    const response = await this.fetchImpl(
      `${trimTrailingSlash(this.apiBaseUrl)}${path}`,
      requestInit
    );

    if (!response.ok) {
      throw new GitHubIssuesAdapterError({
        code: "github-request-failed",
        message: await readErrorMessage(response),
        status: response.status,
        retryable: response.status === 429 || response.status >= 500
      });
    }

    const raw = await response.json();
    const parsed = options.schema.parse(raw) as z.output<Schema>;
    return parsed;
  }

  private toWorkItem(issue: GitHubIssue): WorkItem {
    return {
      id: `${this.owner}/${this.repo}#${issue.number}`,
      providerId: this.providerId,
      externalId: String(issue.number),
      title: issue.title,
      description: issue.body ?? "",
      status: mapGitHubStatus(issue),
      assignees: issue.assignees.map(toExternalUser),
      dueDate: readGeneratedDueDate(issue.body),
      labels: issue.labels.map(readLabelName),
      projectId: null,
      parentId: null,
      url: issue.html_url,
      updatedAt: issue.updated_at
    };
  }

  private toExternalReference(issue: GitHubIssue): ExternalReference {
    return {
      providerId: this.providerId,
      objectType: "work-item",
      externalId: String(issue.number),
      url: issue.html_url,
      version: issue.updated_at
    };
  }
}

function renderIssueBody(input: CreateWorkItemInput): string {
  return [
    input.description.trim(),
    "",
    "<!-- luma-generated-section-start -->",
    input.dueDate ? `Due date: ${input.dueDate}` : "Due date: not confirmed",
    `<!-- ${IDEMPOTENCY_MARKER_PREFIX} ${input.idempotencyKey} -->`,
    "<!-- luma-generated-section-end -->"
  ].join("\n");
}

function renderUpdatedIssueBody(input: UpdateWorkItemInput): string {
  return [
    input.description?.trim() ?? "",
    "",
    "<!-- luma-generated-section-start -->",
    input.dueDate ? `Due date: ${input.dueDate}` : "Due date: not confirmed",
    `<!-- ${IDEMPOTENCY_MARKER_PREFIX} ${input.idempotencyKey} -->`,
    "<!-- luma-generated-section-end -->"
  ].join("\n");
}

function readGeneratedDueDate(body: string | null): string | null {
  const match = body?.match(/^Due date: (\d{4}-\d{2}-\d{2})$/m);
  return match?.[1] ?? null;
}

function readLabelName(label: GitHubLabel): string {
  return typeof label === "string" ? label : label.name;
}

function mapGitHubStatus(issue: GitHubIssue): WorkItem["status"] {
  const labels = new Set(issue.labels.map(readLabelName));

  if (issue.state === "closed") {
    return issue.state_reason === "not_planned" ? "cancelled" : "completed";
  }

  if (labels.has("blocked")) {
    return "blocked";
  }

  if (labels.has("planned")) {
    return "planned";
  }

  if (labels.has("backlog")) {
    return "backlog";
  }

  return "active";
}

function toExternalUser(user: GitHubUser): ExternalUser {
  return {
    id: String(user.id),
    displayName: user.login,
    username: user.login
  };
}

function parseIssueNumber(id: string): number {
  const match = id.match(/(?:#|^)(\d+)$/);
  const value = match?.[1];

  if (!value) {
    throw new GitHubIssuesAdapterError({
      code: "invalid-work-item-id",
      message: `Expected a GitHub issue number or owner/repo#number, got ${id}`,
      status: null,
      retryable: false
    });
  }

  return Number(value);
}

function trimTrailingSlash(input: string): string {
  return input.replace(/\/$/, "");
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > 0
    ? `GitHub request failed with ${response.status}: ${text}`
    : `GitHub request failed with ${response.status}`;
}
