import { describe, expect, it } from "vitest";
import type {
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../../src/ai/reasoning-model.js";
import type {
  EvidenceReference,
  MeetingImportedFromSource
} from "../../src/domain/model.js";
import {
  importedActionItemOwnershipFor,
  importedActionItemSourceOwnerFor,
  mentionedGitHubImplementationReferencesFor
} from "../../src/domain/imported-action-item-semantics.js";
import { createMeetingNotesIngestion } from "../../src/knowledge/meeting-notes-ingestion.js";
import { createMeetingIntelligence as createProductionMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import type { ImportedSourceObservationVerifier } from "../../src/meeting-intelligence/imported-source-observation-verifier.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import type { ObservedSourceRevision } from "../../src/knowledge/observed-source-ledger.js";

class NoAnalysisReasoningModel implements ReasoningModel {
  readonly requests: StructuredReasoningRequest<unknown>[] = [];

  generateStructured<T>(
    request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    this.requests.push(request);
    return Promise.reject(new Error("source candidates must not invoke model analysis"));
  }
}

const acceptingImportedSourceVerifier: ImportedSourceObservationVerifier = {
  verify: () => Promise.resolve({ status: "verified" })
};

function createMeetingIntelligence(
  input: Parameters<typeof createProductionMeetingIntelligence>[0]
) {
  return createProductionMeetingIntelligence({
    ...input,
    importedSourceObservationVerifier: acceptingImportedSourceVerifier
  });
}

function observedMeetingNote(
  overrides: Partial<ObservedSourceRevision> = {}
): ObservedSourceRevision {
  return {
    change: "new",
    source: {
      providerId: "notion",
      sourceKind: "meeting-note",
      sourceObjectId: "meeting-notes-root",
      parentObjectId: "notion-page-product-sync",
      url: "https://notion.so/product-sync"
    },
    revision: 1,
    contentHash: "sha256:meeting-note-v1",
    providerVersion: "2026-08-07T09:31:00.000Z",
    capturedAt: "2026-08-07T09:32:00.000Z",
    snapshot: {
      schemaVersion: 1,
      title: "Product sync",
      lifecycle: "ready",
      calendar: {
        // This is Friday in Berlin but Thursday in UTC: relative deadlines
        // must use the workspace timezone rather than the host timezone.
        startAt: "2026-08-06T23:30:00.000Z",
        endAt: "2026-08-07T00:00:00.000Z",
        attendeeProviderUserIds: ["notion-user-jakob"]
      },
      recording: null,
      sections: {
        summary: {
          state: "available",
          sourceBlockId: "summary-block",
          text: "We agreed to finish the source import.",
          blocks: []
        },
        actionItemsAndNotes: {
          state: "available",
          sourceBlockId: "action-items-block",
          text: "Three source Action Items",
          blocks: [
            {
              id: "action-commitment",
              type: "to-do",
              text: "Jakob will finish the Luma source import by Friday.",
              checked: false,
              children: []
            },
            {
              id: "action-request",
              type: "to-do",
              text: "Could Jakob review LUM-3?",
              checked: false,
              children: []
            },
            {
              id: "action-completed",
              type: "to-do",
              text: "The release checklist is already complete.",
              checked: true,
              children: []
            },
            {
              id: "action-german",
              type: "to-do",
              text: "Ich werde die Notion Quelle bis Freitag prüfen.",
              checked: false,
              children: []
            }
          ]
        },
        transcript: {
          state: "available",
          sourceBlockId: "transcript-block",
          text: "Jakob said that the source import should stay evidence-grounded.",
          blocks: []
        }
      },
      markdown: {
        content: "# Product sync",
        truncated: false,
        unknownBlockIds: []
      },
      completeness: { state: "complete" }
    },
    ...overrides
  };
}

function observedMeetingNoteWithUnavailableActionItems(): ObservedSourceRevision {
  return observedMeetingNote({
    revision: 2,
    contentHash: "sha256:meeting-note-v2-unavailable-action-items",
    snapshot: {
      ...observedMeetingNote().snapshot,
      sections: {
        ...observedMeetingNote().snapshot.sections,
        actionItemsAndNotes: {
          state: "unavailable",
          sourceBlockId: "action-items-block",
          reasons: [
            {
              code: "unreadable-section",
              message: "Notion Action Items could not be read",
              blockId: "action-items-block"
            }
          ]
        }
      },
      completeness: {
        state: "partial",
        reasons: [
          {
            code: "unreadable-section",
            message: "Notion Action Items could not be read",
            blockId: "action-items-block"
          }
        ]
      }
    }
  });
}

function observedMeetingNoteWithEmptyActionItems(): ObservedSourceRevision {
  return observedMeetingNote({
    revision: 2,
    contentHash: "sha256:meeting-note-v2-empty-action-items",
    snapshot: {
      ...observedMeetingNote().snapshot,
      sections: {
        ...observedMeetingNote().snapshot.sections,
        actionItemsAndNotes: {
          state: "available",
          sourceBlockId: "action-items-block",
          text: "No current source Action Items",
          blocks: []
        }
      }
    }
  });
}

function observedMeetingNoteTombstone(): ObservedSourceRevision {
  const previous = observedMeetingNote();

  return {
    ...previous,
    change: "revised",
    revision: 2,
    contentHash: "sha256:meeting-note-v2-confirmed-removed",
    providerVersion: null,
    capturedAt: "2026-08-07T10:00:00.000Z",
    snapshot: {
      schemaVersion: 1,
      title: previous.snapshot.title,
      lifecycle: "removed",
      calendar: previous.snapshot.calendar,
      recording: previous.snapshot.recording,
      sections: {
        summary: { state: "unavailable", sourceBlockId: null, reasons: [] },
        actionItemsAndNotes: { state: "unavailable", sourceBlockId: null, reasons: [] },
        transcript: { state: "unavailable", sourceBlockId: null, reasons: [] }
      },
      markdown: { content: "", truncated: false, unknownBlockIds: [] },
      completeness: {
        state: "removed",
        message: "The root was absent from a complete, fully readable scan."
      }
    }
  };
}

function directImportedMeetingObservation(input?: {
  contentHash?: string;
  observationId?: string;
  candidateExcerpt?: string;
}): MeetingImportedFromSource {
  const contentHash = input?.contentHash ?? "sha256:direct-meeting-note-v1";
  const source = {
    providerId: "notion",
    sourceKind: "meeting-note",
    sourceObjectId: "direct-meeting-notes-root",
    parentObjectId: "notion-page-direct-product-sync",
    sourceRevision: 1,
    contentHash,
    providerVersion: "2026-08-07T09:31:00.000Z",
    title: "Direct product sync",
    externalReference: {
      providerId: "notion",
      objectType: "document",
      externalId: "notion-page-direct-product-sync",
      url: "https://notion.so/direct-product-sync",
      version: "2026-08-07T09:31:00.000Z"
    },
    workItemProviderId: "linear",
    implementationReferenceProviderId: "github-code",
    completeness: "complete",
    completenessReasons: [],
    actionItemsAvailability: "available",
    deadlineReferenceAt: "2026-08-07T09:00:00.000Z",
    capturedAt: "2026-08-07T09:32:00.000Z"
  } satisfies MeetingImportedFromSource["source"];
  const candidateExcerpt =
    input?.candidateExcerpt ?? "Jakob will review the source import by Friday.";
  const sourceSections = [
    {
      section: "summary",
      sourceBlockId: "direct-summary-block",
      excerpt: "The source import needs review."
    },
    {
      section: "action-items-and-notes",
      sourceBlockId: "direct-action-items-block",
      excerpt: candidateExcerpt
    },
    {
      section: "transcript",
      sourceBlockId: "direct-transcript-block",
      excerpt: "Jakob committed to review the source import."
    }
  ] satisfies MeetingImportedFromSource["sourceSections"];
  const sourceVersion = `r${source.sourceRevision}:${source.contentHash}`;
  const sectionEvidence: EvidenceReference[] = sourceSections.map((section) => ({
    evidenceId: `evidence:meeting-note:${source.providerId}:${source.sourceObjectId}:r${source.sourceRevision}:section:${section.section}`,
    source: section.section === "transcript" ? "transcript" : "knowledge",
    sourceObjectId: section.sourceBlockId,
    sourceVersion,
    excerpt: section.excerpt,
    externalReference: source.externalReference
  }));
  const candidateEvidence: EvidenceReference = {
    evidenceId: `evidence:meeting-note:${source.providerId}:${source.sourceObjectId}:r${source.sourceRevision}:block:direct-action`,
    source: "knowledge",
    sourceObjectId: "direct-action",
    sourceVersion,
    excerpt: candidateExcerpt,
    externalReference: source.externalReference
  };
  const candidate = {
    id: `candidate:${source.providerId}:${source.sourceObjectId}:r${source.sourceRevision}:block:direct-action`,
    lineageKey: `candidate:${source.providerId}:${source.sourceObjectId}:block:direct-action`,
    originalText: candidateExcerpt,
    description: candidateExcerpt,
    language: "en",
    modality: { kind: "commitment", sourceForm: "will" },
    completion: "open",
    sourceOwner: importedActionItemSourceOwnerFor(candidateExcerpt),
    ownership: importedActionItemOwnershipFor(candidateExcerpt),
    deadline: {
      originalPhrase: "by Friday",
      normalizedDate: "2026-08-07",
      confidence: "normalized",
      timezone: "Europe/Berlin"
    },
    mentionedWorkItemReferences: [],
    sourceBoundImplementationReferences: mentionedGitHubImplementationReferencesFor(
      candidateExcerpt,
      source.implementationReferenceProviderId
    ),
    projectHints: [],
    componentHints: [],
    source: {
      source,
      sourceBlockId: "direct-action",
      sourceSection: "action-items-and-notes",
      sourceExcerpt: candidateExcerpt
    },
    evidence: [candidateEvidence]
  } satisfies MeetingImportedFromSource["candidates"][number];
  const actionItemBlocks = [
    {
      sourceBlockId: "direct-action",
      excerpt: candidateExcerpt,
      completion: "open"
    }
  ] satisfies MeetingImportedFromSource["actionItemBlocks"];

  return {
    type: "meeting-imported-from-source",
    observationId:
      input?.observationId ??
      `meeting-note-import:${source.providerId}:${source.sourceObjectId}:r${source.sourceRevision}`,
    workspaceId: "workspace_dayova",
    meetingId: `meeting:source:${source.providerId}:${source.sourceObjectId}`,
    occurredAt: "2026-08-07T09:00:00.000Z",
    observedAt: source.capturedAt,
    source,
    sourceSections,
    actionItemBlocks,
    evidence: [...sectionEvidence, candidateEvidence],
    candidates: [candidate]
  };
}

describe("Meeting Notes ingestion", () => {
  it("submits source-derived candidates through Meeting Intelligence without losing source wording or uncertainty", async () => {
    const database = await createPgliteDatabase();
    const reasoningModel = new NoAnalysisReasoningModel();
    const meetingIntelligence = createMeetingIntelligence({ database, reasoningModel });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });

    try {
      const update = await ingestion.ingest({
        workspace,
        source: observedMeetingNote()
      });

      expect(update.acceptedObservationIds).toEqual([
        "meeting-note-import:notion:meeting-notes-root:r1"
      ]);
      expect(update.analysisStatus).toBe("not-needed");
      expect(reasoningModel.requests).toEqual([]);

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(snapshot.state.lifecycle).toBe("imported");
      expect(snapshot.state.importedSources).toEqual([
        expect.objectContaining({
          providerId: "notion",
          sourceObjectId: "meeting-notes-root",
          sourceRevision: 1,
          contentHash: "sha256:meeting-note-v1",
          completeness: "complete"
        })
      ]);
      const [commitment, request, completed, germanCommitment] =
        snapshot.state.importedActionItemCandidates;

      expect(commitment).toMatchObject({
        id: "candidate:notion:meeting-notes-root:r1:block:action-commitment",
        lineageKey: "candidate:notion:meeting-notes-root:block:action-commitment",
        originalText: "Jakob will finish the Luma source import by Friday.",
        modality: { kind: "commitment", sourceForm: "will" },
        sourceOwner: { state: "unmapped", sourceText: "Jakob" },
        ownership: {
          status: "proposed",
          proposedOwnerPersonId: null,
          confidence: "low",
          basis: "inferred-assignment"
        },
        deadline: {
          originalPhrase: "by Friday",
          normalizedDate: "2026-08-07",
          confidence: "normalized",
          timezone: "Europe/Berlin"
        },
        source: {
          sourceBlockId: "action-commitment",
          sourceSection: "action-items-and-notes"
        },
        evidence: [
          {
            sourceObjectId: "action-commitment",
            excerpt: "Jakob will finish the Luma source import by Friday."
          }
        ]
      });
      expect(request?.modality).toEqual({ kind: "question", sourceForm: null });
      expect(request?.mentionedWorkItemReferences).toEqual([
        {
          providerId: "linear",
          objectType: "work-item",
          externalId: "LUM-3"
        }
      ]);
      expect(completed?.completion).toBe("completed");
      expect(completed?.modality).toEqual({ kind: "completed-work", sourceForm: null });
      expect(germanCommitment).toMatchObject({
        language: "de",
        modality: { kind: "commitment", sourceForm: "werde" },
        sourceOwner: { state: "ambiguous", sourceText: "Ich" },
        ownership: {
          status: "unresolved",
          reason: "missing-speaker",
          likelyOwnerPersonId: null
        },
        deadline: {
          originalPhrase: "bis Freitag",
          normalizedDate: "2026-08-07",
          confidence: "normalized",
          timezone: "Europe/Berlin"
        }
      });
    } finally {
      await database.close();
    }
  }, 15_000);

  it("does not mistake non-person subjects for owners and preserves German modal-first owners", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const source = observedMeetingNote({
      contentHash: "sha256:owner-resolution-v1"
    });
    const actionItems = source.snapshot.sections.actionItemsAndNotes;

    if (actionItems.state !== "available") {
      throw new Error("expected available source Action Items");
    }

    actionItems.blocks = [
      {
        id: "action-non-person-subject",
        type: "to-do",
        text: "Das Deployment wird bis Freitag geprüft.",
        checked: false,
        children: []
      },
      {
        id: "action-review-subject",
        type: "to-do",
        text: "Review should happen by Friday.",
        checked: false,
        children: []
      },
      {
        id: "action-german-modal-first",
        type: "to-do",
        text: "Könnte Groß die Notion Quelle prüfen?",
        checked: false,
        children: []
      },
      {
        id: "action-english-pronoun",
        type: "to-do",
        text: "We will review the Notion source by Friday.",
        checked: false,
        children: []
      },
      {
        id: "action-german-pronoun",
        type: "to-do",
        text: "Sie werden Luma prüfen.",
        checked: false,
        children: []
      },
      {
        id: "action-german-modal-pronoun",
        type: "to-do",
        text: "Wir könnten Luma prüfen?",
        checked: false,
        children: []
      }
    ];
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });

    try {
      await ingestion.ingest({ workspace, source });

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      const [
        nonPersonSubject,
        reviewSubject,
        germanModalFirst,
        englishPronoun,
        germanPronoun,
        germanModalPronoun
      ] = snapshot.state.importedActionItemCandidates;

      expect(nonPersonSubject).toMatchObject({
        sourceOwner: { state: "unspecified", sourceText: null },
        modality: { kind: "commitment", sourceForm: "wird" }
      });
      expect(reviewSubject).toMatchObject({
        sourceOwner: { state: "unspecified", sourceText: null },
        modality: { kind: "request", sourceForm: "should" }
      });
      expect(germanModalFirst).toMatchObject({
        sourceOwner: { state: "unmapped", sourceText: "Groß" },
        modality: { kind: "question", sourceForm: null }
      });
      expect(englishPronoun).toMatchObject({
        sourceOwner: { state: "ambiguous", sourceText: "We" },
        modality: { kind: "commitment", sourceForm: "will" }
      });
      expect(germanPronoun).toMatchObject({
        language: "de",
        sourceOwner: { state: "ambiguous", sourceText: "Sie" },
        modality: { kind: "commitment", sourceForm: "werden" }
      });
      expect(germanModalPronoun).toMatchObject({
        language: "de",
        sourceOwner: { state: "ambiguous", sourceText: "Wir" },
        modality: { kind: "question", sourceForm: null }
      });
    } finally {
      await database.close();
    }
  });

  it("preserves German Action Item wording while keeping speaker-dependent ownership unresolved", async () => {
    const database = await createPgliteDatabase();
    const reasoningModel = new NoAnalysisReasoningModel();
    const meetingIntelligence = createMeetingIntelligence({ database, reasoningModel });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const source = observedMeetingNote({
      contentHash: "sha256:german-ownership-safety-v1"
    });
    const actionItems = source.snapshot.sections.actionItemsAndNotes;

    if (actionItems.state !== "available") {
      throw new Error("expected available source Action Items");
    }

    actionItems.blocks = [
      {
        id: "german-self-commitment-mache",
        type: "to-do",
        text: "Ich mache das.",
        checked: false,
        children: []
      },
      {
        id: "german-self-commitment-uebernehme",
        type: "to-do",
        text: "Das übernehme ich.",
        checked: false,
        children: []
      },
      {
        id: "german-question",
        type: "to-do",
        text: "Kannst du das übernehmen?",
        checked: false,
        children: []
      },
      {
        id: "german-acknowledgement",
        type: "to-do",
        text: "Ja, mache ich.",
        checked: false,
        children: []
      },
      {
        id: "german-proposal",
        type: "to-do",
        text: "Fabius könnte sich das anschauen.",
        checked: false,
        children: []
      },
      {
        id: "german-team-request",
        type: "to-do",
        text: "Wir sollten das noch testen.",
        checked: false,
        children: []
      },
      {
        id: "german-completed-work",
        type: "to-do",
        text: "Das habe ich gestern schon erledigt.",
        checked: false,
        children: []
      },
      {
        id: "german-speaker-correction",
        type: "to-do",
        text: "Nein, ich meinte Philipp.",
        checked: false,
        children: []
      }
    ];
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });

    try {
      const update = await ingestion.ingest({ workspace, source });

      expect(update.acceptedObservationIds).toEqual([
        "meeting-note-import:notion:meeting-notes-root:r1"
      ]);
      expect(reasoningModel.requests).toEqual([]);

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(
        snapshot.state.importedActionItemCandidates.map((candidate) => ({
          originalText: candidate.originalText,
          language: candidate.language,
          modality: candidate.modality.kind,
          completion: candidate.completion,
          sourceOwner: candidate.sourceOwner,
          ownership: candidate.ownership
        }))
      ).toEqual([
        {
          originalText: "Ich mache das.",
          language: "de",
          modality: "commitment",
          completion: "open",
          sourceOwner: { state: "ambiguous", sourceText: "Ich" },
          ownership: {
            status: "unresolved",
            reason: "missing-speaker",
            likelyOwnerPersonId: null
          }
        },
        {
          originalText: "Das übernehme ich.",
          language: "de",
          modality: "commitment",
          completion: "open",
          sourceOwner: { state: "ambiguous", sourceText: "ich" },
          ownership: {
            status: "unresolved",
            reason: "missing-speaker",
            likelyOwnerPersonId: null
          }
        },
        {
          originalText: "Kannst du das übernehmen?",
          language: "de",
          modality: "question",
          completion: "open",
          sourceOwner: { state: "ambiguous", sourceText: "du" },
          ownership: {
            status: "unresolved",
            reason: "missing-speaker",
            likelyOwnerPersonId: null
          }
        },
        {
          originalText: "Ja, mache ich.",
          language: "de",
          modality: "commitment",
          completion: "open",
          sourceOwner: { state: "ambiguous", sourceText: "ich" },
          ownership: {
            status: "unresolved",
            reason: "missing-speaker",
            likelyOwnerPersonId: null
          }
        },
        {
          originalText: "Fabius könnte sich das anschauen.",
          language: "de",
          modality: "proposal",
          completion: "open",
          sourceOwner: { state: "unmapped", sourceText: "Fabius" },
          ownership: {
            status: "proposed",
            proposedOwnerPersonId: null,
            confidence: "low",
            basis: "inferred-assignment"
          }
        },
        {
          originalText: "Wir sollten das noch testen.",
          language: "de",
          modality: "request",
          completion: "open",
          sourceOwner: { state: "ambiguous", sourceText: "Wir" },
          ownership: {
            status: "unresolved",
            reason: "missing-speaker",
            likelyOwnerPersonId: null
          }
        },
        {
          originalText: "Das habe ich gestern schon erledigt.",
          language: "de",
          modality: "completed-work",
          completion: "completed",
          sourceOwner: { state: "ambiguous", sourceText: "ich" },
          ownership: {
            status: "unresolved",
            reason: "missing-speaker",
            likelyOwnerPersonId: null
          }
        },
        {
          originalText: "Nein, ich meinte Philipp.",
          language: "de",
          modality: "unknown",
          completion: "open",
          sourceOwner: { state: "ambiguous", sourceText: "ich" },
          ownership: {
            status: "unresolved",
            reason: "missing-speaker",
            likelyOwnerPersonId: null
          }
        }
      ]);
      expect(
        snapshot.state.importedActionItemCandidates.every(
          (candidate) =>
            candidate.ownership.status !== "confirmed" &&
            candidate.ownership.status !== "intentionally-unassigned"
        )
      ).toBe(true);

      const reviews = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "action-item-reconciliation-review" }
      });

      if (reviews.type !== "action-item-reconciliation-review") {
        throw new Error("expected Action Item Reconciliation reviews");
      }

      expect(
        reviews.reviews.find(
          (review) =>
            review.proposal.candidate.originalText ===
            "Das habe ich gestern schon erledigt."
        )?.effectiveOutcome
      ).toEqual({
        type: "reject-not-work",
        rationale: "The source marks this Action Item as already completed."
      });
    } finally {
      await database.close();
    }
  });

  it("keeps German refusals and contingencies out of commitment and create-new reconciliation", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const source = observedMeetingNote({
      contentHash: "sha256:german-refusal-and-contingency-v1"
    });
    const actionItems = source.snapshot.sections.actionItemsAndNotes;

    if (actionItems.state !== "available") {
      throw new Error("expected available source Action Items");
    }

    const refusals = [
      "Ich mache das nicht.",
      "Ich übernehme das nie.",
      "Das mache ich keinesfalls.",
      "Ich übernehme keinerlei Verantwortung."
    ];
    const contingencies = [
      "Ich mache das vielleicht.",
      "Wenn ihr das wollt, mache ich das.",
      "Ich mache das nur im Notfall.",
      "Ich übernehme das bei Bedarf."
    ];
    actionItems.blocks = [...refusals, ...contingencies].map((text, index) => ({
      id: `german-disposition-${index + 1}`,
      type: "to-do",
      text,
      checked: false,
      children: []
    }));
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });

    try {
      const update = await ingestion.ingest({ workspace, source });

      expect(update.errors).toEqual([]);

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      for (const originalText of refusals) {
        expect(
          snapshot.state.importedActionItemCandidates.find(
            (candidate) => candidate.originalText === originalText
          )
        ).toMatchObject({
          language: "de",
          modality: { kind: "unknown", sourceForm: null }
        });
      }

      for (const originalText of contingencies) {
        const candidate = snapshot.state.importedActionItemCandidates.find(
          (item) => item.originalText === originalText
        );

        expect(candidate?.language).toBe("de");
        expect(candidate?.modality.kind).toBe("proposal");
      }

      expect(
        snapshot.state.importedActionItemCandidates.some(
          (candidate) => candidate.modality.kind === "commitment"
        )
      ).toBe(false);

      const reviews = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "action-item-reconciliation-review" }
      });

      if (reviews.type !== "action-item-reconciliation-review") {
        throw new Error("expected Action Item Reconciliation reviews");
      }

      for (const originalText of [...refusals, ...contingencies]) {
        expect(
          reviews.reviews.find(
            (review) => review.proposal.candidate.originalText === originalText
          )?.effectiveOutcome
        ).toEqual({
          type: "needs-clarification",
          rationale:
            "The source wording does not make a clear work commitment or request."
        });
      }

      expect(
        reviews.reviews.some((review) => review.effectiveOutcome.type === "create-new")
      ).toBe(false);
    } finally {
      await database.close();
    }
  });

  it("keeps a named German source commitment proposed until a Human resolves ownership", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const source = observedMeetingNote({
      contentHash: "sha256:jakob-macht-proposed-owner-v1"
    });
    const actionItems = source.snapshot.sections.actionItemsAndNotes;

    if (actionItems.state !== "available") {
      throw new Error("expected available source Action Items");
    }

    actionItems.blocks = [
      {
        id: "jakob-macht-action",
        type: "to-do",
        text: "Jakob macht das bis Freitag.",
        checked: false,
        children: []
      }
    ];
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });

    try {
      await ingestion.ingest({ workspace, source });

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(snapshot.state.importedActionItemCandidates).toEqual([
        expect.objectContaining({
          originalText: "Jakob macht das bis Freitag.",
          modality: { kind: "commitment", sourceForm: "Jakob macht" },
          sourceOwner: { state: "unmapped", sourceText: "Jakob" },
          ownership: {
            status: "proposed",
            proposedOwnerPersonId: null,
            confidence: "low",
            basis: "inferred-assignment"
          }
        })
      ]);
      expect(
        snapshot.state.importedActionItemCandidates.some(
          (candidate) =>
            candidate.ownership.status === "confirmed" ||
            candidate.ownership.status === "intentionally-unassigned"
        )
      ).toBe(false);
    } finally {
      await database.close();
    }
  });

  it("keeps technical identifiers out of work-item references", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const source = observedMeetingNote({
      contentHash: "sha256:technical-identifiers-v1"
    });
    const actionItems = source.snapshot.sections.actionItemsAndNotes;

    if (actionItems.state !== "available") {
      throw new Error("expected available source Action Items");
    }

    actionItems.blocks = [
      {
        id: "action-technical-identifiers",
        type: "to-do",
        text: "Jakob will verify UTF-8, SHA-256, ISO-9001, HTTP-500, GPT-4, S3-123, and LUM-3.",
        checked: false,
        children: []
      }
    ];
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });

    try {
      await ingestion.ingest({ workspace, source });

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(snapshot.state.importedActionItemCandidates[0]).toMatchObject({
        mentionedWorkItemReferences: [
          {
            providerId: "linear",
            objectType: "work-item",
            externalId: "LUM-3"
          }
        ]
      });
    } finally {
      await database.close();
    }
  });

  it("preserves only exact GitHub implementation URLs bound to an Action Item source block", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const source = observedMeetingNote({
      contentHash: "sha256:source-bound-github-references-v1"
    });
    const actionItems = source.snapshot.sections.actionItemsAndNotes;

    if (actionItems.state !== "available") {
      throw new Error("expected available source Action Items");
    }

    actionItems.blocks = [
      {
        id: "action-source-bound-github",
        type: "to-do",
        text: "Jakob will verify https://github.com/Dayova/Luma/pull/42 and https://github.com/Dayova/Luma/commit/0123456789abcdef0123456789abcdef01234567. Ignore https://github.com/Dayova/Luma/issues/42, http://github.com/Dayova/Luma/pull/43, https://github.com/Dayova/Luma/pull/44/files, https://github.com:443/Dayova/Luma/pull/45, https://github.com/Dayova/Luma/pull/./46, https://github.com/Dayova/Luma/pull/47?, https://github.com/Dayova/Luma/pull/48#, https://github.com/Dayova/Luma/PULL/49, and https://github.com/Dayova/Luma/commit/abc123.",
        checked: false,
        children: []
      }
    ];
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });

    try {
      await ingestion.ingest({ workspace, source });

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(snapshot.state.importedActionItemCandidates[0]).toMatchObject({
        sourceBoundImplementationReferences: [
          {
            providerId: "github-code",
            objectType: "pull-request",
            externalId: "Dayova/Luma#42",
            url: "https://github.com/Dayova/Luma/pull/42"
          },
          {
            providerId: "github-code",
            objectType: "commit",
            externalId: "Dayova/Luma@0123456789abcdef0123456789abcdef01234567",
            url: "https://github.com/Dayova/Luma/commit/0123456789abcdef0123456789abcdef01234567"
          }
        ]
      });
    } finally {
      await database.close();
    }
  });

  it("uses the observed source revision as an idempotency boundary", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });
    const source = observedMeetingNote();

    try {
      await ingestion.ingest({ workspace, source });
      const retry = await ingestion.ingest({ workspace, source });

      expect(retry.acceptedObservationIds).toEqual([]);
      expect(retry.duplicateObservationIds).toEqual([
        "meeting-note-import:notion:meeting-notes-root:r1"
      ]);

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(snapshot.state.importedSources).toHaveLength(1);
      expect(snapshot.state.importedActionItemCandidates).toHaveLength(4);
    } finally {
      await database.close();
    }
  });

  it("falls back to the captured instant when a Meeting Note calendar time lacks an offset", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const source = observedMeetingNote({
      capturedAt: "2026-08-06T23:30:00.000Z"
    });

    if (!source.snapshot.calendar) {
      throw new Error("expected source calendar data");
    }

    // If this offset-less value were passed to Date, the answer would depend on
    // the host timezone. The trusted captured instant is Friday in Berlin.
    source.snapshot.calendar.startAt = "2026-08-10T00:30:00";
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });

    try {
      await ingestion.ingest({ workspace, source });

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      const candidate = snapshot.state.importedActionItemCandidates.find(
        (item) =>
          item.id === "candidate:notion:meeting-notes-root:r1:block:action-commitment"
      );

      expect(candidate?.deadline).toMatchObject({
        originalPhrase: "by Friday",
        normalizedDate: "2026-08-07",
        confidence: "normalized",
        timezone: "Europe/Berlin"
      });
    } finally {
      await database.close();
    }
  });

  it("retains a partial source state rather than representing it as complete evidence", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });
    const partial = observedMeetingNote({
      revision: 2,
      contentHash: "sha256:meeting-note-v2",
      snapshot: {
        ...observedMeetingNote().snapshot,
        completeness: {
          state: "partial",
          reasons: [
            {
              code: "transcript-unavailable",
              message: "Notion transcript was unavailable"
            }
          ]
        }
      }
    });

    try {
      await ingestion.ingest({ workspace, source: partial });

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      const importedSource = snapshot.state.importedSources[0];
      const candidate = snapshot.state.importedActionItemCandidates[0];

      expect(importedSource?.sourceRevision).toBe(2);
      expect(importedSource?.completeness).toBe("partial");
      expect(importedSource?.completenessReasons).toEqual([
        expect.objectContaining({ code: "transcript-unavailable" })
      ]);
      expect(candidate?.source.source.completeness).toBe("partial");
    } finally {
      await database.close();
    }
  });

  it("keeps candidate history but makes only the latest source revision current", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });
    const revised = observedMeetingNote({
      revision: 2,
      contentHash: "sha256:meeting-note-v2",
      snapshot: {
        ...observedMeetingNote().snapshot,
        sections: {
          ...observedMeetingNote().snapshot.sections,
          actionItemsAndNotes: {
            state: "available",
            sourceBlockId: "action-items-block",
            text: "One revised source Action Item",
            blocks: [
              {
                id: "action-commitment",
                type: "to-do",
                text: "Jakob will finish the verified Luma source import by Friday.",
                checked: false,
                children: []
              }
            ]
          }
        }
      }
    });

    try {
      await ingestion.ingest({ workspace, source: observedMeetingNote() });
      await ingestion.ingest({ workspace, source: revised });

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(snapshot.state.importedActionItemCandidates).toHaveLength(5);
      expect(snapshot.state.currentImportedActionItemCandidateIds).toEqual([
        "candidate:notion:meeting-notes-root:r2:block:action-commitment"
      ]);
    } finally {
      await database.close();
    }
  });

  it("does not treat an unavailable Action Items section as deleting prior candidates", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });
    const unavailableActionItems = observedMeetingNoteWithUnavailableActionItems();

    try {
      await ingestion.ingest({ workspace, source: observedMeetingNote() });
      await ingestion.ingest({ workspace, source: unavailableActionItems });

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(snapshot.state.importedSources).toHaveLength(2);
      expect(snapshot.state.importedActionItemCandidates).toHaveLength(4);
      expect(snapshot.state.currentImportedActionItemCandidateIds).toEqual([
        "candidate:notion:meeting-notes-root:r1:block:action-commitment",
        "candidate:notion:meeting-notes-root:r1:block:action-request",
        "candidate:notion:meeting-notes-root:r1:block:action-completed",
        "candidate:notion:meeting-notes-root:r1:block:action-german"
      ]);
    } finally {
      await database.close();
    }
  });

  it("treats a confirmed removed root as an invalidation boundary, unlike an unavailable read", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });
    const unavailableAfterRemoval = observedMeetingNoteWithUnavailableActionItems();
    unavailableAfterRemoval.revision = 3;
    unavailableAfterRemoval.contentHash =
      "sha256:meeting-note-v3-unavailable-after-confirmed-removal";

    try {
      await ingestion.ingest({ workspace, source: observedMeetingNote() });
      await ingestion.ingest({ workspace, source: observedMeetingNoteTombstone() });

      const afterRemoval = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (afterRemoval.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(afterRemoval.state.importedActionItemCandidates).toHaveLength(4);
      expect(afterRemoval.state.currentImportedActionItemCandidateIds).toEqual([]);
      expect(afterRemoval.state.importedSources.at(-1)).toMatchObject({
        completeness: "removed",
        completenessReasons: [expect.objectContaining({ code: "source-removed" })]
      });

      // A subsequent unavailable read proves neither restored content nor a
      // new candidate. It must not resurrect Action Items from before removal.
      await ingestion.ingest({ workspace, source: unavailableAfterRemoval });
      const afterUnavailable = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (afterUnavailable.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(afterUnavailable.state.currentImportedActionItemCandidateIds).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("selects the latest readable Action Items revision regardless of import order", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });

    try {
      await ingestion.ingest({
        workspace,
        source: observedMeetingNoteWithUnavailableActionItems()
      });
      await ingestion.ingest({ workspace, source: observedMeetingNote() });

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(snapshot.state.importedSources).toHaveLength(2);
      expect(snapshot.state.importedActionItemCandidates).toHaveLength(4);
      expect(snapshot.state.currentImportedActionItemCandidateIds).toEqual([
        "candidate:notion:meeting-notes-root:r1:block:action-commitment",
        "candidate:notion:meeting-notes-root:r1:block:action-request",
        "candidate:notion:meeting-notes-root:r1:block:action-completed",
        "candidate:notion:meeting-notes-root:r1:block:action-german"
      ]);
    } finally {
      await database.close();
    }
  });

  it("derives legacy current candidates from the newest eligible source revision", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });
    const latestReadable = observedMeetingNote({
      revision: 2,
      contentHash: "sha256:meeting-note-v2-one-current-action-item",
      snapshot: {
        ...observedMeetingNote().snapshot,
        sections: {
          ...observedMeetingNote().snapshot.sections,
          actionItemsAndNotes: {
            state: "available",
            sourceBlockId: "action-items-block",
            text: "One current source Action Item",
            blocks: [
              {
                id: "action-current",
                type: "to-do",
                text: "Jakob will validate the Luma source import by Friday.",
                checked: false,
                children: []
              }
            ]
          }
        }
      }
    });
    const unavailableAfterLegacy = observedMeetingNoteWithUnavailableActionItems();
    unavailableAfterLegacy.revision = 3;
    unavailableAfterLegacy.contentHash =
      "sha256:meeting-note-v3-unavailable-after-legacy-candidate";
    const laterEmpty = observedMeetingNoteWithEmptyActionItems();
    laterEmpty.revision = 4;
    laterEmpty.contentHash = "sha256:meeting-note-v4-empty-action-items";
    const laterUnavailable = observedMeetingNoteWithUnavailableActionItems();
    laterUnavailable.revision = 5;
    laterUnavailable.contentHash = "sha256:meeting-note-v5-unavailable-action-items";

    try {
      await ingestion.ingest({ workspace, source: observedMeetingNote() });
      await ingestion.ingest({ workspace, source: latestReadable });
      await database.query(
        `UPDATE meetings
            SET state_json = (
              state_json::jsonb
                - 'currentImportedActionItemCandidateIds'
                #- '{importedSources,1}'
                #- '{importedActionItemCandidates,4,source,source,actionItemsAvailability}'
            )::TEXT
          WHERE workspace_id = $1 AND meeting_id = $2`,
        [workspace.workspaceId, "meeting:source:notion:meeting-notes-root"]
      );

      const normalizedSnapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (normalizedSnapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(normalizedSnapshot.state.currentImportedActionItemCandidateIds).toEqual([
        "candidate:notion:meeting-notes-root:r2:block:action-current"
      ]);

      await ingestion.ingest({ workspace, source: unavailableAfterLegacy });

      const snapshotAfterUnavailableLegacyRevision = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (snapshotAfterUnavailableLegacyRevision.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(
        snapshotAfterUnavailableLegacyRevision.state.currentImportedActionItemCandidateIds
      ).toEqual(["candidate:notion:meeting-notes-root:r2:block:action-current"]);

      await ingestion.ingest({ workspace, source: laterEmpty });

      const snapshotAfterEmptyRevision = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (snapshotAfterEmptyRevision.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(
        snapshotAfterEmptyRevision.state.currentImportedActionItemCandidateIds
      ).toEqual([]);

      await ingestion.ingest({ workspace, source: laterUnavailable });

      const snapshotAfterUnavailableRevision = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (snapshotAfterUnavailableRevision.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(
        snapshotAfterUnavailableRevision.state.currentImportedActionItemCandidateIds
      ).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("retains legacy candidate work when a later Action Items revision is unavailable", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });

    try {
      await ingestion.ingest({ workspace, source: observedMeetingNote() });
      await database.query(
        `UPDATE meetings
            SET state_json = (
              state_json::jsonb
                - 'currentImportedActionItemCandidateIds'
                #- '{importedSources,0,actionItemsAvailability}'
            )::TEXT
          WHERE workspace_id = $1 AND meeting_id = $2`,
        [workspace.workspaceId, "meeting:source:notion:meeting-notes-root"]
      );

      await ingestion.ingest({
        workspace,
        source: observedMeetingNoteWithUnavailableActionItems()
      });

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(snapshot.state.currentImportedActionItemCandidateIds).toEqual([
        "candidate:notion:meeting-notes-root:r1:block:action-commitment",
        "candidate:notion:meeting-notes-root:r1:block:action-request",
        "candidate:notion:meeting-notes-root:r1:block:action-completed",
        "candidate:notion:meeting-notes-root:r1:block:action-german"
      ]);
    } finally {
      await database.close();
    }
  });

  it("normalizes legacy Meeting State before importing source candidates", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting:source:notion:meeting-notes-root";
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });

    try {
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "meeting-started",
            observationId: "legacy-meeting-started",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-07T09:00:00.000Z",
            observedAt: "2026-08-07T09:00:00.000Z",
            title: "Legacy meeting",
            startedAt: "2026-08-07T09:00:00.000Z",
            languageMode: "en",
            participantIds: []
          }
        ]
      });
      await database.query(
        `UPDATE meetings
            SET state_json = (
              state_json::jsonb
                - 'importedSources'
                - 'importedActionItemCandidates'
                - 'currentImportedActionItemCandidateIds'
            )::TEXT
          WHERE workspace_id = $1 AND meeting_id = $2`,
        [workspace.workspaceId, meetingId]
      );

      const update = await ingestion.ingest({
        workspace,
        source: observedMeetingNote()
      });

      expect(update.acceptedObservationIds).toEqual([
        "meeting-note-import:notion:meeting-notes-root:r1"
      ]);

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(snapshot.state.importedSources).toHaveLength(1);
      expect(snapshot.state.importedActionItemCandidates).toHaveLength(4);
    } finally {
      await database.close();
    }
  });

  it("upgrades legacy unqualified work-item IDs to Linear work-item references", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });

    try {
      await ingestion.ingest({ workspace, source: observedMeetingNote() });
      await database.query(
        `UPDATE meetings
            SET state_json = jsonb_set(
              state_json::jsonb #- '{importedActionItemCandidates,1,mentionedWorkItemReferences}',
              '{importedActionItemCandidates,1,mentionedWorkItemIds}',
              '["LUM-3"]'::jsonb
            )::TEXT
          WHERE workspace_id = $1 AND meeting_id = $2`,
        [workspace.workspaceId, "meeting:source:notion:meeting-notes-root"]
      );

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      const legacyCandidate = snapshot.state.importedActionItemCandidates.find(
        (candidate) =>
          candidate.id === "candidate:notion:meeting-notes-root:r1:block:action-request"
      );

      expect(legacyCandidate?.mentionedWorkItemReferences).toEqual([
        {
          providerId: "linear",
          objectType: "work-item",
          externalId: "LUM-3"
        }
      ]);
    } finally {
      await database.close();
    }
  });

  it("preserves legacy candidate fields while a later readable empty revision clears current work", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });

    try {
      await ingestion.ingest({ workspace, source: observedMeetingNote() });
      await database.query(
        `UPDATE meetings
            SET state_json = jsonb_set(
              state_json::jsonb
                #- '{importedSources,0,completenessReasons}'
                #- '{importedSources,0,actionItemsAvailability}'
                #- '{importedActionItemCandidates,0,completion}'
                #- '{importedActionItemCandidates,0,source,source,completenessReasons}'
                #- '{importedActionItemCandidates,0,source,source,actionItemsAvailability}',
              '{importedActionItemCandidates,0,modality,kind}',
              '"completed"'::jsonb
            )::TEXT
          WHERE workspace_id = $1 AND meeting_id = $2`,
        [workspace.workspaceId, "meeting:source:notion:meeting-notes-root"]
      );
      const downgradedState = await database.query<{
        source_completeness_reasons: string | null;
        source_action_items_availability: string | null;
        candidate_completion: string | null;
      }>(
        `SELECT
            state_json::jsonb #> '{importedSources,0,completenessReasons}' AS source_completeness_reasons,
            state_json::jsonb #> '{importedSources,0,actionItemsAvailability}' AS source_action_items_availability,
            state_json::jsonb #> '{importedActionItemCandidates,0,completion}' AS candidate_completion
          FROM meetings
          WHERE workspace_id = $1 AND meeting_id = $2`,
        [workspace.workspaceId, "meeting:source:notion:meeting-notes-root"]
      );

      expect(downgradedState.rows).toEqual([
        {
          source_completeness_reasons: null,
          source_action_items_availability: null,
          candidate_completion: null
        }
      ]);

      const retry = await ingestion.ingest({ workspace, source: observedMeetingNote() });

      expect(retry.duplicateObservationIds).toEqual([
        "meeting-note-import:notion:meeting-notes-root:r1"
      ]);

      await ingestion.ingest({
        workspace,
        source: observedMeetingNoteWithEmptyActionItems()
      });

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion:meeting-notes-root",
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      const legacyCandidate = snapshot.state.importedActionItemCandidates.find(
        (candidate) =>
          candidate.id ===
          "candidate:notion:meeting-notes-root:r1:block:action-commitment"
      );
      const legacySource = snapshot.state.importedSources.find(
        (source) => source.sourceRevision === 1
      );

      expect(legacyCandidate?.completion).toBe("completed");
      expect(legacyCandidate?.modality).toEqual({ kind: "unknown", sourceForm: "will" });
      expect(legacyCandidate?.source.source.completenessReasons).toEqual([]);
      expect(legacyCandidate?.source.source.actionItemsAvailability).toBe("available");
      expect(legacySource).toMatchObject({
        completenessReasons: [],
        actionItemsAvailability: "available"
      });
      expect(snapshot.state.currentImportedActionItemCandidateIds).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("rejects unbound source Evidence and immutable source revision conflicts", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const direct = directImportedMeetingObservation();
    const firstSourceEvidence = direct.evidence[0];

    if (!firstSourceEvidence) {
      throw new Error("expected source Evidence");
    }

    const extraEvidence = {
      ...firstSourceEvidence,
      evidenceId: "evidence:meeting-note:notion:extra-private-content",
      excerpt: "unbound private content"
    };

    try {
      const unbound = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            ...direct,
            evidence: [...direct.evidence, extraEvidence]
          }
        ]
      });

      expect(unbound.acceptedObservationIds).toEqual([]);
      expect(unbound.errors).toEqual([
        expect.objectContaining({
          code: "invalid-observation",
          message:
            "Imported source Evidence does not exactly match the declared source sections and Action Item blocks"
        })
      ]);

      const accepted = await meetingIntelligence.observe({
        workspace,
        observations: [direct]
      });

      expect(accepted.acceptedObservationIds).toEqual([direct.observationId]);

      const conflict = directImportedMeetingObservation({
        contentHash: "sha256:direct-meeting-note-conflict"
      });
      const rejectedConflict = await meetingIntelligence.observe({
        workspace,
        observations: [conflict]
      });

      expect(rejectedConflict.acceptedObservationIds).toEqual([]);
      expect(rejectedConflict.duplicateObservationIds).toEqual([]);
      expect(rejectedConflict.errors).toEqual([
        expect.objectContaining({
          code: "invalid-observation",
          message: "Imported source revision conflicts with the immutable source history"
        })
      ]);
    } finally {
      await database.close();
    }
  });

  it("requires Action Items availability to match the source-section manifest", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const observation = directImportedMeetingObservation();
    const candidate = observation.candidates[0];

    if (!candidate) {
      throw new Error("expected source Action Item Candidate");
    }

    const withoutActionItemsSection = {
      ...observation,
      sourceSections: observation.sourceSections.filter(
        (section) => section.section !== "action-items-and-notes"
      ),
      evidence: observation.evidence.filter(
        (evidence) =>
          !evidence.evidenceId.includes(":section:action-items-and-notes") &&
          !evidence.evidenceId.includes(":block:direct-action")
      ),
      candidates: []
    } satisfies MeetingImportedFromSource;
    const unavailableWithActionItemsSection = {
      ...observation,
      source: {
        ...observation.source,
        actionItemsAvailability: "unavailable"
      },
      candidates: [
        {
          ...candidate,
          source: {
            ...candidate.source,
            source: {
              ...candidate.source.source,
              actionItemsAvailability: "unavailable"
            }
          }
        }
      ]
    } satisfies MeetingImportedFromSource;
    const candidateWithUnknownAvailability = {
      ...observation,
      candidates: [
        {
          ...candidate,
          source: {
            ...candidate.source,
            source: {
              ...candidate.source.source,
              actionItemsAvailability: "unknown"
            }
          }
        }
      ]
    } satisfies MeetingImportedFromSource;

    try {
      const declaredAvailableWithoutSection = await meetingIntelligence.observe({
        workspace,
        observations: [withoutActionItemsSection]
      });
      const declaredUnavailableWithSection = await meetingIntelligence.observe({
        workspace,
        observations: [unavailableWithActionItemsSection]
      });
      const candidateWithContradictorySource = await meetingIntelligence.observe({
        workspace,
        observations: [candidateWithUnknownAvailability]
      });

      expect(declaredAvailableWithoutSection.errors).toEqual([
        expect.objectContaining({
          code: "invalid-observation",
          message:
            "Imported Action Items availability does not match the source-section manifest"
        })
      ]);
      expect(declaredUnavailableWithSection.errors).toEqual([
        expect.objectContaining({
          code: "invalid-observation",
          message:
            "Imported Action Items availability does not match the source-section manifest"
        })
      ]);
      expect(candidateWithContradictorySource.errors).toEqual([
        expect.objectContaining({
          code: "invalid-observation",
          message:
            "Imported Action Item Candidate candidate:notion:direct-meeting-notes-root:r1:block:direct-action does not match the observed source identity"
        })
      ]);
    } finally {
      await database.close();
    }
  });

  it("atomically rolls back source acceptance when an Evidence write fails", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });
    const source = observedMeetingNote();

    try {
      await database.exec(`
        CREATE FUNCTION reject_source_evidence_write() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'forced source Evidence write failure';
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER reject_source_evidence_write
        BEFORE INSERT ON evidence
        FOR EACH ROW
        EXECUTE FUNCTION reject_source_evidence_write();
      `);

      await expect(ingestion.ingest({ workspace, source })).rejects.toThrow(
        "forced source Evidence write failure"
      );

      const observations = await database.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count FROM meeting_observations`
      );
      const evidence = await database.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count FROM evidence`
      );
      const meetings = await database.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count FROM meetings`
      );

      expect(observations.rows).toEqual([{ count: "0" }]);
      expect(evidence.rows).toEqual([{ count: "0" }]);
      expect(meetings.rows).toEqual([{ count: "0" }]);

      await database.exec(`
        DROP TRIGGER reject_source_evidence_write ON evidence;
        DROP FUNCTION reject_source_evidence_write();
      `);

      const retry = await ingestion.ingest({ workspace, source });

      expect(retry.acceptedObservationIds).toEqual([
        "meeting-note-import:notion:meeting-notes-root:r1"
      ]);
    } finally {
      await database.close();
    }
  });

  it("rejects forged source Evidence without consuming the source revision idempotency key", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const observation = directImportedMeetingObservation();
    const firstCandidate = observation.candidates[0];

    if (!firstCandidate) {
      throw new Error("expected source Action Item Candidate");
    }

    const firstEvidence = firstCandidate.evidence[0];

    if (!firstEvidence) {
      throw new Error("expected source Evidence");
    }

    const forged = {
      ...observation,
      candidates: [
        {
          ...firstCandidate,
          evidence: [
            {
              ...firstEvidence,
              excerpt: "forged source Evidence"
            }
          ]
        }
      ]
    };

    try {
      const rejected = await meetingIntelligence.observe({
        workspace,
        observations: [forged]
      });

      expect(rejected.acceptedObservationIds).toEqual([]);
      expect(rejected.errors).toEqual([
        expect.objectContaining({ code: "invalid-observation" })
      ]);

      const corrected = await meetingIntelligence.observe({
        workspace,
        observations: [observation]
      });

      expect(corrected.acceptedObservationIds).toEqual([observation.observationId]);
    } finally {
      await database.close();
    }
  });

  it("rejects a candidate that claims an Action Item block absent from the source manifest", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const observation = directImportedMeetingObservation();
    const candidate = observation.candidates[0];
    const candidateEvidence = candidate?.evidence[0];

    if (!candidate || !candidateEvidence) {
      throw new Error("expected source Action Item Candidate and Evidence");
    }

    const sourceBlockId = "fabricated-action";
    const fabricatedEvidence = {
      ...candidateEvidence,
      evidenceId:
        "evidence:meeting-note:notion:direct-meeting-notes-root:r1:block:fabricated-action",
      sourceObjectId: sourceBlockId
    };
    const fabricated = {
      ...observation,
      evidence: observation.evidence.map((evidence) =>
        evidence.evidenceId === candidateEvidence.evidenceId
          ? fabricatedEvidence
          : evidence
      ),
      candidates: [
        {
          ...candidate,
          id: "candidate:notion:direct-meeting-notes-root:r1:block:fabricated-action",
          lineageKey:
            "candidate:notion:direct-meeting-notes-root:block:fabricated-action",
          source: {
            ...candidate.source,
            sourceBlockId
          },
          evidence: [fabricatedEvidence]
        }
      ]
    } satisfies MeetingImportedFromSource;

    try {
      const rejected = await meetingIntelligence.observe({
        workspace,
        observations: [fabricated]
      });

      const invalidError = rejected.errors[0];

      if (!invalidError || invalidError.code !== "invalid-observation") {
        throw new Error("expected an invalid Observation error");
      }

      expect(invalidError.message).toContain("source Action Item block");

      const corrected = await meetingIntelligence.observe({
        workspace,
        observations: [observation]
      });

      expect(corrected.acceptedObservationIds).toEqual([observation.observationId]);
    } finally {
      await database.close();
    }
  });

  it("rejects candidates that alter their source wording", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const observation = directImportedMeetingObservation();
    const candidate = observation.candidates[0];

    if (!candidate) {
      throw new Error("expected source Action Item Candidate");
    }

    const forged = {
      ...observation,
      candidates: [
        {
          ...candidate,
          description: "Unrelated work proposal"
        }
      ]
    };

    try {
      const rejected = await meetingIntelligence.observe({
        workspace,
        observations: [forged]
      });

      expect(rejected.acceptedObservationIds).toEqual([]);
      expect(rejected.errors).toEqual([
        expect.objectContaining({ code: "invalid-observation" })
      ]);

      const corrected = await meetingIntelligence.observe({
        workspace,
        observations: [observation]
      });

      expect(corrected.acceptedObservationIds).toEqual([observation.observationId]);
    } finally {
      await database.close();
    }
  });

  it("rejects an Action Item block that is not grounded in the declared Action Items source evidence", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const observation = directImportedMeetingObservation({
      contentHash: "sha256:direct-ungrounded-action-block"
    });
    const ungrounded = {
      ...observation,
      sourceSections: observation.sourceSections.map((section) =>
        section.section === "action-items-and-notes"
          ? { ...section, excerpt: "A harmless source section without this Action Item." }
          : section
      ),
      evidence: observation.evidence.map((evidence) =>
        evidence.sourceObjectId === "direct-action-items-block"
          ? {
              ...evidence,
              excerpt: "A harmless source section without this Action Item."
            }
          : evidence
      )
    } satisfies MeetingImportedFromSource;

    try {
      const rejected = await meetingIntelligence.observe({
        workspace,
        observations: [ungrounded]
      });

      expect(rejected.acceptedObservationIds).toEqual([]);
      expect(rejected.errors[0]).toMatchObject({
        code: "invalid-observation"
      });
      expect(
        rejected.errors[0]?.code === "invalid-observation"
          ? rejected.errors[0].message
          : ""
      ).toContain("not grounded in the Action Items section");
    } finally {
      await database.close();
    }
  });

  it("accepts an exact source deadline when its phrase and calendar date are grounded", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const observation = directImportedMeetingObservation({
      contentHash: "sha256:direct-exact-deadline",
      candidateExcerpt: "Jakob will review the source import by 2026-08-07."
    });
    const candidate = observation.candidates[0];

    if (!candidate) {
      throw new Error("expected source Action Item Candidate");
    }

    const exactDeadline = {
      ...observation,
      candidates: [
        {
          ...candidate,
          deadline: {
            originalPhrase: "by 2026-08-07",
            normalizedDate: "2026-08-07",
            confidence: "exact" as const,
            timezone: workspace.timezone
          }
        }
      ]
    } satisfies MeetingImportedFromSource;

    try {
      const accepted = await meetingIntelligence.observe({
        workspace,
        observations: [exactDeadline]
      });

      expect(accepted.acceptedObservationIds).toEqual([exactDeadline.observationId]);
    } finally {
      await database.close();
    }
  });

  it("rejects source semantic metadata and hints that cannot be derived from canonical wording", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const observation = directImportedMeetingObservation({
      contentHash: "sha256:direct-semantic-binding"
    });
    const candidate = observation.candidates[0];

    if (!candidate) {
      throw new Error("expected source Action Item Candidate");
    }

    const forgedModality = {
      ...observation,
      candidates: [
        {
          ...candidate,
          modality: { kind: "question" as const, sourceForm: "Could" }
        }
      ]
    } satisfies MeetingImportedFromSource;
    const forgedHint = {
      ...observation,
      candidates: [{ ...candidate, projectHints: ["private-project"] }]
    } satisfies MeetingImportedFromSource;
    const forgedConfirmedOwnership = {
      ...observation,
      candidates: [
        {
          ...candidate,
          ownership: {
            status: "confirmed" as const,
            ownerPersonId: "person:forged",
            confidence: "deterministic" as const,
            basis: "human-confirmation" as const
          }
        }
      ]
    } satisfies MeetingImportedFromSource;
    const forgedUnassignedOwnership = {
      ...observation,
      candidates: [
        {
          ...candidate,
          ownership: {
            status: "intentionally-unassigned" as const,
            basis: "human-confirmation" as const
          }
        }
      ]
    } satisfies MeetingImportedFromSource;

    try {
      const modalityRejected = await meetingIntelligence.observe({
        workspace,
        observations: [forgedModality]
      });
      const hintRejected = await meetingIntelligence.observe({
        workspace,
        observations: [forgedHint]
      });
      const confirmedOwnershipRejected = await meetingIntelligence.observe({
        workspace,
        observations: [forgedConfirmedOwnership]
      });
      const unassignedOwnershipRejected = await meetingIntelligence.observe({
        workspace,
        observations: [forgedUnassignedOwnership]
      });
      const modalityError = modalityRejected.errors[0];
      const hintError = hintRejected.errors[0];

      expect(modalityError?.code).toBe("invalid-observation");
      expect(
        modalityError?.code === "invalid-observation" ? modalityError.message : ""
      ).toContain("modality metadata");
      expect(hintError?.code).toBe("invalid-observation");
      expect(
        hintError?.code === "invalid-observation" ? hintError.message : ""
      ).toContain("project hint that does not occur");
      expect(confirmedOwnershipRejected.errors[0]).toMatchObject({
        code: "invalid-observation"
      });
      expect(
        confirmedOwnershipRejected.errors[0]?.code === "invalid-observation"
          ? confirmedOwnershipRejected.errors[0].message
          : ""
      ).toContain("ownership attribution");
      expect(unassignedOwnershipRejected.errors[0]).toMatchObject({
        code: "invalid-observation"
      });
      expect(
        unassignedOwnershipRejected.errors[0]?.code === "invalid-observation"
          ? unassignedOwnershipRejected.errors[0].message
          : ""
      ).toContain("ownership attribution");

      const corrected = await meetingIntelligence.observe({
        workspace,
        observations: [observation]
      });

      expect(corrected.acceptedObservationIds).toEqual([observation.observationId]);
    } finally {
      await database.close();
    }
  });

  it("rejects a source document reference that is not bound to its Notion identity", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const observation = directImportedMeetingObservation({
      contentHash: "sha256:direct-source-reference-binding"
    });
    const candidate = observation.candidates[0];

    if (!candidate) {
      throw new Error("expected source Action Item Candidate");
    }

    const forgedReference = {
      providerId: "github",
      objectType: "document" as const,
      externalId: "github-private-document",
      url: "https://github.com/dayova/private",
      version: observation.source.providerVersion ?? observation.source.contentHash
    };
    const forgedSource = {
      ...observation.source,
      externalReference: forgedReference
    };
    const forged = {
      ...observation,
      source: forgedSource,
      evidence: observation.evidence.map((evidence) => ({
        ...evidence,
        externalReference: forgedReference
      })),
      candidates: [
        {
          ...candidate,
          source: { ...candidate.source, source: forgedSource },
          evidence: candidate.evidence.map((evidence) => ({
            ...evidence,
            externalReference: forgedReference
          }))
        }
      ]
    } satisfies MeetingImportedFromSource;

    try {
      const rejected = await meetingIntelligence.observe({
        workspace,
        observations: [forged]
      });
      const invalidError = rejected.errors[0];

      expect(invalidError?.code).toBe("invalid-observation");
      expect(
        invalidError?.code === "invalid-observation" ? invalidError.message : ""
      ).toContain("external reference is not bound");
    } finally {
      await database.close();
    }
  });

  it("rejects a direct source candidate whose deadline timezone differs from the workspace", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const observation = directImportedMeetingObservation();
    const candidate = observation.candidates[0];

    if (!candidate) {
      throw new Error("expected source Action Item Candidate");
    }

    const wrongTimezone = {
      ...observation,
      candidates: [
        {
          ...candidate,
          deadline: {
            ...candidate.deadline,
            timezone: "UTC"
          }
        }
      ]
    } satisfies MeetingImportedFromSource;

    try {
      const rejected = await meetingIntelligence.observe({
        workspace,
        observations: [wrongTimezone]
      });

      expect(rejected.acceptedObservationIds).toEqual([]);
      const invalidError = rejected.errors[0];

      if (!invalidError || invalidError.code !== "invalid-observation") {
        throw new Error("expected an invalid Observation error");
      }

      expect(invalidError.message).toContain("deadline timezone");

      const corrected = await meetingIntelligence.observe({
        workspace,
        observations: [observation]
      });

      expect(corrected.acceptedObservationIds).toEqual([observation.observationId]);
    } finally {
      await database.close();
    }
  });

  it("rejects contradictory direct source deadline metadata", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const observation = directImportedMeetingObservation();
    const candidate = observation.candidates[0];

    if (!candidate) {
      throw new Error("expected source Action Item Candidate");
    }

    const malformed = {
      ...observation,
      candidates: [
        {
          ...candidate,
          deadline: {
            originalPhrase: null,
            normalizedDate: "2026-99-99",
            confidence: "normalized",
            timezone: workspace.timezone
          }
        }
      ]
    } satisfies MeetingImportedFromSource;

    try {
      const rejected = await meetingIntelligence.observe({
        workspace,
        observations: [malformed]
      });

      const invalidError = rejected.errors[0];

      if (!invalidError || invalidError.code !== "invalid-observation") {
        throw new Error("expected an invalid Observation error");
      }

      expect(invalidError.message).toContain("deadline metadata that does not match");

      const corrected = await meetingIntelligence.observe({
        workspace,
        observations: [observation]
      });

      expect(corrected.acceptedObservationIds).toEqual([observation.observationId]);
    } finally {
      await database.close();
    }
  });

  it("re-derives a relative deadline from its immutable source instant and rejects arbitrary dates or shortened phrases", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const observation = directImportedMeetingObservation({
      contentHash: "sha256:direct-deadline-rederivation"
    });
    const candidate = observation.candidates[0];

    if (!candidate) {
      throw new Error("expected source Action Item Candidate");
    }

    const arbitraryDate = {
      ...observation,
      candidates: [
        {
          ...candidate,
          deadline: {
            ...candidate.deadline,
            normalizedDate: "2030-01-01"
          }
        }
      ]
    } satisfies MeetingImportedFromSource;
    const shortenedPhrase = {
      ...observation,
      candidates: [
        {
          ...candidate,
          deadline: {
            ...candidate.deadline,
            originalPhrase: "Friday"
          }
        }
      ]
    } satisfies MeetingImportedFromSource;

    try {
      const [dateRejected, phraseRejected] = await Promise.all([
        meetingIntelligence.observe({ workspace, observations: [arbitraryDate] }),
        meetingIntelligence.observe({ workspace, observations: [shortenedPhrase] })
      ]);

      expect(dateRejected.acceptedObservationIds).toEqual([]);
      expect(phraseRejected.acceptedObservationIds).toEqual([]);
      expect(dateRejected.errors[0]).toMatchObject({ code: "invalid-observation" });
      expect(phraseRejected.errors[0]).toMatchObject({ code: "invalid-observation" });

      const corrected = await meetingIntelligence.observe({
        workspace,
        observations: [observation]
      });
      expect(corrected.acceptedObservationIds).toEqual([observation.observationId]);
    } finally {
      await database.close();
    }
  });

  it("rejects a direct source deadline phrase that is not present in its canonical source excerpt", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const observation = directImportedMeetingObservation();
    const candidate = observation.candidates[0];

    if (!candidate) {
      throw new Error("expected source Action Item Candidate");
    }

    const forgedDeadline = {
      ...observation,
      candidates: [
        {
          ...candidate,
          deadline: {
            originalPhrase: "by Monday",
            normalizedDate: "2026-08-10",
            confidence: "normalized",
            timezone: workspace.timezone
          }
        }
      ]
    } satisfies MeetingImportedFromSource;

    try {
      const rejected = await meetingIntelligence.observe({
        workspace,
        observations: [forgedDeadline]
      });
      const invalidError = rejected.errors[0];

      if (!invalidError || invalidError.code !== "invalid-observation") {
        throw new Error("expected an invalid Observation error");
      }

      expect(invalidError.message).toContain("deadline metadata that does not match");

      const corrected = await meetingIntelligence.observe({
        workspace,
        observations: [observation]
      });

      expect(corrected.acceptedObservationIds).toEqual([observation.observationId]);
    } finally {
      await database.close();
    }
  });

  it("rejects a direct work-item reference that is not present in its canonical source excerpt", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const observation = directImportedMeetingObservation();
    const candidate = observation.candidates[0];

    if (!candidate) {
      throw new Error("expected source Action Item Candidate");
    }

    const forgedReference = {
      ...observation,
      candidates: [
        {
          ...candidate,
          mentionedWorkItemReferences: [
            {
              providerId: "linear",
              objectType: "work-item",
              externalId: "LUM-3"
            }
          ]
        }
      ]
    } satisfies MeetingImportedFromSource;

    try {
      const rejected = await meetingIntelligence.observe({
        workspace,
        observations: [forgedReference]
      });
      const invalidError = rejected.errors[0];

      if (!invalidError || invalidError.code !== "invalid-observation") {
        throw new Error("expected an invalid Observation error");
      }

      expect(invalidError.message).toContain("work-item reference that does not occur");

      const corrected = await meetingIntelligence.observe({
        workspace,
        observations: [observation]
      });

      expect(corrected.acceptedObservationIds).toEqual([observation.observationId]);
    } finally {
      await database.close();
    }
  });

  it("rejects a direct GitHub implementation reference that is not exact source evidence", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const observation = directImportedMeetingObservation({
      contentHash: "sha256:direct-source-bound-github-reference",
      candidateExcerpt:
        "Jakob will review https://github.com/Dayova/Luma/pull/42 by Friday."
    });
    const candidate = observation.candidates[0];

    if (!candidate) {
      throw new Error("expected source Action Item Candidate");
    }

    const forgedReference = {
      ...observation,
      candidates: [
        {
          ...candidate,
          sourceBoundImplementationReferences: [
            {
              providerId: "github-code",
              objectType: "commit" as const,
              externalId: "Dayova/Luma@0123456789abcdef0123456789abcdef01234567",
              url: "https://github.com/Dayova/Luma/commit/0123456789abcdef0123456789abcdef01234567"
            }
          ]
        }
      ]
    } satisfies MeetingImportedFromSource;

    try {
      const rejected = await meetingIntelligence.observe({
        workspace,
        observations: [forgedReference]
      });
      const invalidError = rejected.errors[0];

      if (!invalidError || invalidError.code !== "invalid-observation") {
        throw new Error("expected an invalid Observation error");
      }

      expect(invalidError.message).toContain(
        "does not declare exactly the GitHub implementation references"
      );

      const corrected = await meetingIntelligence.observe({
        workspace,
        observations: [observation]
      });

      expect(corrected.acceptedObservationIds).toEqual([observation.observationId]);
    } finally {
      await database.close();
    }
  });

  it("replays a pre-LUM-10 imported source payload as the same immutable Observation", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const observation = directImportedMeetingObservation({
      candidateExcerpt:
        "Jakob will review https://github.com/Dayova/Luma/pull/42 by Friday."
    });

    try {
      const accepted = await meetingIntelligence.observe({
        workspace,
        observations: [observation]
      });

      expect(accepted.errors).toEqual([]);
      expect(accepted.acceptedObservationIds).toEqual([observation.observationId]);

      const stored = await database.query<{ payload_json: string }>(
        `SELECT payload_json
           FROM meeting_observations
          WHERE workspace_id = $1 AND observation_id = $2`,
        [workspace.workspaceId, observation.observationId]
      );
      const payloadJson = stored.rows[0]?.payload_json;

      if (!payloadJson) {
        throw new Error("expected persisted imported-source Observation");
      }

      const legacyPayload = JSON.parse(payloadJson) as Record<string, unknown>;
      const legacySource = legacyPayload["source"] as Record<string, unknown>;
      const legacyCandidates = legacyPayload["candidates"] as Record<string, unknown>[];

      delete legacySource["implementationReferenceProviderId"];

      for (const legacyCandidate of legacyCandidates) {
        delete legacyCandidate["sourceBoundImplementationReferences"];
        const legacyCandidateSource = legacyCandidate["source"] as Record<
          string,
          unknown
        >;
        const nestedLegacySource = legacyCandidateSource["source"] as Record<
          string,
          unknown
        >;

        delete nestedLegacySource["implementationReferenceProviderId"];
      }

      await database.query(
        `UPDATE meeting_observations
            SET payload_json = $3
          WHERE workspace_id = $1 AND observation_id = $2`,
        [workspace.workspaceId, observation.observationId, JSON.stringify(legacyPayload)]
      );

      const malformedIncoming = JSON.parse(
        JSON.stringify(legacyPayload)
      ) as MeetingImportedFromSource;
      const malformed = await meetingIntelligence.observe({
        workspace,
        observations: [malformedIncoming]
      });

      expect(malformed.acceptedObservationIds).toEqual([]);
      expect(malformed.errors).toHaveLength(1);
      const malformedError = malformed.errors[0];

      if (!malformedError || malformedError.code !== "invalid-observation") {
        throw new Error("expected an invalid imported-source Observation error");
      }

      expect(malformedError.message).toContain(
        "does not declare an implementation reference provider identity"
      );

      const replay = await meetingIntelligence.observe({
        workspace,
        observations: [observation]
      });

      expect(replay.duplicateObservationIds).toEqual([observation.observationId]);
      expect(replay.errors).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("requires every source work-item identifier to use the source WorkProvider identity", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const sourceText = "Jakob will review LUM-3 by Friday.";
    const observation = directImportedMeetingObservation({
      contentHash: "sha256:direct-provider-qualified-work-reference",
      candidateExcerpt: sourceText
    });
    const candidate = observation.candidates[0];
    const candidateEvidence = candidate?.evidence[0];

    if (!candidate || !candidateEvidence) {
      throw new Error("expected source Action Item Candidate and Evidence");
    }

    const rewrittenCandidate = {
      ...candidate,
      mentionedWorkItemReferences: [
        { providerId: "github", objectType: "work-item" as const, externalId: "LUM-3" }
      ]
    } satisfies MeetingImportedFromSource["candidates"][number];
    const wrongProvider = {
      ...observation,
      candidates: [rewrittenCandidate]
    } satisfies MeetingImportedFromSource;
    const corrected = {
      ...wrongProvider,
      candidates: [
        {
          ...rewrittenCandidate,
          mentionedWorkItemReferences: [
            {
              providerId: "linear",
              objectType: "work-item" as const,
              externalId: "LUM-3"
            }
          ]
        }
      ]
    } satisfies MeetingImportedFromSource;

    try {
      const rejected = await meetingIntelligence.observe({
        workspace,
        observations: [wrongProvider]
      });
      const invalidError = rejected.errors[0];

      expect(invalidError?.code).toBe("invalid-observation");
      expect(
        invalidError?.code === "invalid-observation" ? invalidError.message : ""
      ).toContain("does not declare exactly");

      const accepted = await meetingIntelligence.observe({
        workspace,
        observations: [corrected]
      });

      expect(accepted.acceptedObservationIds).toEqual([corrected.observationId]);
    } finally {
      await database.close();
    }
  });

  it("does not bind a shorter work-item identifier inside a longer source identifier", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const observation = directImportedMeetingObservation();
    const candidate = observation.candidates[0];

    if (!candidate) {
      throw new Error("expected source Action Item Candidate");
    }

    const candidateEvidence = candidate.evidence[0];

    if (!candidateEvidence) {
      throw new Error("expected source Action Item Evidence");
    }

    const sourceText = "Jakob will review LUM-30 by Friday.";
    const forgedShortReference = {
      ...observation,
      evidence: observation.evidence.map((evidence) =>
        evidence.evidenceId === candidateEvidence.evidenceId
          ? { ...evidence, excerpt: sourceText }
          : evidence
      ),
      candidates: [
        {
          ...candidate,
          originalText: sourceText,
          description: sourceText,
          source: {
            ...candidate.source,
            sourceExcerpt: sourceText
          },
          evidence: [
            {
              ...candidateEvidence,
              excerpt: sourceText
            }
          ],
          mentionedWorkItemReferences: [
            {
              providerId: "linear",
              objectType: "work-item",
              externalId: "LUM-3"
            }
          ]
        }
      ]
    } satisfies MeetingImportedFromSource;

    try {
      const rejected = await meetingIntelligence.observe({
        workspace,
        observations: [forgedShortReference]
      });
      const invalidError = rejected.errors[0];

      if (!invalidError || invalidError.code !== "invalid-observation") {
        throw new Error("expected an invalid Observation error");
      }

      expect(invalidError.message).toContain("work-item reference that does not occur");
    } finally {
      await database.close();
    }
  });

  it("encodes opaque provider identifiers before using them in Luma-owned compound IDs", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new NoAnalysisReasoningModel()
    });
    const workspace = {
      workspaceId: "workspace_dayova",
      timezone: "Europe/Berlin"
    };
    const source = observedMeetingNote({
      contentHash: "sha256:meeting-note-with-opaque-identifiers"
    });
    source.source.providerId = "notion:internal";
    source.source.sourceObjectId = "meeting:notes/root";
    const actionItems = source.snapshot.sections.actionItemsAndNotes;

    if (actionItems.state !== "available") {
      throw new Error("expected available source Action Items");
    }

    const action = actionItems.blocks[0];

    if (!action) {
      throw new Error("expected source Action Item");
    }

    actionItems.blocks = [{ ...action, id: "action:block/one" }];
    const ingestion = createMeetingNotesIngestion({ meetingIntelligence });

    try {
      const update = await ingestion.ingest({ workspace, source });

      expect(update.acceptedObservationIds).toEqual([
        "meeting-note-import:notion%3Ainternal:meeting%3Anotes%2Froot:r1"
      ]);

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId: "meeting:source:notion%3Ainternal:meeting%3Anotes%2Froot",
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(snapshot.state.importedActionItemCandidates).toEqual([
        expect.objectContaining({
          id: "candidate:notion%3Ainternal:meeting%3Anotes%2Froot:r1:block:action%3Ablock%2Fone",
          lineageKey:
            "candidate:notion%3Ainternal:meeting%3Anotes%2Froot:block:action%3Ablock%2Fone"
        })
      ]);
    } finally {
      await database.close();
    }
  });
});
