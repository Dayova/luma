import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { AiServiceError } from "../../src/ai/ai-service-error.js";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import {
  createObservedSourceLedger,
  type RawConversationSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import { createContextIntelligence } from "../../src/context-intelligence/context-intelligence.js";
import type { ContextInquiry } from "../../src/context-intelligence/interface.js";
import type {
  ContextAnswerRequest,
  ContextAnswerResult
} from "../../src/context-intelligence/context-answerer.js";
import type {
  ContextCatalog,
  ContextSource
} from "../../src/organizational-context/interface.js";
import { createOrganizationalContext } from "../../src/organizational-context/organizational-context.js";
import { renderDiscordContextAskResult } from "../../src/discord/discord-context-ask-runtime.js";
import { createOpenAIContextAnswerer } from "../../src/context-intelligence/openai-context-answerer.js";

const workspaceId = "workspace_dayova";
const recipients = ["person_jakob", "person_fabius", "person_philipp", "person_julius"];
const now = "2026-09-10T10:00:00.000Z";
const databases: LumaDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
});
const inquiry = (): ContextInquiry => ({
  type: "ask",
  workspaceId,
  inquiryId: "ownership",
  question: "Who owns Luma?",
  audience: { workspaceId, personIds: [...recipients] },
  subject: {
    type: "conversation-thread",
    providerId: "discord",
    conversationObjectId: "2",
    anchorMessageId: "3"
  }
});
function source(id = "ownership"): ContextSource {
  return {
    id,
    kind: "knowledge-document",
    title: "Luma ownership",
    content: "Jakob owns Luma.",
    version: "1",
    updatedAt: now,
    externalReference: {
      providerId: "notion",
      objectType: "document",
      externalId: id,
      url: `https://www.notion.so/${id}`
    },
    standing: "current",
    authority: "human-confirmed"
  };
}
async function harness(
  options: {
    partialThread?: boolean;
    emptyCatalogs?: boolean;
    maxCharacters?: number;
    reply?: (request: ContextAnswerRequest) => ContextAnswerResult;
  } = {}
) {
  const database = await createPgliteDatabase();
  databases.push(database);
  const sources = new Map<string, ContextSource>([["ownership", source()]]);
  const audiences: string[][] = [];
  let authorized = true;
  let beforeRead: (() => void) | undefined;
  const catalog: ContextCatalog = {
    id: "notion-reviewed",
    search: ({ audience }) => {
      audiences.push([...audience.personIds]);
      return Promise.resolve({
        sourceIds: [...sources.keys()],
        complete: true,
        warnings: []
      });
    },
    read: ({ audience, sourceId }) => {
      audiences.push([...audience.personIds]);
      beforeRead?.();
      return Promise.resolve(
        authorized ? structuredClone(sources.get(sourceId) ?? null) : null
      );
    }
  };
  const organizationalContext = createOrganizationalContext({
    database,
    catalogs: options.emptyCatalogs ? [] : [catalog],
    now: () => new Date(now)
  });
  const snapshot: RawConversationSnapshot = {
    schemaVersion: 1,
    conversation: {
      conversationObjectId: "2",
      parentConversationObjectId: "1",
      title: "Luma",
      url: "https://discord.com/channels/1/2"
    },
    boundary: {
      mode: "thread",
      anchorMessageId: "3",
      firstMessageId: "3",
      lastMessageId: "3",
      messageIds: ["3"]
    },
    messages: [
      {
        id: "3",
        ordinal: 0,
        author: {
          providerUserId: "779381502311137301",
          displayName: "Jakob",
          personId: "person_jakob"
        },
        createdAt: now,
        editedAt: null,
        replyToMessageId: null,
        url: "https://discord.com/channels/1/2/3",
        state: "available",
        text: "@Luma Who owns Luma?"
      }
    ],
    completeness: options.partialThread
      ? {
          state: "partial",
          reasons: [{ code: "thread-not-readable", message: "A message is unavailable." }]
        }
      : { state: "complete" }
  };
  const requests: ContextAnswerRequest[] = [];
  const dependencies = {
    database,
    ledger: createObservedSourceLedger({ database }),
    organizationalContext,
    organizationalContextLimits: {
      limit: 8,
      maxCharacters: options.maxCharacters ?? 8_000
    },
    conversationEvidenceSource: {
      capture: () =>
        Promise.resolve({
          source: {
            providerId: "discord",
            sourceKind: "conversation" as const,
            sourceObjectId: "3",
            parentObjectId: "2",
            url: "https://discord.com/channels/1/2/3"
          },
          providerVersion: null,
          snapshot: structuredClone(snapshot),
          observedAt: now
        })
    },
    answerer: {
      answer: (request: ContextAnswerRequest) => {
        requests.push(request);
        return Promise.resolve(options.reply ? options.reply(request) : answer(request));
      }
    },
    now: () => new Date(now)
  };
  return {
    database,
    sources,
    audiences,
    requests,
    snapshot,
    dependencies,
    context: createContextIntelligence(dependencies),
    revoke: () => {
      authorized = false;
    },
    restore: () => {
      authorized = true;
    },
    onRead: (callback: () => void) => {
      beforeRead = callback;
    }
  };
}
function answer(request: ContextAnswerRequest): ContextAnswerResult {
  const org = request.organizationalEvidence?.[0];
  const thread = request.evidence[0];
  if (!thread) throw new Error("Expected original thread evidence");
  return {
    answer: {
      text: org
        ? "Jakob owns Luma."
        : "The thread asks who owns Luma; no ownership source was found.",
      evidenceIds: org ? [org.evidenceId, thread.evidenceId] : [thread.evidenceId]
    },
    facts: [],
    inferences: [],
    unresolved: [],
    metadata: {
      provider: "programmable",
      model: "synthetic",
      promptVersion: request.promptVersion
    }
  };
}
async function delivery(context: ReturnType<typeof createContextIntelligence>) {
  if (!context.requireCurrent) throw new Error("Expected delivery capability");
  return context.requireCurrent(inquiry());
}

describe("Context Ask with governed organizational retrieval", () => {
  it("refuses a source that changes between retrieval and reasoning before making a paid call", async () => {
    const f = await harness();
    let reads = 0;
    f.onRead(() => {
      if (++reads > 1)
        f.sources.set("ownership", {
          ...source(),
          version: "2",
          content: "The Luma ownership source changed."
        });
    });
    await expect(f.context.inquire(inquiry())).rejects.toMatchObject({
      code: "context-inquiry-context-changed"
    });
    expect(f.requests).toHaveLength(0);
  });
  it("preserves the shared AI budget failure after retrieval without storing an invented answer", async () => {
    const error = new AiServiceError(
      "budget-exhausted",
      "The shared AI allowance is exhausted"
    );
    const f = await harness({
      reply: () => {
        throw error;
      }
    });
    await expect(f.context.inquire(inquiry())).rejects.toBe(error);
    expect((await f.database.query("SELECT * FROM context_inquiries")).rows).toHaveLength(
      0
    );
  });
  it("answers with genuine mixed citations, binds the four recipients, and replays a persisted receipt without model work", async () => {
    const f = await harness();
    const result = await f.context.inquire(inquiry());
    expect(result.answer.evidence[0]?.messageId).toBe("3");
    expect(result.answer.organizationalEvidence?.[0]).toMatchObject({
      kind: "knowledge-document",
      id: "ownership",
      authority: "human-confirmed"
    });
    expect(result.organizationalContext?.coverage.complete).toBe(true);
    expect(f.audiences.length).toBeGreaterThan(0);
    for (const audience of f.audiences)
      expect([...audience].sort()).toEqual([...recipients].sort());
    const rendered = renderDiscordContextAskResult(result);
    expect(rendered).toContain("https://www.notion.so/ownership");
    expect(rendered).toContain("https://discord.com/channels/1/2/3");
    expect(rendered).toContain("human-confirmed");
    expect(rendered).toContain("within configured catalogs");
    expect(await createContextIntelligence(f.dependencies).inquire(inquiry())).toEqual(
      result
    );
    await delivery(f.context);
    expect(f.requests).toHaveLength(1);
    const row = await f.database.query<{
      context_request_json: string;
      context_receipt_id: string;
      result_is_deliverable: boolean;
    }>(
      "SELECT context_request_json, context_receipt_id, result_is_deliverable FROM context_inquiries"
    );
    expect(JSON.parse(row.rows[0]?.context_request_json ?? "null")).toEqual(
      result.organizationalContext?.request
    );
    expect(row.rows[0]?.context_receipt_id).toBe(result.organizationalContext?.receiptId);
    expect(row.rows[0]?.result_is_deliverable).toBe(true);
  });

  it("accepts a generic-only grounded answer without inventing a Discord citation", async () => {
    const f = await harness({
      reply: (request) => {
        const result = answer(request);
        const org = request.organizationalEvidence?.[0];
        if (!org) throw new Error("Expected organization evidence");
        result.answer.evidenceIds = [org.evidenceId];
        return result;
      }
    });
    const result = await f.context.inquire(inquiry());
    expect(result.answer.evidence).toEqual([]);
    expect(renderDiscordContextAskResult(result)).toContain("Jakob owns Luma.");
    expect(renderDiscordContextAskResult(result)).not.toContain(
      "https://discord.com/channels/1/2/3"
    );
    expect(await f.context.inquire(inquiry())).toEqual(result);
  });

  it.each(["revoked", "deleted", "changed", "newly-discovered"] as const)(
    "refuses %s evidence before replay and final delivery while retaining the paid result",
    async (kind) => {
      const f = await harness();
      await f.context.inquire(inquiry());
      if (kind === "revoked") f.revoke();
      else if (kind === "deleted") f.sources.delete("ownership");
      else if (kind === "changed")
        f.sources.set("ownership", {
          ...source(),
          version: "2",
          content: "Jakob's Luma ownership needs review."
        });
      else
        f.sources.set("other", {
          ...source("other"),
          content: "Luma ownership also has a new Human clarification."
        });
      await expect(f.context.inquire(inquiry())).rejects.toMatchObject({
        code: "context-inquiry-context-changed"
      });
      await expect(delivery(f.context)).rejects.toMatchObject({
        code: "context-inquiry-context-changed"
      });
      expect(f.requests).toHaveLength(1);
      expect(
        (await f.database.query("SELECT * FROM context_inquiries")).rows
      ).toHaveLength(1);
    }
  );

  it("caches a completed paid result as non-deliverable when sources change during reasoning", async () => {
    let change: () => void = () => undefined;
    const f = await harness({
      reply: (request) => {
        const result = answer(request);
        change();
        return result;
      }
    });
    change = f.revoke;
    await expect(f.context.inquire(inquiry())).rejects.toMatchObject({
      code: "context-inquiry-context-changed"
    });
    f.restore();
    await expect(f.context.inquire(inquiry())).rejects.toMatchObject({
      code: "context-inquiry-context-changed"
    });
    expect(f.requests).toHaveLength(1);
    expect(
      (
        await f.database.query<{ result_is_deliverable: boolean }>(
          "SELECT result_is_deliverable FROM context_inquiries"
        )
      ).rows[0]?.result_is_deliverable
    ).toBe(false);
  });

  it("refuses configured retrieval without an audience or for a changed recipient set", async () => {
    const f = await harness();
    const absent = inquiry();
    delete absent.audience;
    await expect(f.context.inquire(absent)).rejects.toMatchObject({
      code: "context-inquiry-invalid"
    });
    expect(f.requests).toHaveLength(0);
    await f.context.inquire(inquiry());
    await expect(
      f.context.inquire({
        ...inquiry(),
        audience: { workspaceId, personIds: ["person_jakob"] }
      })
    ).rejects.toMatchObject({ code: "context-inquiry-id-conflict" });
  });

  it("qualifies bounded or unconfigured catalog coverage and preserves partial thread refusal", async () => {
    const bounded = await harness({ maxCharacters: 8 });
    const limited = await bounded.context.inquire(inquiry());
    expect(
      bounded.requests[0]?.organizationalEvidence?.[0]?.content.length
    ).toBeLessThanOrEqual(8);
    expect(limited.uncertainty).toBe("partial");
    expect(
      limited.warnings.some(
        (warning) => warning.code === "organizational-context-partial"
      )
    ).toBe(true);
    expect(await bounded.context.inquire(inquiry())).toEqual(limited);
    const empty = await harness({ emptyCatalogs: true });
    const none = await empty.context.inquire(inquiry());
    expect(renderDiscordContextAskResult(none)).toContain(
      "No organizational context sources are configured."
    );
    const partial = await harness({ partialThread: true });
    const result = await partial.context.inquire(inquiry());
    expect(result.uncertainty).toBe("insufficient-evidence");
    expect(partial.requests).toHaveLength(0);
    expect(partial.audiences).toHaveLength(0);
  });

  it("detects corruption of generic evidence even when the ordinary result digest is recomputed", async () => {
    const f = await harness();
    const result = await f.context.inquire(inquiry());
    const altered = structuredClone(result);
    const source = altered.organizationalContext?.evidence[0];
    if (!source) throw new Error("Expected persisted source");
    source.content = "Fabius owns Luma.";
    const json = JSON.stringify(altered);
    const hash = `sha256:${createHash("sha256").update(json).digest("hex")}`;
    await f.database.query(
      "UPDATE context_inquiries SET result_json=$1, result_content_hash=$2",
      [json, hash]
    );
    await expect(f.context.inquire(inquiry())).rejects.toMatchObject({
      code: "context-inquiry-corrupt"
    });
    expect(f.requests).toHaveLength(1);
  });

  it("lets the production answer adapter cite supplied generic sources and rejects an invented source", async () => {
    const f = await harness();
    await f.context.inquire(inquiry());
    const request = f.requests[0];
    if (!request) throw new Error("Expected request");
    const valid = answer(request);
    const { metadata: _metadata, ...output } = valid;
    void _metadata;
    const adapter = createOpenAIContextAnswerer({
      client: { create: () => Promise.resolve({ outputText: JSON.stringify(output) }) }
    });
    await expect(adapter.answer(request)).resolves.toMatchObject({
      answer: valid.answer
    });
    output.answer.evidenceIds = ["organizational:invented"];
    await expect(adapter.answer(request)).rejects.toMatchObject({
      code: "openai-context-answer-evidence-invalid"
    });
  });
});
