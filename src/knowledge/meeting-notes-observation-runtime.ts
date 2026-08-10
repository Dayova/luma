import type { WorkspaceConfig } from "../domain/model.js";
import type { MeetingNotesIngestion } from "./meeting-notes-ingestion.js";
import type {
  MeetingNotesPageRefresh,
  MeetingNotesPageRefresher
} from "./meeting-notes-source.js";
import type { MeetingNotesSyncResult } from "./meeting-notes-sync.js";
import type { ObservedSourceRevision } from "./observed-source-ledger.js";
import type {
  NotionWebhookWakeUp,
  NotionWebhookWakeUpQueue
} from "./notion-webhook-wake-up.js";

export type MeetingNotesCanonicalReconciliation = {
  /** Existing LUM-2 scan/ledger drain; it remains the completeness guarantee. */
  syncOnce(): Promise<MeetingNotesSyncResult>;
  /** Starts the existing recurring canonical source recovery schedule. */
  start(): void;
  stop(): Promise<void>;
};

export type MeetingNotesPageWakeUpResult =
  | {
      pageId: string;
      status: "completed";
      refreshStatus: MeetingNotesPageRefresh["status"];
      observedRecords: number;
      ingestedRecords: number;
      deliveryFailures: Array<{ sourceObjectId: string; message: string }>;
      completeness: MeetingNotesPageRefresh["completeness"];
      partialReasons: MeetingNotesPageRefresh["partialReasons"];
    }
  | {
      pageId: string;
      status: "failed";
      message: string;
    };

export type MeetingNotesObservationRuntimeDrain = {
  pageRefreshes: MeetingNotesPageWakeUpResult[];
  canonicalReconciliation: MeetingNotesSyncResult | null;
};

export type MeetingNotesObservationRuntimeStatus = {
  pendingPageCount: number;
  canonicalReconciliationPending: boolean;
  /** Number of bounded page queues promoted into canonical scans under load. */
  pageWakeUpOverflowCount: number;
  lastPageWakeUpOverflowAt: string | null;
  /** Arrival metadata only; it is never used as source Evidence. */
  lastWebhookReceivedAt: string | null;
  /** Most recent work started from a wake-up signal. */
  lastWakeUpAt: string | null;
  lastSuccessfulCanonicalReconciliationAt: string | null;
  /** Positive clock lag for the last signal, useful but non-canonical telemetry. */
  wakeUpLagMs: number | null;
  lastFailure: {
    scope: "page-refresh" | "canonical-reconciliation";
    pageId?: string;
    message: string;
    at: string;
  } | null;
};

export type CreateMeetingNotesObservationRuntimeInput = {
  workspace: WorkspaceConfig;
  /** Refetches and captures one verified canonical Meeting Note through its ledger. */
  refresher: MeetingNotesPageRefresher;
  /** The only downstream action is the existing source Observation projection. */
  ingestion: MeetingNotesIngestion;
  /** Existing full scan + scheduler; webhooks never replace it. */
  canonicalReconciliation: MeetingNotesCanonicalReconciliation;
  now?: () => Date;
  maxRememberedDeliveries?: number;
  /** Bounds unique direct page reads before promoting the batch to one scan. */
  maxPendingPages?: number;
};

export interface MeetingNotesObservationRuntime extends NotionWebhookWakeUpQueue {
  /** Runs queued wake-ups once; HTTP receipt never runs provider work inline. */
  drain(): Promise<MeetingNotesObservationRuntimeDrain>;
  /** Deliberately explicit host wiring for the existing recurring scan recovery. */
  startCanonicalRecovery(): void;
  stopCanonicalRecovery(): Promise<void>;
  status(): MeetingNotesObservationRuntimeStatus;
}

const DEFAULT_MAX_REMEMBERED_DELIVERIES = 1_000;
const DEFAULT_MAX_PENDING_PAGES = 100;

/**
 * Deep observation-only runtime around the existing source ledger. It neither
 * knows Follow-up Intents nor receives an execution capability, so a signed
 * webhook can only cause a refetch and `MeetingNotesIngestion.ingest(...)`.
 */
export function createMeetingNotesObservationRuntime(
  input: CreateMeetingNotesObservationRuntimeInput
): MeetingNotesObservationRuntime {
  const now = input.now ?? (() => new Date());
  const maxRememberedDeliveries = positiveSafeInteger(
    input.maxRememberedDeliveries ?? DEFAULT_MAX_REMEMBERED_DELIVERIES,
    "maxRememberedDeliveries"
  );
  const maxPendingPages = positiveSafeInteger(
    input.maxPendingPages ?? DEFAULT_MAX_PENDING_PAGES,
    "maxPendingPages"
  );
  const pendingPages = new Map<string, Extract<NotionWebhookWakeUp, { kind: "page" }>>();
  const rememberedDeliveries = new Map<string, true>();
  let pendingCanonicalReconciliation: Extract<
    NotionWebhookWakeUp,
    { kind: "canonical-reconciliation" }
  > | null = null;
  let activeDrain: Promise<MeetingNotesObservationRuntimeDrain> | null = null;
  let lastWebhookReceivedAt: string | null = null;
  let lastWakeUpAt: string | null = null;
  let lastWakeUpOccurredAt: string | null = null;
  let lastSuccessfulCanonicalReconciliationAt: string | null = null;
  let pageWakeUpOverflowCount = 0;
  let lastPageWakeUpOverflowAt: string | null = null;
  let lastFailure: MeetingNotesObservationRuntimeStatus["lastFailure"] = null;

  const queueWakeUp = (
    wakeUp: NotionWebhookWakeUp,
    replayingFailedWakeUp: boolean
  ): { status: "queued" | "coalesced" } => {
    lastWebhookReceivedAt = wakeUp.receivedAt;

    if (!replayingFailedWakeUp && rememberedDeliveries.has(wakeUp.deliveryId)) {
      return { status: "coalesced" };
    }

    if (!replayingFailedWakeUp) {
      rememberDelivery(rememberedDeliveries, wakeUp.deliveryId, maxRememberedDeliveries);
    }

    if (wakeUp.kind === "canonical-reconciliation") {
      const wasPending = pendingCanonicalReconciliation !== null;
      if (
        !pendingCanonicalReconciliation ||
        isLaterWakeUp(wakeUp, pendingCanonicalReconciliation)
      ) {
        pendingCanonicalReconciliation = wakeUp;
      }

      // A full canonical scan supersedes all queued direct page refreshes. It
      // reads current authority for every page and avoids doing the same work
      // twice; a page signal arriving after it is likewise coalesced below.
      pendingPages.clear();
      return { status: wasPending ? "coalesced" : "queued" };
    }

    if (pendingCanonicalReconciliation) {
      return { status: "coalesced" };
    }

    const existing = pendingPages.get(wakeUp.pageId);
    if (!existing) {
      if (pendingPages.size >= maxPendingPages) {
        // Under a burst, a full current-authority scan is both safer and
        // cheaper than retaining unbounded attacker/provider page references.
        // It covers the already queued pages and this new signal together.
        pendingCanonicalReconciliation = {
          kind: "canonical-reconciliation",
          deliveryId: wakeUp.deliveryId,
          occurredAt: wakeUp.occurredAt,
          receivedAt: wakeUp.receivedAt
        };
        pendingPages.clear();
        pageWakeUpOverflowCount += 1;
        lastPageWakeUpOverflowAt = wakeUp.receivedAt;
        return { status: "coalesced" };
      }

      pendingPages.set(wakeUp.pageId, wakeUp);
      return { status: "queued" };
    }

    if (isLaterWakeUp(wakeUp, existing)) {
      pendingPages.set(wakeUp.pageId, wakeUp);
    }

    return { status: "coalesced" };
  };

  const enqueue = (wakeUp: NotionWebhookWakeUp): { status: "queued" | "coalesced" } =>
    queueWakeUp(wakeUp, false);

  const requeueFailedWakeUp = (
    wakeUp: NotionWebhookWakeUp
  ): { status: "queued" | "coalesced" } => queueWakeUp(wakeUp, true);

  const drain = (): Promise<MeetingNotesObservationRuntimeDrain> => {
    if (activeDrain) {
      return activeDrain;
    }

    const pageWakeUps = [...pendingPages.values()].sort((left, right) =>
      left.pageId.localeCompare(right.pageId)
    );
    const canonicalWakeUp = pendingCanonicalReconciliation;
    pendingPages.clear();
    pendingCanonicalReconciliation = null;

    const run = drainWakeUps({
      pageWakeUps,
      canonicalWakeUp,
      input,
      now,
      requeue: requeueFailedWakeUp,
      recordWakeUp: (wakeUp) => {
        lastWakeUpAt = now().toISOString();
        lastWakeUpOccurredAt = wakeUp.occurredAt;
      },
      recordCanonicalResult: (result) => {
        if (isCompleteCanonicalReconciliation(result)) {
          lastSuccessfulCanonicalReconciliationAt = now().toISOString();
          lastFailure = null;
          return;
        }

        lastFailure = {
          scope: "canonical-reconciliation",
          message: incompleteCanonicalReconciliationMessage(result),
          at: now().toISOString()
        };
      },
      recordFailure: (failure) => {
        lastFailure = { ...failure, at: now().toISOString() };
      }
    });
    activeDrain = run.finally(() => {
      activeDrain = null;
    });
    return activeDrain;
  };

  return {
    enqueue,
    drain,
    startCanonicalRecovery() {
      input.canonicalReconciliation.start();
    },
    stopCanonicalRecovery() {
      return input.canonicalReconciliation.stop();
    },
    status() {
      const occurredAtMs = lastWakeUpOccurredAt
        ? Date.parse(lastWakeUpOccurredAt)
        : Number.NaN;
      const wakeUpLagMs = Number.isNaN(occurredAtMs)
        ? null
        : Math.max(0, now().getTime() - occurredAtMs);

      return {
        pendingPageCount: pendingPages.size,
        canonicalReconciliationPending: pendingCanonicalReconciliation !== null,
        pageWakeUpOverflowCount,
        lastPageWakeUpOverflowAt,
        lastWebhookReceivedAt,
        lastWakeUpAt,
        lastSuccessfulCanonicalReconciliationAt,
        wakeUpLagMs,
        lastFailure: lastFailure ? { ...lastFailure } : null
      };
    }
  };
}

type DrainWakeUpsInput = {
  pageWakeUps: Array<Extract<NotionWebhookWakeUp, { kind: "page" }>>;
  canonicalWakeUp: Extract<
    NotionWebhookWakeUp,
    { kind: "canonical-reconciliation" }
  > | null;
  input: CreateMeetingNotesObservationRuntimeInput;
  now: () => Date;
  requeue(wakeUp: NotionWebhookWakeUp): { status: "queued" | "coalesced" };
  recordWakeUp(wakeUp: NotionWebhookWakeUp): void;
  recordCanonicalResult(result: MeetingNotesSyncResult): void;
  recordFailure(input: {
    scope: "page-refresh" | "canonical-reconciliation";
    pageId?: string;
    message: string;
  }): void;
};

async function drainWakeUps(
  input: DrainWakeUpsInput
): Promise<MeetingNotesObservationRuntimeDrain> {
  const pageRefreshes: MeetingNotesPageWakeUpResult[] = [];

  for (const wakeUp of input.pageWakeUps) {
    input.recordWakeUp(wakeUp);

    try {
      const refresh = await input.input.refresher.refreshPage({
        workspaceId: input.input.workspace.workspaceId,
        pageId: wakeUp.pageId
      });
      const delivery = await deliverObservedRecords(
        input.input.ingestion,
        input.input.workspace,
        refresh.records
      );
      pageRefreshes.push({
        pageId: wakeUp.pageId,
        status: "completed",
        refreshStatus: refresh.status,
        observedRecords: refresh.records.length,
        ingestedRecords: delivery.ingestedRecords,
        deliveryFailures: delivery.deliveryFailures,
        completeness: refresh.completeness,
        partialReasons: refresh.partialReasons
      });
    } catch (error) {
      const message = errorMessage(error);
      // A refresh failure remains eligible for a later signal or a caller-led
      // retry. The full canonical schedule is still the recovery backstop.
      input.requeue(wakeUp);
      input.recordFailure({
        scope: "page-refresh",
        pageId: wakeUp.pageId,
        message
      });
      pageRefreshes.push({ pageId: wakeUp.pageId, status: "failed", message });
    }
  }

  if (!input.canonicalWakeUp) {
    return { pageRefreshes, canonicalReconciliation: null };
  }

  input.recordWakeUp(input.canonicalWakeUp);

  try {
    const reconciliation = await input.input.canonicalReconciliation.syncOnce();
    input.recordCanonicalResult(reconciliation);
    return { pageRefreshes, canonicalReconciliation: reconciliation };
  } catch (error) {
    const message = errorMessage(error);
    input.requeue(input.canonicalWakeUp);
    input.recordFailure({ scope: "canonical-reconciliation", message });
    return { pageRefreshes, canonicalReconciliation: null };
  }
}

async function deliverObservedRecords(
  ingestion: MeetingNotesIngestion,
  workspace: WorkspaceConfig,
  records: ObservedSourceRevision[]
): Promise<{
  ingestedRecords: number;
  deliveryFailures: Array<{ sourceObjectId: string; message: string }>;
}> {
  let ingestedRecords = 0;
  const deliveryFailures: Array<{ sourceObjectId: string; message: string }> = [];

  for (const source of records) {
    try {
      const update = await ingestion.ingest({ workspace, source });
      if (update.errors.length > 0) {
        deliveryFailures.push({
          sourceObjectId: source.source.sourceObjectId,
          message: update.errors
            .map((error) => ("message" in error ? error.message : error.code))
            .join("; ")
        });
        continue;
      }

      ingestedRecords += 1;
    } catch (error) {
      deliveryFailures.push({
        sourceObjectId: source.source.sourceObjectId,
        message: errorMessage(error)
      });
    }
  }

  return { ingestedRecords, deliveryFailures };
}

function rememberDelivery(
  deliveries: Map<string, true>,
  deliveryId: string,
  maximum: number
): void {
  deliveries.set(deliveryId, true);

  while (deliveries.size > maximum) {
    const oldest = deliveries.keys().next().value;
    if (!oldest) {
      return;
    }
    deliveries.delete(oldest);
  }
}

function isLaterWakeUp(
  candidate: NotionWebhookWakeUp,
  current: NotionWebhookWakeUp
): boolean {
  const candidateAt = Date.parse(candidate.occurredAt);
  const currentAt = Date.parse(current.occurredAt);

  if (candidateAt !== currentAt) {
    return candidateAt > currentAt;
  }

  return candidate.deliveryId.localeCompare(current.deliveryId) > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }

  return value;
}

function isCompleteCanonicalReconciliation(result: MeetingNotesSyncResult): boolean {
  return result.completeness === "complete" && result.deliveryFailures.length === 0;
}

function incompleteCanonicalReconciliationMessage(
  result: MeetingNotesSyncResult
): string {
  const details = [
    ...(result.completeness === "partial" ? ["partial source coverage"] : []),
    ...(result.deliveryFailures.length > 0
      ? [`${result.deliveryFailures.length} delivery failure(s)`]
      : [])
  ];

  return `Canonical Meeting Notes reconciliation completed with ${details.join(" and ") || "incomplete coverage"}`;
}

export type { MeetingNotesPageRefresher } from "./meeting-notes-source.js";
