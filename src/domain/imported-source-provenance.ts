import type {
  EvidenceReference,
  ImportedActionItemCandidate,
  ImportedMeetingSource,
  ImportedMeetingSourceSection,
  MeetingId
} from "./model.js";
import { opaqueIdentifierSegment } from "./opaque-id.js";

/**
 * The stable identities and evidence grammar for one immutable Meeting Notes
 * source revision. Ingestion uses these values to construct an Observation;
 * Meeting Intelligence uses the same values to verify that Observation.
 */
export function importedSourceMeetingId(source: ImportedMeetingSource): MeetingId {
  return `meeting:source:${opaqueIdentifierSegment(source.providerId)}:${opaqueIdentifierSegment(source.sourceObjectId)}`;
}

export function importedSourceObservationId(source: ImportedMeetingSource): string {
  return `meeting-note-import:${opaqueIdentifierSegment(source.providerId)}:${opaqueIdentifierSegment(source.sourceObjectId)}:r${source.sourceRevision}`;
}

export function importedSourceCandidateId(
  source: ImportedMeetingSource,
  sourceBlockId: string
): string {
  return `candidate:${opaqueIdentifierSegment(source.providerId)}:${opaqueIdentifierSegment(source.sourceObjectId)}:r${source.sourceRevision}:block:${opaqueIdentifierSegment(sourceBlockId)}`;
}

export function importedSourceCandidateLineageKey(
  source: ImportedMeetingSource,
  sourceBlockId: string
): string {
  return `candidate:${opaqueIdentifierSegment(source.providerId)}:${opaqueIdentifierSegment(source.sourceObjectId)}:block:${opaqueIdentifierSegment(sourceBlockId)}`;
}

export function importedSourceSectionEvidenceId(
  source: ImportedMeetingSource,
  section: ImportedMeetingSourceSection["section"]
): string {
  return `evidence:meeting-note:${opaqueIdentifierSegment(source.providerId)}:${opaqueIdentifierSegment(source.sourceObjectId)}:r${source.sourceRevision}:section:${section}`;
}

export function importedSourceCandidateEvidenceId(
  source: ImportedMeetingSource,
  sourceBlockId: string
): string {
  return `evidence:meeting-note:${opaqueIdentifierSegment(source.providerId)}:${opaqueIdentifierSegment(source.sourceObjectId)}:r${source.sourceRevision}:block:${opaqueIdentifierSegment(sourceBlockId)}`;
}

export function importedSourceSectionEvidence(
  source: ImportedMeetingSource,
  section: ImportedMeetingSourceSection
): EvidenceReference {
  return {
    evidenceId: importedSourceSectionEvidenceId(source, section.section),
    source: section.section === "transcript" ? "transcript" : "knowledge",
    sourceObjectId: section.sourceBlockId,
    sourceVersion: `r${source.sourceRevision}:${source.contentHash}`,
    excerpt: section.excerpt,
    externalReference: source.externalReference
  };
}

export function importedSourceCandidateEvidence(
  source: ImportedMeetingSource,
  candidateSource: ImportedActionItemCandidate["source"]
): EvidenceReference {
  return {
    evidenceId: importedSourceCandidateEvidenceId(source, candidateSource.sourceBlockId),
    source: "knowledge",
    sourceObjectId: candidateSource.sourceBlockId,
    sourceVersion: `r${source.sourceRevision}:${source.contentHash}`,
    excerpt: candidateSource.sourceExcerpt,
    externalReference: source.externalReference
  };
}
