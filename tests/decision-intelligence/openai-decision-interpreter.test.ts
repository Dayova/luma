import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import { createAiUsageBudget } from "../../src/ai/ai-usage-budget.js";
import {
  createOpenAIDecisionInterpreter,
  type DecisionModelRequest
} from "../../src/decision-intelligence/openai-decision-interpreter.js";
import { decisionRecord } from "../knowledge/decision-record-fixture.js";
import type { DecisionInterpreter } from "../../src/decision-intelligence/ports.js";
import type { AiResponse } from "../../src/ai/ai-request.js";

let database: LumaDatabase;
beforeEach(async () => {
  database = await createPgliteDatabase();
});
afterEach(async () => {
  await database.close();
  vi.restoreAllMocks();
});
function fixture() {
  const record = decisionRecord();
  const request: Parameters<DecisionInterpreter["interpret"]>[0] = {
    workspace: { workspaceId: "dayova", timezone: "Europe/Berlin" },
    requestId: "explicit-message-1",
    requesterPersonId: "jakob",
    instruction: "Record this decision",
    source: record.source,
    authority: record.authority.snapshot,
    catalog: { id: "decisions", revision: "1", complete: true, records: [] }
  };
  const wire = {
    candidate: {
      ...record.candidate,
      relatedWorkReferenceIds: [] as string[],
      implementationReferenceIds: [] as string[]
    },
    reconciliation: { action: "create" }
  };
  const {
    relatedWork: _relatedWork,
    implementationEvidence: _implementation,
    ...candidate
  } = wire.candidate;
  void _relatedWork;
  void _implementation;
  const value = { ...wire, candidate };
  const response = (): AiResponse => ({
    outputText: JSON.stringify(value),
    model: "gpt-5.6-luna",
    serviceTier: "default",
    status: "completed",
    usage: {
      inputTokens: 100,
      cachedInputTokens: 10,
      cacheWriteTokens: 20,
      outputTokens: 10,
      reasoningTokens: 5
    },
    providerResponseId: "resp_decision",
    providerRequestId: "req_decision"
  });
  const calls: DecisionModelRequest[] = [];
  const client = {
    create: vi.fn((input: DecisionModelRequest) => {
      calls.push(input);
      return Promise.resolve(response());
    })
  };
  const budget = createAiUsageBudget({ database });
  const interpreter = createOpenAIDecisionInterpreter({ budget, client });
  return { request, value, response, calls, client, budget, interpreter };
}
describe("budgeted production DecisionInterpreter", () => {
  it.each(["decision-release", "provider-page-id"])(
    "resolves an explicit %s target to its logical Decision identity",
    async (targetRecordId) => {
      const f = fixture();
      const record = decisionRecord();
      f.request.targetRecordId = targetRecordId;
      f.request.catalog.records = [
        {
          content: record,
          version: "revision-1",
          reference: {
            providerId: "notion",
            objectType: "document",
            externalId: "provider-page-id",
            url: "https://notion.so/provider-page-id"
          }
        }
      ];
      f.client.create.mockImplementation(() =>
        Promise.resolve({
          ...f.response(),
          outputText: JSON.stringify({
            ...f.value,
            reconciliation: { action: "amend", targetRecordId: record.id }
          })
        })
      );
      expect((await f.interpreter.interpret(f.request)).reconciliation).toEqual({
        action: "amend",
        targetRecordId: record.id
      });
    }
  );
  it("returns grounded German proposal modality unchanged and accounts this capability in the shared budget", async () => {
    const f = fixture();
    f.request.source.evidence[0]!.text =
      "Wir könnten RevenueCat verwenden, aber entschieden ist das noch nicht.";
    f.value.candidate.statement.text = f.request.source.evidence[0]!.text;
    f.value.candidate.modality = "proposal";
    f.value.candidate.acceptanceEvidenceIds = [];
    f.value.candidate.disposition = "unknown";
    const result = await f.interpreter.interpret(f.request);
    expect(result.candidate).toMatchObject({
      statement: { text: f.request.source.evidence[0]!.text },
      modality: "proposal",
      acceptanceEvidenceIds: []
    });
    expect(await f.budget.getStatus("dayova")).toMatchObject({
      spentUsd: 0.0000312,
      reservedUsd: 0,
      unknownUsd: 0,
      requestCount: 1,
      byCapability: [{ capability: "decision-interpretation", requestCount: 1 }]
    });
    const telemetry = JSON.stringify(
      (await database.query("SELECT * FROM ai_usage_requests")).rows
    );
    expect(telemetry).toContain("resp_decision");
    expect(telemetry).not.toContain("RevenueCat");
    expect(telemetry).not.toContain("Record this decision");
  });
  it.each(["citation", "person", "scope", "target", "reference", "shape"])(
    "rejects an invented %s after retaining known usage",
    async (kind) => {
      const f = fixture();
      if (kind === "citation")
        f.value.candidate.statement.evidenceIds = ["unseen-evidence"];
      if (kind === "person") f.value.candidate.decisionMakerPersonIds = ["outsider"];
      if (kind === "scope") f.value.candidate.scopeId = "all-dayova";
      if (kind === "reference")
        f.value.candidate.relatedWorkReferenceIds = ["invented-task"];
      f.client.create.mockImplementation(() =>
        Promise.resolve({
          ...f.response(),
          outputText: JSON.stringify(
            kind === "target"
              ? {
                  ...f.value,
                  reconciliation: { action: "amend", targetRecordId: "invented-record" }
                }
              : kind === "shape"
                ? { ...f.value, authorized: true }
                : f.value
          )
        })
      );
      await expect(f.interpreter.interpret(f.request)).rejects.toMatchObject({
        code: "unavailable",
        requestDispatched: true
      });
      expect(await f.budget.getStatus("dayova")).toMatchObject({
        spentUsd: 0.0000312,
        unknownUsd: 0,
        requestCount: 1
      });
    }
  );
  it("keeps missing context and the monthly limit ahead of any provider attempt", async () => {
    const f = fixture();
    await expect(
      f.interpreter.interpret({
        ...f.request,
        catalog: { ...f.request.catalog, complete: false }
      })
    ).rejects.toMatchObject({ requestDispatched: false });
    const capped = createOpenAIDecisionInterpreter({
      budget: createAiUsageBudget({ database, monthlyLimitUsd: 0 }),
      client: f.client
    });
    await expect(capped.interpret(f.request)).rejects.toMatchObject({
      code: "budget-exhausted",
      requestDispatched: false
    });
    expect(f.client.create).not.toHaveBeenCalled();
  });
  it("refuses oversized input without reserving or dispatching a charge", async () => {
    const f = fixture();
    const bounded = createOpenAIDecisionInterpreter({
      budget: f.budget,
      client: f.client,
      limits: { maxInputTokens: 100 }
    });
    await expect(bounded.interpret(f.request)).rejects.toMatchObject({
      code: "request-too-large",
      requestDispatched: false
    });
    expect(f.client.create).not.toHaveBeenCalled();
    expect(await f.budget.getStatus("dayova")).toMatchObject({ requestCount: 0 });
  });
  it("retains an uncertain charge after timeout and refuses a duplicate attempt", async () => {
    const f = fixture();
    f.client.create.mockImplementation(() => new Promise<AiResponse>(() => {}));
    const bounded = createOpenAIDecisionInterpreter({
      budget: f.budget,
      client: f.client,
      limits: { timeoutMs: 5 }
    });
    await expect(bounded.interpret(f.request)).rejects.toMatchObject({ code: "timeout" });
    expect((await f.budget.getStatus("dayova")).unknownUsd).toBeGreaterThan(0);
    await expect(bounded.interpret(f.request)).rejects.toMatchObject({
      code: "request-indeterminate"
    });
    expect(f.client.create).toHaveBeenCalledTimes(1);
  });
  it("uses the actual Responses SDK without tools, storage, retries or an unpriced tier", async () => {
    const f = fixture();
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON SDK body");
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "resp_native_decision",
            object: "response",
            created_at: 1,
            model: "gpt-5.6-luna",
            status: "completed",
            service_tier: "default",
            output: [
              {
                id: "message",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [
                  { type: "output_text", text: JSON.stringify(f.value), annotations: [] }
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
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    });
    const native = createOpenAIDecisionInterpreter({
      budget: f.budget,
      apiKey: "test-only-not-real"
    });
    expect((await native.interpret(f.request)).candidate?.statement.text).toBe(
      f.value.candidate.statement.text
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      store: false,
      service_tier: "default",
      model: "gpt-5.6-luna",
      text: {
        format: {
          type: "json_schema",
          strict: true,
          name: "LumaDecisionInterpretation",
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["candidate", "reconciliation"]
          }
        }
      }
    });
    expect(bodies[0]).not.toHaveProperty("tools");
    fetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: "Synthetic temporary failure" } }),
          { status: 500, headers: { "content-type": "application/json" } }
        )
      )
    );
    await expect(
      native.interpret({ ...f.request, requestId: "next-message" })
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
