import { createRequire } from "node:module";
import type { BlockObjectResponse, Client, PageObjectResponse } from "@notionhq/client";
import type * as NotionSdk from "@notionhq/client";
import type {
  NotionObjectScopedMeetingNoteEvidenceReader,
  NotionObjectScopedMeetingNoteEvidenceSession
} from "./notion-object-scoped-meeting-note-evidence-source.js";
import {
  NOTION_MEETING_NOTES_API_VERSION,
  normalizeNotionMeetingNotesBlock,
  NotionMeetingNotesReadError,
  type NotionMeetingNotesBlock,
  type NotionMeetingNotesPage
} from "./notion-meeting-notes-source.js";
import { canonicalNotionObjectId } from "./notion-object-id.js";

const DEFAULT_BLOCK_CHILD_PAGE_SIZE = 100;
const MAX_BLOCK_CHILD_PAGES_PER_PARENT = 100;
const MAX_BLOCK_CHILD_PAGES_PER_SESSION = 500;
const NOTION_PAGE_ID_PATTERN =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/iu;
const requireNotionSdk = createRequire(import.meta.url);
let cachedNotionSdk: NotionSdkModule | undefined;

type NotionSdkModule = Pick<
  typeof NotionSdk,
  "APIErrorCode" | "Client" | "isFullBlock" | "isFullPage" | "isNotionClientError"
>;

/**
 * Production construction accepts only a separately configured native
 * read-only credential and one exact Notion page UUID. It deliberately has no
 * `NOTION_API_TOKEN` fallback, client, fetch, base URL, data-source, search,
 * or mutation configuration surface.
 */
export type NotionObjectScopedMeetingNoteEvidenceReaderConfig = {
  pageId: string;
  readOnlyApiToken: string;
  token?: never;
  api?: never;
  client?: never;
  baseUrl?: never;
  fetch?: never;
  dataSourceId?: never;
  meetingsDataSourceId?: never;
};

type ReaderTransportInitialization = {
  auth: string;
  notionVersion: typeof NOTION_MEETING_NOTES_API_VERSION;
  retry: false;
};

type RawExactPageTransport = {
  retrievePage(input: { pageId: string }): Promise<unknown>;
  retrievePageMarkdown(input: {
    pageId: string;
    includeTranscript: true;
  }): Promise<unknown>;
  listBlockChildren(input: { blockId: string; cursor?: string }): Promise<unknown>;
};

/**
 * Deterministic transport seam for tests only. It is intentionally absent
 * from Luma's package entrypoint; production construction never accepts an
 * injected client or provider API.
 */
export type NotionObjectScopedMeetingNoteEvidenceTransportForTest = {
  create(input: ReaderTransportInitialization): RawExactPageTransport;
};

export type NotionObjectScopedMeetingNoteEvidenceReaderTestConfig = {
  pageId: string;
  readOnlyApiToken: string;
  transport: NotionObjectScopedMeetingNoteEvidenceTransportForTest;
};

export class NotionObjectScopedMeetingNoteEvidenceReaderError extends Error {
  constructor(
    readonly code:
      | "notion-object-scoped-reader-config-invalid"
      | "notion-object-scoped-reader-page-forbidden"
      | "notion-object-scoped-reader-page-unverified"
      | "notion-object-scoped-reader-block-forbidden"
      | "notion-object-scoped-reader-cursor-forbidden"
      | "notion-object-scoped-reader-capture-in-progress"
      | "notion-object-scoped-reader-session-expired"
      | "notion-object-scoped-reader-request-invalid"
      | "notion-object-scoped-reader-budget-exhausted",
    message: string
  ) {
    super(message);
    this.name = "NotionObjectScopedMeetingNoteEvidenceReaderError";
  }
}

/**
 * Creates the production Notion reader for exactly one Meeting Note page.
 * Constructing it loads the provider SDK, but importing this module or the
 * dormant native-review composition does not. The returned object exposes
 * only LUM-27's exact-page reader capability.
 */
export function createNotionObjectScopedMeetingNoteEvidenceReader(
  config: NotionObjectScopedMeetingNoteEvidenceReaderConfig
): NotionObjectScopedMeetingNoteEvidenceReader {
  const bound = validateConfig(config, ["pageId", "readOnlyApiToken"]);

  return createBoundReader(bound, createSdkTransport(bound));
}

/**
 * Explicit configuration helper for the eventual isolated proof only. It is
 * not server wiring or activation, and intentionally reads neither
 * `NOTION_API_TOKEN` nor any broad Notion source configuration.
 */
export function createNotionObjectScopedMeetingNoteEvidenceReaderFromEnv(
  env: NodeJS.ProcessEnv = process.env
): NotionObjectScopedMeetingNoteEvidenceReader {
  return createNotionObjectScopedMeetingNoteEvidenceReader({
    pageId: requireNativeReadOnlyEnv(env, "LUMA_NATIVE_NOTION_PAGE_ID"),
    readOnlyApiToken: requireNativeReadOnlyEnv(
      env,
      "LUMA_NATIVE_NOTION_READONLY_API_TOKEN"
    )
  });
}

/** Creates the same owned reader from a finite deterministic transport. */
export function createNotionObjectScopedMeetingNoteEvidenceReaderForTest(
  config: NotionObjectScopedMeetingNoteEvidenceReaderTestConfig
): NotionObjectScopedMeetingNoteEvidenceReaderForTest {
  const bound = validateConfig(config, ["pageId", "readOnlyApiToken", "transport"]);

  if (!isTransportForTest(config.transport)) {
    throw configError("A finite exact-page Notion test transport is required");
  }

  return createBoundReaderForTest(
    bound,
    config.transport.create(transportInitialization(bound))
  );
}

/**
 * Test-only raw exact-page operations. This deterministic seam is deliberately
 * absent from Luma's package entrypoint; production construction returns only
 * the callback-scoped `capture` Interface.
 */
export type NotionObjectScopedMeetingNoteEvidenceReaderForTest =
  NotionObjectScopedMeetingNoteEvidenceReader &
    NotionObjectScopedMeetingNoteEvidenceSession;

/**
 * Brands no provider client: it only packages the three finite read
 * operations for deterministic tests. This function is deliberately not
 * exported from `src/index.ts`.
 */
export function createNotionObjectScopedMeetingNoteEvidenceTransportForTest(
  create: (input: ReaderTransportInitialization) => RawExactPageTransport
): NotionObjectScopedMeetingNoteEvidenceTransportForTest {
  if (typeof create !== "function") {
    throw configError("A finite exact-page Notion test transport is required");
  }

  return Object.freeze({ create });
}

type BoundReaderConfig = {
  pageId: string;
  readOnlyApiToken: string;
};

type SessionLease = {
  active: boolean;
  operationInProgress: boolean;
};

type CapabilityState = {
  exactPageVerified: boolean;
  allowedBlockIds: Set<string>;
  allowedCursorsByBlockId: Map<string, Set<string>>;
  reservedCursorsByBlockId: Map<string, Set<string>>;
  blockReadCounts: Map<string, number>;
  totalBlockReads: number;
  rootCandidates: OwnedMeetingNotesRoot[];
  meetingNotesRoot: {
    id: string;
    sectionPointerIds: Set<string>;
    verifiedSectionPointerIds: Set<string>;
  } | null;
  rootScanInProgress: boolean;
};

/**
 * The capability state retains a separately owned, deeply immutable copy of
 * the provider facts that can mint section authority. Public callback results
 * are intentionally mutable data values, never capability state.
 */
type OwnedMeetingNotesRoot = {
  readonly id: string;
  readonly meetingNotes: {
    readonly title: string | null;
    readonly status: string | null;
    readonly summaryBlockId: string | null;
    readonly notesBlockId: string | null;
    readonly transcriptBlockId: string | null;
    readonly calendar: {
      readonly startAt: string;
      readonly endAt: string;
      readonly attendeeProviderUserIds: readonly string[];
    } | null;
    readonly recording: {
      readonly startAt: string | null;
      readonly endAt: string | null;
    } | null;
  };
};

function createBoundReader(
  config: BoundReaderConfig,
  transport: RawExactPageTransport
): NotionObjectScopedMeetingNoteEvidenceReader {
  return Object.freeze({
    async capture<T>(
      operation: (reader: NotionObjectScopedMeetingNoteEvidenceSession) => Promise<T>
    ): Promise<T> {
      if (typeof operation !== "function") {
        throw readerError(
          "notion-object-scoped-reader-request-invalid",
          "Exact-page capture requires a callback"
        );
      }

      const lease: SessionLease = { active: true, operationInProgress: false };
      const session = createReaderSession(config, transport, lease);

      try {
        return await operation(session);
      } finally {
        lease.active = false;
      }
    }
  });
}

function createBoundReaderForTest(
  config: BoundReaderConfig,
  transport: RawExactPageTransport
): NotionObjectScopedMeetingNoteEvidenceReaderForTest {
  const reader = createBoundReader(config, transport);
  const testLease: SessionLease = { active: true, operationInProgress: false };
  const testSession = createReaderSession(config, transport, testLease);
  const testReader: NotionObjectScopedMeetingNoteEvidenceReaderForTest = {
    capture: <T>(
      operation: (session: NotionObjectScopedMeetingNoteEvidenceSession) => Promise<T>
    ): Promise<T> => reader.capture(operation),
    retrievePage: (input: { pageId: string }) => testSession.retrievePage(input),
    retrievePageMarkdown: (input: { pageId: string; includeTranscript: boolean }) =>
      testSession.retrievePageMarkdown(input),
    listBlockChildren: (input: { blockId: string; cursor?: string }) =>
      testSession.listBlockChildren(input)
  };

  return Object.freeze(testReader);
}

function createReaderSession(
  config: BoundReaderConfig,
  transport: RawExactPageTransport,
  lease: SessionLease
): NotionObjectScopedMeetingNoteEvidenceSession {
  const state: CapabilityState = {
    exactPageVerified: false,
    allowedBlockIds: new Set(),
    allowedCursorsByBlockId: new Map(),
    reservedCursorsByBlockId: new Map(),
    blockReadCounts: new Map(),
    totalBlockReads: 0,
    rootCandidates: [],
    meetingNotesRoot: null,
    rootScanInProgress: false
  };

  const resetForVerifiedPage = (): void => {
    state.exactPageVerified = true;
    state.allowedBlockIds.clear();
    state.allowedBlockIds.add(config.pageId);
    state.allowedCursorsByBlockId.clear();
    state.reservedCursorsByBlockId.clear();
    state.blockReadCounts.clear();
    state.rootCandidates = [];
    state.meetingNotesRoot = null;
    state.rootScanInProgress = false;
  };

  const resetForPageAttempt = (): void => {
    state.exactPageVerified = false;
    state.allowedBlockIds.clear();
    state.allowedCursorsByBlockId.clear();
    state.reservedCursorsByBlockId.clear();
    state.blockReadCounts.clear();
    state.rootCandidates = [];
    state.meetingNotesRoot = null;
    state.rootScanInProgress = false;
  };

  const reader: NotionObjectScopedMeetingNoteEvidenceSession = {
    async retrievePage(input) {
      return runSessionOperation(lease, async () => {
        requireConfiguredPage(input, config.pageId);
        resetForPageAttempt();

        let rawPage: unknown;

        try {
          rawPage = await transport.retrievePage({ pageId: config.pageId });
        } catch (error) {
          throw toSafeReadError(error);
        }

        requireActiveSession(lease);

        try {
          const page = parseExactPage(rawPage, config.pageId);
          resetForVerifiedPage();
          return page;
        } catch (error) {
          throw toSafeReadError(error);
        }
      });
    },

    async retrievePageMarkdown(input) {
      return runSessionOperation(lease, async () => {
        requireConfiguredPage(input, config.pageId);

        if (!state.exactPageVerified) {
          throw readerError(
            "notion-object-scoped-reader-page-unverified",
            "The configured Meeting Note page must be verified before Markdown can be read"
          );
        }

        if (input.includeTranscript !== true) {
          throw readerError(
            "notion-object-scoped-reader-request-invalid",
            "Exact-page Markdown reads require the complete transcript"
          );
        }

        let rawMarkdown: unknown;

        try {
          rawMarkdown = await transport.retrievePageMarkdown({
            pageId: config.pageId,
            includeTranscript: true
          });
        } catch (error) {
          throw toSafeReadError(error);
        }

        requireActiveSession(lease);

        try {
          return parseExactPageMarkdown(rawMarkdown, config.pageId);
        } catch (error) {
          throw toSafeReadError(error);
        }
      });
    },

    async listBlockChildren(input) {
      return runSessionOperation(lease, async () => {
        if (!state.exactPageVerified) {
          throw readerError(
            "notion-object-scoped-reader-page-unverified",
            "The configured Meeting Note page must be verified before blocks can be read"
          );
        }

        const blockId = requireAllowedBlock(input, state);
        const cursor = requireRequestedCursor(input);

        if (blockId === config.pageId && cursor === undefined) {
          // A fresh direct-page list starts a fresh provider-derived root tree;
          // no pointer or descendant from an earlier read remains authoritative.
          state.rootCandidates = [];
          state.rootScanInProgress = true;
          clearDescendantsOfConfiguredPage(config.pageId, state);
        }

        if (
          blockId === config.pageId &&
          cursor !== undefined &&
          !state.rootScanInProgress
        ) {
          throw readerError(
            "notion-object-scoped-reader-cursor-forbidden",
            "The configured Meeting Note root cursor is not active"
          );
        }

        requireAvailableCursor(blockId, cursor, state);
        consumeBlockReadBudget(blockId, state);
        reserveAllowedCursor(blockId, cursor, state);

        let rawPage: unknown;

        try {
          rawPage = await transport.listBlockChildren({
            blockId,
            ...(cursor === undefined ? {} : { cursor })
          });
        } catch (error) {
          releaseReservedCursor(blockId, cursor, state);
          throw toSafeReadError(error);
        }

        requireActiveSession(lease);

        try {
          const page = parseBlockChildrenPage(rawPage, {
            configuredPageId: config.pageId,
            expectedParentId: blockId
          });

          consumeReservedCursor(blockId, cursor, state);

          mintProviderDerivedCapabilities({
            configuredPageId: config.pageId,
            parentBlockId: blockId,
            page,
            state
          });

          return {
            blocks: page.blocks.map((item) => item.block),
            nextCursor: page.nextCursor
          };
        } catch (error) {
          releaseReservedCursor(blockId, cursor, state);
          throw toSafeReadError(error);
        }
      });
    }
  };

  return Object.freeze(reader);
}

function requireActiveSession(lease: SessionLease): void {
  if (!lease.active) {
    throw readerError(
      "notion-object-scoped-reader-session-expired",
      "The exact-page reader session is no longer active"
    );
  }
}

async function runSessionOperation<T>(
  lease: SessionLease,
  operation: () => Promise<T>
): Promise<T> {
  requireActiveSession(lease);

  if (lease.operationInProgress) {
    throw readerError(
      "notion-object-scoped-reader-capture-in-progress",
      "An exact-page reader session permits one operation at a time"
    );
  }

  lease.operationInProgress = true;

  try {
    return await operation();
  } finally {
    lease.operationInProgress = false;
  }
}

function clearDescendantsOfConfiguredPage(pageId: string, state: CapabilityState): void {
  state.allowedBlockIds.clear();
  state.allowedBlockIds.add(pageId);
  state.allowedCursorsByBlockId.clear();
  state.reservedCursorsByBlockId.clear();
  state.blockReadCounts.clear();
  state.meetingNotesRoot = null;
}

function mintProviderDerivedCapabilities(input: {
  configuredPageId: string;
  parentBlockId: string;
  page: ParsedBlockChildrenPage;
  state: CapabilityState;
}): void {
  const { configuredPageId, parentBlockId, page, state } = input;

  if (parentBlockId === configuredPageId) {
    for (const item of page.blocks) {
      if (item.block.type === "meeting-notes" || item.block.type === "transcription") {
        const root = ownMeetingNotesRoot(item.block);

        if (root) {
          state.rootCandidates.push(root);
        }
      }
    }

    if (page.nextCursor === null) {
      state.rootScanInProgress = false;
      mintVerifiedMeetingNotesRoot(configuredPageId, state);
    }
  } else if (parentBlockId === state.meetingNotesRoot?.id) {
    mintVerifiedMeetingNotesSectionPointers(parentBlockId, page, state);
  } else {
    for (const item of page.blocks) {
      if (mayTraverseReturnedBlock(item.raw, item.block)) {
        state.allowedBlockIds.add(item.block.id);
      }
    }
  }

  if (page.nextCursor !== null) {
    let cursors = state.allowedCursorsByBlockId.get(parentBlockId);

    if (!cursors) {
      cursors = new Set();
      state.allowedCursorsByBlockId.set(parentBlockId, cursors);
    }

    cursors.add(page.nextCursor);
  }
}

function mintVerifiedMeetingNotesRoot(
  configuredPageId: string,
  state: CapabilityState
): void {
  if (state.rootCandidates.length !== 1) {
    return;
  }

  const root = state.rootCandidates[0];

  if (!root || !isNotionObjectId(root.id)) {
    return;
  }

  const pointers = [
    root.meetingNotes.summaryBlockId,
    root.meetingNotes.notesBlockId,
    root.meetingNotes.transcriptBlockId
  ];

  if (!pointers.every((pointer) => pointer === null || isNotionObjectId(pointer))) {
    return;
  }

  const sectionPointerIds = new Set(
    pointers.filter((pointer): pointer is string => pointer !== null)
  );

  if (root.id !== configuredPageId) {
    // A raw parent check has established that this root is a direct child of
    // the configured page. Its own children must still verify the provider's
    // section pointers before any pointer can become a capability.
    state.allowedBlockIds.add(root.id);
    state.meetingNotesRoot = {
      id: root.id,
      sectionPointerIds,
      verifiedSectionPointerIds: new Set()
    };
  }
}

function ownMeetingNotesRoot(
  block: NotionMeetingNotesBlock
): OwnedMeetingNotesRoot | null {
  const details = block.meetingNotes;

  if (!details) {
    return null;
  }

  const calendar: OwnedMeetingNotesRoot["meetingNotes"]["calendar"] =
    details.calendar === null
      ? null
      : Object.freeze({
          startAt: details.calendar.startAt,
          endAt: details.calendar.endAt,
          attendeeProviderUserIds: Object.freeze([
            ...details.calendar.attendeeProviderUserIds
          ])
        });
  const recording: OwnedMeetingNotesRoot["meetingNotes"]["recording"] =
    details.recording === null
      ? null
      : Object.freeze({
          startAt: details.recording.startAt,
          endAt: details.recording.endAt
        });

  return Object.freeze({
    id: block.id,
    meetingNotes: Object.freeze({
      title: details.title,
      status: details.status,
      summaryBlockId: details.summaryBlockId,
      notesBlockId: details.notesBlockId,
      transcriptBlockId: details.transcriptBlockId,
      calendar,
      recording
    })
  });
}

function mintVerifiedMeetingNotesSectionPointers(
  rootId: string,
  page: ParsedBlockChildrenPage,
  state: CapabilityState
): void {
  const root = state.meetingNotesRoot;

  if (!root || root.id !== rootId) {
    return;
  }

  for (const item of page.blocks) {
    if (
      root.sectionPointerIds.has(item.block.id) &&
      mayReadProviderDerivedSectionPointer(item.raw, item.block)
    ) {
      root.verifiedSectionPointerIds.add(item.block.id);
    }
  }

  if (
    page.nextCursor === null &&
    root.verifiedSectionPointerIds.size === root.sectionPointerIds.size
  ) {
    for (const pointer of root.verifiedSectionPointerIds) {
      state.allowedBlockIds.add(pointer);
    }
  }
}

function mayReadProviderDerivedSectionPointer(
  raw: Record<string, unknown>,
  block: NotionMeetingNotesBlock
): boolean {
  return (
    !isUnsafeMeetingNotesChildType(block.type) &&
    !isUnsafeMeetingNotesChildType(raw["type"])
  );
}

function mayTraverseReturnedBlock(
  raw: Record<string, unknown>,
  block: NotionMeetingNotesBlock
): boolean {
  if (!block.hasChildren || isUnsafeMeetingNotesChildType(block.type)) {
    return false;
  }

  // Child pages/databases and synced content can cross to a provider object
  // outside the verified page tree. LUM-27 will mark such source material
  // incomplete rather than letting a reader follow it.
  return !isUnsafeMeetingNotesChildType(raw["type"]);
}

function isUnsafeMeetingNotesChildType(value: unknown): boolean {
  return [
    "unknown",
    "unsupported",
    "child_page",
    "child_database",
    "synced_block",
    "link_to_page"
  ].includes(value as string);
}

function requireAllowedBlock(input: unknown, state: CapabilityState): string {
  const blockId = isRecord(input) ? canonicalNotionObjectId(input["blockId"]) : null;

  if (!blockId) {
    throw readerError(
      "notion-object-scoped-reader-block-forbidden",
      "The requested Meeting Note block is outside the provider-derived capability tree"
    );
  }

  if (!state.allowedBlockIds.has(blockId)) {
    throw readerError(
      "notion-object-scoped-reader-block-forbidden",
      "The requested Meeting Note block is outside the provider-derived capability tree"
    );
  }

  return blockId;
}

function requireRequestedCursor(input: unknown): string | undefined {
  if (!isRecord(input) || !("cursor" in input) || input["cursor"] === undefined) {
    return undefined;
  }

  const cursor = input["cursor"];

  if (!isOpaqueIdentifier(cursor)) {
    throw readerError(
      "notion-object-scoped-reader-cursor-forbidden",
      "The requested Meeting Note cursor is outside the provider-derived capability tree"
    );
  }

  return cursor;
}

function reserveAllowedCursor(
  blockId: string,
  cursor: string | undefined,
  state: CapabilityState
): void {
  if (cursor === undefined) {
    return;
  }

  requireAvailableCursor(blockId, cursor, state);

  const reservedCursors = state.reservedCursorsByBlockId.get(blockId);

  if (reservedCursors) {
    reservedCursors.add(cursor);
  } else {
    state.reservedCursorsByBlockId.set(blockId, new Set([cursor]));
  }
}

function requireAvailableCursor(
  blockId: string,
  cursor: string | undefined,
  state: CapabilityState
): void {
  if (cursor === undefined) {
    return;
  }

  const cursors = state.allowedCursorsByBlockId.get(blockId);
  const reservedCursors = state.reservedCursorsByBlockId.get(blockId);

  if (!cursors || !cursors.has(cursor) || reservedCursors?.has(cursor)) {
    throw readerError(
      "notion-object-scoped-reader-cursor-forbidden",
      "The requested Meeting Note cursor is outside the provider-derived capability tree"
    );
  }
}

function consumeReservedCursor(
  blockId: string,
  cursor: string | undefined,
  state: CapabilityState
): void {
  if (cursor === undefined) {
    return;
  }

  const cursors = state.allowedCursorsByBlockId.get(blockId);
  const reservedCursors = state.reservedCursorsByBlockId.get(blockId);

  if (!cursors?.delete(cursor) || !reservedCursors?.delete(cursor)) {
    throw readerError(
      "notion-object-scoped-reader-cursor-forbidden",
      "The requested Meeting Note cursor is outside the provider-derived capability tree"
    );
  }

  if (reservedCursors.size === 0) {
    state.reservedCursorsByBlockId.delete(blockId);
  }
}

function releaseReservedCursor(
  blockId: string,
  cursor: string | undefined,
  state: CapabilityState
): void {
  if (cursor === undefined) {
    return;
  }

  const reservedCursors = state.reservedCursorsByBlockId.get(blockId);

  if (!reservedCursors) {
    return;
  }

  reservedCursors.delete(cursor);

  if (reservedCursors.size === 0) {
    state.reservedCursorsByBlockId.delete(blockId);
  }
}

function consumeBlockReadBudget(blockId: string, state: CapabilityState): void {
  const previous = state.blockReadCounts.get(blockId) ?? 0;

  if (
    previous >= MAX_BLOCK_CHILD_PAGES_PER_PARENT ||
    state.totalBlockReads >= MAX_BLOCK_CHILD_PAGES_PER_SESSION
  ) {
    throw readerError(
      "notion-object-scoped-reader-budget-exhausted",
      "The configured Meeting Note block exceeds the exact-page read budget"
    );
  }

  state.blockReadCounts.set(blockId, previous + 1);
  state.totalBlockReads += 1;
}

type ParsedBlockChildrenPage = {
  blocks: Array<{ raw: Record<string, unknown>; block: NotionMeetingNotesBlock }>;
  nextCursor: string | null;
};

function parseBlockChildrenPage(
  value: unknown,
  input: { configuredPageId: string; expectedParentId: string }
): ParsedBlockChildrenPage {
  if (
    !isRecord(value) ||
    value["object"] !== "list" ||
    value["type"] !== "block" ||
    !Array.isArray(value["results"]) ||
    typeof value["has_more"] !== "boolean" ||
    !("next_cursor" in value)
  ) {
    throw invalidProviderMaterial();
  }

  const nextCursor = value["next_cursor"];

  if (nextCursor !== null && !isOpaqueIdentifier(nextCursor)) {
    throw invalidProviderMaterial();
  }

  if ((nextCursor === null) !== (value["has_more"] === false)) {
    throw invalidProviderMaterial();
  }

  if (value["results"].length > DEFAULT_BLOCK_CHILD_PAGE_SIZE) {
    throw invalidProviderMaterial();
  }

  const seenBlockIds = new Set<string>();
  const blocks = value["results"].map((rawValue) => {
    const raw = requireFullBlockWithExpectedParent(rawValue, input);
    const normalized = normalizeNotionMeetingNotesBlock(raw as BlockObjectResponse);

    if (!isValidNormalizedBlock(normalized)) {
      throw invalidProviderMaterial();
    }

    const block = canonicalizedProviderBlock(normalized);

    if (seenBlockIds.has(block.id)) {
      throw invalidProviderMaterial();
    }

    seenBlockIds.add(block.id);
    return { raw, block };
  });

  return { blocks, nextCursor };
}

function requireFullBlockWithExpectedParent(
  value: unknown,
  input: { configuredPageId: string; expectedParentId: string }
): Record<string, unknown> {
  if (!isRecord(value) || !notionSdk().isFullBlock(value as BlockObjectResponse)) {
    throw invalidProviderMaterial();
  }

  if (
    !isNotionObjectId(value["id"]) ||
    typeof value["has_children"] !== "boolean" ||
    value["in_trash"] !== false ||
    ((value["type"] === "meeting_notes" || value["type"] === "transcription") &&
      !isRecord(value[value["type"]])) ||
    !hasExpectedRawParent(value, input)
  ) {
    throw invalidProviderMaterial();
  }

  return value;
}

function hasExpectedRawParent(
  raw: Record<string, unknown>,
  input: { configuredPageId: string; expectedParentId: string }
): boolean {
  const parent = raw["parent"];

  if (!isRecord(parent)) {
    return false;
  }

  return input.expectedParentId === input.configuredPageId
    ? parent["type"] === "page_id" &&
        hasSameNotionObjectId(parent["page_id"], input.configuredPageId)
    : parent["type"] === "block_id" &&
        hasSameNotionObjectId(parent["block_id"], input.expectedParentId);
}

function isValidNormalizedBlock(value: NotionMeetingNotesBlock): boolean {
  if (
    !isNotionObjectId(value.id) ||
    typeof value.type !== "string" ||
    typeof value.hasChildren !== "boolean" ||
    (value.text !== null && typeof value.text !== "string") ||
    (value.checked !== null && typeof value.checked !== "boolean")
  ) {
    return false;
  }

  if (value.type !== "meeting-notes" && value.type !== "transcription") {
    return value.meetingNotes === undefined;
  }

  const metadata = value.meetingNotes;

  return (
    metadata !== undefined &&
    nullableString(metadata.title) &&
    nullableString(metadata.status) &&
    nullableNotionObjectId(metadata.summaryBlockId) &&
    nullableNotionObjectId(metadata.notesBlockId) &&
    nullableNotionObjectId(metadata.transcriptBlockId) &&
    nullableCalendar(metadata.calendar) &&
    nullableRecording(metadata.recording)
  );
}

function canonicalizedProviderBlock(
  block: NotionMeetingNotesBlock
): NotionMeetingNotesBlock {
  const id = canonicalNotionObjectId(block.id);

  if (!id) {
    throw invalidProviderMaterial();
  }

  const details = block.meetingNotes;

  return {
    id,
    type: block.type,
    text: block.text,
    checked: block.checked,
    hasChildren: block.hasChildren,
    ...(details
      ? {
          meetingNotes: {
            title: details.title,
            status: details.status,
            summaryBlockId: canonicalNullableNotionObjectId(details.summaryBlockId),
            notesBlockId: canonicalNullableNotionObjectId(details.notesBlockId),
            transcriptBlockId: canonicalNullableNotionObjectId(details.transcriptBlockId),
            calendar:
              details.calendar === null
                ? null
                : {
                    startAt: details.calendar.startAt,
                    endAt: details.calendar.endAt,
                    attendeeProviderUserIds: [...details.calendar.attendeeProviderUserIds]
                  },
            recording:
              details.recording === null
                ? null
                : {
                    startAt: details.recording.startAt,
                    endAt: details.recording.endAt
                  }
          }
        }
      : {})
  };
}

function canonicalNullableNotionObjectId(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const canonical = canonicalNotionObjectId(value);

  if (!canonical) {
    throw invalidProviderMaterial();
  }

  return canonical;
}

function nullableCalendar(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value["startAt"] === "string" &&
      typeof value["endAt"] === "string" &&
      Array.isArray(value["attendeeProviderUserIds"]) &&
      value["attendeeProviderUserIds"].every((attendee) => typeof attendee === "string"))
  );
}

function nullableRecording(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      (value["startAt"] === null || typeof value["startAt"] === "string") &&
      (value["endAt"] === null || typeof value["endAt"] === "string"))
  );
}

function parseExactPage(value: unknown, pageId: string): NotionMeetingNotesPage {
  if (!isRecord(value) || !notionSdk().isFullPage(value as PageObjectResponse)) {
    throw invalidProviderMaterial();
  }

  if (
    !hasSameNotionObjectId(value["id"], pageId) ||
    typeof value["url"] !== "string" ||
    value["url"].trim() !== value["url"] ||
    value["url"].length === 0 ||
    (value["last_edited_time"] !== null &&
      typeof value["last_edited_time"] !== "string") ||
    value["in_trash"] !== false ||
    !isRecord(value["properties"])
  ) {
    throw invalidProviderMaterial();
  }

  return {
    id: pageId,
    title: titleFromPageProperties(value["properties"]),
    url: value["url"],
    lastEditedAt: value["last_edited_time"],
    inTrash: false
  };
}

function titleFromPageProperties(properties: Record<string, unknown>): string | null {
  for (const property of Object.values(properties)) {
    if (isRecord(property) && property["type"] === "title") {
      return plainText(property["title"]);
    }
  }

  return null;
}

function parseExactPageMarkdown(
  value: unknown,
  pageId: string
): { content: string; truncated: boolean; unknownBlockIds: string[] } {
  if (
    !isRecord(value) ||
    value["object"] !== "page_markdown" ||
    !hasSameNotionObjectId(value["id"], pageId) ||
    typeof value["markdown"] !== "string" ||
    typeof value["truncated"] !== "boolean" ||
    !Array.isArray(value["unknown_block_ids"]) ||
    !value["unknown_block_ids"].every(isOpaqueIdentifier)
  ) {
    throw invalidProviderMaterial();
  }

  return {
    content: value["markdown"],
    truncated: value["truncated"],
    unknownBlockIds: [...value["unknown_block_ids"]]
  };
}

function requireConfiguredPage(input: unknown, pageId: string): void {
  if (!isRecord(input) || canonicalNotionObjectId(input["pageId"]) !== pageId) {
    throw readerError(
      "notion-object-scoped-reader-page-forbidden",
      "The requested page is outside this exact-page reader"
    );
  }
}

function validateConfig(
  value: unknown,
  allowedKeys: readonly string[]
): BoundReaderConfig {
  if (!isRecord(value) || !Object.keys(value).every((key) => allowedKeys.includes(key))) {
    throw configError("Exact-page Notion reader configuration is invalid");
  }

  const pageId = canonicalNotionObjectId(value["pageId"]);
  const readOnlyApiToken = value["readOnlyApiToken"];

  if (!pageId || typeof readOnlyApiToken !== "string") {
    throw configError("A fixed page ID and dedicated read-only token are required");
  }

  const normalizedToken = readOnlyApiToken.trim();

  if (normalizedToken.length === 0) {
    throw configError("A fixed page ID and dedicated read-only token are required");
  }

  return { pageId, readOnlyApiToken: normalizedToken };
}

function requireNativeReadOnlyEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();

  if (!value) {
    throw configError(`${key} is required for the exact-page native Notion reader`);
  }

  return value;
}

function isTransportForTest(
  value: unknown
): value is NotionObjectScopedMeetingNoteEvidenceTransportForTest {
  return isRecord(value) && typeof value["create"] === "function";
}

function createSdkTransport(config: BoundReaderConfig): RawExactPageTransport {
  const { Client } = notionSdk();
  const client = new Client({
    ...transportInitialization(config),
    logger: () => undefined
  });

  return new NotionSdkExactPageTransport(client);
}

function transportInitialization(
  config: BoundReaderConfig
): ReaderTransportInitialization {
  return {
    auth: config.readOnlyApiToken,
    notionVersion: NOTION_MEETING_NOTES_API_VERSION,
    retry: false
  };
}

class NotionSdkExactPageTransport implements RawExactPageTransport {
  constructor(private readonly client: Client) {}

  retrievePage(input: { pageId: string }): Promise<unknown> {
    return this.client.pages.retrieve({ page_id: input.pageId });
  }

  retrievePageMarkdown(input: {
    pageId: string;
    includeTranscript: true;
  }): Promise<unknown> {
    return this.client.pages.retrieveMarkdown({
      page_id: input.pageId,
      include_transcript: input.includeTranscript
    });
  }

  listBlockChildren(input: { blockId: string; cursor?: string }): Promise<unknown> {
    return this.client.blocks.children.list({
      block_id: input.blockId,
      page_size: DEFAULT_BLOCK_CHILD_PAGE_SIZE,
      ...(input.cursor === undefined ? {} : { start_cursor: input.cursor })
    });
  }
}

function toSafeReadError(error: unknown): NotionMeetingNotesReadError {
  if (error instanceof NotionMeetingNotesReadError) {
    switch (error.code) {
      case "source-not-found":
      case "source-restricted":
      case "source-invalid":
      case "transient":
        return new NotionMeetingNotesReadError(error.code, safeMessage(error.code));
      default:
        return new NotionMeetingNotesReadError("transient", safeMessage("transient"));
    }
  }

  const { APIErrorCode, isNotionClientError } = notionSdk();

  if (isNotionClientError(error)) {
    if (error.code === APIErrorCode.ObjectNotFound) {
      return new NotionMeetingNotesReadError(
        "source-not-found",
        safeMessage("source-not-found")
      );
    }

    if (
      error.code === APIErrorCode.RestrictedResource ||
      error.code === APIErrorCode.Unauthorized
    ) {
      return new NotionMeetingNotesReadError(
        "source-restricted",
        safeMessage("source-restricted")
      );
    }
  }

  return new NotionMeetingNotesReadError("transient", safeMessage("transient"));
}

function invalidProviderMaterial(): NotionMeetingNotesReadError {
  return new NotionMeetingNotesReadError("source-invalid", safeMessage("source-invalid"));
}

function safeMessage(code: NotionMeetingNotesReadError["code"]): string {
  switch (code) {
    case "source-not-found":
      return "Notion exact-page material is unavailable";
    case "source-restricted":
      return "Notion exact-page access is unavailable";
    case "source-invalid":
      return "Notion exact-page material could not be verified";
    default:
      return "Notion exact-page material could not be read";
  }
}

function readerError(
  code: ConstructorParameters<typeof NotionObjectScopedMeetingNoteEvidenceReaderError>[0],
  message: string
): NotionObjectScopedMeetingNoteEvidenceReaderError {
  return new NotionObjectScopedMeetingNoteEvidenceReaderError(code, message);
}

function configError(message: string): NotionObjectScopedMeetingNoteEvidenceReaderError {
  return readerError("notion-object-scoped-reader-config-invalid", message);
}

function nullableNotionObjectId(value: unknown): boolean {
  return value === null || isNotionObjectId(value);
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isOpaqueIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !/\s/u.test(value)
  );
}

function isNotionObjectId(value: unknown): value is string {
  return typeof value === "string" && NOTION_PAGE_ID_PATTERN.test(value);
}

function hasSameNotionObjectId(value: unknown, expected: string): boolean {
  const actual = canonicalNotionObjectId(value);
  const canonicalExpected = canonicalNotionObjectId(expected);

  return actual !== null && canonicalExpected !== null && actual === canonicalExpected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function plainText(value: unknown): string | null {
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

/** Provider SDK loading is deferred until this production reader is built. */
function notionSdk(): NotionSdkModule {
  cachedNotionSdk ??= requireNotionSdk("@notionhq/client") as NotionSdkModule;
  return cachedNotionSdk;
}
