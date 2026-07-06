import type { ExternalUser } from "../domain/model.js";

export type CommitReference = {
  repository: string;
  sha: string;
  url: string;
};

export type Commit = CommitReference & {
  message: string;
  author: ExternalUser;
  committedAt: string;
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
};

export type RepositoryActivityQuery = {
  repository: string;
  since: string;
  until?: string;
};

export type CodeActivity = {
  kind:
    "pull-request-opened" | "pull-request-merged" | "commit-pushed" | "release-created";
  title: string;
  occurredAt: string;
  url: string;
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
};

export interface CodeProvider {
  getPullRequest(repository: string, number: number): Promise<CodeChange>;
  getCommit(repository: string, sha: string): Promise<Commit>;
  getRecentActivity(query: RepositoryActivityQuery): Promise<CodeActivity[]>;
  searchCode(query: CodeSearchQuery): Promise<CodeSearchResult[]>;
}
