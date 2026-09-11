import type { ContextAudience } from "../organizational-context/interface.js";
import type { ImportedMeetingSource } from "../domain/model.js";
import {
  ImportedSourceUnavailableError,
  type ImportedSourceAnalysisAccess
} from "../meeting-intelligence/imported-source-analysis.js";
import type { MeetingNoteEvidenceSource } from "../native-review/source-bound-native-review.js";
import type { ObservedSourceLedger } from "./observed-source-ledger.js";

/** Provider reads and sharing policy stay outside Meeting Intelligence. */
export function createGrantedImportedSourceAnalysisAccess(input: {
  ledger: Pick<ObservedSourceLedger, "get">;
  authorize(request: {
    source: ImportedMeetingSource;
    audience: ContextAudience;
  }): Promise<boolean>;
  /** The factory must bind a dedicated read capability to the exact requested page. */
  evidenceSource(source: ImportedMeetingSource): MeetingNoteEvidenceSource | null;
}): ImportedSourceAnalysisAccess {
  return {
    async requireCurrent(request) {
      const bound = structuredClone(request);
      try {
        if (
          !bound.audience.personIds.length ||
          !bound.source.parentObjectId ||
          !(await input.authorize(structuredClone(bound)))
        )
          throw new ImportedSourceUnavailableError();
        const current = await input.ledger.get({
          workspaceId: bound.audience.workspaceId,
          source: {
            providerId: bound.source.providerId,
            sourceKind: "meeting-note",
            sourceObjectId: bound.source.sourceObjectId
          }
        });
        if (
          !current ||
          current.revision !== bound.source.sourceRevision ||
          current.contentHash !== bound.source.contentHash ||
          current.source.parentObjectId !== bound.source.parentObjectId ||
          current.snapshot.lifecycle !== "ready" ||
          current.snapshot.completeness.state !== "complete"
        )
          throw new ImportedSourceUnavailableError();
        const reader = input.evidenceSource(structuredClone(bound.source));
        if (!reader) throw new ImportedSourceUnavailableError();
        const capture = await reader.capture({
          workspaceId: bound.audience.workspaceId,
          page: {
            providerId: bound.source.providerId,
            pageId: bound.source.parentObjectId
          }
        });
        if (
          capture.status !== "captured" ||
          capture.evidence.source.providerId !== current.source.providerId ||
          capture.evidence.source.sourceObjectId !== current.source.sourceObjectId ||
          capture.evidence.source.parentObjectId !== current.source.parentObjectId ||
          canonicalJson(capture.evidence.snapshot) !== canonicalJson(current.snapshot)
        )
          throw new ImportedSourceUnavailableError();
        const finalHead = await input.ledger.get({
          workspaceId: bound.audience.workspaceId,
          source: {
            providerId: bound.source.providerId,
            sourceKind: "meeting-note",
            sourceObjectId: bound.source.sourceObjectId
          }
        });
        if (
          !finalHead ||
          finalHead.revision !== current.revision ||
          finalHead.contentHash !== current.contentHash ||
          !(await input.authorize(structuredClone(bound)))
        )
          throw new ImportedSourceUnavailableError();
      } catch {
        throw new ImportedSourceUnavailableError();
      }
    }
  };
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}
