import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalNotionObjectId } from "./notion-object-id.js";

/**
 * A signed Notion delivery becomes only a wake-up. It intentionally contains
 * no payload content, source revision, or authorization to execute work.
 */
export type NotionWebhookWakeUp =
  | {
      kind: "page";
      deliveryId: string;
      pageId: string;
      occurredAt: string;
      receivedAt: string;
    }
  | {
      kind: "canonical-reconciliation";
      deliveryId: string;
      occurredAt: string;
      receivedAt: string;
    };

export interface NotionWebhookWakeUpQueue {
  enqueue(wakeUp: NotionWebhookWakeUp): { status: "queued" | "coalesced" };
}

export type NotionWebhookDelivery = {
  /** The exact bytes received by the HTTP Adapter, before JSON parsing. */
  rawBody: Uint8Array;
  headers: Readonly<Record<string, string | undefined>>;
};

export type NotionWebhookIngressResult =
  | {
      status: "queued" | "coalesced";
      wakeUp: NotionWebhookWakeUp;
    }
  | {
      status: "ignored";
      reason:
        | "malformed-event"
        | "workspace-mismatch"
        | "subscription-mismatch"
        | "integration-mismatch"
        | "unsupported-event"
        | "outside-canonical-meetings";
    }
  | {
      status: "rejected";
      reason: "signature-missing" | "signature-invalid";
    };

export type CreateNotionWebhookWakeUpIngressInput = {
  workspaceId: string;
  canonicalMeetingsDataSourceId: string;
  /** Notion's verified subscription token; inject it, never read it here. */
  verificationToken: string;
  queue: NotionWebhookWakeUpQueue;
  /** Optional defense-in-depth restrictions for the activated subscription. */
  subscriptionId?: string;
  integrationId?: string;
  now?: () => Date;
};

export interface NotionWebhookWakeUpIngress {
  /**
   * Validates the HMAC over raw bytes, then classifies the delivery into an
   * intentionally content-free wake-up. HTTP routing and subscription setup
   * remain outside this module.
   */
  receive(delivery: NotionWebhookDelivery): NotionWebhookIngressResult;
}

type NotionWebhookEvent = {
  id: string;
  timestamp: string;
  workspaceId: string;
  subscriptionId: string;
  integrationId: string;
  type: string;
  entity: {
    id: string;
    type: string;
  };
};

const PAGE_WAKE_UP_EVENT_TYPES = new Set([
  "page.created",
  "page.content_updated",
  "page.properties_updated"
]);

/**
 * Notion documents X-Notion-Signature as `sha256=<hex>` where the digest is
 * HMAC-SHA256 of the raw request body using the subscription verification
 * token. Keep this Adapter independent from HTTP frameworks so they cannot
 * accidentally reserialize the body before verification.
 */
export function createNotionWebhookWakeUpIngress(
  input: CreateNotionWebhookWakeUpIngressInput
): NotionWebhookWakeUpIngress {
  const workspaceId = requiredOpaqueIdentifier(input.workspaceId, "workspaceId");
  const canonicalMeetingsDataSourceId = requiredOpaqueIdentifier(
    input.canonicalMeetingsDataSourceId,
    "canonicalMeetingsDataSourceId"
  );
  const verificationToken = requiredSecret(input.verificationToken, "verificationToken");
  const subscriptionId = optionalOpaqueIdentifier(input.subscriptionId, "subscriptionId");
  const integrationId = optionalOpaqueIdentifier(input.integrationId, "integrationId");
  const now = input.now ?? (() => new Date());

  return {
    receive(delivery) {
      const signature = headerValue(delivery.headers, "x-notion-signature");

      if (!signature) {
        return { status: "rejected", reason: "signature-missing" };
      }

      if (!hasValidSignature(delivery.rawBody, signature, verificationToken)) {
        return { status: "rejected", reason: "signature-invalid" };
      }

      const event = parseWebhookEvent(delivery.rawBody);

      if (!event) {
        return { status: "ignored", reason: "malformed-event" };
      }

      if (event.workspaceId !== workspaceId) {
        return { status: "ignored", reason: "workspace-mismatch" };
      }

      if (subscriptionId && event.subscriptionId !== subscriptionId) {
        return { status: "ignored", reason: "subscription-mismatch" };
      }

      if (integrationId && event.integrationId !== integrationId) {
        return { status: "ignored", reason: "integration-mismatch" };
      }

      const receivedAt = now().toISOString();
      const pageWakeUp = pageWakeUpFor(event, receivedAt);

      if (pageWakeUp) {
        const queued = input.queue.enqueue(pageWakeUp);
        return { ...queued, wakeUp: pageWakeUp };
      }

      if (PAGE_WAKE_UP_EVENT_TYPES.has(event.type) && event.entity.type === "page") {
        return { status: "ignored", reason: "malformed-event" };
      }

      if (event.type === "data_source.content_updated") {
        if (
          event.entity.type !== "data_source" ||
          event.entity.id !== canonicalMeetingsDataSourceId
        ) {
          return { status: "ignored", reason: "outside-canonical-meetings" };
        }

        const wakeUp: NotionWebhookWakeUp = {
          kind: "canonical-reconciliation",
          deliveryId: event.id,
          occurredAt: event.timestamp,
          receivedAt
        };
        const queued = input.queue.enqueue(wakeUp);
        return { ...queued, wakeUp };
      }

      return { status: "ignored", reason: "unsupported-event" };
    }
  };
}

function pageWakeUpFor(
  event: NotionWebhookEvent,
  receivedAt: string
): Extract<NotionWebhookWakeUp, { kind: "page" }> | null {
  if (!PAGE_WAKE_UP_EVENT_TYPES.has(event.type) || event.entity.type !== "page") {
    return null;
  }

  const pageId = canonicalNotionObjectId(event.entity.id);

  if (!pageId) {
    return null;
  }

  return {
    kind: "page",
    deliveryId: event.id,
    pageId,
    occurredAt: event.timestamp,
    receivedAt
  };
}

function hasValidSignature(
  rawBody: Uint8Array,
  receivedSignature: string,
  verificationToken: string
): boolean {
  if (!/^sha256=[a-f0-9]{64}$/u.test(receivedSignature)) {
    return false;
  }

  const expectedSignature = `sha256=${createHmac("sha256", verificationToken)
    .update(rawBody)
    .digest("hex")}`;
  const expected = Buffer.from(expectedSignature, "utf8");
  const received = Buffer.from(receivedSignature, "utf8");

  return expected.length === received.length && timingSafeEqual(expected, received);
}

function parseWebhookEvent(rawBody: Uint8Array): NotionWebhookEvent | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return null;
  }

  if (!isRecord(parsed) || !isRecord(parsed["entity"])) {
    return null;
  }

  const id = parsed["id"];
  const timestamp = parsed["timestamp"];
  const workspaceId = parsed["workspace_id"];
  const subscriptionId = parsed["subscription_id"];
  const integrationId = parsed["integration_id"];
  const type = parsed["type"];
  const entityId = parsed["entity"]["id"];
  const entityType = parsed["entity"]["type"];

  if (
    !isOpaqueIdentifier(id) ||
    !isTimestamp(timestamp) ||
    !isOpaqueIdentifier(workspaceId) ||
    !isOpaqueIdentifier(subscriptionId) ||
    !isOpaqueIdentifier(integrationId) ||
    !isOpaqueIdentifier(type) ||
    !isOpaqueIdentifier(entityId) ||
    !isOpaqueIdentifier(entityType)
  ) {
    return null;
  }

  return {
    id,
    timestamp,
    workspaceId,
    subscriptionId,
    integrationId,
    type,
    entity: { id: entityId, type: entityType }
  };
}

function headerValue(
  headers: Readonly<Record<string, string | undefined>>,
  expectedName: string
): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === expectedName && typeof value === "string") {
      return value;
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpaqueIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !/\s/u.test(value)
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function requiredOpaqueIdentifier(value: string, name: string): string {
  if (!isOpaqueIdentifier(value)) {
    throw new Error(`Notion webhook ${name} must be a non-blank opaque identifier`);
  }

  return value;
}

function optionalOpaqueIdentifier(
  value: string | undefined,
  name: string
): string | null {
  if (value === undefined) {
    return null;
  }

  return requiredOpaqueIdentifier(value, name);
}

function requiredSecret(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Notion webhook ${name} must be configured`);
  }

  return value;
}
