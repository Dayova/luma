import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect as connectSocket } from "node:net";
import { describe, expect, it } from "vitest";
import type {
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../../src/ai/reasoning-model.js";
import type { WorkspaceConfig } from "../../src/domain/model.js";
import {
  createNotionMeetingNotesObservationHost,
  type NotionMeetingNotesObservationHost
} from "../../src/app/notion-meeting-notes-observation-host.js";
import { createNotionWebhookHttpServer } from "../../src/app/notion-webhook-http-server.js";
import {
  createMeetingNotesIngestion,
  type MeetingNotesIngestion
} from "../../src/knowledge/meeting-notes-ingestion.js";
import { createLedgerBackedImportedSourceVerifier } from "../../src/knowledge/ledger-backed-imported-source-verifier.js";
import type { MeetingNotesPageRefresher } from "../../src/knowledge/meeting-notes-source.js";
import {
  createNotionMeetingNotesSource,
  type NotionMeetingNotesApi,
  type NotionMeetingNotesBlock,
  type NotionMeetingNotesPageReader
} from "../../src/knowledge/notion-meeting-notes-source.js";
import {
  createObservedSourceLedger,
  type ObservedSourceRevision
} from "../../src/knowledge/observed-source-ledger.js";
import {
  createMeetingNotesSync,
  type MeetingNotesSync,
  type MeetingNotesSyncLogger,
  type MeetingNotesSyncScheduler
} from "../../src/knowledge/meeting-notes-sync.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";

const lumaWorkspace: WorkspaceConfig = {
  workspaceId: "workspace_dayova",
  timezone: "Europe/Berlin"
};
const notionWorkspaceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const canonicalMeetingsDataSourceId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const subscriptionId = "cccccccc-dddd-eeee-ffff-000000000000";
const integrationId = "dddddddd-eeee-ffff-0000-111111111111";
const meetingPageId = "11111111-2222-3333-4444-555555555555";
const verificationToken = "secret_luma_notion_webhook_verification_token";

const quietLogger: MeetingNotesSyncLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

function sourceRevision(): ObservedSourceRevision {
  return {
    change: "new",
    source: {
      providerId: "notion",
      sourceKind: "meeting-note",
      sourceObjectId: "meeting-notes-root",
      parentObjectId: meetingPageId,
      url: `https://www.notion.so/${meetingPageId}`
    },
    revision: 1,
    contentHash: "sha256:meeting-notes-root",
    providerVersion: "2026-08-11T10:00:00.000Z",
    capturedAt: "2026-08-11T10:01:00.000Z",
    snapshot: {
      schemaVersion: 1,
      title: "Product sync",
      lifecycle: "ready",
      calendar: null,
      recording: null,
      sections: {
        summary: { state: "unavailable", sourceBlockId: null, reasons: [] },
        actionItemsAndNotes: { state: "unavailable", sourceBlockId: null, reasons: [] },
        transcript: { state: "unavailable", sourceBlockId: null, reasons: [] }
      },
      markdown: { content: "# Product sync", truncated: false, unknownBlockIds: [] },
      completeness: { state: "complete" }
    }
  };
}

class HeldRefresher implements MeetingNotesPageRefresher {
  readonly pageIds: string[] = [];
  readonly started = deferred<void>();
  readonly release = deferred<void>();

  async refreshPage(input: { workspaceId: string; pageId: string }) {
    expect(input.workspaceId).toBe(lumaWorkspace.workspaceId);
    this.pageIds.push(input.pageId);
    this.started.resolve();
    await this.release.promise;

    return {
      status: "refreshed" as const,
      records: [sourceRevision()],
      completeness: "complete" as const,
      partialReasons: []
    };
  }
}

class FailingRefresher implements MeetingNotesPageRefresher {
  constructor(private readonly failureMessage: string) {}

  refreshPage(): Promise<never> {
    return Promise.reject(new Error(this.failureMessage));
  }
}

class RecordingIngestion implements MeetingNotesIngestion {
  readonly records: ObservedSourceRevision[] = [];

  ingest(input: { workspace: WorkspaceConfig; source: ObservedSourceRevision }) {
    expect(input.workspace).toEqual(lumaWorkspace);
    this.records.push(input.source);
    return Promise.resolve({
      workspaceId: lumaWorkspace.workspaceId,
      meetingId: "meeting:meeting-notes-root",
      revision: 1,
      acceptedObservationIds: [],
      duplicateObservationIds: [],
      analysisStatus: "not-needed" as const,
      interventions: [],
      events: [],
      errors: []
    });
  }
}

class RecordingSync implements MeetingNotesSync {
  startCalls = 0;
  stopCalls = 0;

  syncOnce() {
    return Promise.resolve({
      scannedRecords: 0,
      tombstonedRecords: 0,
      ingestedRecords: 0,
      unchangedRecords: 0,
      deliveryFailures: [],
      completeness: "complete" as const,
      partialReasons: []
    });
  }

  start() {
    this.startCalls += 1;
  }

  stop() {
    this.stopCalls += 1;
    return Promise.resolve();
  }

  status() {
    return {
      active: false,
      scheduled: this.startCalls > this.stopCalls,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastOutcome: null
    } as const;
  }
}

class NoAnalysisReasoningModel implements ReasoningModel {
  generateStructured<T>(
    _request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    void _request;
    return Promise.reject(
      new Error("automatic source observation must not invoke model analysis")
    );
  }
}

function meetingNotesBlock(
  overrides: Partial<NotionMeetingNotesBlock> &
    Pick<NotionMeetingNotesBlock, "id" | "type">
): NotionMeetingNotesBlock {
  return {
    text: null,
    checked: null,
    hasChildren: false,
    ...overrides
  };
}

const meetingNotesRootId = "22222222-3333-4444-8555-666666666666";
const summaryBlockId = "33333333-4444-4555-8666-777777777777";
const notesBlockId = "44444444-5555-4666-8777-888888888888";
const transcriptBlockId = "55555555-6666-4777-8888-999999999999";
const actionItemBlockId = "66666666-7777-4888-8999-aaaaaaaaaaaa";

class MutableMeetingNotesApi
  implements NotionMeetingNotesApi, NotionMeetingNotesPageReader
{
  lifecycle: "summary_in_progress" | "notes_ready" = "summary_in_progress";
  actionText = "Jakob prüft LUM-29.";
  private providerVersion = "2026-08-11T10:00:00.000Z";
  readonly markdownCalls: Array<{ pageId: string; includeTranscript: boolean }> = [];

  becomeReady(actionText: string): void {
    this.lifecycle = "notes_ready";
    this.actionText = actionText;
    this.providerVersion = "2026-08-11T10:01:00.000Z";
  }

  correct(actionText: string): void {
    this.actionText = actionText;
    const currentSecond = Number.parseInt(this.providerVersion.slice(17, 19), 10);
    this.providerVersion = `2026-08-11T10:${String(currentSecond + 1).padStart(2, "0")}:00.000Z`;
  }

  listDataSourcePages(): Promise<{
    pages: Array<{
      id: string;
      title: string | null;
      url: string;
      lastEditedAt: string | null;
      inTrash: boolean;
    }>;
    nextCursor: string | null;
    incomplete: boolean;
  }> {
    return Promise.resolve({
      pages: [this.page()],
      nextCursor: null,
      incomplete: false
    });
  }

  retrievePage(input: { pageId: string }) {
    if (input.pageId !== meetingPageId) {
      return Promise.reject(new Error("unexpected exact page read"));
    }

    return Promise.resolve({
      page: this.page(),
      parentDataSourceId: canonicalMeetingsDataSourceId
    });
  }

  listBlockChildren(input: { blockId: string; cursor?: string }) {
    if (input.cursor) {
      return Promise.reject(new Error("unexpected block cursor"));
    }

    if (input.blockId === meetingPageId) {
      return Promise.resolve({ blocks: [this.root()], nextCursor: null });
    }

    if (input.blockId === meetingNotesRootId) {
      return Promise.resolve({
        blocks: [
          meetingNotesBlock({ id: summaryBlockId, type: "paragraph" }),
          meetingNotesBlock({ id: notesBlockId, type: "paragraph" }),
          meetingNotesBlock({ id: transcriptBlockId, type: "paragraph" })
        ],
        nextCursor: null
      });
    }

    if (input.blockId === summaryBlockId) {
      return Promise.resolve({
        blocks: [
          meetingNotesBlock({
            id: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
            type: "paragraph",
            text: "LUM-29 observation workflow"
          })
        ],
        nextCursor: null
      });
    }

    if (input.blockId === notesBlockId) {
      return Promise.resolve({
        blocks: [
          meetingNotesBlock({
            id: actionItemBlockId,
            type: "to-do",
            text: this.actionText,
            checked: false
          })
        ],
        nextCursor: null
      });
    }

    if (input.blockId === transcriptBlockId) {
      return Promise.resolve({ blocks: [], nextCursor: null });
    }

    return Promise.reject(new Error("unexpected Meeting Notes block read"));
  }

  retrievePageMarkdown(input: { pageId: string; includeTranscript: boolean }) {
    if (input.pageId !== meetingPageId || !input.includeTranscript) {
      return Promise.reject(new Error("unexpected Meeting Notes Markdown read"));
    }

    this.markdownCalls.push(input);
    return Promise.resolve({
      content: `# Product sync\n\n${this.actionText}`,
      truncated: false,
      unknownBlockIds: []
    });
  }

  private page() {
    return {
      id: meetingPageId,
      title: "Product sync",
      url: `https://www.notion.so/${meetingPageId}`,
      lastEditedAt: this.providerVersion,
      inTrash: false
    };
  }

  private root(): NotionMeetingNotesBlock {
    return meetingNotesBlock({
      id: meetingNotesRootId,
      type: "meeting-notes",
      hasChildren: true,
      meetingNotes: {
        title: "Product sync",
        status: this.lifecycle,
        summaryBlockId,
        notesBlockId,
        transcriptBlockId,
        calendar: null,
        recording: null
      }
    });
  }
}

class ManualRecurringScheduler {
  private scheduled: (() => void) | null = null;

  readonly schedule: MeetingNotesSyncScheduler = (run) => {
    this.scheduled = run;
    return () => {
      this.scheduled = null;
    };
  };

  run(): void {
    this.scheduled?.();
  }
}

async function eventually(
  predicate: () => boolean | Promise<boolean>,
  message: string
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) {
      return;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(message);
}

function signedDelivery(overrides: Record<string, unknown> = {}) {
  const rawBody = Buffer.from(
    JSON.stringify({
      id: "eeeeeeee-ffff-0000-1111-222222222222",
      timestamp: "2026-08-11T10:02:00.000Z",
      workspace_id: notionWorkspaceId,
      subscription_id: subscriptionId,
      integration_id: integrationId,
      api_version: "2026-03-11",
      type: "page.content_updated",
      entity: { id: meetingPageId, type: "page" },
      ...overrides
    }),
    "utf8"
  );
  const signature = `sha256=${createHmac("sha256", verificationToken)
    .update(rawBody)
    .digest("hex")}`;

  return { rawBody, headers: { "x-notion-signature": signature } };
}

function createHost(
  refresher: HeldRefresher,
  ingestion: RecordingIngestion,
  sync: RecordingSync
): NotionMeetingNotesObservationHost {
  return createNotionMeetingNotesObservationHost({
    lumaWorkspace,
    notionSubscription: {
      notionWorkspaceId,
      canonicalMeetingsDataSourceId,
      verificationToken,
      subscriptionId,
      integrationId
    },
    refresher,
    ingestion,
    canonicalReconciliation: sync
  });
}

function postRawWebhook(input: {
  port: number;
  path: string;
  rawBody: Uint8Array;
  signature: string | string[];
  method?: string;
  contentLength?: number | false;
  contentType?: string;
  contentEncoding?: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const contentLength = input.contentLength ?? input.rawBody.byteLength;
    const headers: Record<string, string | string[]> = {
      "content-type": input.contentType ?? "application/json; charset=utf-8",
      "x-notion-signature": input.signature
    };

    if (contentLength !== false) {
      headers["content-length"] = String(contentLength);
    }

    if (input.contentEncoding) {
      headers["content-encoding"] = input.contentEncoding;
    }

    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: input.port,
        method: input.method ?? "POST",
        path: input.path,
        headers
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve(response.statusCode ?? 0);
        });
      }
    );
    request.once("error", reject);
    request.write(input.rawBody.subarray(0, 11));
    request.end(input.rawBody.subarray(11));
  });
}

function openIncompleteWebhookBody(input: {
  port: number;
  path: string;
  signature: string;
}): void {
  const request = httpRequest({
    host: "127.0.0.1",
    port: input.port,
    method: "POST",
    path: input.path,
    headers: {
      "content-type": "application/json",
      "content-length": "32",
      "x-notion-signature": input.signature
    }
  });
  // Shutdown intentionally destroys this incomplete unauthenticated body.
  request.on("error", () => undefined);
  request.write("{");
}

function postIncompleteUnsignedWebhook(input: {
  port: number;
  path: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket({ host: "127.0.0.1", port: input.port });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("unsigned partial request kept its connection open"));
    }, 500);

    socket.once("connect", () => {
      socket.write(
        [
          `POST ${input.path} HTTP/1.1`,
          "Host: 127.0.0.1",
          "Content-Type: application/json",
          "Content-Length: 32",
          "",
          "{"
        ].join("\r\n")
      );
    });
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
    });
    socket.once("end", () => {
      clearTimeout(timeout);
      resolve(response);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function postFullyReadInvalidSignatureWebhook(input: {
  port: number;
  path: string;
  rawBody: Uint8Array;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket({ host: "127.0.0.1", port: input.port });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("invalid signed request kept its connection open"));
    }, 500);

    socket.once("connect", () => {
      socket.write(
        [
          `POST ${input.path} HTTP/1.1`,
          "Host: 127.0.0.1",
          "Content-Type: application/json",
          `Content-Length: ${input.rawBody.byteLength}`,
          "X-Notion-Signature: sha256=0000000000000000000000000000000000000000000000000000000000000000",
          "",
          ""
        ].join("\r\n")
      );
      socket.write(input.rawBody);
    });
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
    });
    socket.once("end", () => {
      clearTimeout(timeout);
      resolve(response);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

describe("Notion Meeting Notes observation host", () => {
  it("requires a logical Luma workspace distinct from the Notion provider workspace", () => {
    const refresher = new HeldRefresher();
    const ingestion = new RecordingIngestion();
    const sync = new RecordingSync();

    expect(() =>
      createNotionMeetingNotesObservationHost({
        lumaWorkspace: { ...lumaWorkspace, workspaceId: notionWorkspaceId },
        notionSubscription: {
          notionWorkspaceId,
          canonicalMeetingsDataSourceId,
          verificationToken,
          subscriptionId,
          integrationId
        },
        refresher,
        ingestion,
        canonicalReconciliation: sync
      })
    ).toThrow("must be distinct from the Notion provider workspace");
    expect(sync.startCalls).toBe(0);
  });

  it("acknowledges a signed wake-up before its canonical current-state refresh begins", async () => {
    const refresher = new HeldRefresher();
    const ingestion = new RecordingIngestion();
    const sync = new RecordingSync();
    const host = createHost(refresher, ingestion, sync);

    host.start();
    expect(host.status()).toMatchObject({
      acceptingDeliveries: true,
      canonicalRecovery: { scheduled: true }
    });
    expect(host.receive(signedDelivery())).toEqual({ status: "accepted" });
    expect(refresher.pageIds).toEqual([]);

    await refresher.started.promise;
    expect(refresher.pageIds).toEqual([meetingPageId]);
    expect(ingestion.records).toEqual([]);

    refresher.release.resolve();
    await host.stop();

    expect(ingestion.records).toHaveLength(1);
    expect(sync.startCalls).toBe(1);
    expect(sync.stopCalls).toBe(1);
    expect(host.status()).toMatchObject({
      acceptingDeliveries: false,
      canonicalRecovery: { scheduled: false }
    });
  });

  it("exposes only content-free operational failure status", async () => {
    const secret = "synthetic-provider-secret";
    const host = createNotionMeetingNotesObservationHost({
      lumaWorkspace,
      notionSubscription: {
        notionWorkspaceId,
        canonicalMeetingsDataSourceId,
        verificationToken,
        subscriptionId,
        integrationId
      },
      refresher: new FailingRefresher(`${secret} on ${meetingPageId}`),
      ingestion: new RecordingIngestion(),
      canonicalReconciliation: new RecordingSync()
    });

    try {
      host.start();
      expect(host.receive(signedDelivery())).toEqual({ status: "accepted" });
      await eventually(
        () => !host.status().backgroundDrainActive,
        "failing wake-up drain did not settle"
      );

      const failure = host.status().runtime.lastFailure;
      expect(failure?.scope).toBe("page-refresh");
      expect(typeof failure?.at).toBe("string");
      const serialized = JSON.stringify(host.status());
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(meetingPageId);
      expect(serialized).not.toContain(verificationToken);
    } finally {
      await host.stop();
    }
  });

  it("preserves chunked raw bytes through the Notion-only HTTP adapter", async () => {
    const refresher = new HeldRefresher();
    const ingestion = new RecordingIngestion();
    const sync = new RecordingSync();
    const host = createHost(refresher, ingestion, sync);
    const server = createNotionWebhookHttpServer({
      observationHost: host,
      hostname: "127.0.0.1",
      port: 0
    });
    const rawBody = Buffer.from(
      ` {\n  "id": "eeeeeeee-ffff-0000-1111-222222222222",\n  "timestamp": "2026-08-11T10:02:00.000Z",\n  "workspace_id": "${notionWorkspaceId}",\n  "subscription_id": "${subscriptionId}",\n  "integration_id": "${integrationId}",\n  "api_version": "2026-03-11",\n  "type": "page.content_updated",\n  "entity": { "id": "${meetingPageId}", "type": "page" },\n  "data": { "untrusted": "Größe" }\n} `,
      "utf8"
    );
    const signature = `sha256=${createHmac("sha256", verificationToken)
      .update(rawBody)
      .digest("hex")}`;

    try {
      const address = await server.start();
      await expect(
        postRawWebhook({
          port: address.port,
          path: "/notion/webhook",
          rawBody,
          signature
        })
      ).resolves.toBe(200);
      await refresher.started.promise;
      expect(refresher.pageIds).toEqual([meetingPageId]);
      expect(ingestion.records).toEqual([]);

      refresher.release.resolve();
    } finally {
      refresher.release.resolve();
      await server.stop();
    }
  });

  it("rejects invalid or malformed HTTP material before it can refresh a Meeting Note", async () => {
    const refresher = new HeldRefresher();
    const ingestion = new RecordingIngestion();
    const sync = new RecordingSync();
    const host = createHost(refresher, ingestion, sync);
    const server = createNotionWebhookHttpServer({
      observationHost: host,
      hostname: "127.0.0.1",
      port: 0,
      maxBodyBytes: 512
    });
    const delivery = signedDelivery();

    try {
      const address = await server.start();
      await expect(
        postRawWebhook({
          port: address.port,
          path: "/notion/webhook",
          rawBody: delivery.rawBody,
          signature:
            "sha256=0000000000000000000000000000000000000000000000000000000000000000"
        })
      ).resolves.toBe(200);
      const ignoredDelivery = signedDelivery({
        workspace_id: "ffffffff-0000-1111-2222-333333333333"
      });
      await expect(
        postRawWebhook({
          port: address.port,
          path: "/notion/webhook",
          rawBody: ignoredDelivery.rawBody,
          signature: ignoredDelivery.headers["x-notion-signature"]
        })
      ).resolves.toBe(200);
      await expect(
        postRawWebhook({
          port: address.port,
          path: "/notion/webhook",
          rawBody: Buffer.alloc(513, 0),
          signature: `sha256=${createHmac("sha256", verificationToken)
            .update(Buffer.alloc(513, 0))
            .digest("hex")}`
        })
      ).resolves.toBe(413);
      await expect(
        postRawWebhook({
          port: address.port,
          path: "/notion/webhook",
          rawBody: Buffer.alloc(513, 0),
          signature:
            "sha256=0000000000000000000000000000000000000000000000000000000000000000",
          contentLength: false
        })
      ).resolves.toBe(413);
      await expect(
        postRawWebhook({
          port: address.port,
          path: "/notion/webhook",
          rawBody: delivery.rawBody,
          signature: [
            "sha256=0000000000000000000000000000000000000000000000000000000000000000",
            "sha256=0000000000000000000000000000000000000000000000000000000000000000"
          ]
        })
      ).resolves.toBe(204);
      await expect(
        postRawWebhook({
          port: address.port,
          path: "/notion/webhook?unexpected=query",
          rawBody: delivery.rawBody,
          signature:
            "sha256=0000000000000000000000000000000000000000000000000000000000000000"
        })
      ).resolves.toBe(404);
      await expect(
        postRawWebhook({
          port: address.port,
          path: "/notion/webhook",
          rawBody: delivery.rawBody,
          signature:
            "sha256=0000000000000000000000000000000000000000000000000000000000000000",
          method: "GET"
        })
      ).resolves.toBe(405);
      await expect(
        postRawWebhook({
          port: address.port,
          path: "/notion/webhook",
          rawBody: delivery.rawBody,
          signature:
            "sha256=0000000000000000000000000000000000000000000000000000000000000000",
          contentEncoding: "gzip"
        })
      ).resolves.toBe(415);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(refresher.pageIds).toEqual([]);
      expect(ingestion.records).toEqual([]);
    } finally {
      refresher.release.resolve();
      await server.stop();
    }
  });

  it("closes an unsigned partial request after its early rejection", async () => {
    const refresher = new HeldRefresher();
    const ingestion = new RecordingIngestion();
    const sync = new RecordingSync();
    const host = createHost(refresher, ingestion, sync);
    const server = createNotionWebhookHttpServer({
      observationHost: host,
      hostname: "127.0.0.1",
      port: 0,
      requestTimeoutMs: 1_000
    });

    try {
      const address = await server.start();
      const response = await postIncompleteUnsignedWebhook({
        port: address.port,
        path: "/notion/webhook"
      });
      expect(response).toContain("204");
      expect(response.toLowerCase()).not.toContain("content-length");
      expect(refresher.pageIds).toEqual([]);
      expect(ingestion.records).toEqual([]);
    } finally {
      refresher.release.resolve();
      await server.stop();
    }
  });

  it("acknowledges then closes a fully-read invalid signature", async () => {
    const refresher = new HeldRefresher();
    const ingestion = new RecordingIngestion();
    const sync = new RecordingSync();
    const host = createHost(refresher, ingestion, sync);
    const server = createNotionWebhookHttpServer({
      observationHost: host,
      hostname: "127.0.0.1",
      port: 0,
      requestTimeoutMs: 1_000
    });

    try {
      const address = await server.start();
      await expect(
        postFullyReadInvalidSignatureWebhook({
          port: address.port,
          path: "/notion/webhook",
          rawBody: signedDelivery().rawBody
        })
      ).resolves.toContain("200");
      expect(refresher.pageIds).toEqual([]);
      expect(ingestion.records).toEqual([]);
    } finally {
      refresher.release.resolve();
      await server.stop();
    }
  });

  it("quiesces admissions and aborts incomplete HTTP bodies during shutdown", async () => {
    const refresher = new HeldRefresher();
    const ingestion = new RecordingIngestion();
    const sync = new RecordingSync();
    const host = createHost(refresher, ingestion, sync);
    const server = createNotionWebhookHttpServer({
      observationHost: host,
      hostname: "127.0.0.1",
      port: 0,
      requestTimeoutMs: 1_000
    });

    const [first, second] = await Promise.all([server.start(), server.start()]);
    expect(second).toEqual(first);
    openIncompleteWebhookBody({
      port: first.port,
      path: "/notion/webhook",
      signature: "sha256=0000000000000000000000000000000000000000000000000000000000000000"
    });

    await expect(server.stop()).resolves.toBeUndefined();
    expect(host.status().acceptingDeliveries).toBe(false);
    expect(sync.stopCalls).toBe(1);
    expect(refresher.pageIds).toEqual([]);
  });

  it("uses wake-ups for latency and canonical reconciliation for completeness without execution", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const api = new MutableMeetingNotesApi();
    const source = createNotionMeetingNotesSource({
      meetingsDataSourceId: canonicalMeetingsDataSourceId,
      ledger,
      api,
      pageReader: api
    });
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel(),
      importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
        ledger
      })
    });
    const scheduler = new ManualRecurringScheduler();
    const sync = createMeetingNotesSync({
      workspace: lumaWorkspace,
      source,
      ingestion: createMeetingNotesIngestion({ meetingIntelligence }),
      scheduleRecurring: scheduler.schedule,
      logger: quietLogger
    });
    const host = createNotionMeetingNotesObservationHost({
      lumaWorkspace,
      notionSubscription: {
        notionWorkspaceId,
        canonicalMeetingsDataSourceId,
        verificationToken,
        subscriptionId,
        integrationId
      },
      refresher: source,
      ingestion: createMeetingNotesIngestion({ meetingIntelligence }),
      canonicalReconciliation: sync
    });
    const sourceIdentity = {
      providerId: "notion",
      sourceKind: "meeting-note" as const,
      sourceObjectId: meetingNotesRootId
    };

    try {
      host.start();
      await eventually(
        async () =>
          (
            await ledger.get({
              workspaceId: lumaWorkspace.workspaceId,
              source: sourceIdentity
            })
          )?.revision === 1,
        "initial canonical reconciliation did not observe the not-ready Meeting Note"
      );

      expect(host.receive(signedDelivery())).toEqual({ status: "accepted" });
      await eventually(
        () => !host.status().backgroundDrainActive,
        "not-ready wake-up did not finish"
      );

      const notReady = await ledger.get({
        workspaceId: lumaWorkspace.workspaceId,
        source: sourceIdentity
      });
      expect(notReady).toMatchObject({
        revision: 1,
        snapshot: { completeness: { state: "not-ready" } }
      });
      expect(api.markdownCalls).toEqual([]);

      const notReadyMeeting = await meetingIntelligence.query({
        workspaceId: lumaWorkspace.workspaceId,
        meetingId: `meeting:source:notion:${meetingNotesRootId}`,
        query: { type: "snapshot" }
      });
      expect(notReadyMeeting).toMatchObject({
        type: "snapshot",
        state: { importedActionItemCandidates: [] }
      });

      api.becomeReady("Jakob prüft LUM-29.");
      expect(
        host.receive(
          signedDelivery({
            id: "eeeeeeee-ffff-0000-1111-222222222223",
            timestamp: "2026-08-11T10:03:00.000Z"
          })
        )
      ).toEqual({ status: "accepted" });
      expect(
        host.receive(
          signedDelivery({
            id: "eeeeeeee-ffff-0000-1111-222222222224",
            timestamp: "2026-08-11T10:02:30.000Z"
          })
        )
      ).toEqual({ status: "accepted" });
      expect(
        host.receive(
          signedDelivery({
            id: "eeeeeeee-ffff-0000-1111-222222222223",
            timestamp: "2026-08-11T10:03:00.000Z"
          })
        )
      ).toEqual({ status: "accepted" });
      await eventually(
        async () =>
          (
            await ledger.get({
              workspaceId: lumaWorkspace.workspaceId,
              source: sourceIdentity
            })
          )?.revision === 2,
        "ready wake-up did not create exactly one ready source revision"
      );

      const readyMeeting = await meetingIntelligence.query({
        workspaceId: lumaWorkspace.workspaceId,
        meetingId: `meeting:source:notion:${meetingNotesRootId}`,
        query: { type: "snapshot" }
      });
      if (readyMeeting.type !== "snapshot") {
        throw new Error("expected a Meeting snapshot after the ready wake-up");
      }
      expect(readyMeeting.state.importedSources).toEqual(
        expect.arrayContaining([expect.objectContaining({ sourceRevision: 2 })])
      );
      expect(readyMeeting.state.importedActionItemCandidates).toEqual([
        expect.objectContaining({ originalText: "Jakob prüft LUM-29." })
      ]);

      api.correct("Jakob prüft LUM-29 mit dem aktuellen Meeting Note.");
      scheduler.run();
      await eventually(
        async () =>
          (
            await ledger.get({
              workspaceId: lumaWorkspace.workspaceId,
              source: sourceIdentity
            })
          )?.revision === 3,
        "scheduled canonical reconciliation did not recover the missed edit"
      );

      api.correct("Jakob prüft LUM-29 final.");
      expect(
        host.receive(
          signedDelivery({
            id: "eeeeeeee-ffff-0000-1111-222222222225",
            timestamp: "2026-08-11T10:04:00.000Z"
          })
        )
      ).toEqual({ status: "accepted" });
      await eventually(
        async () =>
          (
            await ledger.get({
              workspaceId: lumaWorkspace.workspaceId,
              source: sourceIdentity
            })
          )?.revision === 4,
        "later edited Meeting Note did not create one new source revision"
      );

      const revisedMeeting = await meetingIntelligence.query({
        workspaceId: lumaWorkspace.workspaceId,
        meetingId: `meeting:source:notion:${meetingNotesRootId}`,
        query: { type: "snapshot" }
      });
      if (revisedMeeting.type !== "snapshot") {
        throw new Error("expected a Meeting snapshot after the later edit");
      }
      expect(revisedMeeting.state.importedSources).toEqual(
        expect.arrayContaining([expect.objectContaining({ sourceRevision: 4 })])
      );
      expect(revisedMeeting.state.importedActionItemCandidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ originalText: "Jakob prüft LUM-29 final." })
        ])
      );
      await expect(
        database.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM observed_source_snapshots"
        )
      ).resolves.toMatchObject({ rows: [{ count: 4 }] });
      await expect(
        database.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM follow_up_executions"
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await host.stop();
      await database.close();
    }
  });
});
