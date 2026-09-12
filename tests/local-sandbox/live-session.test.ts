import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createLiveSandboxSession } from "../../src/local-sandbox/live-session.js";
import { createAiUsageBudget } from "../../src/ai/ai-usage-budget.js";
import type { OpenAIResponseRequest } from "../../src/ai/openai-reasoning-model.js";

const now = () => new Date("2026-09-12T07:00:00Z");
const analysisInput = {
  type: "analyze",
  title: "Local test",
  text: "Jakob: I own Luma. We might use a VPS, but hosting is undecided."
};
const inputSchema = z.object({ evidence: z.array(z.object({ evidenceId: z.string() })) });
function clients() {
  const requests: OpenAIResponseRequest[] = [];
  let failure: Error | undefined;
  let badCitation = false;
  return {
    requests,
    fail(error: Error) {
      failure = error;
    },
    invalidateCitations() {
      badCitation = true;
    },
    ports: {
      reasoning: {
        create: (request: OpenAIResponseRequest) => {
          requests.push(request);
          if (failure) return Promise.reject(failure);
          const evidenceIds = [
            inputSchema.parse(JSON.parse(request.input)).evidence[0]!.evidenceId
          ];
          return Promise.resolve(
            response({
              actionItems: [
                {
                  stableKey: "luma",
                  description: "Build Luma.",
                  ownerId: null,
                  dueDate: {
                    originalPhrase: null,
                    normalizedDate: null,
                    confidence: "unknown",
                    timezone: "Europe/Berlin"
                  },
                  status: "candidate",
                  relatedDecisionIds: [],
                  evidenceIds,
                  confidence: "high"
                }
              ],
              decisions: [],
              openQuestions: [],
              risks: [],
              followUpIntentions: []
            })
          );
        }
      },
      answer: {
        create: (request: OpenAIResponseRequest) => {
          requests.push(request);
          if (failure) return Promise.reject(failure);
          const evidence = z
            .object({
              evidence: z.array(
                z.object({ evidenceId: z.string(), text: z.string().nullable() })
              )
            })
            .parse(JSON.parse(request.input)).evidence;
          const correction = evidence.find((e) =>
            e.text?.includes('"ownerId":"person_julius"')
          );
          return Promise.resolve(
            response({
              answer: {
                text: correction
                  ? "Julius owns Luma after Jakob’s correction."
                  : "Hosting is still undecided.",
                evidenceIds: [
                  badCitation ? "invented" : (correction ?? evidence[0])!.evidenceId
                ]
              },
              facts: [],
              inferences: [],
              unresolved: []
            })
          );
        }
      }
    }
  };
}
function response(output: unknown) {
  return {
    outputText: JSON.stringify(output),
    model: "gpt-5.6-luna",
    serviceTier: "default",
    status: "completed",
    usage: {
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 20,
      reasoningTokens: 0
    }
  };
}

describe("real-AI local mode with deterministic external response clients", () => {
  it("uses real adapters and cores, carries human instructions into answers, and preserves replay/accounting across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luma-live-local-test-"));
    const path = join(directory, "store");
    const mock = clients();
    let at = now();
    let session = await createLiveSandboxSession({
      database: await createPgliteDatabase(path),
      clients: mock.ports,
      now: () => at
    });
    try {
      const analyzed = await session.execute(analysisInput);
      expect(analyzed.error).toBeNull();
      expect(analyzed.result).toMatchObject({ analysisStatus: "completed", errors: [] });
      expect(analyzed.usage.requestCount).toBe(1);
      expect(analyzed.usage.spentUsd).toBeGreaterThan(0);
      const owner = await session.execute({
        type: "judge",
        action: "owner",
        itemId: "action:luma",
        owner: "person_julius"
      });
      expect(owner.error).toBeNull();
      expect(owner.state).toMatchObject({ actionItems: [{ ownerId: "person_julius" }] });
      expect(mock.requests).toHaveLength(1);
      at = new Date("2026-09-14T07:00:00Z");
      const answer = await session.execute({ type: "ask", text: "What is decided?" });
      expect(answer.error).toBeNull();
      expect(answer.result).toMatchObject({
        type: "answer",
        answer: { text: "Julius owns Luma after Jakob’s correction." }
      });
      expect(mock.requests).toHaveLength(2);

      expect(answer.usage.requestCount).toBe(2);
      await session.close();
      const reopened = await createPgliteDatabase(path);
      expect(
        (await reopened.query("SELECT asked_at FROM local_ai_questions")).rows
      ).toEqual([{ asked_at: at.toISOString() }]);
      at = new Date("2026-09-15T07:00:00Z");
      session = await createLiveSandboxSession({
        database: reopened,
        clients: mock.ports,
        now: () => at
      });
      const cached = await session.execute({ type: "ask", text: "What is decided?" });
      expect(cached.error).toBeNull();
      expect(cached.usage.spentUsd).toBe(answer.usage.spentUsd);
      await session.execute({ type: "replay" });
      await session.execute({ type: "conclude" });
      const afterConclusion = await session.execute({
        type: "ask",
        text: "What is decided?"
      });
      expect(afterConclusion.error).toBeNull();
      expect(mock.requests).toHaveLength(2);
      expect(cached.source?.text).toBe(analysisInput.text);
    } finally {
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("blocks calls without a key and never reflects or persists the supplied key", async () => {
    const database = await createPgliteDatabase();
    const session = await createLiveSandboxSession({ database, now });
    try {
      const absent = await session.execute(analysisInput);
      expect(absent.error?.message).toContain("API key");
      expect(absent.usage.requestCount).toBe(0);
      const secret = "sk-test-local-secret-not-a-real-key";
      const connected = await session.execute({ type: "connect", apiKey: secret });
      expect(connected.connected).toBe(true);
      expect(JSON.stringify(connected)).not.toContain(secret);
      expect((await database.query("SELECT * FROM local_ai_meetings")).rows).toEqual([]);
      const disconnected = await session.execute({ type: "disconnect" });
      expect(disconnected.connected).toBe(false);
      expect((await session.execute(analysisInput)).usage.requestCount).toBe(0);
    } finally {
      await session.close();
    }
  });

  it("retains uncertain charges and surfaces provider failures without leaking error bodies", async () => {
    const mock = clients();
    const session = await createLiveSandboxSession({
      database: await createPgliteDatabase(),
      clients: mock.ports,
      now
    });
    try {
      await session.execute(analysisInput);
      mock.fail(new Error("secret-provider-error-body"));
      const failed = await session.execute({ type: "ask", text: "What is decided?" });
      expect(failed.error).not.toBeNull();
      expect(JSON.stringify(failed)).not.toContain("secret-provider-error-body");
      expect(failed.usage.unknownUsd).toBeGreaterThan(0);
      await session.execute({ type: "ask", text: "What is decided?" });
      expect(mock.requests).toHaveLength(2);
    } finally {
      await session.close();
    }
  });

  it("rejects fabricated citations without displaying an AI answer or repeating the paid attempt", async () => {
    const mock = clients();
    const session = await createLiveSandboxSession({
      database: await createPgliteDatabase(),
      clients: mock.ports,
      now
    });
    try {
      await session.execute(analysisInput);
      mock.invalidateCitations();
      const invalid = await session.execute({ type: "ask", text: "What is decided?" });
      expect(invalid.error).not.toBeNull();
      expect(invalid.result).toBeNull();
      await session.execute({ type: "ask", text: "What is decided?" });
      expect(mock.requests).toHaveLength(2);
    } finally {
      await session.close();
    }
  });

  it("refuses provider dispatch when the durable monthly test allowance is held", async () => {
    const database = await createPgliteDatabase();
    const budget = createAiUsageBudget({
      database,
      monthlyLimitUsd: 1,
      workflowLimitUsd: 1,
      now
    });
    // Fill almost all of the allowance with unresolved prior calls through the real budget port.
    for (let index = 0; index < 6; index++) {
      const reservation = await budget.reserve({
        workspaceId: "luma-local-ai",
        workflowId: `prior-${index}`,
        capability: "test",
        model: "gpt-5.6-luna",
        inputTokenUpperBound: 50000,
        maxOutputTokens: 128000
      });
      await budget.markUnknown(reservation.reservationId);
    }
    const mock = clients();
    const session = await createLiveSandboxSession({
      database,
      clients: mock.ports,
      now
    });
    try {
      const blocked = await session.execute(analysisInput);
      expect(mock.requests).toHaveLength(0);
      expect(blocked.result).toMatchObject({ analysisStatus: "deferred" });
      expect(JSON.stringify(blocked.result)).toContain("budget");
      expect(blocked.usage.unknownUsd).toBeGreaterThan(0.99);
    } finally {
      await session.close();
    }
  });
});
