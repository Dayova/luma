import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import { createDecisionRecallRuntime } from "../../src/organizational-context/decision-recall-runtime.js";
import { createOrganizationalContext } from "../../src/organizational-context/organizational-context.js";
import type { DecisionRecordCatalog } from "../../src/knowledge/decision-record-catalog.js";
import type { CanonicalDecisionRecord } from "../../src/domain/decision-records.js";
import { decisionRecord } from "../knowledge/decision-record-fixture.js";
import {
  nativeDecisionFixture,
  completeNativeDecisionOperation,
  audience
} from "../knowledge/notion-decision-native-fixture.js";

let database: LumaDatabase;
let directory: string;
beforeEach(async () => {
  database = await createPgliteDatabase();
  directory = await mkdtemp(join(tmpdir(), "luma-decision-recall-"));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await database.close();
  await rm(directory, { recursive: true, force: true });
});
const search = { audience, concepts: ["Luma"], limit: 100 };
const request = {
  ...search,
  subject: { type: "conversation" as const, id: "current-thread" },
  purpose: "answer-question" as const,
  time: { mode: "current" as const },
  limit: 3,
  maxCharacters: 10_000
};
function fixture() {
  let readable = true;
  let complete = true;
  let recipients = audience;
  let clock = new Date("2026-09-11T10:00:00Z");
  let record: CanonicalDecisionRecord = {
    content: decisionRecord(),
    version: "one",
    reference: {
      providerId: "notion",
      objectType: "document",
      externalId: "page",
      url: "https://notion.so/page",
      version: "one"
    }
  };
  const records: DecisionRecordCatalog = {
    providerId: "notion",
    discover: vi.fn(() =>
      Promise.resolve({
        id: "decision-source",
        revision: record.version,
        complete,
        records: complete ? [structuredClone(record)] : []
      })
    ),
    requireCurrent: () => Promise.resolve(),
    read: () =>
      Promise.reject(new Error("Untrusted identifier shortcut must not be used")),
    readReference: vi.fn(() => Promise.resolve(readable ? structuredClone(record) : null))
  };
  const config = {
    database,
    workspaceId: "dayova",
    catalogId: "decisions",
    records,
    audience: () => Promise.resolve(recipients),
    now: () => clock
  };
  return {
    config,
    records,
    incomplete: () => {
      complete = false;
    },
    revoke: () => {
      readable = false;
    },
    audience: (value: typeof audience) => {
      recipients = value;
    },
    age: () => {
      clock = new Date("2026-09-11T12:00:00Z");
    },
    change: () => {
      record = {
        ...record,
        version: "two",
        content: {
          ...record.content,
          candidate: {
            ...record.content.candidate,
            statement: {
              ...record.content.candidate.statement,
              text: "Luma uses the current revised internal policy."
            }
          }
        }
      };
    }
  };
}

describe("durable background Decision candidate discovery", () => {
  it("does no provider work during cold discovery and reuses only audience-bound candidate hints after restart", async () => {
    const f = fixture();
    const runtime = await createDecisionRecallRuntime(f.config);
    expect(await runtime.catalog.search(search)).toMatchObject({
      sourceIds: [],
      complete: false
    });
    expect(f.records.discover).not.toHaveBeenCalled();
    expect(await runtime.syncOnce()).toMatchObject({
      state: "ready",
      active: false,
      indexedCount: 1,
      coverage: "partial"
    });
    const found = await runtime.catalog.search(search);
    expect(found).toMatchObject({ complete: false, sourceIds: [expect.any(String)] });
    expect(f.records.discover).toHaveBeenCalledTimes(1);
    await runtime.stop();
    const restarted = await createDecisionRecallRuntime(f.config);
    expect(await restarted.catalog.search(search)).toEqual(found);
    f.change();
    expect(
      await restarted.catalog.read({ audience, sourceId: found.sourceIds[0]! })
    ).toMatchObject({
      version: "two",
      title: "Luma uses the current revised internal policy."
    });
    expect(f.records.discover).toHaveBeenCalledTimes(1);
    await restarted.stop();
  });
  it("keeps failed/stale discovery explicit and never uses cached source content after revocation", async () => {
    const f = fixture();
    const runtime = await createDecisionRecallRuntime(f.config);
    await runtime.syncOnce();
    const context = createOrganizationalContext({
      database,
      catalogs: [runtime.catalog]
    });
    const first = await context.retrieve(request);
    expect(first.sources).toHaveLength(1);
    f.incomplete();
    expect(await runtime.syncOnce()).toMatchObject({ state: "partial", indexedCount: 1 });
    f.age();
    expect(await runtime.status()).toMatchObject({ state: "stale" });
    expect((await runtime.catalog.search(search)).warnings.join(" ")).toContain("stale");
    f.revoke();
    expect((await context.retrieve(request)).sources).toEqual([]);
    await expect(context.requireCurrent(request, first.receiptId)).rejects.toThrow();
    await runtime.stop();
  });
  it("does not expand original index recipients when current configuration changes", async () => {
    const f = fixture();
    f.audience({ workspaceId: "dayova", personIds: ["jakob"] });
    const runtime = await createDecisionRecallRuntime(f.config);
    await runtime.syncOnce();
    f.audience(audience);
    expect(await runtime.catalog.search(search)).toMatchObject({
      sourceIds: [],
      complete: false
    });
    expect(
      await runtime.catalog.search({
        ...search,
        audience: { workspaceId: "elsewhere", personIds: ["jakob"] }
      })
    ).toMatchObject({ sourceIds: [] });
    expect(f.records.readReference).not.toHaveBeenCalled();
    await runtime.stop();
  });
  it("withholds corrupted candidate manifests rather than promoting them to authority", async () => {
    const f = fixture();
    const runtime = await createDecisionRecallRuntime(f.config);
    await runtime.syncOnce();
    await database.query(
      "UPDATE decision_recall_indexes SET manifest_json='{}' WHERE workspace_id=$1",
      ["dayova"]
    );
    expect(await runtime.catalog.search(search)).toMatchObject({
      sourceIds: [],
      complete: false
    });
    expect(await runtime.status()).toMatchObject({ state: "not-ready", indexedCount: 0 });
    await runtime.stop();
  });
  it("aborts a running discovery, drains it, rejects new admission and discards a late result", async () => {
    const f = fixture();
    let signal: AbortSignal | undefined;
    let release = () => {};
    f.records.discover = (input) => {
      signal = input.signal;
      return new Promise((resolve) => {
        release = () =>
          resolve({ id: "late", revision: "late", complete: true, records: [] });
      });
    };
    const runtime = await createDecisionRecallRuntime(f.config);
    runtime.start();
    runtime.start();
    const run = runtime.syncOnce();
    expect(runtime.syncOnce()).toBe(run);
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(await runtime.status()).toMatchObject({ scheduled: true, active: true });
    await runtime.stop();
    expect(signal?.aborted).toBe(true);
    expect(await run).toMatchObject({ state: "stopped" });
    release();
    await Promise.resolve();
    expect(await runtime.status()).toMatchObject({ indexedCount: 0, active: false });
    await expect(runtime.syncOnce()).rejects.toThrow("stopped");
    expect(() => runtime.start()).toThrow("stopped");
    expect(await runtime.catalog.search(search)).toMatchObject({ sourceIds: [] });
  });
  it("cancels admitted live source reads and drains both successful and failed callers on shutdown", async () => {
    const f = fixture();
    const runtime = await createDecisionRecallRuntime(f.config);
    await runtime.syncOnce();
    const found = await runtime.catalog.search(search);
    let signal: AbortSignal | undefined;
    f.records.readReference = (input) => {
      signal = input.signal;
      return new Promise(() => {});
    };
    const reading = runtime.catalog.read({ audience, sourceId: found.sourceIds[0]! });
    const failure = expect(reading).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(signal).toBeDefined());
    await runtime.stop();
    await failure;
    expect(signal?.aborted).toBe(true);
    expect(
      await runtime.catalog.read({ audience, sourceId: found.sourceIds[0]! })
    ).toBeNull();
  });
  it("keeps foreground exact reads available while a real native refresh waits for its background request allowance", async () => {
    const f = await nativeDecisionFixture(database, directory, 100);
    const runtime = await createDecisionRecallRuntime({
      database,
      workspaceId: "dayova",
      catalogId: "native-decisions",
      records: f.reader,
      audience: () => Promise.resolve(audience)
    });
    f.clock();
    await completeNativeDecisionOperation(runtime.syncOnce());
    f.calls.length = 0;
    const refresh = runtime.syncOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await runtime.status()).toMatchObject({ active: true });
    expect(f.calls.filter((call) => call.kind === "records")).toHaveLength(10);
    const context = createOrganizationalContext({
      database,
      catalogs: [runtime.catalog]
    });
    const start = Date.now();
    const answer = await completeNativeDecisionOperation(context.retrieve(request));
    expect(answer.sources).toHaveLength(1);
    expect(answer.sources[0]!.duplicates).toHaveLength(2);
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(await runtime.status()).toMatchObject({ active: true });
    expect(f.throttled()).toBe(0);
    await runtime.stop();
    await refresh;
  });
  it("indexes 100 actual native signed records outside Ask, then answers with bounded live reads under the unchanged context deadlines", async () => {
    const f = await nativeDecisionFixture(database, directory, 100);
    const runtime = await createDecisionRecallRuntime({
      database,
      workspaceId: "dayova",
      catalogId: "native-decisions",
      records: f.reader,
      audience: () => Promise.resolve(audience)
    });
    f.clock();
    const cold = Date.now();
    expect(await runtime.catalog.search(search)).toMatchObject({
      sourceIds: [],
      complete: false
    });
    expect(Date.now() - cold).toBeLessThan(5_000);
    expect(f.calls).toEqual([]);
    expect(await completeNativeDecisionOperation(runtime.syncOnce())).toMatchObject({
      state: "ready",
      indexedCount: 100
    });
    expect(f.calls.filter((call) => call.kind === "records")).toHaveLength(302);
    f.calls.length = 0;
    const context = createOrganizationalContext({
      database,
      catalogs: [runtime.catalog]
    });
    const started = Date.now();
    const result = await completeNativeDecisionOperation(context.retrieve(request));
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.duplicates).toHaveLength(2);
    expect(result.sources.every((source) => source.authority === "human-confirmed")).toBe(
      true
    );
    expect(result.retrieval.complete).toBe(false);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(f.calls.filter((call) => call.kind === "records")).toHaveLength(9);
    expect(f.throttled()).toBe(0);
    await runtime.stop();
  });
});
