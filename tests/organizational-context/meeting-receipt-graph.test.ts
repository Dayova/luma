import { describe, expect, it } from "vitest";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import {
  createExternalContextReceiptVerifier,
  createOrganizationalContext
} from "../../src/organizational-context/organizational-context.js";
import type {
  ContextCatalog,
  ContextSource,
  MeetingContextProofLeaves,
  OrganizationalContextRequest
} from "../../src/organizational-context/interface.js";

const audience = {
  workspaceId: "graph",
  personIds: ["jakob", "fabius", "julius", "philipp"]
};
function request(id: string): OrganizationalContextRequest {
  return {
    audience,
    subject: { type: "meeting", id },
    purpose: "understand-discussion",
    concepts: ["Luma"],
    time: { mode: "current" },
    limit: 50,
    maxCharacters: 64_000
  };
}
function source(id: string): ContextSource {
  return {
    id,
    title: `Luma ${id}`,
    content: `Luma original ${id}`,
    kind: "previous-meeting-item",
    version: "1",
    updatedAt: "2026-09-11T09:00:00.000Z",
    standing: "proposed",
    authority: "ai-inference",
    externalReference: {
      providerId: "original-source",
      objectType: "document",
      externalId: id,
      url: `https://example.invalid/${id}`
    }
  };
}
async function fixture(discoveries: Record<string, string[]>) {
  const database = await createPgliteDatabase();
  const receipts = new Map<
    string,
    { id: string; request: OrganizationalContextRequest }
  >();
  const catalog: ContextCatalog = {
    id: "meeting-leaves",
    dependencyKind: "meeting",
    search: ({ subject }) =>
      Promise.resolve({
        sourceIds: discoveries[subject?.id ?? ""] ?? [],
        complete: false,
        warnings: ["Bounded original Meeting coverage"]
      }),
    read: ({ sourceId, subject }) =>
      Promise.resolve(
        discoveries[subject?.id ?? ""]?.includes(sourceId) ? source(sourceId) : null
      )
  };
  const context = createOrganizationalContext({ database, catalogs: [catalog] });
  for (const id of Object.keys(discoveries)) {
    const original = request(id);
    const result = await context.retrieve(original);
    receipts.set(id, { id: result.receiptId, request: original });
  }
  let reads = 0;
  let current = true;
  const leaves: MeetingContextProofLeaves = {
    id: catalog.id,
    search: (request) => catalog.search(request),
    read: ({ sourceId, subject }) => {
      reads++;
      if (!discoveries[subject?.id ?? ""]?.includes(sourceId))
        return Promise.resolve(null);
      return Promise.resolve({
        source: source(sourceId),
        meetingId: sourceId,
        receipts: receipts.has(sourceId) ? [receipts.get(sourceId)!] : [],
        requireCurrent: () =>
          current
            ? Promise.resolve()
            : Promise.reject(new Error("Original source grant revoked"))
      });
    }
  };
  const external = createExternalContextReceiptVerifier({
    database,
    catalogs: [],
    ignoredEmptyCatalogIds: [catalog.id]
  });
  const graph = external.withMeetingLeaves!(leaves);
  return {
    database,
    receipts,
    external,
    graph,
    reads: () => reads,
    revoke: () => {
      current = false;
    }
  };
}

describe("owned bounded Meeting receipt graph", () => {
  it("rejects an actual cycle while the external-only verifier still refuses Meeting material", async () => {
    const f = await fixture({ A: ["B"], B: ["A"] });
    try {
      const receipt = f.receipts.get("A")!;
      const input = { originalRequest: receipt.request, receiptId: receipt.id, audience };
      await expect(f.external.requireCurrent(input)).rejects.toThrow();
      await expect(f.graph.requireCurrent(input)).rejects.toThrow();
      expect(f.reads()).toBeLessThan(10);
    } finally {
      await f.database.close();
    }
  });
  it("proves a three-Meeting graph, preserving original recipients on every receipt", async () => {
    const f = await fixture({ A: ["B"], B: ["C"], C: [] });
    try {
      const receipt = f.receipts.get("A")!;
      const input = { originalRequest: receipt.request, receiptId: receipt.id, audience };
      const result = await f.graph.requireCurrent(input);
      expect(result.sources.map((entry) => entry.id)).toEqual(["B"]);
      expect(result.sources[0]?.authority).toBe("ai-inference");
      await expect(
        f.graph.requireCurrent({
          ...input,
          audience: { ...audience, personIds: [...audience.personIds, "guest"] }
        })
      ).rejects.toThrow();
      f.revoke();
      await expect(f.graph.requireCurrent(input)).rejects.toThrow();
    } finally {
      await f.database.close();
    }
  });
  it("refuses excessive depth without dropping ancestors to fabricate a successful discovery", async () => {
    const f = await fixture({ A: ["B"], B: ["C"], C: ["D"], D: ["E"], E: [] });
    try {
      const receipt = f.receipts.get("A")!;
      await expect(
        f.graph.requireCurrent({
          originalRequest: receipt.request,
          receiptId: receipt.id,
          audience
        })
      ).rejects.toThrow();
      expect(f.reads()).toBeLessThanOrEqual(4);
    } finally {
      await f.database.close();
    }
  });
  it("refuses excessive breadth and leaves persisted retrieval history unchanged", async () => {
    const f = await fixture({
      A: Array.from({ length: 41 }, (_, index) => `source-${index}`)
    });
    try {
      const before = await f.database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM organizational_context_receipts"
      );
      const receipt = f.receipts.get("A")!;
      await expect(
        f.graph.requireCurrent({
          originalRequest: receipt.request,
          receiptId: receipt.id,
          audience
        })
      ).rejects.toThrow();
      expect(f.reads()).toBe(40);
      expect(
        (
          await f.database.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM organizational_context_receipts"
          )
        ).rows
      ).toEqual(before.rows);
    } finally {
      await f.database.close();
    }
  });
});
