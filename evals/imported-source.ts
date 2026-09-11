import type { MeetingImportedFromSource } from "../src/domain/model.js";
import {
  importedActionItemCompletionFor,
  importedActionItemDeadlineFor,
  importedActionItemLanguageFor,
  importedActionItemModalityFor,
  importedActionItemOwnershipFor,
  importedActionItemSourceOwnerFor
} from "../src/domain/imported-action-item-semantics.js";
import {
  importedSourceCandidateEvidence,
  importedSourceCandidateId,
  importedSourceCandidateLineageKey,
  importedSourceObservationId,
  importedSourceSectionEvidence
} from "../src/domain/imported-source-provenance.js";

/** Synthetic source adapter. It does not establish a production Notion ledger proof. */
export function importedObservation(
  workspaceId: string,
  meetingId: string,
  text: string,
  at: string
): MeetingImportedFromSource {
  const source: MeetingImportedFromSource["source"] = {
    providerId: "notion",
    sourceKind: "meeting-note",
    sourceObjectId: "eval-source",
    parentObjectId: "eval-page",
    sourceRevision: 1,
    contentHash: "sha256:synthetic-source",
    providerVersion: at,
    title: "Synthetic evaluation source",
    externalReference: {
      providerId: "notion",
      objectType: "document",
      externalId: "eval-page",
      url: "https://example.invalid/eval-page",
      version: at
    },
    workItemProviderId: "linear",
    implementationReferenceProviderId: "github-code",
    completeness: "complete",
    completenessReasons: [],
    actionItemsAvailability: "available",
    deadlineReferenceAt: at,
    capturedAt: at
  };
  const sourceSections: MeetingImportedFromSource["sourceSections"] = [
    {
      section: "summary",
      sourceBlockId: "summary",
      excerpt: "Synthetic evaluation meeting."
    },
    { section: "action-items-and-notes", sourceBlockId: "actions", excerpt: text },
    { section: "transcript", sourceBlockId: "transcript", excerpt: text }
  ];
  const candidateSource: MeetingImportedFromSource["candidates"][number]["source"] = {
    source,
    sourceBlockId: "action",
    sourceSection: "action-items-and-notes",
    sourceExcerpt: text
  };
  const evidence = importedSourceCandidateEvidence(source, candidateSource);
  const completion = importedActionItemCompletionFor(text, "open");
  return {
    type: "meeting-imported-from-source",
    observationId: importedSourceObservationId(source),
    workspaceId,
    meetingId,
    occurredAt: at,
    observedAt: at,
    source,
    sourceSections,
    actionItemBlocks: [{ sourceBlockId: "action", excerpt: text, completion }],
    evidence: [
      ...sourceSections.map((section) => importedSourceSectionEvidence(source, section)),
      evidence
    ],
    candidates: [
      {
        id: importedSourceCandidateId(source, "action"),
        lineageKey: importedSourceCandidateLineageKey(source, "action"),
        originalText: text,
        description: text,
        language: importedActionItemLanguageFor(text),
        modality: importedActionItemModalityFor(text),
        completion,
        sourceOwner: importedActionItemSourceOwnerFor(text),
        ownership: importedActionItemOwnershipFor(text),
        deadline: importedActionItemDeadlineFor(text, "Europe/Berlin", at),
        mentionedWorkItemReferences: [
          { providerId: "linear", objectType: "work-item", externalId: "LUM-3" }
        ],
        sourceBoundImplementationReferences: [],
        projectHints: [],
        componentHints: [],
        source: candidateSource,
        evidence: [evidence]
      }
    ]
  };
}
