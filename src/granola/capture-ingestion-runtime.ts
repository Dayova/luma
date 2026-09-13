import type { LumaDatabase } from "../persistence/db.js";
import { createLogicalMeetings } from "../logical-meetings/logical-meetings.js";
import type {
  LogicalMeetings,
  LogicalMeeting,
  MeetingCaptureAddress
} from "../logical-meetings/interface.js";
import type { MeetingUpdate } from "../meeting-intelligence/interface.js";
import type { GranolaMcpClient } from "./mcp-client.js";
import { GranolaSourceError } from "./mcp-client.js";
import type { GranolaPolicy } from "./policy.js";
import { createGranolaMeetingCaptureSource } from "./meeting-capture-source.js";

export type GranolaSyncResult = {
  status: "partial" | "unavailable";
  scanned: number;
  accepted: number;
  unchanged: number;
  withheld: number;
  failures: Array<{ connectionId: string; code: string }>;
  coverageReasons: readonly string[];
};

export type GranolaConnectionIntakeStatus = {
  active: boolean;
  scheduled: boolean;
  checked: boolean;
  failureCodes: readonly string[];
};

/** Composition seam: one shared owned store, one OAuth client per opted-in user. */
export async function createGranolaCaptureIngestionRuntime(input: {
  database: LumaDatabase;
  workspaceId: string;
  policy: GranolaPolicy;
  connections: readonly { connectionId: string; client: GranolaMcpClient }[];
  now?: () => Date;
  intervalMs?: number;
  perConnectionLimit?: number;
  report?: (result: GranolaSyncResult) => void | Promise<void>;
  /** Source delivery into the shared MI instance. Included in the owned run/drain. */
  onResolved?: (meeting: LogicalMeeting) => Promise<MeetingUpdate>;
}): Promise<{
  start(): void;
  stop(): Promise<void>;
  syncOnce(): Promise<GranolaSyncResult>;
  status(): {
    active: boolean;
    scheduled: boolean;
    lastResult: GranolaSyncResult | null;
    lastFailure: string | null;
  };
  connectionStatus(connectionId: string): GranolaConnectionIntakeStatus | null;
  logicalMeetings: LogicalMeetings;
  sources: Awaited<ReturnType<typeof createGranolaMeetingCaptureSource>>[];
}> {
  const intervalMs = input.intervalMs ?? 300_000;
  const limit = input.perConnectionLimit ?? 10;
  if (
    !input.connections.length ||
    input.connections.length > 4 ||
    new Set(input.connections.map((item) => item.connectionId)).size !==
      input.connections.length ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 20 ||
    !Number.isInteger(intervalMs) ||
    intervalMs < 60_000 ||
    intervalMs > 3_600_000
  )
    throw new GranolaSourceError("policy-withheld");
  const sources = await Promise.all(
    input.connections.map((connection) =>
      createGranolaMeetingCaptureSource({ ...input, ...connection })
    )
  );
  const logicalMeetings = createLogicalMeetings({
    database: input.database,
    captureRevisionVerifier: {
      verify: (request) => {
        const index = input.connections.findIndex(
          (connection) =>
            connection.connectionId === request.revision.address.providerConnectionId
        );
        return index >= 0
          ? sources[index]!.verifier.verify(request)
          : Promise.resolve({
              status: "rejected",
              message: "Granola connection is not configured."
            });
      }
    },
    ...(input.now ? { now: input.now } : {})
  });
  let running: Promise<GranolaSyncResult> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let lastResult: GranolaSyncResult | null = null;
  let lastFailure: string | null = null;
  const offsets = new Map<string, number>();
  const connectionStates = new Map(
    input.connections.map(({ connectionId }) => [
      connectionId,
      { active: false, checked: false, failureCodes: [] as string[] }
    ])
  );
  const run = async (): Promise<GranolaSyncResult> => {
    const result: GranolaSyncResult = {
      status: "partial",
      scanned: 0,
      accepted: 0,
      unchanged: 0,
      withheld: 0,
      failures: [],
      coverageReasons: ["rolling-history-window", "bounded-provider-discovery"]
    };
    for (const [index, source] of sources.entries()) {
      if (stopped) break;
      const connectionId = input.connections[index]!.connectionId;
      const state = connectionStates.get(connectionId)!;
      state.active = true;
      const failures: string[] = [];
      const failed = (code: string) => {
        failures.push(code);
        result.failures.push({ connectionId, code });
      };
      try {
        // Revisit known addresses too, so policy exclusions are delivered even
        // when the provider's rolling recent window no longer lists a capture.
        const known = await source.knownCaptures();
        let found: readonly MeetingCaptureAddress[] = [];
        try {
          found = (
            await source.discover({
              workspaceId: input.workspaceId,
              providerConnectionId: connectionId,
              limit
            })
          ).captures;
        } catch (error) {
          failed(code(error));
        }
        const all = [
          ...new Map(
            [...known, ...found].map((capture) => [capture.externalCaptureId, capture])
          ).values()
        ];
        const offset = (offsets.get(connectionId) ?? 0) % Math.max(all.length, 1);
        const ordered = [...all.slice(offset), ...all.slice(0, offset)].slice(0, limit);
        offsets.set(connectionId, (offset + ordered.length) % Math.max(all.length, 1));
        for (const capture of ordered) {
          if (stopped) break;
          result.scanned += 1;
          try {
            const revision = await source.fetchCapture({
              workspaceId: input.workspaceId,
              capture
            });
            const outcome = await logicalMeetings.resolveCapture({
              workspaceId: input.workspaceId,
              revision
            });
            if (outcome.status === "accepted") {
              result.accepted += 1;
              if (outcome.decision.effect === "unchanged") result.unchanged += 1;
              const update = await input.onResolved?.(outcome.decision.logicalMeeting);
              for (const error of update?.errors ?? []) failed(error.code);
            } else if (outcome.status === "excluded") result.withheld += 1;
            else failed(outcome.code);
          } catch (error) {
            failed(code(error));
          }
        }
      } catch (error) {
        failed(code(error));
      } finally {
        state.active = false;
        // Stop may interrupt the connection between provider calls or captures.
        // Retain its previous completed scan; another owner's scan grants no status.
        if (!stopped) {
          state.checked = true;
          state.failureCodes = [...new Set(failures)];
        }
      }
    }
    if (result.failures.length && !result.accepted && !result.withheld)
      result.status = "unavailable";
    lastResult = structuredClone(result);
    lastFailure = null;
    await input.report?.(structuredClone(result));
    return result;
  };
  const syncOnce = () => {
    if (stopped) return Promise.reject(new GranolaSourceError("connection-unavailable"));
    return (running ??= run()
      .catch((error) => {
        lastFailure = code(error);
        throw new GranolaSourceError("source-unavailable");
      })
      .finally(() => {
        running = undefined;
      }));
  };
  return {
    sources,
    logicalMeetings,
    syncOnce,
    connectionStatus(connectionId) {
      const state = connectionStates.get(connectionId);
      return state ? { ...structuredClone(state), scheduled: Boolean(timer) } : null;
    },
    status: () => ({
      active: Boolean(running),
      scheduled: Boolean(timer),
      lastResult: structuredClone(lastResult),
      lastFailure
    }),
    start() {
      if (timer || stopped) return;
      const tick = () => {
        void syncOnce().catch(() => undefined);
      };
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      timer = undefined;
      await running?.catch(() => undefined);
    }
  };
}
function code(error: unknown): string {
  return error instanceof GranolaSourceError ? error.code : "source-unavailable";
}
