import { isDeepStrictEqual } from "node:util";
import type { LumaDatabase } from "../persistence/db.js";
import type { MeetingCaptureAccess } from "../meeting-intelligence/meeting-capture-access.js";
import {
  ImportedSourceUnavailableError,
  readImportedSourceAnalysisReceipt,
  type ImportedSourceAnalysisAccess
} from "../meeting-intelligence/imported-source-analysis.js";
import type { ObservedSourceLedger } from "./observed-source-ledger.js";
import { observedNotionMeetingCapture } from "./notion-meeting-capture.js";
import { opaqueIdentifierSegment } from "../domain/opaque-id.js";

/** Reuses the exact Notion archive and immutable original MI source grants. */
export function createNotionMeetingCaptureAccess(input: {
  database: LumaDatabase;
  ledger: ObservedSourceLedger;
  sourceAccess: ImportedSourceAnalysisAccess;
  providerId: string;
  canonicalSourceScopeId: string;
  /** The configured read credential scope; a replacement must not inherit old Human dependencies. */
  authorizationScopeId: string;
}): MeetingCaptureAccess {
  if (
    ![input.providerId, input.canonicalSourceScopeId, input.authorizationScopeId].every(
      (value) => value.trim()
    )
  )
    throw new ImportedSourceUnavailableError();
  return {
    async readCurrent({ workspaceId, capture, audience }) {
      const address = capture.address,
        revision = capture.latestRevision;
      if (
        address.providerId !== input.providerId ||
        address.providerConnectionId !== input.canonicalSourceScopeId ||
        address.sourceKind !== "meeting-note" ||
        audience.workspaceId !== workspaceId
      )
        throw new ImportedSourceUnavailableError();
      const source = await input.ledger.get({
        workspaceId,
        source: {
          providerId: input.providerId,
          sourceKind: "meeting-note",
          sourceObjectId: address.externalCaptureId
        }
      });
      if (
        !source ||
        !isDeepStrictEqual(
          observedNotionMeetingCapture({
            source: { ...source, change: "unchanged" },
            canonicalSourceScopeId: input.canonicalSourceScopeId
          }),
          revision
        )
      )
        throw new ImportedSourceUnavailableError();
      const meetingId = `meeting:source:${opaqueIdentifierSegment(input.providerId)}:${opaqueIdentifierSegment(address.externalCaptureId)}`;
      const stored = await input.database.query<{ receipt_id: string }>(
        "SELECT receipt_id FROM meeting_imported_source_receipts WHERE workspace_id=$1 AND meeting_id=$2 AND receipt_json::jsonb->'source'->>'sourceRevision'=$3 AND receipt_json::jsonb->'source'->>'contentHash'=$4 LIMIT 2",
        [workspaceId, meetingId, String(source.revision), source.contentHash]
      );
      if (stored.rows.length !== 1) throw new ImportedSourceUnavailableError();
      const verified = await readImportedSourceAnalysisReceipt(
        input.database,
        workspaceId,
        meetingId,
        stored.rows[0]!.receipt_id
      );
      const receipt = [verified].find(
        (value) =>
          value.source.providerId === input.providerId &&
          value.source.sourceObjectId === address.externalCaptureId &&
          value.source.sourceRevision === source.revision &&
          value.source.contentHash === source.contentHash &&
          value.audience.workspaceId === workspaceId &&
          audience.personIds.length > 0 &&
          audience.personIds.every((person) => value.audience.personIds.includes(person))
      );
      if (!receipt) throw new ImportedSourceUnavailableError();
      await input.sourceAccess.requireCurrent({ source: receipt.source, audience });
      const materials = revision.materials.map((descriptor) => {
        const section = Object.values(source.snapshot.sections).find(
          (value) =>
            value.state === "available" &&
            value.sourceBlockId === descriptor.sourceObjectId
        );
        const text =
          descriptor.kind === "calendar-metadata"
            ? JSON.stringify(source.snapshot.calendar)
            : descriptor.kind === "attendees"
              ? JSON.stringify(source.snapshot.calendar?.attendeeProviderUserIds ?? [])
              : section?.state === "available"
                ? section.text
                : null;
        if (!text?.trim()) throw new ImportedSourceUnavailableError();
        return { descriptor, text };
      });
      await input.sourceAccess.requireCurrent({ source: receipt.source, audience });
      const latest = await input.ledger.get({
        workspaceId,
        source: {
          providerId: input.providerId,
          sourceKind: "meeting-note",
          sourceObjectId: address.externalCaptureId
        }
      });
      if (
        latest?.revision !== source.revision ||
        latest.contentHash !== source.contentHash
      )
        throw new ImportedSourceUnavailableError();
      return {
        authorizationScopeId: input.authorizationScopeId,
        canonicalAnchorRef: revision.externalReference,
        materials
      };
    }
  };
}
