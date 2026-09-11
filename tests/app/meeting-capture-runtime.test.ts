import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMeetingCaptureRuntime } from "../../src/app/meeting-capture-runtime.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createMeetingNotesIngestion } from "../../src/knowledge/meeting-notes-ingestion.js";
import {
  createObservedSourceLedger,
  type RawMeetingNoteSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createGrantedImportedSourceAnalysisAccess } from "../../src/knowledge/granted-imported-source-analysis-access.js";
import { createLedgerBackedImportedSourceVerifier } from "../../src/knowledge/ledger-backed-imported-source-verifier.js";
import { observedNotionMeetingCapture } from "../../src/knowledge/notion-meeting-capture.js";
import {
  createGranolaPolicy,
  type GranolaConnectionPolicy
} from "../../src/granola/policy.js";
import { granolaAccountFingerprint } from "../../src/granola/wire-format.js";
import type { GranolaMcpClient } from "../../src/granola/mcp-client.js";
import type {
  ReasoningModel,
  StructuredReasoningRequest
} from "../../src/ai/reasoning-model.js";

const workspace = { workspaceId: "workspace_dayova", timezone: "Europe/Berlin" };
const at = "2026-09-11T09:00:00.000Z";
function reasoning() {
  const requests: StructuredReasoningRequest<unknown>[] = [];
  const model: ReasoningModel = {
    generateStructured: <T>(request: StructuredReasoningRequest<T>) => {
      requests.push(request);
      const value =
        request.schemaName === "CaptureSynthesisProposal"
          ? {
              claims: request.evidence.map((evidence, index) => ({
                key: `claim-${index}`,
                kind: "question",
                text: "Launch remains a proposal.",
                evidenceIds: [evidence.evidenceId],
                quotations: [],
                conflictingKeys: [],
                confidence: "medium"
              }))
            }
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
  };
  return { model, requests };
}

describe("meeting capture application composition", () => {
  it("delivers an admitted Notion revision into the same MI, retains its anchor, replays once and withholds revoked material", async () => {
    const database = await createPgliteDatabase();
    const ledger = createObservedSourceLedger({ database });
    const identity = {
      providerId: "notion",
      sourceKind: "meeting-note" as const,
      sourceObjectId: "root",
      parentObjectId: "page",
      url: "https://notion.so/page"
    };
    const snapshot: RawMeetingNoteSnapshot = {
      schemaVersion: 1,
      title: "Release",
      lifecycle: "ready",
      calendar: null,
      recording: null,
      sections: {
        summary: {
          state: "available",
          sourceBlockId: "summary",
          text: "Launch proposal.",
          blocks: []
        },
        transcript: {
          state: "available",
          sourceBlockId: "transcript",
          text: "Wir könnten starten; noch keine Entscheidung.",
          blocks: []
        },
        actionItemsAndNotes: { state: "unavailable", sourceBlockId: null, reasons: [] }
      },
      markdown: { content: "# Release", truncated: false, unknownBlockIds: [] },
      completeness: { state: "complete" }
    };
    let allowed = true;
    const sourceAccess = createGrantedImportedSourceAnalysisAccess({
      ledger,
      authorize: () => Promise.resolve(allowed),
      evidenceSource: () => ({
        capture: () =>
          Promise.resolve({
            status: "captured",
            evidence: {
              source: identity,
              observedAt: at,
              providerVersion: at,
              snapshot
            }
          })
      })
    });
    const runtime = await createMeetingCaptureRuntime({
      database,
      workspace,
      ledger,
      workItemProviderId: "linear",
      notion: {
        sourceAccess,
        providerId: "notion",
        canonicalSourceScopeId: "notion-canonical",
        authorizationScopeId: "notion-reader"
      }
    });
    const f = reasoning();
    const mi = createMeetingIntelligence({
      database,
      reasoningModel: f.model,
      importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
        ledger
      }),
      importedSourceAnalysis: {
        access: sourceAccess,
        audience: () =>
          Promise.resolve({
            workspaceId: workspace.workspaceId,
            personIds: [...dayovaFounderPersonIds]
          })
      },
      captureSynthesis: runtime.configuration
    });
    const ingestion = runtime.connect(
      mi,
      createMeetingNotesIngestion({ meetingIntelligence: mi })
    );
    try {
      const source = await ledger.record({
        workspaceId: workspace.workspaceId,
        source: identity,
        observedAt: at,
        providerVersion: at,
        snapshot
      });
      expect(await ingestion.ingest({ workspace, source })).toMatchObject({
        analysisStatus: "completed",
        errors: []
      });
      const resolved = await runtime.logicalMeetings.resolveCapture({
        workspaceId: workspace.workspaceId,
        revision: observedNotionMeetingCapture({
          source,
          canonicalSourceScopeId: "notion-canonical"
        })
      });
      if (resolved.status !== "accepted") throw new Error("Expected accepted capture");
      const query = () =>
        mi.query({
          workspaceId: workspace.workspaceId,
          meetingId: resolved.decision.logicalMeeting.id,
          query: { type: "capture-synthesis" }
        });
      expect(await query()).toMatchObject({
        availability: "available",
        synthesis: { canonicalAnchorRef: { externalId: "page" } }
      });
      expect(
        f.requests.filter((item) => item.schemaName === "CaptureSynthesisProposal")
      ).toHaveLength(1);
      const count = f.requests.length;
      expect(await ingestion.ingest({ workspace, source })).toMatchObject({ errors: [] });
      expect(f.requests).toHaveLength(count);
      await expect(
        ingestion.ingest({ workspace: { ...workspace, workspaceId: "outside" }, source })
      ).rejects.toThrow("workspace");
      allowed = false;
      expect(await query()).toMatchObject({
        availability: "unavailable",
        synthesis: null
      });
      expect(f.requests).toHaveLength(count);
    } finally {
      await runtime.stop();
      await database.close();
    }
  });

  it.each([true, false])(
    "uses actual protected Granola opt-in and original audience (all founders: %s)",
    async (allFounders) => {
      const directory = await mkdtemp(join(tmpdir(), "luma-capture-runtime-"));
      const database = await createPgliteDatabase();
      const ledger = createObservedSourceLedger({ database });
      const text = (value: string) => ({
        content: [{ type: "text", text: value }],
        isError: false
      });
      const account = text("Account Jakob; active workspace Dayova");
      const document =
        '<meeting id="work" title="Weekly" date="Sep 11, 2026 9:00 AM"><known_participants>Jakob (note creator) &lt;jakob@dayova.test&gt;</known_participants><summary>Wir könnten nächste Woche starten.</summary></meeting>';
      const client: GranolaMcpClient = {
        tools: () =>
          Promise.resolve([
            { name: "get_account_info", inputSchema: { type: "object", properties: {} } },
            {
              name: "list_meetings",
              inputSchema: { type: "object", properties: { limit: { type: "integer" } } }
            },
            {
              name: "get_meetings",
              inputSchema: {
                type: "object",
                properties: { meeting_ids: { type: "array", items: { type: "string" } } },
                required: ["meeting_ids"]
              }
            }
          ]),
        call: (name) =>
          Promise.resolve(
            name === "get_account_info"
              ? account
              : text(
                  name === "list_meetings"
                    ? `<meetings_data count="1">${document}</meetings_data>`
                    : document
                )
          )
      };
      const connection: GranolaConnectionPolicy = {
        connectionId: "jakob",
        ownerPersonId: "person_jakob",
        optInId: "explicit-opt-in",
        accountFingerprint: granolaAccountFingerprint(account),
        enabled: true,
        audiencePersonIds: allFounders ? [...dayovaFounderPersonIds] : ["person_jakob"],
        automaticInternalMeetings: false,
        participantDirectory: [],
        includedMeetingIds: ["work"],
        excludedMeetingIds: []
      };
      const policyPath = join(directory, "policy.json");
      const savePolicy = () =>
        writeFile(
          policyPath,
          JSON.stringify({
            version: 1,
            workspaceId: workspace.workspaceId,
            connections: [connection]
          }),
          { mode: 0o600 }
        );
      await savePolicy();
      const runtime = await createMeetingCaptureRuntime({
        database,
        workspace,
        ledger,
        workItemProviderId: "linear",
        granola: {
          policy: createGranolaPolicy({
            path: policyPath,
            workspaceId: workspace.workspaceId
          }),
          connections: [{ connectionId: "jakob", client }]
        }
      });
      const f = reasoning();
      const mi = createMeetingIntelligence({
        database,
        reasoningModel: f.model,
        captureSynthesis: runtime.configuration
      });
      let meetingId = "";
      runtime.connect(
        {
          ...mi,
          observe: (request) => {
            const observation = request.observations.find(
              (item) => item.type === "meeting-capture-set-observed"
            );
            if (observation) meetingId = observation.meetingId;
            return mi.observe(request);
          }
        },
        createMeetingNotesIngestion({ meetingIntelligence: mi })
      );
      try {
        await runtime.syncGranolaOnce();
        const query = () =>
          mi.query({
            workspaceId: workspace.workspaceId,
            meetingId,
            query: { type: "capture-synthesis" }
          });
        if (allFounders) {
          expect(await query()).toMatchObject({
            availability: "available",
            synthesis: { coverage: "partial", canonicalAnchorRef: null }
          });
          expect(f.requests).toHaveLength(1);
          expect(
            f.requests[0]!.evidence.every((item) => item.source === "knowledge")
          ).toBe(true);
          expect(await runtime.syncGranolaOnce()).toMatchObject({
            unchanged: 1,
            failures: []
          });
          expect(f.requests).toHaveLength(1);
          connection.excludedMeetingIds.push("work");
          await savePolicy();
          expect(await query()).toMatchObject({
            availability: "unavailable",
            synthesis: null
          });
        } else {
          expect(await query()).toMatchObject({
            availability: "not-produced",
            synthesis: null
          });
          expect(f.requests).toHaveLength(0);
        }
        await runtime.stop();
        expect(runtime.status()).toMatchObject({ active: false, scheduled: false });
        await expect(runtime.syncGranolaOnce()).rejects.toThrow("connection-unavailable");
      } finally {
        await runtime.stop();
        await database.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
