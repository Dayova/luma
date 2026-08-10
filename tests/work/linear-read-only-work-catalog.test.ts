import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createLinearReadOnlyApiForTest,
  createLinearReadOnlyWorkCatalog,
  createLinearReadOnlyWorkCatalogForTest,
  createLinearReadOnlyWorkCatalogFromEnv,
  LinearReadOnlyWorkCatalogError,
  type LinearReadOnlyApi,
  type LinearReadOnlyApiIssue,
  type LinearReadOnlyWorkCatalogConfig
} from "../../src/work/linear-read-only-work-catalog.js";
import type {
  LinearApi,
  LinearWorkProviderConfig
} from "../../src/work/linear-work-provider.js";

type CapturedGraphqlRequest = {
  url: string;
  method: string;
  query: string;
  variables: Record<string, unknown>;
};

function linearIssue(
  overrides: Partial<LinearReadOnlyApiIssue> = {}
): LinearReadOnlyApiIssue {
  return {
    id: "issue-301",
    identifier: "LUM-301",
    title: "Prepare the release checklist",
    description: "Prepare the release checklist.",
    stateType: "started",
    stateName: "In Progress",
    assignee: {
      id: "67e00026-a426-4476-83bb-fe679fc5ca9c",
      displayName: "Jakob",
      email: "jakob@example.com"
    },
    dueDate: "2026-07-20",
    labels: ["meeting-follow-up"],
    projectId: null,
    parentId: null,
    url: "https://linear.app/dayova/issue/LUM-301",
    updatedAt: "2026-07-16T09:06:00.000Z",
    ...overrides
  };
}

class RecordingLinearReadOnlyApi {
  readonly searchCalls: Array<{ teamId: string; text: string; limit: number }> = [];
  readonly getCalls: string[] = [];
  searchResult: LinearReadOnlyApiIssue[] = [linearIssue()];
  getResult: LinearReadOnlyApiIssue = linearIssue();

  searchIssues(input: {
    teamId: string;
    text: string;
    limit: number;
  }): Promise<LinearReadOnlyApiIssue[]> {
    this.searchCalls.push(input);
    return Promise.resolve(this.searchResult);
  }

  getIssue(id: string): Promise<LinearReadOnlyApiIssue> {
    this.getCalls.push(id);
    return Promise.resolve(this.getResult);
  }
}

function responseJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function sdkPageInfo(): Record<string, unknown> {
  return {
    __typename: "PageInfo",
    startCursor: null,
    endCursor: null,
    hasPreviousPage: false,
    hasNextPage: false
  };
}

function sdkIssue(id: string): Record<string, unknown> {
  return {
    __typename: "Issue",
    trashed: false,
    reactionData: [],
    labelIds: [],
    integrationSourceType: null,
    url: `https://linear.test/issue/${id}`,
    identifier: `LUM-${id}`,
    priorityLabel: "No priority",
    previousIdentifiers: [],
    reactions: [],
    customerTicketCount: 0,
    sharedAccess: {
      __typename: "IssueSharedAccess",
      disallowedIssueFields: [],
      sharedWithCount: 0,
      sharedWithUsers: [],
      viewerHasOnlySharedAccess: false,
      isShared: false
    },
    branchName: null,
    delegate: null,
    botActor: null,
    sourceComment: null,
    cycle: null,
    dueDate: null,
    estimate: null,
    syncedWith: [],
    externalUserCreator: null,
    asksExternalUserRequester: null,
    asksRequester: null,
    description: "A bounded test issue.",
    title: `Bounded issue ${id}`,
    number: 1,
    lastAppliedTemplate: null,
    updatedAt: "2026-08-10T00:00:00.000Z",
    boardOrder: 0,
    sortOrder: 0,
    prioritySortOrder: 0,
    subIssueSortOrder: null,
    parent: null,
    priority: 0,
    projectMilestone: null,
    project: null,
    recurringIssueTemplate: null,
    team: { id: "team-luma" },
    archivedAt: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    startedTriageAt: null,
    triagedAt: null,
    addedToCycleAt: null,
    addedToProjectAt: null,
    addedToTeamAt: null,
    autoArchivedAt: null,
    autoClosedAt: null,
    canceledAt: null,
    completedAt: null,
    startedAt: null,
    slaStartedAt: null,
    slaBreachesAt: null,
    slaHighRiskAt: null,
    slaMediumRiskAt: null,
    snoozedUntilAt: null,
    slaType: null,
    id,
    assignee: null,
    creator: null,
    snoozedBy: null,
    favorite: null,
    state: { id: "state-started" },
    inheritsSharedAccess: false
  };
}

function sdkSearchPayload(issueIds: readonly string[]): Record<string, unknown> {
  return {
    __typename: "IssueSearchPayload",
    archivePayload: {
      __typename: "ArchiveResponse",
      archive: "",
      totalCount: 0,
      databaseVersion: 0,
      includesDependencies: false
    },
    totalCount: issueIds.length,
    nodes: issueIds.map(sdkIssue),
    pageInfo: sdkPageInfo()
  };
}

function sdkLabelsPayload(): Record<string, unknown> {
  return {
    __typename: "IssueLabelConnection",
    nodes: [],
    pageInfo: sdkPageInfo()
  };
}

function sdkWorkflowState(id: string): Record<string, unknown> {
  return {
    __typename: "WorkflowState",
    description: null,
    updatedAt: "2026-08-10T00:00:00.000Z",
    inheritedFrom: null,
    position: 0,
    color: "#5E6AD2",
    name: "In Progress",
    team: { id: "team-luma" },
    archivedAt: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    type: "started",
    id
  };
}

describe("LinearReadOnlyWorkCatalog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a team-scoped, bounded search and maps provider-neutral Work Items", async () => {
    const api = new RecordingLinearReadOnlyApi();
    const catalog = createLinearReadOnlyWorkCatalogForTest({
      api: createLinearReadOnlyApiForTest(api),
      teamId: "team-luma",
      providerId: "linear-readonly"
    });

    await expect(
      catalog.searchWorkItems({
        workspaceId: "workspace_luma",
        text: "  release checklist  ",
        limit: 999
      })
    ).resolves.toEqual([
      {
        id: "issue-301",
        providerId: "linear-readonly",
        externalId: "LUM-301",
        title: "Prepare the release checklist",
        description: "Prepare the release checklist.",
        status: "active",
        assignees: [
          {
            id: "67e00026-a426-4476-83bb-fe679fc5ca9c",
            displayName: "Jakob",
            username: "jakob@example.com"
          }
        ],
        dueDate: "2026-07-20",
        labels: ["meeting-follow-up"],
        projectId: null,
        parentId: null,
        url: "https://linear.app/dayova/issue/LUM-301",
        updatedAt: "2026-07-16T09:06:00.000Z"
      }
    ]);

    expect(api.searchCalls).toEqual([
      {
        teamId: "team-luma",
        text: "release checklist",
        limit: 10
      }
    ]);
  });

  it("only fetches an issue selector returned by its own bounded search", async () => {
    const api = new RecordingLinearReadOnlyApi();
    const catalog = createLinearReadOnlyWorkCatalogForTest({
      api: createLinearReadOnlyApiForTest(api),
      teamId: "team-luma"
    });

    await expect(catalog.getWorkItem("issue-301")).rejects.toMatchObject({
      code: "linear-readonly-selector-invalid"
    });
    expect(api.getCalls).toEqual([]);

    await catalog.searchWorkItems({
      workspaceId: "workspace_luma",
      text: "release checklist",
      limit: 1
    });

    await expect(catalog.getWorkItem("issue-301")).resolves.toMatchObject({
      externalId: "LUM-301"
    });
    expect(api.getCalls).toEqual(["issue-301"]);
  });

  it("enforces the bounded result limit before caching selectors from Linear", async () => {
    const api = new RecordingLinearReadOnlyApi();
    api.searchResult = Array.from({ length: 11 }, (_, index) =>
      linearIssue({
        id: `issue-${index + 1}`,
        identifier: `LUM-${index + 1}`
      })
    );
    const catalog = createLinearReadOnlyWorkCatalogForTest({
      api: createLinearReadOnlyApiForTest(api),
      teamId: "team-luma"
    });

    await expect(
      catalog.searchWorkItems({
        workspaceId: "workspace_luma",
        text: "release checklist",
        limit: 10
      })
    ).resolves.toHaveLength(10);
    await expect(catalog.getWorkItem("issue-11")).rejects.toMatchObject({
      code: "linear-readonly-selector-invalid"
    });
    expect(api.getCalls).toEqual([]);
  });

  it("slices an over-returning SDK response before issue hydration and emits only queries", async () => {
    const requests: CapturedGraphqlRequest[] = [];
    const issueIds = Array.from({ length: 11 }, (_, index) => `issue-${index + 1}`);

    const fakeFetch: typeof fetch = (input, init) => {
      if (typeof init?.body !== "string") {
        throw new Error("Linear SDK request body must be GraphQL JSON");
      }

      const body = JSON.parse(init.body) as {
        query: string;
        variables?: Record<string, unknown>;
      };
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const request = {
        url,
        method: init?.method ?? "GET",
        query: body.query,
        variables: body.variables ?? {}
      };
      requests.push(request);

      if (body.query.includes("query searchIssues")) {
        return Promise.resolve(
          responseJson({ data: { searchIssues: sdkSearchPayload(issueIds) } })
        );
      }

      if (body.query.includes("query issue_labels")) {
        return Promise.resolve(
          responseJson({ data: { issue: { labels: sdkLabelsPayload() } } })
        );
      }

      if (body.query.includes("query workflowState(")) {
        return Promise.resolve(
          responseJson({
            data: { workflowState: sdkWorkflowState(String(request.variables["id"])) }
          })
        );
      }

      if (body.query.includes("query issue(")) {
        return Promise.resolve(
          responseJson({
            data: { issue: sdkIssue(String(request.variables["id"])) }
          })
        );
      }

      throw new Error(`Unexpected Linear GraphQL operation: ${body.query}`);
    };
    vi.stubGlobal("fetch", fakeFetch);

    const catalog = createLinearReadOnlyWorkCatalog({
      readOnlyApiKey: "read-only-test-key",
      apiUrl: "https://linear.test/graphql",
      teamId: "team-luma"
    });

    await expect(
      catalog.searchWorkItems({
        workspaceId: "workspace_luma",
        text: "release checklist",
        limit: 10
      })
    ).resolves.toHaveLength(10);

    const searches = requests.filter((request) =>
      request.query.includes("query searchIssues")
    );
    const hydratedIssues = requests.filter((request) =>
      request.query.includes("query issue($id")
    );
    const labelReads = requests.filter((request) =>
      request.query.includes("query issue_labels")
    );
    const workflowStateReads = requests.filter((request) =>
      request.query.includes("query workflowState(")
    );

    expect(searches).toHaveLength(1);
    expect(searches[0]?.variables).toMatchObject({
      teamId: "team-luma",
      term: "release checklist",
      first: 10,
      includeArchived: false
    });
    expect(hydratedIssues).toHaveLength(10);
    expect(hydratedIssues.map((request) => request.variables["id"])).toEqual(
      issueIds.slice(0, 10)
    );
    expect(labelReads).toHaveLength(10);
    expect(labelReads.every((request) => request.variables["first"] === 51)).toBe(true);
    expect(workflowStateReads).toHaveLength(10);
    expect(requests).toHaveLength(31);
    expect(requests.every((request) => request.method === "POST")).toBe(true);
    expect(requests.every((request) => /^\s*query\b/.test(request.query))).toBe(true);
  });

  const oversizedPayloads: Array<[string, Partial<LinearReadOnlyApiIssue>]> = [
    ["title", { title: "x".repeat(1_025) }],
    ["description", { description: "x".repeat(64_001) }],
    [
      "label count",
      { labels: Array.from({ length: 51 }, (_, index) => `label-${index}`) }
    ],
    ["label value", { labels: ["x".repeat(257)] }]
  ];

  it.each(oversizedPayloads)(
    "fails closed for an oversized %s without retaining a partial search result",
    async (_field, oversized) => {
      const api = new RecordingLinearReadOnlyApi();
      api.searchResult = [
        linearIssue({ id: "issue-valid" }),
        linearIssue({ id: "issue-oversized", ...oversized })
      ];
      const catalog = createLinearReadOnlyWorkCatalogForTest({
        api: createLinearReadOnlyApiForTest(api),
        teamId: "team-luma"
      });

      await expect(
        catalog.searchWorkItems({
          workspaceId: "workspace_luma",
          text: "release checklist",
          limit: 10
        })
      ).rejects.toMatchObject({ code: "linear-readonly-payload-too-large" });
      await expect(catalog.getWorkItem("issue-valid")).rejects.toMatchObject({
        code: "linear-readonly-selector-invalid"
      });
      expect(api.getCalls).toEqual([]);
    }
  );

  it("fails closed when a selected issue exceeds the payload limit during hydration", async () => {
    const api = new RecordingLinearReadOnlyApi();
    api.getResult = linearIssue({
      id: "issue-301",
      description: "x".repeat(64_001)
    });
    const catalog = createLinearReadOnlyWorkCatalogForTest({
      api: createLinearReadOnlyApiForTest(api),
      teamId: "team-luma"
    });

    await catalog.searchWorkItems({
      workspaceId: "workspace_luma",
      text: "release checklist",
      limit: 1
    });

    await expect(catalog.getWorkItem("issue-301")).rejects.toMatchObject({
      code: "linear-readonly-payload-too-large"
    });
    expect(api.getCalls).toEqual(["issue-301"]);
  });

  it("keeps writer configuration and APIs outside the read-only construction seams", () => {
    type WriterConfiguredLinearWorkProvider = LinearWorkProviderConfig & {
      readOnlyApiKey: string;
      apiKey: string;
      api: LinearApi;
    };

    expectTypeOf<LinearReadOnlyWorkCatalogConfig>().toMatchTypeOf<{
      teamId: string;
      readOnlyApiKey: string;
      apiKey?: never;
      api?: never;
    }>();
    expectTypeOf<WriterConfiguredLinearWorkProvider>().not.toMatchTypeOf<LinearReadOnlyWorkCatalogConfig>();
    expectTypeOf<LinearApi>().not.toMatchTypeOf<
      Parameters<typeof createLinearReadOnlyApiForTest>[0]
    >();
    expectTypeOf<LinearApi>().not.toMatchTypeOf<LinearReadOnlyApi>();
  });

  it("exposes and invokes no mutation surface", async () => {
    const api = new RecordingLinearReadOnlyApi();
    const catalog = createLinearReadOnlyWorkCatalogForTest({
      api: createLinearReadOnlyApiForTest(api),
      teamId: "team-luma"
    });

    expect(Object.keys(catalog).sort()).toEqual([
      "getWorkItem",
      "identityProviderId",
      "providerId",
      "searchWorkItems",
      "supportsConditionalUpdates"
    ]);
    expect(Object.hasOwn(catalog, "createWorkItem")).toBe(false);
    expect(Object.hasOwn(catalog, "updateWorkItem")).toBe(false);
    expect(Object.hasOwn(catalog, "addComment")).toBe(false);

    await catalog.searchWorkItems({
      workspaceId: "workspace_luma",
      text: "release checklist",
      limit: 1
    });
    await catalog.getWorkItem("issue-301");

    expect(api.searchCalls).toHaveLength(1);
    expect(api.getCalls).toEqual(["issue-301"]);
  });

  it("fails closed for malformed query input before reaching Linear", async () => {
    const api = new RecordingLinearReadOnlyApi();
    const catalog = createLinearReadOnlyWorkCatalogForTest({
      api: createLinearReadOnlyApiForTest(api),
      teamId: "team-luma"
    });

    await expect(
      catalog.searchWorkItems({
        workspaceId: "workspace_luma",
        text: "   ",
        limit: 1
      })
    ).rejects.toMatchObject({ code: "linear-readonly-query-invalid" });
    await expect(
      catalog.searchWorkItems({
        workspaceId: "workspace_luma",
        text: "release checklist",
        limit: 0
      })
    ).rejects.toMatchObject({ code: "linear-readonly-query-invalid" });

    expect(api.searchCalls).toEqual([]);
  });

  it("requires a nonblank read-only key even when a writer key is present", () => {
    const writerOnlyEnv = {
      LINEAR_API_KEY: "writer-key-must-not-be-used",
      LINEAR_TEAM_ID: "team-luma"
    };

    expect(() => createLinearReadOnlyWorkCatalogFromEnv(writerOnlyEnv)).toThrow(
      LinearReadOnlyWorkCatalogError
    );
    expect(() => createLinearReadOnlyWorkCatalogFromEnv(writerOnlyEnv)).toThrow(
      "LINEAR_READONLY_API_KEY is required"
    );
    expect(() =>
      createLinearReadOnlyWorkCatalogFromEnv({
        ...writerOnlyEnv,
        LINEAR_READONLY_API_KEY: "   "
      })
    ).toThrow("LINEAR_READONLY_API_KEY is required");
  });
});
