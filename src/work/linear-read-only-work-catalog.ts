import { LinearClient } from "@linear/sdk";
import { linearSdkIssueToApiIssue } from "./linear-sdk-issue.js";
import { toLinearWorkItem, type LinearApiIssue } from "./linear-work-item.js";
import type { WorkCatalog, WorkQuery } from "./interface.js";

const MAX_SEARCH_RESULTS = 10;
const MAX_SEARCH_TEXT_LENGTH = 2_000;
const MAX_ISSUE_SELECTOR_LENGTH = 256;
const MAX_REMEMBERED_ISSUE_SELECTORS = 1_000;

export type LinearReadOnlyApiIssue = LinearApiIssue;

/**
 * The only Linear operations the dedicated read-only catalog may invoke.
 * Keep mutation methods out of this Interface rather than relying on an
 * allowlist at a caller or a narrowed writer-capable object.
 */
export interface LinearReadOnlyApi {
  searchIssues(input: {
    teamId: string;
    text: string;
    limit: number;
  }): Promise<LinearReadOnlyApiIssue[]>;
  getIssue(id: string): Promise<LinearReadOnlyApiIssue>;
}

export type LinearReadOnlyWorkCatalogConfig = {
  teamId: string;
  apiKey?: string;
  apiUrl?: string;
  providerId?: string;
  api?: LinearReadOnlyApi;
};

export class LinearReadOnlyWorkCatalogError extends Error {
  constructor(
    readonly code:
      | "linear-readonly-config-incomplete"
      | "linear-readonly-query-invalid"
      | "linear-readonly-selector-invalid",
    message: string
  ) {
    super(message);
    this.name = "LinearReadOnlyWorkCatalogError";
  }
}

/**
 * A separately credentialed, bounded Linear catalog for reconciliation reads.
 * It neither imports nor wraps WorkProvider, so a writer capability cannot
 * enter through this adapter by type or by environment fallback.
 */
export function createLinearReadOnlyWorkCatalog(
  config: LinearReadOnlyWorkCatalogConfig
): WorkCatalog {
  const teamId = requireConfigString(config.teamId, "LINEAR_TEAM_ID");
  const providerId = nonBlank(config.providerId) ?? "linear";
  const api = config.api ?? createLinearReadOnlySdkApi(config);
  const permittedSelectors = new BoundedSelectorSet(MAX_REMEMBERED_ISSUE_SELECTORS);

  return {
    providerId,
    identityProviderId: "linear",
    supportsConditionalUpdates: false,
    async searchWorkItems(query) {
      const input = normalizeSearchQuery(query, teamId);
      const issues = (await api.searchIssues(input)).slice(0, input.limit);

      for (const issue of issues) {
        permittedSelectors.add(issue.id);
      }

      return issues.map((issue) => toLinearWorkItem(issue, providerId));
    },
    async getWorkItem(id) {
      const selector = normalizeIssueSelector(id);

      if (!permittedSelectors.has(selector)) {
        throw new LinearReadOnlyWorkCatalogError(
          "linear-readonly-selector-invalid",
          "Linear read-only fetch requires an issue selector returned by a bounded search"
        );
      }

      return toLinearWorkItem(await api.getIssue(selector), providerId);
    }
  };
}

export function createLinearReadOnlyWorkCatalogFromEnv(
  env: NodeJS.ProcessEnv = process.env
): WorkCatalog {
  const apiKey = requireConfigString(
    env["LINEAR_READONLY_API_KEY"],
    "LINEAR_READONLY_API_KEY"
  );
  const teamId = requireConfigString(env["LINEAR_TEAM_ID"], "LINEAR_TEAM_ID");
  const config: LinearReadOnlyWorkCatalogConfig = { apiKey, teamId };
  const apiUrl = nonBlank(env["LINEAR_API_URL"]);
  const providerId = nonBlank(env["LUMA_LINEAR_PROVIDER_ID"]);

  if (apiUrl) {
    config.apiUrl = apiUrl;
  }

  if (providerId) {
    config.providerId = providerId;
  }

  return createLinearReadOnlyWorkCatalog(config);
}

function createLinearReadOnlySdkApi(
  config: LinearReadOnlyWorkCatalogConfig
): LinearReadOnlyApi {
  const apiKey = requireConfigString(config.apiKey, "LINEAR_READONLY_API_KEY");

  return new LinearSdkReadOnlyApi(
    new LinearClient({
      apiKey,
      ...(config.apiUrl ? { apiUrl: config.apiUrl } : {})
    })
  );
}

class LinearSdkReadOnlyApi implements LinearReadOnlyApi {
  constructor(private readonly client: LinearClient) {}

  async searchIssues(input: {
    teamId: string;
    text: string;
    limit: number;
  }): Promise<LinearReadOnlyApiIssue[]> {
    const result = await this.client.searchIssues(input.text, {
      teamId: input.teamId,
      first: input.limit,
      includeArchived: false
    });

    return Promise.all(
      result.nodes.map(async (issue) =>
        linearSdkIssueToApiIssue(await this.client.issue(issue.id))
      )
    );
  }

  getIssue(id: string): Promise<LinearReadOnlyApiIssue> {
    return this.client.issue(id).then(linearSdkIssueToApiIssue);
  }
}

function normalizeSearchQuery(
  query: WorkQuery,
  teamId: string
): { teamId: string; text: string; limit: number } {
  const workspaceId = query.workspaceId.trim();
  const text = query.text.trim();

  if (
    workspaceId.length === 0 ||
    text.length === 0 ||
    text.length > MAX_SEARCH_TEXT_LENGTH ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1
  ) {
    throw new LinearReadOnlyWorkCatalogError(
      "linear-readonly-query-invalid",
      "Linear read-only search requires a bounded workspace, query, and positive limit"
    );
  }

  return {
    teamId,
    text,
    limit: Math.min(query.limit, MAX_SEARCH_RESULTS)
  };
}

function normalizeIssueSelector(value: string): string {
  const selector = value.trim();

  if (selector.length === 0 || selector.length > MAX_ISSUE_SELECTOR_LENGTH) {
    throw new LinearReadOnlyWorkCatalogError(
      "linear-readonly-selector-invalid",
      "Linear read-only fetch requires one bounded issue selector"
    );
  }

  return selector;
}

function requireConfigString(value: string | undefined, key: string): string {
  const normalized = nonBlank(value);

  if (!normalized) {
    throw new LinearReadOnlyWorkCatalogError(
      "linear-readonly-config-incomplete",
      `${key} is required for the Linear read-only Work Catalog`
    );
  }

  return normalized;
}

function nonBlank(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

class BoundedSelectorSet {
  private readonly values = new Set<string>();

  constructor(private readonly capacity: number) {}

  add(value: string): void {
    this.values.delete(value);
    this.values.add(value);

    if (this.values.size <= this.capacity) {
      return;
    }

    const oldest = this.values.values().next().value;

    if (oldest) {
      this.values.delete(oldest);
    }
  }

  has(value: string): boolean {
    return this.values.has(value);
  }
}
