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

type GranolaConnection = { connectionId: string; client: GranolaMcpClient };
type GranolaRuntime = Awaited<ReturnType<typeof createGranolaCaptureIngestionRuntime>>;
type GranolaRegistry = {
  runtime: GranolaRuntime;
  connections: readonly GranolaConnection[];
  access: ReturnType<typeof createGranolaMeetingCaptureAccess>;
};

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
    connections: readonly GranolaConnection[];
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
  const buildGranola = async (
    connections: readonly GranolaConnection[]
  ): Promise<GranolaRegistry | undefined> => {
    if (!input.granola) throw new Error("Granola capture is not configured");
    if (!connections.length) return undefined;
    const runtime = await createGranolaCaptureIngestionRuntime({
      ...input.granola,
      connections,
      database,
      workspaceId: workspace.workspaceId,
      onResolved: deliver
    });
    return {
      runtime,
      connections,
      access: createGranolaMeetingCaptureAccess({
        sources: connections.map((connection, index) => ({
          connectionId: connection.connectionId,
          source: runtime.sources[index]!
        }))
      })
    };
  };
  let registry = input.granola
    ? await buildGranola([...input.granola.connections])
    : undefined;
  let activeRegistry = registry;
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
          activeRegistry?.connections.findIndex(
            (connection) =>
              connection.connectionId === request.revision.address.providerConnectionId
          ) ?? -1;
        if (
          request.revision.address.providerId === "granola" &&
          activeRegistry &&
          index >= 0
        )
          return activeRegistry.runtime.sources[index]!.verifier.verify(request);
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
        if (provider === "granola" && activeRegistry)
          return activeRegistry.access.readCurrent(request);
        throw new Error("Capture source is outside this runtime.");
      }
    }
  };
  let connected = false;
  let started = false;
  let stopped = false;
  let changing: Promise<void> = Promise.resolve();
  const notionRuns = new Set<Promise<MeetingUpdate>>();
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
        ingest(request): Promise<MeetingUpdate> {
          if (stopped) return Promise.reject(new Error("Capture runtime is stopped"));
          const run = async (): Promise<MeetingUpdate> => {
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
          };
          const pending = run().finally(() => notionRuns.delete(pending));
          notionRuns.add(pending);
          return pending;
        }
      };
    },
    start() {
      if (!connected) throw new Error("Capture runtime is not connected");
      if (stopped) throw new Error("Capture runtime is stopped");
      started = true;
      activeRegistry?.runtime.start();
    },
    stop: async () => {
      stopped = true;
      activeRegistry = undefined;
      const drains = await Promise.allSettled([
        registry?.runtime.stop(),
        changing.catch(() => undefined),
        ...notionRuns
      ]);
      const failure = drains.find((drain) => drain.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
    syncGranolaOnce: () => {
      if (!connected || !activeRegistry || stopped)
        throw new Error("Granola capture is not configured and connected");
      return activeRegistry.runtime.syncOnce();
    },
    /** Owner-attested connection changes are serialized and drain old intake first. */
    replaceGranolaConnections(connections: readonly GranolaConnection[]) {
      if (!connected || !input.granola || stopped)
        return Promise.reject(new Error("Granola capture cannot change connections"));
      const replacement = connections.map((connection) => ({ ...connection }));
      changing = changing
        .catch(() => undefined)
        .then(async () => {
          if (stopped) throw new Error("Capture runtime is stopped");
          activeRegistry = undefined;
          await registry?.runtime.stop();
          registry = undefined;
          if (stopped) throw new Error("Capture runtime is stopped");
          const next = await buildGranola(replacement);
          if (stopped) {
            await next?.runtime.stop();
            throw new Error("Capture runtime is stopped");
          }
          registry = next;
          activeRegistry = next;
          if (started) next?.runtime.start();
        });
      return changing;
    },
    status: () => registry?.runtime.status() ?? null
  };
}
