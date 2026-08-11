import type { WorkspaceConfig } from "../domain/model.js";
import {
  createMeetingNotesObservationRuntime,
  type MeetingNotesObservationRuntimeStatus
} from "../knowledge/meeting-notes-observation-runtime.js";
import type { MeetingNotesIngestion } from "../knowledge/meeting-notes-ingestion.js";
import type { MeetingNotesPageRefresher } from "../knowledge/meeting-notes-source.js";
import type {
  MeetingNotesSync,
  MeetingNotesSyncStatus
} from "../knowledge/meeting-notes-sync.js";
import { canonicalNotionObjectId } from "../knowledge/notion-object-id.js";
import {
  createNotionWebhookWakeUpIngress,
  type NotionWebhookDelivery
} from "../knowledge/notion-webhook-wake-up.js";

export type NotionObservationSubscription = {
  /** Provider UUID used only to validate Notion's `workspace_id` delivery field. */
  notionWorkspaceId: string;
  canonicalMeetingsDataSourceId: string;
  /** Injected from a deployment secret store; never loaded or logged here. */
  verificationToken: string;
  subscriptionId: string;
  integrationId: string;
};

export type CreateNotionMeetingNotesObservationHostInput = {
  /** Luma's logical workspace for evidence, ledger, and Meeting Intelligence. */
  lumaWorkspace: WorkspaceConfig;
  notionSubscription: NotionObservationSubscription;
  refresher: MeetingNotesPageRefresher;
  ingestion: MeetingNotesIngestion;
  /** The existing canonical scan schedule and recovery capability. */
  canonicalReconciliation: MeetingNotesSync;
};

export type NotionMeetingNotesObservationHostReceipt = {
  /** Sanitized admission result; page IDs, delivery IDs, and payload never leave the host. */
  status: "accepted" | "ignored" | "rejected" | "unavailable";
};

export type NotionMeetingNotesObservationHostStatus = {
  acceptingDeliveries: boolean;
  backgroundDrainActive: boolean;
  /** Sanitized operational counters/timestamps; never page IDs or provider errors. */
  runtime: SafeMeetingNotesObservationRuntimeStatus;
  canonicalRecovery: MeetingNotesSyncStatus;
};

export type SafeMeetingNotesObservationRuntimeStatus = Omit<
  MeetingNotesObservationRuntimeStatus,
  "lastFailure"
> & {
  lastFailure: { scope: "page-refresh" | "canonical-reconciliation"; at: string } | null;
};

/**
 * The app-layer observation Module for automatic Notion Meeting Notes intake.
 * It owns ingress/runtime composition and hides source parsing, source revisions,
 * ledger capture, and reconciliation behind a raw-delivery/lifecycle Interface.
 * It has no execution, writer, Discord, or provider-client capability.
 */
export interface NotionMeetingNotesObservationHost {
  /** Begins immediate plus recurring canonical recovery. */
  start(): void;
  /** Admits raw signed bytes and defers all provider work until after the receipt. */
  receive(delivery: NotionWebhookDelivery): NotionMeetingNotesObservationHostReceipt;
  /** Content-free operational status only. */
  status(): NotionMeetingNotesObservationHostStatus;
  /** Stops admissions, settles accepted work, then stops canonical recovery. */
  stop(): Promise<void>;
}

export function createNotionMeetingNotesObservationHost(
  input: CreateNotionMeetingNotesObservationHostInput
): NotionMeetingNotesObservationHost {
  const notionSubscription = normalizeSubscription(input.notionSubscription);
  requireDistinctLumaWorkspace(
    input.lumaWorkspace.workspaceId,
    notionSubscription.notionWorkspaceId
  );
  const runtime = createMeetingNotesObservationRuntime({
    workspace: input.lumaWorkspace,
    refresher: input.refresher,
    ingestion: input.ingestion,
    canonicalReconciliation: input.canonicalReconciliation
  });
  const ingress = createNotionWebhookWakeUpIngress({
    notionWorkspaceId: notionSubscription.notionWorkspaceId,
    canonicalMeetingsDataSourceId: notionSubscription.canonicalMeetingsDataSourceId,
    verificationToken: notionSubscription.verificationToken,
    subscriptionId: notionSubscription.subscriptionId,
    integrationId: notionSubscription.integrationId,
    queue: runtime
  });
  let acceptingDeliveries = false;
  let scheduledDrain: Promise<void> | null = null;

  const settleRuntimeDrain = async (): Promise<void> => {
    // The runtime may start one successor when a new external delivery lands
    // during an active drain. Await every such active successor, but do not
    // spin on caller-led retries that remain pending after a failed refresh.
    do {
      await runtime.drain();
      await Promise.resolve();
    } while (runtime.status().drainActive);
  };

  const requestDeferredDrain = (): void => {
    if (scheduledDrain) {
      return;
    }

    scheduledDrain = new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    })
      .then(settleRuntimeDrain)
      // The runtime records operational failure state and retains recovery in
      // its canonical schedule. The HTTP caller has already received a prompt
      // acknowledgement and must never observe provider/source details.
      .catch(() => undefined)
      .finally(() => {
        scheduledDrain = null;
      });
  };

  return {
    start() {
      if (acceptingDeliveries) {
        return;
      }

      // Begin the canonical completeness backstop before a listener can
      // acknowledge a latency-only signal. `MeetingNotesSync.start()` starts
      // its initial scan synchronously and owns the recurring schedule.
      runtime.startCanonicalRecovery();
      acceptingDeliveries = true;
    },
    receive(delivery) {
      if (!acceptingDeliveries) {
        return { status: "unavailable" };
      }

      const result = ingress.receive(delivery);

      if (result.status === "queued" || result.status === "coalesced") {
        requestDeferredDrain();
        return { status: "accepted" };
      }

      return { status: result.status };
    },
    status() {
      return {
        acceptingDeliveries,
        backgroundDrainActive: scheduledDrain !== null,
        runtime: safeRuntimeStatus(runtime.status()),
        canonicalRecovery: input.canonicalReconciliation.status()
      };
    },
    async stop() {
      acceptingDeliveries = false;

      // A host adapter closes its listener first. This drains only work which
      // was accepted before shutdown and then lets the existing sync own its
      // own in-flight scheduled scan shutdown before persistence is closed.
      await (scheduledDrain ?? settleRuntimeDrain());
      await runtime.stopCanonicalRecovery();
    }
  };
}

function safeRuntimeStatus(
  status: MeetingNotesObservationRuntimeStatus
): SafeMeetingNotesObservationRuntimeStatus {
  const { lastFailure, ...safeStatus } = status;

  return {
    ...safeStatus,
    lastFailure: lastFailure ? { scope: lastFailure.scope, at: lastFailure.at } : null
  };
}

function normalizeSubscription(
  input: NotionObservationSubscription
): NotionObservationSubscription {
  return {
    notionWorkspaceId: requireNotionUuid(input.notionWorkspaceId, "notionWorkspaceId"),
    canonicalMeetingsDataSourceId: requireNotionUuid(
      input.canonicalMeetingsDataSourceId,
      "canonicalMeetingsDataSourceId"
    ),
    verificationToken: input.verificationToken,
    subscriptionId: requireNotionUuid(input.subscriptionId, "subscriptionId"),
    integrationId: requireNotionUuid(input.integrationId, "integrationId")
  };
}

function requireNotionUuid(value: string, name: string): string {
  const canonical = canonicalNotionObjectId(value);

  if (!canonical) {
    throw new Error(`Notion observation ${name} must be a Notion UUID`);
  }

  return canonical;
}

function requireDistinctLumaWorkspace(
  lumaWorkspaceId: string,
  notionWorkspaceId: string
): void {
  if (
    lumaWorkspaceId === notionWorkspaceId ||
    canonicalNotionObjectId(lumaWorkspaceId) === notionWorkspaceId
  ) {
    throw new Error(
      "Notion observation logical Luma workspace must be distinct from the Notion provider workspace"
    );
  }
}
