import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createGitHubIssuesWorkProvider,
  createGitHubIssuesWorkProviderFromEnv
} from "../../src/work/github-issues-adapter.js";

type CapturedRequest = {
  url: string;
  method: string;
  body: unknown;
  authorization: string | null;
};

function githubIssue(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    id: 1000,
    number: 312,
    title: "Investigate session migration strategy",
    body: "Follow up.\n\nDue date: 2026-06-29",
    state: "open",
    state_reason: null,
    html_url: "https://github.example/owner/repo/issues/312",
    updated_at: "2026-06-26T10:20:00Z",
    assignees: [
      {
        id: 42,
        login: "jakob"
      }
    ],
    labels: [
      {
        name: "planned"
      }
    ],
    ...overrides
  };
}

function responseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function createFakeFetch(handler: (request: CapturedRequest) => Response): {
  fetchImpl: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];

  return {
    requests,
    fetchImpl(input, init) {
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const request = {
        url,
        method: init?.method ?? "GET",
        body,
        authorization: new Headers(init?.headers).get("Authorization")
      };
      requests.push(request);
      return Promise.resolve(handler(request));
    }
  };
}

describe("GitHub Issues WorkProvider", () => {
  it("uses the base64 private key when the direct-key env variable is blank", () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048
    });
    const privateKeyBase64 = Buffer.from(
      privateKey.export({ type: "pkcs1", format: "pem" })
    ).toString("base64");

    expect(() =>
      createGitHubIssuesWorkProviderFromEnv({
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_APP_ID: "12345",
        GITHUB_APP_INSTALLATION_ID: "999",
        GITHUB_APP_PRIVATE_KEY: "",
        GITHUB_APP_PRIVATE_KEY_BASE64: privateKeyBase64
      })
    ).not.toThrow();
  });

  it("creates a GitHub issue with a Luma idempotency marker and returns a provider-neutral reference", async () => {
    const fake = createFakeFetch((request) => {
      if (request.url.includes("/search/issues")) {
        return responseJson({ items: [] });
      }

      if (request.url.endsWith("/repos/owner/repo/issues")) {
        return responseJson(githubIssue());
      }

      return responseJson({ message: "not found" }, 404);
    });
    const provider = createGitHubIssuesWorkProvider({
      token: "token",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://api.github.example",
      fetchImpl: fake.fetchImpl
    });

    const reference = await provider.createWorkItem({
      title: "Investigate session migration strategy",
      description: "Follow up.",
      assigneeProviderUserId: "jakob",
      mentionProviderUserIds: ["jakob", "philipp"],
      dueDate: "2026-06-29",
      labels: ["meeting-follow-up"],
      idempotencyKey: "workspace:meeting:intent:execute"
    });

    expect(reference).toEqual({
      providerId: "github-issues",
      objectType: "work-item",
      externalId: "312",
      url: "https://github.example/owner/repo/issues/312",
      version: "2026-06-26T10:20:00Z"
    });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]?.body).toEqual({
      title: "Investigate session migration strategy",
      body: [
        "Follow up.",
        "\ncc @jakob @philipp",
        "",
        "<!-- luma-generated-section-start -->",
        "Due date: 2026-06-29",
        "<!-- luma-idempotency-key: workspace:meeting:intent:execute -->",
        "<!-- luma-generated-section-end -->"
      ].join("\n"),
      assignees: ["jakob"],
      labels: ["meeting-follow-up"]
    });
  });

  it("returns an existing issue when the idempotency marker is already present", async () => {
    const fake = createFakeFetch((request) => {
      if (request.url.includes("/search/issues")) {
        return responseJson({ items: [githubIssue()] });
      }

      throw new Error("create issue should not be called");
    });
    const provider = createGitHubIssuesWorkProvider({
      token: "token",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://api.github.example",
      fetchImpl: fake.fetchImpl
    });

    const reference = await provider.createWorkItem({
      title: "Investigate session migration strategy",
      description: "Follow up.",
      assigneeProviderUserId: "jakob",
      mentionProviderUserIds: ["jakob"],
      dueDate: "2026-06-29",
      labels: ["meeting-follow-up"],
      idempotencyKey: "workspace:meeting:intent:execute"
    });

    expect(reference.externalId).toBe("312");
    expect(fake.requests).toHaveLength(1);
  });

  it("escapes a canonical JSON idempotency tuple as one GitHub search phrase", async () => {
    const fake = createFakeFetch((request) => {
      if (request.url.includes("/search/issues")) {
        return responseJson({ items: [githubIssue()] });
      }

      throw new Error("create issue should not be called");
    });
    const provider = createGitHubIssuesWorkProvider({
      token: "token",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://api.github.example",
      fetchImpl: fake.fetchImpl
    });
    const idempotencyKey = JSON.stringify([
      "workspace",
      "meeting:with:colons",
      "intent:with:colons",
      "execute"
    ]);

    await provider.createWorkItem({
      title: "Investigate tuple marker escaping",
      description: "Follow up.",
      assigneeProviderUserId: null,
      mentionProviderUserIds: [],
      dueDate: null,
      labels: [],
      idempotencyKey
    });

    const searchUrl = fake.requests[0]?.url;

    if (!searchUrl) {
      throw new Error("expected an idempotency search request");
    }

    expect(new URL(searchUrl).searchParams.get("q")).toBe(
      `repo:owner/repo is:issue ${JSON.stringify(
        `luma-idempotency-key: ${idempotencyKey}`
      )}`
    );
  });

  it("normalizes GitHub issue status, assignees, labels, and body due date into WorkItem", async () => {
    const fake = createFakeFetch((request) => {
      if (request.url.endsWith("/repos/owner/repo/issues/312")) {
        return responseJson(githubIssue());
      }

      return responseJson({ message: "not found" }, 404);
    });
    const provider = createGitHubIssuesWorkProvider({
      token: "token",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://api.github.example",
      fetchImpl: fake.fetchImpl
    });

    const workItem = await provider.getWorkItem("owner/repo#312");

    expect(workItem).toEqual({
      id: "owner/repo#312",
      providerId: "github-issues",
      externalId: "312",
      title: "Investigate session migration strategy",
      description: "Follow up.\n\nDue date: 2026-06-29",
      status: "planned",
      assignees: [
        {
          id: "42",
          displayName: "jakob",
          username: "jakob"
        }
      ],
      dueDate: "2026-06-29",
      labels: ["planned"],
      projectId: null,
      parentId: null,
      url: "https://github.example/owner/repo/issues/312",
      updatedAt: "2026-06-26T10:20:00Z"
    });
  });

  it("uses a GitHub App installation token so created issues are authored by the bot", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048
    });
    const privateKeyPem = privateKey
      .export({
        type: "pkcs1",
        format: "pem"
      })
      .toString();
    const fake = createFakeFetch((request) => {
      if (request.url.endsWith("/app/installations/999/access_tokens")) {
        return responseJson({
          token: "ghs_installation_token",
          expires_at: "2026-06-26T11:00:00Z"
        });
      }

      if (request.url.includes("/search/issues")) {
        return responseJson({ items: [] });
      }

      if (request.url.endsWith("/repos/owner/repo/issues")) {
        return responseJson(githubIssue());
      }

      return responseJson({ message: "not found" }, 404);
    });
    const provider = createGitHubIssuesWorkProvider({
      auth: {
        type: "github-app",
        appId: "12345",
        installationId: "999",
        privateKey: privateKeyPem
      },
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://api.github.example",
      fetchImpl: fake.fetchImpl,
      now: () => new Date("2026-06-26T10:20:00Z")
    });

    await provider.createWorkItem({
      title: "Investigate session migration strategy",
      description: "Follow up.",
      assigneeProviderUserId: "jakob",
      mentionProviderUserIds: [],
      dueDate: "2026-06-29",
      labels: ["meeting-follow-up"],
      idempotencyKey: "workspace:meeting:intent:execute"
    });

    const tokenRequests = fake.requests.filter((request) =>
      request.url.endsWith("/app/installations/999/access_tokens")
    );
    const githubApiRequests = fake.requests.filter(
      (request) => !request.url.endsWith("/app/installations/999/access_tokens")
    );

    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
    expect(githubApiRequests.map((request) => request.authorization)).toEqual([
      "Bearer ghs_installation_token",
      "Bearer ghs_installation_token"
    ]);
  });
});
