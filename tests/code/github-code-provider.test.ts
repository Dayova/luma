import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createGitHubCodeProvider,
  createGitHubCodeProviderFromEnv,
  type GitHubCodeProviderConfig
} from "../../src/code/github-code-provider.js";

const repo = "dayova/luma";
const head = "a".repeat(40);
const base = "b".repeat(40);
const second = "c".repeat(40);
const time = "2026-09-10T10:00:00.000Z";
const prefix = `/repos/${repo}`;
const headPath = `${prefix}/commits/heads%2Fmain`;
const user = { id: 1, login: "founder" };

describe("GitHub read-only CodeProvider", () => {
  it("reads a full immutable commit with honest unlinked author identity", async () => {
    const h = harness();
    h.json(`${prefix}/commits/${head}`, commit(head));
    const result = await h.provider.getCommit("Dayova/Luma", head);
    expect(result).toEqual({
      repository: repo,
      sha: head,
      url: `https://github.com/${repo}/commit/${head}`,
      message: "Preserve source history",
      author: null,
      committedAt: time,
      observedAt: time
    });
    expect(h.requests).toHaveLength(1);
    const request = h.requests[0]!;
    expect(request.init.method).toBe("GET");
    expect(request.init.redirect).toBe("manual");
    expect(new Headers(request.init.headers).get("authorization")).toBe(
      "Bearer test-read-token"
    );
    expect(h.provider.readScope).toEqual({
      credentialScopeId: "dayova-code-reader",
      repositories: [repo]
    });
  });

  it("rejects another repository and mutable public commit IDs before any request", async () => {
    const h = harness();
    await expect(h.provider.getCommit("other/private", head)).rejects.toMatchObject({
      code: "repository-not-allowed"
    });
    await expect(h.provider.getCommit(repo, "main")).rejects.toMatchObject({
      code: "query-invalid"
    });
    await expect(
      h.provider.searchCode({ repository: repo, text: "x repo:other/private", limit: 2 })
    ).rejects.toMatchObject({ code: "query-invalid" });
    expect(h.requests).toEqual([]);
  });

  it("requires a separate configured read scope and never falls back to a writer token", () => {
    expect(() =>
      createGitHubCodeProviderFromEnv({
        GITHUB_TOKEN: "writer-token",
        GITHUB_REPOSITORY: repo
      })
    ).toThrow("configuration-invalid");
    expect(() => harness({ repositories: [repo, "Dayova/Luma"] })).toThrow(
      "configuration-invalid"
    );
    expect(() => harness({ apiBaseUrl: "http://api.github.com" })).toThrow(
      "configuration-invalid"
    );
    expect(() => harness({ webBaseUrl: "https://user:secret@github.com" })).toThrow(
      "configuration-invalid"
    );
  });

  it("reads PR metadata, bounded files, commits and actual/requested reviewers without inferring work links", async () => {
    const h = harness();
    prRoutes(h);
    h.json(`${prefix}/pulls/7/reviews`, [
      { user: { id: 2, login: "reviewer" } },
      { user }
    ]);
    const result = await h.provider.getPullRequest(repo, 7);
    expect(result).toMatchObject({
      repository: repo,
      number: 7,
      state: "open",
      headSha: head,
      baseSha: base,
      updatedAt: time,
      filesChanged: ["src/a.ts"],
      commits: [{ sha: head }],
      reviewers: [{ username: "founder" }, { username: "reviewer" }],
      linkedWorkItemIds: []
    });
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.warnings.join(" ")).toContain(
      "Linked work relationships are not verified"
    );
    expect(h.requests.every((request) => request.init.method === "GET")).toBe(true);
    expect(
      h.requests.filter((request) => request.url.pathname === `${prefix}/pulls/7`)
    ).toHaveLength(2);
  });

  it("exposes truncated PR pagination and GitHub's commit cap", async () => {
    const h = harness({ maxPages: 1 });
    prRoutes(h, { changed_files: 101, commits: 251 });
    h.json(`${prefix}/pulls/7/files`, [{ filename: "src/a.ts" }], {
      link: `<https://api.github.com${prefix}/pulls/7/files?per_page=100&page=2>; rel="next"`
    });
    const result = await h.provider.getPullRequest(repo, 7);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.warnings.join(" ")).toContain("pagination limit");
    expect(result.coverage.warnings.join(" ")).toContain("250 PR commits");
  });

  it("refuses a PR that changed while related lists were read", async () => {
    const h = harness();
    prRoutes(h);
    let reads = 0;
    h.on(`${prefix}/pulls/7`, () =>
      json(pull({ head: { sha: ++reads === 1 ? head : second } }))
    );
    await expect(h.provider.getPullRequest(repo, 7)).rejects.toMatchObject({
      code: "source-changed",
      retryable: true
    });
  });

  it.each([
    "https://evil.example/private?page=2",
    `https://api.github.com/repos/other/private/pulls/7/files?per_page=100&page=2`,
    `https://api.github.com${prefix}/pulls/7/files?per_page=100&page=8`
  ])("does not follow an untrusted pagination target: %s", async (next) => {
    const h = harness();
    prRoutes(h);
    h.json(`${prefix}/pulls/7/files`, [], { link: `<${next}>; rel="next"` });
    await expect(h.provider.getPullRequest(repo, 7)).rejects.toMatchObject({
      code: "response-invalid"
    });
    expect(
      h.requests.every((request) => request.url.origin === "https://api.github.com")
    ).toBe(true);
    expect(h.requests.some((request) => request.url.href === next)).toBe(false);
  });

  it("follows validated pagination within its configured bound", async () => {
    const h = harness();
    prRoutes(h, { changed_files: 2 });
    h.on(`${prefix}/pulls/7/files`, (url) =>
      url.searchParams.get("page") === "1"
        ? json([{ filename: "src/a.ts" }], {
            link: `<https://api.github.com${prefix}/pulls/7/files?page=2&per_page=100>; rel="next"`
          })
        : json([{ filename: "src/b.ts" }])
    );
    const result = await h.provider.getPullRequest(repo, 7);
    expect(result.filesChanged).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.coverage.warnings.join(" ")).not.toContain("pagination");
  });

  it("verifies actual file bytes at a qualified immutable branch head, without trusting search snippets", async () => {
    const h = harness();
    const source = "// history\nexport const preserve = true;\n";
    const blob = searchRoutes(h, source);
    const result = await h.provider.searchCode({
      repository: repo,
      text: "preserve",
      limit: 3
    });
    expect(result.results).toEqual([
      {
        repository: repo,
        path: "src/a.ts",
        excerpt: source,
        startLine: 1,
        endLine: 3,
        commitSha: head,
        blobSha: blob.sha,
        url: `https://github.com/${repo}/blob/${head}/src/a.ts#L1-L3`
      }
    ]);
    expect(result.commitSha).toBe(head);
    expect(result.results[0]?.blobSha).not.toBe(result.commitSha);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.warnings.join(" ")).toContain("index");
    const contentRequest = h.requests.find((request) =>
      request.url.pathname.endsWith("/contents/src/a.ts")
    );
    expect(contentRequest?.url.searchParams.get("ref")).toBe(head);
    expect(
      h.requests.filter((request) => request.url.pathname === headPath)
    ).toHaveLength(2);
    expect(
      h.requests
        .find((request) => request.url.pathname === "/search/code")
        ?.url.searchParams.get("q")
    ).toBe(`repo:${repo} in:file "preserve"`);
  });

  it("keeps excerpt line positions in the original Unicode source", async () => {
    const h = harness();
    const lines = [
      "İ".repeat(100),
      ...Array.from({ length: 25 }, (_, i) => (i === 8 ? "preserve" : `line ${i}`))
    ];
    searchRoutes(h, lines.join("\n"));
    const result = await h.provider.searchCode({
      repository: repo,
      text: "preserve",
      limit: 1
    });
    expect(result.results[0]?.excerpt).toContain("preserve");
    expect(result.results[0]?.startLine).toBe(7);
  });

  it("does not use stale indexed snippets when the pinned blob differs", async () => {
    const h = harness();
    searchRoutes(h, "preserve");
    h.json("/search/code", searchResult(second));
    const result = await h.provider.searchCode({
      repository: repo,
      text: "preserve",
      limit: 1
    });
    expect(result.results).toEqual([]);
    expect(result.coverage.warnings.join(" ")).toContain("differs from the pinned");
  });

  it("rejects forged blob bytes even if the contents API repeats the search hash", async () => {
    const h = harness();
    const blob = searchRoutes(h, "preserve");
    h.json(`${prefix}/contents/src/a.ts`, {
      ...blob,
      content: Buffer.from("falsified").toString("base64"),
      size: 9
    });
    await expect(
      h.provider.searchCode({ repository: repo, text: "preserve", limit: 1 })
    ).rejects.toMatchObject({ code: "response-invalid" });
  });

  it("reports incomplete zero-result searches without claiming there is no code", async () => {
    const h = harness();
    searchRoutes(h, "preserve");
    h.json("/search/code", { total_count: 0, incomplete_results: true, items: [] });
    const result = await h.provider.searchCode({
      repository: repo,
      text: "preserve",
      limit: 1
    });
    expect(result.results).toEqual([]);
    expect(result.coverage).toMatchObject({ complete: false });
    expect(result.coverage.warnings.join(" ")).toContain("incomplete search");
  });

  it.each(["head", "default-branch"])(
    "detects a changed %s before returning current code",
    async (change) => {
      const h = harness();
      searchRoutes(h, "preserve");
      let reads = 0;
      if (change === "head")
        h.on(headPath, () => json(commit(++reads === 1 ? head : second)));
      else
        h.on(prefix, () =>
          json({
            full_name: repo,
            html_url: `https://github.com/${repo}`,
            default_branch: ++reads === 1 ? "main" : "release"
          })
        );
      await expect(
        h.provider.searchCode({ repository: repo, text: "preserve", limit: 1 })
      ).rejects.toMatchObject({ code: "source-changed" });
    }
  );

  it("omits unreadable and oversized files with explicit incomplete coverage", async () => {
    const h = harness({ maxFileBytes: 4 });
    searchRoutes(h, "preserve");
    let result = await h.provider.searchCode({
      repository: repo,
      text: "preserve",
      limit: 1
    });
    expect(result.results).toEqual([]);
    expect(result.coverage.warnings.join(" ")).toContain("byte limit");
    h.on(
      `${prefix}/contents/src/a.ts`,
      () => new Response("private error", { status: 404 })
    );
    result = await h.provider.searchCode({
      repository: repo,
      text: "preserve",
      limit: 1
    });
    expect(result.results).toEqual([]);
    expect(result.coverage.warnings.join(" ")).toContain("not-found");
    expect(JSON.stringify(result)).not.toContain("private error");
  });

  it("omits binary file bytes without passing them into context", async () => {
    const h = harness();
    searchRoutes(h, "preserve\0private");
    const result = await h.provider.searchCode({
      repository: repo,
      text: "preserve",
      limit: 1
    });
    expect(result.results).toEqual([]);
    expect(result.coverage.warnings.join(" ")).toContain("binary content");
  });

  it("reports witnessed push tips and merged PR events with provider timestamps and limited history", async () => {
    const h = harness();
    h.json(`${prefix}/events`, [
      event("push", "PushEvent", { head, before: base }),
      event("merge", "PullRequestEvent", {
        action: "merged",
        number: 7,
        pull_request: {
          title: "Merged fix",
          html_url: `https://github.com/${repo}/pull/7`
        }
      }),
      event("release", "ReleaseEvent", {
        action: "published",
        release: {
          name: "Release 1",
          tag_name: "v1",
          html_url: `https://github.com/${repo}/releases/tag/v1`
        }
      })
    ]);
    h.json(`${prefix}/commits/${head}`, commit(head, "2020-01-01T00:00:00.000Z"));
    const result = await h.provider.getRecentActivity({
      repository: repo,
      since: "2026-09-01T00:00:00.000Z"
    });
    expect(result.activities.map((activity) => activity.kind).sort()).toEqual([
      "commit-pushed",
      "pull-request-merged",
      "release-created"
    ]);
    expect(
      result.activities.find((activity) => activity.kind === "commit-pushed")
    ).toMatchObject({ occurredAt: time, commitSha: head, sourceEventId: "push" });
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.warnings.join(" ")).toContain("past 30 days");
  });

  it("reports rate limits without retrying or exposing provider response bodies", async () => {
    const h = harness();
    h.on(
      `${prefix}/commits/${head}`,
      () =>
        new Response("private diagnostic", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "retry-after": "45" }
        })
    );
    await expect(h.provider.getCommit(repo, head)).rejects.toMatchObject({
      code: "rate-limited",
      retryable: true,
      retryAfterMs: 45_000
    });
    expect(h.requests).toHaveLength(1);
  });

  it.each(["redirect", "foreign-link", "wrong-sha", "oversized"])(
    "rejects unsafe provider responses: %s",
    async (kind) => {
      const h = harness({ maxResponseBytes: 1_000 });
      h.on(`${prefix}/commits/${head}`, () =>
        kind === "redirect"
          ? new Response(null, {
              status: 302,
              headers: { location: "https://evil.example/secret" }
            })
          : json(
              kind === "foreign-link"
                ? {
                    ...commit(head),
                    html_url: `https://evil.example/${repo}/commit/${head}`
                  }
                : kind === "wrong-sha"
                  ? commit(second)
                  : { ...commit(head), padding: "x".repeat(2_000) }
            )
      );
      await expect(h.provider.getCommit(repo, head)).rejects.toMatchObject({
        code: "response-invalid"
      });
      expect(h.requests).toHaveLength(1);
    }
  );

  it("bounds a fetch that never settles and cancels a stalled response body", async () => {
    const h = harness({ requestTimeoutMs: 20, operationTimeoutMs: 100 });
    h.on(`${prefix}/commits/${head}`, () => new Promise<Response>(() => undefined));
    await expect(h.provider.getCommit(repo, head)).rejects.toMatchObject({
      code: "timeout"
    });
    expect(h.requests[0]?.init.signal?.aborted).toBe(true);
    const cancelled = vi.fn();
    h.on(
      `${prefix}/commits/${head}`,
      () => new Response(new ReadableStream({ cancel: cancelled }))
    );
    await expect(h.provider.getCommit(repo, head)).rejects.toMatchObject({
      code: "timeout"
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("enforces one operation request budget across provider subreads", async () => {
    const h = harness({ maxRequests: 1 });
    prRoutes(h);
    await expect(h.provider.getPullRequest(repo, 7)).rejects.toMatchObject({
      code: "read-limit"
    });
    expect(h.requests).toHaveLength(1);
  });

  it("rereads pinned excerpt bytes and current default head without consulting the search index", async () => {
    const h = harness();
    const blob = searchRoutes(h, "first\npreserve\nlast");
    const reference = {
      repository: repo,
      path: "src/a.ts",
      commitSha: head,
      blobSha: blob.sha,
      startLine: 2,
      endLine: 2
    };
    const result = await h.provider.getCurrentCodeExcerpt(reference);
    expect(result).toMatchObject({
      ...reference,
      excerpt: "preserve",
      committedAt: time,
      observedAt: time
    });
    expect(h.requests.some((request) => request.url.pathname === "/search/code")).toBe(
      false
    );
    h.json(headPath, commit(second));
    await expect(h.provider.getCurrentCodeExcerpt(reference)).resolves.toBeNull();
  });

  it.each([
    "deleted",
    "access-revoked",
    "changed-during-read",
    "branch-switch",
    "blob-changed",
    "line-range"
  ])("refuses ineligible current excerpt: %s", async (kind) => {
    const h = harness();
    const blob = searchRoutes(h, "preserve");
    const reference = {
      repository: repo,
      path: "src/a.ts",
      commitSha: head,
      blobSha: blob.sha,
      startLine: 1,
      endLine: 1
    };
    if (kind === "deleted" || kind === "access-revoked")
      h.on(
        `${prefix}/contents/src/a.ts`,
        () => new Response(null, { status: kind === "deleted" ? 404 : 403 })
      );
    if (kind === "changed-during-read") {
      let reads = 0;
      h.on(headPath, () => json(commit(++reads === 1 ? head : second)));
    }
    if (kind === "branch-switch") {
      let reads = 0;
      h.on(prefix, () =>
        json({
          full_name: repo,
          html_url: `https://github.com/${repo}`,
          default_branch: ++reads === 1 ? "main" : "release"
        })
      );
      h.json(`${prefix}/commits/heads%2Frelease`, commit(head));
    }
    if (kind === "blob-changed") reference.blobSha = second;
    if (kind === "line-range") reference.endLine = 2;
    await expect(h.provider.getCurrentCodeExcerpt(reference)).resolves.toBeNull();
  });
});

function harness(overrides: Partial<GitHubCodeProviderConfig> = {}) {
  type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
  const routes = new Map<string, Handler>();
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    );
    requests.push({ url, init });
    const handler = routes.get(url.pathname);
    if (!handler) throw new Error(`Unexpected fixture route ${url.pathname}`);
    return handler(url, init);
  };
  return {
    requests,
    provider: createGitHubCodeProvider({
      token: "test-read-token",
      credentialScopeId: "dayova-code-reader",
      repositories: [repo],
      fetchImpl,
      now: () => new Date(time),
      ...overrides
    }),
    on: (path: string, handler: Handler) => routes.set(path, handler),
    json: (path: string, value: unknown, headers?: Record<string, string>) =>
      routes.set(path, () => json(value, headers))
  };
}
function json(value: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    ...(headers ? { headers } : {})
  });
}
function commit(sha: string, committedAt = time) {
  return {
    sha,
    html_url: `https://github.com/${repo}/commit/${sha}`,
    author: null,
    commit: { message: "Preserve source history", committer: { date: committedAt } }
  };
}
function pull(overrides: Record<string, unknown> = {}) {
  return {
    id: 77,
    number: 7,
    title: "A fix",
    body: "Details",
    user,
    state: "open",
    draft: false,
    merged: false,
    html_url: `https://github.com/${repo}/pull/7`,
    updated_at: time,
    head: { sha: head },
    base: { sha: base, repo: { full_name: repo } },
    additions: 2,
    deletions: 1,
    changed_files: 1,
    commits: 1,
    requested_reviewers: [user],
    requested_teams: [],
    ...overrides
  };
}
function prRoutes(
  h: ReturnType<typeof harness>,
  overrides: Record<string, unknown> = {}
) {
  h.json(`${prefix}/pulls/7`, pull(overrides));
  h.json(`${prefix}/pulls/7/files`, [{ filename: "src/a.ts" }]);
  h.json(`${prefix}/pulls/7/commits`, [
    { sha: head, html_url: `https://github.com/${repo}/commit/${head}` }
  ]);
  h.json(`${prefix}/pulls/7/reviews`, []);
}
function searchResult(blobSha: string) {
  return {
    total_count: 1,
    incomplete_results: false,
    items: [
      {
        path: "src/a.ts",
        sha: blobSha,
        html_url: `https://github.com/${repo}/blob/${head}/src/a.ts`,
        repository: { full_name: repo },
        text_matches: [{ fragment: "UNTRUSTED SEARCH SNIPPET" }]
      }
    ]
  };
}
function searchRoutes(h: ReturnType<typeof harness>, source: string) {
  const bytes = Buffer.from(source);
  const sha = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  const blob = {
    type: "file",
    path: "src/a.ts",
    size: bytes.length,
    sha,
    encoding: "base64",
    content: bytes.toString("base64")
  };
  h.json(prefix, {
    full_name: repo,
    default_branch: "main",
    html_url: `https://github.com/${repo}`
  });
  h.json(headPath, commit(head));
  h.json("/search/code", searchResult(sha));
  h.json(`${prefix}/contents/src/a.ts`, blob);
  return blob;
}
function event(id: string, type: string, payload: unknown) {
  return { id, type, created_at: time, repo: { name: repo }, payload };
}
