import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import { createAiUsageBudget } from "../../src/ai/ai-usage-budget.js";
import type { AiResponse } from "../../src/ai/ai-request.js";
import type { StructuredWorkModelInput } from "../../src/domain/structured-work.js";
import {
  createOpenAIStructuredWorkInterpreter,
  type StructuredWorkModelRequest
} from "../../src/structured-work/openai-structured-work-interpreter.js";
import {
  recordSchema,
  sourceFixture,
  workspace,
  structuredWorkFixture,
  title
} from "./fixture.js";

let database: LumaDatabase;
beforeEach(async () => {
  database = await createPgliteDatabase();
});
afterEach(async () => {
  await database.close();
  vi.restoreAllMocks();
});
function fixture() {
  const request: StructuredWorkModelInput = {
    requestId: "command",
    workspace,
    instruction: sourceFixture().evidence.at(-1)!.text,
    requesterPersonId: "jakob",
    source: sourceFixture(),
    records: {
      schema: structuredClone(recordSchema),
      records: [],
      complete: true,
      revision: "1"
    },
    work: []
  };
  const wire = {
    targetKey: "hypotheses",
    record: {
      fields: [{ key: "hypothesis", value: { type: "text", value: title } }],
      evidenceIds: ["e0"],
      reconciliation: { action: "create" }
    },
    work: {
      title: "Validate flexible learning times",
      description:
        "Gather student feedback and compare the findings with this hypothesis.",
      evidenceIds: ["e0", "e4", "e5"],
      ownership: { status: "confirmed", personId: "jakob", evidenceIds: ["e4", "e5"] },
      reconciliation: { action: "create" }
    }
  };
  const response = (): AiResponse => ({
    outputText: JSON.stringify(wire),
    model: "gpt-5.6-luna",
    serviceTier: "default",
    status: "completed",
    providerResponseId: "resp_structured",
    usage: {
      inputTokens: 100,
      cachedInputTokens: 10,
      cacheWriteTokens: 20,
      outputTokens: 10,
      reasoningTokens: 5
    }
  });
  const create = vi.fn<(request: StructuredWorkModelRequest) => Promise<AiResponse>>(() =>
    Promise.resolve(response())
  );
  const budget = createAiUsageBudget({ database });
  const interpreter = createOpenAIStructuredWorkInterpreter({
    budget,
    client: { create }
  });
  const access = { requireCurrent: vi.fn(() => Promise.resolve()) };
  return { request, wire, response, create, budget, interpreter, access };
}
function withLargeCatalog(request: StructuredWorkModelInput) {
  request.work = Array.from({ length: 396 }, (_, index) => ({
    id: `DAY-${index + 1}`,
    providerId: "linear",
    externalId: `issue-${index + 1}`,
    title: `Preserved validation scope ${index + 1}`,
    description: `Original independent requirements for issue ${index + 1}. ${"Measure student feedback and preserve the previous evidence. ".repeat(10)}`,
    status: "completed" as const,
    assignees: [],
    dueDate: null,
    labels: [],
    projectId: null,
    parentId: null,
    url: `https://linear.app/dayova/issue/DAY-${index + 1}`,
    updatedAt: "2026-09-11T12:00:00.000Z"
  }));
  return request;
}
describe("production structured-work interpreter and shared budget", () => {
  it("grounds the hypothesis and separate validation work, preserves source language and accounts the capability", async () => {
    const f = fixture();
    f.request.source.evidence[0]!.text =
      "Wir könnten flexiblere Lernzeiten testen. Bisher ist die Hypothese nicht bestätigt.";
    f.wire.record.fields[0]!.value.value = "Flexiblere Lernzeiten könnten helfen";
    expect(await f.interpreter.interpret(f.request, f.access)).toMatchObject({
      record: {
        fields: {
          hypothesis: { type: "text", value: f.wire.record.fields[0]!.value.value }
        }
      },
      work: { ownership: { personId: "jakob" } }
    });
    expect(await f.budget.getStatus("dayova")).toMatchObject({
      requestCount: 1,
      unknownUsd: 0,
      reservedUsd: 0,
      byCapability: [{ capability: "structured-work-interpretation", requestCount: 1 }]
    });
    const telemetry = JSON.stringify(
      (await database.query("SELECT * FROM ai_usage_requests")).rows
    );
    expect(telemetry).not.toContain("Flexiblere");
    expect(telemetry).not.toContain(f.request.instruction);
  });
  it.each([
    "target",
    "field",
    "choice",
    "duplicate-field",
    "evidence",
    "person",
    "record-match",
    "work-match"
  ])("rejects invented %s with settled actual usage", async (kind) => {
    const f = fixture();
    if (kind === "target") f.wire.targetKey = "another-table";
    if (kind === "field") f.wire.record.fields[0]!.key = "new-property";
    if (kind === "choice")
      f.wire.record.fields.push({
        key: "status",
        value: { type: "choice", value: "Invented option" }
      });
    if (kind === "duplicate-field")
      f.wire.record.fields.push(structuredClone(f.wire.record.fields[0]!));
    if (kind === "evidence") f.wire.work.evidenceIds = ["unseen"];
    if (kind === "person") f.wire.work.ownership.personId = "guest";
    f.create.mockImplementation(() =>
      Promise.resolve({
        ...f.response(),
        outputText: JSON.stringify(
          kind === "record-match"
            ? {
                ...f.wire,
                record: {
                  ...f.wire.record,
                  reconciliation: { action: "link", targetId: "unknown" }
                }
              }
            : kind === "work-match"
              ? {
                  ...f.wire,
                  work: {
                    ...f.wire.work,
                    reconciliation: { action: "link", targetId: "unknown" }
                  }
                }
              : f.wire
        )
      })
    );
    await expect(f.interpreter.interpret(f.request, f.access)).rejects.toMatchObject({
      code: "unavailable",
      requestDispatched: true
    });
    expect(await f.budget.getStatus("dayova")).toMatchObject({
      requestCount: 1,
      unknownUsd: 0
    });
  });
  it("keeps incomplete context, oversized requests and the monthly limit ahead of native dispatch", async () => {
    const f = fixture();
    await expect(
      f.interpreter.interpret(
        { ...f.request, records: { ...f.request.records, complete: false } },
        f.access
      )
    ).rejects.toMatchObject({ requestDispatched: false });
    await expect(
      createOpenAIStructuredWorkInterpreter({
        budget: f.budget,
        client: { create: f.create },
        limits: { maxInputTokens: 100 }
      }).interpret(f.request, f.access)
    ).rejects.toMatchObject({ code: "request-too-large" });
    await expect(
      createOpenAIStructuredWorkInterpreter({
        budget: createAiUsageBudget({ database, monthlyLimitUsd: 0 }),
        client: { create: f.create }
      }).interpret(f.request, f.access)
    ).rejects.toMatchObject({ code: "budget-exhausted", requestDispatched: false });
    expect(f.create).not.toHaveBeenCalled();
    expect((await f.budget.getStatus("dayova")).requestCount).toBe(0);
  });
  it("blocks disclosure if the admitted original grant is revoked during budget reservation", async () => {
    const f = fixture();
    let granted = true;
    const interpreter = createOpenAIStructuredWorkInterpreter({
      budget: {
        ...f.budget,
        reserve: async (input) => {
          const value = await f.budget.reserve(input);
          granted = false;
          return value;
        }
      },
      client: { create: f.create }
    });
    await expect(
      interpreter.interpret(f.request, {
        requireCurrent: () =>
          granted ? Promise.resolve() : Promise.reject(new Error("revoked"))
      })
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(f.create).not.toHaveBeenCalled();
    expect(await f.budget.getStatus("dayova")).toMatchObject({
      unknownUsd: 0,
      spentUsd: 0,
      reservedUsd: 0,
      requestCount: 1
    });
  });
  it("refuses a late admission proof after its deadline without making a paid call", async () => {
    const f = fixture();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const interpreter = createOpenAIStructuredWorkInterpreter({
      budget: f.budget,
      client: { create: f.create },
      limits: { timeoutMs: 5 }
    });
    await expect(
      interpreter.interpret(f.request, { requireCurrent: () => gate })
    ).rejects.toMatchObject({ code: "timeout", requestDispatched: false });
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.create).not.toHaveBeenCalled();
    expect(await f.budget.getStatus("dayova")).toMatchObject({
      unknownUsd: 0,
      spentUsd: 0,
      reservedUsd: 0,
      requestCount: 1
    });
  });
  it("retains an uncertain timed-out attempt without repeating it", async () => {
    const f = fixture();
    f.create.mockImplementation(() => new Promise(() => {}));
    const interpreter = createOpenAIStructuredWorkInterpreter({
      budget: f.budget,
      client: { create: f.create },
      limits: { timeoutMs: 5 }
    });
    await expect(interpreter.interpret(f.request, f.access)).rejects.toMatchObject({
      code: "timeout"
    });
    await expect(interpreter.interpret(f.request, f.access)).rejects.toMatchObject({
      code: "request-indeterminate"
    });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect((await f.budget.getStatus("dayova")).unknownUsd).toBeGreaterThan(0);
  });
  it("executes the provided hypothesis fixture through MI and the actual model adapter, then replays without another paid attempt", async () => {
    const f = fixture(),
      core = structuredWorkFixture(database);
    core.configuration.interpreter = f.interpreter;
    const { mi, execution } = core.make();
    const first = await mi.observe(core.request);
    expect(first.state).toBe("validated");
    const result = await execution.execute({
      workspace,
      subject: core.request.subject,
      structuredWorkRequestId: first.requestId,
      intentId: first.approvedIntentId!
    });
    expect(result.state).toBe("completed");
    const recreated = core.make();
    expect((await recreated.mi.observe(core.request)).duplicate).toBe(true);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(core.createRecord).toHaveBeenCalledTimes(1);
    expect(core.createIssue).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    "uses the real SDK and identical count/generation context when a large catalog is %s",
    async (large) => {
      const f = fixture();
      if (large) withLargeCatalog(f.request);
      let body: Record<string, unknown> | null = null;
      let counted: Record<string, unknown> | null = null;
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
        if (typeof init?.body !== "string") throw new Error("Expected native JSON body");
        body = JSON.parse(init.body) as Record<string, unknown>;
        const requestUrl =
          url instanceof Request ? url.url : url instanceof URL ? url.href : url;
        if (requestUrl.endsWith("/responses/input_tokens")) {
          counted = body;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                object: "response.input_tokens",
                input_tokens: 75_000
              }),
              { headers: { "content-type": "application/json" } }
            )
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "resp_native_structured",
              object: "response",
              created_at: 1,
              model: "gpt-5.6-luna",
              status: "completed",
              service_tier: "default",
              output: [
                {
                  id: "msg",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [
                    { type: "output_text", text: JSON.stringify(f.wire), annotations: [] }
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
                "x-request-id": "req_native_structured"
              }
            }
          )
        );
      });
      await createOpenAIStructuredWorkInterpreter({
        apiKey: "test-only",
        budget: f.budget
      }).interpret(f.request, f.access);
      expect(body).toMatchObject({
        store: false,
        service_tier: "default",
        text: { format: { type: "json_schema", strict: true } }
      });
      expect(body).not.toHaveProperty("tools");
      if (large) {
        expect(counted).toMatchObject({
          model: body!["model"],
          instructions: body!["instructions"],
          input: body!["input"],
          text: body!["text"]
        });
        const sent = JSON.parse(body!["input"] as string) as StructuredWorkModelInput;
        expect(sent.work).toEqual(f.request.work);
        expect(sent.work).toHaveLength(396);
      } else expect(counted).toBeNull();
      const checkObjects = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          value.forEach(checkObjects);
          return;
        }
        const object = value as Record<string, unknown>;
        if (object["type"] === "object")
          expect(object["additionalProperties"]).toBe(false);
        Object.values(object).forEach(checkObjects);
      };
      checkObjects(body);
      expect(fetch).toHaveBeenCalledTimes(large ? 2 : 1);
      expect(await f.budget.getStatus("dayova")).toMatchObject({
        requestCount: 1,
        unknownUsd: 0
      });
    }
  );
  it.each([0, -1, 2.5, NaN, 100_001])(
    "does not generate on an invalid or excessive native count %s",
    async (count) => {
      const f = fixture();
      const countInputTokens = vi.fn(() => Promise.resolve(count));
      const interpreter = createOpenAIStructuredWorkInterpreter({
        budget: f.budget,
        client: { create: f.create, countInputTokens }
      });
      await expect(
        interpreter.interpret(withLargeCatalog(f.request), f.access)
      ).rejects.toMatchObject({ code: "request-too-large", requestDispatched: false });
      expect(f.create).not.toHaveBeenCalled();
      expect(await f.budget.getStatus("dayova")).toMatchObject({
        requestCount: 1,
        unknownUsd: 0,
        spentUsd: 0,
        reservedUsd: 0
      });
    }
  );
  it("admits neither counting nor generation when the budget or original grant refuses disclosure", async () => {
    const f = fixture();
    const countInputTokens = vi.fn(() => Promise.resolve(75_000));
    const request = withLargeCatalog(f.request);
    await expect(
      createOpenAIStructuredWorkInterpreter({
        budget: createAiUsageBudget({ database, monthlyLimitUsd: 0 }),
        client: { create: f.create, countInputTokens }
      }).interpret(request, f.access)
    ).rejects.toMatchObject({ code: "budget-exhausted" });
    await expect(
      createOpenAIStructuredWorkInterpreter({
        budget: f.budget,
        client: { create: f.create, countInputTokens }
      }).interpret(request, {
        requireCurrent: () => Promise.reject(new Error("revoked"))
      })
    ).rejects.toMatchObject({ requestDispatched: false });
    expect(countInputTokens).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
  it("reproves original access after counting without disclosing a revoked request to generation", async () => {
    const f = fixture();
    let granted = true;
    const countInputTokens = vi.fn(() => {
      granted = false;
      return Promise.resolve(75_000);
    });
    const interpreter = createOpenAIStructuredWorkInterpreter({
      budget: f.budget,
      client: { create: f.create, countInputTokens }
    });
    await expect(
      interpreter.interpret(withLargeCatalog(f.request), {
        requireCurrent: () =>
          granted ? Promise.resolve() : Promise.reject(new Error("revoked"))
      })
    ).rejects.toMatchObject({ requestDispatched: false });
    expect(countInputTokens).toHaveBeenCalledTimes(1);
    expect(f.create).not.toHaveBeenCalled();
    expect(await f.budget.getStatus("dayova")).toMatchObject({
      unknownUsd: 0,
      spentUsd: 0
    });
  });
  it("cannot generate after a token count settles beyond its admission deadline", async () => {
    const f = fixture();
    let release!: (count: number) => void;
    const pending = new Promise<number>((resolve) => {
      release = resolve;
    });
    const countInputTokens = vi.fn(() => pending);
    const interpreter = createOpenAIStructuredWorkInterpreter({
      budget: f.budget,
      limits: { timeoutMs: 10 },
      client: { create: f.create, countInputTokens }
    });
    await expect(
      interpreter.interpret(withLargeCatalog(f.request), f.access)
    ).rejects.toMatchObject({ code: "timeout", requestDispatched: false });
    release(75_000);
    await pending;
    await Promise.resolve();
    expect(f.create).not.toHaveBeenCalled();
    expect(await f.budget.getStatus("dayova")).toMatchObject({
      unknownUsd: 0,
      spentUsd: 0
    });
  });
  it("retains the serialized input bound before counting and reservation", async () => {
    const f = fixture();
    withLargeCatalog(f.request);
    f.request.work[0]!.description = "x".repeat(1_048_576);
    const countInputTokens = vi.fn(() => Promise.resolve(75_000));
    await expect(
      createOpenAIStructuredWorkInterpreter({
        budget: f.budget,
        client: { create: f.create, countInputTokens }
      }).interpret(f.request, f.access)
    ).rejects.toMatchObject({ code: "request-too-large" });
    expect(countInputTokens).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect((await f.budget.getStatus("dayova")).requestCount).toBe(0);
  });
});
