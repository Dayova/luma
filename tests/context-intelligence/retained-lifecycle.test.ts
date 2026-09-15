import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import {
  createObservedSourceLedger,
  type RawConversationSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createRetainedConversationLifecycle } from "../../src/knowledge/retained-conversation-lifecycle.js";
import { createContextIntelligence } from "../../src/context-intelligence/context-intelligence.js";
import type { ContextInquiry } from "../../src/context-intelligence/interface.js";
import type { ConversationEvidenceSource } from "../../src/context-intelligence/conversation-evidence-source.js";

const now = "2026-09-15T13:00:00.000Z";
const databases: LumaDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) if (!db.closed) await db.close();
});
const inquiry = (id = "ask"): ContextInquiry => ({
  type: "ask",
  workspaceId: "dayova",
  inquiryId: id,
  question: "Who owns Luma?",
  audience: { workspaceId: "dayova", personIds: ["jakob"] },
  subject: {
    type: "conversation-thread",
    providerId: "discord",
    conversationObjectId: "thread",
    anchorMessageId: "question"
  }
});
function snapshot(): RawConversationSnapshot {
  const messages = [
    { id: "claim", text: "Jakob owns Luma." },
    { id: "question", text: "Who owns Luma?" }
  ].map((m, ordinal) => ({
    ...m,
    ordinal,
    state: "available" as const,
    author: { providerUserId: "jakob", displayName: "Jakob" },
    createdAt: now,
    editedAt: null,
    replyToMessageId: null,
    url: `https://discord.com/channels/guild/thread/${m.id}`
  }));
  return {
    schemaVersion: 1,
    conversation: {
      conversationObjectId: "thread",
      parentConversationObjectId: "parent",
      title: "Luma",
      url: "https://discord.com/channels/guild/thread"
    },
    boundary: {
      mode: "thread",
      anchorMessageId: "question",
      firstMessageId: "claim",
      lastMessageId: "question",
      messageIds: ["claim", "question"]
    },
    messages,
    completeness: { state: "complete" }
  };
}
async function harness(db?: LumaDatabase) {
  const database = db ?? (await createPgliteDatabase());
  if (!db) databases.push(database);
  const lifecycle = createRetainedConversationLifecycle({
    database,
    workspaceId: "dayova",
    providerId: "discord",
    allowedParentIds: ["parent"]
  });
  let current = snapshot();
  let readsFail = false;
  let whileAnswering: (() => Promise<void>) | undefined;
  let whileReading: (() => Promise<void>) | undefined;
  let answers = 0;
  const raw: ConversationEvidenceSource = {
    async capture() {
      const captured = structuredClone(current);
      await whileReading?.();
      if (readsFail) throw new Error("provider unavailable");
      return {
        source: {
          providerId: "discord",
          sourceKind: "conversation",
          sourceObjectId: "question",
          parentObjectId: "thread",
          url: "https://discord.com/channels/guild/thread/question"
        },
        providerVersion: null,
        snapshot: captured,
        observedAt: now
      };
    }
  };
  const ledger = createObservedSourceLedger({ database });
  const construct = (allowedParentIds = ["parent"]) =>
    createContextIntelligence({
      database,
      ledger,
      conversationEvidenceSource: {
        capture: (request) =>
          createRetainedConversationLifecycle({
            database,
            workspaceId: "dayova",
            providerId: "discord",
            allowedParentIds
          }).capture(raw, request)
      },
      answerer: {
        async answer(request) {
          answers++;
          await whileAnswering?.();
          return {
            answer: {
              text: "Jakob owns Luma.",
              evidenceIds: [request.evidence[0]!.evidenceId]
            },
            facts: [],
            inferences: [],
            unresolved: [],
            metadata: {
              provider: "test",
              model: "programmable",
              promptVersion: request.promptVersion
            }
          };
        }
      }
    });
  return {
    database,
    lifecycle,
    raw,
    ledger,
    context: construct(),
    construct,
    answers: () => answers,
    set: (value: RawConversationSnapshot) => {
      current = value;
    },
    failReads: () => {
      readsFail = true;
    },
    whileAnswering: (fn: () => Promise<void>) => {
      whileAnswering = fn;
    },
    whileReading: (fn: () => Promise<void>) => {
      whileReading = fn;
    }
  };
}
const edit = (eventId = "edit") => ({
  kind: "edited" as const,
  eventId,
  observedAt: now,
  conversationId: "thread",
  messageId: "claim",
  text: "Julius owns Luma.",
  providerVersion: "2026-09-15T13:01:00.000Z"
});

describe("retained conversation lifecycle through Context Intelligence", () => {
  it("replays unchanged answers without another model call and deduplicates observed revisions", async () => {
    const h = await harness();
    const first = await h.context.inquire(inquiry());
    expect(await h.context.inquire(inquiry())).toEqual(first);
    expect(h.answers()).toBe(1);
    await h.lifecycle.observe(edit());
    await h.lifecycle.observe({ ...edit(), observedAt: "2026-09-15T13:02:00.000Z" });
    expect(
      (
        await h.database.query(
          "SELECT * FROM conversation_lifecycle_events WHERE kind='edited'"
        )
      ).rows
    ).toHaveLength(1);
    await expect(h.context.inquire(inquiry())).rejects.toThrow();
    expect(h.answers()).toBe(1);
  });
  it("withholds an in-flight answer when an observed edit changes its source and preserves the original ledger", async () => {
    const h = await harness();
    h.whileAnswering(async () => {
      await h.lifecycle.observe(edit());
      const changed = snapshot();
      changed.messages[0]!.text = "Julius owns Luma.";
      changed.messages[0]!.editedAt = edit().providerVersion;
      h.set(changed);
    });
    await expect(h.context.inquire(inquiry())).rejects.toThrow();
    const original = await h.ledger.get({
      workspaceId: "dayova",
      source: {
        providerId: "discord",
        sourceKind: "conversation",
        sourceObjectId: "question"
      },
      revision: 1
    });
    expect(original?.snapshot.messages[0]?.text).toBe("Jakob owns Luma.");
  });
  it("retains positive deletion tombstones, refuses stale rereads, and never fabricates deletion from a failed fetch", async () => {
    const h = await harness();
    await h.context.inquire(inquiry());
    h.failReads();
    await expect(h.context.inquire(inquiry("outage"))).rejects.toThrow();
    expect(
      (
        await h.database.query(
          "SELECT * FROM conversation_lifecycle_events WHERE kind='deleted'"
        )
      ).rows
    ).toHaveLength(0);
    await h.lifecycle.observe({
      kind: "deleted",
      eventId: "delete",
      observedAt: now,
      conversationId: "thread",
      messageId: "claim"
    });
    const tombstones = await h.database.query<{ payload_json: string }>(
      "SELECT payload_json FROM conversation_lifecycle_events WHERE kind='deleted'"
    );
    expect(JSON.parse(tombstones.rows[0]!.payload_json)).toEqual({ state: "deleted" });
    const restarted = await harness(h.database);
    await expect(restarted.context.inquire(inquiry("stale-provider"))).rejects.toThrow();
    expect(restarted.answers()).toBe(0);
  });
  it("blocks both replay and fresh reasoning after explicit exclusion or configuration removal", async () => {
    const h = await harness();
    await h.context.inquire(inquiry());
    await expect(h.construct([]).inquire(inquiry())).rejects.toThrow();
    await expect(h.construct([]).inquire(inquiry("removed"))).rejects.toThrow();
    await h.lifecycle.observe({
      kind: "excluded",
      eventId: "exclude",
      observedAt: now,
      conversationId: "thread"
    });
    await expect(h.context.inquire(inquiry())).rejects.toThrow();
    await expect(h.context.inquire(inquiry("excluded"))).rejects.toThrow();
    expect(h.answers()).toBe(1);
  });
  it("retains create and unknown edit events only for previously admitted conversations", async () => {
    const h = await harness();
    await h.lifecycle.observe({ ...edit(), conversationId: "personal" });
    expect(
      (await h.database.query("SELECT * FROM conversation_lifecycle_events")).rows
    ).toHaveLength(0);
    await h.context.inquire(inquiry());
    await h.lifecycle.observe({
      ...edit("created"),
      kind: "created",
      messageId: "later",
      text: "new message"
    });
    await h.lifecycle.observe({ ...edit(), text: null, providerVersion: null });
    await expect(h.context.inquire(inquiry())).rejects.toThrow();
    expect(
      (
        await h.database.query(
          "SELECT kind FROM conversation_lifecycle_events WHERE kind IN ('created','edited')"
        )
      ).rows
    ).toHaveLength(2);
  });
  it("refuses a snapshot captured concurrently with an event", async () => {
    const h = await harness();
    await h.context.inquire(inquiry());
    h.whileReading(() => h.lifecycle.observe(edit()));
    await expect(h.context.inquire(inquiry("racing"))).rejects.toThrow();
    expect(h.answers()).toBe(1);
  });
  it("does not let a changed payload reuse an existing event ID", async () => {
    const h = await harness();
    await h.context.inquire(inquiry());
    await h.lifecycle.observe(edit());
    await expect(h.lifecycle.observe({ ...edit(), text: "replacement" })).rejects.toThrow(
      "Conflicting"
    );
  });
  it("keeps events across a durable-store restart and exposes the gap while allowing fresh current-state questions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luma-lifecycle-"));
    let database = await createPgliteDatabase(join(directory, "db"));
    try {
      const h = await harness(database);
      await h.context.inquire(inquiry());
      await h.lifecycle.observe({ ...edit("new"), kind: "created", messageId: "later" });
      await database.close();
      database = await createPgliteDatabase(join(directory, "db"));
      const restarted = await harness(database);
      await restarted.lifecycle.gap("restart", now);
      await expect(restarted.context.inquire(inquiry())).rejects.toThrow();
      const fresh = await restarted.context.inquire(inquiry("fresh"));
      expect(await restarted.context.inquire(inquiry("fresh"))).toEqual(fresh);
      expect(restarted.answers()).toBe(1);
      expect(fresh.warnings).toContainEqual(
        expect.objectContaining({ code: "conversation-history-gap" })
      );
      expect(
        (
          await database.query(
            "SELECT * FROM conversation_lifecycle_events WHERE event_id='new'"
          )
        ).rows
      ).toHaveLength(1);
      expect(
        (
          await database.query(
            "SELECT * FROM conversation_lifecycle_events WHERE kind='deleted'"
          )
        ).rows
      ).toHaveLength(0);
    } finally {
      if (!database.closed) await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
