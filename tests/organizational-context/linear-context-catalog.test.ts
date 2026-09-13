import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createLinearContextCatalog,
  createLinearContextCatalogFromEnv
} from "../../src/organizational-context/linear-context-catalog.js";
import type { ContextCatalogAuthorization } from "../../src/organizational-context/catalog-authorization.js";
import type {
  ContextAudience,
  OrganizationalContextRequest
} from "../../src/organizational-context/interface.js";
import {
  createLinearReadOnlyApiForTest,
  createLinearReadOnlyWorkCatalogForTest,
  type LinearReadOnlyApiIssue,
  type LinearReadOnlyWorkCatalog
} from "../../src/work/linear-read-only-work-catalog.js";
import type { WorkCatalog } from "../../src/work/interface.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import {
  createOrganizationalContext,
  OrganizationalContextUnavailableError
} from "../../src/organizational-context/organizational-context.js";

const issueId = "ac5c3f41-c2ce-485e-8227-d4c8fa445f5d";
const secondIssueId = "931dc2cb-7f2c-4403-9578-1b498d52de92";
const audience: ContextAudience = {
  workspaceId: "dayova",
  personIds: ["person_jakob", "person_fabius", "person_julius", "person_philipp"]
};
const sourceId = `issue:${issueId}:LUM-4`;
const searchInput = { audience, concepts: ["Luma release"], limit: 20 };
const readInput = { audience, sourceId };

function issue(changes: Partial<LinearReadOnlyApiIssue> = {}): LinearReadOnlyApiIssue {
  return {
    id: issueId,
    teamId: "team-luma",
    identifier: "LUM-4",
    title: "Luma release preparation",
    description: "We could expand the release after the founders discuss it.",
    stateType: "started",
    stateName: "In Progress",
    assignee: {
      id: "linear-person",
      displayName: "Jakob",
      email: "private@example.test"
    },
    dueDate: "2026-09-12",
    labels: ["proposed"],
    projectId: null,
    parentId: null,
    url: "https://linear.app/dayova/issue/LUM-4/context",
    updatedAt: "2026-09-10T12:00:00.000Z",
    ...changes
  };
}

function fixture() {
  let current = issue();
  let teamAllowed = true;
  const deniedIssues = new Set<string>();
  const search = vi.fn<
    (input: {
      teamId: string;
      text: string;
      limit: number;
    }) => Promise<LinearReadOnlyApiIssue[]>
  >(() => Promise.resolve([current]));
  const get = vi.fn<(id: string) => Promise<LinearReadOnlyApiIssue>>(() =>
    Promise.resolve(current)
  );
  const authorize = vi.fn<ContextCatalogAuthorization>((input) =>
    Promise.resolve(
      input.audience.workspaceId === audience.workspaceId &&
        input.audience.personIds.every((personId) =>
          audience.personIds.includes(personId)
        ) &&
        input.credentialScopeId === "founder-work-v1" &&
        input.source.provider === "linear" &&
        input.source.teamId === "team-luma" &&
        teamAllowed &&
        (!input.source.issueId || !deniedIssues.has(input.source.issueId))
    )
  );
  const makeReader = () =>
    createLinearReadOnlyWorkCatalogForTest({
      teamId: "team-luma",
      api: createLinearReadOnlyApiForTest({ searchIssues: search, getIssue: get })
    });
  const makeCatalog = (reader = makeReader()) =>
    createLinearContextCatalog({
      workspaceId: "dayova",
      credentialScopeId: "founder-work-v1",
      authorize,
      readOnlyWorkCatalog: reader
    });
  return {
    search,
    get,
    authorize,
    makeReader,
    makeCatalog,
    deniedIssues,
    catalog: makeCatalog(),
    setCurrent: (value: LinearReadOnlyApiIssue) => {
      current = value;
    },
    revokeTeam: () => {
      teamAllowed = false;
    }
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Linear organizational context catalog", () => {
  it.each(["current", "proposed", "disputed", "superseded", "historical"])(
    "uses explicit %s knowledge labels without treating completion or labels as Human authority",
    async (standing) => {
      const f = fixture();
      f.setCurrent(
        issue({
          labels: [`luma:knowledge:${standing}`],
          stateType: "completed",
          stateName: "Done"
        })
      );
      expect(await f.catalog.read(readInput)).toMatchObject({
        standing,
        authority: "source"
      });
    }
  );

  it("withholds conflicting or unsupported explicit knowledge labels", async () => {
    const f = fixture();
    for (const labels of [
      ["luma:knowledge:current", "luma:knowledge:superseded"],
      ["luma:knowledge:approved"],
      ["luma:knowledge:"]
    ]) {
      f.setCurrent(issue({ labels }));
      expect(await f.catalog.read(readInput)).toBeNull();
    }
  });

  it("invalidates a retained receipt on label-only supersession without deleting historical material", async () => {
    const f = fixture();
    const database = await createPgliteDatabase();
    try {
      const context = createOrganizationalContext({ database, catalogs: [f.catalog] });
      const request: OrganizationalContextRequest = {
        audience,
        subject: { type: "conversation", id: "standing" },
        purpose: "answer-question",
        concepts: ["Luma release"],
        time: { mode: "current" },
        limit: 10,
        maxCharacters: 8000
      };
      const before = await context.retrieve(request);
      expect(before.sources).toHaveLength(1);
      f.setCurrent(issue({ labels: ["luma:knowledge:superseded"] }));
      await expect(context.requireCurrent(request, before.receiptId)).rejects.toThrow();
      expect((await context.retrieve(request)).sources).toEqual([]);
      expect(
        (await context.retrieve({ ...request, time: { mode: "history" } })).sources.some(
          (source) => source.standing === "superseded"
        )
      ).toBe(true);
      f.revokeTeam();
      expect(
        (await context.retrieve({ ...request, time: { mode: "history" } })).sources
      ).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("uses bounded read-only team search and source facts without inferring accepted decisions or owners", async () => {
    const f = fixture();
    const result = await f.catalog.search(searchInput);
    expect(result.sourceIds).toEqual([sourceId]);
    expect(result.complete).toBe(false);
    expect(result.warnings.join(" ")).toContain("non-exhaustive");
    expect(f.search.mock.calls[0]?.[0]).toEqual({
      teamId: "team-luma",
      text: "Luma release",
      limit: 10
    });
    const source = await f.catalog.read(readInput);
    expect(source).toMatchObject({
      id: sourceId,
      kind: "work-item",
      authority: "source",
      standing: "current",
      title: "Luma release preparation",
      externalReference: {
        providerId: "linear",
        externalId: "LUM-4",
        objectType: "work-item"
      }
    });
    expect(source?.content).toContain("We could expand");
    expect(source?.content).toContain("Normalized work state: active");
    expect(source?.content).toContain("Due date: 2026-09-12");
    expect(source?.content).toContain("Labels: proposed");
    expect(source?.content).not.toContain("private@example.test");
    expect(source?.decisionKey).toBeUndefined();
    expect(source?.supersedes).toBeUndefined();
    expect(Object.keys(f.catalog).sort()).toEqual(["id", "read", "search"]);
    expect(Object.isFrozen(f.catalog)).toBe(true);
    expect(f.catalog.id).toBe("linear:founder-work-v1:team-luma");
  });

  it("rejects the wrong workspace or ungranted recipients before any provider I/O", async () => {
    const f = fixture();
    for (const recipients of [
      { ...audience, workspaceId: "another-workspace" },
      { ...audience, personIds: ["guest"] },
      { ...audience, personIds: [] }
    ]) {
      expect(
        (await f.catalog.search({ ...searchInput, audience: recipients })).sourceIds
      ).toEqual([]);
      expect(await f.catalog.read({ ...readInput, audience: recipients })).toBeNull();
    }
    expect(f.search).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
  });

  it("refuses structural copies and narrowed writers instead of accepting their public brand", () => {
    const f = fixture();
    const copiedReader = { ...f.makeReader(), createWorkItem: vi.fn() };
    expect(() => f.makeCatalog(copiedReader)).toThrow("issued read-only");
    expect(copiedReader.createWorkItem).not.toHaveBeenCalled();
    expectTypeOf<WorkCatalog>().not.toExtend<LinearReadOnlyWorkCatalog>();
  });

  it("admits an exact UUID and identifier through a fresh bounded search after reader recreation", async () => {
    const f = fixture();
    await f.catalog.search(searchInput);
    const recreated = f.makeCatalog();
    expect((await recreated.read(readInput))?.id).toBe(sourceId);
    expect(f.search.mock.calls.at(-1)?.[0]).toEqual({
      teamId: "team-luma",
      text: "LUM-4",
      limit: 10
    });
    expect(f.get).toHaveBeenCalledWith(issueId);
    f.deniedIssues.add(issueId);
    const calls = f.search.mock.calls.length;
    expect(await f.makeCatalog().read(readInput)).toBeNull();
    expect(f.search).toHaveBeenCalledTimes(calls);
  });

  it("does not disclose search results when the team grant disappears during I/O", async () => {
    const f = fixture();
    f.search.mockImplementation(() => {
      f.revokeTeam();
      return Promise.resolve([issue()]);
    });
    expect((await f.catalog.search(searchInput)).sourceIds).toEqual([]);
    expect(f.get).not.toHaveBeenCalled();
  });

  it("rechecks accumulated issue grants after later concept reads", async () => {
    const f = fixture();
    f.search.mockImplementation((input) => {
      if (input.text === "first") return Promise.resolve([issue()]);
      f.deniedIssues.add(issueId);
      return Promise.resolve([issue({ id: secondIssueId, identifier: "LUM-9" })]);
    });
    const result = await f.catalog.search({
      ...searchInput,
      concepts: ["first", "second"]
    });
    expect(result.sourceIds).toEqual([`issue:${secondIssueId}:LUM-9`]);
    expect(result.sourceIds).not.toContain(sourceId);
  });

  it.each(["search", "get"] as const)(
    "withdraws a source if its issue grant disappears during %s",
    async (stage) => {
      const f = fixture();
      const revoke = () => {
        f.deniedIssues.add(issueId);
        return Promise.resolve(stage === "search" ? [issue()] : issue());
      };
      if (stage === "search")
        f.search.mockImplementation(async () => {
          await revoke();
          return [issue()];
        });
      else
        f.get.mockImplementation(async () => {
          await revoke();
          return issue();
        });
      expect(await f.catalog.read(readInput)).toBeNull();
      if (stage === "search") expect(f.get).not.toHaveBeenCalled();
    }
  );

  it("fails closed without partial identifiers or private errors after a later search failure", async () => {
    const f = fixture();
    f.search.mockImplementation((input) => {
      if (input.text === "first") return Promise.resolve([issue()]);
      throw new Error("SECRET provider diagnostics");
    });
    const result = await f.catalog.search({
      ...searchInput,
      concepts: ["first", "second"]
    });
    expect(result.sourceIds).toEqual([]);
    expect(result.complete).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    f.get.mockRejectedValue(new Error("SECRET missing issue"));
    f.search.mockResolvedValue([issue()]);
    expect(await f.catalog.read(readInput)).toBeNull();
  });

  it("does not admit ambiguous, missing, moved or malformed source identities", async () => {
    const f = fixture();
    expect(await f.catalog.read({ ...readInput, sourceId: "LUM-4" })).toBeNull();
    expect(f.search).not.toHaveBeenCalled();
    for (const candidate of [
      [],
      [issue({ id: secondIssueId })],
      [issue({ identifier: "LUM-9" })]
    ]) {
      f.search.mockResolvedValue(candidate);
      expect(await f.catalog.read(readInput)).toBeNull();
    }
    expect(f.get).not.toHaveBeenCalled();
    f.search.mockResolvedValue([issue()]);
    f.get.mockResolvedValue(issue({ teamId: "team-other" }));
    expect(await f.catalog.read(readInput)).toBeNull();
    f.get.mockResolvedValue(issue({ identifier: "LUM-9" }));
    expect(await f.catalog.read(readInput)).toBeNull();
  });

  it("requires dedicated context credentials and a scope identity without writer or other reader fallback", () => {
    const fetch = vi.fn(() => {
      throw new Error("No network expected");
    });
    vi.stubGlobal("fetch", fetch);
    const f = fixture();
    const unrelated = {
      LINEAR_API_KEY: "writer",
      LINEAR_READONLY_API_KEY: "other-reader",
      LINEAR_TEAM_ID: "other-team",
      LUMA_CONTEXT_LINEAR_TEAM_ID: "team-luma",
      LUMA_CONTEXT_LINEAR_CREDENTIAL_SCOPE_ID: "founder-work-v1"
    };
    expect(() =>
      createLinearContextCatalogFromEnv({
        workspaceId: "dayova",
        authorize: f.authorize,
        env: unrelated
      })
    ).toThrow("LUMA_CONTEXT_LINEAR_READONLY_API_KEY");
    expect(() =>
      createLinearContextCatalogFromEnv({
        workspaceId: "dayova",
        authorize: f.authorize,
        env: {
          ...unrelated,
          LUMA_CONTEXT_LINEAR_READONLY_API_KEY: "read-only-test-key",
          LUMA_CONTEXT_LINEAR_CREDENTIAL_SCOPE_ID: ""
        }
      })
    ).toThrow("LUMA_CONTEXT_LINEAR_CREDENTIAL_SCOPE_ID");
    const catalog = createLinearContextCatalogFromEnv({
      workspaceId: "dayova",
      authorize: f.authorize,
      env: { ...unrelated, LUMA_CONTEXT_LINEAR_READONLY_API_KEY: "read-only-test-key" }
    });
    expect(catalog.id).toBe("linear:founder-work-v1:team-luma");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["edit", "revocation", "team move"] as const)(
    "invalidates a durable retrieval receipt after %s and preserves retained source history",
    async (change) => {
      const database = await createPgliteDatabase();
      try {
        const f = fixture();
        const context = createOrganizationalContext({ database, catalogs: [f.catalog] });
        const request: OrganizationalContextRequest = {
          ...searchInput,
          subject: { type: "conversation", id: "founder-thread" },
          purpose: "answer-question",
          time: { mode: "current" },
          maxCharacters: 8_000
        };
        const bundle = await context.retrieve(request);
        expect(bundle.sources).toHaveLength(1);
        // A new reader has no selector cache and must prove eligibility afresh.
        const restarted = createOrganizationalContext({
          database,
          catalogs: [f.makeCatalog()]
        });
        await restarted.requireCurrent(request, bundle.receiptId);
        if (change === "edit")
          f.setCurrent(
            issue({
              description: "The release scope changed.",
              updatedAt: "2026-09-10T13:00:00.000Z"
            })
          );
        else if (change === "revocation") f.deniedIssues.add(issueId);
        else f.setCurrent(issue({ teamId: "team-other" }));
        await expect(
          restarted.requireCurrent(request, bundle.receiptId)
        ).rejects.toBeInstanceOf(OrganizationalContextUnavailableError);
        expect(
          (await database.query("SELECT source_id FROM organizational_context_snapshots"))
            .rows
        ).toHaveLength(1);
      } finally {
        await database.close();
      }
    }
  );
});
