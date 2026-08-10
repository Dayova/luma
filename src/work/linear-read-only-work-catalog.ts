import { LinearClient } from "@linear/sdk";
import { linearSdkIssueToApiIssue } from "./linear-sdk-issue.js";
import { toLinearWorkItem, type LinearApiIssue } from "./linear-work-item.js";
import type { WorkCatalog, WorkQuery } from "./interface.js";

const MAX_SEARCH_RESULTS = 10;
const MAX_SEARCH_TEXT_LENGTH = 2_000;
const MAX_ISSUE_SELECTOR_LENGTH = 256;
const MAX_REMEMBERED_ISSUE_SELECTORS = 1_000;
// These limits are deliberately enforced before a provider record becomes a
// WorkItem, so reconciliation never persists a silently truncated record.
const MAX_ISSUE_TITLE_CODE_UNITS = 1_024;
const MAX_ISSUE_DESCRIPTION_CODE_UNITS = 64_000;
const MAX_ISSUE_LABEL_COUNT = 50;
const MAX_ISSUE_LABEL_CODE_UNITS = 256;
const READ_ONLY_LABEL_FETCH_LIMIT = MAX_ISSUE_LABEL_COUNT + 1;

export type LinearReadOnlyApiIssue = LinearApiIssue;

export const linearReadOnlyApiBrand: unique symbol = Symbol("LinearReadOnlyApi");

type LinearReadOnlyApiOperations = {
  searchIssues(input: {
    teamId: string;
    text: string;
    limit: number;
  }): Promise<LinearReadOnlyApiIssue[]>;
  getIssue(id: string): Promise<LinearReadOnlyApiIssue>;
};

/**
 * The only Linear operations the dedicated read-only catalog may invoke.
 * Keep mutation methods out of this Interface rather than relying on an
 * allowlist at a caller or a narrowed writer-capable object.
 */
export interface LinearReadOnlyApi extends LinearReadOnlyApiOperations {
  /**
   * Nominally separates this constrained transport from the writer-capable
   * LinearApi. It is exported solely so declaration emit can name this
   * computed key; supported construction remains the production adapter and
   * explicit test factory below.
   */
  readonly [linearReadOnlyApiBrand]: true;
}

type LinearReadOnlyApiTestDouble = LinearReadOnlyApiOperations & {
  createIssue?: never;
  updateIssue?: never;
  addComment?: never;
  findIssueByIdempotencyKey?: never;
};

type NoExtraProperties<Expected, Actual extends Expected> = Actual &
  Record<Exclude<keyof Actual, keyof Expected>, never>;

/**
 * Brands a deterministic, query-only test double for the test catalog seam.
 * It is intentionally absent from the package entrypoint. The input rejects
 * mutation surfaces and captures the concrete input keys, so a generic
 * wrapper cannot conceal a writer-capable LinearApi at this test-only boundary.
 */
export function createLinearReadOnlyApiForTest<
  Actual extends LinearReadOnlyApiTestDouble
>(api: NoExtraProperties<LinearReadOnlyApiTestDouble, Actual>): LinearReadOnlyApi {
  return {
    [linearReadOnlyApiBrand]: true,
    searchIssues: (input) => api.searchIssues(input),
    getIssue: (id) => api.getIssue(id)
  };
}

export type LinearReadOnlyWorkCatalogConfig = {
  teamId: string;
  /** A dedicated Linear key constrained to read permission. */
  readOnlyApiKey: string;
  /** Writer credentials and APIs are incompatible with this production seam. */
  apiKey?: never;
  api?: never;
  apiUrl?: string;
  providerId?: string;
};

/**
 * Deterministic test configuration only. Production construction never
 * accepts an injected API, which keeps an ordinary writer-capable LinearApi
 * out of the read-only adapter's production seam.
 *
 * This type is intentionally not exported from Luma's package entrypoint.
 */
export type LinearReadOnlyWorkCatalogTestConfig = {
  teamId: string;
  providerId?: string;
  api: LinearReadOnlyApi;
};

export class LinearReadOnlyWorkCatalogError extends Error {
  constructor(
    readonly code:
      | "linear-readonly-config-incomplete"
      | "linear-readonly-query-invalid"
      | "linear-readonly-selector-invalid"
      | "linear-readonly-provider-scope-invalid"
      | "linear-readonly-payload-too-large",
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
  return createLinearReadOnlyWorkCatalogWithApi(
    config,
    createLinearReadOnlySdkApi(config)
  );
}

/**
 * Creates the catalog with a deterministic fake for tests. This is the only
 * injection seam and must not be used to compose the production runtime.
 */
export function createLinearReadOnlyWorkCatalogForTest(
  config: LinearReadOnlyWorkCatalogTestConfig
): WorkCatalog {
  return createLinearReadOnlyWorkCatalogWithApi(config, config.api);
}

function createLinearReadOnlyWorkCatalogWithApi(
  config: Omit<LinearReadOnlyWorkCatalogTestConfig, "api">,
  api: LinearReadOnlyApi
): WorkCatalog {
  const teamId = requireConfigString(config.teamId, "LINEAR_TEAM_ID");
  const providerId = nonBlank(config.providerId) ?? "linear";
  const permittedSelectors = new BoundedSelectorSet(MAX_REMEMBERED_ISSUE_SELECTORS);

  return {
    providerId,
    identityProviderId: "linear",
    supportsConditionalUpdates: false,
    async searchWorkItems(query) {
      const input = normalizeSearchQuery(query, teamId);
      const issues = (await api.searchIssues(input)).slice(0, input.limit);

      for (const issue of issues) {
        validateReadOnlyIssuePayload(issue, teamId);
      }

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

      const issue = await api.getIssue(selector);
      validateReadOnlyIssuePayload(issue, teamId);
      return toLinearWorkItem(issue, providerId);
    }
  };
}

export function createLinearReadOnlyWorkCatalogFromEnv(
  env: NodeJS.ProcessEnv = process.env
): WorkCatalog {
  const readOnlyApiKey = requireConfigString(
    env["LINEAR_READONLY_API_KEY"],
    "LINEAR_READONLY_API_KEY"
  );
  const teamId = requireConfigString(env["LINEAR_TEAM_ID"], "LINEAR_TEAM_ID");
  const config: LinearReadOnlyWorkCatalogConfig = { readOnlyApiKey, teamId };
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
  const apiKey = requireConfigString(config.readOnlyApiKey, "LINEAR_READONLY_API_KEY");

  return new LinearSdkReadOnlyApi(
    new LinearClient({
      apiKey,
      ...(config.apiUrl ? { apiUrl: config.apiUrl } : {})
    })
  );
}

class LinearSdkReadOnlyApi implements LinearReadOnlyApi {
  readonly [linearReadOnlyApiBrand] = true as const;

  constructor(private readonly client: LinearClient) {}

  async searchIssues(input: {
    teamId: string;
    text: string;
    limit: number;
  }): Promise<LinearReadOnlyApiIssue[]> {
    const limit = Math.min(input.limit, MAX_SEARCH_RESULTS);
    const result = await this.client.searchIssues(input.text, {
      teamId: input.teamId,
      first: limit,
      includeArchived: false
    });

    return Promise.all(
      result.nodes.slice(0, limit).map(async (issue) =>
        linearSdkIssueToApiIssue(await this.client.issue(issue.id), {
          labelLimit: READ_ONLY_LABEL_FETCH_LIMIT
        })
      )
    );
  }

  async getIssue(id: string): Promise<LinearReadOnlyApiIssue> {
    return linearSdkIssueToApiIssue(await this.client.issue(id), {
      labelLimit: READ_ONLY_LABEL_FETCH_LIMIT
    });
  }
}

function validateReadOnlyIssuePayload(
  issue: LinearReadOnlyApiIssue,
  teamId: string
): void {
  if (issue.teamId !== teamId) {
    throw new LinearReadOnlyWorkCatalogError(
      "linear-readonly-provider-scope-invalid",
      "Linear read-only issue must belong to the configured team scope"
    );
  }

  if (issue.title.length > MAX_ISSUE_TITLE_CODE_UNITS) {
    throw payloadTooLarge("title");
  }

  if (issue.description.length > MAX_ISSUE_DESCRIPTION_CODE_UNITS) {
    throw payloadTooLarge("description");
  }

  if (issue.labels.length > MAX_ISSUE_LABEL_COUNT) {
    throw payloadTooLarge("labels");
  }

  if (issue.labels.some((label) => label.length > MAX_ISSUE_LABEL_CODE_UNITS)) {
    throw payloadTooLarge("labels");
  }
}

function payloadTooLarge(
  field: "title" | "description" | "labels"
): LinearReadOnlyWorkCatalogError {
  return new LinearReadOnlyWorkCatalogError(
    "linear-readonly-payload-too-large",
    `Linear read-only ${field} payload exceeds its configured safety limit`
  );
}

function normalizeSearchQuery(
  query: WorkQuery,
  teamId: string
): { teamId: string; text: string; limit: number } {
  const workspaceId = query.workspaceId.trim();
  const text = query.text.trim();

  if (
    workspaceId.length === 0 ||
    workspaceId !== teamId ||
    text.length === 0 ||
    text.length > MAX_SEARCH_TEXT_LENGTH ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1
  ) {
    throw new LinearReadOnlyWorkCatalogError(
      "linear-readonly-query-invalid",
      "Linear read-only search requires the configured workspace, query, and positive limit"
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
