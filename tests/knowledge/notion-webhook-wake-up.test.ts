import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createNotionWebhookWakeUpIngress,
  type NotionWebhookWakeUp,
  type NotionWebhookWakeUpQueue
} from "../../src/knowledge/notion-webhook-wake-up.js";

const verificationToken = "secret_luma_notion_webhook_verification_token";
const workspaceId = "workspace_dayova";
const canonicalMeetingsDataSourceId = "dayova-meetings";
const meetingPageId = "11111111-2222-3333-4444-555555555555";

class RecordingWakeUpQueue implements NotionWebhookWakeUpQueue {
  readonly wakeUps: NotionWebhookWakeUp[] = [];

  enqueue(wakeUp: NotionWebhookWakeUp) {
    this.wakeUps.push(wakeUp);
    return { status: "queued" as const };
  }
}

function webhookEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "event-page-content-updated-1",
    timestamp: "2026-08-10T11:30:00.000Z",
    workspace_id: workspaceId,
    subscription_id: "subscription-dayova-meetings",
    integration_id: "integration-luma",
    api_version: "2026-03-11",
    attempt_number: 1,
    type: "page.content_updated",
    entity: { id: meetingPageId, type: "page" },
    data: { deliberately_untrusted: "never becomes source evidence" },
    ...overrides
  };
}

function signedDelivery(body: Record<string, unknown>) {
  const rawBody = Buffer.from(JSON.stringify(body), "utf8");
  const signature = `sha256=${createHmac("sha256", verificationToken)
    .update(rawBody)
    .digest("hex")}`;

  return {
    rawBody,
    headers: { "x-notion-signature": signature }
  };
}

describe("Notion webhook wake-up ingress", () => {
  it("authenticates the raw delivery then emits only a bounded page wake-up", () => {
    const queue = new RecordingWakeUpQueue();
    const ingress = createNotionWebhookWakeUpIngress({
      workspaceId,
      canonicalMeetingsDataSourceId,
      verificationToken,
      queue,
      now: () => new Date("2026-08-10T11:31:00.000Z")
    });

    const result = ingress.receive(signedDelivery(webhookEvent()));

    expect(result).toMatchObject({
      status: "queued",
      wakeUp: {
        kind: "page",
        pageId: meetingPageId,
        deliveryId: "event-page-content-updated-1",
        occurredAt: "2026-08-10T11:30:00.000Z",
        receivedAt: "2026-08-10T11:31:00.000Z"
      }
    });
    expect(queue.wakeUps).toEqual([
      expect.objectContaining({
        kind: "page",
        pageId: meetingPageId
      })
    ]);
    expect(JSON.stringify(queue.wakeUps)).not.toContain("deliberately_untrusted");
  });

  it("normalizes a compact uppercase Notion page UUID before queueing it", () => {
    const queue = new RecordingWakeUpQueue();
    const ingress = createNotionWebhookWakeUpIngress({
      workspaceId,
      canonicalMeetingsDataSourceId,
      verificationToken,
      queue
    });

    expect(
      ingress.receive(
        signedDelivery(
          webhookEvent({
            entity: { id: meetingPageId.replaceAll("-", "").toUpperCase(), type: "page" }
          })
        )
      )
    ).toMatchObject({ status: "queued", wakeUp: { pageId: meetingPageId } });
  });

  it("rejects missing, malformed, and tampered signatures before parsing a wake-up", () => {
    const queue = new RecordingWakeUpQueue();
    const ingress = createNotionWebhookWakeUpIngress({
      workspaceId,
      canonicalMeetingsDataSourceId,
      verificationToken,
      queue
    });
    const delivery = signedDelivery(webhookEvent());

    expect(ingress.receive({ rawBody: delivery.rawBody, headers: {} })).toMatchObject({
      status: "rejected",
      reason: "signature-missing"
    });
    expect(
      ingress.receive({
        rawBody: delivery.rawBody,
        headers: { "X-Notion-Signature": "sha256=not-a-valid-digest" }
      })
    ).toMatchObject({ status: "rejected", reason: "signature-invalid" });
    expect(
      ingress.receive({
        rawBody: Buffer.from(
          JSON.stringify(webhookEvent({ entity: { id: "forged-page", type: "page" } })),
          "utf8"
        ),
        headers: delivery.headers
      })
    ).toMatchObject({ status: "rejected", reason: "signature-invalid" });
    expect(queue.wakeUps).toEqual([]);
  });

  it("ignores authenticated events outside the configured workspace and event scope", () => {
    const queue = new RecordingWakeUpQueue();
    const ingress = createNotionWebhookWakeUpIngress({
      workspaceId,
      canonicalMeetingsDataSourceId,
      verificationToken,
      queue,
      subscriptionId: "subscription-dayova-meetings",
      integrationId: "integration-luma"
    });

    expect(
      ingress.receive(signedDelivery(webhookEvent({ workspace_id: "other-workspace" })))
    ).toMatchObject({ status: "ignored", reason: "workspace-mismatch" });
    expect(
      ingress.receive(
        signedDelivery(webhookEvent({ subscription_id: "other-subscription" }))
      )
    ).toMatchObject({ status: "ignored", reason: "subscription-mismatch" });
    expect(
      ingress.receive(
        signedDelivery(
          webhookEvent({
            type: "comment.created",
            entity: { id: "comment-1", type: "comment" }
          })
        )
      )
    ).toMatchObject({ status: "ignored", reason: "unsupported-event" });
    expect(
      ingress.receive(
        signedDelivery(
          webhookEvent({
            type: "data_source.content_updated",
            entity: { id: "another-data-source", type: "data_source" }
          })
        )
      )
    ).toMatchObject({ status: "ignored", reason: "outside-canonical-meetings" });
    expect(queue.wakeUps).toEqual([]);
  });

  it("ignores a signed page event with an unsafe entity ID before it can become a page read", () => {
    const queue = new RecordingWakeUpQueue();
    const ingress = createNotionWebhookWakeUpIngress({
      workspaceId,
      canonicalMeetingsDataSourceId,
      verificationToken,
      queue
    });

    for (const suffix of ["#unexpected-path", "?unexpected=query", "/nested", "%2f"]) {
      expect(
        ingress.receive(
          signedDelivery(
            webhookEvent({ entity: { id: `${meetingPageId}${suffix}`, type: "page" } })
          )
        )
      ).toMatchObject({ status: "ignored", reason: "malformed-event" });
    }

    expect(queue.wakeUps).toEqual([]);
  });

  it("turns an authenticated canonical data-source signal into a reconciliation wake-up", () => {
    const queue = new RecordingWakeUpQueue();
    const ingress = createNotionWebhookWakeUpIngress({
      workspaceId,
      canonicalMeetingsDataSourceId,
      verificationToken,
      queue
    });

    const result = ingress.receive(
      signedDelivery(
        webhookEvent({
          id: "event-canonical-data-source-1",
          type: "data_source.content_updated",
          entity: {
            id: canonicalMeetingsDataSourceId,
            type: "data_source"
          }
        })
      )
    );

    expect(result).toMatchObject({
      status: "queued",
      wakeUp: { kind: "canonical-reconciliation" }
    });
    expect(queue.wakeUps).toEqual([
      expect.objectContaining({ kind: "canonical-reconciliation" })
    ]);
  });
});
