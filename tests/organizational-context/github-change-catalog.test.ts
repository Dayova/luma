import { describe, expect, it } from "vitest";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createOrganizationalContext } from "../../src/organizational-context/organizational-context.js";
import { createGitHubCodeProvider } from "../../src/code/github-code-provider.js";
import { createGitHubChangeContextCatalog } from "../../src/organizational-context/github-change-context-catalog.js";

const repository = "dayova/luma";
const now = "2026-09-11T06:00:00.000Z";
const audience = {
  workspaceId: "dayova",
  personIds: ["jakob", "fabius", "philipp", "julius"]
};
const head = "a".repeat(40);

describe("GitHub PR/activity context through the real CodeProvider", () => {
  it.each(["changed", "geändert"])(
    "selects the generic %s activity scope through the real core and revalidates provider events",
    async (term) => {
      const h = harness();
      const database = await createPgliteDatabase();
      try {
        const context = createOrganizationalContext({
          database,
          catalogs: [h.catalog],
          now: () => new Date(now)
        });
        const request = {
          audience,
          subject: { type: "conversation" as const, id: "founder-updates" },
          purpose: "answer-question" as const,
          concepts: [term],
          time: { mode: "current" as const },
          limit: 5,
          maxCharacters: 12000
        };
        const result = await context.retrieve(request);
        expect(result.sources).toHaveLength(1);
        const source = result.sources[0]!;
        expect(source.title).toContain("recent activity");
        expect(source.content).toContain('"matching":"recent-feed"');
        expect(source.content).toContain('"requestedLiteralTerms":["' + term + '"]');
        expect(source.content).toContain(
          "not words or claims supplied by the repository"
        );
        expect(source.content).toContain("Preserve history");
        await expect(
          context.requireCurrent(request, result.receiptId)
        ).resolves.toBeUndefined();
        h.removeEvents();
        await expect(context.requireCurrent(request, result.receiptId)).rejects.toThrow();
        expect((await context.retrieve(request)).sources).toHaveLength(0);
        h.revoke();
        const reads = h.requests.length;
        expect((await context.retrieve(request)).sources).toHaveLength(0);
        expect(h.requests).toHaveLength(reads);
      } finally {
        await database.close();
      }
    }
  );
  it("keeps draft work proposed, rereads merged state, versions body changes and refuses revocation", async () => {
    const h = harness();
    const result = await h.catalog.search({ audience, concepts: ["history"], limit: 4 });
    expect(result.sourceIds).toHaveLength(2);
    expect(result.complete).toBe(false);
    const prId = result.sourceIds[0]!;
    const initial = await h.catalog.read({ audience, sourceId: prId });
    expect(initial).toMatchObject({
      standing: "proposed",
      authority: "source",
      externalReference: {
        objectType: "pull-request",
        url: `https://github.com/${repository}/pull/7`
      }
    });
    expect(initial?.content).toContain("not deployed");
    h.pr.merged = true;
    h.pr.state = "closed";
    h.pr.draft = false;
    const merged = await h.catalog.read({ audience, sourceId: prId });
    expect(merged?.standing).toBe("current");
    expect(merged?.version).not.toBe(initial?.version);
    h.pr.body = "Changed history preservation conditions";
    expect((await h.catalog.read({ audience, sourceId: prId }))?.version).not.toBe(
      merged?.version
    );
    h.revoke();
    const calls = h.requests.length;
    expect(await h.catalog.read({ audience, sourceId: prId })).toBeNull();
    expect(h.requests).toHaveLength(calls);
    expect(
      (await h.catalog.search({ audience, concepts: ["history"], limit: 4 })).sourceIds
    ).toEqual([]);
  });

  it("retains explicit partial activity coverage and invalidates removed events without a cached fallback", async () => {
    const h = harness();
    const result = await h.catalog.search({ audience, concepts: ["history"], limit: 4 });
    const id = result.sourceIds[1]!;
    const activity = await h.catalog.read({ audience, sourceId: id });
    expect(activity?.title).toContain("recent activity");
    expect(activity?.content).toContain("delayed");
    expect(activity?.content).toContain("pull-request-opened");
    expect(activity?.content).not.toContain("deployed successfully");
    h.removeEvents();
    expect(await h.catalog.read({ audience, sourceId: id })).toBeNull();
    expect(
      (await h.catalog.search({ audience, concepts: ["history"], limit: 4 })).sourceIds
    ).toEqual([result.sourceIds[0]]);
  });

  it("denies guests and a grant revoked during provider reads, without returning source IDs", async () => {
    const h = harness();
    expect(
      (
        await h.catalog.search({
          audience: { ...audience, personIds: [...audience.personIds, "guest"] },
          concepts: ["history"],
          limit: 4
        })
      ).sourceIds
    ).toEqual([]);
    expect(h.requests).toEqual([]);
    const result = await h.catalog.search({ audience, concepts: ["history"], limit: 4 });
    h.revokeOnRead();
    expect(await h.catalog.read({ audience, sourceId: result.sourceIds[0]! })).toBeNull();
    expect(
      await h.catalog.read({ audience, sourceId: result.sourceIds[0]! + "=" })
    ).toBeNull();
  });

  it("keeps PR search and activity failures partial and diagnostic text private", async () => {
    const h = harness();
    h.failReads();
    const result = await h.catalog.search({ audience, concepts: ["history"], limit: 4 });
    expect(result.sourceIds).toEqual([]);
    expect(result.warnings.join(" ")).toContain("unavailable");
    expect(JSON.stringify(result)).not.toContain("private diagnostic");
  });
});

function harness() {
  let granted = true;
  let events = true;
  let revokeDuringRead = false;
  let failed = false;
  const requests: string[] = [];
  const pr = {
    id: 70,
    number: 7,
    title: "Preserve history",
    body: "Retain history by default.",
    user: { id: 1, login: "jakob" },
    state: "open",
    draft: true,
    merged: false,
    html_url: `https://github.com/${repository}/pull/7`,
    updated_at: now,
    head: { sha: head },
    base: { sha: "b".repeat(40), repo: { full_name: repository } },
    additions: 1,
    deletions: 0,
    changed_files: 0,
    commits: 0,
    requested_reviewers: [],
    requested_teams: []
  };
  const provider = createGitHubCodeProvider({
    token: "synthetic-token",
    credentialScopeId: "founder-reader",
    repositories: [repository],
    now: () => new Date(now),
    fetchImpl: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      expect(url.origin).toBe("https://api.github.com");
      expect(init?.method).toBe("GET");
      requests.push(url.pathname);
      if (failed) return Promise.reject(new Error("private diagnostic"));
      let response: unknown;
      if (
        url.pathname === "/search/issues" &&
        !(url.searchParams.get("q") ?? "").includes('"history"')
      )
        response = { total_count: 0, incomplete_results: false, items: [] };
      else if (url.pathname === "/search/issues")
        response = {
          total_count: 1,
          incomplete_results: false,
          items: [
            { number: 7, html_url: pr.html_url, pull_request: { html_url: pr.html_url } }
          ]
        };
      else if (url.pathname === `/repos/${repository}/pulls/7`) {
        if (revokeDuringRead) granted = false;
        response = pr;
      } else if (/\/pulls\/7\/(files|commits|reviews)$/u.test(url.pathname))
        response = [];
      else if (url.pathname === `/repos/${repository}/events`)
        response = events
          ? [
              {
                id: "1",
                type: "PullRequestEvent",
                created_at: now,
                repo: { name: repository },
                payload: {
                  action: "opened",
                  number: 7,
                  pull_request: { title: "Preserve history", html_url: pr.html_url }
                }
              }
            ]
          : [];
      else throw new Error("Unexpected synthetic endpoint");
      return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
    }
  });
  return {
    pr,
    requests,
    revoke: () => {
      granted = false;
    },
    removeEvents: () => {
      events = false;
    },
    revokeOnRead: () => {
      revokeDuringRead = true;
    },
    failReads: () => {
      failed = true;
    },
    catalog: createGitHubChangeContextCatalog({
      codeProvider: provider,
      now: () => new Date(now),
      authorize: (input) =>
        Promise.resolve(
          granted &&
            input.audience.workspaceId === audience.workspaceId &&
            input.audience.personIds.every((person) =>
              audience.personIds.includes(person)
            )
        )
    })
  };
}
