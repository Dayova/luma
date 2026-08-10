import { createRequire } from "node:module";
import type {
  BlockObjectResponse,
  Client,
  PageObjectResponse,
  PartialBlockObjectResponse
} from "@notionhq/client";
import type * as NotionSdk from "@notionhq/client";
import type {
  MeetingNotesCompleteScan,
  MeetingNotesPageRefresh,
  MeetingNotesPageRefresher,
  MeetingNotesScan,
  MeetingNotesScanPartialReason,
  MeetingNotesSource
} from "./meeting-notes-source.js";
import {
  ObservedSourceExecutionFenceConflictError,
  type CapturedMeetingNoteBlock,
  type ObservedSourceHead,
  type ObservedSourceLedger,
  type ObservedSourceRevision,
  type RawMeetingNoteSection,
  type RawMeetingNoteSnapshot,
  type SourcePartialReason
} from "./observed-source-ledger.js";
import type { OperationalOutcomeMarkerVerifier } from "./operational-outcome-writer.js";
import {
  parseOperationalOutcomeSection,
  stripOperationalOutcomeSection
} from "./operational-outcome-markdown.js";
import { canonicalNotionObjectId } from "./notion-object-id.js";

const NOTION_MEETING_NOTES_API_VERSION = "2026-03-11";
const DEFAULT_PAGE_SIZE = 100;
// Notion child-page reads use `DEFAULT_PAGE_SIZE`; exceeding either bound is
// malformed provider material, never a reason to continue an unbounded scan.
const MAX_BLOCK_CHILD_PAGES = 100;
const MAX_CAPTURED_MEETING_NOTE_BLOCKS = 10_000;
const MAX_MEETING_NOTE_BLOCK_CHILD_READS = 1_000;
const MAX_MEETING_NOTE_BLOCK_TREE_DEPTH = 100;
const SCAN_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_SCAN_SESSIONS = 100;
const requireNotionSdk = createRequire(import.meta.url);
let cachedNotionSdk: NotionSdkModule | undefined;

type NotionSdkModule = Pick<
  typeof NotionSdk,
  "APIErrorCode" | "Client" | "isFullBlock" | "isFullPage" | "isNotionClientError"
>;

export type NotionMeetingNotesPage = {
  id: string;
  title: string | null;
  url: string;
  lastEditedAt: string | null;
  inTrash: boolean;
};

export type NotionMeetingNotesBlock = {
  id: string;
  type: string;
  text: string | null;
  checked: boolean | null;
  hasChildren: boolean;
  meetingNotes?: {
    title: string | null;
    status: string | null;
    summaryBlockId: string | null;
    notesBlockId: string | null;
    transcriptBlockId: string | null;
    calendar: {
      startAt: string;
      endAt: string;
      attendeeProviderUserIds: string[];
    } | null;
    recording: {
      startAt: string | null;
      endAt: string | null;
    } | null;
  };
};

export interface NotionMeetingNotesApi {
  listDataSourcePages(input: {
    dataSourceId: string;
    cursor?: string;
    limit: number;
  }): Promise<{
    pages: NotionMeetingNotesPage[];
    nextCursor: string | null;
    incomplete: boolean;
  }>;
  listBlockChildren(input: { blockId: string; cursor?: string }): Promise<{
    blocks: NotionMeetingNotesBlock[];
    nextCursor: string | null;
  }>;
  retrievePageMarkdown(input: { pageId: string; includeTranscript: boolean }): Promise<{
    content: string;
    truncated: boolean;
    unknownBlockIds: string[];
  }>;
}

/**
 * The narrow direct-page read needed after a signed wake-up. The normal scan
 * Adapter deliberately does not require it, so scan-only tests and adapters
 * retain their smaller capability surface.
 */
export interface NotionMeetingNotesPageReader {
  retrievePage(input: { pageId: string }): Promise<{
    page: NotionMeetingNotesPage;
    parentDataSourceId: string | null;
  }>;
}

/** A Notion source can scan canonically and refresh one proven member page. */
export interface NotionMeetingNotesSource
  extends MeetingNotesSource, MeetingNotesPageRefresher {}

/**
 * The narrow read surface shared by canonical scans and exact-page evidence
 * capture. It deliberately has no page enumeration or mutation capability.
 */
export type NotionMeetingNoteSnapshotReader = Pick<
  NotionMeetingNotesApi,
  "listBlockChildren" | "retrievePageMarkdown"
>;

export type NotionMeetingNoteSnapshotOwnership = {
  workspaceId: string;
  providerId: string;
  operationalOutcomeMarkerVerifier?: OperationalOutcomeMarkerVerifier;
};

type MeetingNoteCaptureBudget = {
  remainingBlocks: number;
  remainingBlockChildReads: number;
};

export type NotionMeetingNotesSourceConfig = {
  meetingsDataSourceId: string;
  ledger: ObservedSourceLedger;
  token?: string;
  providerId?: string;
  /**
   * Required to ignore a Luma outcome marker. Without a durable proof, a
   * checksum-valid section remains untrusted canonical source material.
   */
  operationalOutcomeMarkerVerifier?: OperationalOutcomeMarkerVerifier;
  api?: NotionMeetingNotesApi;
  pageReader?: NotionMeetingNotesPageReader;
  now?: () => Date;
};

export type CreateNotionMeetingNotesSourceFromEnvInput = {
  ledger: ObservedSourceLedger;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  operationalOutcomeMarkerVerifier?: OperationalOutcomeMarkerVerifier;
};

export class NotionMeetingNotesSourceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NotionMeetingNotesSourceError";
    this.code = code;
  }
}

export type NotionMeetingNotesReadErrorCode =
  | "source-not-found"
  | "source-restricted"
  | "transient"
  | "source-invalid"
  /** A Luma-owned writeback exists, but it cannot be proven safe to ignore. */
  | "unsafe-operational-outcome-markdown"
  | "unverified-operational-outcome-markdown"
  | "operational-outcome-marker-verification-unavailable";

export class NotionMeetingNotesReadError extends Error {
  readonly code: NotionMeetingNotesReadErrorCode;

  constructor(code: NotionMeetingNotesReadErrorCode, message: string) {
    super(message);
    this.name = "NotionMeetingNotesReadError";
    this.code = code;
  }
}

type NotionMeetingNotesScanSession = {
  workspaceId: string;
  initialHeads: ObservedSourceHead[];
  observedSourceObjectIds: Set<string>;
  fullyReadable: boolean;
  createdAtMs: number;
};

export function createNotionMeetingNotesSource(
  config: NotionMeetingNotesSourceConfig
): NotionMeetingNotesSource {
  const api = config.api ?? createNotionSdkMeetingNotesApi(config);
  const pageReader = config.pageReader ?? asNotionMeetingNotesPageReader(api);
  const meetingsDataSourceId =
    canonicalNotionObjectId(config.meetingsDataSourceId) ?? config.meetingsDataSourceId;
  const providerId = config.providerId ?? "notion";
  const now = config.now ?? (() => new Date());
  const scanSessionsByCursor = new Map<string, NotionMeetingNotesScanSession>();

  const scanSessionKey = (workspaceId: string, cursor: string): string =>
    JSON.stringify([workspaceId, cursor]);

  const evictExpiredScanSessions = (): void => {
    const expiresBeforeMs = now().getTime() - SCAN_SESSION_TTL_MS;

    for (const [key, session] of scanSessionsByCursor) {
      if (session.createdAtMs <= expiresBeforeMs) {
        scanSessionsByCursor.delete(key);
      }
    }
  };

  const evictOldestScanSession = (): void => {
    let oldestKey: string | null = null;
    let oldestCreatedAtMs = Number.POSITIVE_INFINITY;

    for (const [key, session] of scanSessionsByCursor) {
      if (session.createdAtMs < oldestCreatedAtMs) {
        oldestKey = key;
        oldestCreatedAtMs = session.createdAtMs;
      }
    }

    if (oldestKey) {
      // Discarding an abandoned cursor can only remove absence authority. A
      // later fresh scan will still reconcile from its own ledger snapshot.
      scanSessionsByCursor.delete(oldestKey);
    }
  };

  const beginScanSession = async (
    workspaceId: string
  ): Promise<NotionMeetingNotesScanSession> => {
    // A new first page abandons any incomplete prior cursor drain. That prior
    // scan can no longer authorize an absence conclusion. Other workspaces
    // have independent scans and must retain their own cursor state.
    for (const [key, session] of scanSessionsByCursor) {
      if (session.workspaceId === workspaceId) {
        scanSessionsByCursor.delete(key);
      }
    }

    return {
      workspaceId,
      initialHeads: await config.ledger.listCurrent({
        workspaceId,
        providerId,
        sourceKind: "meeting-note"
      }),
      observedSourceObjectIds: new Set(),
      fullyReadable: true,
      createdAtMs: now().getTime()
    };
  };

  const consumeScanSession = (
    workspaceId: string,
    cursor: string
  ): NotionMeetingNotesScanSession | null => {
    const key = scanSessionKey(workspaceId, cursor);
    const session = scanSessionsByCursor.get(key) ?? null;
    scanSessionsByCursor.delete(key);

    return session;
  };

  const completeScan = (
    session: NotionMeetingNotesScanSession
  ): MeetingNotesCompleteScan => {
    let consumed = false;

    return {
      async reconcileAbsent() {
        if (consumed) {
          throw new Error(
            "A completed Meeting Notes scan may reconcile absence only once"
          );
        }

        consumed = true;

        if (!session.fullyReadable) {
          throw new Error("An incomplete Meeting Notes scan cannot reconcile absence");
        }

        const tombstones: ObservedSourceRevision[] = [];
        const partialReasons: MeetingNotesScanPartialReason[] = [];

        for (const previous of session.initialHeads) {
          if (session.observedSourceObjectIds.has(previous.source.sourceObjectId)) {
            continue;
          }

          let tombstone: ObservedSourceRevision | null;

          try {
            tombstone = await config.ledger.recordTombstone({
              workspaceId: session.workspaceId,
              previous,
              observedAt: now().toISOString()
            });
          } catch (error) {
            if (error instanceof ObservedSourceExecutionFenceConflictError) {
              partialReasons.push(
                sourceExecutionFenceReason(
                  previous.source.parentObjectId,
                  previous.source.sourceObjectId
                )
              );
              continue;
            }

            throw error;
          }

          if (tombstone) {
            tombstones.push(tombstone);
          }
        }

        return { tombstones, partialReasons };
      }
    };
  };

  return {
    async scan(input): Promise<MeetingNotesScan> {
      evictExpiredScanSessions();
      const session = input.cursor
        ? consumeScanSession(input.workspaceId, input.cursor)
        : await beginScanSession(input.workspaceId);
      const page = await api.listDataSourcePages({
        dataSourceId: meetingsDataSourceId,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        limit: input.limit ?? DEFAULT_PAGE_SIZE
      });
      const records = [];
      const partialReasons: MeetingNotesScanPartialReason[] = [];

      if (page.incomplete) {
        partialReasons.push({
          code: "source-enumeration-incomplete",
          message: "Notion reported an incomplete canonical Meetings data source query",
          retryable: false
        });
      }

      if (page.nextCursor) {
        partialReasons.push({
          code: "pagination-pending",
          message: "More canonical Meetings data source pages remain to be scanned",
          retryable: false
        });
      }

      for (const meetingPage of page.pages) {
        const captured = await captureNotionMeetingPage({
          api,
          page: meetingPage,
          workspaceId: input.workspaceId,
          providerId,
          ledger: config.ledger,
          now,
          ...(config.operationalOutcomeMarkerVerifier
            ? {
                operationalOutcomeMarkerVerifier: config.operationalOutcomeMarkerVerifier
              }
            : {})
        });
        records.push(...captured.records);
        partialReasons.push(...captured.partialReasons);
      }

      for (const record of records) {
        if (record.snapshot.completeness.state === "complete") {
          continue;
        }

        partialReasons.push({
          code: "source-record-incomplete",
          message:
            "A Meeting Notes source root was not fully readable; source absence cannot be inferred.",
          sourceObjectId: record.source.sourceObjectId,
          retryable: true
        });
      }

      const completeness =
        partialReasons.length > 0 ||
        records.some((record) => record.snapshot.completeness.state !== "complete")
          ? "partial"
          : "complete";
      const scan: MeetingNotesScan = {
        records,
        nextCursor: page.nextCursor,
        completeness,
        partialReasons
      };

      if (!session) {
        return scan;
      }

      for (const record of records) {
        session.observedSourceObjectIds.add(record.source.sourceObjectId);
      }

      // Pagination is expected for an otherwise readable scan. It prevents
      // issuance of the capability until the final cursor page, but it must
      // not poison the whole session once that page is successfully drained.
      const hasUnreadableMaterial =
        partialReasons.some((reason) => reason.code !== "pagination-pending") ||
        records.some((record) => record.snapshot.completeness.state !== "complete");

      if (hasUnreadableMaterial) {
        session.fullyReadable = false;
      }

      if (page.nextCursor) {
        const cursorKey = scanSessionKey(input.workspaceId, page.nextCursor);
        const conflictingSession = scanSessionsByCursor.get(cursorKey);

        if (conflictingSession) {
          // Interleaved cursors cannot prove which source roots each caller
          // actually observed. Disable absence authority for both scans.
          session.fullyReadable = false;
          conflictingSession.fullyReadable = false;
        } else {
          while (scanSessionsByCursor.size >= MAX_PENDING_SCAN_SESSIONS) {
            evictOldestScanSession();
          }
          scanSessionsByCursor.set(cursorKey, session);
        }
      } else if (session.fullyReadable) {
        scan.completeScan = completeScan(session);
      }

      return scan;
    },
    async refreshPage(input): Promise<MeetingNotesPageRefresh> {
      if (!pageReader) {
        throw new NotionMeetingNotesSourceError(
          "notion-page-reader-missing",
          "A Notion page reader is required to refresh a signed Meeting Notes wake-up"
        );
      }

      const pageId = requiredCanonicalNotionPageId(input.pageId);
      let pageRead: Awaited<ReturnType<NotionMeetingNotesPageReader["retrievePage"]>>;
      let page: NotionMeetingNotesPage;

      try {
        pageRead = await pageReader.retrievePage({ pageId });
        page = validateNotionMeetingNotesPageRefresh(pageRead, pageId);
      } catch (error) {
        const ignored = ignoredNonRetryablePageRefresh(pageId, error);

        if (ignored) {
          return ignored;
        }

        throw error;
      }

      // A direct page request can never establish absence. A page outside the
      // configured canonical data source (or now in trash) is simply not a
      // candidate; only a completed canonical scan can tombstone a root.
      if (
        !isCanonicalMeetingsDataSourceMembership(
          pageRead.parentDataSourceId,
          meetingsDataSourceId
        ) ||
        page.inTrash
      ) {
        return {
          status: "ignored",
          records: [],
          completeness: "complete",
          partialReasons: []
        };
      }

      const captured = await captureNotionMeetingPage({
        api,
        page,
        workspaceId: input.workspaceId,
        providerId,
        ledger: config.ledger,
        now,
        ...(config.operationalOutcomeMarkerVerifier
          ? { operationalOutcomeMarkerVerifier: config.operationalOutcomeMarkerVerifier }
          : {})
      });
      const completeness =
        captured.partialReasons.length > 0 ||
        captured.records.some(
          (record) => record.snapshot.completeness.state !== "complete"
        )
          ? "partial"
          : "complete";

      return {
        status: captured.foundMeetingNotesRoot ? "refreshed" : "ignored",
        records: captured.records,
        completeness,
        partialReasons: captured.partialReasons
      };
    }
  };
}

function isCanonicalMeetingsDataSourceMembership(
  parentDataSourceId: string | null,
  canonicalMeetingsDataSourceId: string
): boolean {
  if (parentDataSourceId === null) {
    return false;
  }

  return (
    (canonicalNotionObjectId(parentDataSourceId) ?? parentDataSourceId) ===
    canonicalMeetingsDataSourceId
  );
}

type CaptureNotionMeetingPageInput = {
  api: NotionMeetingNotesApi;
  page: NotionMeetingNotesPage;
  workspaceId: string;
  providerId: string;
  ledger: ObservedSourceLedger;
  now: () => Date;
  operationalOutcomeMarkerVerifier?: OperationalOutcomeMarkerVerifier;
};

type CapturedNotionMeetingPage = {
  foundMeetingNotesRoot: boolean;
  records: ObservedSourceRevision[];
  partialReasons: MeetingNotesScanPartialReason[];
};

/**
 * The shared capture path for canonical scans and page wake-ups. It is the
 * only place this Adapter turns current Notion material into a ledger record;
 * wake-ups never get a parallel parser, hash, or source revision path.
 */
async function captureNotionMeetingPage(
  input: CaptureNotionMeetingPageInput
): Promise<CapturedNotionMeetingPage> {
  let page: NotionMeetingNotesPage;
  let rootBlocks: NotionMeetingNotesBlock[];

  try {
    page = {
      ...input.page,
      id: requiredCanonicalNotionObjectId(input.page.id, "Notion Meeting Notes page")
    };
    rootBlocks = await listAllNotionBlockChildren(input.api, page.id);
  } catch (error) {
    return {
      foundMeetingNotesRoot: false,
      records: [],
      partialReasons: [pageReadFailureReason(input.page.id, error)]
    };
  }

  const partialReasons: MeetingNotesScanPartialReason[] = [];

  if (
    rootBlocks.some((block) => block.type === "unknown" || block.type === "unsupported")
  ) {
    partialReasons.push({
      code: "unreadable-page",
      message:
        "Notion returned unreadable root block content; Meeting Notes root absence cannot be inferred",
      pageId: input.page.id,
      retryable: true
    });
  }

  const sourceBlocks = rootBlocks.filter(isNotionMeetingNotesRoot);
  const records: ObservedSourceRevision[] = [];

  for (const rawSourceBlock of sourceBlocks) {
    let snapshot: RawMeetingNoteSnapshot;
    let sourceBlock: NotionMeetingNotesBlock;

    try {
      sourceBlock = {
        ...rawSourceBlock,
        id: requiredCanonicalNotionObjectId(
          rawSourceBlock.id,
          "Notion Meeting Notes root block"
        )
      };
      snapshot = await captureNotionMeetingNoteSnapshot(input.api, page, sourceBlock, {
        workspaceId: input.workspaceId,
        providerId: input.providerId,
        ...(input.operationalOutcomeMarkerVerifier
          ? { operationalOutcomeMarkerVerifier: input.operationalOutcomeMarkerVerifier }
          : {})
      });
    } catch (error) {
      partialReasons.push(
        meetingNoteReadFailureReason(page.id, rawSourceBlock.id, error)
      );
      continue;
    }

    try {
      records.push(
        await input.ledger.record({
          workspaceId: input.workspaceId,
          source: {
            providerId: input.providerId,
            sourceKind: "meeting-note",
            sourceObjectId: sourceBlock.id,
            parentObjectId: page.id,
            url: page.url
          },
          providerVersion: page.lastEditedAt,
          snapshot,
          observedAt: input.now().toISOString()
        })
      );
    } catch (error) {
      if (error instanceof ObservedSourceExecutionFenceConflictError) {
        partialReasons.push(sourceExecutionFenceReason(page.id, sourceBlock.id));
        continue;
      }

      throw error;
    }
  }

  return {
    foundMeetingNotesRoot: sourceBlocks.length > 0,
    records,
    partialReasons
  };
}

export function createNotionMeetingNotesSourceFromEnv(
  input: CreateNotionMeetingNotesSourceFromEnvInput
): NotionMeetingNotesSource {
  const env = input.env ?? process.env;
  const config: NotionMeetingNotesSourceConfig = {
    ledger: input.ledger,
    token: requireEnv(env, "NOTION_API_TOKEN"),
    meetingsDataSourceId: requireEnv(env, "NOTION_MEETINGS_DATA_SOURCE_ID")
  };
  const providerId = nonBlank(env["LUMA_NOTION_PROVIDER_ID"]);

  if (providerId) {
    config.providerId = providerId;
  }

  if (input.now) {
    config.now = input.now;
  }

  if (input.operationalOutcomeMarkerVerifier) {
    config.operationalOutcomeMarkerVerifier = input.operationalOutcomeMarkerVerifier;
  }

  return createNotionMeetingNotesSource(config);
}

function createNotionSdkMeetingNotesApi(
  config: NotionMeetingNotesSourceConfig
): NotionMeetingNotesApi {
  if (!config.token) {
    throw new NotionMeetingNotesSourceError(
      "notion-token-missing",
      "NOTION_API_TOKEN is required for the Notion Meeting Notes source"
    );
  }

  const { Client } = notionSdk();
  return new NotionSdkMeetingNotesApi(
    new Client({ auth: config.token, notionVersion: NOTION_MEETING_NOTES_API_VERSION })
  );
}

function asNotionMeetingNotesPageReader(
  api: NotionMeetingNotesApi
): NotionMeetingNotesPageReader | null {
  return typeof (api as Partial<NotionMeetingNotesPageReader>).retrievePage === "function"
    ? (api as unknown as NotionMeetingNotesPageReader)
    : null;
}

function validateNotionMeetingNotesPageRefresh(
  value: unknown,
  expectedPageId: string
): NotionMeetingNotesPage {
  if (!isRecord(value) || !isRecord(value["page"])) {
    throw new NotionMeetingNotesReadError(
      "source-invalid",
      "Notion returned an invalid Meeting Notes wake-up page"
    );
  }

  const page = value["page"];
  const parentDataSourceId = value["parentDataSourceId"];

  const pageId = canonicalNotionObjectId(page["id"]);

  if (
    pageId !== expectedPageId ||
    (page["title"] !== null && typeof page["title"] !== "string") ||
    typeof page["url"] !== "string" ||
    page["url"].trim().length === 0 ||
    (page["lastEditedAt"] !== null && typeof page["lastEditedAt"] !== "string") ||
    typeof page["inTrash"] !== "boolean" ||
    !isNullableOpaqueIdentifier(parentDataSourceId)
  ) {
    throw new NotionMeetingNotesReadError(
      "source-invalid",
      "Notion returned an invalid Meeting Notes wake-up page"
    );
  }

  return {
    id: pageId,
    title: page["title"],
    url: page["url"],
    lastEditedAt: page["lastEditedAt"],
    inTrash: page["inTrash"]
  };
}

function requiredCanonicalNotionPageId(value: string): string {
  return requiredCanonicalNotionObjectId(value, "A Notion Meeting Notes wake-up page");
}

function requiredCanonicalNotionObjectId(value: string, label: string): string {
  const objectId = canonicalNotionObjectId(value);

  if (!objectId) {
    throw new NotionMeetingNotesReadError("source-invalid", `${label} ID must be a UUID`);
  }

  return objectId;
}

function ignoredNonRetryablePageRefresh(
  pageId: string,
  error: unknown
): MeetingNotesPageRefresh | null {
  if (!(error instanceof NotionMeetingNotesReadError) || isRetryableReadError(error)) {
    return null;
  }

  return {
    status: "ignored",
    records: [],
    completeness: "partial",
    partialReasons: [pageReadFailureReason(pageId, error)]
  };
}

class NotionSdkMeetingNotesApi
  implements NotionMeetingNotesApi, NotionMeetingNotesPageReader
{
  constructor(private readonly client: Client) {}

  async retrievePage(input: {
    pageId: string;
  }): Promise<{ page: NotionMeetingNotesPage; parentDataSourceId: string | null }> {
    const page = await readFromNotion(() =>
      this.client.pages.retrieve({ page_id: input.pageId })
    );

    if (!notionSdk().isFullPage(page)) {
      throw new NotionMeetingNotesReadError(
        "source-invalid",
        "Notion returned a partial page for a Meeting Notes wake-up"
      );
    }

    return {
      page: toMeetingNotesPage(page),
      parentDataSourceId:
        page.parent.type === "data_source_id" ? page.parent.data_source_id : null
    };
  }

  async listDataSourcePages(input: {
    dataSourceId: string;
    cursor?: string;
    limit: number;
  }): Promise<{
    pages: NotionMeetingNotesPage[];
    nextCursor: string | null;
    incomplete: boolean;
  }> {
    const result = await readFromNotion(() =>
      this.client.dataSources.query({
        data_source_id: input.dataSourceId,
        page_size: input.limit,
        result_type: "page",
        sorts: [{ timestamp: "created_time", direction: "ascending" }],
        ...(input.cursor ? { start_cursor: input.cursor } : {})
      })
    );

    const pages = result.results.filter(notionSdk().isFullPage);
    return {
      pages: pages.map(toMeetingNotesPage),
      nextCursor: result.next_cursor,
      incomplete:
        result.request_status?.type === "incomplete" ||
        pages.length !== result.results.length
    };
  }

  async listBlockChildren(input: {
    blockId: string;
    cursor?: string;
  }): Promise<{ blocks: NotionMeetingNotesBlock[]; nextCursor: string | null }> {
    const result = await readFromNotion(() =>
      this.client.blocks.children.list({
        block_id: input.blockId,
        page_size: DEFAULT_PAGE_SIZE,
        ...(input.cursor ? { start_cursor: input.cursor } : {})
      })
    );

    return {
      blocks: result.results.map(normalizeNotionMeetingNotesBlock),
      nextCursor: result.next_cursor
    };
  }

  async retrievePageMarkdown(input: {
    pageId: string;
    includeTranscript: boolean;
  }): Promise<{ content: string; truncated: boolean; unknownBlockIds: string[] }> {
    const result = await readFromNotion(() =>
      this.client.pages.retrieveMarkdown({
        page_id: input.pageId,
        include_transcript: input.includeTranscript
      })
    );

    return {
      content: result.markdown,
      truncated: result.truncated,
      unknownBlockIds: result.unknown_block_ids
    };
  }
}

export async function captureNotionMeetingNoteSnapshot(
  api: NotionMeetingNoteSnapshotReader,
  page: NotionMeetingNotesPage,
  sourceBlock: NotionMeetingNotesBlock,
  ownership: NotionMeetingNoteSnapshotOwnership
): Promise<RawMeetingNoteSnapshot> {
  const details = sourceBlock.meetingNotes;

  if (!details) {
    return failedSnapshot("Meeting Notes block did not contain Meeting Notes metadata");
  }

  const status = normalizeLifecycle(details.status);

  if (status !== "ready") {
    const reason =
      status === "unknown" ? unknownLifecycleReason() : notReadyReason(details.status);

    return {
      schemaVersion: 1,
      title: details.title ?? page.title,
      lifecycle: status,
      calendar: details.calendar,
      recording: details.recording,
      sections: {
        summary: unavailableSection(null, [reason]),
        actionItemsAndNotes: unavailableSection(null, [reason]),
        transcript: unavailableSection(null, [reason])
      },
      markdown: { content: "", truncated: false, unknownBlockIds: [] },
      completeness:
        status === "unknown"
          ? { state: "partial", reasons: [reason] }
          : { state: "not-ready", providerStatus: details.status }
    };
  }

  const pageId = requiredCanonicalNotionObjectId(page.id, "Notion Meeting Notes page");
  const meetingNotesRootId = requiredCanonicalNotionObjectId(
    sourceBlock.id,
    "Notion Meeting Notes root block"
  );

  // Every metadata pointer is an authority to read a provider block. Prove
  // that authority from the verified Meeting Notes root before following it;
  // a pointer-shaped UUID alone could otherwise name unrelated accessible
  // content outside this Meeting Note.
  const captureBudget: MeetingNoteCaptureBudget = {
    remainingBlocks: MAX_CAPTURED_MEETING_NOTE_BLOCKS,
    remainingBlockChildReads: MAX_MEETING_NOTE_BLOCK_CHILD_READS
  };
  const sectionPointers = await verifiedMeetingNotesSectionPointers(
    api,
    { ...sourceBlock, id: meetingNotesRootId },
    details,
    captureBudget
  );

  const markdownRead = await readMarkdown(api, pageId);
  const markdown = await canonicalMeetingNoteMarkdown(
    markdownRead.markdown,
    pageId,
    ownership
  );
  const summaryResult = await readSection(
    api,
    sectionPointers.summaryBlockId,
    "summary",
    captureBudget
  );
  const actionItemsAndNotesResult = await readSection(
    api,
    sectionPointers.notesBlockId,
    "notes",
    captureBudget
  );
  const transcriptResult = await readSection(
    api,
    sectionPointers.transcriptBlockId,
    "transcript",
    captureBudget
  );
  const reasons = [
    ...summaryResult.reasons,
    ...actionItemsAndNotesResult.reasons,
    ...transcriptResult.reasons
  ];

  if (markdown.truncated) {
    reasons.push({
      code: "truncated-markdown",
      message: "Notion reported that the Meeting Note Markdown is truncated"
    });
  }

  if (markdownRead.unreadable) {
    reasons.push({
      code: "unreadable-markdown",
      message: "Notion could not read the complete Meeting Note Markdown"
    });
  }

  if (markdown.unknownBlockIds.length > 0) {
    reasons.push({
      code: "unknown-blocks",
      message: "Notion reported unresolved blocks in the Meeting Note Markdown"
    });
  }

  return {
    schemaVersion: 1,
    title: details.title ?? page.title,
    lifecycle: "ready",
    calendar: details.calendar,
    recording: details.recording,
    sections: {
      summary: summaryResult.section,
      actionItemsAndNotes: actionItemsAndNotesResult.section,
      transcript: transcriptResult.section
    },
    markdown,
    completeness:
      reasons.length === 0 ? { state: "complete" } : { state: "partial", reasons }
  };
}

type VerifiedMeetingNotesSectionPointers = Pick<
  NonNullable<NotionMeetingNotesBlock["meetingNotes"]>,
  "summaryBlockId" | "notesBlockId" | "transcriptBlockId"
>;

async function verifiedMeetingNotesSectionPointers(
  api: Pick<NotionMeetingNotesApi, "listBlockChildren">,
  sourceBlock: NotionMeetingNotesBlock,
  details: NonNullable<NotionMeetingNotesBlock["meetingNotes"]>,
  budget: MeetingNoteCaptureBudget
): Promise<VerifiedMeetingNotesSectionPointers> {
  const pointers: VerifiedMeetingNotesSectionPointers = {
    summaryBlockId: canonicalMeetingNotesSectionPointer(details.summaryBlockId),
    notesBlockId: canonicalMeetingNotesSectionPointer(details.notesBlockId),
    transcriptBlockId: canonicalMeetingNotesSectionPointer(details.transcriptBlockId)
  };
  const nonNullPointers = Object.values(pointers).filter(
    (pointer): pointer is string => pointer !== null
  );

  if (nonNullPointers.length === 0) {
    return pointers;
  }

  const meetingNotesRootId = requiredCanonicalNotionObjectId(
    sourceBlock.id,
    "Notion Meeting Notes root block"
  );
  const directChildren = await listAllNotionBlockChildrenWithBudget(
    api,
    meetingNotesRootId,
    budget
  );
  const directChildIds = new Set(
    directChildren.flatMap((child) => {
      if (!isSafeMeetingNotesBlockChildRead(child)) {
        return [];
      }

      const childId = canonicalNotionObjectId(child.id);
      return childId ? [childId] : [];
    })
  );

  if (nonNullPointers.some((pointer) => !directChildIds.has(pointer))) {
    throw new NotionMeetingNotesReadError(
      "source-invalid",
      "Notion Meeting Notes section metadata did not reference direct root children"
    );
  }

  return pointers;
}

function isSafeMeetingNotesBlockChildRead(child: NotionMeetingNotesBlock): boolean {
  return ![
    "unknown",
    "unsupported",
    "child_page",
    "child_database",
    "synced_block",
    "link_to_page"
  ].includes(child.type);
}

function canonicalMeetingNotesSectionPointer(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const pointer = canonicalNotionObjectId(value);

  if (!pointer) {
    throw new NotionMeetingNotesReadError(
      "source-invalid",
      "Notion Meeting Notes section metadata must contain UUID block IDs"
    );
  }

  return pointer;
}

function failedSnapshot(message: string): RawMeetingNoteSnapshot {
  return {
    schemaVersion: 1,
    title: null,
    lifecycle: "failed",
    calendar: null,
    recording: null,
    sections: {
      summary: unavailableSection(null, [unknownShapeReason(message)]),
      actionItemsAndNotes: unavailableSection(null, [unknownShapeReason(message)]),
      transcript: unavailableSection(null, [unknownShapeReason(message)])
    },
    markdown: { content: "", truncated: false, unknownBlockIds: [] },
    completeness: { state: "failed", providerStatus: null }
  };
}

async function readMarkdown(
  api: Pick<NotionMeetingNotesApi, "retrievePageMarkdown">,
  pageId: string
): Promise<{
  markdown: { content: string; truncated: boolean; unknownBlockIds: string[] };
  unreadable: boolean;
}> {
  try {
    const markdown = await api.retrievePageMarkdown({ pageId, includeTranscript: true });

    if (!isNotionMeetingNoteMarkdown(markdown)) {
      throw new NotionMeetingNotesReadError(
        "source-invalid",
        "Notion returned invalid Meeting Note Markdown"
      );
    }

    return {
      markdown,
      unreadable: false
    };
  } catch (error) {
    if (!isUnavailableSourceError(error)) {
      throw error;
    }

    return {
      markdown: { content: "", truncated: false, unknownBlockIds: [] },
      unreadable: true
    };
  }
}

function isNotionMeetingNoteMarkdown(
  value: unknown
): value is { content: string; truncated: boolean; unknownBlockIds: string[] } {
  return (
    isRecord(value) &&
    typeof value["content"] === "string" &&
    typeof value["truncated"] === "boolean" &&
    Array.isArray(value["unknownBlockIds"]) &&
    value["unknownBlockIds"].every(isNonBlankOpaqueIdentifier)
  );
}

async function canonicalMeetingNoteMarkdown(
  markdown: { content: string; truncated: boolean; unknownBlockIds: string[] },
  pageExternalId: string,
  ownership: NotionMeetingNoteSnapshotOwnership
): Promise<{ content: string; truncated: boolean; unknownBlockIds: string[] }> {
  const parsed = parseOperationalOutcomeSection(markdown.content);

  if (parsed.status === "invalid") {
    // A malformed, duplicated, or externally edited ownership marker means
    // we cannot distinguish canonical source text from Luma's writeback. Do
    // not persist a synthetic revision or grant source-absence authority.
    throw new NotionMeetingNotesReadError(
      "unsafe-operational-outcome-markdown",
      `Luma Operational Outcome Markdown cannot be safely excluded from source ingestion: ${parsed.message}`
    );
  }

  if (parsed.status === "valid") {
    const verifier = ownership.operationalOutcomeMarkerVerifier;

    if (!verifier) {
      throw new NotionMeetingNotesReadError(
        "unverified-operational-outcome-markdown",
        "Luma Operational Outcome Markdown cannot be safely excluded without a durable ownership verifier"
      );
    }

    let isOwned: boolean;

    try {
      isOwned = await verifier.isOwned({
        workspaceId: ownership.workspaceId,
        providerId: ownership.providerId,
        pageExternalId,
        payloadDigest: parsed.payloadDigest,
        contentDigest: parsed.contentDigest,
        operationDigest: parsed.operationDigest
      });
    } catch {
      throw new NotionMeetingNotesReadError(
        "operational-outcome-marker-verification-unavailable",
        "Luma could not verify Operational Outcome Markdown ownership"
      );
    }

    if (!isOwned) {
      throw new NotionMeetingNotesReadError(
        "unverified-operational-outcome-markdown",
        "Luma Operational Outcome Markdown does not match a durable successful settlement"
      );
    }
  }

  const stripped = stripOperationalOutcomeSection(markdown.content);

  if (stripped.status === "invalid") {
    // The parser above and the shared stripping helper must agree. If they
    // ever do not, retain the original source rather than guessing ownership.
    throw new NotionMeetingNotesReadError(
      "unsafe-operational-outcome-markdown",
      `Luma Operational Outcome Markdown cannot be safely excluded from source ingestion: ${stripped.message}`
    );
  }

  return { ...markdown, content: stripped.markdown };
}

async function readSection(
  api: Pick<NotionMeetingNotesApi, "listBlockChildren">,
  blockId: string | null,
  section: "summary" | "notes" | "transcript",
  budget: MeetingNoteCaptureBudget
): Promise<{ section: RawMeetingNoteSection; reasons: SourcePartialReason[] }> {
  if (!blockId) {
    const reason = missingSectionReason(section);
    return { section: unavailableSection(null, [reason]), reasons: [reason] };
  }

  const sectionBlockId = requiredCanonicalNotionObjectId(
    blockId,
    `Notion Meeting Notes ${section} section block`
  );

  try {
    const blocks = await captureBlockTree(api, sectionBlockId, budget);
    const unknown = findUnknownBlocks(blocks);

    const reasons =
      unknown.length > 0
        ? [unknownShapeReason(`Notion returned unknown ${section} block content`)]
        : [];

    return {
      section: {
        state: "available",
        sourceBlockId: sectionBlockId,
        text: flattenCapturedBlocks(blocks),
        blocks
      },
      reasons
    };
  } catch (error) {
    if (!isUnavailableSourceError(error)) {
      throw error;
    }

    const reason: SourcePartialReason = {
      code: section === "transcript" ? "transcript-unavailable" : "unreadable-section",
      message: `Notion could not read the Meeting Note ${section} section`,
      blockId: sectionBlockId
    };
    return { section: unavailableSection(blockId, [reason]), reasons: [reason] };
  }
}

export async function listAllNotionBlockChildren(
  api: Pick<NotionMeetingNotesApi, "listBlockChildren">,
  blockId: string
): Promise<NotionMeetingNotesBlock[]> {
  return listAllNotionBlockChildrenWithBudget(api, blockId);
}

async function listAllNotionBlockChildrenWithBudget(
  api: Pick<NotionMeetingNotesApi, "listBlockChildren">,
  blockId: string,
  budget?: MeetingNoteCaptureBudget
): Promise<NotionMeetingNotesBlock[]> {
  const blocks: NotionMeetingNotesBlock[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  for (let pageCount = 0; pageCount < MAX_BLOCK_CHILD_PAGES; pageCount += 1) {
    consumeBlockChildRead(budget);
    const rawPage = await api.listBlockChildren({
      blockId,
      ...(cursor === undefined ? {} : { cursor })
    });
    const page = validateNotionBlockChildrenPage(rawPage);
    blocks.push(...page.blocks);

    if (page.nextCursor === null) {
      return blocks;
    }

    if (seenCursors.has(page.nextCursor)) {
      throw new NotionMeetingNotesReadError(
        "source-invalid",
        "Notion repeated a block-children pagination cursor"
      );
    }

    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  throw new NotionMeetingNotesReadError(
    "source-invalid",
    "Notion exceeded the bounded block-children pagination limit"
  );
}

function consumeBlockChildRead(budget: MeetingNoteCaptureBudget | undefined): void {
  if (!budget) {
    return;
  }

  if (budget.remainingBlockChildReads < 1) {
    throw new NotionMeetingNotesReadError(
      "source-invalid",
      "Notion exceeded the bounded Meeting Note block-read limit"
    );
  }

  budget.remainingBlockChildReads -= 1;
}

function validateNotionBlockChildrenPage(value: unknown): {
  blocks: NotionMeetingNotesBlock[];
  nextCursor: string | null;
} {
  if (!isRecord(value) || !Array.isArray(value["blocks"]) || !("nextCursor" in value)) {
    throw new NotionMeetingNotesReadError(
      "source-invalid",
      "Notion returned an invalid block-children page"
    );
  }

  const nextCursor = value["nextCursor"];

  if (nextCursor !== null && !isNonBlankOpaqueIdentifier(nextCursor)) {
    throw new NotionMeetingNotesReadError(
      "source-invalid",
      "Notion returned an invalid block-children pagination cursor"
    );
  }

  if (
    value["blocks"].length > DEFAULT_PAGE_SIZE ||
    !value["blocks"].every(isNotionMeetingNotesBlockShape)
  ) {
    throw new NotionMeetingNotesReadError(
      "source-invalid",
      "Notion returned an invalid Meeting Note block"
    );
  }

  return {
    blocks: value["blocks"],
    nextCursor
  };
}

function isNotionMeetingNotesBlockShape(
  value: unknown
): value is NotionMeetingNotesBlock {
  if (
    !isRecord(value) ||
    !isNonBlankOpaqueIdentifier(value["id"]) ||
    !isNonBlankOpaqueIdentifier(value["type"]) ||
    (value["text"] !== null && typeof value["text"] !== "string") ||
    (value["checked"] !== null && typeof value["checked"] !== "boolean") ||
    typeof value["hasChildren"] !== "boolean"
  ) {
    return false;
  }

  if (!("meetingNotes" in value) || value["meetingNotes"] === undefined) {
    return true;
  }

  const meetingNotes = value["meetingNotes"];

  return (
    isRecord(meetingNotes) &&
    (meetingNotes["title"] === null || typeof meetingNotes["title"] === "string") &&
    (meetingNotes["status"] === null || typeof meetingNotes["status"] === "string") &&
    isNullableOpaqueIdentifier(meetingNotes["summaryBlockId"]) &&
    isNullableOpaqueIdentifier(meetingNotes["notesBlockId"]) &&
    isNullableOpaqueIdentifier(meetingNotes["transcriptBlockId"]) &&
    isNullableCalendar(meetingNotes["calendar"]) &&
    isNullableRecording(meetingNotes["recording"])
  );
}

function isNullableOpaqueIdentifier(value: unknown): boolean {
  return value === null || isNonBlankOpaqueIdentifier(value);
}

function isNullableCalendar(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value["startAt"] === "string" &&
      typeof value["endAt"] === "string" &&
      Array.isArray(value["attendeeProviderUserIds"]) &&
      value["attendeeProviderUserIds"].every((attendee) => typeof attendee === "string"))
  );
}

function isNullableRecording(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      (value["startAt"] === null || typeof value["startAt"] === "string") &&
      (value["endAt"] === null || typeof value["endAt"] === "string"))
  );
}

function isNonBlankOpaqueIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !/\s/u.test(value)
  );
}

async function captureBlockTree(
  api: Pick<NotionMeetingNotesApi, "listBlockChildren">,
  blockId: string,
  budget: MeetingNoteCaptureBudget,
  ancestors = new Set<string>()
): Promise<CapturedMeetingNoteBlock[]> {
  const canonicalBlockId = requiredCanonicalNotionObjectId(
    blockId,
    "Notion Meeting Notes block"
  );

  if (ancestors.has(canonicalBlockId)) {
    throw new NotionMeetingNotesReadError(
      "source-invalid",
      "Notion returned a cyclic Meeting Note block tree"
    );
  }

  if (ancestors.size >= MAX_MEETING_NOTE_BLOCK_TREE_DEPTH) {
    throw new NotionMeetingNotesReadError(
      "source-invalid",
      "Notion exceeded the bounded Meeting Note block tree depth"
    );
  }

  if (budget.remainingBlocks < 1) {
    throw new NotionMeetingNotesReadError(
      "source-invalid",
      "Notion exceeded the bounded Meeting Note block capture limit"
    );
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(canonicalBlockId);
  const blocks = await listAllNotionBlockChildrenWithBudget(
    api,
    canonicalBlockId,
    budget
  );

  if (blocks.length > budget.remainingBlocks) {
    throw new NotionMeetingNotesReadError(
      "source-invalid",
      "Notion exceeded the bounded Meeting Note block capture limit"
    );
  }

  budget.remainingBlocks -= blocks.length;
  const captured: CapturedMeetingNoteBlock[] = [];

  for (const block of blocks) {
    if (block.hasChildren && !isSafeMeetingNotesBlockChildRead(block)) {
      throw new NotionMeetingNotesReadError(
        "source-invalid",
        "Notion Meeting Notes contained a linked or unsupported nested block"
      );
    }

    const childBlockId = block.hasChildren
      ? requiredCanonicalNotionObjectId(block.id, "Notion Meeting Notes child block")
      : block.id;

    captured.push({
      id: childBlockId,
      type: block.type,
      text: block.text,
      checked: block.checked,
      children: block.hasChildren
        ? await captureBlockTree(api, childBlockId, budget, nextAncestors)
        : []
    });
  }

  return captured;
}

function flattenCapturedBlocks(blocks: CapturedMeetingNoteBlock[]): string {
  return blocks
    .flatMap((block) => [block.text, flattenCapturedBlocks(block.children)])
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

function findUnknownBlocks(
  blocks: CapturedMeetingNoteBlock[]
): CapturedMeetingNoteBlock[] {
  return blocks.flatMap((block) => [
    ...(block.type === "unknown" || block.type === "unsupported" ? [block] : []),
    ...findUnknownBlocks(block.children)
  ]);
}

export function isNotionMeetingNotesRoot(block: NotionMeetingNotesBlock): boolean {
  return block.type === "meeting-notes" || block.type === "transcription";
}

function unavailableSection(
  sourceBlockId: string | null,
  reasons: SourcePartialReason[]
): RawMeetingNoteSection {
  return { state: "unavailable", sourceBlockId, reasons };
}

function pageReadFailureReason(
  pageId: string,
  error: unknown
): MeetingNotesScanPartialReason {
  return {
    code: "unreadable-page",
    message: "Notion could not read a page from the canonical Meetings data source",
    pageId,
    retryable: isRetryableReadError(error)
  };
}

function sourceExecutionFenceReason(
  pageId: string | null,
  sourceObjectId: string
): MeetingNotesScanPartialReason {
  return {
    code: "source-execution-fenced",
    message:
      "Luma is completing an approved source-bound execution for this Meeting Notes root; retry after its canonical receipt is recorded.",
    ...(pageId ? { pageId } : {}),
    sourceObjectId,
    retryable: true
  };
}

function meetingNoteReadFailureReason(
  pageId: string,
  sourceObjectId: string,
  error: unknown
): MeetingNotesScanPartialReason {
  if (
    error instanceof NotionMeetingNotesReadError &&
    error.code === "unsafe-operational-outcome-markdown"
  ) {
    return {
      code: "unreadable-meeting-note",
      message:
        "Luma Operational Outcome Markdown is malformed, duplicated, or edited; the Meeting Note was skipped to prevent a synthetic source revision",
      pageId,
      sourceObjectId,
      retryable: false
    };
  }

  if (
    error instanceof NotionMeetingNotesReadError &&
    error.code === "unverified-operational-outcome-markdown"
  ) {
    return {
      code: "unreadable-meeting-note",
      message:
        "Luma Operational Outcome Markdown could not be proven against a durable successful settlement; the Meeting Note was skipped to preserve canonical source evidence",
      pageId,
      sourceObjectId,
      retryable: false
    };
  }

  if (
    error instanceof NotionMeetingNotesReadError &&
    error.code === "operational-outcome-marker-verification-unavailable"
  ) {
    return {
      code: "unreadable-meeting-note",
      message:
        "Luma could not verify Operational Outcome Markdown ownership; the Meeting Note was skipped until the verification dependency recovers",
      pageId,
      sourceObjectId,
      retryable: true
    };
  }

  return {
    code: "unreadable-meeting-note",
    message:
      "Notion could not read a Meeting Note without risking a synthetic source revision",
    pageId,
    sourceObjectId,
    retryable: isRetryableReadError(error)
  };
}

function isUnavailableSourceError(error: unknown): error is NotionMeetingNotesReadError {
  return (
    error instanceof NotionMeetingNotesReadError &&
    (error.code === "source-not-found" || error.code === "source-restricted")
  );
}

function isRetryableReadError(error: unknown): boolean {
  return (
    !(error instanceof NotionMeetingNotesReadError) ||
    error.code === "transient" ||
    error.code === "operational-outcome-marker-verification-unavailable"
  );
}

function normalizeLifecycle(status: string | null): RawMeetingNoteSnapshot["lifecycle"] {
  if (status === "notes_ready") {
    return "ready";
  }

  if (status) {
    return "not-ready";
  }

  return "unknown";
}

function notReadyReason(status: string | null): SourcePartialReason {
  return {
    code: "meeting-notes-not-ready",
    message: `Notion Meeting Notes are not ready${status ? ` (${status})` : ""}`
  };
}

function unknownLifecycleReason(): SourcePartialReason {
  return {
    code: "unknown-provider-shape",
    message: "Notion Meeting Notes did not expose a lifecycle status"
  };
}

function missingSectionReason(
  section: "summary" | "notes" | "transcript"
): SourcePartialReason {
  return {
    code: section === "transcript" ? "transcript-unavailable" : "missing-section",
    message: `Notion Meeting Notes do not expose a ${section} block`
  };
}

function unknownShapeReason(message: string): SourcePartialReason {
  return { code: "unknown-provider-shape", message };
}

function toMeetingNotesPage(page: PageObjectResponse): NotionMeetingNotesPage {
  return {
    id: page.id,
    title: readTitle(page),
    url: page.url,
    lastEditedAt: page.last_edited_time,
    inTrash: page.in_trash
  };
}

export function normalizeNotionMeetingNotesBlock(
  block: BlockObjectResponse | PartialBlockObjectResponse
): NotionMeetingNotesBlock {
  if (!notionSdk().isFullBlock(block)) {
    return {
      id: block.id,
      type: "unknown",
      text: null,
      checked: null,
      hasChildren: false
    };
  }

  if (block.type === "meeting_notes") {
    return toCapturedMeetingNotesBlock(block, "meeting-notes", block.meeting_notes);
  }

  if (block.type === "transcription") {
    return toCapturedMeetingNotesBlock(block, "transcription", block.transcription);
  }

  return {
    id: block.id,
    type: block.type,
    text: richTextForBlock(block),
    checked: block.type === "to_do" ? block.to_do.checked : null,
    hasChildren: block.has_children
  };
}

function toCapturedMeetingNotesBlock(
  block: BlockObjectResponse,
  type: "meeting-notes" | "transcription",
  metadata: {
    title?: unknown;
    status?: string;
    children?: {
      summary_block_id?: string;
      notes_block_id?: string;
      transcript_block_id?: string;
    };
    calendar_event?: {
      start_time: string;
      end_time: string;
      attendees?: string[];
    };
    recording?: {
      start_time?: string;
      end_time?: string;
    };
  }
): NotionMeetingNotesBlock {
  return {
    id: block.id,
    type,
    text: null,
    checked: null,
    hasChildren: block.has_children,
    meetingNotes: {
      title: richTextToText(metadata.title),
      status: metadata.status ?? null,
      summaryBlockId: metadata.children?.summary_block_id ?? null,
      notesBlockId: metadata.children?.notes_block_id ?? null,
      transcriptBlockId: metadata.children?.transcript_block_id ?? null,
      calendar: metadata.calendar_event
        ? {
            startAt: metadata.calendar_event.start_time,
            endAt: metadata.calendar_event.end_time,
            attendeeProviderUserIds: metadata.calendar_event.attendees ?? []
          }
        : null,
      recording: metadata.recording
        ? {
            startAt: metadata.recording.start_time ?? null,
            endAt: metadata.recording.end_time ?? null
          }
        : null
    }
  };
}

function readTitle(page: PageObjectResponse): string | null {
  const title = Object.values(page.properties).find(
    (property) => property.type === "title"
  );
  return title && title.type === "title" ? richTextToText(title.title) : null;
}

function richTextForBlock(block: BlockObjectResponse): string | null {
  const record = block as unknown;

  if (!isRecord(record)) {
    return null;
  }

  const content = record[block.type];
  return isRecord(content) ? richTextToText(content["rich_text"]) : null;
}

function richTextToText(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const text = value
    .map((item) =>
      isRecord(item) && typeof item["plain_text"] === "string" ? item["plain_text"] : ""
    )
    .join("");
  return text.length > 0 ? text : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = nonBlank(env[key]);

  if (!value) {
    throw new NotionMeetingNotesSourceError(
      "notion-config-incomplete",
      `${key} is required for the Notion Meeting Notes source`
    );
  }

  return value;
}

function nonBlank(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

async function readFromNotion<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw toNotionMeetingNotesReadError(error);
  }
}

function toNotionMeetingNotesReadError(error: unknown): NotionMeetingNotesReadError {
  if (error instanceof NotionMeetingNotesReadError) {
    return error;
  }

  const { APIErrorCode, isNotionClientError } = notionSdk();

  if (isNotionClientError(error)) {
    switch (error.code) {
      case APIErrorCode.ObjectNotFound:
        return new NotionMeetingNotesReadError("source-not-found", error.message);
      case APIErrorCode.RestrictedResource:
        return new NotionMeetingNotesReadError("source-restricted", error.message);
      default:
        return new NotionMeetingNotesReadError("transient", error.message);
    }
  }

  return new NotionMeetingNotesReadError(
    "transient",
    error instanceof Error ? error.message : "Notion read failed"
  );
}

/** Provider SDK loading is deferred until the production Notion adapter runs. */
function notionSdk(): NotionSdkModule {
  cachedNotionSdk ??= requireNotionSdk("@notionhq/client") as NotionSdkModule;
  return cachedNotionSdk;
}
