import { describe, expect, it } from "vitest";
import {
  createLinearReadOnlyWorkCatalog,
  createLinearReadOnlyWorkCatalogFromEnv,
  LinearReadOnlyWorkCatalogError,
  type LinearReadOnlyApi,
  type LinearReadOnlyApiIssue
} from "../../src/work/linear-read-only-work-catalog.js";

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

class RecordingLinearReadOnlyApi implements LinearReadOnlyApi {
  readonly searchCalls: Array<{ teamId: string; text: string; limit: number }> = [];
  readonly getCalls: string[] = [];
  readonly mutationRequests: string[] = [];
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

  createIssue(): Promise<never> {
    return this.recordUnexpectedMutation("createIssue");
  }

  updateIssue(): Promise<never> {
    return this.recordUnexpectedMutation("updateIssue");
  }

  addComment(): Promise<never> {
    return this.recordUnexpectedMutation("addComment");
  }

  private recordUnexpectedMutation(operation: string): Promise<never> {
    this.mutationRequests.push(operation);
    return Promise.reject(new Error(`Unexpected Linear mutation: ${operation}`));
  }
}

describe("LinearReadOnlyWorkCatalog", () => {
  it("uses a team-scoped, bounded search and maps provider-neutral Work Items", async () => {
    const api = new RecordingLinearReadOnlyApi();
    const catalog = createLinearReadOnlyWorkCatalog({
      api,
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
    const catalog = createLinearReadOnlyWorkCatalog({ api, teamId: "team-luma" });

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
    const catalog = createLinearReadOnlyWorkCatalog({ api, teamId: "team-luma" });

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

  it("exposes and invokes no mutation surface", async () => {
    const api = new RecordingLinearReadOnlyApi();
    const catalog = createLinearReadOnlyWorkCatalog({ api, teamId: "team-luma" });

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
    expect(api.mutationRequests).toEqual([]);
  });

  it("fails closed for malformed query input before reaching Linear", async () => {
    const api = new RecordingLinearReadOnlyApi();
    const catalog = createLinearReadOnlyWorkCatalog({ api, teamId: "team-luma" });

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
