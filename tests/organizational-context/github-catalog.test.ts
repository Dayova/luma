import { describe, expect, it, vi } from "vitest";
import type { CodeProvider, CurrentCodeExcerpt } from "../../src/code/interface.js";
import { GitHubCodeProviderError } from "../../src/code/github-code-provider.js";
import { createGitHubContextCatalog } from "../../src/organizational-context/github-context-catalog.js";
import type { ContextAudience } from "../../src/organizational-context/interface.js";

const audience: ContextAudience = {
  workspaceId: "dayova",
  personIds: ["jakob", "fabius", "julius", "philipp"]
};
const repo = "dayova/luma";
const excerpt: CurrentCodeExcerpt = {
  repository: repo,
  path: "src/history.ts",
  commitSha: "a".repeat(40),
  blobSha: "b".repeat(40),
  startLine: 1,
  endLine: 1,
  excerpt: "preserveHistory();",
  url: `https://github.com/${repo}/blob/${"a".repeat(40)}/src/history.ts#L1-L1`,
  committedAt: "2026-09-10T10:00:00.000Z",
  observedAt: "2026-09-10T11:00:00.000Z"
};

describe("GitHub organizational context catalog", () => {
  it("binds stable immutable source IDs and versions to the credential scope and actual recipients", async () => {
    const h = harness();
    const search = await h.catalog.search({ audience, concepts: ["history"], limit: 3 });
    expect(search.complete).toBe(false);
    expect(search.sourceIds).toHaveLength(1);
    const sourceId = search.sourceIds[0]!;
    const source = await h.catalog.read({ audience, sourceId });
    expect(source).toMatchObject({
      id: sourceId,
      content: excerpt.excerpt,
      authority: "source",
      standing: "current",
      updatedAt: excerpt.committedAt
    });
    expect(source?.version).toContain(excerpt.commitSha);
    expect(source?.externalReference.url).toBe(excerpt.url);
    expect(h.authorize).toHaveBeenCalledWith({
      audience,
      providerId: "github-code",
      credentialScopeId: "dayova-reader",
      repository: repo
    });
    expect(h.catalog.id).toContain("dayova-reader");
    expect(harness("different-reader").catalog.id).not.toBe(h.catalog.id);
    await h.catalog.read({ audience, sourceId });
    expect(h.current).toHaveBeenCalledTimes(2);
    expect(h.search).toHaveBeenCalledTimes(1);
  });

  it.each(["workspace", "guest", "empty"])(
    "fails closed on an unauthorized %s audience before provider reads",
    async (kind) => {
      const h = harness();
      const rejected =
        kind === "workspace"
          ? { ...audience, workspaceId: "other" }
          : {
              ...audience,
              personIds: kind === "empty" ? [] : [...audience.personIds, "guest"]
            };
      const result = await h.catalog.search({
        audience: rejected,
        concepts: ["history"],
        limit: 3
      });
      expect(result.sourceIds).toEqual([]);
      expect(h.search).not.toHaveBeenCalled();
      expect(h.current).not.toHaveBeenCalled();
    }
  );

  it("checks revocation again after a source read and never returns retained cached content", async () => {
    const h = harness();
    const sourceId = (
      await h.catalog.search({ audience, concepts: ["history"], limit: 1 })
    ).sourceIds[0]!;
    expect(await h.catalog.read({ audience, sourceId })).not.toBeNull();
    h.current.mockImplementationOnce(() => {
      h.authorize.mockResolvedValue(false);
      return Promise.resolve(excerpt);
    });
    expect(await h.catalog.read({ audience, sourceId })).toBeNull();
    const calls = h.current.mock.calls.length;
    expect(await h.catalog.read({ audience, sourceId })).toBeNull();
    expect(h.current).toHaveBeenCalledTimes(calls);
  });

  it("rejects deleted/changed sources and mismatched returned immutable identities", async () => {
    const h = harness();
    const sourceId = (
      await h.catalog.search({ audience, concepts: ["history"], limit: 1 })
    ).sourceIds[0]!;
    h.current.mockResolvedValueOnce(null);
    expect(await h.catalog.read({ audience, sourceId })).toBeNull();
    h.current.mockResolvedValueOnce({ ...excerpt, blobSha: "c".repeat(40) });
    expect(await h.catalog.read({ audience, sourceId })).toBeNull();
    expect(await h.catalog.read({ audience, sourceId: sourceId + "=" })).toBeNull();
  });

  it("honors bounded discovery and preserves partial coverage without exposing diagnostic text", async () => {
    const h = harness();
    h.search.mockRejectedValueOnce(new Error("private provider content"));
    h.search.mockRejectedValueOnce(new GitHubCodeProviderError("rate-limited", true));
    const catalog = createGitHubContextCatalog({
      codeProvider: h.provider,
      authorize: h.authorize,
      maxSearches: 2
    });
    const result = await catalog.search({
      audience,
      concepts: ["one", "two", "three"],
      limit: 5
    });
    expect(h.search).toHaveBeenCalledTimes(2);
    expect(result.sourceIds).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.warnings.join(" ")).toContain("rate-limited");
    expect(JSON.stringify(result)).not.toContain("private provider content");
  });

  it("denies a grant revoked while search is running and sanitizes read failures", async () => {
    const h = harness();
    const sourceId = (
      await h.catalog.search({ audience, concepts: ["history"], limit: 1 })
    ).sourceIds[0]!;
    h.current.mockRejectedValueOnce(new Error("private upstream response"));
    await expect(h.catalog.read({ audience, sourceId })).rejects.toThrow(
      /^GitHub context is unavailable\.$/u
    );
    h.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await h.catalog.search({ audience, concepts: ["history"], limit: 1 });
    expect(result.sourceIds).toEqual([]);
  });

  it("removes private path candidates from earlier terms when a later term sees revocation", async () => {
    const h = harness();
    h.authorize
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const result = await h.catalog.search({
      audience,
      concepts: ["history", "preserve"],
      limit: 3
    });
    expect(h.search).toHaveBeenCalledTimes(2);
    expect(result.sourceIds).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("history.ts");
  });
});

function harness(scope = "dayova-reader") {
  const search = vi.fn<CodeProvider["searchCode"]>().mockResolvedValue({
    results: [excerpt],
    commitSha: excerpt.commitSha,
    observedAt: excerpt.observedAt,
    coverage: { complete: false, warnings: ["Index coverage is bounded."] }
  });
  const current = vi
    .fn<CodeProvider["getCurrentCodeExcerpt"]>()
    .mockResolvedValue(excerpt);
  const unused = (): Promise<never> => {
    return Promise.reject(new Error("Unexpected provider capability"));
  };
  const provider: CodeProvider = {
    providerId: "github-code",
    readScope: { credentialScopeId: scope, repositories: [repo] },
    getCommit: unused,
    getPullRequest: unused,
    getRecentActivity: unused,
    searchCode: search,
    getCurrentCodeExcerpt: current
  };
  const authorize = vi.fn((input: { audience: ContextAudience }) =>
    Promise.resolve(
      input.audience.workspaceId === audience.workspaceId &&
        input.audience.personIds.every((person) => audience.personIds.includes(person))
    )
  );
  const catalog = createGitHubContextCatalog({ codeProvider: provider, authorize });
  return { catalog, provider, authorize, search, current };
}
