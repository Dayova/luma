import type {
  MeetingNoteEvidenceCapture,
  MeetingNoteEvidenceSource
} from "../native-review/source-bound-native-review.js";
import type { OperationalOutcomeMarkerVerifier } from "./operational-outcome-writer.js";
import {
  captureNotionMeetingNoteSnapshot,
  isNotionMeetingNotesRoot,
  listAllNotionBlockChildren,
  NotionMeetingNotesReadError,
  type NotionMeetingNoteSnapshotReader,
  type NotionMeetingNotesPage
} from "./notion-meeting-notes-source.js";
import { canonicalNotionObjectId } from "./notion-object-id.js";

/**
 * The exact-page reader exposes only the reads that one Meeting Note capture
 * needs. It cannot enumerate a data source, search Notion, or mutate Notion.
 */
export interface NotionObjectScopedMeetingNoteEvidenceReader extends NotionMeetingNoteSnapshotReader {
  retrievePage(input: { pageId: string }): Promise<NotionMeetingNotesPage>;
}

export type NotionObjectScopedMeetingNoteEvidenceSourceConfig = {
  /** The one logical Luma workspace this adapter may serve. */
  workspaceId: string;
  /** Opaque provider identity expected by the native review boundary. */
  providerId: string;
  /** The one exact Notion page UUID this adapter may read. */
  pageId: string;
  reader: NotionObjectScopedMeetingNoteEvidenceReader;
  /** Required to safely exclude a Luma-owned Operational Outcome marker. */
  operationalOutcomeMarkerVerifier?: OperationalOutcomeMarkerVerifier;
  now?: () => Date;
};

export class NotionObjectScopedMeetingNoteEvidenceSourceError extends Error {
  constructor(
    readonly code: "notion-object-scoped-evidence-config-invalid",
    message: string
  ) {
    super(message);
    this.name = "NotionObjectScopedMeetingNoteEvidenceSourceError";
  }
}

/**
 * Creates a read-only evidence source bound to exactly one logical workspace
 * and one provider page. The `capture` request is checked only as an ingress
 * assertion; its values never select a provider object.
 */
export function createNotionObjectScopedMeetingNoteEvidenceSource(
  config: NotionObjectScopedMeetingNoteEvidenceSourceConfig
): MeetingNoteEvidenceSource {
  const bound = validateConfig(config);

  return {
    async capture(input): Promise<MeetingNoteEvidenceCapture> {
      if (!matchesBoundCapture(input, bound)) {
        return unavailable(
          "meeting-note-capture-unavailable",
          "The configured Meeting Note evidence cannot serve this request.",
          false
        );
      }

      const firstPage = await readConfiguredPage({
        reader: bound.reader,
        pageId: bound.pageId
      });

      if (firstPage.status === "unavailable") {
        return firstPage.capture;
      }

      let rootBlocks;

      try {
        rootBlocks = await listAllNotionBlockChildren(bound.reader, bound.pageId);
      } catch (error) {
        return rootUnavailable(error);
      }

      if (rootBlocks.some(isUnreadableRootBlock)) {
        return unavailable(
          "meeting-note-root-unreadable",
          "The configured Meeting Note root could not be read safely.",
          false
        );
      }

      const roots = rootBlocks.filter(isNotionMeetingNotesRoot);

      if (roots.length === 0) {
        return unavailable(
          "meeting-note-root-missing",
          "The configured page does not expose one readable Meeting Note root.",
          false
        );
      }

      if (roots.length !== 1) {
        return unavailable(
          "meeting-note-root-ambiguous",
          "The configured page does not expose one readable Meeting Note root.",
          false
        );
      }

      const root = roots[0];
      const rootId = root ? canonicalNotionObjectId(root.id) : null;

      if (!root || !root.meetingNotes || !rootId) {
        return unavailable(
          "meeting-note-root-unreadable",
          "The configured Meeting Note root could not be read safely.",
          false
        );
      }

      const canonicalRoot = { ...root, id: rootId };

      try {
        const snapshot = await captureNotionMeetingNoteSnapshot(
          bound.reader,
          firstPage.page,
          canonicalRoot,
          {
            workspaceId: bound.workspaceId,
            providerId: bound.providerId,
            ...(bound.operationalOutcomeMarkerVerifier
              ? {
                  operationalOutcomeMarkerVerifier: bound.operationalOutcomeMarkerVerifier
                }
              : {})
          }
        );

        if (snapshot.completeness.state !== "complete") {
          // SourceBoundNativeReview persists and ingests a successful capture
          // before it can inspect completeness. An exact-page native surface
          // must therefore stop incomplete material at the provider boundary.
          return unavailable(
            "meeting-note-root-unreadable",
            "The configured Meeting Note root is not completely readable.",
            false
          );
        }

        // Notion does not offer one atomic snapshot across page metadata,
        // blocks, and Markdown. This final version reread cannot eliminate
        // that provider limitation, but it prevents labeling mixed material
        // with a provider version that demonstrably changed during capture.
        const finalPage = await readConfiguredPage({
          reader: bound.reader,
          pageId: bound.pageId
        });

        if (finalPage.status === "unavailable") {
          return finalPage.capture;
        }

        if (finalPage.page.lastEditedAt !== firstPage.page.lastEditedAt) {
          return unavailable(
            "meeting-note-page-unreadable",
            "The configured Meeting Note page could not be verified.",
            true
          );
        }

        const observedAt = observedAtFrom(bound.now);

        if (!observedAt) {
          return unavailable(
            "meeting-note-capture-unavailable",
            "The configured Meeting Note evidence could not be captured safely.",
            false
          );
        }

        return {
          status: "captured",
          evidence: {
            source: {
              providerId: bound.providerId,
              sourceKind: "meeting-note",
              sourceObjectId: canonicalRoot.id,
              parentObjectId: bound.pageId,
              url: canonicalNotionPageUrl(bound.pageId)
            },
            providerVersion: firstPage.page.lastEditedAt,
            snapshot,
            observedAt
          }
        };
      } catch (error) {
        return rootUnavailable(error);
      }
    }
  };
}

type BoundEvidenceConfig = {
  workspaceId: string;
  providerId: string;
  pageId: string;
  reader: NotionObjectScopedMeetingNoteEvidenceReader;
  operationalOutcomeMarkerVerifier?: OperationalOutcomeMarkerVerifier;
  now: () => Date;
};

function validateConfig(value: unknown): BoundEvidenceConfig {
  if (!isRecord(value) || !isEvidenceReader(value["reader"])) {
    throw new NotionObjectScopedMeetingNoteEvidenceSourceError(
      "notion-object-scoped-evidence-config-invalid",
      "A complete read-only Notion exact-page reader is required"
    );
  }

  const now = value["now"];

  if (now !== undefined && typeof now !== "function") {
    throw new NotionObjectScopedMeetingNoteEvidenceSourceError(
      "notion-object-scoped-evidence-config-invalid",
      "now must be a function when configured for object-scoped Notion evidence"
    );
  }

  return {
    workspaceId: requiredOpaqueIdentifier(value["workspaceId"], "workspaceId"),
    providerId: requiredOpaqueIdentifier(value["providerId"], "providerId"),
    pageId: requiredCanonicalNotionPageId(value["pageId"]),
    reader: value["reader"],
    ...(isOperationalOutcomeMarkerVerifier(value["operationalOutcomeMarkerVerifier"])
      ? { operationalOutcomeMarkerVerifier: value["operationalOutcomeMarkerVerifier"] }
      : {}),
    now: now === undefined ? () => new Date() : (now as () => Date)
  };
}

function requiredCanonicalNotionPageId(value: unknown): string {
  const pageId = canonicalNotionObjectId(value);

  if (!pageId) {
    throw new NotionObjectScopedMeetingNoteEvidenceSourceError(
      "notion-object-scoped-evidence-config-invalid",
      "pageId must be a Notion UUID"
    );
  }

  return pageId;
}

function requiredOpaqueIdentifier(value: unknown, name: string): string {
  if (!isOpaqueIdentifier(value)) {
    throw new NotionObjectScopedMeetingNoteEvidenceSourceError(
      "notion-object-scoped-evidence-config-invalid",
      `${name} must be a non-blank opaque identifier without whitespace`
    );
  }

  return value;
}

function isEvidenceReader(
  value: unknown
): value is NotionObjectScopedMeetingNoteEvidenceReader {
  return (
    isRecord(value) &&
    typeof value["retrievePage"] === "function" &&
    typeof value["listBlockChildren"] === "function" &&
    typeof value["retrievePageMarkdown"] === "function"
  );
}

function isOperationalOutcomeMarkerVerifier(
  value: unknown
): value is OperationalOutcomeMarkerVerifier {
  return isRecord(value) && typeof value["isOwned"] === "function";
}

function matchesBoundCapture(value: unknown, bound: BoundEvidenceConfig): boolean {
  return (
    isRecord(value) &&
    value["workspaceId"] === bound.workspaceId &&
    isRecord(value["page"]) &&
    value["page"]["providerId"] === bound.providerId &&
    canonicalNotionObjectId(value["page"]["pageId"]) === bound.pageId
  );
}

function isExactConfiguredPage(
  value: unknown,
  pageId: string
): value is NotionMeetingNotesPage & { lastEditedAt: string } {
  return (
    isRecord(value) &&
    canonicalNotionObjectId(value["id"]) === pageId &&
    (value["title"] === null || typeof value["title"] === "string") &&
    isTrustedNotionPageUrl(value["url"]) &&
    typeof value["lastEditedAt"] === "string" &&
    value["lastEditedAt"].trim() === value["lastEditedAt"] &&
    value["lastEditedAt"].length > 0 &&
    value["inTrash"] === false
  );
}

function isUnreadableRootBlock(block: { type: string }): boolean {
  return block.type === "unknown" || block.type === "unsupported";
}

async function readConfiguredPage(input: {
  reader: NotionObjectScopedMeetingNoteEvidenceReader;
  pageId: string;
}): Promise<
  | { status: "read"; page: NotionMeetingNotesPage & { lastEditedAt: string } }
  | { status: "unavailable"; capture: MeetingNoteEvidenceCapture }
> {
  try {
    const page = await input.reader.retrievePage({ pageId: input.pageId });

    if (!isExactConfiguredPage(page, input.pageId)) {
      return {
        status: "unavailable",
        capture: unavailable(
          "meeting-note-page-unreadable",
          "The configured Meeting Note page could not be verified.",
          false
        )
      };
    }

    return { status: "read", page: { ...page, id: input.pageId } };
  } catch (error) {
    return {
      status: "unavailable",
      capture: pageUnavailable(error)
    };
  }
}

function pageUnavailable(error: unknown): MeetingNoteEvidenceCapture {
  return unavailable(
    "meeting-note-page-unreadable",
    "The configured Meeting Note page could not be read.",
    isRetryableReadError(error)
  );
}

function rootUnavailable(error: unknown): MeetingNoteEvidenceCapture {
  return unavailable(
    "meeting-note-root-unreadable",
    "The configured Meeting Note root could not be read safely.",
    isRetryableReadError(error)
  );
}

function unavailable(
  code: Extract<MeetingNoteEvidenceCapture, { status: "unavailable" }>["code"],
  message: string,
  retryable: boolean
): MeetingNoteEvidenceCapture {
  return { status: "unavailable", code, message, retryable };
}

function isRetryableReadError(error: unknown): boolean {
  return (
    !(error instanceof NotionMeetingNotesReadError) ||
    error.code === "transient" ||
    error.code === "operational-outcome-marker-verification-unavailable"
  );
}

function observedAtFrom(now: () => Date): string | null {
  try {
    const observedAt = now();

    return observedAt instanceof Date && !Number.isNaN(observedAt.getTime())
      ? observedAt.toISOString()
      : null;
  } catch {
    return null;
  }
}

function isOpaqueIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !/\s/u.test(value)
  );
}

function canonicalNotionPageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId}`;
}

function isTrustedNotionPageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "notion.so" ||
        url.hostname === "www.notion.so" ||
        url.hostname === "app.notion.com") &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.port.length === 0
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
