import { describe, expect, it } from "vitest";
import { createWorkspaceBoundWorkCatalog } from "../../src/app/workspace-bound-work-catalog.js";
import type {
  WorkCatalog,
  WorkItem,
  WorkProvider,
  WorkQuery
} from "../../src/work/interface.js";

class RecordingWorkCatalog implements WorkCatalog {
  readonly providerId = "linear";
  readonly identityProviderId = "linear";
  readonly supportsConditionalUpdates = false;
  readonly searchCalls: WorkQuery[] = [];
  readonly getCalls: string[] = [];

  searchWorkItems(query: WorkQuery): Promise<WorkItem[]> {
    this.searchCalls.push(query);
    return Promise.resolve([]);
  }

  getWorkItem(id: string): Promise<WorkItem> {
    this.getCalls.push(id);

    return Promise.resolve({
      id,
      providerId: this.providerId,
      externalId: id,
      title: "Unreachable in this test",
      description: "",
      status: "backlog",
      assignees: [],
      dueDate: null,
      labels: [],
      projectId: null,
      parentId: null,
      url: "https://linear.app/dayova/issue/LUM-26",
      updatedAt: "2026-08-10T00:00:00.000Z"
    });
  }
}

describe("WorkspaceBoundWorkCatalog", () => {
  it("fails closed for a blank logical workspace or provider scope", () => {
    const delegatedCatalog = new RecordingWorkCatalog();

    expect(() =>
      createWorkspaceBoundWorkCatalog({
        workspaceId: "   ",
        providerScopeId: "team_dayova",
        workCatalog: delegatedCatalog
      })
    ).toThrow("workspaceId is required for a workspace-bound Work Catalog");
    expect(() =>
      createWorkspaceBoundWorkCatalog({
        workspaceId: "workspace_dayova",
        providerScopeId: "   ",
        workCatalog: delegatedCatalog
      })
    ).toThrow("providerScopeId is required for a workspace-bound Work Catalog");
    expect(delegatedCatalog.searchCalls).toEqual([]);
    expect(delegatedCatalog.getCalls).toEqual([]);
  });

  it("rejects a different logical Luma workspace before reaching its catalog", async () => {
    const delegatedCatalog = new RecordingWorkCatalog();
    const catalog = createWorkspaceBoundWorkCatalog({
      workspaceId: "workspace_dayova",
      providerScopeId: "team_dayova",
      workCatalog: delegatedCatalog
    });

    await expect(
      catalog.searchWorkItems({
        workspaceId: "workspace_other",
        text: "release readiness",
        limit: 5
      })
    ).rejects.toMatchObject({
      code: "workspace-bound-work-catalog-workspace-mismatch"
    });

    expect(delegatedCatalog.searchCalls).toEqual([]);
  });

  it("normalizes configured scopes while preserving catalog metadata and translating only a copied search workspace", async () => {
    const delegatedCatalog = new RecordingWorkCatalog();
    const catalog = createWorkspaceBoundWorkCatalog({
      workspaceId: "  workspace_dayova  ",
      providerScopeId: "  team_dayova  ",
      workCatalog: delegatedCatalog
    });
    const query: WorkQuery = {
      workspaceId: "workspace_dayova",
      text: "release readiness",
      limit: 5
    };

    await catalog.searchWorkItems(query);
    await catalog.getWorkItem("issue-26");

    expect(catalog.providerId).toBe("linear");
    expect(catalog.identityProviderId).toBe("linear");
    expect(catalog.supportsConditionalUpdates).toBe(false);
    expect(Object.hasOwn(catalog, "createWorkItem")).toBe(false);
    expect(Object.hasOwn(catalog, "updateWorkItem")).toBe(false);
    expect(Object.hasOwn(catalog, "addComment")).toBe(false);
    expect(delegatedCatalog.searchCalls).toEqual([
      {
        workspaceId: "team_dayova",
        text: "release readiness",
        limit: 5
      }
    ]);
    expect(delegatedCatalog.searchCalls[0]).not.toBe(query);
    expect(query).toEqual({
      workspaceId: "workspace_dayova",
      text: "release readiness",
      limit: 5
    });
    expect(delegatedCatalog.getCalls).toEqual(["issue-26"]);
  });

  it("rejects a direct writer-capable provider rather than narrowing it structurally", () => {
    const readCatalog = new RecordingWorkCatalog();
    const writerCapableDelegate: WorkProvider = {
      providerId: readCatalog.providerId,
      identityProviderId: readCatalog.identityProviderId,
      supportsConditionalUpdates: readCatalog.supportsConditionalUpdates,
      searchWorkItems: (query) => readCatalog.searchWorkItems(query),
      getWorkItem: (id) => readCatalog.getWorkItem(id),
      createWorkItem: () => Promise.reject(new Error("must remain unreachable")),
      updateWorkItem: () => Promise.reject(new Error("must remain unreachable")),
      addComment: () => Promise.reject(new Error("must remain unreachable"))
    };
    expect(() =>
      createWorkspaceBoundWorkCatalog({
        workspaceId: "workspace_dayova",
        providerScopeId: "team_dayova",
        workCatalog: writerCapableDelegate
      })
    ).toThrow("Workspace-bound Work Catalog does not accept direct writer methods");
  });
});
