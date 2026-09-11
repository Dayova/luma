import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinearWorkProvider } from "../../src/work/linear-work-provider.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const teamId = "11111111-1111-4111-8111-111111111111";
function issue(index: number, state = "started") {
  return {
    id: `issue-${index}`,
    identifier: `DAY-${index}`,
    title: `Validation ${index}`,
    description: "Original hypothesis and validation scope.",
    url: `https://linear.app/dayova/issue/DAY-${index}`,
    updatedAt: "2026-09-11T10:00:00.000Z",
    archivedAt: null,
    dueDate: null,
    team: { id: teamId },
    project: { id: "project" },
    parent: null,
    state: { type: state, name: state },
    assignee: { id: "linear-jakob", displayName: "Jakob", email: "jakob@example.test" },
    labels: { nodes: [{ name: "validation" }], pageInfo: { hasNextPage: false } }
  };
}
function fixture(count = 100) {
  const wire = {
    team: { id: teamId },
    issues: {
      nodes: Array.from({ length: count }, (_, index) =>
        issue(index, index % 2 ? "completed" : "started")
      ),
      pageInfo: { hasNextPage: false }
    }
  };
  const requests: Array<{ query: string; variables: { teamId: string; first: number } }> =
    [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
    if (typeof init?.body !== "string") throw new Error("Expected native JSON body");
    requests.push(JSON.parse(init.body) as (typeof requests)[number]);
    return Promise.resolve(
      new Response(JSON.stringify({ data: wire }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
  });
  const provider = createLinearWorkProvider({ apiKey: "test-only", teamId });
  const discover = () =>
    provider.discoverWorkItems!({ workspaceId: "dayova", limit: 100 });
  return { wire, requests, fetch, provider, discover };
}
describe("actual Linear complete structured-work catalog", () => {
  it("requires an exact readable team even when the issue filter returns no rows", async () => {
    const f = fixture(0);
    expect(await f.discover()).toEqual({ items: [], complete: true });
    f.wire.team.id = "different-team";
    await expect(f.discover()).rejects.toThrow("unavailable");
  });
  it("returns all 100 exact records and nested fields in one native request, including completed work", async () => {
    const f = fixture();
    const result = await f.discover();
    expect(result.complete).toBe(true);
    expect(result.items).toHaveLength(100);
    expect(result.items.find((item) => item.externalId === "DAY-1")).toMatchObject({
      id: "issue-1",
      status: "completed",
      assignees: [
        { id: "linear-jakob", displayName: "Jakob", username: "jakob@example.test" }
      ],
      labels: ["validation"],
      projectId: "project",
      parentId: null,
      description: "Original hypothesis and validation scope.",
      updatedAt: "2026-09-11T10:00:00.000Z"
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.requests[0]!.variables).toEqual({
      teamId,
      teamSelector: teamId,
      first: 100
    });
    expect(f.requests[0]!.query).toContain("includeArchived: false");
    expect(f.requests[0]!.query).toContain("labels(first: 51)");
    expect(f.requests[0]!.query).not.toContain("mutation");
  });
  it("keeps a delayed single response bounded without multiplying requests per record", async () => {
    const f = fixture();
    f.fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ data: f.wire }), {
                  status: 200,
                  headers: { "content-type": "application/json" }
                })
              ),
            25
          );
        })
    );
    expect((await f.discover()).items).toHaveLength(100);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["issues", "labels", "label-count"])(
    "withholds complete absence when %s pagination is incomplete",
    async (kind) => {
      const f = fixture(1);
      if (kind === "issues") f.wire.issues.pageInfo.hasNextPage = true;
      if (kind === "labels") f.wire.issues.nodes[0]!.labels.pageInfo.hasNextPage = true;
      if (kind === "label-count")
        f.wire.issues.nodes[0]!.labels.nodes = Array.from({ length: 51 }, (_, index) => ({
          name: `label-${index}`
        }));
      expect((await f.discover()).complete).toBe(false);
      expect(f.fetch).toHaveBeenCalledTimes(1);
    }
  );
  it.each([
    "team",
    "duplicate",
    "state",
    "assignee",
    "missing-page",
    "archived",
    "oversized"
  ])("rejects an unverifiable %s response without a follow-up fetch", async (kind) => {
    const f = fixture(1);
    let wire: unknown = f.wire;
    if (kind === "team") f.wire.issues.nodes[0]!.team.id = "foreign-team";
    if (kind === "duplicate")
      f.wire.issues.nodes.push(structuredClone(f.wire.issues.nodes[0]!));
    if (kind === "state") f.wire.issues.nodes[0]!.state.type = "invented-state";
    if (kind === "assignee")
      wire = {
        issues: {
          ...f.wire.issues,
          nodes: [{ ...f.wire.issues.nodes[0], assignee: { id: "user" } }]
        }
      };
    if (kind === "missing-page") wire = { issues: { nodes: f.wire.issues.nodes } };
    if (kind === "archived")
      wire = {
        issues: {
          ...f.wire.issues,
          nodes: [{ ...f.wire.issues.nodes[0], archivedAt: "2026-09-11T10:00:00.000Z" }]
        }
      };
    if (kind === "oversized") f.wire.issues.nodes[0]!.description = "x".repeat(64001);
    f.fetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: wire }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    await expect(f.discover()).rejects.toThrow(
      "complete current Linear catalog is unavailable"
    );
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([200, 400, 429, 503])(
    "never treats HTTP %s error/partial data as complete or retries it",
    async (status) => {
      const f = fixture(1);
      f.fetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: f.wire,
              errors: [
                { message: "Private error payload", extensions: { code: "RATELIMITED" } }
              ]
            }),
            { status, headers: { "content-type": "application/json" } }
          )
        )
      );
      const error = await f.discover().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("Private error payload");
      expect(f.fetch).toHaveBeenCalledTimes(1);
    }
  );
  it("aborts an unresponsive native request at the owned deadline and does not retry", async () => {
    vi.useFakeTimers();
    const f = fixture(1);
    let signal: AbortSignal | null | undefined;
    f.fetch.mockImplementation((_url, init) => {
      signal = init?.signal;
      return new Promise(() => {});
    });
    const pending = expect(f.discover()).rejects.toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(15001);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("reads an explicitly named archived issue through the existing exact-reference path", async () => {
    const f = fixture(1);
    const archived = {
      ...issue(1, "completed"),
      archivedAt: "2026-09-11T10:00:00.000Z",
      teamId,
      projectId: "project",
      parentId: null,
      assigneeId: null,
      stateId: null,
      assignee: null,
      state: { id: "done", type: "completed", name: "Done" },
      reactions: [],
      sharedAccess: {
        isShared: false,
        sharedWithCount: 0,
        viewerHasOnlySharedAccess: false,
        disallowedIssueFields: [],
        sharedWithUsers: []
      }
    };
    f.fetch.mockImplementation((_url, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected native request");
      const body = JSON.parse(init.body) as { query: string };
      const result = body.query.includes("Issue_Labels")
        ? { issue: { labels: { nodes: [], pageInfo: { hasNextPage: false } } } }
        : body.query.includes("workflowState(")
          ? { workflowState: archived.state }
          : { issue: archived };
      return Promise.resolve(
        new Response(JSON.stringify({ data: result }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    });
    const result = await f.provider.getWorkItem("DAY-1");
    expect(result.externalId).toBe("DAY-1");
    expect(result.title).toBe("Validation 1");
  });
});
