import { createHash } from "node:crypto";
import type { LumaDatabase } from "../persistence/db.js";

export type SourcePartialReason = {
  code:
    | "missing-meeting-notes-block"
    | "meeting-notes-not-ready"
    | "missing-section"
    | "unreadable-section"
    | "transcript-unavailable"
    | "truncated-markdown"
    | "unreadable-markdown"
    | "unknown-blocks"
    | "pagination-incomplete"
    | "unknown-provider-shape";
  message: string;
  blockId?: string;
};

export type CapturedMeetingNoteBlock = {
  id: string;
  type: string;
  text: string | null;
  checked: boolean | null;
  children: CapturedMeetingNoteBlock[];
};

export type RawMeetingNoteSection =
  | {
      state: "available";
      sourceBlockId: string;
      text: string;
      blocks: CapturedMeetingNoteBlock[];
    }
  | {
      state: "unavailable";
      sourceBlockId: string | null;
      reasons: SourcePartialReason[];
    };

export type RawMeetingNoteSnapshot = {
  schemaVersion: 1;
  title: string | null;
  lifecycle: "not-ready" | "ready" | "failed" | "removed" | "unknown";
  calendar: {
    startAt: string;
    endAt: string;
    attendeeProviderUserIds: string[];
  } | null;
  recording: {
    startAt: string | null;
    endAt: string | null;
  } | null;
  sections: {
    summary: RawMeetingNoteSection;
    actionItemsAndNotes: RawMeetingNoteSection;
    transcript: RawMeetingNoteSection;
  };
  markdown: {
    content: string;
    truncated: boolean;
    unknownBlockIds: string[];
  };
  completeness:
    | { state: "complete" }
    | { state: "not-ready"; providerStatus: string | null }
    | { state: "partial"; reasons: SourcePartialReason[] }
    | { state: "failed"; providerStatus: string | null }
    /**
     * A complete, readable canonical source scan proved that this root no
     * longer exists. This is intentionally distinct from a provider read
     * failure or unavailable section, neither of which can remove evidence.
     */
    | { state: "removed"; message: string };
};

export type ConversationSourcePartialReason = {
  code:
    | "history-truncated"
    | "message-content-unavailable"
    | "message-fetch-failed"
    | "pagination-incomplete"
    | "thread-not-readable"
    | "unknown-provider-shape";
  message: string;
  messageId?: string;
};

export type RawConversationAuthor = {
  providerUserId: string;
  displayName: string;
  /** The best identity-directory mapping known at capture time, if any. */
  personId?: string | null;
};

export type RawConversationMessage =
  | {
      id: string;
      /** Zero-based order in the exact captured evidence boundary. */
      ordinal: number;
      author: RawConversationAuthor;
      createdAt: string;
      editedAt: string | null;
      replyToMessageId: string | null;
      url: string;
      state: "available";
      text: string;
    }
  | {
      id: string;
      /** Zero-based order in the exact captured evidence boundary. */
      ordinal: number;
      author: RawConversationAuthor;
      createdAt: string;
      editedAt: string | null;
      replyToMessageId: string | null;
      url: string;
      state: "deleted";
      text: null;
    };

/**
 * A bounded, immutable conversation capture. It represents evidence observed
 * at one instant only; unlike a canonical Meeting Notes scan it has no
 * authority to infer that an absent message or conversation was deleted.
 */
export type RawConversationSnapshot = {
  schemaVersion: 1;
  conversation: {
    conversationObjectId: string;
    parentConversationObjectId: string | null;
    title: string | null;
    url: string;
  };
  boundary: {
    mode: "thread";
    anchorMessageId: string;
    firstMessageId: string;
    lastMessageId: string;
    /** Exact, ordered IDs represented by `messages`. */
    messageIds: string[];
  };
  messages: RawConversationMessage[];
  completeness:
    | { state: "complete" }
    | { state: "partial"; reasons: ConversationSourcePartialReason[] };
};

export type ObservedSourceKind = "meeting-note" | "conversation";

type ObservedSourceIdentityByKind = {
  "meeting-note": {
    providerId: string;
    sourceKind: "meeting-note";
    sourceObjectId: string;
    parentObjectId: string | null;
    url: string;
  };
  conversation: {
    providerId: string;
    sourceKind: "conversation";
    /** The immutable interaction/anchor message that requested the inquiry. */
    sourceObjectId: string;
    /** The bounded thread or conversation that supplied the evidence. */
    parentObjectId: string;
    /** Stable provider URL for the immutable anchor message. */
    url: string;
  };
};

type ObservedSourceKey<Kind extends ObservedSourceKind = ObservedSourceKind> = {
  providerId: string;
  sourceKind: Kind;
  sourceObjectId: string;
};

type ObservedSourceSnapshotPayloadByKind = {
  "meeting-note": RawMeetingNoteSnapshot;
  conversation: RawConversationSnapshot;
};

/**
 * The provider-neutral identity of a durable evidence root. Defaults preserve
 * Meeting Notes callers while generic Ledger methods infer the correct kind.
 */
export type ObservedSourceIdentity<Kind extends ObservedSourceKind = "meeting-note"> =
  ObservedSourceIdentityByKind[Kind];

export type ObservedSourceSnapshotPayload<
  Kind extends ObservedSourceKind = "meeting-note"
> = ObservedSourceSnapshotPayloadByKind[Kind];

/**
 * The provider-neutral identity of a source root whose mutable ledger head can
 * be fenced while Luma performs a source-bound external mutation.
 */
export type ObservedSourceExecutionFenceSource = Pick<
  ObservedSourceIdentity<"meeting-note">,
  "providerId" | "sourceKind" | "sourceObjectId"
>;

export type ObservedSourceExecutionFenceExpectedHead = {
  revision: number;
  contentHash: string;
};

/** Identifies one durable Follow-up Execution without exposing provider state. */
export type ObservedSourceExecutionFenceOwner = {
  meetingId: string;
  intentId: string;
  executionLeaseId: string;
};

export type AcquireObservedSourceExecutionFenceInput = {
  workspaceId: string;
  source: ObservedSourceExecutionFenceSource;
  /** The immutable source revision the execution was approved to act on. */
  expected: ObservedSourceExecutionFenceExpectedHead;
  owner: ObservedSourceExecutionFenceOwner;
  now: Date;
};

export type ObservedSourceExecutionFenceAcquisition =
  | { status: "acquired" }
  | {
      status: "superseded";
      /** `null` means the source root has no readable current ledger head. */
      current: ObservedSourceExecutionFenceExpectedHead | null;
    }
  | { status: "busy"; owner: ObservedSourceExecutionFenceOwner };

/**
 * A durable observation made while a source execution fence held the mutable
 * ledger head. The newer material is deliberately not promoted to a source
 * revision until the fence is released, but it is enough to revoke permission
 * to mutate an external provider from the old head.
 */
export type ObservedSourceExecutionFenceSupersession =
  | {
      kind: "changed";
      contentHash: string;
      observedAt: string;
    }
  | { kind: "removed"; observedAt: string };

export type VerifyObservedSourceExecutionFenceHeldCurrentInput = {
  workspaceId: string;
  source: ObservedSourceExecutionFenceSource;
  expected: ObservedSourceExecutionFenceExpectedHead;
  owner: ObservedSourceExecutionFenceOwner;
};

/**
 * The exact fence owner can write only while its captured head still matches
 * and no blocked source scan has durably observed a supersession.
 */
export type ObservedSourceExecutionFenceHeldCurrent =
  | { status: "current" }
  | {
      status: "superseded";
      supersession: ObservedSourceExecutionFenceSupersession | null;
    }
  | { status: "not-held" };

export type ReleaseObservedSourceExecutionFenceInput = {
  database: Pick<LumaDatabase, "query">;
  workspaceId: string;
  source: ObservedSourceExecutionFenceSource;
  owner: ObservedSourceExecutionFenceOwner;
};

export type ReleaseObservedSourceExecutionFencesForExecutionInput = {
  database: Pick<LumaDatabase, "query">;
  workspaceId: string;
  owner: ObservedSourceExecutionFenceOwner;
};

export type ReleaseObservedSourceExecutionFencesForSettlementInput = {
  database: Pick<LumaDatabase, "query">;
  workspaceId: string;
  meetingId: string;
  intentId: string;
};

/**
 * An expected, retryable source-ingestion conflict. It is deliberately
 * provider-neutral: the ledger owns the source boundary, not the adapter.
 */
export class ObservedSourceExecutionFenceConflictError extends Error {
  readonly code = "source-execution-fenced";

  constructor(
    readonly source: ObservedSourceExecutionFenceSource,
    readonly owner: ObservedSourceExecutionFenceOwner
  ) {
    super(
      `Observed source ${source.providerId}/${source.sourceKind}/${source.sourceObjectId} is fenced by active execution ${owner.intentId}`
    );
    this.name = "ObservedSourceExecutionFenceConflictError";
  }
}

type RecordObservedSourceInputByKind = {
  [Kind in ObservedSourceKind]: {
    workspaceId: string;
    source: ObservedSourceIdentityByKind[Kind];
    providerVersion: string | null;
    snapshot: ObservedSourceSnapshotPayloadByKind[Kind];
    observedAt: string;
  };
};

export type RecordObservedSourceInput<Kind extends ObservedSourceKind = "meeting-note"> =
  RecordObservedSourceInputByKind[Kind];

export type GetObservedSourceRevisionInput<
  Kind extends ObservedSourceKind = "meeting-note"
> = {
  workspaceId: string;
  source: ObservedSourceKey<Kind>;
  revision?: number;
};

export type ListObservedSourceHeadsInput<
  Kind extends ObservedSourceKind = "meeting-note"
> = {
  workspaceId: string;
  providerId: string;
  sourceKind: Kind;
};

export type RecordObservedSourceTombstoneInput = {
  workspaceId: string;
  /**
   * The immutable head that was absent from a fully readable source scan.
   * Its revision/hash provide compare-and-set protection if the source was
   * rediscovered while that scan was completing.
   */
  previous: ObservedSourceHead<"meeting-note">;
  observedAt: string;
};

type ObservedSourceSnapshotByKind = {
  [Kind in ObservedSourceKind]: {
    source: ObservedSourceIdentityByKind[Kind];
    revision: number;
    contentHash: string;
    providerVersion: string | null;
    capturedAt: string;
    snapshot: ObservedSourceSnapshotPayloadByKind[Kind];
  };
};

export type ObservedSourceSnapshot<Kind extends ObservedSourceKind = "meeting-note"> =
  ObservedSourceSnapshotByKind[Kind];

/**
 * The mutable ledger head wrapped around an immutable snapshot. Its generation
 * advances on every successful provider observation, including an unchanged
 * content reread, and whenever a new tombstone becomes current. This prevents
 * a stale absence scan from erasing a rediscovered root.
 */
type ObservedSourceHeadByKind = {
  [Kind in ObservedSourceKind]: ObservedSourceSnapshotByKind[Kind] & {
    observationGeneration: number;
  };
};

export type ObservedSourceHead<Kind extends ObservedSourceKind = "meeting-note"> =
  ObservedSourceHeadByKind[Kind];

type ObservedSourceRevisionByKind = {
  [Kind in ObservedSourceKind]: ObservedSourceSnapshotByKind[Kind] & {
    change: "new" | "revised" | "unchanged";
  };
};

export type ObservedSourceRevision<Kind extends ObservedSourceKind = "meeting-note"> =
  ObservedSourceRevisionByKind[Kind];

export interface ObservedSourceLedger {
  record<Input extends RecordObservedSourceInput<ObservedSourceKind>>(
    input: Input
  ): Promise<ObservedSourceRevision<Input["source"]["sourceKind"]>>;
  /**
   * Atomically proves the current source head is exactly the approved head,
   * then prevents a concurrent source revision or tombstone from advancing it.
   */
  acquireExecutionFence(
    input: AcquireObservedSourceExecutionFenceInput
  ): Promise<ObservedSourceExecutionFenceAcquisition>;
  /**
   * Atomically verifies an exact fence owner, its immutable expected head,
   * and the absence of a durable blocked-scan supersession signal.
   */
  verifyExecutionFenceHeldCurrent(
    input: VerifyObservedSourceExecutionFenceHeldCurrentInput
  ): Promise<ObservedSourceExecutionFenceHeldCurrent>;
  /** Releases one exact source fence; a different execution cannot release it. */
  releaseExecutionFence(
    input: Omit<ReleaseObservedSourceExecutionFenceInput, "database">
  ): Promise<void>;
  get<Input extends GetObservedSourceRevisionInput<ObservedSourceKind>>(
    input: Input
  ): Promise<ObservedSourceSnapshot<Input["source"]["sourceKind"]> | null>;
  /** Lists immutable current heads for one provider-neutral source root family. */
  listCurrent<Input extends ListObservedSourceHeadsInput<ObservedSourceKind>>(
    input: Input
  ): Promise<ObservedSourceHead<Input["sourceKind"]>[]>;
  /**
   * Appends an immutable removal revision if this exact source head remains
   * current. `null` means a newer source revision won the race and must not be
   * overwritten by a stale absence conclusion.
   */
  recordTombstone(
    input: RecordObservedSourceTombstoneInput
  ): Promise<ObservedSourceRevision<"meeting-note"> | null>;
}

export type CreateObservedSourceLedgerInput = {
  database: LumaDatabase;
};

type SourceHeadRow = {
  current_revision: number;
  current_content_hash: string | null;
  current_observation_generation: number;
};

type SourceExecutionFenceOwnerRow = {
  meeting_id: string;
  intent_id: string;
  execution_lease_id: string;
};

type SourceExecutionFenceRow = SourceExecutionFenceOwnerRow & {
  source_revision: number;
  source_content_hash: string;
  supersession_kind: "changed" | "removed" | null;
  superseding_content_hash: string | null;
  superseded_at: string | null;
};

type SourceExecutionFenceConflict = {
  source: ObservedSourceExecutionFenceSource;
  owner: ObservedSourceExecutionFenceOwner;
};

type SourceFenceTransactionResult<T> =
  | { outcome: "recorded"; value: T }
  | { outcome: "fenced"; conflict: SourceExecutionFenceConflict };

type SourceSnapshotRow = {
  source_revision: number;
  content_hash: string;
  provider_version: string | null;
  source_reference_json: string;
  captured_at: string;
  raw_payload_json: string;
};

type SourceHeadSnapshotRow = SourceSnapshotRow & {
  source_object_id: string;
  current_observation_generation: number;
};

export function createObservedSourceLedger(
  input: CreateObservedSourceLedgerInput
): ObservedSourceLedger {
  return {
    async acquireExecutionFence(fenceInput) {
      assertMeetingNoteMutationSource(fenceInput.source);
      validateExecutionFenceExpectedHead(fenceInput.expected);
      const key = sourceKey(fenceInput);

      return input.database.transaction(async (transaction) => {
        // Every source mutation below locks this same mutable head before it
        // checks the fence. The comparison and insertion are therefore one
        // serialization point, not a best-effort preflight read.
        const headResult = await transaction.query<SourceHeadRow>(
          `SELECT current_revision, current_content_hash, current_observation_generation
             FROM observed_sources
            WHERE workspace_id = $1
              AND provider_id = $2
              AND source_kind = $3
              AND source_object_id = $4
            FOR UPDATE`,
          key
        );
        const head = headResult.rows[0];

        if (
          !head ||
          head.current_revision !== fenceInput.expected.revision ||
          head.current_content_hash !== fenceInput.expected.contentHash
        ) {
          return {
            status: "superseded" as const,
            current: sourceHeadExpectedHead(head)
          };
        }

        const existingResult = await transaction.query<SourceExecutionFenceRow>(
          `SELECT source_revision, source_content_hash,
                  supersession_kind, superseding_content_hash, superseded_at,
                  meeting_id, intent_id, execution_lease_id
             FROM observed_source_execution_fences
            WHERE workspace_id = $1
              AND provider_id = $2
              AND source_kind = $3
              AND source_object_id = $4
            FOR UPDATE`,
          key
        );
        const existing = existingResult.rows[0];

        if (!existing) {
          await transaction.query(
            `INSERT INTO observed_source_execution_fences (
               workspace_id, provider_id, source_kind, source_object_id,
               source_revision, source_content_hash,
               meeting_id, intent_id, execution_lease_id, acquired_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              ...key,
              fenceInput.expected.revision,
              fenceInput.expected.contentHash,
              fenceInput.owner.meetingId,
              fenceInput.owner.intentId,
              fenceInput.owner.executionLeaseId,
              fenceInput.now.toISOString()
            ]
          );

          return { status: "acquired" as const };
        }

        const owner = executionFenceOwner(existing);

        if (sameExecutionFenceOwner(owner, fenceInput.owner)) {
          if (
            existing.source_revision !== fenceInput.expected.revision ||
            existing.source_content_hash !== fenceInput.expected.contentHash
          ) {
            throw new Error(
              `Observed source execution fence for ${fenceInput.owner.intentId} conflicts with its immutable expected source head`
            );
          }

          if (sourceExecutionFenceSupersession(existing)) {
            return {
              status: "superseded" as const,
              current: sourceHeadExpectedHead(head)
            };
          }

          return { status: "acquired" as const };
        }

        return { status: "busy" as const, owner };
      });
    },
    async verifyExecutionFenceHeldCurrent(verificationInput) {
      assertMeetingNoteMutationSource(verificationInput.source);
      validateExecutionFenceExpectedHead(verificationInput.expected);
      const key = sourceKey(verificationInput);

      return input.database.transaction(async (transaction) => {
        // Source recording locks this head first and its fence second before
        // it can persist a supersession signal. Observe both in that same
        // order so no blocked source change can be missed between reads.
        const headResult = await transaction.query<SourceHeadRow>(
          `SELECT current_revision, current_content_hash, current_observation_generation
             FROM observed_sources
            WHERE workspace_id = $1
              AND provider_id = $2
              AND source_kind = $3
              AND source_object_id = $4
            FOR UPDATE`,
          key
        );
        const head = headResult.rows[0];

        if (
          !head ||
          head.current_revision !== verificationInput.expected.revision ||
          head.current_content_hash !== verificationInput.expected.contentHash
        ) {
          return { status: "superseded" as const, supersession: null };
        }

        const fence = await readSourceExecutionFenceForUpdate(transaction, key);

        if (
          !fence ||
          !sameExecutionFenceOwner(executionFenceOwner(fence), verificationInput.owner)
        ) {
          return { status: "not-held" as const };
        }

        if (
          fence.source_revision !== verificationInput.expected.revision ||
          fence.source_content_hash !== verificationInput.expected.contentHash
        ) {
          return { status: "not-held" as const };
        }

        const supersession = sourceExecutionFenceSupersession(fence);

        return supersession
          ? { status: "superseded" as const, supersession }
          : { status: "current" as const };
      });
    },
    async releaseExecutionFence(releaseInput): Promise<void> {
      assertMeetingNoteMutationSource(releaseInput.source);
      await releaseObservedSourceExecutionFence({
        database: input.database,
        ...releaseInput
      });
    },
    async record<Input extends RecordObservedSourceInput<ObservedSourceKind>>(
      recordInput: Input
    ): Promise<ObservedSourceRevision<Input["source"]["sourceKind"]>> {
      validateObservedSourceRecord(recordInput);
      const canonicalPayload = canonicalJson(recordInput.snapshot);
      const contentHash = observedSourceContentHash(canonicalPayload);
      const rawPayload = JSON.stringify(recordInput.snapshot);
      const sourceReference = JSON.stringify(recordInput.source);
      const result = await input.database.transaction(
        async (
          transaction
        ): Promise<
          SourceFenceTransactionResult<
            ObservedSourceRevision<Input["source"]["sourceKind"]>
          >
        > => {
          await transaction.query(
            `INSERT INTO observed_sources (
             workspace_id,
             provider_id,
             source_kind,
             source_object_id,
             parent_object_id,
             source_reference_json,
             current_revision,
             current_content_hash,
             first_observed_at,
             last_observed_at,
             last_provider_version
           )
           VALUES ($1, $2, $3, $4, $5, $6, 0, NULL, $7, $7, $8)
           ON CONFLICT (workspace_id, provider_id, source_kind, source_object_id)
           DO NOTHING`,
            [
              recordInput.workspaceId,
              recordInput.source.providerId,
              recordInput.source.sourceKind,
              recordInput.source.sourceObjectId,
              recordInput.source.parentObjectId,
              sourceReference,
              recordInput.observedAt,
              recordInput.providerVersion
            ]
          );

          const headResult = await transaction.query<SourceHeadRow>(
            `SELECT current_revision, current_content_hash, current_observation_generation
             FROM observed_sources
            WHERE workspace_id = $1
              AND provider_id = $2
              AND source_kind = $3
              AND source_object_id = $4
            FOR UPDATE`,
            sourceKey(recordInput)
          );
          const head = headResult.rows[0];

          if (!head) {
            throw new Error("Observed source head was not created");
          }

          const currentSnapshot =
            head.current_revision === 0
              ? null
              : await readObservedSourceSnapshot(
                  transaction,
                  sourceKey(recordInput),
                  head.current_revision
                );

          if (head.current_revision > 0 && !currentSnapshot) {
            throw new Error("Observed source snapshot is missing");
          }

          const currentSnapshotObservation = currentSnapshot
            ? toObservedSourceSnapshot<Input["source"]["sourceKind"]>(
                currentSnapshot,
                recordInput.source
              )
            : null;
          const currentSnapshotSource = currentSnapshotObservation?.source ?? null;

          const conflict = isMeetingNoteSource(recordInput.source)
            ? await sourceRecordExecutionFenceConflict(transaction, {
                workspaceId: recordInput.workspaceId,
                source: recordInput.source,
                head,
                observedContentHash: contentHash,
                currentSnapshotParentObjectId:
                  currentSnapshotSource?.parentObjectId ?? null,
                observedParentObjectId: recordInput.source.parentObjectId,
                observedAt: recordInput.observedAt
              })
            : null;

          if (conflict) {
            // Return normally so the durable supersession signal commits; the
            // public conflict is raised only after this local transaction.
            return { outcome: "fenced", conflict };
          }

          if (
            head.current_content_hash === contentHash &&
            currentSnapshotObservation !== null &&
            currentSnapshotSource !== null &&
            currentSnapshotSource?.parentObjectId === recordInput.source.parentObjectId
          ) {
            await transaction.query(
              `UPDATE observed_sources
                SET parent_object_id = $5,
                    source_reference_json = $6,
                    last_observed_at = $7,
                    last_provider_version = $8,
                    current_observation_generation = current_observation_generation + 1
              WHERE workspace_id = $1
                AND provider_id = $2
                AND source_kind = $3
                AND source_object_id = $4`,
              [
                ...sourceKey(recordInput),
                recordInput.source.parentObjectId,
                sourceReference,
                recordInput.observedAt,
                recordInput.providerVersion
              ]
            );
            return {
              outcome: "recorded",
              // A URL-only reread must keep the identity originally bound to
              // this immutable revision. A parent move instead mints a new
              // revision even when the captured evidence is unchanged.
              value: observedSourceRevisionFromSnapshot(
                currentSnapshotObservation,
                "unchanged"
              )
            };
          }

          const revision = head.current_revision + 1;
          await transaction.query(
            `INSERT INTO observed_source_snapshots (
             workspace_id,
             provider_id,
             source_kind,
             source_object_id,
             source_revision,
             content_hash,
             provider_version,
             source_reference_json,
             canonical_payload_json,
             raw_payload_json,
             captured_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              ...sourceKey(recordInput),
              revision,
              contentHash,
              recordInput.providerVersion,
              sourceReference,
              canonicalPayload,
              rawPayload,
              recordInput.observedAt
            ]
          );
          await transaction.query(
            `UPDATE observed_sources
              SET parent_object_id = $5,
                  source_reference_json = $6,
                  current_revision = $7,
                  current_content_hash = $8,
                  last_observed_at = $9,
                  last_provider_version = $10,
                  current_observation_generation = current_observation_generation + 1
            WHERE workspace_id = $1
              AND provider_id = $2
              AND source_kind = $3
              AND source_object_id = $4`,
            [
              ...sourceKey(recordInput),
              recordInput.source.parentObjectId,
              sourceReference,
              revision,
              contentHash,
              recordInput.observedAt,
              recordInput.providerVersion
            ]
          );

          return {
            outcome: "recorded",
            value: observedSourceRevisionFromRecord<Input["source"]["sourceKind"]>(
              recordInput as RecordObservedSourceInput<Input["source"]["sourceKind"]>,
              head.current_revision === 0 ? "new" : "revised",
              revision,
              contentHash
            )
          };
        }
      );

      if (result.outcome === "fenced") {
        throw new ObservedSourceExecutionFenceConflictError(
          result.conflict.source,
          result.conflict.owner
        );
      }

      return result.value;
    },
    async get<Input extends GetObservedSourceRevisionInput<ObservedSourceKind>>(
      getInput: Input
    ): Promise<ObservedSourceSnapshot<Input["source"]["sourceKind"]> | null> {
      if (
        getInput.revision !== undefined &&
        (!Number.isInteger(getInput.revision) || getInput.revision <= 0)
      ) {
        throw new Error("Observed source revision must be a positive integer");
      }

      const result =
        getInput.revision !== undefined
          ? await input.database.query<SourceSnapshotRow>(
              `SELECT source_revision,
                    content_hash,
                    provider_version,
                    source_reference_json,
                    captured_at,
                    raw_payload_json
               FROM observed_source_snapshots
              WHERE workspace_id = $1
                AND provider_id = $2
                AND source_kind = $3
                AND source_object_id = $4
                AND source_revision = $5`,
              [...sourceKey(getInput), getInput.revision]
            )
          : await input.database.query<SourceSnapshotRow>(
              `SELECT snapshots.source_revision,
                    snapshots.content_hash,
                    snapshots.provider_version,
                    snapshots.source_reference_json,
                    snapshots.captured_at,
                    snapshots.raw_payload_json
               FROM observed_sources AS sources
               JOIN observed_source_snapshots AS snapshots
                 ON snapshots.workspace_id = sources.workspace_id
                AND snapshots.provider_id = sources.provider_id
                AND snapshots.source_kind = sources.source_kind
                AND snapshots.source_object_id = sources.source_object_id
                AND snapshots.source_revision = sources.current_revision
              WHERE sources.workspace_id = $1
                AND sources.provider_id = $2
                AND sources.source_kind = $3
                AND sources.source_object_id = $4`,
              sourceKey(getInput)
            );
      const snapshot = result.rows[0];

      return snapshot
        ? toObservedSourceSnapshot<Input["source"]["sourceKind"]>(
            snapshot,
            getInput.source
          )
        : null;
    },
    async listCurrent<Input extends ListObservedSourceHeadsInput<ObservedSourceKind>>(
      listInput: Input
    ): Promise<ObservedSourceHead<Input["sourceKind"]>[]> {
      const result = await input.database.query<SourceHeadSnapshotRow>(
        `SELECT snapshots.source_revision,
                snapshots.content_hash,
                snapshots.provider_version,
                snapshots.source_reference_json,
                snapshots.captured_at,
                snapshots.raw_payload_json,
                sources.source_object_id,
                sources.current_observation_generation
           FROM observed_sources AS sources
           JOIN observed_source_snapshots AS snapshots
             ON snapshots.workspace_id = sources.workspace_id
            AND snapshots.provider_id = sources.provider_id
            AND snapshots.source_kind = sources.source_kind
            AND snapshots.source_object_id = sources.source_object_id
            AND snapshots.source_revision = sources.current_revision
          WHERE sources.workspace_id = $1
            AND sources.provider_id = $2
            AND sources.source_kind = $3
          ORDER BY sources.source_object_id ASC`,
        [listInput.workspaceId, listInput.providerId, listInput.sourceKind]
      );

      return result.rows.map((row) =>
        toObservedSourceHead<Input["sourceKind"]>(row, {
          providerId: listInput.providerId,
          sourceKind: listInput.sourceKind,
          sourceObjectId: row.source_object_id
        })
      );
    },
    async recordTombstone(
      tombstoneInput: RecordObservedSourceTombstoneInput
    ): Promise<ObservedSourceRevision<"meeting-note"> | null> {
      assertMeetingNoteMutationSource(tombstoneInput.previous.source);
      const sourceKeyInput = {
        workspaceId: tombstoneInput.workspaceId,
        source: tombstoneInput.previous.source
      } satisfies Pick<RecordObservedSourceInput, "workspaceId" | "source">;
      const tombstone = tombstoneSnapshot();
      const canonicalPayload = canonicalJson(tombstone);
      const contentHash = observedSourceContentHash(canonicalPayload);
      const rawPayload = JSON.stringify(tombstone);
      const sourceReference = JSON.stringify(tombstoneInput.previous.source);

      const result = await input.database.transaction(
        async (
          transaction
        ): Promise<
          SourceFenceTransactionResult<ObservedSourceRevision<"meeting-note"> | null>
        > => {
          const headResult = await transaction.query<SourceHeadRow>(
            `SELECT current_revision, current_content_hash, current_observation_generation
             FROM observed_sources
            WHERE workspace_id = $1
              AND provider_id = $2
              AND source_kind = $3
              AND source_object_id = $4
            FOR UPDATE`,
            sourceKey(sourceKeyInput)
          );
          const head = headResult.rows[0];

          // A later scan may have rediscovered this root after the complete scan
          // that inferred its absence. Never overwrite that newer observation.
          if (
            !head ||
            head.current_revision !== tombstoneInput.previous.revision ||
            head.current_content_hash !== tombstoneInput.previous.contentHash ||
            head.current_observation_generation !==
              tombstoneInput.previous.observationGeneration
          ) {
            return { outcome: "recorded", value: null };
          }

          const conflict = await sourceTombstoneExecutionFenceConflict(transaction, {
            ...sourceKeyInput,
            observedAt: tombstoneInput.observedAt
          });

          if (conflict) {
            // Return normally so the durable supersession signal commits; the
            // public conflict is raised only after this local transaction.
            return { outcome: "fenced", conflict };
          }

          if (head.current_content_hash === contentHash) {
            const snapshotResult = await transaction.query<SourceSnapshotRow>(
              `SELECT source_revision,
                    content_hash,
                    provider_version,
                    source_reference_json,
                    captured_at,
                    raw_payload_json
               FROM observed_source_snapshots
              WHERE workspace_id = $1
                AND provider_id = $2
                AND source_kind = $3
                AND source_object_id = $4
                AND source_revision = $5`,
              [...sourceKey(sourceKeyInput), head.current_revision]
            );
            const snapshot = snapshotResult.rows[0];

            if (!snapshot) {
              throw new Error("Observed source tombstone snapshot is missing");
            }

            await transaction.query(
              `UPDATE observed_sources
                SET last_observed_at = $5
              WHERE workspace_id = $1
                AND provider_id = $2
                AND source_kind = $3
                AND source_object_id = $4`,
              [...sourceKey(sourceKeyInput), tombstoneInput.observedAt]
            );

            const stored = toObservedSourceSnapshot<"meeting-note">(
              snapshot,
              tombstoneInput.previous.source
            );

            return {
              outcome: "recorded",
              value: {
                change: "unchanged",
                ...stored
              }
            };
          }

          const revision = head.current_revision + 1;
          await transaction.query(
            `INSERT INTO observed_source_snapshots (
             workspace_id,
             provider_id,
             source_kind,
             source_object_id,
             source_revision,
             content_hash,
             provider_version,
             source_reference_json,
             canonical_payload_json,
             raw_payload_json,
             captured_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10)`,
            [
              ...sourceKey(sourceKeyInput),
              revision,
              contentHash,
              sourceReference,
              canonicalPayload,
              rawPayload,
              tombstoneInput.observedAt
            ]
          );
          await transaction.query(
            `UPDATE observed_sources
              SET current_revision = $5,
                  current_content_hash = $6,
                  last_observed_at = $7,
                  last_provider_version = NULL,
                  current_observation_generation = current_observation_generation + 1
            WHERE workspace_id = $1
              AND provider_id = $2
              AND source_kind = $3
              AND source_object_id = $4`,
            [
              ...sourceKey(sourceKeyInput),
              revision,
              contentHash,
              tombstoneInput.observedAt
            ]
          );

          return {
            outcome: "recorded",
            value: {
              change: "revised",
              source: tombstoneInput.previous.source,
              revision,
              contentHash,
              providerVersion: null,
              capturedAt: tombstoneInput.observedAt,
              snapshot: tombstone
            }
          };
        }
      );

      if (result.outcome === "fenced") {
        throw new ObservedSourceExecutionFenceConflictError(
          result.conflict.source,
          result.conflict.owner
        );
      }

      return result.value;
    }
  };
}

/**
 * Deletes exactly one fenced source root. This is useful for a narrow
 * source-level recovery path; normal terminal execution cleanup should use
 * `releaseObservedSourceExecutionFencesForSettlement` inside its own durable
 * receipt transaction.
 */
export async function releaseObservedSourceExecutionFence(
  input: ReleaseObservedSourceExecutionFenceInput
): Promise<void> {
  assertMeetingNoteMutationSource(input.source);
  await input.database.query(
    `DELETE FROM observed_source_execution_fences
      WHERE workspace_id = $1
        AND provider_id = $2
        AND source_kind = $3
        AND source_object_id = $4
        AND meeting_id = $5
        AND intent_id = $6
        AND execution_lease_id = $7`,
    [
      ...sourceKey(input),
      input.owner.meetingId,
      input.owner.intentId,
      input.owner.executionLeaseId
    ]
  );
}

/**
 * Releases every source root fenced by one completed execution. It accepts a
 * query-capable transaction so Follow-up Execution can commit its canonical
 * receipt and this cleanup atomically.
 */
export async function releaseObservedSourceExecutionFencesForExecution(
  input: ReleaseObservedSourceExecutionFencesForExecutionInput
): Promise<void> {
  await input.database.query(
    `DELETE FROM observed_source_execution_fences
      WHERE workspace_id = $1
        AND meeting_id = $2
        AND intent_id = $3
        AND execution_lease_id = $4
        AND source_kind = 'meeting-note'`,
    [
      input.workspaceId,
      input.owner.meetingId,
      input.owner.intentId,
      input.owner.executionLeaseId
    ]
  );
}

/**
 * Releases every lease ever held by a settlement. Follow-up Execution uses
 * this only while serializing the terminal receipt for that settlement: a
 * manual recovery can legitimately complete under a new outer lease after an
 * interrupted earlier execution left its fence behind.
 */
export async function releaseObservedSourceExecutionFencesForSettlement(
  input: ReleaseObservedSourceExecutionFencesForSettlementInput
): Promise<void> {
  await input.database.query(
    `DELETE FROM observed_source_execution_fences
      WHERE workspace_id = $1
        AND meeting_id = $2
        AND intent_id = $3
        AND source_kind = 'meeting-note'`,
    [input.workspaceId, input.meetingId, input.intentId]
  );
}

function tombstoneSnapshot(): RawMeetingNoteSnapshot {
  return {
    schemaVersion: 1,
    // The immutable historical revision retains source material for audit.
    // The current tombstone deliberately contains only removal metadata.
    title: null,
    lifecycle: "removed",
    calendar: null,
    recording: null,
    sections: {
      summary: unavailableRemovedSection(),
      actionItemsAndNotes: unavailableRemovedSection(),
      transcript: unavailableRemovedSection()
    },
    markdown: {
      content: "",
      truncated: false,
      unknownBlockIds: []
    },
    completeness: {
      state: "removed",
      message:
        "The Meeting Notes source root was absent from a complete, fully readable canonical source scan."
    }
  };
}

function unavailableRemovedSection(): Extract<
  RawMeetingNoteSection,
  { state: "unavailable" }
> {
  return {
    state: "unavailable",
    sourceBlockId: null,
    reasons: []
  };
}

async function readObservedSourceSnapshot(
  database: Pick<LumaDatabase, "query">,
  key: [string, string, string, string],
  revision: number
): Promise<SourceSnapshotRow | null> {
  const result = await database.query<SourceSnapshotRow>(
    `SELECT source_revision,
            content_hash,
            provider_version,
            source_reference_json,
            captured_at,
            raw_payload_json
       FROM observed_source_snapshots
      WHERE workspace_id = $1
        AND provider_id = $2
        AND source_kind = $3
        AND source_object_id = $4
        AND source_revision = $5`,
    [...key, revision]
  );

  return result.rows[0] ?? null;
}

async function sourceRecordExecutionFenceConflict(
  database: Pick<LumaDatabase, "query">,
  input: {
    workspaceId: string;
    source: ObservedSourceExecutionFenceSource;
    head: SourceHeadRow;
    observedContentHash: string;
    currentSnapshotParentObjectId: string | null;
    observedParentObjectId: string | null;
    observedAt: string;
  }
): Promise<SourceExecutionFenceConflict | null> {
  const fence = await readSourceExecutionFenceForUpdate(database, sourceKey(input));

  if (!fence) {
    return null;
  }

  // A blocked scan may not advance the source head, but it must not hide a
  // newer canonical source state from the execution that installed the fence.
  // A parent-page move is material too: its parent page is the outcome target
  // even when the extracted text happens to be byte-for-byte equal. A URL-only
  // refresh is discovery metadata and does not revoke the held target.
  if (
    input.head.current_content_hash !== input.observedContentHash ||
    input.currentSnapshotParentObjectId !== input.observedParentObjectId
  ) {
    await recordSourceExecutionFenceSupersession(database, sourceKey(input), fence, {
      kind: "changed",
      contentHash: input.observedContentHash,
      observedAt: input.observedAt
    });
  }

  return {
    source: sourceFenceSource(input.source),
    owner: executionFenceOwner(fence)
  };
}

async function sourceTombstoneExecutionFenceConflict(
  database: Pick<LumaDatabase, "query">,
  input: {
    workspaceId: string;
    source: ObservedSourceExecutionFenceSource;
    observedAt: string;
  }
): Promise<SourceExecutionFenceConflict | null> {
  const fence = await readSourceExecutionFenceForUpdate(database, sourceKey(input));

  if (!fence) {
    return null;
  }

  await recordSourceExecutionFenceSupersession(database, sourceKey(input), fence, {
    kind: "removed",
    observedAt: input.observedAt
  });

  return {
    source: sourceFenceSource(input.source),
    owner: executionFenceOwner(fence)
  };
}

async function readSourceExecutionFenceForUpdate(
  database: Pick<LumaDatabase, "query">,
  key: [string, string, string, string]
): Promise<SourceExecutionFenceRow | null> {
  const result = await database.query<SourceExecutionFenceRow>(
    `SELECT source_revision, source_content_hash,
            supersession_kind, superseding_content_hash, superseded_at,
            meeting_id, intent_id, execution_lease_id
       FROM observed_source_execution_fences
      WHERE workspace_id = $1
        AND provider_id = $2
        AND source_kind = $3
        AND source_object_id = $4
      FOR UPDATE`,
    key
  );

  return result.rows[0] ?? null;
}

async function recordSourceExecutionFenceSupersession(
  database: Pick<LumaDatabase, "query">,
  key: [string, string, string, string],
  fence: SourceExecutionFenceRow,
  supersession: ObservedSourceExecutionFenceSupersession
): Promise<void> {
  // The first observed supersession is immutable enough to revoke the held
  // execution. Keeping it stable also makes a later diagnostic auditable.
  if (sourceExecutionFenceSupersession(fence)) {
    return;
  }

  await database.query(
    `UPDATE observed_source_execution_fences
        SET supersession_kind = $5,
            superseding_content_hash = $6,
            superseded_at = $7
      WHERE workspace_id = $1
        AND provider_id = $2
        AND source_kind = $3
        AND source_object_id = $4
        AND supersession_kind IS NULL`,
    [
      ...key,
      supersession.kind,
      supersession.kind === "changed" ? supersession.contentHash : null,
      supersession.observedAt
    ]
  );
}

function sourceExecutionFenceSupersession(
  fence: SourceExecutionFenceRow
): ObservedSourceExecutionFenceSupersession | null {
  if (fence.supersession_kind === "changed") {
    return {
      kind: "changed",
      // A malformed partial row is still a durable invalidation and must
      // fail closed rather than make an in-flight provider mutation safe.
      contentHash: fence.superseding_content_hash ?? "unknown",
      observedAt: fence.superseded_at ?? "unknown"
    };
  }

  if (fence.supersession_kind === "removed") {
    return { kind: "removed", observedAt: fence.superseded_at ?? "unknown" };
  }

  return null;
}

function validateExecutionFenceExpectedHead(
  expected: ObservedSourceExecutionFenceExpectedHead
): void {
  if (!Number.isInteger(expected.revision) || expected.revision <= 0) {
    throw new Error(
      "Observed source execution fence revision must be a positive integer"
    );
  }

  if (expected.contentHash.trim().length === 0) {
    throw new Error("Observed source execution fence content hash must not be blank");
  }
}

function sourceHeadExpectedHead(
  head: SourceHeadRow | undefined
): ObservedSourceExecutionFenceExpectedHead | null {
  return head && head.current_revision > 0 && head.current_content_hash !== null
    ? { revision: head.current_revision, contentHash: head.current_content_hash }
    : null;
}

function sourceFenceSource(
  source: ObservedSourceExecutionFenceSource
): ObservedSourceExecutionFenceSource {
  return {
    providerId: source.providerId,
    sourceKind: source.sourceKind,
    sourceObjectId: source.sourceObjectId
  };
}

function executionFenceOwner(
  row: SourceExecutionFenceOwnerRow
): ObservedSourceExecutionFenceOwner {
  return {
    meetingId: row.meeting_id,
    intentId: row.intent_id,
    executionLeaseId: row.execution_lease_id
  };
}

function sameExecutionFenceOwner(
  left: ObservedSourceExecutionFenceOwner,
  right: ObservedSourceExecutionFenceOwner
): boolean {
  return (
    left.meetingId === right.meetingId &&
    left.intentId === right.intentId &&
    left.executionLeaseId === right.executionLeaseId
  );
}

type ObservedSourceKeyInput = {
  workspaceId: string;
  source: ObservedSourceKey;
};

function sourceKey(input: ObservedSourceKeyInput): [string, string, string, string] {
  return [
    input.workspaceId,
    input.source.providerId,
    input.source.sourceKind,
    input.source.sourceObjectId
  ];
}

function validateObservedSourceRecord(
  input: RecordObservedSourceInput<ObservedSourceKind>
): void {
  validateObservedSourceIdentity(input.source);

  if (input.source.sourceKind === "meeting-note") {
    if (!isRawMeetingNoteSnapshot(input.snapshot)) {
      throw new Error("Observed Meeting Notes snapshot has an invalid shape");
    }
    return;
  }

  if (input.source.sourceKind === "conversation") {
    if (!isRawConversationSnapshot(input.snapshot)) {
      throw new Error("Observed conversation snapshot has an invalid shape");
    }

    validateConversationSnapshotBinding(input.source, input.snapshot);
    return;
  }

  throw new Error("Observed source kind is unsupported");
}

function toObservedSourceSnapshot<Kind extends ObservedSourceKind>(
  snapshot: SourceSnapshotRow,
  expectedSource: ObservedSourceKey<Kind>
): ObservedSourceSnapshot<Kind> {
  const source = parseObservedSourceIdentity(snapshot.source_reference_json);

  if (
    source.providerId !== expectedSource.providerId ||
    source.sourceKind !== expectedSource.sourceKind ||
    source.sourceObjectId !== expectedSource.sourceObjectId
  ) {
    throw new Error("Observed source identity does not match its stored source row");
  }

  const parsedSnapshot = parseSnapshot(source.sourceKind, snapshot.raw_payload_json);
  assertStoredSnapshotContentHash(snapshot.content_hash, parsedSnapshot);

  if (source.sourceKind === "conversation") {
    validateConversationSnapshotBinding(
      source,
      parsedSnapshot as RawConversationSnapshot
    );
  }

  return {
    source,
    revision: snapshot.source_revision,
    contentHash: snapshot.content_hash,
    providerVersion: snapshot.provider_version,
    capturedAt: snapshot.captured_at,
    snapshot: parsedSnapshot
  } as ObservedSourceSnapshot<Kind>;
}

function toObservedSourceHead<Kind extends ObservedSourceKind>(
  snapshot: SourceHeadSnapshotRow,
  expectedSource: ObservedSourceKey<Kind>
): ObservedSourceHead<Kind> {
  return {
    ...toObservedSourceSnapshot(snapshot, expectedSource),
    observationGeneration: snapshot.current_observation_generation
  } as ObservedSourceHead<Kind>;
}

function observedSourceRevisionFromSnapshot<Kind extends ObservedSourceKind>(
  snapshot: ObservedSourceSnapshot<Kind>,
  change: ObservedSourceRevision<Kind>["change"]
): ObservedSourceRevision<Kind> {
  return { ...snapshot, change } as ObservedSourceRevision<Kind>;
}

function observedSourceRevisionFromRecord<Kind extends ObservedSourceKind>(
  input: RecordObservedSourceInput<Kind>,
  change: ObservedSourceRevision<Kind>["change"],
  revision: number,
  contentHash: string
): ObservedSourceRevision<Kind> {
  return {
    change,
    source: input.source,
    revision,
    contentHash,
    providerVersion: input.providerVersion,
    capturedAt: input.observedAt,
    snapshot: input.snapshot
  } as ObservedSourceRevision<Kind>;
}

function parseSnapshot(
  sourceKind: ObservedSourceKind,
  value: string
): ObservedSourceSnapshotPayload<ObservedSourceKind> {
  const parsed: unknown = JSON.parse(value);

  if (sourceKind === "meeting-note") {
    if (!isRawMeetingNoteSnapshot(parsed)) {
      throw new Error("Observed source snapshot has an invalid stored shape");
    }
    return parsed;
  }

  if (!isRawConversationSnapshot(parsed)) {
    throw new Error("Observed source snapshot has an invalid stored shape");
  }

  return parsed;
}

function assertStoredSnapshotContentHash(
  contentHash: string,
  snapshot: ObservedSourceSnapshotPayload<ObservedSourceKind>
): void {
  if (contentHash !== observedSourceContentHash(canonicalJson(snapshot))) {
    throw new Error(
      "Observed source snapshot content hash does not match its stored payload"
    );
  }
}

function observedSourceContentHash(canonicalPayload: string): string {
  return `sha256:${createHash("sha256").update(canonicalPayload).digest("hex")}`;
}

function parseObservedSourceIdentity(
  value: string
): ObservedSourceIdentity<ObservedSourceKind> {
  const parsed: unknown = JSON.parse(value);

  if (
    !isRecord(parsed) ||
    !isNonBlankString(parsed["providerId"]) ||
    !isNonBlankString(parsed["sourceObjectId"]) ||
    !isNonBlankString(parsed["url"])
  ) {
    throw new Error("Observed source identity has an invalid stored shape");
  }

  if (parsed["sourceKind"] === "meeting-note") {
    if (
      parsed["parentObjectId"] !== null &&
      !isNonBlankString(parsed["parentObjectId"])
    ) {
      throw new Error("Observed source identity has an invalid stored shape");
    }

    return {
      providerId: parsed["providerId"],
      sourceKind: "meeting-note",
      sourceObjectId: parsed["sourceObjectId"],
      parentObjectId: parsed["parentObjectId"],
      url: parsed["url"]
    };
  }

  if (
    parsed["sourceKind"] !== "conversation" ||
    !isNonBlankString(parsed["parentObjectId"])
  ) {
    throw new Error("Observed source identity has an invalid stored shape");
  }

  return {
    providerId: parsed["providerId"],
    sourceKind: "conversation",
    sourceObjectId: parsed["sourceObjectId"],
    parentObjectId: parsed["parentObjectId"],
    url: parsed["url"]
  };
}

function validateObservedSourceIdentity(
  source: ObservedSourceIdentity<ObservedSourceKind>
): void {
  assertSupportedObservedSourceKind(source.sourceKind);

  if (
    !isNonBlankString(source.providerId) ||
    !isNonBlankString(source.sourceObjectId) ||
    !isNonBlankString(source.url) ||
    (source.parentObjectId !== null && !isNonBlankString(source.parentObjectId))
  ) {
    throw new Error("Observed source identity has an invalid shape");
  }

  if (source.sourceKind === "conversation" && !isNonBlankString(source.parentObjectId)) {
    throw new Error("Observed conversation source requires a conversation parent");
  }
}

function validateConversationSnapshotBinding(
  source: ObservedSourceIdentity<"conversation">,
  snapshot: RawConversationSnapshot
): void {
  const { boundary, messages } = snapshot;

  if (source.sourceObjectId !== boundary.anchorMessageId) {
    throw new Error("Observed conversation source must match its anchor message");
  }

  if (source.parentObjectId !== snapshot.conversation.conversationObjectId) {
    throw new Error("Observed conversation source must match its conversation parent");
  }

  if (messages.length === 0 || boundary.messageIds.length !== messages.length) {
    throw new Error("Observed conversation boundary must contain every captured message");
  }

  if (
    new Set(boundary.messageIds).size !== boundary.messageIds.length ||
    !boundary.messageIds.includes(boundary.anchorMessageId)
  ) {
    throw new Error("Observed conversation boundary has an invalid anchor message");
  }

  const first = messages[0];
  const last = messages.at(-1);

  if (
    !first ||
    !last ||
    boundary.firstMessageId !== first.id ||
    boundary.lastMessageId !== last.id
  ) {
    throw new Error(
      "Observed conversation boundary does not match captured message order"
    );
  }

  for (const [index, message] of messages.entries()) {
    if (message.ordinal !== index || boundary.messageIds[index] !== message.id) {
      throw new Error("Observed conversation boundary does not match captured messages");
    }
  }
}

function isRawMeetingNoteSnapshot(value: unknown): value is RawMeetingNoteSnapshot {
  // Schema version alone is no longer a sufficient discriminator: bounded
  // conversations use the same version and must never inherit Meeting Notes'
  // execution-fence or tombstone authority through an untyped caller.
  return (
    isRecord(value) && value["schemaVersion"] === 1 && !isRawConversationSnapshot(value)
  );
}

function isRawConversationSnapshot(value: unknown): value is RawConversationSnapshot {
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== 1 ||
    !isRawConversation(value["conversation"]) ||
    !isRawConversationBoundary(value["boundary"]) ||
    !Array.isArray(value["messages"]) ||
    !Array.from(value["messages"]).every(isRawConversationMessage) ||
    !isRawConversationCompleteness(value["completeness"])
  ) {
    return false;
  }

  return true;
}

function isRawConversation(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonBlankString(value["conversationObjectId"]) &&
    (value["parentConversationObjectId"] === null ||
      isNonBlankString(value["parentConversationObjectId"])) &&
    (value["title"] === null || typeof value["title"] === "string") &&
    isNonBlankString(value["url"])
  );
}

function isRawConversationBoundary(value: unknown): boolean {
  return (
    isRecord(value) &&
    value["mode"] === "thread" &&
    isNonBlankString(value["anchorMessageId"]) &&
    isNonBlankString(value["firstMessageId"]) &&
    isNonBlankString(value["lastMessageId"]) &&
    Array.isArray(value["messageIds"]) &&
    Array.from(value["messageIds"]).every(isNonBlankString)
  );
}

function isRawConversationMessage(value: unknown): value is RawConversationMessage {
  if (
    !isRecord(value) ||
    !isNonBlankString(value["id"]) ||
    !Number.isInteger(value["ordinal"]) ||
    (value["ordinal"] as number) < 0 ||
    !isRawConversationAuthor(value["author"]) ||
    !isNonBlankString(value["createdAt"]) ||
    (value["editedAt"] !== null && !isNonBlankString(value["editedAt"])) ||
    (value["replyToMessageId"] !== null &&
      !isNonBlankString(value["replyToMessageId"])) ||
    !isNonBlankString(value["url"])
  ) {
    return false;
  }

  return (
    (value["state"] === "available" && typeof value["text"] === "string") ||
    (value["state"] === "deleted" && value["text"] === null)
  );
}

function isRawConversationAuthor(value: unknown): value is RawConversationAuthor {
  return (
    isRecord(value) &&
    isNonBlankString(value["providerUserId"]) &&
    isNonBlankString(value["displayName"]) &&
    (value["personId"] === undefined ||
      value["personId"] === null ||
      isNonBlankString(value["personId"]))
  );
}

function isRawConversationCompleteness(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  if (value["state"] === "complete") {
    return true;
  }

  return (
    value["state"] === "partial" &&
    Array.isArray(value["reasons"]) &&
    value["reasons"].length > 0 &&
    Array.from(value["reasons"]).every(isConversationSourcePartialReason)
  );
}

function isConversationSourcePartialReason(
  value: unknown
): value is ConversationSourcePartialReason {
  return (
    isRecord(value) &&
    (value["code"] === "history-truncated" ||
      value["code"] === "message-content-unavailable" ||
      value["code"] === "message-fetch-failed" ||
      value["code"] === "pagination-incomplete" ||
      value["code"] === "thread-not-readable" ||
      value["code"] === "unknown-provider-shape") &&
    isNonBlankString(value["message"]) &&
    (value["messageId"] === undefined || isNonBlankString(value["messageId"]))
  );
}

function isMeetingNoteSource(
  source: ObservedSourceIdentity<ObservedSourceKind>
): source is ObservedSourceIdentity<"meeting-note"> {
  return source.sourceKind === "meeting-note";
}

function assertSupportedObservedSourceKind(
  sourceKind: unknown
): asserts sourceKind is ObservedSourceKind {
  if (sourceKind !== "meeting-note" && sourceKind !== "conversation") {
    throw new Error("Observed source kind is unsupported");
  }
}

/**
 * Fences and tombstones authorize external Operational Outcome mutations.
 * Keep their runtime boundary narrow even when an untyped caller bypasses the
 * public TypeScript contract.
 */
function assertMeetingNoteMutationSource(
  source: unknown
): asserts source is ObservedSourceExecutionFenceSource {
  if (
    !isRecord(source) ||
    source["sourceKind"] !== "meeting-note" ||
    !isNonBlankString(source["providerId"]) ||
    !isNonBlankString(source["sourceObjectId"])
  ) {
    throw new Error(
      "Observed source fence and tombstone APIs support only valid meeting-note roots"
    );
  }
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical source payload contains an unsupported number");
    }
    return JSON.stringify(value);
  }

  if (
    typeof value === "undefined" ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new Error("Canonical source payload contains an unsupported value");
  }

  if (Array.isArray(value)) {
    // JSON.stringify writes an undefined array element as null. Match that
    // durable representation so a valid input can be replayed by hash.
    return `[${Array.from(value, (element) =>
      canonicalJson(element === undefined ? null : element)
    ).join(",")}]`;
  }

  if (!isRecord(value)) {
    throw new Error("Canonical source payload contains an unsupported value");
  }

  return `{${Object.keys(value)
    .sort()
    // JSON.stringify omits undefined object properties. Optional capture
    // fields use that representation when an adapter has no value.
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
