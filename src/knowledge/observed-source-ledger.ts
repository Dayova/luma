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

export type ObservedSourceIdentity = {
  providerId: string;
  sourceKind: "meeting-note";
  sourceObjectId: string;
  parentObjectId: string | null;
  url: string;
};

export type RecordObservedSourceInput = {
  workspaceId: string;
  source: ObservedSourceIdentity;
  providerVersion: string | null;
  snapshot: RawMeetingNoteSnapshot;
  observedAt: string;
};

export type GetObservedSourceRevisionInput = {
  workspaceId: string;
  source: Pick<ObservedSourceIdentity, "providerId" | "sourceKind" | "sourceObjectId">;
  revision?: number;
};

export type ListObservedSourceHeadsInput = {
  workspaceId: string;
  providerId: string;
  sourceKind: "meeting-note";
};

export type RecordObservedSourceTombstoneInput = {
  workspaceId: string;
  /**
   * The immutable head that was absent from a fully readable source scan.
   * Its revision/hash provide compare-and-set protection if the source was
   * rediscovered while that scan was completing.
   */
  previous: ObservedSourceHead;
  observedAt: string;
};

export type ObservedSourceSnapshot = {
  source: ObservedSourceIdentity;
  revision: number;
  contentHash: string;
  providerVersion: string | null;
  capturedAt: string;
  snapshot: RawMeetingNoteSnapshot;
};

/**
 * The mutable ledger head wrapped around an immutable snapshot. Its generation
 * advances on every successful provider observation, including an unchanged
 * content reread, so a stale absence scan cannot erase a rediscovered root.
 */
export type ObservedSourceHead = ObservedSourceSnapshot & {
  observationGeneration: number;
};

export type ObservedSourceRevision = ObservedSourceSnapshot & {
  change: "new" | "revised" | "unchanged";
};

export interface ObservedSourceLedger {
  record(input: RecordObservedSourceInput): Promise<ObservedSourceRevision>;
  get(input: GetObservedSourceRevisionInput): Promise<ObservedSourceSnapshot | null>;
  /** Lists immutable current heads for one provider-neutral source root family. */
  listCurrent(input: ListObservedSourceHeadsInput): Promise<ObservedSourceHead[]>;
  /**
   * Appends an immutable removal revision if this exact source head remains
   * current. `null` means a newer source revision won the race and must not be
   * overwritten by a stale absence conclusion.
   */
  recordTombstone(
    input: RecordObservedSourceTombstoneInput
  ): Promise<ObservedSourceRevision | null>;
}

export type CreateObservedSourceLedgerInput = {
  database: LumaDatabase;
};

type SourceHeadRow = {
  current_revision: number;
  current_content_hash: string | null;
  current_observation_generation: number;
};

type SourceSnapshotRow = {
  source_revision: number;
  content_hash: string;
  provider_version: string | null;
  source_reference_json: string;
  captured_at: string;
  raw_payload_json: string;
};

type SourceHeadSnapshotRow = SourceSnapshotRow & {
  current_observation_generation: number;
};

export function createObservedSourceLedger(
  input: CreateObservedSourceLedgerInput
): ObservedSourceLedger {
  return {
    async record(recordInput) {
      const canonicalPayload = canonicalJson(recordInput.snapshot);
      const contentHash = `sha256:${createHash("sha256")
        .update(canonicalPayload)
        .digest("hex")}`;
      const rawPayload = JSON.stringify(recordInput.snapshot);
      const sourceReference = JSON.stringify(recordInput.source);

      return input.database.transaction(async (transaction) => {
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

        if (head.current_content_hash === contentHash) {
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
            [...sourceKey(recordInput), head.current_revision]
          );
          const snapshot = snapshotResult.rows[0];

          if (!snapshot) {
            throw new Error("Observed source snapshot is missing");
          }

          return {
            change: "unchanged",
            // A metadata-only reread must keep the identity originally bound
            // to this immutable revision. The mutable source head is still
            // refreshed above for future discovery metadata.
            source: parseObservedSourceIdentity(snapshot.source_reference_json),
            revision: snapshot.source_revision,
            contentHash: snapshot.content_hash,
            providerVersion: snapshot.provider_version,
            capturedAt: snapshot.captured_at,
            snapshot: parseSnapshot(snapshot.raw_payload_json)
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
          change: head.current_revision === 0 ? "new" : "revised",
          source: recordInput.source,
          revision,
          contentHash,
          providerVersion: recordInput.providerVersion,
          capturedAt: recordInput.observedAt,
          snapshot: recordInput.snapshot
        };
      });
    },
    async get(getInput): Promise<ObservedSourceSnapshot | null> {
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

      return snapshot ? toObservedSourceSnapshot(snapshot) : null;
    },
    async listCurrent(listInput): Promise<ObservedSourceHead[]> {
      const result = await input.database.query<SourceHeadSnapshotRow>(
        `SELECT snapshots.source_revision,
                snapshots.content_hash,
                snapshots.provider_version,
                snapshots.source_reference_json,
                snapshots.captured_at,
                snapshots.raw_payload_json,
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

      return result.rows.map(toObservedSourceHead);
    },
    async recordTombstone(tombstoneInput): Promise<ObservedSourceRevision | null> {
      const sourceKeyInput = {
        workspaceId: tombstoneInput.workspaceId,
        source: tombstoneInput.previous.source
      } satisfies Pick<RecordObservedSourceInput, "workspaceId" | "source">;
      const tombstone = tombstoneSnapshot(tombstoneInput.previous);
      const canonicalPayload = canonicalJson(tombstone);
      const contentHash = `sha256:${createHash("sha256")
        .update(canonicalPayload)
        .digest("hex")}`;
      const rawPayload = JSON.stringify(tombstone);
      const sourceReference = JSON.stringify(tombstoneInput.previous.source);

      return input.database.transaction(async (transaction) => {
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
          return null;
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
                SET last_observed_at = $5,
                    current_observation_generation = current_observation_generation + 1
              WHERE workspace_id = $1
                AND provider_id = $2
                AND source_kind = $3
                AND source_object_id = $4`,
            [...sourceKey(sourceKeyInput), tombstoneInput.observedAt]
          );

          return {
            change: "unchanged",
            source: parseObservedSourceIdentity(snapshot.source_reference_json),
            revision: snapshot.source_revision,
            contentHash: snapshot.content_hash,
            providerVersion: snapshot.provider_version,
            capturedAt: snapshot.captured_at,
            snapshot: parseSnapshot(snapshot.raw_payload_json)
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
          [...sourceKey(sourceKeyInput), revision, contentHash, tombstoneInput.observedAt]
        );

        return {
          change: "revised",
          source: tombstoneInput.previous.source,
          revision,
          contentHash,
          providerVersion: null,
          capturedAt: tombstoneInput.observedAt,
          snapshot: tombstone
        };
      });
    }
  };
}

function tombstoneSnapshot(previous: ObservedSourceHead): RawMeetingNoteSnapshot {
  return {
    schemaVersion: 1,
    // Keep descriptive, non-actionable metadata for auditability. No original
    // source material is carried into the tombstone revision.
    title: previous.snapshot.title,
    lifecycle: "removed",
    calendar: previous.snapshot.calendar,
    recording: previous.snapshot.recording,
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

function sourceKey(
  input:
    | Pick<RecordObservedSourceInput, "workspaceId" | "source">
    | GetObservedSourceRevisionInput
): [string, string, string, string] {
  return [
    input.workspaceId,
    input.source.providerId,
    input.source.sourceKind,
    input.source.sourceObjectId
  ];
}

function parseSnapshot(value: string): RawMeetingNoteSnapshot {
  const parsed: unknown = JSON.parse(value);

  if (!isRawMeetingNoteSnapshot(parsed)) {
    throw new Error("Observed source snapshot has an invalid stored shape");
  }

  return parsed;
}

function toObservedSourceSnapshot(snapshot: SourceSnapshotRow): ObservedSourceSnapshot {
  return {
    source: parseObservedSourceIdentity(snapshot.source_reference_json),
    revision: snapshot.source_revision,
    contentHash: snapshot.content_hash,
    providerVersion: snapshot.provider_version,
    capturedAt: snapshot.captured_at,
    snapshot: parseSnapshot(snapshot.raw_payload_json)
  };
}

function toObservedSourceHead(snapshot: SourceHeadSnapshotRow): ObservedSourceHead {
  return {
    ...toObservedSourceSnapshot(snapshot),
    observationGeneration: snapshot.current_observation_generation
  };
}

function parseObservedSourceIdentity(value: string): ObservedSourceIdentity {
  const parsed: unknown = JSON.parse(value);

  if (
    !isRecord(parsed) ||
    typeof parsed["providerId"] !== "string" ||
    parsed["sourceKind"] !== "meeting-note" ||
    typeof parsed["sourceObjectId"] !== "string" ||
    (parsed["parentObjectId"] !== null && typeof parsed["parentObjectId"] !== "string") ||
    typeof parsed["url"] !== "string"
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

function isRawMeetingNoteSnapshot(value: unknown): value is RawMeetingNoteSnapshot {
  return isRecord(value) && value["schemaVersion"] === 1;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (!isRecord(value)) {
    throw new Error("Canonical source payload contains an unsupported value");
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
