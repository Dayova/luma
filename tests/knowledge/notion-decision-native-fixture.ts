import { vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LumaDatabase } from "../../src/persistence/db.js";
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
import { decisionRecord } from "./decision-record-fixture.js";
export const workspaceId = "dayova";
export const dataSourceId = "3bc2e872-28bf-8193-9669-ec8c5a94aae3";
export const ownershipId = "11111111-1111-4111-8111-111111111111";
export const audience = decisionRecord().source.audience;
export const signingKey = "test-only-signing-key-with-more-than-32-bytes";
export const pageId = (n: number) =>
  `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;

export async function nativeDecisionFixture(
  database: LumaDatabase,
  directory: string,
  count: number
) {
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

export async function completeNativeDecisionOperation<T>(
  pending: Promise<T>
): Promise<T> {
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
