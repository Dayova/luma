import type {
  EvidenceReference,
  ImportedActionItemCandidate,
  ImportedActionItemSourceBlock,
  ImportedMeetingSource,
  ImportedMeetingSourceSection,
  ImportedWorkItemReference,
  MeetingImportedFromSource,
  WorkspaceConfig
} from "../domain/model.js";
import {
  importedSourceCandidateEvidence,
  importedSourceCandidateId,
  importedSourceCandidateLineageKey,
  importedSourceMeetingId,
  importedSourceObservationId,
  importedSourceSectionEvidence,
  importedSourceSectionEvidenceId
} from "../domain/imported-source-provenance.js";
import {
  importedActionItemDeadlineFor,
  importedActionItemDeadlineReferenceAt,
  importedActionItemLanguageFor,
  importedActionItemModalityFor,
  importedActionItemOwnerFor,
  mentionedWorkItemExternalIdsFor
} from "../domain/imported-action-item-semantics.js";
import type {
  MeetingIntelligence,
  MeetingUpdate
} from "../meeting-intelligence/interface.js";
import type {
  CapturedMeetingNoteBlock,
  ObservedSourceRevision,
  RawMeetingNoteSection
} from "./observed-source-ledger.js";

export type IngestObservedMeetingNoteInput = {
  workspace: WorkspaceConfig;
  source: ObservedSourceRevision;
};

export interface MeetingNotesIngestion {
  ingest(input: IngestObservedMeetingNoteInput): Promise<MeetingUpdate>;
}

export type CreateMeetingNotesIngestionInput = {
  meetingIntelligence: MeetingIntelligence;
  /** Dayova's canonical work tracker unless a different WorkProvider is configured. */
  workItemProviderId?: string;
};

export function createMeetingNotesIngestion(
  input: CreateMeetingNotesIngestionInput
): MeetingNotesIngestion {
  const workItemProviderId = (input.workItemProviderId ?? "linear").trim();

  if (workItemProviderId.length === 0) {
    throw new Error("Meeting Notes ingestion requires a WorkProvider identity");
  }

  return {
    ingest: (ingestInput) => {
      const observation = observedMeetingNoteToObservation(
        ingestInput,
        workItemProviderId
      );
      return input.meetingIntelligence.observe({
        workspace: ingestInput.workspace,
        observations: [observation]
      });
    }
  };
}

/**
 * The sole deterministic projection from an immutable source revision into a
 * Meeting Intelligence Observation. A ledger-backed verifier reuses it to
 * prove source provenance before MI accepts a public observation.
 */
export function observedMeetingNoteToObservation(
  input: IngestObservedMeetingNoteInput,
  workItemProviderId: string
): MeetingImportedFromSource {
  const source = toImportedMeetingSource(input.source, workItemProviderId);
  const meetingId = importedSourceMeetingId(source);
  const sourceSections = sourceSectionsFromSnapshot(input.source);
  const actionItemBlocks = actionItemBlocksFromSnapshot(input.source);
  const sectionEvidence = sourceEvidence(source, sourceSections);
  const candidates = actionItemCandidates(
    source,
    actionItemBlocks,
    input.workspace.timezone,
    source.deadlineReferenceAt,
    workItemProviderId,
    sectionEvidence
  );
  const evidence = uniqueEvidence([
    ...sectionEvidence,
    ...candidates.flatMap((candidate) => candidate.evidence)
  ]);

  return {
    type: "meeting-imported-from-source",
    observationId: importedSourceObservationId(source),
    workspaceId: input.workspace.workspaceId,
    meetingId,
    occurredAt: input.source.snapshot.calendar?.startAt ?? source.capturedAt,
    observedAt: source.capturedAt,
    source,
    sourceSections,
    actionItemBlocks,
    evidence,
    candidates
  };
}

function toImportedMeetingSource(
  source: ObservedSourceRevision,
  workItemProviderId: string
): ImportedMeetingSource {
  return {
    providerId: source.source.providerId,
    sourceKind: "meeting-note",
    sourceObjectId: source.source.sourceObjectId,
    parentObjectId: source.source.parentObjectId,
    sourceRevision: source.revision,
    contentHash: source.contentHash,
    providerVersion: source.providerVersion,
    title: source.snapshot.title,
    externalReference: {
      providerId: source.source.providerId,
      objectType: "document",
      externalId: source.source.parentObjectId ?? source.source.sourceObjectId,
      url: source.source.url,
      version: source.providerVersion ?? source.contentHash
    },
    workItemProviderId,
    completeness: completenessFromSnapshot(source),
    completenessReasons: completenessReasonsFromSnapshot(source),
    actionItemsAvailability:
      source.snapshot.sections.actionItemsAndNotes.state === "available"
        ? "available"
        : "unavailable",
    deadlineReferenceAt: importedActionItemDeadlineReferenceAt(
      source.snapshot.calendar?.startAt,
      source.capturedAt
    ),
    capturedAt: source.capturedAt
  };
}

function completenessFromSnapshot(
  source: ObservedSourceRevision
): ImportedMeetingSource["completeness"] {
  switch (source.snapshot.completeness.state) {
    case "complete":
      return "complete";
    case "partial":
      return "partial";
    case "not-ready":
      return "not-ready";
    case "failed":
      return "failed";
    case "removed":
      return "removed";
  }
}

function completenessReasonsFromSnapshot(
  source: ObservedSourceRevision
): ImportedMeetingSource["completenessReasons"] {
  switch (source.snapshot.completeness.state) {
    case "complete":
      return [];
    case "partial":
      return source.snapshot.completeness.reasons.map((reason) => ({
        code: reason.code,
        message: reason.message,
        ...(reason.blockId ? { sourceBlockId: reason.blockId } : {})
      }));
    case "not-ready":
      return [
        {
          code: "meeting-notes-not-ready",
          message: `Meeting Notes are not ready${source.snapshot.completeness.providerStatus ? ` (${source.snapshot.completeness.providerStatus})` : ""}`
        }
      ];
    case "failed":
      return [
        {
          code: "meeting-notes-failed",
          message: `Meeting Notes failed${source.snapshot.completeness.providerStatus ? ` (${source.snapshot.completeness.providerStatus})` : ""}`
        }
      ];
    case "removed":
      return [
        {
          code: "source-removed",
          message: source.snapshot.completeness.message
        }
      ];
  }
}

function sourceSectionsFromSnapshot(
  source: ObservedSourceRevision
): ImportedMeetingSourceSection[] {
  const sections = [
    ["summary", source.snapshot.sections.summary],
    ["action-items-and-notes", source.snapshot.sections.actionItemsAndNotes],
    ["transcript", source.snapshot.sections.transcript]
  ] as const;

  return sections.flatMap(([section, sourceSection]) => {
    if (sourceSection.state !== "available") {
      return [];
    }

    return [
      {
        section,
        sourceBlockId: sourceSection.sourceBlockId,
        excerpt:
          section === "action-items-and-notes"
            ? actionItemsSectionExcerpt(sourceSection)
            : sourceSection.text
      } satisfies ImportedMeetingSourceSection
    ];
  });
}

/**
 * The root Section text is not guaranteed to repeat descendant to-do text.
 * Preserve the readable child tree in its evidence manifest so MI can bind a
 * candidate block to source material rather than a self-asserted fragment.
 */
function actionItemsSectionExcerpt(
  section: Extract<RawMeetingNoteSection, { state: "available" }>
): string {
  return [
    section.text,
    ...flattenBlocks(section)
      .map((block) => block.text)
      .filter((text): text is string => Boolean(text))
  ]
    .filter((text, index, values) => text.length > 0 && values.indexOf(text) === index)
    .join("\n");
}

function sourceEvidence(
  importedSource: ImportedMeetingSource,
  sourceSections: ImportedMeetingSourceSection[]
): EvidenceReference[] {
  return sourceSections.map((section) =>
    importedSourceSectionEvidence(importedSource, section)
  );
}

function actionItemCandidates(
  importedSource: ImportedMeetingSource,
  actionItemBlocks: ImportedActionItemSourceBlock[],
  timezone: string,
  referenceAt: string | null,
  workItemProviderId: string,
  evidence: EvidenceReference[]
): ImportedActionItemCandidate[] {
  if (importedSource.actionItemsAvailability !== "available") {
    return [];
  }

  const actionEvidence = evidence.find(
    (reference) =>
      reference.evidenceId ===
      importedSourceSectionEvidenceId(importedSource, "action-items-and-notes")
  );

  if (!actionEvidence) {
    throw new Error("Imported Action Item section is missing its source Evidence");
  }

  return actionItemBlocks.flatMap((block) => {
    const originalText = block.excerpt;

    if (originalText.length === 0) {
      return [];
    }

    const source = {
      source: importedSource,
      sourceBlockId: block.sourceBlockId,
      sourceSection: "action-items-and-notes" as const,
      sourceExcerpt: originalText
    };
    const candidateEvidence = importedSourceCandidateEvidence(importedSource, source);
    const lineageKey = importedSourceCandidateLineageKey(
      importedSource,
      block.sourceBlockId
    );

    return [
      {
        id: importedSourceCandidateId(importedSource, block.sourceBlockId),
        lineageKey,
        originalText,
        description: originalText,
        language: importedActionItemLanguageFor(originalText),
        modality: importedActionItemModalityFor(originalText),
        completion: block.completion,
        owner: importedActionItemOwnerFor(originalText),
        deadline: importedActionItemDeadlineFor(originalText, timezone, referenceAt),
        mentionedWorkItemReferences: mentionedWorkItemReferences(
          originalText,
          workItemProviderId
        ),
        projectHints: [],
        componentHints: [],
        source,
        evidence: [candidateEvidence]
      } satisfies ImportedActionItemCandidate
    ];
  });
}

function actionItemBlocksFromSnapshot(
  source: ObservedSourceRevision
): ImportedActionItemSourceBlock[] {
  const section = source.snapshot.sections.actionItemsAndNotes;

  if (section.state !== "available") {
    return [];
  }

  return flattenBlocks(section)
    .filter(isActionItemBlock)
    .map((block) => ({
      sourceBlockId: block.id,
      excerpt: block.text?.trim() ?? "",
      completion: block.checked === true ? "completed" : "open"
    }));
}

function flattenBlocks(
  section: Extract<RawMeetingNoteSection, { state: "available" }>
): CapturedMeetingNoteBlock[] {
  const flattened: CapturedMeetingNoteBlock[] = [];
  const visit = (block: CapturedMeetingNoteBlock): void => {
    flattened.push(block);
    block.children.forEach(visit);
  };

  section.blocks.forEach(visit);
  return flattened;
}

function isActionItemBlock(block: CapturedMeetingNoteBlock): boolean {
  return block.type.toLowerCase().replaceAll("_", "-") === "to-do";
}

function mentionedWorkItemReferences(
  text: string,
  providerId: string
): ImportedWorkItemReference[] {
  return mentionedWorkItemExternalIdsFor(text).map((externalId) => ({
    providerId,
    objectType: "work-item",
    externalId
  }));
}

function uniqueEvidence(evidence: EvidenceReference[]): EvidenceReference[] {
  const byId = new Map(evidence.map((reference) => [reference.evidenceId, reference]));
  return [...byId.values()];
}
