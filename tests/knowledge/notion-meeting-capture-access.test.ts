import { describe, expect, it } from "vitest";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import {
  createObservedSourceLedger,
  type RawMeetingNoteSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createGrantedImportedSourceAnalysisAccess } from "../../src/knowledge/granted-imported-source-analysis-access.js";
import { createLedgerBackedImportedSourceVerifier } from "../../src/knowledge/ledger-backed-imported-source-verifier.js";
import { createLedgerBackedNotionCaptureRevisionVerifier } from "../../src/knowledge/ledger-backed-notion-capture-revision-verifier.js";
import { createNotionMeetingCaptureAccess } from "../../src/knowledge/notion-meeting-capture-access.js";
import { observedMeetingNoteToObservation } from "../../src/knowledge/meeting-notes-ingestion.js";
import { observedNotionMeetingCapture } from "../../src/knowledge/notion-meeting-capture.js";
import { createMeetingCaptureIngestion } from "../../src/knowledge/meeting-capture-ingestion.js";
import { createLogicalMeetings } from "../../src/logical-meetings/logical-meetings.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import type { StructuredReasoningRequest } from "../../src/ai/reasoning-model.js";
import type { CaptureSynthesisProposal } from "../../src/ai/capture-synthesis-proposal.js";

describe("Notion capture synthesis through the original source grant", () => {
  it("reads exact archived sections, retains the original anchor and withholds access after a grant/source change", async () => {
    const database = await createPgliteDatabase();
    const workspace = { workspaceId: "workspace_dayova", timezone: "Europe/Berlin" };
    const time = "2026-09-11T09:00:00.000Z";
    const identity = {
      providerId: "notion",
      sourceKind: "meeting-note" as const,
      sourceObjectId: "root",
      parentObjectId: "page",
      url: "https://notion.so/page"
    };
    const raw: RawMeetingNoteSnapshot = {
      schemaVersion: 1,
      title: "Release",
      lifecycle: "ready",
      calendar: null,
      recording: null,
      sections: {
        summary: {
          state: "available",
          sourceBlockId: "summary",
          text: "Release starten.",
          blocks: []
        },
        transcript: {
          state: "available",
          sourceBlockId: "transcript",
          text: "Wir könnten starten; das ist keine Zusage.",
          blocks: []
        },
        actionItemsAndNotes: { state: "unavailable", sourceBlockId: null, reasons: [] }
      },
      markdown: { content: "# Release", truncated: false, unknownBlockIds: [] },
      completeness: { state: "complete" }
    };
    let allowed = true;
    let recipients = ["person_jakob"];
    const ledger = createObservedSourceLedger({ database });
    const source = await ledger.record({
      workspaceId: workspace.workspaceId,
      source: identity,
      observedAt: time,
      providerVersion: time,
      snapshot: raw
    });
    const sourceAccess = createGrantedImportedSourceAnalysisAccess({
      ledger,
      authorize: () => Promise.resolve(allowed),
      evidenceSource: () => ({
        capture: () =>
          Promise.resolve({
            status: "captured",
            evidence: {
              source: identity,
              observedAt: time,
              providerVersion: time,
              snapshot: raw
            }
          })
      })
    });
    const logicalMeetings = createLogicalMeetings({
      database,
      captureRevisionVerifier: createLedgerBackedNotionCaptureRevisionVerifier({
        ledger,
        canonicalSourceScopeId: "canonical-notion"
      })
    });
    const audience = () =>
      Promise.resolve({
        workspaceId: workspace.workspaceId,
        personIds: [...recipients]
      });
    const mi = createMeetingIntelligence({
      database,
      importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
        ledger
      }),
      importedSourceAnalysis: { access: sourceAccess, audience },
      reasoningModel: {
        generateStructured: <T>(request: StructuredReasoningRequest<T>) => {
          const material = request.evidence.find((item) => item.source === "transcript")!;
          const synthesis: CaptureSynthesisProposal = {
            claims: [
              {
                key: "launch",
                kind: "decision",
                text: "Noch keine Zusage.",
                evidenceIds: [material.evidenceId],
                quotations: [
                  { evidenceId: material.evidenceId, text: "das ist keine Zusage" }
                ],
                conflictingKeys: [],
                confidence: "high"
              }
            ]
          };
          const value =
            request.schemaName === "CaptureSynthesisProposal"
              ? synthesis
              : {
                  decisions: [],
                  actionItems: [],
                  openQuestions: [],
                  risks: [],
                  followUpIntentions: []
                };
          return Promise.resolve({
            value: value as T,
            metadata: {
              provider: "fixture",
              model: "fixture",
              promptVersion: request.promptVersion
            }
          });
        }
      },
      captureSynthesis: {
        logicalMeetings,
        audience,
        access: createNotionMeetingCaptureAccess({
          database,
          ledger,
          sourceAccess,
          providerId: "notion",
          canonicalSourceScopeId: "canonical-notion",
          authorizationScopeId: "notion-reader-original"
        })
      }
    });
    try {
      const binding = await logicalMeetings.resolveCapture({
        workspaceId: workspace.workspaceId,
        revision: observedNotionMeetingCapture({
          source,
          canonicalSourceScopeId: "canonical-notion"
        })
      });
      if (binding.status !== "accepted") throw new Error("Expected capture binding");
      const ingestion = createMeetingCaptureIngestion({
        workspace,
        meetingIntelligence: mi
      });
      expect(
        (await ingestion.ingest(binding.decision.logicalMeeting)).analysisStatus
      ).toBe("deferred");
      expect(
        (
          await mi.observe({
            workspace,
            observations: [
              observedMeetingNoteToObservation({ workspace, source }, "linear")
            ]
          })
        ).errors
      ).toEqual([]);
      expect(
        (await ingestion.ingest(binding.decision.logicalMeeting)).analysisStatus
      ).toBe("completed");
      const query = () =>
        mi.query({
          workspaceId: workspace.workspaceId,
          meetingId: binding.decision.logicalMeeting.id,
          query: { type: "capture-synthesis" }
        });
      expect(await query()).toMatchObject({
        availability: "available",
        synthesis: {
          canonicalAnchorRef: { externalId: "page" },
          claims: [{ quotations: [{ text: "das ist keine Zusage" }] }]
        }
      });
      recipients = ["person_jakob", "person_fabius"];
      expect(await query()).toMatchObject({
        availability: "unavailable",
        synthesis: null
      });
      recipients = ["person_jakob"];
      allowed = false;
      expect(await query()).toMatchObject({
        availability: "unavailable",
        synthesis: null
      });
      allowed = true;
      raw.sections.transcript = {
        state: "available",
        sourceBlockId: "transcript",
        text: "Changed live source.",
        blocks: []
      };
      expect(await query()).toMatchObject({
        availability: "unavailable",
        synthesis: null
      });
    } finally {
      await database.close();
    }
  });
});
