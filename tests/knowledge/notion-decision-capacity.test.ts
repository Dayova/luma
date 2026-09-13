import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import { DecisionWriteNotAppliedError } from "../../src/knowledge/decision-records.js";
import { sharedNotionRequestScheduler } from "../../src/knowledge/notion-request-scheduler.js";
import {
  nativeDecisionFixture,
  completeNativeDecisionOperation as complete,
  audience,
  pageId
} from "./notion-decision-native-fixture.js";

let database: LumaDatabase;
let directory: string;
beforeEach(async () => {
  database = await createPgliteDatabase();
  directory = await mkdtemp(join(tmpdir(), "luma-notion-capacity-"));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await database.close();
  await rm(directory, { recursive: true, force: true });
});

const fixture = (count: number) => nativeDecisionFixture(database, directory, count);

describe("native Decision Record capacity and read-only access", () => {
  it("discovers 100 signed records under a real-shaped 180/minute service window with bounded asynchronous reads", async () => {
    const f = await fixture(100);
    f.clock();
    const started = Date.now();
    const catalog = await complete(f.reader.discover({ audience, limit: 100 }));
    expect(catalog.complete).toBe(true);
    expect(catalog.records).toHaveLength(100);
    expect(new Set(f.calls.map((call) => call.credential))).toEqual(new Set(["reader"]));
    expect(f.calls.filter((call) => call.kind === "records")).toHaveLength(302);
    expect(f.calls.filter((call) => call.kind === "authority")).toHaveLength(3);
    expect(f.sourceProof).toHaveBeenCalledTimes(1);
    expect(f.authorityProof).toHaveBeenCalledTimes(1);
    expect(f.throttled()).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(60_000);
    expect(Date.now() - started).toBeLessThan(240_000);
  });
  it("aborts a native transport that never settles within the per-request bound", async () => {
    const f = await fixture(0);
    f.clock();
    f.stall();
    const start = Date.now();
    const result = await complete(f.reader.discover({ audience, limit: 100 }));
    expect(result.complete).toBe(false);
    expect(f.cancelled()).toBe(1);
    expect(Date.now() - start).toBeLessThan(10_000);
  });
  it.each([429, 529] as const)(
    "honors native SDK Retry-After after an actual %s response without losing the catalog",
    async (status) => {
      const f = await fixture(1);
      f.clock();
      f.overload(status);
      const start = Date.now();
      const result = await complete(f.reader.discover({ audience, limit: 100 }));
      expect(result.complete).toBe(true);
      expect(result.records).toHaveLength(1);
      expect(f.throttled()).toBe(1);
      expect(f.calls[0]!.at - start).toBeGreaterThanOrEqual(2_000);
    }
  );
  it("verifies a known complete snapshot with exact content and fresh deduplicated grants without repeating initial reads", async () => {
    const f = await fixture(100);
    f.clock();
    const snapshot = await complete(f.reader.discover({ audience, limit: 100 }));
    f.calls.length = 0;
    f.sourceProof.mockClear();
    f.authorityProof.mockClear();
    await complete(f.reader.requireCurrent({ audience, snapshot }));
    expect(f.calls.filter((call) => call.kind === "records")).toHaveLength(202);
    expect(f.calls.filter((call) => call.kind === "authority")).toHaveLength(3);
    expect(f.sourceProof).toHaveBeenCalledTimes(1);
    expect(f.authorityProof).toHaveBeenCalledTimes(1);
    expect(f.throttled()).toBe(0);
    f.seed(pageId(1), "changed-without-native-timestamp");
    await expect(
      complete(f.reader.requireCurrent({ audience, snapshot }))
    ).rejects.toThrow();
  });
  it("creates the 100th record without repeated catalog payload scans and verifies the returned exact native page", async () => {
    const f = await fixture(99);
    f.clock();
    const result = await complete(f.records.write(f.create()));
    expect(
      new Set(
        f.calls.filter((call) => call.kind === "records").map((call) => call.credential)
      )
    ).toEqual(new Set(["writer"]));
    expect(
      new Set(
        f.calls.filter((call) => call.kind === "authority").map((call) => call.credential)
      )
    ).toEqual(new Set(["reader"]));
    expect(result.record.reference.externalId).toBe(pageId(100));
    expect(f.pages.size).toBe(100);
    expect(f.calls.filter((call) => call.kind === "records")).toHaveLength(503);
    expect(f.calls.filter((call) => call.kind === "authority")).toHaveLength(18);
    expect(f.throttled()).toBe(0);
  });
  it("refuses a changed canonical catalog even when the provider's edit timestamp is unchanged", async () => {
    const f = await fixture(1);
    f.changeBeforeDispatch(() => f.seed(pageId(1), f.create().stage.record.id));
    await expect(f.records.write(f.create())).rejects.toBeInstanceOf(
      DecisionWriteNotAppliedError
    );
    expect(f.pages.size).toBe(1);
    expect(
      (await f.records.read({ audience, recordId: f.create().stage.record.id }))?.content
        .id
    ).toBe(f.create().stage.record.id);
  });
  it("uses exact verified references without a catalog scan while logical collisions still refuse and the native reader cannot write", async () => {
    const f = await fixture(2);
    f.seed(pageId(2), pageId(1));
    expect(Object.keys(f.reader).sort()).toEqual([
      "discover",
      "history",
      "providerId",
      "read",
      "readReference",
      "requireCurrent"
    ]);
    const reference = {
      providerId: "notion",
      objectType: "document" as const,
      externalId: pageId(1),
      url: `https://notion.so/${pageId(1)}`
    };
    expect((await f.reader.readReference({ audience, reference }))?.content.id).toBe(
      "decision-1"
    );
    expect(f.calls.filter((call) => call.kind === "records")).toHaveLength(3);
    expect(await f.reader.read({ audience, recordId: pageId(1) })).toBeNull();
    f.revoke();
    expect(await f.reader.readReference({ audience, reference })).toBeNull();
    expect(
      f.calls.some(
        (call) =>
          call.kind === "records" && call.method !== "GET" && call.method !== "POST"
      )
    ).toBe(false);
    expect(f.pages.size).toBe(2);
  });
  it("keeps a lost creation acknowledgement unknown and recovers its positive signed identity without another write", async () => {
    const f = await fixture(2);
    f.loseResponse();
    await expect(f.records.write(f.create())).rejects.toThrow("unknown");
    const before = f.calls.filter((call) => call.kind === "records").length;
    expect((await f.records.findWritten(f.create()))?.record.reference.externalId).toBe(
      pageId(3)
    );
    expect(f.pages.size).toBe(3);
    expect(f.calls.filter((call) => call.kind === "records").length - before).toBe(11);
  });
  it("does not dispatch after a currentness proof stalls beyond the operation deadline", async () => {
    const f = await fixture(0);
    f.clock();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = f.records.write({ ...f.create(), requireCurrent: () => held });
    const refusal = expect(pending).rejects.toBeInstanceOf(DecisionWriteNotAppliedError);
    await complete(refusal);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.pages.size).toBe(0);
  });
  it("revalidates source permission when the write must wait after its first complete proof", async () => {
    const f = await fixture(0);
    f.clock();
    let attempts = 0;
    const requireCurrent = async () => {
      attempts++;
      if (attempts > 1) throw new Error("Source authorization revoked while queued");
      const scheduler = sharedNotionRequestScheduler(f.writerToken);
      // Three destination reads already occurred (two discovery lists and the final list).
      await Promise.all(
        Array.from({ length: 177 }, () =>
          scheduler.request({
            signal: new AbortController().signal,
            readOnly: true,
            send: () => Promise.resolve()
          })
        )
      );
    };
    await complete(
      expect(f.records.write({ ...f.create(), requireCurrent })).rejects.toBeInstanceOf(
        DecisionWriteNotAppliedError
      )
    );
    expect(attempts).toBe(2);
    expect(f.pages.size).toBe(0);
  });
});
