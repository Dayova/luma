import { afterEach, describe, expect, it } from "vitest";
import { createDecisionContextCatalog } from "../../src/organizational-context/decision-context-catalog.js";
import { createOrganizationalContext } from "../../src/organizational-context/organizational-context.js";
import type { OrganizationalContextRequest } from "../../src/organizational-context/interface.js";
import type { DecisionRecordCatalog } from "../../src/knowledge/decision-record-catalog.js";
import type {
  CanonicalDecisionRecord,
  DecisionCatalogSnapshot
} from "../../src/domain/decision-records.js";
import { decisionRecord } from "../knowledge/decision-record-fixture.js";
import { decisionDigest } from "../../src/decision-intelligence/persistence.js";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";

const audience = decisionRecord().source.audience;
const request: OrganizationalContextRequest = {
  audience,
  subject: { type: "conversation", id: "another-thread" },
  purpose: "answer-question",
  concepts: ["Luma"],
  time: { mode: "current" },
  limit: 10,
  maxCharacters: 8000
};
const databases: LumaDatabase[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});
function canonical(
  id: string,
  text: string,
  state: CanonicalDecisionRecord["content"]["status"] = "active"
): CanonicalDecisionRecord {
  const content = decisionRecord(id);
  content.candidate.statement.text = text;
  content.source.evidence[0]!.text = text;
  content.source.evidence[0]!.reference.excerpt = text;
  content.status = state;
  content.recordedAt = "2020-01-01T12:00:00Z";
  return {
    content,
    reference: {
      providerId: "notion",
      objectType: "document",
      externalId: id,
      url: `https://notion.so/${id}`,
      version: "v1"
    },
    version: "v1"
  };
}
async function fixture() {
  const database = await createPgliteDatabase();
  databases.push(database);
  let records: CanonicalDecisionRecord[] = [
    canonical("active", "Luma remains internal to the four founders.")
  ];
  let granted = true,
    complete = true;
  const snapshot = (): DecisionCatalogSnapshot => ({
    id: "decisions",
    revision: decisionDigest(records),
    records: structuredClone(records),
    complete
  });
  const permitted = (readers: typeof audience) =>
    granted &&
    readers.workspaceId === audience.workspaceId &&
    readers.personIds.every((id) => audience.personIds.includes(id));
  const reader: DecisionRecordCatalog = {
    providerId: "notion",
    discover: (input) =>
      Promise.resolve(
        permitted(input.audience)
          ? snapshot()
          : { ...snapshot(), complete: false, records: [] }
      ),
    requireCurrent: (input) =>
      permitted(input.audience) &&
      decisionDigest(snapshot()) === decisionDigest(input.snapshot)
        ? Promise.resolve()
        : Promise.reject(new Error("changed")),
    read: () =>
      Promise.reject(new Error("Known citations must use exact-reference reads")),
    readReference: (input) =>
      Promise.resolve(
        permitted(input.audience)
          ? structuredClone(
              records.find(
                (record) =>
                  record.reference.externalId === input.reference.externalId &&
                  record.reference.url === input.reference.url
              ) ?? null
            )
          : null
      )
  };
  const catalog = createDecisionContextCatalog({
    id: "canonical-decisions",
    records: reader
  });
  const context = () =>
    createOrganizationalContext({
      database,
      catalogs: [catalog],
      now: () => new Date("2026-09-11T12:00:00Z")
    });
  return {
    database,
    catalog,
    context,
    setRecords: (next: CanonicalDecisionRecord[]) => {
      records = next;
    },
    revoke: () => {
      granted = false;
    },
    incomplete: () => {
      complete = false;
    }
  };
}
describe("canonical Decision recall", () => {
  it("recalls an old still-active Human decision without its raw archive or fabricated rationale", async () => {
    const f = await fixture();
    const result = await f.context().retrieve(request);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      standing: "current",
      authority: "human-confirmed",
      updatedAt: "2020-01-01T12:00:00Z"
    });
    expect(result.sources[0]!.content).toContain("internal to the four founders");
    expect(result.sources[0]!.content).toContain("Original source: https://discord.com/");
    expect(result.sources[0]!.content).not.toContain("Rationale:");
    expect(result.sources[0]!.content).not.toContain("record-decision");
    expect(result.retrieval.complete).toBe(true);
    await f.context().requireCurrent(request, result.receiptId);
  });
  it("keeps superseded and reversed records out of current answers and labels them in explicit history", async () => {
    const f = await fixture();
    const old = canonical("old", "Luma uses immediate deployment.", "superseded");
    const reversed = canonical("reversed", "Luma is available to guests.", "reversed");
    const active = canonical("active", "Luma uses staged deployment.");
    active.content.supersedes = [old.reference];
    old.content.supersededBy = active.reference;
    f.setRecords([old, reversed, active]);
    const current = await f.context().retrieve(request);
    expect(current.sources.map((source) => source.title)).toEqual([
      "Luma uses staged deployment."
    ]);
    const history = await f.context().retrieve({ ...request, time: { mode: "history" } });
    expect(history.sources).toHaveLength(3);
    expect(
      history.sources.find((source) => source.title.includes("guests"))?.standing
    ).toBe("superseded");
    expect(
      history.sources.find((source) => source.title.includes("immediate"))?.content
    ).toContain("Replaced by:");
  });
  it("a pending successor does not suppress its active predecessor", async () => {
    const f = await fixture();
    const old = canonical("old", "Luma remains internal.");
    const pending = canonical("pending", "Luma will support customers.", "pending");
    pending.content.supersedes = [old.reference];
    f.setRecords([old, pending]);
    const result = await f.context().retrieve(request);
    expect(result.sources[0]?.title).toBe("Luma remains internal.");
    expect(
      result.sources.find((source) => source.title.includes("customers"))
    ).toMatchObject({ standing: "proposed" });
    expect(
      result.sources.find((source) => source.title.includes("customers"))?.content
    ).toContain("not active organizational policy");
  });
  it("revokes stored receipts and new projections without deleting retained evidence", async () => {
    const f = await fixture();
    const result = await f.context().retrieve(request);
    const before = await f.database.query(
      "SELECT source_json FROM organizational_context_snapshots"
    );
    f.revoke();
    await expect(f.context().requireCurrent(request, result.receiptId)).rejects.toThrow();
    expect((await f.context().retrieve(request)).sources).toEqual([]);
    expect(
      (await f.database.query("SELECT source_json FROM organizational_context_snapshots"))
        .rows
    ).toEqual(before.rows);
  });
  it("invalidates a cached answer after a canonical amendment while retaining the previously observed history", async () => {
    const f = await fixture();
    const first = await f.context().retrieve(request);
    const updated = canonical("active", "Luma has a different approved rollout.");
    updated.content.recordedAt = "2026-09-11T11:00:00Z";
    updated.version = "v2";
    updated.reference.version = "v2";
    f.setRecords([updated]);
    await expect(f.context().requireCurrent(request, first.receiptId)).rejects.toThrow();
    expect((await f.context().retrieve(request)).sources[0]!.content).toContain(
      "different approved rollout"
    );
    const history = await f
      .context()
      .retrieve({ ...request, time: { mode: "history", asOf: "2021-01-01T12:00:00Z" } });
    expect(history.sources[0]?.standing).toBe("historical");
    expect(history.sources[0]?.content).toContain("internal to the four founders");
  });
  it.each([
    "tentative",
    "derived-acceptance",
    "provisional",
    "missing-owner",
    "changed-proof"
  ])(
    "withholds %s authority rather than assigning Human-confirmed standing",
    async (failure) => {
      const f = await fixture();
      const record = canonical("active", "Luma might be owned by the CTO.");
      if (failure === "tentative") record.content.candidate.modality = "proposal";
      if (failure === "derived-acceptance")
        record.content.source.evidence[0]!.origin = "provider-derived";
      if (failure === "provisional")
        record.content.authority.snapshot.grants[0]!.standing = "provisional";
      if (failure === "missing-owner") record.content.authority.grantIds = [];
      if (failure === "changed-proof")
        record.content.authority.decisionMakerPersonIds = ["fabius"];
      f.setRecords([record]);
      expect((await f.context().retrieve(request)).sources).toEqual([]);
    }
  );
  it.each(["valid", "subject", "content", "authorization", "audience"])(
    "binds supplemental Human acceptance to its exact original source: %s",
    async (variant) => {
      const f = await fixture();
      const record = canonical("active", "Luma remains internal to the four founders.");
      const source = record.content.source;
      const original = structuredClone(source.evidence[0]!);
      original.id = "review-evidence";
      original.reference.evidenceId = original.id;
      record.content.candidate.acceptanceEvidenceIds = [original.id];
      record.content.authority.acceptanceEvidenceIds = [original.id];
      source.evidence[0]!.origin = "provider-derived";
      source.evidence[0]!.authorPersonId = null;
      const review = {
        id: "review",
        requestId: "request",
        observationId: "observation",
        subject: structuredClone(source.subject),
        actor: { providerId: "discord", providerUserId: "jakob-discord" },
        personId: "jakob",
        audience: structuredClone(source.audience),
        sourceContentHash: source.contentHash,
        sourceAuthorizationHash: source.authorizationHash,
        reviewToken: null,
        acceptedCandidateHash: null,
        evidence: original,
        observedAt: "2026-09-11T12:00:00Z"
      };
      if (variant === "subject") review.subject = { type: "meeting", meetingId: "other" };
      if (variant === "content") review.sourceContentHash = "different";
      if (variant === "authorization") review.sourceAuthorizationHash = "different";
      if (variant === "audience") review.audience.personIds = ["jakob"];
      record.content.authority.humanReviews = [review];
      f.setRecords([record]);
      const result = await f.context().retrieve(request);
      expect(result.sources).toHaveLength(variant === "valid" ? 1 : 0);
    }
  );
  it("withholds a record whose claimed Human acceptance was only synthesis accuracy confirmation", async () => {
    const f = await fixture();
    const record = canonical("accuracy-only", "Luma will launch.");
    record.content.source.evidence[0]!.purpose = "capture-synthesis-review";
    f.setRecords([record]);
    expect((await f.context().retrieve(request)).sources).toEqual([]);
  });
  it("withholds incomplete catalog discovery and audience expansion", async () => {
    const f = await fixture();
    f.incomplete();
    const result = await f.context().retrieve(request);
    expect(result.sources).toEqual([]);
    expect(result.retrieval.complete).toBe(false);
    expect(
      (
        await f.context().retrieve({
          ...request,
          audience: { ...audience, personIds: [...audience.personIds, "guest"] }
        })
      ).sources
    ).toEqual([]);
  });
  it("refuses malformed or retargeted source identities", async () => {
    const f = await fixture();
    expect(await f.catalog.read({ audience, sourceId: "decision:garbage" })).toBeNull();
    expect(await f.catalog.read({ audience, sourceId: "notion:other-page" })).toBeNull();
  });
});
