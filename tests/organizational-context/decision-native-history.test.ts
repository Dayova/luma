import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import { createDecisionRecallRuntime } from "../../src/organizational-context/decision-recall-runtime.js";
import { createOrganizationalContext } from "../../src/organizational-context/organizational-context.js";
import { renderNotionDecisionRecord } from "../../src/knowledge/notion-decision-record-format.js";
import type { DecisionRecordContent } from "../../src/domain/decision-records.js";
import {
  nativeDecisionFixture,
  audience,
  dataSourceId,
  pageId,
  signingKey,
  workspaceId
} from "../knowledge/notion-decision-native-fixture.js";
let database: LumaDatabase;
let directory: string;
let stop: (() => Promise<void>) | undefined;
beforeEach(async () => {
  database = await createPgliteDatabase();
  directory = await mkdtemp(join(tmpdir(), "luma-native-history-"));
});
afterEach(async () => {
  await stop?.();
  stop = undefined;
  vi.restoreAllMocks();
  await database.close();
  await rm(directory, { recursive: true, force: true });
});
const request = {
  audience,
  subject: { type: "conversation" as const, id: "history-question" },
  purpose: "answer-question" as const,
  concepts: ["Luma"],
  time: { mode: "current" as const },
  limit: 3,
  maxCharacters: 12000
};
async function fixture() {
  const native = await nativeDecisionFixture(database, directory, 1);
  const original = native.create().stage.record;
  original.id = "decision-history";
  original.recordedAt = "2020-01-01T10:00:00Z";
  original.candidate.statement.text = "Luma chose the alpha rollout.";
  const amended = structuredClone(original);
  amended.recordedAt = "2022-01-01T10:00:00Z";
  amended.candidate.statement.text = "Luma chose the beta rollout.";
  const latest = structuredClone(amended);
  latest.recordedAt = "2026-09-11T10:00:00Z";
  latest.candidate.statement.text = "Luma chose the gamma rollout.";
  const revisions = [original, amended, latest];
  const seed = (
    contents: DecisionRecordContent[] = revisions,
    recordedRevisionTimes = true
  ) =>
    native.pages.set(
      pageId(1),
      renderNotionDecisionRecord(
        {
          format: 1,
          workspaceId,
          dataSourceId,
          revisions: contents.map((content, index) => ({
            operationId: `revision-${index + 1}`,
            stageDigest: String(index + 1).repeat(64),
            ...(recordedRevisionTimes ? { recordedAt: content.recordedAt } : {}),
            content
          }))
        },
        signingKey
      )
    );
  seed();
  const recall = await createDecisionRecallRuntime({
    database,
    workspaceId,
    catalogId: "canonical-decisions",
    records: native.reader,
    audience: () => Promise.resolve(audience)
  });
  stop = () => recall.stop();
  const context = createOrganizationalContext({ database, catalogs: [recall.catalog] });
  return { native, recall, context, revisions, seed };
}
describe("previously unseen signed Decision archive recall", () => {
  it("discovers all revisions in the background, then reads an unseen as-of state through native read-only HTTP", async () => {
    const f = await fixture();
    const originalPages = new Map(f.native.pages);
    expect((await f.recall.syncOnce()).state).toBe("ready");
    expect(
      (await database.query("SELECT source_json FROM organizational_context_snapshots"))
        .rows
    ).toEqual([]);
    const historical = {
      ...request,
      time: { mode: "history" as const, asOf: "2021-01-01T00:00:00Z" }
    };
    const before = f.native.calls.length;
    const candidates = await f.recall.catalog.search({ ...historical });
    expect(candidates.sourceIds).toHaveLength(1);
    expect(f.native.calls).toHaveLength(before);
    const answer = await f.context.retrieve(historical);
    expect(answer.sources).toHaveLength(1);
    expect(answer.sources[0]).toMatchObject({
      standing: "historical",
      authority: "human-confirmed",
      updatedAt: "2020-01-01T10:00:00Z"
    });
    expect(answer.sources[0]!.content).toContain("alpha rollout");
    expect(answer.sources[0]!.content).toContain("Historical signed revision");
    expect(answer.sources[0]!.content).toContain("Effective at: not explicitly recorded");
    expect(answer.sources[0]!.content).not.toContain("Evidence and revision history");
    await f.context.requireCurrent(historical, answer.receiptId);
    expect(f.native.calls.every((call) => call.credential === "reader")).toBe(true);
    expect(f.native.pages).toEqual(originalPages);
  });
  it("keeps retained archive versions out of current defaults and selects the latest recorded as-of revision", async () => {
    const f = await fixture();
    await f.recall.syncOnce();
    const history = await f.context.retrieve({ ...request, time: { mode: "history" } });
    expect(history.sources).toHaveLength(3);
    expect(history.sources.every((source) => source.standing === "historical")).toBe(
      true
    );
    const current = await f.context.retrieve(request);
    expect(current.sources).toHaveLength(1);
    expect(current.sources[0]!.content).toContain("gamma rollout");
    expect(current.sources[0]!.standing).toBe("current");
    const asOf = await f.context.retrieve({
      ...request,
      time: { mode: "history", asOf: "2023-01-01T00:00:00Z" }
    });
    expect(asOf.sources).toHaveLength(1);
    expect(asOf.sources[0]!.content).toContain("beta rollout");
    expect(asOf.sources[0]!.content).not.toContain("alpha rollout");
  });
  it("prefers recent matching history when the live-read bound omits older revisions", async () => {
    const f = await fixture();
    const newest = structuredClone(f.revisions[2]!);
    newest.recordedAt = "2026-09-12T10:00:00Z";
    newest.candidate.statement.text = "Luma chose the delta rollout.";
    f.seed([...f.revisions, newest]);
    await f.recall.syncOnce();
    const history = await f.context.retrieve({ ...request, time: { mode: "history" } });
    expect(history.sources).toHaveLength(3);
    const content = history.sources.map((source) => source.content).join("\n");
    expect(content).toContain("delta rollout");
    expect(content).toContain("beta rollout");
    expect(content).not.toContain("alpha rollout");
    expect(history.retrieval.complete).toBe(false);
  });
  it("separates recorded knowledge time from evidenced applicability and never activates a pending record by elapsed time", async () => {
    const f = await fixture();
    f.revisions[0]!.status = "pending";
    f.revisions[0]!.candidate.effectiveAt = "2022-01-01T00:00:00Z";
    f.revisions[2]!.candidate.effectiveAt = "2018-01-01T00:00:00Z";
    f.seed();
    await f.recall.syncOnce();
    const result = await f.context.retrieve({
      ...request,
      time: { mode: "history", asOf: "2021-01-01T00:00:00Z" }
    });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.content).toContain("Record state: pending");
    expect(result.sources[0]!.content).toContain("Effective at: 2022-01-01");
    expect(result.sources[0]!.content).not.toContain("gamma rollout");
    expect(result.sources[0]!.standing).toBe("historical");
  });
  it.each(["source-revoked", "archive-amended", "archive-tampered"])(
    "invalidates historical receipts after %s while retaining prior snapshots",
    async (kind) => {
      const f = await fixture();
      await f.recall.syncOnce();
      const historical = {
        ...request,
        time: { mode: "history" as const, asOf: "2021-01-01T00:00:00Z" }
      };
      const answer = await f.context.retrieve(historical);
      expect(answer.sources).toHaveLength(1);
      const saved = await database.query(
        "SELECT source_json FROM organizational_context_snapshots ORDER BY snapshot_id"
      );
      if (kind === "source-revoked") f.native.revoke();
      else if (kind === "archive-tampered")
        f.native.pages.set(
          pageId(1),
          f.native.pages.get(pageId(1))!.replace("alpha rollout", "private unsigned edit")
        );
      else {
        const next = structuredClone(f.revisions[2]!);
        next.recordedAt = "2026-09-12T10:00:00Z";
        next.candidate.statement.text = "Luma changed again.";
        f.seed([...f.revisions, next]);
      }
      await expect(
        f.context.requireCurrent(historical, answer.receiptId)
      ).rejects.toThrow();
      expect(
        (
          await database.query(
            "SELECT source_json FROM organizational_context_snapshots ORDER BY snapshot_id"
          )
        ).rows
      ).toEqual(saved.rows);
      if (kind === "archive-amended") {
        const refreshed = await f.context.retrieve(historical);
        expect(refreshed.sources).toHaveLength(1);
        expect(refreshed.sources[0]!.content).toContain("alpha rollout");
        await f.context.requireCurrent(historical, refreshed.receiptId);
      } else expect((await f.context.retrieve(historical)).sources).toEqual([]);
    }
  );
  it("retains legacy undated archive states without inventing their as-of lifecycle timing", async () => {
    const f = await fixture();
    f.seed(f.revisions, false);
    await f.recall.syncOnce();
    const full = await f.context.retrieve({ ...request, time: { mode: "history" } });
    expect(full.sources).toHaveLength(3);
    expect(
      full.sources.every((source) =>
        source.content.includes("Revision recorded at: unknown")
      )
    ).toBe(true);
    const asOf = await f.context.retrieve({
      ...request,
      time: { mode: "history", asOf: "2023-01-01T00:00:00Z" }
    });
    expect(asOf.sources).toEqual([]);
    expect(asOf.retrieval.complete).toBe(false);
  });
  it("requires the original audience on every archived revision and reports bounded history omissions", async () => {
    const f = await fixture();
    const bounded = await f.native.reader.history!.discover({
      audience,
      limit: 100,
      historyLimit: 1
    });
    expect(bounded.current.complete).toBe(true);
    expect(bounded.complete).toBe(false);
    expect(bounded.revisions).toHaveLength(1);
    f.revisions[0]!.source.audience.personIds = ["jakob"];
    f.seed();
    const originalPages = new Map(f.native.pages);
    await f.recall.syncOnce();
    expect(
      (await f.context.retrieve({ ...request, time: { mode: "history" } })).sources
    ).toEqual([]);
    expect(f.native.calls.every((call) => call.credential === "reader")).toBe(true);
    expect(f.native.pages).toEqual(originalPages);
  });
});
