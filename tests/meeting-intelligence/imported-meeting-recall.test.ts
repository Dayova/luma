import { describe, expect, it } from "vitest";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { importedMeetingFixture } from "../../evals/imported-meeting-fixture.js";
import { createOrganizationalContext } from "../../src/organizational-context/organizational-context.js";
import { createExternalContextReceiptVerifier } from "../../src/organizational-context/organizational-context.js";
import type {
  ContextCatalog,
  ContextSource
} from "../../src/organizational-context/interface.js";

function externalFixture() {
  let readable = true;
  let version = "1";
  let discovered = ["guide"];
  const catalog: ContextCatalog = {
    id: "external-guide",
    search: () =>
      Promise.resolve({ sourceIds: discovered, complete: true, warnings: [] }),
    read: ({ sourceId }) =>
      Promise.resolve(
        readable
          ? ({
              id: sourceId,
              kind: "knowledge-document",
              title: "Luma source guide",
              content: "Luma responsibility is provisional until confirmed.",
              version,
              updatedAt: "2026-08-01T09:00:00.000Z",
              externalReference: {
                providerId: "notion",
                objectType: "document",
                externalId: sourceId,
                url: `https://example.invalid/${sourceId}`
              },
              standing: "current",
              authority: "source"
            } satisfies ContextSource)
          : null
      )
  };
  return {
    catalog,
    revoke: () => {
      readable = false;
    },
    change: () => {
      version = "2";
    },
    discover: () => {
      discovered = ["guide", "new-source"];
    },
    empty: () => {
      discovered = [];
    }
  };
}

describe("source-bound prior Meeting recall", () => {
  it("returns receipt time as a UTC instant when source timestamps carry offsets", async () => {
    const database = await createPgliteDatabase();
    const f = importedMeetingFixture(database);
    try {
      await f.ingest(
        "offset",
        "Luma has an offset source timestamp.",
        "2026-09-11T10:00:00+02:00"
      );
      const result = await f.organizationalContext().retrieve(f.request());
      expect(result.sources).toHaveLength(1);
      expect(result.sources[0]?.updatedAt).toBe("2026-09-11T08:00:00.000Z");
    } finally {
      await database.close();
    }
  });
  for (const change of ["revoke", "change", "discover"] as const)
    it(`recalls normal externally grounded imports and invalidates recall after external ${change}`, async () => {
      const database = await createPgliteDatabase();
      const f = importedMeetingFixture(database);
      const external = externalFixture();
      try {
        f.compose([external.catalog]);
        const admitted = await f.ingest("normal", "Luma owner remains Jakob.");
        expect(admitted.result.analysisStatus).toBe("completed");
        const state = await f.snapshot(admitted.observation);
        expect(
          state.decisions[0]?.provenance.evidence.some((evidence) =>
            evidence.evidenceId.startsWith("organizational-context:")
          )
        ).toBe(true);
        const first = await f.organizationalContext().retrieve(f.request());
        expect(first.sources).toHaveLength(1);
        expect(first.sources[0]?.content).toContain("responsibility is provisional");
        external[change]();
        await expect(
          f.organizationalContext().requireCurrent(f.request(), first.receiptId)
        ).rejects.toThrow();
        expect((await f.organizationalContext().retrieve(f.request())).sources).toEqual(
          []
        );
      } finally {
        await database.close();
      }
    });
  it("proves empty external receipts without treating later discovery as still empty", async () => {
    const database = await createPgliteDatabase();
    const f = importedMeetingFixture(database);
    const external = externalFixture();
    try {
      external.empty();
      f.compose([external.catalog]);
      await f.ingest("empty", "Luma original source stands alone.");
      const first = await f.organizationalContext().retrieve(f.request());
      expect(first.sources).toHaveLength(1);
      external.discover();
      expect((await f.organizationalContext().retrieve(f.request())).sources).toEqual([]);
      await expect(
        f.organizationalContext().requireCurrent(f.request(), first.receiptId)
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });
  it("recalls A through B into C and excludes circular descendants during each original Meeting's replay", async () => {
    const database = await createPgliteDatabase();
    const f = importedMeetingFixture(database);
    const external = externalFixture();
    try {
      f.compose([external.catalog]);
      const first = await f.ingest("first", "Luma first source decision.");
      const second = await f.ingest("second", "Luma second source decision.");
      const third = await f.ingest("third", "Luma third source decision.");
      for (const admitted of [first, second, third]) {
        expect(admitted.result.analysisStatus).toBe("completed");
        expect(admitted.result.errors).toEqual([]);
        expect((await f.snapshot(admitted.observation)).decisions).toHaveLength(1);
        const conclusion = await f.mi().conclude({
          workspaceId: f.workspace.workspaceId,
          meetingId: admitted.observation.meetingId
        });
        expect(JSON.stringify(conclusion)).toContain("source decision");
      }
      expect(
        f.requests[2]?.evidence.filter(
          (evidence) => evidence.source === "previous-meeting"
        )
      ).toHaveLength(2);
      const recalled = await f.organizationalContext().retrieve(f.request());
      expect(recalled.sources).toHaveLength(3);
      expect(
        recalled.sources.every(
          (source) =>
            source.authority === "ai-inference" && source.standing === "proposed"
        )
      ).toBe(true);
      await f.organizationalContext().requireCurrent(f.request(), recalled.receiptId);
      expect(f.requests).toHaveLength(3);
      expect(() =>
        createExternalContextReceiptVerifier({
          database,
          catalogs: [f.catalog()],
          ignoredEmptyCatalogIds: []
        })
      ).toThrow("only external provider catalogs");
    } finally {
      await database.close();
    }
  });
  for (const invalidation of [
    "source-grant",
    "source-version",
    "human-rejection",
    "external-grant",
    "independent-discovery"
  ] as const)
    it(`invalidates every borrowed edge after ${invalidation} without reinterpreting or deleting Evidence`, async () => {
      const database = await createPgliteDatabase();
      const f = importedMeetingFixture(database);
      const external = externalFixture();
      try {
        f.compose([external.catalog]);
        const first = await f.ingest("first", "Luma first source decision.");
        await f.ingest("second", "Luma second source decision.");
        const third = await f.ingest("third", "Luma third source decision.");
        expect(third.result.errors).toEqual([]);
        const recalled = await f.organizationalContext().retrieve(f.request());
        expect(recalled.sources).toHaveLength(3);
        if (invalidation === "source-grant") f.records.get("first")!.readers = [];
        if (invalidation === "source-version") {
          const section = f.records.get("first")!.snapshot.sections.transcript;
          if (section.state !== "available") throw new Error("Expected transcript");
          section.text = "Changed original source";
        }
        if (invalidation === "human-rejection")
          await f.judge(first.observation, {
            kind: "reject",
            meetingItemId: "decision:choice"
          });
        if (invalidation === "external-grant") external.revoke();
        if (invalidation === "independent-discovery") {
          f.context(undefined);
          await f.ingest("independent", "Luma independently eligible later source.");
        }
        const calls = f.requests.length;
        await expect(
          f.organizationalContext().requireCurrent(f.request(), recalled.receiptId)
        ).rejects.toThrow();
        const current = await f.organizationalContext().retrieve(f.request());
        expect(
          current.sources.some((source) =>
            source.content.includes('"statement":"Luma second source decision.')
          )
        ).toBe(false);
        expect(
          current.sources.some((source) =>
            source.content.includes('"statement":"Luma third source decision.')
          )
        ).toBe(false);
        expect(f.requests).toHaveLength(calls);
        expect(
          (
            await database.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM meeting_imported_source_receipts"
            )
          ).rows[0]?.count
        ).toBeGreaterThanOrEqual(3);
      } finally {
        await database.close();
      }
    });
  it("rechecks the recalled item's original grant after its ancestors finish proving", async () => {
    const database = await createPgliteDatabase();
    const f = importedMeetingFixture(database);
    const external = externalFixture();
    let armed = false;
    const catalog: ContextCatalog = {
      ...external.catalog,
      read: async (request) => {
        const value = await external.catalog.read(request);
        if (armed) {
          armed = false;
          f.records.get("second")!.readers = [];
        }
        return value;
      }
    };
    try {
      f.compose([catalog]);
      await f.ingest("first", "Luma first source decision.");
      await f.ingest("second", "Luma second source decision.");
      const result = await f.organizationalContext().retrieve(f.request());
      const selected = result.sources.find((entry) =>
        entry.content.includes('"statement":"Luma second source decision.')
      );
      expect(selected).toBeDefined();
      armed = true;
      await expect(
        f.catalog().read({ audience: f.audience, sourceId: selected!.id })
      ).rejects.toThrow();
      expect(f.requests).toHaveLength(2);
    } finally {
      await database.close();
    }
  });
  it("deduplicates exact copied understanding without inflating its authority or losing source links", async () => {
    const database = await createPgliteDatabase();
    const f = importedMeetingFixture(database);
    try {
      await f.ingest(
        "copy-one",
        "Luma could use this approach; this remains a proposal."
      );
      await f.ingest(
        "copy-two",
        "Luma could use this approach; this remains a proposal."
      );
      const result = await f.organizationalContext().retrieve(f.request());
      expect(result.sources).toHaveLength(1);
      expect(result.sources[0]?.authority).toBe("ai-inference");
      expect(result.sources[0]?.standing).toBe("proposed");
      expect(result.sources[0]?.duplicates).toHaveLength(1);
      f.records.get("copy-two")!.readers = [];
      await expect(
        f.organizationalContext().requireCurrent(f.request(), result.receiptId)
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });
  it("recalls original wording and preserves older Human confirmation ahead of a newer proposed choice", async () => {
    const db = await createPgliteDatabase();
    const f = importedMeetingFixture(db);
    try {
      const old = await f.ingest("old", "Jakob owns Luma.", "2026-08-01T10:00:00.000Z");
      expect(old.result.analysisStatus).toBe("completed");
      await f.judge(old.observation, {
        kind: "confirm",
        meetingItemId: "decision:choice"
      });
      await f.ingest("new", "Fabius könnte Luma übernehmen, das ist nur ein Vorschlag.");
      const result = await f.organizationalContext().retrieve(f.request());
      expect(result.sources.map((source) => [source.authority, source.standing])).toEqual(
        [
          ["human-confirmed", "current"],
          ["ai-inference", "proposed"]
        ]
      );
      expect(result.sources[0]?.content).toContain("Jakob owns Luma.");
      expect(result.sources[1]?.content).toContain("könnte");
      expect(result.sources[0]?.externalReference.url).toBe("https://notion.so/page-old");
      expect(result.sources[0]?.kind).toBe("previous-meeting-item");
      expect(result.retrieval.complete).toBe(false);
      await f.organizationalContext().requireCurrent(f.request(), result.receiptId);
      expect(f.requests).toHaveLength(2);
    } finally {
      await db.close();
    }
  });
  it("never expands an original audience when current source policy permits more readers", async () => {
    const db = await createPgliteDatabase();
    const f = importedMeetingFixture(db);
    try {
      await f.ingest("private", "Private Luma decision", undefined, ["jakob"]);
      expect((await f.organizationalContext().retrieve(f.request())).sources).toEqual([]);
      const subset = await f.organizationalContext().retrieve(f.request(["jakob"]));
      expect(subset.sources).toHaveLength(1);
      expect(
        await f.catalog().read({ audience: f.audience, sourceId: subset.sources[0]!.id })
      ).toBeNull();
      f.records.get("private")!.readers = [];
      await expect(
        f.organizationalContext().requireCurrent(f.request(["jakob"]), subset.receiptId)
      ).rejects.toThrow();
      expect(
        (await f.organizationalContext().retrieve(f.request(["jakob"]))).sources
      ).toEqual([]);
    } finally {
      await db.close();
    }
  });
  it("excludes the current Meeting from both discovery and retained-source rereads", async () => {
    const db = await createPgliteDatabase();
    const f = importedMeetingFixture(db);
    try {
      const observed = await f.ingest("same", "Luma source text");
      const first = await f.organizationalContext().retrieve(f.request());
      const request = {
        ...f.request(),
        subject: { type: "meeting" as const, id: observed.observation.meetingId }
      };
      expect((await f.organizationalContext().retrieve(request)).sources).toEqual([]);
      expect(
        await f.catalog().read({
          audience: f.audience,
          sourceId: first.sources[0]!.id,
          subject: request.subject
        })
      ).toBeNull();
    } finally {
      await db.close();
    }
  });
  it("never uses old raw capture snapshots after a new source revision, including explicit history", async () => {
    const db = await createPgliteDatabase();
    const f = importedMeetingFixture(db);
    try {
      await f.ingest("changed", "Luma old eligible material");
      const first = await f.organizationalContext().retrieve(f.request());
      await f.ingest(
        "changed",
        "Luma new replacement material",
        "2026-09-11T10:00:00.000Z"
      );
      await expect(
        f.organizationalContext().requireCurrent(f.request(), first.receiptId)
      ).rejects.toThrow();
      const history = await f
        .organizationalContext()
        .retrieve({ ...f.request(), time: { mode: "history" } });
      expect(
        history.sources.some((source) => source.content.includes("old eligible"))
      ).toBe(false);
      const rows = await db.query<{ count: number }>(
        "SELECT count(*)::int as count FROM organizational_context_snapshots"
      );
      expect(rows.rows[0]?.count).toBeGreaterThanOrEqual(1);
    } finally {
      await db.close();
    }
  });
  it("invalidates cached selection after Human rejection and retains eligible Human supersession only as history", async () => {
    const db = await createPgliteDatabase();
    const f = importedMeetingFixture(db);
    try {
      const observed = await f.ingest("judged", "Luma old decision");
      const first = await f.organizationalContext().retrieve(f.request());
      await f.judge(observed.observation, {
        kind: "correct",
        meetingItemId: "decision:choice",
        correction: { status: "superseded" }
      });
      expect((await f.organizationalContext().retrieve(f.request())).sources).toEqual([]);
      expect(
        (
          await f
            .organizationalContext()
            .retrieve({ ...f.request(), time: { mode: "history" } })
        ).sources.length
      ).toBeGreaterThan(0);
      await f.judge(
        observed.observation,
        { kind: "reject", meetingItemId: "decision:choice" },
        "reject"
      );
      await expect(
        f.organizationalContext().requireCurrent(f.request(), first.receiptId)
      ).rejects.toThrow();
      expect(
        (
          await f
            .organizationalContext()
            .retrieve({ ...f.request(), time: { mode: "history" } })
        ).sources
      ).toEqual([]);
    } finally {
      await db.close();
    }
  });
  it("fences a Human change during external proof and withholds independently replaced Human text without a grant", async () => {
    const db = await createPgliteDatabase();
    const f = importedMeetingFixture(db);
    try {
      const observed = await f.ingest("midflight", "Luma private plan");
      const first = await f.organizationalContext().retrieve(f.request());
      f.afterRead(() =>
        f
          .judge(
            observed.observation,
            {
              kind: "correct",
              meetingItemId: "decision:choice",
              correction: { statement: "Luma independently replaced confidential text" }
            },
            "correction"
          )
          .then(() => {})
      );
      expect(
        await f.catalog().read({ audience: f.audience, sourceId: first.sources[0]!.id })
      ).toBeNull();
      expect((await f.organizationalContext().retrieve(f.request())).sources).toEqual([]);
    } finally {
      await db.close();
    }
  });
  it("retains legacy Discord speech but never infers an original recall audience from today's participants", async () => {
    const database = await createPgliteDatabase();
    const f = importedMeetingFixture(database);
    try {
      const base = {
        workspaceId: f.workspace.workspaceId,
        meetingId: "legacy-discord",
        observedAt: "2026-09-11T09:00:00.000Z",
        occurredAt: "2026-09-11T09:00:00.000Z"
      };
      const mi = f.mi();
      const result = await mi.observe({
        workspace: f.workspace,
        observations: [
          {
            ...base,
            type: "meeting-started",
            observationId: "started",
            title: "Luma legacy Discord",
            startedAt: base.occurredAt,
            languageMode: "en",
            participantIds: f.audience.personIds
          },
          {
            ...base,
            type: "utterance-committed",
            observationId: "speech",
            utteranceId: "speech",
            version: 1,
            speaker: {
              status: "unresolved",
              candidatePersonId: null,
              confidence: "unknown",
              basis: "provider-speaker-label"
            },
            startedAt: base.occurredAt,
            endedAt: base.occurredAt,
            originalText: "Luma private legacy speech",
            language: "en"
          }
        ]
      });
      expect(result.acceptedObservationIds).toContain("speech");
      expect(result.analysisStatus).toBe("completed");
      const before = await database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM utterance_versions"
      );
      for (const time of [{ mode: "current" }, { mode: "history" }] as const) {
        const recalled = await f
          .organizationalContext()
          .retrieve({ ...f.request(), time });
        expect(recalled.sources).toEqual([]);
        expect(recalled.retrieval.complete).toBe(false);
        expect(recalled.retrieval.warnings.join(" ")).toContain("ungranted history");
      }
      expect(
        (
          await database.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM utterance_versions"
          )
        ).rows
      ).toEqual(before.rows);
      expect(
        (
          await database.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM meeting_imported_source_receipts"
          )
        ).rows[0]?.count
      ).toBe(0);
    } finally {
      await database.close();
    }
  });
  it("withholds externally informed analysis when no restricted verifier is composed", async () => {
    const db = await createPgliteDatabase();
    const f = importedMeetingFixture(db);
    try {
      f.context(
        createOrganizationalContext({
          database: db,
          catalogs: [
            {
              id: "external",
              search: () =>
                Promise.resolve({
                  sourceIds: ["document"],
                  complete: true,
                  warnings: []
                }),
              read: () =>
                Promise.resolve({
                  id: "document",
                  kind: "knowledge-document",
                  title: "Luma private external context",
                  content: "Luma external context",
                  version: "1",
                  updatedAt: "2026-09-11T08:00:00.000Z",
                  externalReference: {
                    providerId: "test",
                    objectType: "document",
                    externalId: "document",
                    url: "https://example.invalid/document"
                  },
                  standing: "current",
                  authority: "source"
                })
            }
          ]
        })
      );
      const observed = await f.ingest("derived", "Luma original transcript");
      expect(observed.result.analysisStatus).toBe("completed");
      expect((await f.snapshot(observed.observation)).decisions).toHaveLength(1);
      expect((await f.organizationalContext().retrieve(f.request())).sources).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
