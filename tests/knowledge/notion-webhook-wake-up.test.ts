import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createNotionWebhookWakeUpIngress,
  type NotionWebhookWakeUp,
  type NotionWebhookWakeUpQueue
} from "../../src/knowledge/notion-webhook-wake-up.js";

const verificationToken = "secret_luma_notion_webhook_verification_token";
const notionWorkspaceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const canonicalMeetingsDataSourceId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const canonicalMeetingsDataSourceUuid = "cccccccc-dddd-eeee-ffff-000000000000";
const subscriptionId = "dddddddd-eeee-ffff-0000-111111111111";
const integrationId = "eeeeeeee-ffff-0000-1111-222222222222";
const meetingPageId = "11111111-2222-3333-4444-555555555555";
const deliveryId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";

class RecordingWakeUpQueue implements NotionWebhookWakeUpQueue {
  readonly wakeUps: NotionWebhookWakeUp[] = [];

  enqueue(wakeUp: NotionWebhookWakeUp) {
    this.wakeUps.push(wakeUp);
    return { status: "queued" as const };
  }
}

function webhookEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: deliveryId,
    timestamp: "2026-08-10T11:30:00.000Z",
    workspace_id: notionWorkspaceId,
    subscription_id: subscriptionId,
    integration_id: integrationId,
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
      notionWorkspaceId,
      canonicalMeetingsDataSourceId,
      verificationToken,
      subscriptionId,
      integrationId,
      queue,
      now: () => new Date("2026-08-10T11:31:00.000Z")
    });

    const result = ingress.receive(signedDelivery(webhookEvent()));

    expect(result).toMatchObject({
      status: "queued",
      wakeUp: {
        kind: "page",
        pageId: meetingPageId,
        deliveryId,
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
      notionWorkspaceId,
      canonicalMeetingsDataSourceId,
      verificationToken,
      subscriptionId,
      integrationId,
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

  it("treats an event API version as non-authoritative delivery metadata", () => {
    const queue = new RecordingWakeUpQueue();
    const ingress = createNotionWebhookWakeUpIngress({
      notionWorkspaceId,
      canonicalMeetingsDataSourceId,
      verificationToken,
      subscriptionId,
      integrationId,
      queue
    });

    expect(
      ingress.receive(signedDelivery(webhookEvent({ api_version: undefined })))
    ).toMatchObject({ status: "queued", wakeUp: { kind: "page" } });
    expect(
      ingress.receive(
        signedDelivery(
          webhookEvent({
            id: "99999999-aaaa-4bbb-8ccc-ddddddddddde",
            api_version: "2025-09-03"
          })
        )
      )
    ).toMatchObject({ status: "queued", wakeUp: { kind: "page" } });
    expect(queue.wakeUps).toHaveLength(2);
  });

  it("rejects missing, malformed, and tampered signatures before parsing a wake-up", () => {
    const queue = new RecordingWakeUpQueue();
    const ingress = createNotionWebhookWakeUpIngress({
      notionWorkspaceId,
      canonicalMeetingsDataSourceId,
      verificationToken,
      subscriptionId,
      integrationId,
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

  it("rejects duplicate signature spellings at the provider-neutral ingress seam", () => {
    const queue = new RecordingWakeUpQueue();
    const ingress = createNotionWebhookWakeUpIngress({
      notionWorkspaceId,
      canonicalMeetingsDataSourceId,
      verificationToken,
      subscriptionId,
      integrationId,
      queue
    });
    const delivery = signedDelivery(webhookEvent());

    expect(
      ingress.receive({
        rawBody: delivery.rawBody,
        headers: {
          "x-notion-signature": delivery.headers["x-notion-signature"],
          "X-Notion-Signature": delivery.headers["x-notion-signature"]
        }
      })
    ).toMatchObject({ status: "rejected", reason: "signature-missing" });
    expect(queue.wakeUps).toEqual([]);
  });

  it("ignores authenticated events outside the configured workspace and event scope", () => {
    const queue = new RecordingWakeUpQueue();
    const ingress = createNotionWebhookWakeUpIngress({
      notionWorkspaceId,
      canonicalMeetingsDataSourceId,
      verificationToken,
      queue,
      subscriptionId,
      integrationId
    });

    expect(
      ingress.receive(
        signedDelivery(
          webhookEvent({ workspace_id: "ffffffff-0000-1111-2222-333333333333" })
        )
      )
    ).toMatchObject({ status: "ignored", reason: "workspace-mismatch" });
    expect(
      ingress.receive(
        signedDelivery(
          webhookEvent({ subscription_id: "ffffffff-0000-1111-2222-333333333333" })
        )
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
      notionWorkspaceId,
      canonicalMeetingsDataSourceId,
      verificationToken,
      subscriptionId,
      integrationId,
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

  it("ignores a signed event with an unsafe delivery ID before it reaches the bounded queue", () => {
    const queue = new RecordingWakeUpQueue();
    const ingress = createNotionWebhookWakeUpIngress({
      notionWorkspaceId,
      canonicalMeetingsDataSourceId,
      verificationToken,
      subscriptionId,
      integrationId,
      queue
    });

    expect(
      ingress.receive(signedDelivery(webhookEvent({ id: "delivery#untrusted-path" })))
    ).toMatchObject({ status: "ignored", reason: "malformed-event" });
    expect(queue.wakeUps).toEqual([]);
  });

  it("turns an authenticated canonical data-source signal into a reconciliation wake-up", () => {
    const queue = new RecordingWakeUpQueue();
    const ingress = createNotionWebhookWakeUpIngress({
      notionWorkspaceId,
      canonicalMeetingsDataSourceId,
      verificationToken,
      subscriptionId,
      integrationId,
      queue
    });

    const result = ingress.receive(
      signedDelivery(
        webhookEvent({
          id: "99999999-aaaa-4bbb-8ccc-dddddddddddf",
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

  it("recognizes equivalent Notion data-source UUID spellings as canonical", () => {
    const queue = new RecordingWakeUpQueue();
    const ingress = createNotionWebhookWakeUpIngress({
      notionWorkspaceId,
      canonicalMeetingsDataSourceId: canonicalMeetingsDataSourceUuid
        .replaceAll("-", "")
        .toUpperCase(),
      verificationToken,
      subscriptionId,
      integrationId,
      queue
    });

    expect(
      ingress.receive(
        signedDelivery(
          webhookEvent({
            id: "99999999-aaaa-4bbb-8ccc-ddddddddddea",
            type: "data_source.content_updated",
            entity: { id: canonicalMeetingsDataSourceUuid, type: "data_source" }
          })
        )
      )
    ).toMatchObject({
      status: "queued",
      wakeUp: { kind: "canonical-reconciliation" }
    });
    expect(queue.wakeUps).toEqual([
      expect.objectContaining({ kind: "canonical-reconciliation" })
    ]);
  });
});
