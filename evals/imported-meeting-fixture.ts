import type { LumaDatabase } from "../src/persistence/db.js";
import type { HumanJudgment, MeetingImportedFromSource } from "../src/domain/model.js";
import type {
  MeetingAnalysisProposalBatch,
  StructuredReasoningRequest
} from "../src/ai/reasoning-model.js";
import type {
  ContextAudience,
  ContextCatalog,
  OrganizationalContext,
  OrganizationalContextRequest
} from "../src/organizational-context/interface.js";
import {
  createObservedSourceLedger,
  type RawMeetingNoteSnapshot
} from "../src/knowledge/observed-source-ledger.js";
import { createGrantedImportedSourceAnalysisAccess } from "../src/knowledge/granted-imported-source-analysis-access.js";
import { createLedgerBackedImportedSourceVerifier } from "../src/knowledge/ledger-backed-imported-source-verifier.js";
import { observedMeetingNoteToObservation } from "../src/knowledge/meeting-notes-ingestion.js";
import { createMeetingIntelligence } from "../src/meeting-intelligence/meeting-intelligence.js";
import {
  createImportedMeetingContextCatalog,
  importedMeetingContextCatalogId
} from "../src/meeting-intelligence/imported-meeting-context-catalog.js";
import {
  createOrganizationalContext,
  createExternalContextReceiptVerifier
} from "../src/organizational-context/organizational-context.js";

/** Real admission, ledger and MI; only provider reads and model proposals are synthetic. */
export function importedMeetingFixture(
  database: LumaDatabase,
  workspaceId = "eval-imported-recall"
) {
  const time = "2026-09-11T09:00:00.000Z";
  const workspace = { workspaceId, timezone: "Europe/Berlin" };
  const recipients = ["jakob", "fabius", "philipp", "julius"];
  const audience: ContextAudience = { workspaceId, personIds: recipients };
  const ledger = createObservedSourceLedger({ database });
  const records = new Map<
    string,
    {
      snapshot: RawMeetingNoteSnapshot;
      readers: string[];
      observation: MeetingImportedFromSource;
    }
  >();
  let afterRead: (() => Promise<void>) | undefined;
  const access = createGrantedImportedSourceAnalysisAccess({
    ledger,
    authorize: (request) =>
      Promise.resolve(
        request.audience.personIds.every((person) =>
          records.get(request.source.sourceObjectId)?.readers.includes(person)
        )
      ),
    evidenceSource: (source) => ({
      capture: async () => {
        const record = records.get(source.sourceObjectId)!;
        const snapshot = structuredClone(record.snapshot);
        const callback = afterRead;
        afterRead = undefined;
        if (callback) await callback();
        return {
          status: "captured",
          evidence: {
            source: {
              providerId: "notion",
              sourceKind: "meeting-note",
              sourceObjectId: source.sourceObjectId,
              parentObjectId: source.parentObjectId,
              url: source.externalReference.url
            },
            snapshot,
            providerVersion: time,
            observedAt: time
          }
        };
      }
    })
  });
  const requests: StructuredReasoningRequest<unknown>[] = [];
  let proposalStatus: "candidate" | "confirmed" = "candidate";
  let context: OrganizationalContext | undefined;
  let externalCatalogs: ContextCatalog[] | undefined;
  let citeExternal = false;
  const mi = () =>
    createMeetingIntelligence({
      database,
      importedSourceAnalysis: {
        access,
        audience: () => Promise.resolve(structuredClone(audience))
      },
      importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
        ledger
      }),
      ...(context
        ? {
            organizationalContext: context,
            contextAudience: () => Promise.resolve(structuredClone(audience))
          }
        : {}),
      reasoningModel: {
        generateStructured: <T>(request: StructuredReasoningRequest<T>) => {
          requests.push(structuredClone(request));
          const source = request.evidence.find((item) => item.source === "transcript")!;
          const value: MeetingAnalysisProposalBatch = {
            decisions: [
              {
                stableKey: "choice",
                statement: source.excerpt!,
                rationale: [],
                status: proposalStatus,
                supportingParticipantIds: [],
                objectingParticipantIds: [],
                relatedTopicIds: [],
                evidenceIds: [
                  source.evidenceId,
                  ...(citeExternal
                    ? request.evidence
                        .filter((entry) =>
                          entry.evidenceId.startsWith("organizational-context:")
                        )
                        .map((entry) => entry.evidenceId)
                    : [])
                ],
                confidence: "high"
              }
            ],
            actionItems: [],
            openQuestions: [],
            risks: [],
            followUpIntentions: []
          };
          return Promise.resolve({
            value: value as T,
            metadata: {
              provider: "synthetic",
              model: "source-excerpt-decision-v1",
              promptVersion: request.promptVersion
            }
          });
        }
      },
      now: () => new Date(time)
    });
  const catalog = () =>
    createImportedMeetingContextCatalog({
      database,
      sourceAccess: access,
      ...(externalCatalogs
        ? {
            externalContext: createExternalContextReceiptVerifier({
              database,
              catalogs: externalCatalogs,
              ignoredEmptyCatalogIds: [importedMeetingContextCatalogId],
              now: () => new Date(time)
            })
          }
        : {})
    });
  const organizationalContext = () =>
    createOrganizationalContext({
      database,
      catalogs: [catalog()],
      now: () => new Date(time)
    });
  const request = (personIds = recipients): OrganizationalContextRequest => ({
    audience: { workspaceId, personIds },
    subject: { type: "conversation", id: "new-discussion" },
    purpose: "answer-question",
    concepts: ["Luma"],
    time: { mode: "current" },
    limit: 20,
    maxCharacters: 20000
  });
  const ingest = async (
    id: string,
    text: string,
    at = time,
    originalReaders = recipients
  ) => {
    const snapshot: RawMeetingNoteSnapshot = {
      schemaVersion: 1,
      title: "Private Meeting",
      lifecycle: "ready",
      calendar: { startAt: at, endAt: at, attendeeProviderUserIds: [] },
      recording: null,
      sections: {
        summary: { state: "available", sourceBlockId: "summary", text: "", blocks: [] },
        actionItemsAndNotes: {
          state: "available",
          sourceBlockId: "notes",
          text: "",
          blocks: []
        },
        transcript: { state: "available", sourceBlockId: "transcript", text, blocks: [] }
      },
      markdown: { content: "# Private Meeting", truncated: false, unknownBlockIds: [] },
      completeness: { state: "complete" }
    };
    const source = await ledger.record({
      workspaceId,
      source: {
        providerId: "notion",
        sourceKind: "meeting-note",
        sourceObjectId: id,
        parentObjectId: `page-${id}`,
        url: `https://notion.so/page-${id}`
      },
      providerVersion: at,
      snapshot,
      observedAt: at
    });
    const observation = observedMeetingNoteToObservation({ workspace, source }, "linear");
    records.set(id, { snapshot, readers: [...recipients], observation });
    audience.personIds = [...originalReaders];
    const result = await mi().observe({ workspace, observations: [observation] });
    audience.personIds = [...recipients];
    return { observation, result };
  };
  return {
    database,
    workspace,
    audience,
    requests,
    records,
    ledger,
    access,
    catalog,
    organizationalContext,
    request,
    mi,
    ingest,
    status: (value: typeof proposalStatus) => {
      proposalStatus = value;
    },
    compose: (catalogs: ContextCatalog[]) => {
      externalCatalogs = [...catalogs];
      context = createOrganizationalContext({
        database,
        catalogs: [...catalogs, catalog()],
        now: () => new Date(time)
      });
      citeExternal = true;
    },
    context: (value: OrganizationalContext) => {
      context = value;
    },
    afterRead: (callback: () => Promise<void>) => {
      afterRead = callback;
    },
    judge: async (
      observation: MeetingImportedFromSource,
      judgment: HumanJudgment,
      id = "judge"
    ) =>
      mi().observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            workspaceId,
            meetingId: observation.meetingId,
            observationId: id,
            occurredAt: time,
            observedAt: time,
            participantId: "jakob",
            judgment
          }
        ]
      }),
    snapshot: async (observation: MeetingImportedFromSource) => {
      const result = await mi().query({
        workspaceId,
        meetingId: observation.meetingId,
        query: { type: "snapshot" }
      });
      if (result.type !== "snapshot") throw new Error("Wrong query result");
      return result.state;
    }
  };
}
