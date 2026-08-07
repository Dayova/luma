import {
  APIErrorCode,
  Client,
  isFullBlock,
  isFullPage,
  isNotionClientError,
  type BlockObjectResponse,
  type PageObjectResponse,
  type PartialBlockObjectResponse
} from "@notionhq/client";
import type {
  MeetingNotesScan,
  MeetingNotesScanPartialReason,
  MeetingNotesSource
} from "./meeting-notes-source.js";
import type {
  CapturedMeetingNoteBlock,
  ObservedSourceLedger,
  RawMeetingNoteSection,
  RawMeetingNoteSnapshot,
  SourcePartialReason
} from "./observed-source-ledger.js";

const NOTION_MEETING_NOTES_API_VERSION = "2026-03-11";
const DEFAULT_PAGE_SIZE = 100;

export type NotionMeetingNotesPage = {
  id: string;
  title: string | null;
  url: string;
  lastEditedAt: string | null;
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

export type NotionMeetingNotesSourceConfig = {
  meetingsDataSourceId: string;
  ledger: ObservedSourceLedger;
  token?: string;
  providerId?: string;
  api?: NotionMeetingNotesApi;
  now?: () => Date;
};

export type CreateNotionMeetingNotesSourceFromEnvInput = {
  ledger: ObservedSourceLedger;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
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
  "source-not-found" | "source-restricted" | "transient";

export class NotionMeetingNotesReadError extends Error {
  readonly code: NotionMeetingNotesReadErrorCode;

  constructor(code: NotionMeetingNotesReadErrorCode, message: string) {
    super(message);
    this.name = "NotionMeetingNotesReadError";
    this.code = code;
  }
}

export function createNotionMeetingNotesSource(
  config: NotionMeetingNotesSourceConfig
): MeetingNotesSource {
  const api = config.api ?? createNotionSdkMeetingNotesApi(config);
  const providerId = config.providerId ?? "notion";
  const now = config.now ?? (() => new Date());

  return {
    async scan(input): Promise<MeetingNotesScan> {
      const page = await api.listDataSourcePages({
        dataSourceId: config.meetingsDataSourceId,
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
        let rootBlocks: NotionMeetingNotesBlock[];

        try {
          rootBlocks = await listAllBlockChildren(api, meetingPage.id);
        } catch (error) {
          partialReasons.push(pageReadFailureReason(meetingPage.id, error));
          continue;
        }

        const sourceBlocks = rootBlocks.filter(isMeetingNotesBlock);

        for (const sourceBlock of sourceBlocks) {
          let snapshot: RawMeetingNoteSnapshot;

          try {
            snapshot = await captureMeetingNote(api, meetingPage, sourceBlock);
          } catch (error) {
            partialReasons.push(
              meetingNoteReadFailureReason(meetingPage.id, sourceBlock.id, error)
            );
            continue;
          }

          records.push(
            await config.ledger.record({
              workspaceId: input.workspaceId,
              source: {
                providerId,
                sourceKind: "meeting-note",
                sourceObjectId: sourceBlock.id,
                parentObjectId: meetingPage.id,
                url: meetingPage.url
              },
              providerVersion: meetingPage.lastEditedAt,
              snapshot,
              observedAt: now().toISOString()
            })
          );
        }
      }

      return {
        records,
        nextCursor: page.nextCursor,
        completeness:
          partialReasons.length > 0 ||
          records.some((record) => record.snapshot.completeness.state !== "complete")
            ? "partial"
            : "complete",
        partialReasons
      };
    }
  };
}

export function createNotionMeetingNotesSourceFromEnv(
  input: CreateNotionMeetingNotesSourceFromEnvInput
): MeetingNotesSource {
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

  return new NotionSdkMeetingNotesApi(
    new Client({ auth: config.token, notionVersion: NOTION_MEETING_NOTES_API_VERSION })
  );
}

class NotionSdkMeetingNotesApi implements NotionMeetingNotesApi {
  constructor(private readonly client: Client) {}

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

    const pages = result.results.filter(isFullPage);
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

async function captureMeetingNote(
  api: NotionMeetingNotesApi,
  page: NotionMeetingNotesPage,
  sourceBlock: NotionMeetingNotesBlock
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

  const markdownRead = await readMarkdown(api, page.id);
  const markdown = markdownRead.markdown;
  const [summaryResult, actionItemsAndNotesResult, transcriptResult] = await Promise.all([
    readSection(api, details.summaryBlockId, "summary"),
    readSection(api, details.notesBlockId, "notes"),
    readSection(api, details.transcriptBlockId, "transcript")
  ]);
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
  api: NotionMeetingNotesApi,
  pageId: string
): Promise<{
  markdown: { content: string; truncated: boolean; unknownBlockIds: string[] };
  unreadable: boolean;
}> {
  try {
    return {
      markdown: await api.retrievePageMarkdown({ pageId, includeTranscript: true }),
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

async function readSection(
  api: NotionMeetingNotesApi,
  blockId: string | null,
  section: "summary" | "notes" | "transcript"
): Promise<{ section: RawMeetingNoteSection; reasons: SourcePartialReason[] }> {
  if (!blockId) {
    const reason = missingSectionReason(section);
    return { section: unavailableSection(null, [reason]), reasons: [reason] };
  }

  try {
    const blocks = await captureBlockTree(api, blockId);
    const unknown = findUnknownBlocks(blocks);

    const reasons =
      unknown.length > 0
        ? [unknownShapeReason(`Notion returned unknown ${section} block content`)]
        : [];

    return {
      section: {
        state: "available",
        sourceBlockId: blockId,
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
      blockId
    };
    return { section: unavailableSection(blockId, [reason]), reasons: [reason] };
  }
}

async function listAllBlockChildren(
  api: NotionMeetingNotesApi,
  blockId: string
): Promise<NotionMeetingNotesBlock[]> {
  const blocks: NotionMeetingNotesBlock[] = [];
  let cursor: string | undefined;

  do {
    const page = await api.listBlockChildren({ blockId, ...(cursor ? { cursor } : {}) });
    blocks.push(...page.blocks);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  return blocks;
}

async function captureBlockTree(
  api: NotionMeetingNotesApi,
  blockId: string
): Promise<CapturedMeetingNoteBlock[]> {
  const blocks = await listAllBlockChildren(api, blockId);
  return Promise.all(
    blocks.map(async (block) => ({
      id: block.id,
      type: block.type,
      text: block.text,
      checked: block.checked,
      children: block.hasChildren ? await captureBlockTree(api, block.id) : []
    }))
  );
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

function isMeetingNotesBlock(block: NotionMeetingNotesBlock): boolean {
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

function meetingNoteReadFailureReason(
  pageId: string,
  sourceObjectId: string,
  error: unknown
): MeetingNotesScanPartialReason {
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
  return !(error instanceof NotionMeetingNotesReadError) || error.code === "transient";
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
    lastEditedAt: page.last_edited_time
  };
}

export function normalizeNotionMeetingNotesBlock(
  block: BlockObjectResponse | PartialBlockObjectResponse
): NotionMeetingNotesBlock {
  if (!isFullBlock(block)) {
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
