import type { WorkspaceConfig } from "../domain/model.js";
import type { LumaDatabase } from "../persistence/db.js";
import type { ObservedSourceLedger } from "../knowledge/observed-source-ledger.js";
import type { ImportedSourceAnalysisAccess } from "../meeting-intelligence/imported-source-analysis.js";
import type { CaptureSynthesisConfiguration } from "../meeting-intelligence/meeting-capture-access.js";
import type { MeetingNotesIngestion } from "../knowledge/meeting-notes-ingestion.js";
import type {
  MeetingIntelligence,
  MeetingUpdate
} from "../meeting-intelligence/interface.js";
import type { GranolaPolicy } from "../granola/policy.js";
import type { GranolaMcpClient } from "../granola/mcp-client.js";
import { createGranolaCaptureIngestionRuntime } from "../granola/capture-ingestion-runtime.js";
import { createGranolaMeetingCaptureAccess } from "../granola/meeting-capture-access.js";
import { createNotionMeetingCaptureAccess } from "../knowledge/notion-meeting-capture-access.js";
import { createLedgerBackedNotionCaptureRevisionVerifier } from "../knowledge/ledger-backed-notion-capture-revision-verifier.js";
import { createLogicalMeetings } from "../logical-meetings/logical-meetings.js";
import { createMeetingCaptureIngestion } from "../knowledge/meeting-capture-ingestion.js";
import { observedNotionMeetingCapture } from "../knowledge/notion-meeting-capture.js";
import { observedMeetingNoteToObservation } from "../knowledge/meeting-notes-ingestion.js";
import { dayovaFounderPersonIds } from "./founder-access.js";

/** Construction and lifecycle only; capture interpretation stays inside MI.observe. */
export async function createMeetingCaptureRuntime(input: {
  database: LumaDatabase;
  workspace: WorkspaceConfig;
  ledger: ObservedSourceLedger;
  workItemProviderId: string;
  notion?: {
    sourceAccess: ImportedSourceAnalysisAccess;
    providerId: string;
    canonicalSourceScopeId: string;
    authorizationScopeId: string;
  };
  granola?: {
    policy: GranolaPolicy;
    connections: readonly { connectionId: string; client: GranolaMcpClient }[];
    intervalMs?: number;
    perConnectionLimit?: number;
  };
}) {
  if (!input.notion && !input.granola)
    throw new Error("Capture synthesis needs a configured governed source");
  const { workspace, database } = input;
  let ingestion: ReturnType<typeof createMeetingCaptureIngestion> | undefined;
  const deliver = (
    meeting: Parameters<ReturnType<typeof createMeetingCaptureIngestion>["ingest"]>[0]
  ) => {
    if (!ingestion)
      throw new Error("Capture intake started before Meeting Intelligence was connected");
    return ingestion.ingest(meeting);
  };
  const granola = input.granola
    ? await createGranolaCaptureIngestionRuntime({
        ...input.granola,
        database,
        workspaceId: workspace.workspaceId,
        onResolved: deliver
      })
    : undefined;
  const granolaAccess =
    granola && input.granola
      ? createGranolaMeetingCaptureAccess({
          sources: input.granola.connections.map((connection, index) => ({
            connectionId: connection.connectionId,
            source: granola.sources[index]!
          }))
        })
      : undefined;
  const notionAccess = input.notion
    ? createNotionMeetingCaptureAccess({
        ...input.notion,
        database,
        ledger: input.ledger
      })
    : undefined;
  const notionVerifier = input.notion
    ? createLedgerBackedNotionCaptureRevisionVerifier({
        ...input.notion,
        ledger: input.ledger
      })
    : undefined;
  const logicalMeetings = createLogicalMeetings({
    database,
    captureRevisionVerifier: {
      verify(request) {
        if (
          input.notion &&
          request.revision.address.providerId === input.notion.providerId &&
          notionVerifier
        )
          return notionVerifier.verify(request);
        const index =
          input.granola?.connections.findIndex(
            (connection) =>
              connection.connectionId === request.revision.address.providerConnectionId
          ) ?? -1;
        if (request.revision.address.providerId === "granola" && granola && index >= 0)
          return granola.sources[index]!.verifier.verify(request);
        return Promise.resolve({
          status: "rejected",
          message: "Capture source is outside this runtime."
        });
      }
    }
  });
  const configuration: CaptureSynthesisConfiguration = {
    logicalMeetings,
    audience: (workspaceId) =>
      Promise.resolve(
        workspaceId === workspace.workspaceId
          ? { workspaceId, personIds: [...dayovaFounderPersonIds] }
          : null
      ),
    access: {
      readCurrent(request) {
        const provider = request.capture.address.providerId;
        if (provider === input.notion?.providerId && notionAccess)
          return notionAccess.readCurrent(request);
        if (provider === "granola" && granolaAccess)
          return granolaAccess.readCurrent(request);
        throw new Error("Capture source is outside this runtime.");
      }
    }
  };
  let connected = false;
  return {
    configuration,
    logicalMeetings,
    /** Late construction binding; completed before any Gateway/source intake starts. */
    connect(
      meetingIntelligence: MeetingIntelligence,
      base: MeetingNotesIngestion
    ): MeetingNotesIngestion {
      if (connected) throw new Error("Capture runtime is already connected");
      connected = true;
      ingestion = createMeetingCaptureIngestion({ workspace, meetingIntelligence });
      return {
        async ingest(request): Promise<MeetingUpdate> {
          if (request.workspace.workspaceId !== workspace.workspaceId)
            throw new Error("Capture intake is outside this runtime's workspace");
          const update = await base.ingest(request);
          if (!input.notion) return update;
          const observation = observedMeetingNoteToObservation(
            request,
            input.workItemProviderId
          );
          if (
            request.source.source.providerId !== input.notion.providerId ||
            ![
              ...update.acceptedObservationIds,
              ...update.duplicateObservationIds
            ].includes(observation.observationId)
          )
            return update;
          // Only already-admitted original material can become a shared Logical
          // Meeting. This does not treat provider enumeration as a recipient grant.
          await input.notion.sourceAccess.requireCurrent({
            source: observation.source,
            audience: {
              workspaceId: workspace.workspaceId,
              personIds: [...dayovaFounderPersonIds]
            }
          });
          const resolved = await logicalMeetings.resolveCapture({
            workspaceId: workspace.workspaceId,
            revision: observedNotionMeetingCapture({
              source: request.source,
              canonicalSourceScopeId: input.notion.canonicalSourceScopeId
            })
          });
          if (resolved.status !== "accepted")
            throw new Error("Notion capture could not be resolved for synthesis.");
          const synthesis = await deliver(resolved.decision.logicalMeeting);
          return {
            ...update,
            errors: [...update.errors, ...synthesis.errors],
            analysisStatus:
              update.analysisStatus === "deferred" ||
              synthesis.analysisStatus === "deferred"
                ? "deferred"
                : update.analysisStatus
          };
        }
      };
    },
    start() {
      if (!connected) throw new Error("Capture runtime is not connected");
      granola?.start();
    },
    stop: async () => {
      await granola?.stop();
    },
    syncGranolaOnce: () => {
      if (!connected || !granola)
        throw new Error("Granola capture is not configured and connected");
      return granola.syncOnce();
    },
    status: () => granola?.status() ?? null
  };
}
