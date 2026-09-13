import { describe, expect, it } from "vitest";
import {
  createDiscordDirectMessages,
  type DirectMessage,
  type DiscordDirectMessageTransport
} from "../../src/discord/discord-direct-messages.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createAiUsageBudget } from "../../src/ai/ai-usage-budget.js";
import type { ContextAnswerer } from "../../src/context-intelligence/context-answerer.js";
import { AiServiceError } from "../../src/ai/ai-service-error.js";

const people = new Map([
  ["779381502311137301", "person_jakob"],
  ["726409024894926869", "person_fabius"],
  ["1492911575806251219", "person_philipp"],
  ["1376219174723911841", "person_julius"]
]);
const jakob = "779381502311137301";
const fabius = "726409024894926869";
const bot = "1526147284822392952";
const channel = "1550000000000000001";
function setup() {
  let number = 1550000000000000100n;
  let time = new Date("2026-09-13T07:00:00Z");
  const messages: DirectMessage[] = [];
  const recipients = new Map([[channel, jakob]]);
  const sent: {
    channelId: string;
    recipientId: string;
    content: string;
    idempotencyKey: string;
  }[] = [];
  let calls = 0;
  let duringAnswer: (() => void) | undefined;
  let failure: Error | undefined;
  const answerer: ContextAnswerer = {
    answer: (request) => {
      calls++;
      duringAnswer?.();
      if (failure) return Promise.reject(failure);
      return Promise.resolve({
        answer: {
          text: request.evidence.map((e) => e.text).join(" | "),
          evidenceIds: request.evidence.map((e) => e.evidenceId)
        },
        facts: [],
        inferences: [],
        unresolved: [],
        metadata: {
          provider: "test",
          model: "fixture",
          promptVersion: request.promptVersion
        }
      });
    }
  };
  const transport: DiscordDirectMessageTransport = {
    onMessage() {},
    botId: () => bot,
    recipient: (id) => Promise.resolve(recipients.get(id) ?? null),
    read: (id, messageId) =>
      Promise.resolve(
        messages.find((m) => m.channelId === id && m.id === messageId) ?? null
      ),
    before: (id, messageId, limit) =>
      Promise.resolve(
        messages
          .filter((m) => m.channelId === id && BigInt(m.id) < BigInt(messageId))
          .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1))
          .slice(0, limit)
      ),
    send: (response) => {
      sent.push(response);
      return Promise.resolve();
    }
  };
  function message(text: string, authorId = jakob, channelId = channel) {
    time = new Date(time.getTime() + 11000);
    const m: DirectMessage = {
      id: String(number++),
      channelId,
      authorId,
      bot: authorId === bot,
      text,
      createdAt: time.toISOString(),
      editedAt: null,
      unsupported: false
    };
    messages.push(m);
    return { channelId, messageId: m.id, authorId };
  }
  return {
    transport,
    answerer,
    message,
    sent,
    messages,
    recipients,
    now: () => time,
    calls: () => calls,
    during(fn: () => void) {
      duringAnswer = fn;
    },
    fail(error: Error) {
      failure = error;
    }
  };
}
async function withRuntime(
  run: (
    fixture: ReturnType<typeof setup>,
    runtime: Awaited<ReturnType<typeof createDiscordDirectMessages>>,
    database: Awaited<ReturnType<typeof createPgliteDatabase>>
  ) => Promise<void>
) {
  const fixture = setup();
  const database = await createPgliteDatabase();
  const runtime = await createDiscordDirectMessages({
    workspaceId: "test",
    database,
    transport: fixture.transport,
    answerer: fixture.answerer,
    budget: createAiUsageBudget({ database, monthlyLimitUsd: 1 }),
    now: fixture.now,
    authorize: (id) => Promise.resolve(people.get(id) ?? null)
  });
  try {
    await run(fixture, runtime, database);
  } finally {
    await database.close();
  }
}

describe("private founder conversations", () => {
  it.each([...people.keys()])(
    "answers founder %s without a mention and only in their DM",
    async (user) => {
      await withRuntime(async (f, r) => {
        f.recipients.set(channel, user);
        await r.handle(f.message("I will test Luma tomorrow. What will I do?", user));
        expect(f.calls()).toBe(1);
        expect(f.sent).toHaveLength(1);
        expect(f.sent[0]).toMatchObject({
          channelId: channel,
          recipientId: user,
          content: expect.stringContaining("test Luma") as unknown
        });
      });
    }
  );
  it("rejects outsiders, group DMs and mismatched recipients before analysis or replies", async () => {
    await withRuntime(async (f, r) => {
      await r.handle(f.message("private outsider text", "999999999999999999"));
      f.recipients.delete(channel);
      await r.handle(f.message("group DM"));
      f.recipients.set(channel, fabius);
      await r.handle(f.message("wrong recipient"));
      expect(f.calls()).toBe(0);
      expect(f.sent).toEqual([]);
    });
  });
  it("keeps founder evidence separate and excludes bot output from human evidence", async () => {
    await withRuntime(async (f, r) => {
      await r.handle(f.message("Jakob private detail alpha"));
      const second = "1550000000000000002";
      f.recipients.set(second, fabius);
      await r.handle(f.message("Fabius private detail beta", fabius, second));
      expect(f.sent.at(-1)?.content).not.toContain("alpha");
      f.message("Bot invention gamma", bot);
      await r.handle(f.message("What did I tell you?"));
      expect(f.sent.at(-1)?.content).toContain("alpha");
      expect(f.sent.at(-1)?.content).not.toContain("beta");
      expect(f.sent.at(-1)?.content).not.toContain("gamma");
    });
  });
  it("starts fresh with /new while retaining earlier source revisions", async () => {
    await withRuntime(async (f, r, database) => {
      await r.handle(f.message("Old context alpha"));
      const first = await database.query(
        "SELECT count(*) FROM observed_source_snapshots"
      );
      await r.handle(f.message("/new"));
      await r.handle(f.message("New context beta"));
      expect(f.sent.at(-1)?.content).toContain("beta");
      expect(f.sent.at(-1)?.content).not.toContain("alpha");
      expect(
        (await database.query("SELECT count(*) FROM observed_source_snapshots")).rows
      ).not.toEqual(first.rows);
    });
  });
  it("does not publish an answer when its source changes during analysis", async () => {
    await withRuntime(async (f, r) => {
      const event = f.message("Secret source alpha");
      f.during(() => {
        f.messages[0]!.text = "Changed source beta";
        f.messages[0]!.editedAt = f.now().toISOString();
      });
      await r.handle(event);
      expect(f.calls()).toBe(1);
      expect(f.sent.at(-1)?.content).not.toContain("alpha");
    });
  });
  it("reuses a retained answer after runtime restart without another model request", async () => {
    await withRuntime(async (f, r, database) => {
      const event = f.message("A repeatable question");
      await r.handle(event);
      const restarted = await createDiscordDirectMessages({
        workspaceId: "test",
        database,
        transport: f.transport,
        answerer: f.answerer,
        budget: createAiUsageBudget({ database }),
        authorize: (id) => Promise.resolve(people.get(id) ?? null),
        now: f.now
      });
      await restarted.handle(event);
      expect(f.calls()).toBe(1);
      expect(f.sent[1]?.content).toBe(f.sent[0]?.content);
      expect(f.sent[1]?.idempotencyKey).toBe(f.sent[0]?.idempotencyKey);
    });
  });
  it("explains budget failure and keeps usage available without another model call", async () => {
    await withRuntime(async (f, r) => {
      f.fail(
        new AiServiceError("budget-exhausted", "Private provider body", {
          requestDispatched: false
        })
      );
      await r.handle(f.message("An AI question"));
      expect(f.sent.at(-1)?.content).toContain("budget");
      expect(f.sent.at(-1)?.content).not.toContain("Private provider body");
      await r.handle(f.message("usage"));
      expect(f.sent.at(-1)?.content).toContain("$1.00");
      expect(f.calls()).toBe(1);
    });
  });
  it("refuses truncated history, then permits a fresh /new boundary", async () => {
    await withRuntime(async (f, r) => {
      for (let i = 0; i < 51; i++) f.message("Earlier text");
      await r.handle(f.message("Question"));
      expect(f.sent.at(-1)?.content).toContain("/new");
      expect(f.calls()).toBe(0);
      await r.handle(f.message("/new"));
      await r.handle(f.message("Fresh bounded question"));
      expect(f.calls()).toBe(1);
      expect(f.sent.at(-1)?.content).toContain("Fresh bounded question");
    });
  });
});
