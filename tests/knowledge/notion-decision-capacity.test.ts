import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import {
  createNotionDecisionAuthority,
  decisionAuthorityContentHash
} from "../../src/decision-intelligence/notion-decision-authority.js";
import { createNotionReadOnlyKnowledgeCatalog } from "../../src/knowledge/notion-read-only-knowledge-catalog.js";
import {
  createNotionDecisionRecords,
  createNotionDecisionRecordCatalog
} from "../../src/knowledge/notion-decision-records.js";
import { renderNotionDecisionRecord } from "../../src/knowledge/notion-decision-record-format.js";
import { DecisionWriteNotAppliedError } from "../../src/knowledge/decision-records.js";
import { sharedNotionRequestScheduler } from "../../src/knowledge/notion-request-scheduler.js";
import { decisionRecord } from "./decision-record-fixture.js";

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

const workspaceId = "dayova";
const dataSourceId = "3bc2e872-28bf-8193-9669-ec8c5a94aae3";
const ownershipId = "11111111-1111-4111-8111-111111111111";
const audience = decisionRecord().source.audience;
const signingKey = "test-only-signing-key-with-more-than-32-bytes";
const pageId = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;

async function fixture(count: number) {
  const writerToken = `test-only-writer-${randomUUID()}`;
  const readerToken = `test-only-reader-${randomUUID()}`;
  const text = "Jakob owns Luma.";
  const policyPath = join(directory, "authority.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      schemaVersion: 1,
      workspaceId,
      documentId: ownershipId,
      contentHash: decisionAuthorityContentHash(text),
      grants: [
        {
          id: "luma-owner",
          personId: "jakob",
          scopeId: "luma",
          kind: "project-ownership",
          standing: "current",
          excerpt: text,
          delegatedBy: null,
          consultedPersonIds: []
        }
      ]
    }),
    { mode: 0o600 }
  );
  const pages = new Map<string, string>();
  const calls: { kind: "authority" | "records"; method: string; at: number }[] = [];
  const windows = new Map<string, number[]>();
  let latency = 0;
  let throttled = 0;
  let overloadStatus: 429 | 529 | undefined;
  let stall = false;
  let cancelled = 0;
  const authorityGranted = true;
  let sourceGranted = true;
  let loseCreate = false;
  let listCount = 0;
  let onFinalListing = () => {};
  vi.spyOn(globalThis, "fetch").mockImplementation(async (raw, init) => {
    const url = new URL(raw instanceof Request ? raw.url : String(raw));
    const method = init?.method ?? "GET";
    if (stall)
      return new Promise<Response>(() => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            cancelled++;
          },
          { once: true }
        );
      });
    if (overloadStatus !== undefined) {
      const status = overloadStatus;
      overloadStatus = undefined;
      throttled++;
      return new Response(
        JSON.stringify({
          object: "error",
          code: status === 429 ? "rate_limited" : "service_unavailable",
          status,
          message: "test overload"
        }),
        { status, headers: { "retry-after": "2" } }
      );
    }
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    const now = Date.now();
    const recent = (windows.get(authorization) ?? []).filter((at) => at > now - 60_000);
    if (recent.length >= 180) {
      throttled++;
      return new Response(
        JSON.stringify({
          object: "error",
          code: "rate_limited",
          message: "test window exhausted",
          status: 429
        }),
        {
          status: 429,
          headers: {
            "retry-after": String(
              Math.max(1, Math.ceil((recent[0]! + 60_000 - now) / 1000))
            )
          }
        }
      );
    }
    recent.push(now);
    windows.set(authorization, recent);
    const kind = url.pathname.includes(ownershipId) ? "authority" : "records";
    calls.push({ kind, method, at: now });
    if (latency)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, latency);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("cancelled"));
          },
          { once: true }
        );
      });
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as { markdown?: string })
        : {};
    let result: unknown;
    if (kind === "authority")
      result = url.pathname.endsWith("/markdown")
        ? {
            object: "page_markdown",
            id: ownershipId,
            markdown: text,
            truncated: false,
            unknown_block_ids: []
          }
        : {
            object: "page",
            id: ownershipId,
            url: `https://notion.so/${ownershipId}`,
            archived: !authorityGranted,
            in_trash: !authorityGranted,
            last_edited_time: "2026-09-11T10:00:00Z",
            properties: { title: { type: "title", title: [{ plain_text: "Ownership" }] } }
          };
    else if (url.pathname === `/v1/data_sources/${dataSourceId}/query`) {
      listCount++;
      if (listCount === 3) onFinalListing();
      result = {
        object: "list",
        results: [...pages.keys()].map((id) => ({ object: "page", id })),
        has_more: false,
        next_cursor: null
      };
    } else if (url.pathname === "/v1/pages" && method === "POST") {
      const id = pageId(pages.size + 1);
      pages.set(id, body.markdown!);
      if (loseCreate) throw new Error("Native acknowledgement lost");
      result = { object: "page", id };
    } else {
      const id = url.pathname.split("/")[3]!;
      result = url.pathname.endsWith("/markdown")
        ? {
            object: "page_markdown",
            id,
            markdown: pages.get(id),
            truncated: false,
            unknown_block_ids: []
          }
        : {
            object: "page",
            id,
            url: `https://notion.so/${id}`,
            archived: false,
            in_trash: false,
            last_edited_time: "2026-09-11T10:00:00Z",
            parent: { type: "data_source_id", data_source_id: dataSourceId }
          };
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
  const knowledge = createNotionReadOnlyKnowledgeCatalog({
    workspaceId,
    credentialScopeId: "authority",
    pageIds: [ownershipId],
    readOnlyApiToken: readerToken,
    authorize: () => Promise.resolve(authorityGranted)
  });
  const authority = createNotionDecisionAuthority({
    database,
    workspaceId,
    policyPath,
    knowledge,
    recipientPersonIds: audience.personIds
  });
  const snapshot = await authority.read({ audience });
  const content = (id: string) => {
    const value = decisionRecord(id);
    value.authority.snapshot = snapshot;
    value.authority.grantIds = ["luma-owner"];
    return value;
  };
  const seed = (id: string, logicalId: string) =>
    pages.set(
      id,
      renderNotionDecisionRecord(
        {
          format: 1,
          workspaceId,
          dataSourceId,
          revisions: [
            {
              operationId: `seed-${id}`,
              stageDigest: "a".repeat(64),
              content: content(logicalId)
            }
          ]
        },
        signingKey
      )
    );
  for (let i = 1; i <= count; i++) seed(pageId(i), `decision-${i}`);
  const sourceProof = vi.fn(() => Promise.resolve(sourceGranted));
  const authorityProof = vi.fn(
    (request: Parameters<typeof authority.authorizeRetainedAuthority>[0]) =>
      authority.authorizeRetainedAuthority(request)
  );
  const config = {
    workspaceId,
    dataSourceId,
    signingKey,
    authorize: () => Promise.resolve(true),
    authorizeRetainedSource: sourceProof,
    authorizeRetainedAuthority: authorityProof
  };
  const records = createNotionDecisionRecords({ ...config, token: writerToken });
  const reader = createNotionDecisionRecordCatalog({
    ...config,
    readOnlyApiToken: writerToken
  });
  const create = () => ({
    audience,
    operationId: `new-${count}`,
    stage: { type: "create-record" as const, record: content(`new-${count}`) },
    requireCurrent: () => authority.requireCurrent({ audience, snapshot })
  });
  calls.length = 0;
  return {
    records,
    reader,
    create,
    calls,
    sourceProof,
    authorityProof,
    pages,
    seed,
    writerToken,
    changeBeforeDispatch: (change: () => void) => {
      onFinalListing = change;
    },
    clock: () => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      latency = 10;
    },
    throttled: () => throttled,
    stall: () => {
      stall = true;
    },
    cancelled: () => cancelled,
    overload: (status: 429 | 529) => {
      overloadStatus = status;
    },
    loseResponse: () => {
      loseCreate = true;
    },
    revoke: () => {
      sourceGranted = false;
    },
    writes: () =>
      calls.filter((call) => call.kind === "records" && call.method === "POST").length
  };
}

async function complete<T>(pending: Promise<T>): Promise<T> {
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  for (let i = 0; i < 241 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return pending;
}

describe("native Decision Record capacity and read-only access", () => {
  it("discovers 100 signed records under a real-shaped 180/minute service window with bounded asynchronous reads", async () => {
    const f = await fixture(100);
    f.clock();
    const started = Date.now();
    const catalog = await complete(f.reader.discover({ audience, limit: 100 }));
    expect(catalog.complete).toBe(true);
    expect(catalog.records).toHaveLength(100);
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
