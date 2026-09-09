import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import { createAiUsageBudget, type AiUsageBudget } from "../../src/ai/ai-usage-budget.js";
import {
  createOpenAIReasoningModel,
  createOpenAIReasoningModelFromEnv
} from "../../src/ai/openai-reasoning-model.js";
import { createOpenAIContextAnswerer } from "../../src/context-intelligence/openai-context-answerer.js";
import {
  aiRequestLimitsFromEnv,
  normalizedOpenAiUsage,
  normalizeAiServiceError,
  type AiRequestLimits,
  type AiResponse
} from "../../src/ai/ai-request.js";
import type { StructuredReasoningRequest } from "../../src/ai/reasoning-model.js";
import type { ContextAnswerRequest } from "../../src/context-intelligence/context-answerer.js";

type Capability = "meeting" | "context";
const usage = {
  inputTokens: 100,
  cachedInputTokens: 10,
  cacheWriteTokens: 20,
  outputTokens: 10,
  reasoningTokens: 5
};
const meetingRequest: StructuredReasoningRequest<unknown> = {
  workspaceId: "dayova",
  meetingId: "meeting",
  purpose: "understand-discussion",
  promptVersion: "v1",
  schemaName: "MeetingAnalysisProposalBatch",
  evidence: [],
  context: ["private-evidence-must-not-appear-in-ledger"],
  input: { revision: 1 }
};
const contextRequest: ContextAnswerRequest = {
  workspaceId: "dayova",
  inquiryId: "inquiry",
  question: "private-question-must-not-appear-in-ledger",
  promptVersion: "v1",
  source: {
    providerId: "discord",
    conversationObjectId: "thread",
    anchorMessageId: "message",
    snapshotRevision: 1,
    contentHash: "sha256:source",
    boundary: {
      mode: "thread",
      firstMessageId: "message",
      lastMessageId: "message",
      messageIds: ["message"]
    }
  },
  evidence: [
    {
      evidenceId: "evidence",
      providerId: "discord",
      conversationObjectId: "thread",
      anchorMessageId: "message",
      sourceRevision: 1,
      messageId: "message",
      ordinal: 1,
      author: { providerUserId: "jakob", displayName: "Jakob", personId: "person_jakob" },
      createdAt: "2026-09-08T12:00:00Z",
      editedAt: null,
      replyToMessageId: null,
      url: "https://discord.com/channels/guild/thread/message",
      state: "available",
      text: "private-evidence-must-not-appear-in-ledger"
    }
  ]
};

function response(capability: Capability): AiResponse {
  return {
    outputText:
      capability === "meeting"
        ? JSON.stringify({
            actionItems: [],
            decisions: [],
            openQuestions: [],
            risks: [],
            followUpIntentions: []
          })
        : JSON.stringify({
            answer: { text: "A sourced answer.", evidenceIds: ["evidence"] },
            facts: [],
            inferences: [],
            unresolved: []
          }),
    model: "gpt-5.6-luna",
    serviceTier: "default",
    status: "completed",
    usage,
    providerResponseId: "resp_safe_123",
    providerRequestId: "req_safe_456"
  };
}

function caller(
  capability: Capability,
  input: {
    budget: AiUsageBudget;
    client: { create(): Promise<AiResponse> };
    limits?: Partial<AiRequestLimits>;
  }
): () => Promise<unknown> {
  return capability === "meeting"
    ? () => createOpenAIReasoningModel(input).generateStructured(meetingRequest)
    : () => createOpenAIContextAnswerer(input).answer(contextRequest);
}

describe.each<Capability>(["meeting", "context"])(
  "budgeted %s OpenAI adapter",
  (capability) => {
    let database: LumaDatabase;
    beforeEach(async () => {
      database = await createPgliteDatabase();
    });
    afterEach(async () => {
      await database.close();
      vi.restoreAllMocks();
    });

    it("denies a request before contacting the provider when the shared cap is zero", async () => {
      const client = { create: vi.fn(() => Promise.resolve(response(capability))) };
      const budget = createAiUsageBudget({ database, monthlyLimitUsd: 0 });
      await expect(caller(capability, { budget, client })()).rejects.toMatchObject({
        code: "budget-exhausted"
      });
      expect(client.create).not.toHaveBeenCalled();
      expect(await budget.getStatus("dayova")).toMatchObject({ requestCount: 0 });
    });

    it("records actual normalized usage before rejecting malformed output", async () => {
      const client = {
        create: vi.fn(() =>
          Promise.resolve({
            ...response(capability),
            outputText: "not valid JSON"
          })
        )
      };
      const budget = createAiUsageBudget({ database });
      await expect(caller(capability, { budget, client })()).rejects.toThrow();
      expect(await budget.getStatus("dayova")).toMatchObject({
        spentUsd: 0.0000312,
        reservedUsd: 0,
        unknownUsd: 0,
        requestCount: 1
      });
      const { rows } = await database.query("SELECT * FROM ai_usage_requests");
      const telemetry = JSON.stringify(rows);
      expect(telemetry).toContain("resp_safe_123");
      expect(telemetry).toContain("req_safe_456");
      expect(telemetry).toContain("openai-standard-2026-09-08");
      expect(telemetry).not.toContain("private-evidence");
      expect(telemetry).not.toContain("private-question");
      expect(telemetry).not.toContain("not valid JSON");
    });

    it("keeps missing usage unknown and suppresses a duplicate paid attempt", async () => {
      const missing = response(capability);
      delete missing.usage;
      const client = { create: vi.fn(() => Promise.resolve(missing)) };
      const budget = createAiUsageBudget({ database });
      const call = caller(capability, { budget, client });
      await call();
      const status = await budget.getStatus("dayova");
      expect(status.spentUsd).toBe(0);
      expect(status.unknownUsd).toBeGreaterThan(0);
      await expect(call()).rejects.toMatchObject({ code: "request-indeterminate" });
      expect(client.create).toHaveBeenCalledTimes(1);
    });

    it("times out once, retains the possible charge and refuses a duplicate paid attempt", async () => {
      const client = { create: vi.fn(() => new Promise<AiResponse>(() => {})) };
      const budget = createAiUsageBudget({ database });
      const call = caller(capability, { budget, client, limits: { timeoutMs: 5 } });
      await expect(call()).rejects.toMatchObject({ code: "timeout" });
      expect((await budget.getStatus("dayova")).unknownUsd).toBeGreaterThan(0);
      await expect(call()).rejects.toMatchObject({ code: "request-indeterminate" });
      expect(client.create).toHaveBeenCalledTimes(1);
    });

    it("charges incomplete provider output but never accepts it as a completed answer", async () => {
      const client = {
        create: vi.fn(() =>
          Promise.resolve({ ...response(capability), status: "incomplete" })
        )
      };
      const budget = createAiUsageBudget({ database });
      await expect(caller(capability, { budget, client })()).rejects.toMatchObject({
        code: "unavailable"
      });
      expect(await budget.getStatus("dayova")).toMatchObject({
        spentUsd: 0.0000312,
        reservedUsd: 0,
        unknownUsd: 0
      });
    });

    it("reports an exhausted output limit as a request size failure after charging usage", async () => {
      const client = {
        create: vi.fn(() =>
          Promise.resolve({
            ...response(capability),
            status: "incomplete",
            incompleteReason: "max_output_tokens"
          })
        )
      };
      const budget = createAiUsageBudget({ database });
      await expect(caller(capability, { budget, client })()).rejects.toMatchObject({
        code: "request-too-large"
      });
      expect(await budget.getStatus("dayova")).toMatchObject({
        spentUsd: 0.0000312,
        reservedUsd: 0,
        unknownUsd: 0
      });
      const { rows } = await database.query<{ response_facts_json: string }>(
        "SELECT response_facts_json FROM ai_usage_requests"
      );
      expect(JSON.parse(rows[0]?.response_facts_json ?? "{}") as unknown).toMatchObject({
        incompleteReason: "max_output_tokens",
        failureCode: "request-too-large"
      });
      expect(client.create).toHaveBeenCalledTimes(1);
    });

    it.each([{ model: "unverified-model" }, { serviceTier: "priority" }])(
      "blocks spend after unverified returned pricing %j",
      async (pricing) => {
        const client = {
          create: vi.fn(() => Promise.resolve({ ...response(capability), ...pricing }))
        };
        const budget = createAiUsageBudget({ database });
        await expect(caller(capability, { budget, client })()).rejects.toMatchObject({
          code: "not-configured"
        });
        expect(await budget.getStatus("dayova")).toMatchObject({
          configured: false,
          status: "not-configured",
          spentUsd: 0
        });
        expect((await budget.getStatus("dayova")).unknownUsd).toBeGreaterThan(0);
        await expect(
          budget.reserve({
            workspaceId: "dayova",
            workflowId: "distinct",
            capability: "other",
            model: "gpt-5.6-luna",
            inputTokenUpperBound: 1000,
            maxOutputTokens: 1000
          })
        ).rejects.toMatchObject({ code: "not-configured" });
        expect(client.create).toHaveBeenCalledTimes(1);
      }
    );

    it("rejects oversized content including instructions and schema before admission", async () => {
      const client = { create: vi.fn(() => Promise.resolve(response(capability))) };
      const budget = createAiUsageBudget({ database });
      await expect(
        caller(capability, { budget, client, limits: { maxInputTokens: 100 } })()
      ).rejects.toMatchObject({ code: "request-too-large" });
      expect(client.create).not.toHaveBeenCalled();
      expect(await budget.getStatus("dayova")).toMatchObject({ requestCount: 0 });
    });
  }
);

describe("OpenAI wire usage and operational failures", () => {
  it.each<Capability>(["meeting", "context"])(
    "preserves the SDK output-limit reason and charges completed usage for %s",
    async (capability) => {
      const database = await createPgliteDatabase();
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "resp_output_limit",
            model: "gpt-5.6-luna",
            service_tier: "default",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [
              {
                type: "message",
                id: "msg_output_limit",
                status: "incomplete",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: response(capability).outputText,
                    annotations: []
                  }
                ]
              }
            ],
            usage: {
              input_tokens: 100,
              input_tokens_details: { cached_tokens: 10, cache_write_tokens: 20 },
              output_tokens: 10,
              output_tokens_details: { reasoning_tokens: 5 },
              total_tokens: 110
            }
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-request-id": "req_output_limit"
            }
          }
        )
      );
      try {
        const config = { apiKey: "test-key", budget: createAiUsageBudget({ database }) };
        const call =
          capability === "meeting"
            ? () => createOpenAIReasoningModel(config).generateStructured(meetingRequest)
            : () => createOpenAIContextAnswerer(config).answer(contextRequest);
        await expect(call()).rejects.toMatchObject({ code: "request-too-large" });
        expect(await config.budget.getStatus("dayova")).toMatchObject({
          spentUsd: 0.0000312,
          reservedUsd: 0,
          unknownUsd: 0
        });
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        fetch.mockRestore();
        await database.close();
      }
    }
  );

  it("normalizes complete usage and rejects missing or inconsistent details", () => {
    const raw = {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 10, cache_write_tokens: 20 },
      output_tokens: 10,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 110
    };
    expect(normalizedOpenAiUsage(raw)).toEqual(usage);
    expect(
      normalizedOpenAiUsage({ ...raw, input_tokens_details: { cached_tokens: 10 } })
    ).toBeUndefined();
    expect(normalizedOpenAiUsage({ ...raw, total_tokens: 115 })).toBeUndefined();
    expect(
      normalizedOpenAiUsage({
        ...raw,
        input_tokens_details: { cached_tokens: 90, cache_write_tokens: 20 }
      })
    ).toBeUndefined();
  });
  it.each([
    "insufficient_quota",
    "billing_hard_limit_reached",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "credit_balance_exhausted"
  ])(
    "distinguishes provider billing exhaustion %s from a transient rate limit",
    (code) => {
      expect(
        normalizeAiServiceError({
          status: 429,
          error: { code },
          message: "provider-private-secret"
        })
      ).toMatchObject({ code: "provider-quota" });
      expect(normalizeAiServiceError({ status: 429, code }).message).not.toContain(
        "provider-private-secret"
      );
    }
  );
  it("keeps transient retry timing and validates bounded request configuration", () => {
    expect(
      normalizeAiServiceError({
        status: 429,
        headers: new Headers({ "retry-after": "3" })
      })
    ).toMatchObject({ code: "rate-limited", retryAfterSeconds: 3 });
    expect(aiRequestLimitsFromEnv({})).toEqual({
      maxInputTokens: 100000,
      maxOutputTokens: 8192,
      timeoutMs: 60000
    });
    for (const limit of ["0", "-1", "Infinity", "128001"])
      expect(() =>
        aiRequestLimitsFromEnv({ LUMA_AI_MAX_OUTPUT_TOKENS: limit })
      ).toThrow();
  });
  it("forwards a durable budget through the public environment factory before any SDK request", async () => {
    const database = await createPgliteDatabase();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network prohibited in test"));
    try {
      const model = createOpenAIReasoningModelFromEnv(
        { OPENAI_API_KEY: "test-key" },
        { budget: createAiUsageBudget({ database, monthlyLimitUsd: 0 }) }
      );
      await expect(model.generateStructured(meetingRequest)).rejects.toMatchObject({
        code: "budget-exhausted"
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      await database.close();
    }
  });
  it.each<Capability>(["meeting", "context"])(
    "disables SDK retries and sends bounded Standard Luna requests for %s",
    async (capability) => {
      const database = await createPgliteDatabase();
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: "private provider message",
              type: "rate_limit_error",
              code: "rate_limit_exceeded"
            }
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "0",
              "x-request-id": "req_rate"
            }
          }
        )
      );
      try {
        const config = { apiKey: "test-key", budget: createAiUsageBudget({ database }) };
        const call =
          capability === "meeting"
            ? () => createOpenAIReasoningModel(config).generateStructured(meetingRequest)
            : () => createOpenAIContextAnswerer(config).answer(contextRequest);
        await expect(call()).rejects.toMatchObject({ code: "rate-limited" });
        expect(fetch).toHaveBeenCalledTimes(1);
        const options = fetch.mock.calls[0]?.[1];
        if (typeof options?.body !== "string")
          throw new Error("expected a JSON request body");
        const outbound = JSON.parse(options.body) as unknown;
        expect(outbound).toMatchObject({
          service_tier: "default",
          prompt_cache_options: { ttl: "30m" },
          max_output_tokens: 8192,
          store: false
        });
        expect(outbound).not.toHaveProperty("prompt_cache_retention");
        expect((await config.budget.getStatus("dayova")).unknownUsd).toBeGreaterThan(0);
        await expect(call()).rejects.toMatchObject({ code: "request-indeterminate" });
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        fetch.mockRestore();
        await database.close();
      }
    }
  );
});
