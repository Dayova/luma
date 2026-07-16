import { describe, expect, it } from "vitest";
import {
  createLinearWorkProvider,
  type LinearApi,
  type LinearApiIssue,
  type LinearCreateIssueInput
} from "../../src/work/linear-work-provider.js";

function linearIssue(overrides: Partial<LinearApiIssue> = {}): LinearApiIssue {
  return {
    id: "issue-301",
    identifier: "DAY-301",
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
    url: "https://linear.app/dayova/issue/DAY-301",
    updatedAt: "2026-07-16T09:06:00.000Z",
    ...overrides
  };
}

class FakeLinearApi implements LinearApi {
  readonly createCalls: LinearCreateIssueInput[] = [];
  existing: LinearApiIssue | null = null;

  searchIssues(): Promise<LinearApiIssue[]> {
    return Promise.resolve([]);
  }

  findIssueByIdempotencyKey(): Promise<LinearApiIssue | null> {
    return Promise.resolve(this.existing);
  }

  getIssue(): Promise<LinearApiIssue> {
    return Promise.resolve(linearIssue());
  }

  createIssue(input: LinearCreateIssueInput): Promise<LinearApiIssue> {
    this.createCalls.push(input);
    return Promise.resolve(linearIssue({ description: input.description }));
  }

  updateIssue(): Promise<LinearApiIssue> {
    return Promise.resolve(linearIssue());
  }

  addComment(): Promise<void> {
    return Promise.resolve();
  }
}

describe("Linear WorkProvider", () => {
  it("creates a team issue with assignment, subscribers, and an idempotency marker", async () => {
    const api = new FakeLinearApi();
    const provider = createLinearWorkProvider({
      api,
      teamId: "63c160e7-ab70-4ef9-9822-0f85590ebb7f"
    });

    const reference = await provider.createWorkItem({
      title: "Prepare the release checklist",
      description: "Prepare the release checklist discussed in the Meeting.",
      assigneeProviderUserId: "67e00026-a426-4476-83bb-fe679fc5ca9c",
      mentionProviderUserIds: [
        "67e00026-a426-4476-83bb-fe679fc5ca9c",
        "5213a22b-1699-499f-8901-e34204add045"
      ],
      dueDate: "2026-07-20",
      labels: ["meeting-follow-up"],
      idempotencyKey: "workspace:meeting:intent:execute"
    });

    expect(api.createCalls).toEqual([
      {
        teamId: "63c160e7-ab70-4ef9-9822-0f85590ebb7f",
        title: "Prepare the release checklist",
        description: [
          "Prepare the release checklist discussed in the Meeting.",
          "",
          "<!-- luma-idempotency-key: workspace:meeting:intent:execute -->"
        ].join("\n"),
        assigneeId: "67e00026-a426-4476-83bb-fe679fc5ca9c",
        subscriberIds: [
          "67e00026-a426-4476-83bb-fe679fc5ca9c",
          "5213a22b-1699-499f-8901-e34204add045"
        ],
        dueDate: "2026-07-20",
        labelNames: ["meeting-follow-up"]
      }
    ]);
    expect(reference).toEqual({
      providerId: "linear",
      objectType: "work-item",
      externalId: "DAY-301",
      url: "https://linear.app/dayova/issue/DAY-301",
      version: "2026-07-16T09:06:00.000Z"
    });
  });

  it("returns the existing Linear issue when the idempotency marker is present", async () => {
    const api = new FakeLinearApi();
    api.existing = linearIssue();
    const provider = createLinearWorkProvider({ api, teamId: "team-dayova" });

    const reference = await provider.createWorkItem({
      title: "Prepare the release checklist",
      description: "Prepare it.",
      assigneeProviderUserId: null,
      mentionProviderUserIds: [],
      dueDate: null,
      labels: [],
      idempotencyKey: "workspace:meeting:intent:execute"
    });

    expect(reference.externalId).toBe("DAY-301");
    expect(api.createCalls).toHaveLength(0);
  });

  it("normalizes Linear workflow states into provider-neutral work states", async () => {
    const api = new FakeLinearApi();
    api.getIssue = () =>
      Promise.resolve(
        linearIssue({ stateType: "started", stateName: "Blocked", labels: ["blocked"] })
      );
    const provider = createLinearWorkProvider({ api, teamId: "team-dayova" });

    await expect(provider.getWorkItem("DAY-301")).resolves.toMatchObject({
      id: "DAY-301",
      providerId: "linear",
      status: "blocked",
      assignees: [
        {
          id: "67e00026-a426-4476-83bb-fe679fc5ca9c",
          displayName: "Jakob",
          username: "jakob@example.com"
        }
      ]
    });
  });
});
