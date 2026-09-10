import { afterEach, describe, expect, it } from "vitest";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import {
  createOrganizationalContext,
  OrganizationalContextUnavailableError
} from "../../src/organizational-context/organizational-context.js";
import type {
  ContextCatalog,
  ContextSource,
  OrganizationalContextRequest
} from "../../src/organizational-context/interface.js";

const request: OrganizationalContextRequest = {
  audience: {
    workspaceId: "dayova",
    personIds: ["jakob", "fabius", "philipp", "julius"]
  },
  subject: { type: "conversation", id: "thread" },
  purpose: "answer-question",
  concepts: ["Luma budget"],
  time: { mode: "current" },
  limit: 10,
  maxCharacters: 8_000
};
function source(id: string, changes: Partial<ContextSource> = {}): ContextSource {
  return {
    id,
    title: "Luma budget",
    content: "Luma AI budget is $30 per month.",
    kind: "knowledge-document",
    version: "v1",
    updatedAt: "2025-01-01T00:00:00Z",
    standing: "current",
    authority: "human-confirmed",
    externalReference: {
      providerId: "notion",
      objectType: "document",
      externalId: id,
      url: `https://notion.so/${id}`
    },
    ...changes
  };
}
function catalog(initial: ContextSource[]) {
  const sources = new Map(initial.map((s) => [s.id, s]));
  let allowed = true;
  let unavailable = false;
  const port: ContextCatalog = {
    id: "founder-knowledge",
    search() {
      if (unavailable) throw new Error("SECRET");
      return Promise.resolve({
        sourceIds: [...sources.keys()],
        complete: true,
        warnings: []
      });
    },
    read(input) {
      if (unavailable) throw new Error("SECRET");
      return Promise.resolve(
        allowed &&
          input.audience.workspaceId === "dayova" &&
          input.audience.personIds.every((id) => request.audience.personIds.includes(id))
          ? (sources.get(input.sourceId) ?? null)
          : null
      );
    }
  };
  return {
    sources,
    port,
    revoke: () => {
      allowed = false;
    },
    fail: () => {
      unavailable = true;
    }
  };
}
const databases: LumaDatabase[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});
async function setup(initial: ContextSource[]) {
  const database = await createPgliteDatabase();
  databases.push(database);
  const testCatalog = catalog(initial);
  const context = createOrganizationalContext({
    database,
    catalogs: [testCatalog.port],
    now: () => new Date("2026-09-10T12:00:00Z")
  });
  return { database, ...testCatalog, context };
}

describe("governed organizational retrieval", () => {
  it("keeps an old valid Human decision above a newer unaccepted proposal", async () => {
    const { context } = await setup([
      source("accepted"),
      source("proposal", {
        content: "We could raise Luma budget to $100.",
        updatedAt: "2026-09-10T00:00:00Z",
        standing: "proposed",
        authority: "ai-inference",
        supersedes: ["accepted"]
      })
    ]);
    const answer = await context.retrieve({ ...request, limit: 1 });
    expect(answer.sources.map((s) => s.id)).toEqual(["accepted"]);
    expect(answer.retrieval.complete).toBe(false);
    expect(answer.retrieval.warnings.join(" ")).toContain("omitted");
  });
  it("requires explicit Human supersession and keeps superseded material available as history", async () => {
    const { context } = await setup([
      source("old"),
      source("new", {
        content: "Luma budget is now $40.",
        version: "v2",
        updatedAt: "2026-09-10T00:00:00Z",
        supersedes: ["old"]
      })
    ]);
    expect((await context.retrieve(request)).sources.map((s) => s.id)).toEqual(["new"]);
    const history = await context.retrieve({
      ...request,
      time: { mode: "history", asOf: "2025-12-31T00:00:00Z" }
    });
    expect(history.sources.map((s) => s.id)).toEqual(["old"]);
  });
  it("does not let a future-effective decision supersede today's valid decision", async () => {
    const { context } = await setup([
      source("old"),
      source("future", {
        content: "Luma budget is $40.",
        effectiveAt: "2027-01-01T00:00:00Z",
        supersedes: ["old"]
      })
    ]);
    expect((await context.retrieve(request)).sources.map((s) => s.id)).toEqual(["old"]);
  });
  it("retains old document versions while excluding them from current context", async () => {
    const { context, sources, database } = await setup([source("policy")]);
    await context.retrieve(request);
    sources.set(
      "policy",
      source("policy", {
        version: "v2",
        content: "Luma budget is now $40.",
        updatedAt: "2026-09-10T00:00:00Z"
      })
    );
    expect((await context.retrieve(request)).sources.map((s) => s.version)).toEqual([
      "v2"
    ]);
    expect(
      (await context.retrieve({ ...request, time: { mode: "history" } })).sources
        .map((s) => s.version)
        .sort()
    ).toEqual(["v1", "v2"]);
    expect(
      (await database.query("SELECT * FROM organizational_context_snapshots")).rows
    ).toHaveLength(2);
  });
  it("deduplicates mirrored evidence without treating it as independent corroboration", async () => {
    const { context } = await setup([source("first"), source("mirror")]);
    const answer = await context.retrieve(request);
    expect(answer.sources).toHaveLength(1);
    expect(answer.sources[0]?.duplicates).toHaveLength(1);
    expect(answer.retrieval.selected).toBe(1);
  });
  it("discloses conflicts instead of silently choosing a more recent decision", async () => {
    const { context } = await setup([
      source("one", { decisionKey: "budget" }),
      source("two", {
        decisionKey: "budget",
        content: "Luma budget is $80.",
        updatedAt: "2026-01-01T00:00:00Z"
      })
    ]);
    const answer = await context.retrieve(request);
    expect(answer.sources).toHaveLength(2);
    expect(answer.retrieval.warnings.join(" ")).toContain("Conflicting");
  });
  it("rejects a replay after revocation without deleting retained history", async () => {
    const { context, revoke, database } = await setup([source("policy")]);
    const answer = await context.retrieve(request);
    await context.requireCurrent(request, answer.receiptId);
    revoke();
    await expect(
      context.requireCurrent(request, answer.receiptId)
    ).rejects.toBeInstanceOf(OrganizationalContextUnavailableError);
    expect(
      (await context.retrieve({ ...request, time: { mode: "history" } })).sources
    ).toEqual([]);
    expect(
      (await database.query("SELECT * FROM organizational_context_snapshots")).rows
    ).toHaveLength(1);
  });
  it("rejects changed context, changed recipients and a fabricated receipt", async () => {
    const { context, sources } = await setup([source("policy")]);
    const answer = await context.retrieve(request);
    await expect(
      context.requireCurrent(
        { ...request, audience: { ...request.audience, personIds: ["guest"] } },
        answer.receiptId
      )
    ).rejects.toBeInstanceOf(OrganizationalContextUnavailableError);
    await expect(context.requireCurrent(request, "fabricated")).rejects.toBeInstanceOf(
      OrganizationalContextUnavailableError
    );
    sources.set("policy", source("policy", { content: "Luma budget is $50." }));
    await expect(
      context.requireCurrent(request, answer.receiptId)
    ).rejects.toBeInstanceOf(OrganizationalContextUnavailableError);
  });
  it("does not fall back to cached private text on a provider outage", async () => {
    const { context, fail } = await setup([source("policy")]);
    await context.retrieve(request);
    fail();
    const answer = await context.retrieve(request);
    expect(answer.sources).toEqual([]);
    expect(answer.retrieval.complete).toBe(false);
    expect(JSON.stringify(answer)).not.toContain("SECRET");
  });
  it("bounds excerpts and discloses truncation without modifying the retained source", async () => {
    const { context, database } = await setup([source("policy")]);
    const answer = await context.retrieve({ ...request, maxCharacters: 12 });
    expect(answer.retrieval.characters).toBe(12);
    expect(answer.sources[0]?.excerptTruncated).toBe(true);
    expect(
      (
        await database.query<{ source_json: string }>(
          "SELECT source_json FROM organizational_context_snapshots"
        )
      ).rows[0]?.source_json
    ).toContain("$30 per month");
  });
  it("finds retained history even when current provider search no longer matches the old terminology", async () => {
    const { context, sources, port } = await setup([source("renamed")]);
    await context.retrieve(request);
    sources.set(
      "renamed",
      source("renamed", {
        title: "Unrelated title",
        content: "Current unrelated text",
        version: "v2"
      })
    );
    port.search = () => Promise.resolve({ sourceIds: [], complete: true, warnings: [] });
    const history = await context.retrieve({ ...request, time: { mode: "history" } });
    expect(history.sources.map((item) => item.version)).toEqual(["v1"]);
    await context.requireCurrent(
      { ...request, time: { mode: "history" } },
      history.receiptId
    );
  });
  it("invalidates a derived answer when discovery adds a conflicting source", async () => {
    const { context, sources } = await setup([source("one", { decisionKey: "budget" })]);
    const answer = await context.retrieve(request);
    sources.set(
      "two",
      source("two", { decisionKey: "budget", content: "Luma budget is $90." })
    );
    await expect(
      context.requireCurrent(request, answer.receiptId)
    ).rejects.toBeInstanceOf(OrganizationalContextUnavailableError);
  });
  it("revalidates omitted decision context too, because it affects ranking and conflict warnings", async () => {
    const { context, sources } = await setup([
      source("one"),
      source("proposal", { standing: "proposed", content: "Luma budget could be $90." })
    ]);
    const bounded = { ...request, limit: 1 };
    const answer = await context.retrieve(bounded);
    sources.set(
      "proposal",
      source("proposal", {
        standing: "current",
        content: "Luma budget is now $90.",
        supersedes: ["one"]
      })
    );
    await expect(
      context.requireCurrent(bounded, answer.receiptId)
    ).rejects.toBeInstanceOf(OrganizationalContextUnavailableError);
  });
});
