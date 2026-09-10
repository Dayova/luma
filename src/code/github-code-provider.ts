import { createHash } from "node:crypto";
import { z } from "zod";
import type { ExternalUser } from "../domain/model.js";
import type {
  CodeActivity,
  CodeActivityResult,
  CodeChange,
  CodeProvider,
  CodeReadCoverage,
  CodeSearchQuery,
  CodeSearchResponse,
  Commit,
  RepositoryActivityQuery
} from "./interface.js";

const API_VERSION = "2026-03-10";
const shaSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/i)
  .transform((sha) => sha.toLowerCase());
const timeSchema = z.string().datetime({ offset: true });
const userSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1)
});
const commitSchema = z.object({
  sha: shaSchema,
  html_url: z.string(),
  author: userSchema.nullable(),
  commit: z.object({
    message: z.string(),
    committer: z.object({ date: timeSchema })
  })
});
const pullSchema = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  user: userSchema,
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged: z.boolean(),
  html_url: z.string(),
  updated_at: timeSchema,
  head: z.object({ sha: shaSchema }),
  base: z.object({ sha: shaSchema, repo: z.object({ full_name: z.string() }) }),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changed_files: z.number().int().nonnegative(),
  commits: z.number().int().nonnegative(),
  requested_reviewers: z.array(userSchema),
  requested_teams: z.array(z.unknown())
});
const searchSchema = z.object({
  total_count: z.number().int().nonnegative(),
  incomplete_results: z.boolean(),
  items: z.array(
    z.object({
      path: z.string(),
      sha: shaSchema,
      html_url: z.string(),
      repository: z.object({ full_name: z.string() })
    })
  )
});
const contentSchema = z.object({
  type: z.literal("file"),
  path: z.string(),
  sha: shaSchema,
  size: z.number().int().nonnegative(),
  encoding: z.literal("base64"),
  content: z.string()
});
const eventSchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  created_at: timeSchema,
  repo: z.object({ name: z.string() }),
  payload: z.unknown()
});

export type GitHubCodeProviderConfig = {
  /** A separately provisioned read-only token; never a writer-token fallback. */
  token: string;
  credentialScopeId: string;
  repositories: readonly string[];
  providerId?: string;
  /** Explicit trusted GitHub Enterprise endpoints, if not github.com. */
  apiBaseUrl?: string;
  webBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  requestTimeoutMs?: number;
  operationTimeoutMs?: number;
  maxRequests?: number;
  maxPages?: number;
  maxResponseBytes?: number;
  maxFileBytes?: number;
};

export class GitHubCodeProviderError extends Error {
  constructor(
    readonly code:
      | "configuration-invalid"
      | "repository-not-allowed"
      | "query-invalid"
      | "read-limit"
      | "timeout"
      | "rate-limited"
      | "access-denied"
      | "not-found"
      | "unavailable"
      | "response-invalid"
      | "source-changed",
    readonly retryable: boolean,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null
  ) {
    super(`GitHub code read failed: ${code}.`);
    this.name = "GitHubCodeProviderError";
  }
}

type ReadContext = { signal: AbortSignal; remaining: number };
type JsonResponse = { value: unknown; next: boolean };

export function createGitHubCodeProvider(config: GitHubCodeProviderConfig): CodeProvider {
  return new GitHubCodeReader(config);
}

export function createGitHubCodeProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env
): CodeProvider {
  return createGitHubCodeProvider({
    token: env["LUMA_GITHUB_CODE_READONLY_TOKEN"] ?? "",
    credentialScopeId: env["LUMA_GITHUB_CODE_CREDENTIAL_SCOPE_ID"] ?? "",
    repositories: (env["LUMA_GITHUB_CODE_REPOSITORIES"] ?? "")
      .split(",")
      .map((item) => item.trim()),
    ...(env["LUMA_GITHUB_CODE_PROVIDER_ID"]
      ? { providerId: env["LUMA_GITHUB_CODE_PROVIDER_ID"] }
      : {}),
    ...(env["LUMA_GITHUB_CODE_API_BASE_URL"]
      ? { apiBaseUrl: env["LUMA_GITHUB_CODE_API_BASE_URL"] }
      : {}),
    ...(env["LUMA_GITHUB_CODE_WEB_BASE_URL"]
      ? { webBaseUrl: env["LUMA_GITHUB_CODE_WEB_BASE_URL"] }
      : {})
  });
}

class GitHubCodeReader implements CodeProvider {
  readonly providerId: string;
  readonly readScope: CodeProvider["readScope"];
  private readonly api: URL;
  private readonly web: URL;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly requestTimeoutMs: number;
  private readonly operationTimeoutMs: number;
  private readonly maxRequests: number;
  private readonly maxPages: number;
  private readonly maxResponseBytes: number;
  private readonly maxFileBytes: number;

  constructor(config: GitHubCodeProviderConfig) {
    if (
      !config.token.trim() ||
      /[\r\n]/u.test(config.token) ||
      !config.credentialScopeId.trim()
    )
      fail("configuration-invalid");
    const repositories = config.repositories.map(repositoryName);
    if (
      repositories.length === 0 ||
      repositories.length > 50 ||
      new Set(repositories).size !== repositories.length
    )
      fail("configuration-invalid");
    this.readScope = Object.freeze({
      credentialScopeId: config.credentialScopeId.trim(),
      repositories: Object.freeze(repositories)
    });
    this.providerId = config.providerId?.trim() || "github-code";
    this.api = baseUrl(config.apiBaseUrl ?? "https://api.github.com");
    this.web = baseUrl(config.webBaseUrl ?? "https://github.com");
    if (this.web.pathname !== "/") fail("configuration-invalid");
    this.token = config.token;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? (() => new Date());
    this.requestTimeoutMs = bound(config.requestTimeoutMs ?? 10_000, 1, 60_000);
    this.operationTimeoutMs = bound(config.operationTimeoutMs ?? 30_000, 1, 120_000);
    this.maxRequests = bound(config.maxRequests ?? 40, 1, 100);
    this.maxPages = bound(config.maxPages ?? 3, 1, 10);
    this.maxResponseBytes = bound(config.maxResponseBytes ?? 2_000_000, 128, 8_000_000);
    this.maxFileBytes = bound(config.maxFileBytes ?? 128_000, 1, 384_000);
  }

  async getCommit(repository: string, sha: string): Promise<Commit> {
    const repo = this.allowed(repository);
    const revision = parseInput(shaSchema, sha);
    return this.read((context) => this.commit(repo, revision, context));
  }

  async getPullRequest(repository: string, number: number): Promise<CodeChange> {
    const repo = this.allowed(repository);
    if (!Number.isSafeInteger(number) || number < 1) fail("query-invalid");
    return this.read(async (context) => {
      const path = `/repos/${repo}/pulls/${number}`;
      const initial = parse(pullSchema, (await this.get(path, context)).value);
      if (
        initial.number !== number ||
        repositoryName(initial.base.repo.full_name) !== repo
      )
        fail("response-invalid");
      this.checkWeb(initial.html_url, `${repo}/pull/${number}`);
      const files = await this.pages(
        `${path}/files`,
        z.object({ filename: z.string() }),
        context
      );
      const commits = await this.pages(
        `${path}/commits`,
        z.object({ sha: shaSchema, html_url: z.string() }),
        context
      );
      const reviews = await this.pages(
        `${path}/reviews`,
        z.object({ user: userSchema.nullable() }),
        context
      );
      const final = parse(pullSchema, (await this.get(path, context)).value);
      if (JSON.stringify(final) !== JSON.stringify(initial)) fail("source-changed", true);
      const fileNames = files.items.map((item) => filePath(item.filename));
      const commitReferences = commits.items.map((item) => {
        this.checkWeb(item.html_url, `${repo}/commit/${item.sha}`);
        return {
          repository: repo,
          sha: item.sha,
          url: this.webUrl(`${repo}/commit/${item.sha}`)
        };
      });
      const reviewers = new Map(
        initial.requested_reviewers.map((user) => [user.id, externalUser(user)])
      );
      for (const review of reviews.items)
        if (review.user) reviewers.set(review.user.id, externalUser(review.user));
      const warnings = [
        "Linked work relationships are not verified by this read-only code provider.",
        ...files.warnings,
        ...commits.warnings,
        ...reviews.warnings
      ];
      if (
        fileNames.length !== initial.changed_files ||
        new Set(fileNames).size !== fileNames.length
      )
        warnings.push("The changed-file list is incomplete or inconsistent.");
      if (
        commitReferences.length !== initial.commits ||
        new Set(commitReferences.map((item) => item.sha)).size !== commitReferences.length
      )
        warnings.push(
          "The PR commit list is incomplete; GitHub exposes at most 250 PR commits."
        );
      if (initial.requested_teams.length > 0)
        warnings.push("Requested review teams have not been expanded into people.");
      return {
        id: String(initial.id),
        providerId: this.providerId,
        repository: repo,
        number,
        title: initial.title,
        description: initial.body ?? "",
        author: externalUser(initial.user),
        reviewers: [...reviewers.values()],
        state: initial.merged
          ? "merged"
          : initial.state === "closed"
            ? "closed"
            : initial.draft
              ? "draft"
              : "open",
        additions: initial.additions,
        deletions: initial.deletions,
        filesChanged: [...new Set(fileNames)],
        commits: commitReferences,
        linkedWorkItemIds: [],
        url: this.webUrl(`${repo}/pull/${number}`),
        headSha: initial.head.sha,
        baseSha: initial.base.sha,
        updatedAt: initial.updated_at,
        observedAt: this.now().toISOString(),
        coverage: coverage(warnings)
      };
    });
  }

  async searchCode(query: CodeSearchQuery): Promise<CodeSearchResponse> {
    const repo = this.allowed(query.repository);
    const text = query.text.trim();
    // A literal phrase cannot inject repository/organization qualifiers.
    if (
      !text ||
      text.length > 200 ||
      /[:"\\]/u.test(text) ||
      hasControlCharacters(text) ||
      !Number.isInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 20
    )
      fail("query-invalid");
    return this.read(async (context) => {
      const repository = parse(
        z.object({
          full_name: z.string(),
          default_branch: z.string().min(1),
          html_url: z.string()
        }),
        (await this.get(`/repos/${repo}`, context)).value
      );
      if (repositoryName(repository.full_name) !== repo) fail("response-invalid");
      this.checkWeb(repository.html_url, repo);
      const headPath = `/repos/${repo}/commits/${encodeURIComponent(`heads/${repository.default_branch}`)}`;
      const head = parse(commitSchema, (await this.get(headPath, context)).value);
      this.checkWeb(head.html_url, `${repo}/commit/${head.sha}`);
      const q = `repo:${repo} in:file "${text}"`;
      const searchPath = `/search/code?q=${encodeURIComponent(q)}&per_page=${query.limit}&page=1`;
      const response = await this.get(searchPath, context);
      const search = parse(searchSchema, response.value);
      const warnings = [
        "GitHub code search is a default-branch index with file/index limits; absence of a match is not proof of absence."
      ];
      if (search.incomplete_results)
        warnings.push("GitHub reported incomplete search results.");
      if (response.next || search.total_count > query.limit)
        warnings.push("More indexed matches exist beyond the requested result limit.");
      const results: CodeSearchResponse["results"] = [];
      const seen = new Set<string>();
      for (const item of search.items.slice(0, query.limit)) {
        if (repositoryName(item.repository.full_name) !== repo) fail("response-invalid");
        const path = filePath(item.path);
        this.checkWebPrefix(item.html_url, `${repo}/blob/`);
        if (seen.has(path)) {
          warnings.push("GitHub returned a repeated search path.");
          continue;
        }
        seen.add(path);
        try {
          const content = parse(
            contentSchema,
            (
              await this.get(
                `/repos/${repo}/contents/${encodePath(path)}?ref=${head.sha}`,
                context
              )
            ).value
          );
          if (content.path !== path) fail("response-invalid");
          if (content.size > this.maxFileBytes) {
            warnings.push("A matching file exceeds the configured byte limit.");
            continue;
          }
          const bytes = decodeBlob(content.content, content.size, content.sha);
          if (content.sha !== item.sha) {
            warnings.push(
              "An indexed match differs from the pinned default-branch revision."
            );
            continue;
          }
          let source: string;
          try {
            source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            warnings.push("A matching file is not readable UTF-8 text.");
            continue;
          }
          if (source.includes("\0")) {
            warnings.push("A matching file is binary content.");
            continue;
          }
          const excerpt = excerptAt(source, text);
          if (!excerpt) {
            warnings.push("An indexed phrase could not be verified in the pinned file.");
            continue;
          }
          results.push({
            repository: repo,
            path,
            ...excerpt,
            commitSha: head.sha,
            blobSha: content.sha,
            url: `${this.webUrl(`${repo}/blob/${head.sha}/${encodePath(path)}`)}#L${excerpt.startLine}-L${excerpt.endLine}`
          });
        } catch (error) {
          if (
            !(error instanceof GitHubCodeProviderError) ||
            error.code === "response-invalid"
          )
            throw error;
          warnings.push(`A matching file could not be read (${error.code}).`);
          if (
            error.code === "timeout" ||
            error.code === "read-limit" ||
            error.code === "rate-limited"
          )
            break;
        }
      }
      // Currentness is observed, not an atomic promise over future reads.
      const finalRepository = parse(
        z.object({ full_name: z.string(), default_branch: z.string() }),
        (await this.get(`/repos/${repo}`, context)).value
      );
      if (repositoryName(finalRepository.full_name) !== repo) fail("response-invalid");
      if (finalRepository.default_branch !== repository.default_branch)
        fail("source-changed", true);
      const finalHead = parse(commitSchema, (await this.get(headPath, context)).value);
      this.checkWeb(finalHead.html_url, `${repo}/commit/${finalHead.sha}`);
      if (finalHead.sha !== head.sha) fail("source-changed", true);
      return {
        results,
        commitSha: head.sha,
        coverage: coverage(warnings),
        observedAt: this.now().toISOString()
      };
    });
  }

  async getRecentActivity(query: RepositoryActivityQuery): Promise<CodeActivityResult> {
    const repo = this.allowed(query.repository);
    const since = Date.parse(parseInput(timeSchema, query.since));
    const until = query.until
      ? Date.parse(parseInput(timeSchema, query.until))
      : this.now().getTime();
    if (since > until) fail("query-invalid");
    return this.read(async (context) => {
      const events = await this.pages(
        `/repos/${repo}/events`,
        eventSchema,
        context,
        Math.min(this.maxPages, 3)
      );
      const warnings = [
        "GitHub Events exposes at most 300 events from the past 30 days and can lag 30 seconds to 6 hours; this is not complete activity history.",
        ...events.warnings
      ];
      const activities: CodeActivity[] = [];
      const seen = new Set<string>();
      for (const event of events.items) {
        if (repositoryName(event.repo.name) !== repo) fail("response-invalid");
        const occurredAt = event.created_at;
        const at = Date.parse(occurredAt);
        if (at < since || at > until || seen.has(event.id)) continue;
        seen.add(event.id);
        const common = { repository: repo, sourceEventId: event.id, occurredAt };
        if (event.type === "PushEvent") {
          const payload = parse(z.object({ head: shaSchema }), event.payload);
          try {
            const commit = await this.commit(repo, payload.head, context);
            activities.push({
              ...common,
              kind: "commit-pushed",
              title: `Push tip ${commit.sha.slice(0, 12)}: ${commit.message.split("\n")[0] ?? ""}`,
              url: commit.url,
              commitSha: commit.sha
            });
          } catch (error) {
            if (
              !(error instanceof GitHubCodeProviderError) ||
              error.code === "response-invalid"
            )
              throw error;
            warnings.push(`A pushed tip could not be read (${error.code}).`);
          }
        } else if (event.type === "PullRequestEvent") {
          const payload = parse(
            z.object({
              action: z.string(),
              number: z.number().int().positive(),
              pull_request: z.object({
                title: z.string(),
                html_url: z.string(),
                merged: z.boolean().optional()
              })
            }),
            event.payload
          );
          const kind =
            payload.action === "opened"
              ? "pull-request-opened"
              : payload.action === "merged" ||
                  (payload.action === "closed" && payload.pull_request.merged)
                ? "pull-request-merged"
                : null;
          if (!kind) continue;
          this.checkWeb(payload.pull_request.html_url, `${repo}/pull/${payload.number}`);
          activities.push({
            ...common,
            kind,
            title: payload.pull_request.title,
            url: this.webUrl(`${repo}/pull/${payload.number}`)
          });
        } else if (event.type === "ReleaseEvent") {
          const payload = parse(
            z.object({
              action: z.string(),
              release: z.object({
                name: z.string().nullable(),
                tag_name: z.string(),
                html_url: z.string()
              })
            }),
            event.payload
          );
          if (payload.action !== "published") continue;
          this.checkWeb(
            payload.release.html_url,
            `${repo}/releases/tag/${encodeURIComponent(payload.release.tag_name)}`
          );
          activities.push({
            ...common,
            kind: "release-created",
            title: payload.release.name ?? payload.release.tag_name,
            url: this.webUrl(
              `${repo}/releases/tag/${encodeURIComponent(payload.release.tag_name)}`
            )
          });
        }
      }
      activities.sort(
        (a, b) =>
          b.occurredAt.localeCompare(a.occurredAt) ||
          a.sourceEventId.localeCompare(b.sourceEventId)
      );
      return {
        activities,
        coverage: coverage(warnings),
        observedAt: this.now().toISOString()
      };
    });
  }

  private allowed(repository: string): string {
    const repo = repositoryName(repository);
    if (!this.readScope.repositories.includes(repo)) fail("repository-not-allowed");
    return repo;
  }

  private async commit(repo: string, sha: string, context: ReadContext): Promise<Commit> {
    const item = parse(
      commitSchema,
      (await this.get(`/repos/${repo}/commits/${sha}`, context)).value
    );
    if (item.sha !== sha) fail("response-invalid");
    this.checkWeb(item.html_url, `${repo}/commit/${sha}`);
    return {
      repository: repo,
      sha,
      url: this.webUrl(`${repo}/commit/${sha}`),
      message: item.commit.message,
      author: item.author ? externalUser(item.author) : null,
      committedAt: item.commit.committer.date,
      observedAt: this.now().toISOString()
    };
  }

  private async pages<T>(
    path: string,
    schema: z.ZodType<T>,
    context: ReadContext,
    maxPages = this.maxPages
  ): Promise<{ items: T[]; warnings: string[] }> {
    const items: T[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await this.get(`${path}?per_page=100&page=${page}`, context);
      items.push(...parse(z.array(schema).max(100), response.value));
      if (!response.next) return { items, warnings: [] };
    }
    return {
      items,
      warnings: ["A provider list exceeded the configured pagination limit."]
    };
  }

  private async read<T>(operation: (context: ReadContext) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.operationTimeoutMs);
    try {
      return await operation({ signal: controller.signal, remaining: this.maxRequests });
    } finally {
      clearTimeout(timer);
    }
  }

  private async get(path: string, context: ReadContext): Promise<JsonResponse> {
    if (context.signal.aborted) fail("timeout", true);
    if (context.remaining-- <= 0) fail("read-limit");
    if (!path.startsWith("/") || path.startsWith("//")) fail("response-invalid");
    const url = new URL(`${this.api.href.replace(/\/$/u, "")}${path}`);
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(this.requestTimeoutMs)
    ]);
    try {
      const response = await abortable(
        this.fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.token}`,
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "luma-code-reader"
          }
        }),
        signal
      );
      if (response.url && new URL(response.url).href !== url.href)
        fail("response-invalid");
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" ||
            response.headers.has("retry-after")))
      ) {
        throw new GitHubCodeProviderError(
          "rate-limited",
          true,
          response.status,
          retryAfter(response.headers, this.now().getTime())
        );
      }
      if (response.status === 401 || response.status === 403)
        throw new GitHubCodeProviderError("access-denied", false, response.status);
      if (response.status === 404)
        throw new GitHubCodeProviderError("not-found", false, 404);
      if (!response.ok)
        throw new GitHubCodeProviderError(
          response.status >= 500 ? "unavailable" : "response-invalid",
          response.status >= 500,
          response.status
        );
      const next = validatePagination(response.headers.get("link"), url);
      const bytes = await abortable(
        readBytes(response, this.maxResponseBytes, signal),
        signal
      );
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        fail("response-invalid");
      }
      return { value, next };
    } catch (error) {
      if (error instanceof GitHubCodeProviderError) throw error;
      throw new GitHubCodeProviderError(signal.aborted ? "timeout" : "unavailable", true);
    }
  }

  private webUrl(path: string): string {
    return new URL(path, this.web).href;
  }
  private checkWeb(value: string, path: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      fail("response-invalid");
    }
    if (
      url.href.toLowerCase() !== this.webUrl(path).toLowerCase() ||
      url.username ||
      url.password
    )
      fail("response-invalid");
  }
  private checkWebPrefix(value: string, path: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      fail("response-invalid");
    }
    if (
      url.origin !== this.web.origin ||
      !url.pathname.toLowerCase().startsWith(`/${path.toLowerCase()}`) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      fail("response-invalid");
  }
}

function fail(code: GitHubCodeProviderError["code"], retryable = false): never {
  throw new GitHubCodeProviderError(code, retryable);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) fail("response-invalid");
  return result.data;
}
function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) fail("query-invalid");
  return result.data;
}
function bound(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max)
    fail("configuration-invalid");
  return value;
}
function repositoryName(value: string): string {
  if (
    !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/iu.test(value) ||
    [".", ".."].includes(value.split("/")[1] ?? "")
  )
    fail("configuration-invalid");
  return value.toLowerCase();
}
function baseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("configuration-invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    fail("configuration-invalid");
  return url;
}
function filePath(value: string): string {
  if (
    !value ||
    value.length > 4096 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    hasControlCharacters(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail("response-invalid");
  return value;
}
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
function hasControlCharacters(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
  );
}
function externalUser(user: z.infer<typeof userSchema>): ExternalUser {
  return { id: String(user.id), displayName: user.login, username: user.login };
}
function coverage(warnings: string[]): CodeReadCoverage {
  return { complete: warnings.length === 0, warnings: [...new Set(warnings)] };
}
function decodeBlob(encoded: string, size: number, sha: string): Uint8Array {
  const compact = encoded.replace(/\s/gu, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(compact))
    fail("response-invalid");
  const bytes = Buffer.from(compact, "base64");
  const digest = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (bytes.length !== size || digest !== sha) fail("response-invalid");
  return bytes;
}
function excerptAt(
  source: string,
  query: string
): { excerpt: string; startLine: number; endLine: number } | null {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const index = new RegExp(escaped, "iu").exec(source)?.index;
  if (index === undefined) return null;
  const lines = source.split("\n");
  const matchLine = source.slice(0, index).split("\n").length - 1;
  const start = Math.max(0, matchLine - 3);
  const end = Math.min(lines.length, matchLine + 9);
  const selected = lines.slice(start, end);
  if (selected.join("\n").length > 4_000) return null;
  return { excerpt: selected.join("\n"), startLine: start + 1, endLine: end };
}
function validatePagination(link: string | null, current: URL): boolean {
  if (!link) return false;
  const matches = [...link.matchAll(/<([^>]+)>;\s*rel="next"/gu)];
  if (matches.length === 0) return false;
  if (matches.length !== 1 || !matches[0]?.[1]) fail("response-invalid");
  let next: URL;
  try {
    next = new URL(matches[0][1]);
  } catch {
    fail("response-invalid");
  }
  const expected = new URL(current);
  const page = Number(current.searchParams.get("page") ?? "1");
  expected.searchParams.set("page", String(page + 1));
  next.searchParams.sort();
  expected.searchParams.sort();
  if (next.href !== expected.href) fail("response-invalid");
  return true;
}
function retryAfter(headers: Headers, now: number): number | null {
  const retry = headers.get("retry-after");
  if (retry) {
    const seconds = Number(retry);
    const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(retry) - now;
    if (Number.isFinite(delay) && delay >= 0) return delay;
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  return reset > 0 ? Math.max(0, reset * 1_000 - now) : null;
}
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new GitHubCodeProviderError("timeout", true));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(
          error instanceof Error
            ? error
            : new GitHubCodeProviderError("unavailable", true)
        );
      }
    );
  });
}
async function readBytes(
  response: Response,
  max: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > max || !response.body)
    fail("response-invalid");
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes: unknown = chunk.value;
      if (!(bytes instanceof Uint8Array)) fail("response-invalid");
      count += bytes.length;
      if (count > max) fail("response-invalid");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel();
  }
}
