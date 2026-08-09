import { createHash } from "node:crypto";
import type { ActionItemReconciliationReview, WorkspaceConfig } from "../domain/model.js";
import type { IdentityDirectory, PersonIdentity } from "../identity/interface.js";
import type { MeetingNotesIngestion } from "../knowledge/meeting-notes-ingestion.js";
import type {
  ObservedSourceIdentity,
  ObservedSourceLedger,
  ObservedSourceSnapshot,
  RawMeetingNoteSnapshot
} from "../knowledge/observed-source-ledger.js";
import type { MeetingIntelligence } from "../meeting-intelligence/interface.js";
import type { LumaDatabase } from "../persistence/db.js";

export const SOURCE_BOUND_NATIVE_REVIEW_CAPABILITY_VERSION =
  "source-bound-native-review-v1";

export type ExactMeetingNotePage = {
  providerId: string;
  pageId: string;
};

/**
 * A native ingress must create this from an authenticated provider principal.
 * It intentionally has no Person ID: only IdentityDirectory may map a
 * provider account to a Luma Person, and that mapping must be unique.
 */
export type TrustedNativeActor = {
  identityProviderId: string;
  providerUserId: string;
};

export type CapturedMeetingNoteEvidence = {
  /** The adapter derives this one root; callers never provide it. */
  source: ObservedSourceIdentity<"meeting-note">;
  providerVersion: string | null;
  snapshot: RawMeetingNoteSnapshot;
  observedAt: string;
};

export type MeetingNoteEvidenceCapture =
  | {
      status: "captured";
      evidence: CapturedMeetingNoteEvidence;
    }
  | {
      status: "unavailable";
      code:
        | "meeting-note-page-not-found"
        | "meeting-note-page-unreadable"
        | "meeting-note-root-missing"
        | "meeting-note-root-ambiguous"
        | "meeting-note-root-unreadable"
        | "meeting-note-capture-unavailable";
      message: string;
      retryable: boolean;
    };

/**
 * Captures one requested page, not a data-source scan. The provider adapter
 * is responsible for deriving exactly one Meeting Note root and must report
 * zero, multiple, or unreadable roots as unavailable.
 */
export interface MeetingNoteEvidenceSource {
  capture(input: {
    workspaceId: string;
    page: ExactMeetingNotePage;
  }): Promise<MeetingNoteEvidenceCapture>;
}

export type SourceBoundNativeReviewRequest = {
  nativeRunId: string;
  actor: TrustedNativeActor;
  page: ExactMeetingNotePage;
};

export type SourceBoundNativeReviewSource = {
  providerId: string;
  pageId: string;
  sourceObjectId: string;
  revision: number;
  contentHash: string;
};

export type OpaqueNativeReviewWorkReference = {
  providerId: string;
  lookupId: string;
};

export type SourceBoundNativeReviewClarificationCode =
  | "native-actor-unmapped"
  | "native-actor-ambiguous"
  | "native-identity-unavailable"
  | "meeting-note-page-not-found"
  | "meeting-note-page-unreadable"
  | "meeting-note-root-missing"
  | "meeting-note-root-ambiguous"
  | "meeting-note-root-unreadable"
  | "meeting-note-capture-unavailable"
  | "meeting-note-root-invalid"
  | "meeting-note-ledger-unavailable"
  | "meeting-note-ledger-invalid"
  | "meeting-note-source-incomplete"
  | "meeting-note-ingestion-rejected"
  | "meeting-intelligence-unavailable"
  | "work-catalog-unavailable";

export type SourceBoundNativeReviewReceipt = {
  capabilityVersion: typeof SOURCE_BOUND_NATIVE_REVIEW_CAPABILITY_VERSION;
  workspaceId: string;
  nativeRunId: string;
  actor: TrustedNativeActor & { personId: string | null };
  page: ExactMeetingNotePage;
  /** Null only when no immutable source revision could safely be pinned. */
  source: SourceBoundNativeReviewSource | null;
  outcome:
    | {
        type: "reviewed";
        reviewIds: string[];
        workReferences: OpaqueNativeReviewWorkReference[];
      }
    | {
        type: "needs-clarification";
        code: SourceBoundNativeReviewClarificationCode;
        message: string;
        retryable: boolean;
        reviewIds: string[];
        workReferences: OpaqueNativeReviewWorkReference[];
      };
};

export interface SourceBoundNativeReview {
  review(input: SourceBoundNativeReviewRequest): Promise<SourceBoundNativeReviewReceipt>;
}

export type CreateSourceBoundNativeReviewInput = {
  database: LumaDatabase;
  /** Trusted composition binds a native review surface to one workspace. */
  workspace: WorkspaceConfig;
  ledger: ObservedSourceLedger;
  meetingIntelligence: MeetingIntelligence;
  meetingNotesIngestion: MeetingNotesIngestion;
  meetingNoteEvidenceSource: MeetingNoteEvidenceSource;
  identityDirectory: IdentityDirectory;
  now?: () => Date;
};

type SourceBoundNativeReviewRow = {
  request_hash: string;
  actor_identity_provider_id: string;
  actor_provider_user_id: string;
  actor_person_id: string | null;
  page_provider_id: string;
  page_id: string;
  source_provider_id: string | null;
  source_object_id: string | null;
  source_revision: number | null;
  source_content_hash: string | null;
  capability_version: string;
  receipt_json: string;
  receipt_content_hash: string;
};

type ResolvedNativeActor = TrustedNativeActor & { personId: string | null };

export class SourceBoundNativeReviewError extends Error {
  constructor(
    readonly code:
      | "native-review-invalid"
      | "native-review-run-id-conflict"
      | "native-review-receipt-corrupt"
      | "native-review-replay-unavailable",
    readonly retryable: boolean,
    message: string
  ) {
    super(message);
    this.name = "SourceBoundNativeReviewError";
  }
}

/**
 * One deep native review operation. It owns actor resolution, exact-page
 * capture, immutable source persistence, source ingestion, reconciliation
 * lookup, and durable replay. Native callers cannot choose a source root,
 * revision, model answer, generic Work Catalog operation, or mutation.
 */
export function createSourceBoundNativeReview(
  input: CreateSourceBoundNativeReviewInput
): SourceBoundNativeReview {
  const workspace = cloneWorkspace(input.workspace);
  const now = input.now ?? (() => new Date());
  const locks = sourceBoundNativeReviewLocksFor(input.database);

  return {
    async review(request) {
      const immutableRequest = normalizeReviewRequest(request);
      const key = JSON.stringify([workspace.workspaceId, immutableRequest.nativeRunId]);

      return withRunLock(locks, key, () =>
        reviewNativeMeetingNote(input, workspace, immutableRequest, now)
      );
    }
  };
}

async function reviewNativeMeetingNote(
  input: CreateSourceBoundNativeReviewInput,
  workspace: WorkspaceConfig,
  request: SourceBoundNativeReviewRequest,
  now: () => Date
): Promise<SourceBoundNativeReviewReceipt> {
  const requestHash = nativeReviewRequestHash(workspace, request);
  const existing = await replayExistingReceipt({
    database: input.database,
    ledger: input.ledger,
    workspace,
    request,
    requestHash
  });

  if (existing) {
    return existing;
  }

  const actor = await resolveNativeActor(
    input.identityDirectory,
    workspace,
    request.actor
  );

  if (actor.status !== "resolved") {
    return persistNativeReviewReceipt({
      database: input.database,
      ledger: input.ledger,
      workspace,
      request,
      requestHash,
      receipt: clarificationReceipt({
        workspace,
        request,
        actor: {
          ...request.actor,
          personId: null
        },
        source: null,
        code: actor.code,
        message: actor.message,
        retryable: actor.retryable
      }),
      createdAt: now().toISOString()
    });
  }

  const captured = await captureMeetingNoteEvidence(
    input.meetingNoteEvidenceSource,
    workspace,
    request.page
  );

  if (captured.status === "unavailable") {
    return persistNativeReviewReceipt({
      database: input.database,
      ledger: input.ledger,
      workspace,
      request,
      requestHash,
      receipt: clarificationReceipt({
        workspace,
        request,
        actor: actor.actor,
        source: null,
        code: captured.code,
        message: captured.message,
        retryable: captured.retryable
      }),
      createdAt: now().toISOString()
    });
  }

  const validatedCapture = validateCapturedMeetingNote(captured.evidence, request.page);

  if (validatedCapture.status === "unavailable") {
    return persistNativeReviewReceipt({
      database: input.database,
      ledger: input.ledger,
      workspace,
      request,
      requestHash,
      receipt: clarificationReceipt({
        workspace,
        request,
        actor: actor.actor,
        source: null,
        code: validatedCapture.code,
        message: validatedCapture.message,
        retryable: false
      }),
      createdAt: now().toISOString()
    });
  }

  const recorded = await recordMeetingNoteEvidence(
    input.ledger,
    workspace,
    validatedCapture.evidence
  );

  if (recorded.status === "unavailable") {
    return persistNativeReviewReceipt({
      database: input.database,
      ledger: input.ledger,
      workspace,
      request,
      requestHash,
      receipt: clarificationReceipt({
        workspace,
        request,
        actor: actor.actor,
        source: null,
        code: recorded.code,
        message: recorded.message,
        retryable: recorded.retryable
      }),
      createdAt: now().toISOString()
    });
  }

  const immutableSource = await readImmutableMeetingNoteRevision({
    ledger: input.ledger,
    workspace,
    page: request.page,
    source: recorded.source,
    revision: recorded.revision,
    contentHash: recorded.contentHash
  });

  if (immutableSource.status === "unavailable") {
    return persistNativeReviewReceipt({
      database: input.database,
      ledger: input.ledger,
      workspace,
      request,
      requestHash,
      receipt: clarificationReceipt({
        workspace,
        request,
        actor: actor.actor,
        source: null,
        code: immutableSource.code,
        message: immutableSource.message,
        retryable: immutableSource.retryable
      }),
      createdAt: now().toISOString()
    });
  }

  const source = sourceReceiptReference(immutableSource.source, request.page);
  const ingestion = await ingestPinnedMeetingNote({
    ingestion: input.meetingNotesIngestion,
    workspace,
    source: immutableSource.source
  });

  if (ingestion.status === "unavailable") {
    return persistNativeReviewReceipt({
      database: input.database,
      ledger: input.ledger,
      workspace,
      request,
      requestHash,
      receipt: clarificationReceipt({
        workspace,
        request,
        actor: actor.actor,
        source,
        code: ingestion.code,
        message: ingestion.message,
        retryable: ingestion.retryable
      }),
      createdAt: now().toISOString()
    });
  }

  const reviews = await queryPinnedReviews({
    meetingIntelligence: input.meetingIntelligence,
    workspace,
    meetingId: ingestion.meetingId,
    source: immutableSource.source,
    page: request.page
  });

  if (reviews.status === "unavailable") {
    return persistNativeReviewReceipt({
      database: input.database,
      ledger: input.ledger,
      workspace,
      request,
      requestHash,
      receipt: clarificationReceipt({
        workspace,
        request,
        actor: actor.actor,
        source,
        code: reviews.code,
        message: reviews.message,
        retryable: reviews.retryable
      }),
      createdAt: now().toISOString()
    });
  }

  const reviewIds = reviews.reviews.map((review) => review.id).sort(compareStrings);
  const workReferences = opaqueWorkReferences(reviews.reviews);

  if (immutableSource.source.snapshot.completeness.state !== "complete") {
    return persistNativeReviewReceipt({
      database: input.database,
      ledger: input.ledger,
      workspace,
      request,
      requestHash,
      receipt: clarificationReceipt({
        workspace,
        request,
        actor: actor.actor,
        source,
        code: "meeting-note-source-incomplete",
        message:
          "The exact Meeting Note source is incomplete and cannot support a canonical work review.",
        retryable: true,
        reviewIds,
        workReferences
      }),
      createdAt: now().toISOString()
    });
  }

  const catalogFailed = reviews.reviews.some((review) =>
    review.searches.some(
      (search) => search.status === "failed" || search.status === "not-configured"
    )
  );
  const receipt: SourceBoundNativeReviewReceipt = catalogFailed
    ? clarificationReceipt({
        workspace,
        request,
        actor: actor.actor,
        source,
        code: "work-catalog-unavailable",
        message:
          "The read-only canonical Work Catalog could not be fully read; review proposals remain available for clarification.",
        retryable: true,
        reviewIds,
        workReferences
      })
    : {
        capabilityVersion: SOURCE_BOUND_NATIVE_REVIEW_CAPABILITY_VERSION,
        workspaceId: workspace.workspaceId,
        nativeRunId: request.nativeRunId,
        actor: actor.actor,
        page: { ...request.page },
        source,
        outcome: {
          type: "reviewed",
          reviewIds,
          workReferences
        }
      };

  return persistNativeReviewReceipt({
    database: input.database,
    ledger: input.ledger,
    workspace,
    request,
    requestHash,
    receipt,
    createdAt: now().toISOString()
  });
}

async function resolveNativeActor(
  identityDirectory: IdentityDirectory,
  workspace: WorkspaceConfig,
  actor: TrustedNativeActor
): Promise<
  | { status: "resolved"; actor: ResolvedNativeActor }
  | {
      status: "unavailable";
      code:
        | "native-actor-unmapped"
        | "native-actor-ambiguous"
        | "native-identity-unavailable";
      message: string;
      retryable: boolean;
    }
> {
  let people: PersonIdentity[];

  try {
    people = await identityDirectory.findPeopleByProviderUserId({
      workspaceId: workspace.workspaceId,
      providerId: actor.identityProviderId,
      providerUserId: actor.providerUserId
    });
  } catch {
    return {
      status: "unavailable",
      code: "native-identity-unavailable",
      message:
        "The trusted native actor could not be resolved through the Identity Directory.",
      retryable: true
    };
  }

  if (people.length === 0) {
    return {
      status: "unavailable",
      code: "native-actor-unmapped",
      message: "The authenticated native actor is not mapped to a Luma Person.",
      retryable: false
    };
  }

  if (people.length !== 1) {
    return {
      status: "unavailable",
      code: "native-actor-ambiguous",
      message: "The authenticated native actor maps to more than one Luma Person.",
      retryable: false
    };
  }

  const person = people[0];

  if (!person) {
    throw new Error("expected one mapped native actor");
  }

  return {
    status: "resolved",
    actor: {
      ...actor,
      personId: person.personId
    }
  };
}

async function captureMeetingNoteEvidence(
  source: MeetingNoteEvidenceSource,
  workspace: WorkspaceConfig,
  page: ExactMeetingNotePage
): Promise<MeetingNoteEvidenceCapture> {
  try {
    const capture = await source.capture({
      workspaceId: workspace.workspaceId,
      page: { ...page }
    });

    return isMeetingNoteCapture(capture)
      ? capture
      : {
          status: "unavailable",
          code: "meeting-note-root-unreadable",
          message: "The Meeting Note source returned an invalid exact-page capture.",
          retryable: true
        };
  } catch {
    return {
      status: "unavailable",
      code: "meeting-note-capture-unavailable",
      message: "The exact Meeting Note page could not be captured.",
      retryable: true
    };
  }
}

function validateCapturedMeetingNote(
  captured: CapturedMeetingNoteEvidence,
  page: ExactMeetingNotePage
):
  | { status: "captured"; evidence: CapturedMeetingNoteEvidence }
  | {
      status: "unavailable";
      code: "meeting-note-root-invalid";
      message: string;
    } {
  const source = captured.source;

  if (
    source.sourceKind !== "meeting-note" ||
    source.providerId !== page.providerId ||
    source.parentObjectId !== page.pageId ||
    !isNonBlankString(source.sourceObjectId) ||
    !isNonBlankString(source.url) ||
    !isNonBlankString(captured.observedAt)
  ) {
    return {
      status: "unavailable",
      code: "meeting-note-root-invalid",
      message:
        "The captured Meeting Note root does not prove one exact root for the requested page."
    };
  }

  try {
    return {
      status: "captured",
      evidence: {
        source: { ...source },
        providerVersion: captured.providerVersion,
        snapshot: structuredClone(captured.snapshot),
        observedAt: captured.observedAt
      }
    };
  } catch {
    return {
      status: "unavailable",
      code: "meeting-note-root-invalid",
      message:
        "The captured Meeting Note evidence cannot be copied as immutable source material."
    };
  }
}

async function recordMeetingNoteEvidence(
  ledger: ObservedSourceLedger,
  workspace: WorkspaceConfig,
  evidence: CapturedMeetingNoteEvidence
): Promise<
  | {
      status: "recorded";
      source: ObservedSourceIdentity<"meeting-note">;
      revision: number;
      contentHash: string;
    }
  | {
      status: "unavailable";
      code: "meeting-note-ledger-unavailable";
      message: string;
      retryable: true;
    }
> {
  try {
    const recorded = await ledger.record({
      workspaceId: workspace.workspaceId,
      source: evidence.source,
      providerVersion: evidence.providerVersion,
      snapshot: evidence.snapshot,
      observedAt: evidence.observedAt
    });

    return {
      status: "recorded",
      source: recorded.source,
      revision: recorded.revision,
      contentHash: recorded.contentHash
    };
  } catch {
    return {
      status: "unavailable",
      code: "meeting-note-ledger-unavailable",
      message: "The exact Meeting Note evidence could not be durably recorded.",
      retryable: true
    };
  }
}

async function readImmutableMeetingNoteRevision(input: {
  ledger: ObservedSourceLedger;
  workspace: WorkspaceConfig;
  page: ExactMeetingNotePage;
  source: ObservedSourceIdentity<"meeting-note">;
  revision: number;
  contentHash: string;
}): Promise<
  | { status: "captured"; source: ObservedSourceSnapshot<"meeting-note"> }
  | {
      status: "unavailable";
      code: "meeting-note-ledger-unavailable" | "meeting-note-ledger-invalid";
      message: string;
      retryable: boolean;
    }
> {
  let immutable: ObservedSourceSnapshot<"meeting-note"> | null;

  try {
    immutable = await input.ledger.get({
      workspaceId: input.workspace.workspaceId,
      source: {
        providerId: input.source.providerId,
        sourceKind: "meeting-note",
        sourceObjectId: input.source.sourceObjectId
      },
      revision: input.revision
    });
  } catch {
    return {
      status: "unavailable",
      code: "meeting-note-ledger-unavailable",
      message: "The immutable Meeting Note revision could not be re-read.",
      retryable: true
    };
  }

  if (
    !immutable ||
    immutable.contentHash !== input.contentHash ||
    immutable.source.providerId !== input.page.providerId ||
    immutable.source.parentObjectId !== input.page.pageId ||
    immutable.source.sourceKind !== "meeting-note"
  ) {
    return {
      status: "unavailable",
      code: "meeting-note-ledger-invalid",
      message:
        "The durable Meeting Note revision does not match the exact page capture that requested review.",
      retryable: false
    };
  }

  return { status: "captured", source: immutable };
}

function sourceReceiptReference(
  source: ObservedSourceSnapshot<"meeting-note">,
  page: ExactMeetingNotePage
): SourceBoundNativeReviewSource {
  return {
    providerId: source.source.providerId,
    pageId: page.pageId,
    sourceObjectId: source.source.sourceObjectId,
    revision: source.revision,
    contentHash: source.contentHash
  };
}

async function ingestPinnedMeetingNote(input: {
  ingestion: MeetingNotesIngestion;
  workspace: WorkspaceConfig;
  source: ObservedSourceSnapshot<"meeting-note">;
}): Promise<
  | { status: "ingested"; meetingId: string }
  | {
      status: "unavailable";
      code: "meeting-note-ingestion-rejected" | "meeting-intelligence-unavailable";
      message: string;
      retryable: boolean;
    }
> {
  try {
    const update = await input.ingestion.ingest({
      workspace: input.workspace,
      source: {
        ...input.source,
        change: "unchanged"
      }
    });

    if (
      update.acceptedObservationIds.length + update.duplicateObservationIds.length ===
      0
    ) {
      return {
        status: "unavailable",
        code: "meeting-note-ingestion-rejected",
        message: "Meeting Intelligence did not accept the immutable Meeting Note source.",
        retryable: update.errors.some((error) => error.retryable)
      };
    }

    return { status: "ingested", meetingId: update.meetingId };
  } catch {
    return {
      status: "unavailable",
      code: "meeting-intelligence-unavailable",
      message: "Meeting Intelligence could not ingest the immutable Meeting Note source.",
      retryable: true
    };
  }
}

async function queryPinnedReviews(input: {
  meetingIntelligence: MeetingIntelligence;
  workspace: WorkspaceConfig;
  meetingId: string;
  source: ObservedSourceSnapshot<"meeting-note">;
  page: ExactMeetingNotePage;
}): Promise<
  | { status: "reviewed"; reviews: ActionItemReconciliationReview[] }
  | {
      status: "unavailable";
      code: "meeting-intelligence-unavailable";
      message: string;
      retryable: true;
    }
> {
  try {
    const result = await input.meetingIntelligence.query({
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      query: { type: "action-item-reconciliation-review" }
    });

    if (result.type !== "action-item-reconciliation-review") {
      return {
        status: "unavailable",
        code: "meeting-intelligence-unavailable",
        message: "Meeting Intelligence returned an unsupported native review response.",
        retryable: true
      };
    }

    return {
      status: "reviewed",
      reviews: result.reviews
        .map((review) => review.proposal)
        .filter((review) => reviewIsBoundToSource(review, input.source, input.page))
    };
  } catch {
    return {
      status: "unavailable",
      code: "meeting-intelligence-unavailable",
      message:
        "Meeting Intelligence could not query the exact source revision's reviews.",
      retryable: true
    };
  }
}

function reviewIsBoundToSource(
  review: ActionItemReconciliationReview,
  source: ObservedSourceSnapshot<"meeting-note">,
  page: ExactMeetingNotePage
): boolean {
  const candidateSource = review.candidate.source.source;

  return (
    candidateSource.providerId === source.source.providerId &&
    candidateSource.sourceKind === "meeting-note" &&
    candidateSource.sourceObjectId === source.source.sourceObjectId &&
    candidateSource.parentObjectId === page.pageId &&
    candidateSource.sourceRevision === source.revision &&
    candidateSource.contentHash === source.contentHash
  );
}

function opaqueWorkReferences(
  reviews: ActionItemReconciliationReview[]
): OpaqueNativeReviewWorkReference[] {
  const byIdentity = new Map<string, OpaqueNativeReviewWorkReference>();

  for (const review of reviews) {
    for (const search of review.searches) {
      for (const workItem of search.workItems) {
        const reference = {
          providerId: workItem.providerId,
          lookupId: workItem.lookupId
        };
        byIdentity.set(
          JSON.stringify([reference.providerId, reference.lookupId]),
          reference
        );
      }
    }

    if (
      review.outcome.type === "link-existing" ||
      review.outcome.type === "update-existing"
    ) {
      const reference = {
        providerId: review.outcome.workItem.providerId,
        lookupId: review.outcome.workItem.lookupId
      };
      byIdentity.set(
        JSON.stringify([reference.providerId, reference.lookupId]),
        reference
      );
    }
  }

  return [...byIdentity.values()].sort(
    (left, right) =>
      compareStrings(left.providerId, right.providerId) ||
      compareStrings(left.lookupId, right.lookupId)
  );
}

function clarificationReceipt(input: {
  workspace: WorkspaceConfig;
  request: SourceBoundNativeReviewRequest;
  actor: ResolvedNativeActor;
  source: SourceBoundNativeReviewSource | null;
  code: SourceBoundNativeReviewClarificationCode;
  message: string;
  retryable: boolean;
  reviewIds?: string[];
  workReferences?: OpaqueNativeReviewWorkReference[];
}): SourceBoundNativeReviewReceipt {
  return {
    capabilityVersion: SOURCE_BOUND_NATIVE_REVIEW_CAPABILITY_VERSION,
    workspaceId: input.workspace.workspaceId,
    nativeRunId: input.request.nativeRunId,
    actor: { ...input.actor },
    page: { ...input.request.page },
    source: input.source ? { ...input.source } : null,
    outcome: {
      type: "needs-clarification",
      code: input.code,
      message: input.message,
      retryable: input.retryable,
      reviewIds: [...(input.reviewIds ?? [])].sort(compareStrings),
      workReferences: [...(input.workReferences ?? [])]
    }
  };
}

async function persistNativeReviewReceipt(input: {
  database: LumaDatabase;
  ledger: ObservedSourceLedger;
  workspace: WorkspaceConfig;
  request: SourceBoundNativeReviewRequest;
  requestHash: string;
  receipt: SourceBoundNativeReviewReceipt;
  createdAt: string;
}): Promise<SourceBoundNativeReviewReceipt> {
  const result = await input.database.transaction(async (transaction) => {
    const existing = await readNativeReviewReceipt(
      transaction,
      input.workspace,
      input.request
    );

    if (existing) {
      return { status: "existing" as const, row: existing };
    }

    const receiptJson = JSON.stringify(input.receipt);
    const receiptContentHash = sha256(receiptJson);
    const inserted = await transaction.query<{ native_run_id: string }>(
      `INSERT INTO source_bound_native_reviews (
         workspace_id,
         native_run_id,
         request_hash,
         actor_identity_provider_id,
         actor_provider_user_id,
         actor_person_id,
         page_provider_id,
         page_id,
         source_provider_id,
         source_object_id,
         source_revision,
         source_content_hash,
         capability_version,
         receipt_json,
         receipt_content_hash,
         created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
       ) ON CONFLICT (workspace_id, native_run_id) DO NOTHING
       RETURNING native_run_id`,
      [
        input.workspace.workspaceId,
        input.request.nativeRunId,
        input.requestHash,
        input.receipt.actor.identityProviderId,
        input.receipt.actor.providerUserId,
        input.receipt.actor.personId,
        input.receipt.page.providerId,
        input.receipt.page.pageId,
        input.receipt.source?.providerId ?? null,
        input.receipt.source?.sourceObjectId ?? null,
        input.receipt.source?.revision ?? null,
        input.receipt.source?.contentHash ?? null,
        input.receipt.capabilityVersion,
        receiptJson,
        receiptContentHash,
        input.createdAt
      ]
    );

    if (inserted.rows[0]) {
      return { status: "persisted" as const, receipt: input.receipt };
    }

    const concurrent = await readNativeReviewReceipt(
      transaction,
      input.workspace,
      input.request
    );

    if (!concurrent) {
      throw new Error("Native review receipt insert did not reveal a durable winner");
    }

    return { status: "existing" as const, row: concurrent };
  });

  if (result.status === "persisted") {
    return result.receipt;
  }

  return replayStoredReceipt({
    ledger: input.ledger,
    workspace: input.workspace,
    request: input.request,
    requestHash: input.requestHash,
    row: result.row
  });
}

async function replayExistingReceipt(input: {
  database: LumaDatabase;
  ledger: ObservedSourceLedger;
  workspace: WorkspaceConfig;
  request: SourceBoundNativeReviewRequest;
  requestHash: string;
}): Promise<SourceBoundNativeReviewReceipt | null> {
  const row = await readNativeReviewReceipt(
    input.database,
    input.workspace,
    input.request
  );

  return row
    ? replayStoredReceipt({
        ledger: input.ledger,
        workspace: input.workspace,
        request: input.request,
        requestHash: input.requestHash,
        row
      })
    : null;
}

async function readNativeReviewReceipt(
  database: Pick<LumaDatabase, "query">,
  workspace: WorkspaceConfig,
  request: Pick<SourceBoundNativeReviewRequest, "nativeRunId">
): Promise<SourceBoundNativeReviewRow | null> {
  const result = await database.query<SourceBoundNativeReviewRow>(
    `SELECT request_hash,
            actor_identity_provider_id,
            actor_provider_user_id,
            actor_person_id,
            page_provider_id,
            page_id,
            source_provider_id,
            source_object_id,
            source_revision,
            source_content_hash,
            capability_version,
            receipt_json,
            receipt_content_hash
       FROM source_bound_native_reviews
      WHERE workspace_id = $1 AND native_run_id = $2`,
    [workspace.workspaceId, request.nativeRunId]
  );

  return result.rows[0] ?? null;
}

async function replayStoredReceipt(input: {
  ledger: ObservedSourceLedger;
  workspace: WorkspaceConfig;
  request: SourceBoundNativeReviewRequest;
  requestHash: string;
  row: SourceBoundNativeReviewRow;
}): Promise<SourceBoundNativeReviewReceipt> {
  if (input.row.request_hash !== input.requestHash) {
    throw new SourceBoundNativeReviewError(
      "native-review-run-id-conflict",
      false,
      "A native review run ID may only be reused for the exact original actor and page."
    );
  }

  if (input.row.receipt_content_hash !== sha256(input.row.receipt_json)) {
    throw new SourceBoundNativeReviewError(
      "native-review-receipt-corrupt",
      false,
      "Stored native review receipt does not match its recorded content hash."
    );
  }

  const receipt = parseStoredReceipt(input.row.receipt_json);

  if (!receiptMatchesStoredBinding(receipt, input.workspace, input.request, input.row)) {
    throw new SourceBoundNativeReviewError(
      "native-review-receipt-corrupt",
      false,
      "Stored native review receipt does not match its immutable request binding."
    );
  }

  if (receipt.source) {
    const source = await readImmutableMeetingNoteRevision({
      ledger: input.ledger,
      workspace: input.workspace,
      page: receipt.page,
      source: {
        providerId: receipt.source.providerId,
        sourceKind: "meeting-note",
        sourceObjectId: receipt.source.sourceObjectId,
        parentObjectId: receipt.source.pageId,
        url: "replay-bound-source"
      },
      revision: receipt.source.revision,
      contentHash: receipt.source.contentHash
    });

    if (source.status === "unavailable") {
      throw new SourceBoundNativeReviewError(
        source.code === "meeting-note-ledger-unavailable"
          ? "native-review-replay-unavailable"
          : "native-review-receipt-corrupt",
        source.retryable,
        "Stored native review receipt no longer names a verifiable immutable Meeting Note revision."
      );
    }
  }

  return receipt;
}

function parseStoredReceipt(value: string): SourceBoundNativeReviewReceipt {
  try {
    const parsed: unknown = JSON.parse(value);

    if (!isReceiptShape(parsed)) {
      throw new Error("invalid receipt shape");
    }

    return parsed;
  } catch {
    throw new SourceBoundNativeReviewError(
      "native-review-receipt-corrupt",
      false,
      "Stored native review receipt cannot be read safely."
    );
  }
}

function receiptMatchesStoredBinding(
  receipt: SourceBoundNativeReviewReceipt,
  workspace: WorkspaceConfig,
  request: SourceBoundNativeReviewRequest,
  row: SourceBoundNativeReviewRow
): boolean {
  const sourceColumnsAreAllNull = [
    row.source_provider_id,
    row.source_object_id,
    row.source_revision,
    row.source_content_hash
  ].every((value) => value === null);
  const sourceColumnsAreAllPresent = [
    row.source_provider_id,
    row.source_object_id,
    row.source_revision,
    row.source_content_hash
  ].every((value) => value !== null);
  const sourceMatches = receipt.source
    ? sourceColumnsAreAllPresent &&
      receipt.source.providerId === row.source_provider_id &&
      receipt.source.sourceObjectId === row.source_object_id &&
      receipt.source.revision === row.source_revision &&
      receipt.source.contentHash === row.source_content_hash &&
      receipt.source.pageId === request.page.pageId
    : sourceColumnsAreAllNull;

  return (
    (sourceColumnsAreAllNull || sourceColumnsAreAllPresent) &&
    receipt.capabilityVersion === SOURCE_BOUND_NATIVE_REVIEW_CAPABILITY_VERSION &&
    row.capability_version === SOURCE_BOUND_NATIVE_REVIEW_CAPABILITY_VERSION &&
    receipt.workspaceId === workspace.workspaceId &&
    receipt.nativeRunId === request.nativeRunId &&
    receipt.actor.identityProviderId === request.actor.identityProviderId &&
    receipt.actor.providerUserId === request.actor.providerUserId &&
    receipt.actor.identityProviderId === row.actor_identity_provider_id &&
    receipt.actor.providerUserId === row.actor_provider_user_id &&
    receipt.actor.personId === row.actor_person_id &&
    receipt.page.providerId === request.page.providerId &&
    receipt.page.pageId === request.page.pageId &&
    receipt.page.providerId === row.page_provider_id &&
    receipt.page.pageId === row.page_id &&
    sourceMatches
  );
}

function nativeReviewRequestHash(
  workspace: WorkspaceConfig,
  request: SourceBoundNativeReviewRequest
): string {
  return sha256(
    JSON.stringify({
      workspaceId: workspace.workspaceId,
      nativeRunId: request.nativeRunId,
      actor: {
        identityProviderId: request.actor.identityProviderId,
        providerUserId: request.actor.providerUserId
      },
      page: {
        providerId: request.page.providerId,
        pageId: request.page.pageId
      }
    })
  );
}

function normalizeReviewRequest(
  input: SourceBoundNativeReviewRequest
): SourceBoundNativeReviewRequest {
  if (!input || typeof input !== "object") {
    throw invalidReviewRequest();
  }

  return {
    nativeRunId: requiredIdentifier(input.nativeRunId),
    actor: {
      identityProviderId: requiredIdentifier(input.actor?.identityProviderId),
      providerUserId: requiredIdentifier(input.actor?.providerUserId)
    },
    page: {
      providerId: requiredIdentifier(input.page?.providerId),
      pageId: requiredIdentifier(input.page?.pageId)
    }
  };
}

function cloneWorkspace(workspace: WorkspaceConfig): WorkspaceConfig {
  if (!workspace || typeof workspace !== "object") {
    throw new Error(
      "Source Bound Native Review requires trusted workspace configuration"
    );
  }

  return {
    ...workspace,
    workspaceId: requiredIdentifier(workspace.workspaceId),
    timezone: requiredIdentifier(workspace.timezone)
  };
}

function requiredIdentifier(value: unknown): string {
  if (typeof value !== "string") {
    throw invalidReviewRequest();
  }

  const normalized = value.trim();

  if (normalized.length === 0 || normalized.length > 2_000) {
    throw invalidReviewRequest();
  }

  return normalized;
}

function invalidReviewRequest(): SourceBoundNativeReviewError {
  return new SourceBoundNativeReviewError(
    "native-review-invalid",
    false,
    "Native review requires one trusted run ID, authenticated actor, and exact Meeting Note page."
  );
}

function isMeetingNoteCapture(value: unknown): value is MeetingNoteEvidenceCapture {
  if (!value || typeof value !== "object") {
    return false;
  }

  const capture = value as {
    status?: unknown;
    evidence?: unknown;
    code?: unknown;
    message?: unknown;
    retryable?: unknown;
  };

  return capture.status === "captured"
    ? isCapturedMeetingNoteEvidence(capture.evidence)
    : capture.status === "unavailable" &&
        isMeetingNoteCaptureCode(capture.code) &&
        isNonBlankString(capture.message) &&
        typeof capture.retryable === "boolean";
}

function isCapturedMeetingNoteEvidence(
  value: unknown
): value is CapturedMeetingNoteEvidence {
  if (!value || typeof value !== "object") {
    return false;
  }

  const evidence = value as {
    source?: unknown;
    providerVersion?: unknown;
    snapshot?: unknown;
    observedAt?: unknown;
  };

  return (
    isObservedMeetingNoteIdentity(evidence.source) &&
    (evidence.providerVersion === null || typeof evidence.providerVersion === "string") &&
    Boolean(evidence.snapshot && typeof evidence.snapshot === "object") &&
    isNonBlankString(evidence.observedAt)
  );
}

function isObservedMeetingNoteIdentity(
  value: unknown
): value is ObservedSourceIdentity<"meeting-note"> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const source = value as Partial<ObservedSourceIdentity<"meeting-note">>;
  return (
    source.sourceKind === "meeting-note" &&
    isNonBlankString(source.providerId) &&
    isNonBlankString(source.sourceObjectId) &&
    (source.parentObjectId === null || isNonBlankString(source.parentObjectId)) &&
    isNonBlankString(source.url)
  );
}

function isMeetingNoteCaptureCode(
  value: unknown
): value is Extract<MeetingNoteEvidenceCapture, { status: "unavailable" }>["code"] {
  return (
    value === "meeting-note-page-not-found" ||
    value === "meeting-note-page-unreadable" ||
    value === "meeting-note-root-missing" ||
    value === "meeting-note-root-ambiguous" ||
    value === "meeting-note-root-unreadable" ||
    value === "meeting-note-capture-unavailable"
  );
}

function isReceiptShape(value: unknown): value is SourceBoundNativeReviewReceipt {
  if (!value || typeof value !== "object") {
    return false;
  }

  const receipt = value as Partial<SourceBoundNativeReviewReceipt>;

  return (
    receipt.capabilityVersion === SOURCE_BOUND_NATIVE_REVIEW_CAPABILITY_VERSION &&
    isNonBlankString(receipt.workspaceId) &&
    isNonBlankString(receipt.nativeRunId) &&
    isResolvedNativeActor(receipt.actor) &&
    isExactMeetingNotePage(receipt.page) &&
    (receipt.source === null || isSourceReference(receipt.source)) &&
    isReceiptOutcome(receipt.outcome)
  );
}

function isResolvedNativeActor(value: unknown): value is ResolvedNativeActor {
  if (!value || typeof value !== "object") {
    return false;
  }

  const actor = value as Partial<ResolvedNativeActor>;
  return (
    isNonBlankString(actor.identityProviderId) &&
    isNonBlankString(actor.providerUserId) &&
    (actor.personId === null || isNonBlankString(actor.personId))
  );
}

function isExactMeetingNotePage(value: unknown): value is ExactMeetingNotePage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const page = value as Partial<ExactMeetingNotePage>;
  return isNonBlankString(page.providerId) && isNonBlankString(page.pageId);
}

function isSourceReference(value: unknown): value is SourceBoundNativeReviewSource {
  if (!value || typeof value !== "object") {
    return false;
  }

  const source = value as Partial<SourceBoundNativeReviewSource>;
  return (
    isNonBlankString(source.providerId) &&
    isNonBlankString(source.pageId) &&
    isNonBlankString(source.sourceObjectId) &&
    typeof source.revision === "number" &&
    Number.isInteger(source.revision) &&
    source.revision > 0 &&
    isNonBlankString(source.contentHash)
  );
}

function isReceiptOutcome(
  value: unknown
): value is SourceBoundNativeReviewReceipt["outcome"] {
  if (!value || typeof value !== "object") {
    return false;
  }

  const outcome = value as {
    type?: unknown;
    reviewIds?: unknown;
    workReferences?: unknown;
    code?: unknown;
    message?: unknown;
    retryable?: unknown;
  };

  if (
    (outcome.type !== "reviewed" && outcome.type !== "needs-clarification") ||
    !Array.isArray(outcome.reviewIds) ||
    !outcome.reviewIds.every(isNonBlankString) ||
    !Array.isArray(outcome.workReferences) ||
    !outcome.workReferences.every(isOpaqueWorkReference)
  ) {
    return false;
  }

  return (
    outcome.type === "reviewed" ||
    (isNonBlankString(outcome.code) &&
      isNonBlankString(outcome.message) &&
      typeof outcome.retryable === "boolean")
  );
}

function isOpaqueWorkReference(value: unknown): value is OpaqueNativeReviewWorkReference {
  if (!value || typeof value !== "object") {
    return false;
  }

  const reference = value as Partial<OpaqueNativeReviewWorkReference>;
  return isNonBlankString(reference.providerId) && isNonBlankString(reference.lookupId);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

const sourceBoundNativeReviewLocks = new WeakMap<
  LumaDatabase,
  Map<string, Promise<void>>
>();

function sourceBoundNativeReviewLocksFor(
  database: LumaDatabase
): Map<string, Promise<void>> {
  let locks = sourceBoundNativeReviewLocks.get(database);

  if (!locks) {
    locks = new Map();
    sourceBoundNativeReviewLocks.set(database, locks);
  }

  return locks;
}

function withRunLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.catch(() => undefined).then(() => current);
  locks.set(key, chain);

  return previous
    .catch(() => undefined)
    .then(operation)
    .finally(() => {
      release?.();

      if (locks.get(key) === chain) {
        locks.delete(key);
      }
    });
}
