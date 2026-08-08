import { createSign } from "node:crypto";
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
const INSTALLATION_TOKEN_REFRESH_SKEW_MS = 60_000;

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

const githubInstallationAccessTokenSchema = z
  .object({
    token: z.string(),
    expires_at: z.string()
  })
  .passthrough();

type GitHubIssue = z.output<typeof githubIssueSchema>;
type GitHubLabel = z.output<typeof githubLabelSchema>;
type GitHubUser = z.output<typeof githubUserSchema>;

export type GitHubIssuesAuthConfig =
  | {
      type: "token";
      token: string;
    }
  | {
      type: "github-app";
      appId: string;
      installationId: string;
      privateKey: string;
    };

export type GitHubIssuesWorkProviderConfig = {
  token?: string;
  auth?: GitHubIssuesAuthConfig;
  owner: string;
  repo: string;
  apiBaseUrl?: string;
  providerId?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
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
    providerId: adapter.providerId,
    identityProviderId: "github-issues",
    searchWorkItems: (query) => adapter.searchWorkItems(query),
    getWorkItem: (id) => adapter.getWorkItem(id),
    createWorkItem: (input) => adapter.createWorkItem(input),
    findCreatedWorkItemByIdempotencyKey: (idempotencyKey) =>
      adapter.findCreatedWorkItemByIdempotencyKey(idempotencyKey),
    updateWorkItem: (id, input) => adapter.updateWorkItem(id, input),
    addComment: (id, body) => adapter.addComment(id, body)
  };
}

export function createGitHubIssuesWorkProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env
): WorkProvider {
  const repository = env["GITHUB_REPOSITORY"];

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
    owner,
    repo,
    auth: authFromEnv(env)
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
  private readonly auth: GitHubIssuesAuthConfig;
  private readonly owner: string;
  private readonly repo: string;
  private readonly apiBaseUrl: string;
  readonly providerId: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private cachedInstallationAccessToken: {
    token: string;
    expiresAtMs: number;
  } | null = null;

  constructor(config: GitHubIssuesWorkProviderConfig) {
    this.auth = normalizeAuthConfig(config);
    this.owner = config.owner;
    this.repo = config.repo;
    this.apiBaseUrl = config.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL;
    this.providerId = config.providerId ?? "github-issues";
    this.userAgent = config.userAgent ?? "luma-meeting-intelligence";
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? (() => new Date());
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

  async findCreatedWorkItemByIdempotencyKey(
    idempotencyKey: string
  ): Promise<ExternalReference | null> {
    const existing = await this.findExistingIssueByIdempotencyKey(idempotencyKey);
    return existing ? this.toExternalReference(existing) : null;
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
    // Tuple keys are canonical JSON and therefore contain quotes. JSON string
    // encoding is also valid GitHub-search phrase escaping, so the marker
    // remains one exact phrase instead of terminating the query early.
    const githubQuery = `repo:${this.owner}/${this.repo} is:issue ${JSON.stringify(marker)}`;
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
        Authorization: await this.authorizationHeader(),
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

  private async authorizationHeader(): Promise<string> {
    switch (this.auth.type) {
      case "token":
        return `Bearer ${this.auth.token}`;
      case "github-app":
        return `Bearer ${await this.getInstallationAccessToken(this.auth)}`;
    }
  }

  private async getInstallationAccessToken(
    auth: Extract<GitHubIssuesAuthConfig, { type: "github-app" }>
  ): Promise<string> {
    const nowMs = this.now().getTime();

    if (
      this.cachedInstallationAccessToken &&
      this.cachedInstallationAccessToken.expiresAtMs -
        INSTALLATION_TOKEN_REFRESH_SKEW_MS >
        nowMs
    ) {
      return this.cachedInstallationAccessToken.token;
    }

    const jwt = createGitHubAppJwt({
      appId: auth.appId,
      privateKey: auth.privateKey,
      now: this.now
    });
    const response = await this.fetchImpl(
      `${trimTrailingSlash(this.apiBaseUrl)}/app/installations/${auth.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
          "User-Agent": this.userAgent,
          "X-GitHub-Api-Version": GITHUB_API_VERSION
        }
      }
    );

    if (!response.ok) {
      throw new GitHubIssuesAdapterError({
        code: "github-app-token-request-failed",
        message: await readErrorMessage(response),
        status: response.status,
        retryable: response.status === 429 || response.status >= 500
      });
    }

    const raw = await response.json();
    const parsed = githubInstallationAccessTokenSchema.parse(raw);
    const expiresAtMs = Date.parse(parsed.expires_at);

    if (!Number.isFinite(expiresAtMs)) {
      throw new GitHubIssuesAdapterError({
        code: "invalid-github-app-token-expiration",
        message: "GitHub returned an installation token without a valid expires_at",
        status: null,
        retryable: true
      });
    }

    this.cachedInstallationAccessToken = {
      token: parsed.token,
      expiresAtMs
    };

    return parsed.token;
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
    renderMentions(input.mentionProviderUserIds),
    "",
    "<!-- luma-generated-section-start -->",
    input.dueDate ? `Due date: ${input.dueDate}` : "Due date: not confirmed",
    `<!-- ${IDEMPOTENCY_MARKER_PREFIX} ${input.idempotencyKey} -->`,
    "<!-- luma-generated-section-end -->"
  ].join("\n");
}

function renderMentions(mentionProviderUserIds: string[]): string {
  if (mentionProviderUserIds.length === 0) {
    return "";
  }

  return `\ncc ${mentionProviderUserIds.map((login) => `@${login}`).join(" ")}`;
}

function normalizeAuthConfig(
  config: GitHubIssuesWorkProviderConfig
): GitHubIssuesAuthConfig {
  if (config.auth) {
    return config.auth;
  }

  if (config.token) {
    return {
      type: "token",
      token: config.token
    };
  }

  throw new GitHubIssuesAdapterError({
    code: "missing-github-auth",
    message: "Configure GitHub Issues with GitHub App credentials or a token fallback",
    status: null,
    retryable: false
  });
}

function authFromEnv(env: NodeJS.ProcessEnv): GitHubIssuesAuthConfig {
  const appId = nonBlankEnvValue(env["GITHUB_APP_ID"]);
  const installationId = nonBlankEnvValue(env["GITHUB_APP_INSTALLATION_ID"]);
  const privateKey =
    nonBlankEnvValue(env["GITHUB_APP_PRIVATE_KEY"]) ??
    decodeBase64PrivateKey(nonBlankEnvValue(env["GITHUB_APP_PRIVATE_KEY_BASE64"]));

  if (appId || installationId || privateKey) {
    if (!appId || !installationId || !privateKey) {
      throw new GitHubIssuesAdapterError({
        code: "incomplete-github-app-auth",
        message:
          "GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, and GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_BASE64 are required for bot-authored GitHub activity",
        status: null,
        retryable: false
      });
    }

    return {
      type: "github-app",
      appId,
      installationId,
      privateKey
    };
  }

  const token = nonBlankEnvValue(env["GITHUB_TOKEN"]);

  if (token) {
    return {
      type: "token",
      token
    };
  }

  throw new GitHubIssuesAdapterError({
    code: "missing-github-auth",
    message:
      "Configure GitHub App credentials for bot-authored activity, or GITHUB_TOKEN for local user-authored development fallback",
    status: null,
    retryable: false
  });
}

function nonBlankEnvValue(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

function decodeBase64PrivateKey(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return Buffer.from(value, "base64").toString("utf8");
}

function createGitHubAppJwt(input: {
  appId: string;
  privateKey: string;
  now: () => Date;
}): string {
  const nowSeconds = Math.floor(input.now().getTime() / 1000);
  const issuedAt = nowSeconds - 60;
  const expiresAt = nowSeconds + 9 * 60;
  const encodedHeader = base64UrlEncode(
    JSON.stringify({
      alg: "RS256",
      typ: "JWT"
    })
  );
  const encodedPayload = base64UrlEncode(
    JSON.stringify({
      iat: issuedAt,
      exp: expiresAt,
      iss: input.appId
    })
  );
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = createSign("RSA-SHA256")
    .update(unsignedToken)
    .end()
    .sign(normalizePrivateKey(input.privateKey));

  return `${unsignedToken}.${base64UrlEncode(signature)}`;
}

function normalizePrivateKey(privateKey: string): string {
  return privateKey.replace(/\\n/g, "\n");
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
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
