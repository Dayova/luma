import type { ExternalUser } from "../domain/model.js";

/** Coverage is about this bounded read, never proof that a repository has no other work. */
export type CodeReadCoverage = {
  complete: boolean;
  warnings: string[];
};

/** Configured credential/repository boundary; this is not a reader ACL or a sharing grant. */
export type CodeReadScope = {
  credentialScopeId: string;
  repositories: readonly string[];
};

export type CommitReference = {
  repository: string;
  sha: string;
  url: string;
};

export type Commit = CommitReference & {
  message: string;
  /** Null when GitHub cannot bind the original Git author to an account. */
  author: ExternalUser | null;
  committedAt: string;
  observedAt: string;
};

export type CodeChange = {
  id: string;
  providerId: string;
  repository: string;
  number: number;
  title: string;
  description: string;
  author: ExternalUser;
  reviewers: ExternalUser[];
  state: "draft" | "open" | "merged" | "closed";
  additions: number;
  deletions: number;
  filesChanged: string[];
  commits: CommitReference[];
  linkedWorkItemIds: string[];
  url: string;
  headSha: string;
  baseSha: string;
  updatedAt: string;
  observedAt: string;
  coverage: CodeReadCoverage;
};

export type RepositoryActivityQuery = {
  repository: string;
  since: string;
  until?: string;
};

export type CodeActivity = {
  repository: string;
  /** Provider event identity; commit timestamps are not push timestamps. */
  sourceEventId: string;
  kind:
    "pull-request-opened" | "pull-request-merged" | "commit-pushed" | "release-created";
  title: string;
  occurredAt: string;
  url: string;
  /** For commit-pushed, the observed tip after that push, not every commit in it. */
  commitSha?: string;
};

export type CodeActivityResult = {
  activities: CodeActivity[];
  coverage: CodeReadCoverage;
  observedAt: string;
};

export type CodeSearchQuery = {
  repository: string;
  text: string;
  limit: number;
};

export type CodeSearchResult = {
  repository: string;
  path: string;
  excerpt: string;
  url: string;
  commitSha: string;
  blobSha: string;
  startLine: number;
  endLine: number;
};

export type CodeSearchResponse = {
  results: CodeSearchResult[];
  /** Exact default-branch commit whose file bytes were read. */
  commitSha: string;
  coverage: CodeReadCoverage;
  observedAt: string;
};

/** Search results are discovery references; callers must read the PR before using it. */
export type PullRequestSearchResponse = {
  results: Array<{ repository: string; number: number }>;
  coverage: CodeReadCoverage;
  observedAt: string;
};

export type CodeExcerptReference = Pick<
  CodeSearchResult,
  "repository" | "path" | "commitSha" | "blobSha" | "startLine" | "endLine"
>;
export type CurrentCodeExcerpt = CodeSearchResult & {
  committedAt: string;
  observedAt: string;
};

export interface CodeProvider {
  readonly providerId: string;
  readonly readScope: CodeReadScope;
  getPullRequest(repository: string, number: number): Promise<CodeChange>;
  searchPullRequests(query: CodeSearchQuery): Promise<PullRequestSearchResponse>;
  getCommit(repository: string, sha: string): Promise<Commit>;
  getRecentActivity(query: RepositoryActivityQuery): Promise<CodeActivityResult>;
  searchCode(query: CodeSearchQuery): Promise<CodeSearchResponse>;
  /** Fresh bytes and readability at the still-current default head; never a cached search hit. */
  getCurrentCodeExcerpt(
    reference: CodeExcerptReference
  ): Promise<CurrentCodeExcerpt | null>;
}
