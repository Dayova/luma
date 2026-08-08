import { describe, expect, it } from "vitest";
import {
  importedSourceCandidateEvidence,
  importedSourceCandidateEvidenceId,
  importedSourceCandidateId,
  importedSourceCandidateLineageKey,
  importedSourceMeetingId,
  importedSourceObservationId,
  importedSourceSectionEvidence,
  importedSourceSectionEvidenceId
} from "../../src/domain/imported-source-provenance.js";
import type {
  ImportedActionItemCandidate,
  ImportedMeetingSource,
  ImportedMeetingSourceSection
} from "../../src/domain/model.js";

const source: ImportedMeetingSource = {
  providerId: "notion:internal",
  sourceKind: "meeting-note",
  sourceObjectId: "meeting:notes/root",
  parentObjectId: "page:product-sync",
  sourceRevision: 7,
  contentHash: "sha256:source-v7",
  providerVersion: "2026-08-08T10:00:00.000Z",
  title: "Product sync",
  externalReference: {
    providerId: "notion:internal",
    objectType: "document",
    externalId: "page:product-sync",
    url: "https://notion.so/product-sync",
    version: "2026-08-08T10:00:00.000Z"
  },
  workItemProviderId: "linear",
  completeness: "complete",
  completenessReasons: [],
  actionItemsAvailability: "available",
  deadlineReferenceAt: "2026-08-08T10:00:00.000Z",
  capturedAt: "2026-08-08T10:01:00.000Z"
};

describe("imported source provenance", () => {
  it("derives opaque-safe identities and evidence from the immutable source revision", () => {
    const section: ImportedMeetingSourceSection = {
      section: "transcript",
      sourceBlockId: "transcript:block/one",
      excerpt: "The source observation is immutable."
    };
    const candidate = {
      source: {
        source,
        sourceBlockId: "action:block/one",
        sourceSection: "action-items-and-notes" as const,
        sourceExcerpt: "Jakob will review LUM-3."
      }
    } satisfies Pick<ImportedActionItemCandidate, "source">;

    expect(importedSourceMeetingId(source)).toBe(
      "meeting:source:notion%3Ainternal:meeting%3Anotes%2Froot"
    );
    expect(importedSourceObservationId(source)).toBe(
      "meeting-note-import:notion%3Ainternal:meeting%3Anotes%2Froot:r7"
    );
    expect(importedSourceCandidateId(source, candidate.source.sourceBlockId)).toBe(
      "candidate:notion%3Ainternal:meeting%3Anotes%2Froot:r7:block:action%3Ablock%2Fone"
    );
    expect(
      importedSourceCandidateLineageKey(source, candidate.source.sourceBlockId)
    ).toBe(
      "candidate:notion%3Ainternal:meeting%3Anotes%2Froot:block:action%3Ablock%2Fone"
    );
    expect(importedSourceSectionEvidenceId(source, section.section)).toBe(
      "evidence:meeting-note:notion%3Ainternal:meeting%3Anotes%2Froot:r7:section:transcript"
    );
    expect(
      importedSourceCandidateEvidenceId(source, candidate.source.sourceBlockId)
    ).toBe(
      "evidence:meeting-note:notion%3Ainternal:meeting%3Anotes%2Froot:r7:block:action%3Ablock%2Fone"
    );
    expect(importedSourceSectionEvidence(source, section)).toEqual({
      evidenceId:
        "evidence:meeting-note:notion%3Ainternal:meeting%3Anotes%2Froot:r7:section:transcript",
      source: "transcript",
      sourceObjectId: "transcript:block/one",
      sourceVersion: "r7:sha256:source-v7",
      excerpt: "The source observation is immutable.",
      externalReference: source.externalReference
    });
    expect(importedSourceCandidateEvidence(source, candidate.source)).toEqual({
      evidenceId:
        "evidence:meeting-note:notion%3Ainternal:meeting%3Anotes%2Froot:r7:block:action%3Ablock%2Fone",
      source: "knowledge",
      sourceObjectId: "action:block/one",
      sourceVersion: "r7:sha256:source-v7",
      excerpt: "Jakob will review LUM-3.",
      externalReference: source.externalReference
    });
  });
});
