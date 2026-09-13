import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  candidates,
  ComparisonError,
  createComparisonReasoningModel,
  defaultLimits,
  comparisonPayload,
  candidateKey,
  googleEndpoint,
  type GoogleEndpoint,
  type Candidate,
  type ResponseFacts,
  type Transport
} from "../../src/evaluation/provider-comparison/providers.js";
import {
  corpusSchema,
  requestForFixture,
  scoreProposal
} from "../../src/evaluation/provider-comparison/corpus.js";
import {
  runComparison,
  renderReport
} from "../../src/evaluation/provider-comparison/runner.js";
import type { MeetingAnalysisProposalBatch } from "../../src/ai/reasoning-model.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";

const corpus = corpusSchema.parse(
  JSON.parse(readFileSync("evals/fixtures/provider-comparison.json", "utf8")) as unknown
);
const fixture = corpus.fixtures[0]!;
const request = requestForFixture(fixture);
const empty: MeetingAnalysisProposalBatch = {
  actionItems: [],
  decisions: [],
  openQuestions: [],
  risks: [],
  followUpIntentions: []
};
function proposal(
  evidenceId = request.evidence[0]!.evidenceId
): MeetingAnalysisProposalBatch {
  return {
    ...empty,
    actionItems: [
      {
        stableKey: "export",
        description: "Export-Fix fertigstellen",
        ownerId: "person_alex",
        dueDate: {
          originalPhrase: "morgen",
          normalizedDate: "2026-09-11",
          confidence: "normalized",
          timezone: "Europe/Berlin"
        },
        status: "confirmed",
        relatedDecisionIds: [],
        evidenceIds: [evidenceId],
        confidence: "high"
      }
    ]
  };
}
function wire(
  candidate: Candidate,
  output: unknown = proposal(),
  complete = true,
  knownUsage = true
) {
  const text = JSON.stringify(output);
  switch (candidate.id) {
    case "openai":
      return {
        model: candidate.model,
        id: "response_test",
        status: complete ? "completed" : "incomplete",
        output: [{ type: "message", content: [{ type: "output_text", text }] }],
        ...(knownUsage
          ? {
              usage: {
                input_tokens: 100,
                output_tokens: 30,
                output_tokens_details: { reasoning_tokens: 10 }
              }
            }
          : {})
      };
    case "anthropic":
      return {
        model: candidate.model,
        id: "response_test",
        stop_reason: complete ? "end_turn" : "max_tokens",
        content: [
          { type: "thinking", thinking: "not persisted" },
          { type: "text", text }
        ],
        ...(knownUsage
          ? {
              usage: {
                input_tokens: 70,
                cache_read_input_tokens: 20,
                cache_creation_input_tokens: 10,
                output_tokens: 30
              }
            }
          : {})
      };
    case "google":
      return {
        modelVersion: candidate.model,
        responseId: "response_test",
        candidates: [
          {
            finishReason: complete ? "STOP" : "MAX_TOKENS",
            content: { parts: [{ thought: true, text: "not persisted" }, { text }] }
          }
        ],
        ...(knownUsage
          ? {
              usageMetadata: {
                promptTokenCount: 100,
                candidatesTokenCount: 20,
                thoughtsTokenCount: 10
              }
            }
          : {})
      };
    case "deepseek":
      return {
        model: candidate.model,
        id: "response_test",
        choices: [
          {
            finish_reason: complete ? "stop" : "length",
            message: { content: text, reasoning_content: "not persisted" }
          }
        ],
        ...(knownUsage
          ? {
              usage: {
                prompt_tokens: 100,
                completion_tokens: 30,
                completion_tokens_details: { reasoning_tokens: 10 }
              }
            }
          : {})
      };
  }
}
function fake(
  candidate: Candidate,
  output: unknown = proposal(),
  complete = true,
  knownUsage = true
): Transport {
  return () =>
    Promise.resolve(Response.json(wire(candidate, output, complete, knownUsage)));
}

describe("provider comparison adapters", () => {
  it.each(candidates)(
    "normalizes $id usage and preserves proposal/evidence through the owned port",
    async (candidate) => {
      const facts: ResponseFacts[] = [];
      const model = createComparisonReasoningModel({
        candidate,
        apiKey: "test-only",
        limits: defaultLimits,
        transport: fake(candidate),
        onResponse: (f) => facts.push(f)
      });
      const result = await model.generateStructured(request);
      expect(result.value).toEqual(proposal());
      expect(result.metadata.provider).toBe(candidate.id);
      expect(facts[0]?.usage).toMatchObject({ inputTokens: 100, outputTokens: 30 });
      expect(facts[0]?.estimatedUncachedCostUsd).toBe(
        (100 * candidate.inputRate + 30 * candidate.outputRate) / 1_000_000
      );
      expect(JSON.stringify(facts)).not.toContain("not persisted");
    }
  );
  it.each(candidates)(
    "retains $id accounting on truncated output and rejects partial answers",
    async (candidate) => {
      const facts: ResponseFacts[] = [];
      const model = createComparisonReasoningModel({
        candidate,
        apiKey: "test-only",
        limits: defaultLimits,
        transport: fake(candidate, proposal(), false),
        onResponse: (f) => facts.push(f)
      });
      await expect(model.generateStructured(request)).rejects.toMatchObject({
        code: "incomplete-or-refused"
      });
      expect(facts[0]?.usage?.outputTokens).toBe(30);
    }
  );
  it.each(candidates)(
    "rejects invented evidence from $id and keeps usage unknown when absent",
    async (candidate) => {
      const facts: ResponseFacts[] = [];
      const model = createComparisonReasoningModel({
        candidate,
        apiKey: "test-only",
        limits: defaultLimits,
        transport: fake(candidate, proposal("invented-id"), true, false),
        onResponse: (f) => facts.push(f)
      });
      await expect(model.generateStructured(request)).rejects.toMatchObject({
        code: "unknown-evidence"
      });
      expect(facts[0]?.usage).toBeNull();
      expect(facts[0]?.estimatedUncachedCostUsd).toBeNull();
    }
  );
  it.each(candidates)(
    "enforces output bounds and authenticates $id without putting the key in its URL",
    async (candidate) => {
      const transport = vi.fn<Transport>((url, init) => {
        expect(url).not.toContain("secret");
        expect(init.redirect).toBe("error");
        if (typeof init.body !== "string") throw new Error("Expected JSON body");
        const body = JSON.parse(init.body) as Record<string, unknown>;
        const generation = body["generationConfig"] as
          Record<string, unknown> | undefined;
        expect(
          body["max_tokens"] ??
            body["max_output_tokens"] ??
            generation?.["maxOutputTokens"]
        ).toBe(4096);
        expect(init.body).toContain(request.evidence[0]!.excerpt);
        return fake(candidate)(url, init);
      });
      await createComparisonReasoningModel({
        candidate,
        apiKey: "secret",
        limits: defaultLimits,
        transport,
        onResponse: () => {}
      }).generateStructured(request);
      expect(transport).toHaveBeenCalledTimes(1);
    }
  );
  it("bounds input before dispatch and never retries or exposes HTTP response bodies", async () => {
    const transport = vi.fn<Transport>(() =>
      Promise.resolve(new Response("secret echoed prompt", { status: 401 }))
    );
    const create = (maxInputBytes: number) =>
      createComparisonReasoningModel({
        candidate: candidates[0],
        apiKey: "test",
        limits: { ...defaultLimits, maxInputBytes },
        transport,
        onResponse: () => {}
      });
    await expect(create(10).generateStructured(request)).rejects.toMatchObject({
      code: "input-limit"
    });
    expect(transport).not.toHaveBeenCalled();
    await expect(create(32_000).generateStructured(request)).rejects.toThrow("http-401");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("times out even if the transport ignores cancellation", async () => {
    const model = createComparisonReasoningModel({
      candidate: candidates[0],
      apiKey: "test",
      limits: { ...defaultLimits, timeoutMs: 10 },
      transport: () => new Promise(() => {}),
      onResponse: () => {}
    });
    await expect(model.generateStructured(request)).rejects.toMatchObject({
      code: "timeout-usage-unknown"
    });
  });
  it("retains usage for schema failures", async () => {
    const facts: ResponseFacts[] = [];
    const model = createComparisonReasoningModel({
      candidate: candidates[0],
      apiKey: "test",
      limits: defaultLimits,
      transport: fake(candidates[0], { hallucinated: true }),
      onResponse: (f) => facts.push(f)
    });
    await expect(model.generateStructured(request)).rejects.toMatchObject({
      code: "invalid-json-or-schema"
    });
    expect(facts[0]?.usage?.inputTokens).toBe(100);
  });
  it("works through Meeting Intelligence and keeps source evidence idempotent", async () => {
    const database = await createPgliteDatabase();
    const evidenceId = "evidence:transcript:utterance_export:v1";
    const transport = vi.fn(fake(candidates[1], proposal(evidenceId)));
    const intelligence = createMeetingIntelligence({
      database,
      reasoningModel: createComparisonReasoningModel({
        candidate: candidates[1],
        apiKey: "test",
        limits: defaultLimits,
        transport,
        onResponse: () => {}
      })
    });
    const input = {
      workspace: { workspaceId: "workspace_eval", timezone: "Europe/Berlin" },
      observations: [
        {
          type: "utterance-committed" as const,
          observationId: "obs_export",
          workspaceId: "workspace_eval",
          meetingId: "meeting_eval",
          occurredAt: fixture.occurredAt,
          observedAt: fixture.occurredAt,
          utteranceId: "utterance_export",
          version: 1,
          speaker: {
            status: "attributed" as const,
            personId: "person_alex",
            confidence: "deterministic" as const,
            basis: "provider-identity" as const
          },
          startedAt: fixture.occurredAt,
          endedAt: fixture.occurredAt,
          originalText: fixture.utterances[0]!.text,
          language: "de" as const
        }
      ]
    };
    try {
      const result = await intelligence.observe(input);
      expect(result.analysisStatus).toBe("completed");
      const replay = await intelligence.observe(input);
      expect(replay.duplicateObservationIds).toEqual(["obs_export"]);
      expect(transport).toHaveBeenCalledTimes(1);
      const snapshot = await intelligence.query({
        workspaceId: "workspace_eval",
        meetingId: "meeting_eval",
        query: { type: "snapshot" }
      });
      expect(snapshot.type).toBe("snapshot");
      expect(JSON.stringify(snapshot)).toContain("Export-Fix");
      expect(JSON.stringify(snapshot)).toContain("anthropic");
    } finally {
      await database.close();
    }
  });
});

describe("comparison evaluation integrity", () => {
  it("does not send labels to models, and detects wrong owners, dates, and empty extraction", () => {
    expect(scoreProposal(fixture, proposal()).every((c) => c.passed)).toBe(true);
    const wrong = proposal();
    wrong.actionItems[0]!.ownerId = "person_sam";
    wrong.actionItems[0]!.dueDate.normalizedDate = "2026-09-12";
    expect(
      scoreProposal(fixture, wrong)
        .filter((c) => !c.passed)
        .map((c) => c.dimension)
    ).toEqual(["ownership", "deadline"]);
    expect(scoreProposal(fixture, empty).every((c) => !c.passed)).toBe(true);
    const payload = comparisonPayload(request);
    expect(payload.input).not.toContain("checks");
    expect(payload.input).not.toContain("manualReview");
  });
  it("does not count unrun or missing-credential rows as successful evaluation", async () => {
    const factory = vi.fn();
    const report = await runComparison({
      corpus,
      env: {},
      live: true,
      maxRequests: 4,
      repeats: 1,
      gitRevision: "test",
      selected: candidates,
      modelFactory: factory
    });
    expect(factory).not.toHaveBeenCalled();
    expect(report.rows).toHaveLength(corpus.fixtures.length * candidates.length);
    expect(
      report.rows.every((r) => r.status === "missing-credential" && r.checks === null)
    ).toBe(true);
    expect(renderReport(report)).toContain("not measured");
    const preflight = await runComparison({
      corpus,
      env: { OPENAI_API_KEY: "test" },
      live: false,
      maxRequests: 4,
      repeats: 1,
      gitRevision: "test",
      selected: candidates,
      modelFactory: factory
    });
    expect(factory).not.toHaveBeenCalled();
    expect(preflight.rows[0]?.status).toBe("not-run");
  });
  it("runs matched cases across providers before moving on, journals first, and enforces request caps", async () => {
    const events: string[] = [];
    const env = Object.fromEntries(candidates.map((c) => [c.key, "test"]));
    const report = await runComparison({
      corpus,
      env,
      live: true,
      maxRequests: 4,
      repeats: 2,
      gitRevision: "test",
      selected: candidates,
      beforeRequest: (row) => {
        events.push(`journal:${row.provider}`);
        return Promise.resolve();
      },
      modelFactory: (candidate, apiKey, onResponse) =>
        createComparisonReasoningModel({
          candidate,
          apiKey,
          limits: defaultLimits,
          onResponse,
          transport: (url, init) => {
            events.push(`request:${candidate.id}`);
            return fake(candidate)(url, init);
          }
        })
    });
    expect(events).toEqual(
      candidates.flatMap((c) => [`journal:${c.id}`, `request:${c.id}`])
    );
    expect(report.rows.filter((r) => r.status === "completed")).toHaveLength(4);
    expect(report.rows.filter((r) => r.status === "request-limit")).toHaveLength(
      corpus.fixtures.length * candidates.length * 2 - 4
    );
    expect(new Set(report.rows.slice(0, 4).map((r) => r.requestHash)).size).toBe(1);
  });
  it("rejects invalid limits without invoking providers", async () => {
    await expect(
      runComparison({
        corpus,
        env: {},
        live: true,
        maxRequests: NaN,
        repeats: 1,
        gitRevision: "test",
        selected: candidates
      })
    ).rejects.toBeInstanceOf(ComparisonError);
  });
});

describe("Google hosting configuration", () => {
  const google = candidates.find((c) => c.id === "google")!;

  it("keeps the full model request identical across Developer API and Vertex routes", async () => {
    const endpoints: GoogleEndpoint[] = [
      { backend: "developer" },
      { backend: "vertex" },
      { backend: "vertex", projectId: "luma-evaluation" }
    ];
    const sent: { url: string; body: string }[] = [];
    for (const endpoint of endpoints) {
      const model = createComparisonReasoningModel({
        candidate: google,
        apiKey: "test-secret",
        limits: defaultLimits,
        googleEndpoint: endpoint,
        onResponse: () => {},
        transport: (url, init) => {
          if (typeof init.body !== "string") throw new Error("expected JSON");
          sent.push({ url, body: init.body });
          expect(new Headers(init.headers).get("x-goog-api-key")).toBe("test-secret");
          expect(url).not.toContain("test-secret");
          expect(init.redirect).toBe("error");
          return Promise.resolve(new Response(JSON.stringify(wire(google))));
        }
      });
      expect((await model.generateStructured(request)).value).toEqual(proposal());
    }
    expect(new Set(sent.map((s) => s.body)).size).toBe(1);
    expect(sent.map((s) => s.url)).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
      "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:generateContent",
      "https://aiplatform.googleapis.com/v1/projects/luma-evaluation/locations/global/publishers/google/models/gemini-3.8-flash:generateContent"
    ]);
  });

  it("uses only the selected backend's credential and records Vertex in preflight", async () => {
    const env = { LUMA_EVAL_GOOGLE_BACKEND: "vertex", GEMINI_API_KEY: "developer-key" };
    expect(candidateKey(google, env)).toBeUndefined();
    expect(candidateKey(google, { ...env, VERTEX_API_KEY: "vertex-key" })).toBe(
      "vertex-key"
    );
    expect(
      candidateKey(google, {
        GEMINI_API_KEY: "developer-key",
        VERTEX_API_KEY: "vertex-key"
      })
    ).toBe("developer-key");
    const report = await runComparison({
      corpus,
      env,
      live: false,
      maxRequests: 1,
      repeats: 1,
      gitRevision: "test",
      selected: [google]
    });
    expect(report.rows.every((r) => r.status === "missing-credential")).toBe(true);
    expect(report.googleEndpoint).toEqual({ backend: "vertex" });
    expect(report.googlePricingSource).toContain("cloud.google.com");
    expect(renderReport(report)).toContain("vertex (express, global)");
  });

  it("rejects invalid backends and project paths before sending credentials", () => {
    expect(() => googleEndpoint({ LUMA_EVAL_GOOGLE_BACKEND: "typo" })).toThrow(
      "invalid-google-backend"
    );
    expect(() =>
      googleEndpoint({
        LUMA_EVAL_GOOGLE_BACKEND: "vertex",
        VERTEX_PROJECT_ID: "../another-project"
      })
    ).toThrow("invalid-vertex-project");
  });
});

describe("Anthropic explicit prompt JSON mode", () => {
  it("keeps the complete contract and validates output without a native grammar or retries", async () => {
    const anthropic = candidates.find((c) => c.id === "anthropic")!;
    let requests = 0;
    const model = createComparisonReasoningModel({
      candidate: anthropic,
      apiKey: "test-key",
      limits: defaultLimits,
      anthropicOutputMode: "prompt-json",
      onResponse: () => {},
      transport: (_url, init) => {
        requests++;
        if (typeof init.body !== "string") throw new Error("expected JSON body");
        const body = JSON.parse(init.body) as {
          output_config: { format?: unknown; effort: string };
          system: string;
        };
        expect(body.output_config.format).toBeUndefined();
        expect(body.output_config.effort).toBe("medium");
        expect(body.system).toBe(comparisonPayload(request).instructions);
        return Promise.resolve(
          new Response(
            JSON.stringify(
              wire(anthropic, requests === 1 ? proposal() : { actionItems: [] })
            )
          )
        );
      }
    });
    expect((await model.generateStructured(request)).value).toEqual(proposal());
    await expect(model.generateStructured(request)).rejects.toThrow(
      "invalid-json-or-schema"
    );
    expect(requests).toBe(2);
  });
});
