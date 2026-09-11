import { createHash } from "node:crypto";
import { z } from "zod";
import {
  meetingAnalysisJsonSchema,
  meetingAnalysisSchema,
  MEETING_INTELLIGENCE_INSTRUCTIONS
} from "../../ai/meeting-analysis-contract.js";
import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel,
  StructuredReasoningRequest
} from "../../ai/reasoning-model.js";

export const candidates = [
  {
    id: "openai",
    model: "gpt-5.6-luna",
    key: "OPENAI_API_KEY",
    inputRate: 0.2,
    outputRate: 1.2,
    pricing: "https://developers.openai.com/api/docs/models/gpt-5.6-luna"
  },
  {
    id: "anthropic",
    model: "claude-sonnet-5",
    key: "ANTHROPIC_API_KEY",
    inputRate: 2,
    outputRate: 10,
    pricing: "https://platform.claude.com/docs/en/about-claude/pricing"
  },
  {
    id: "google",
    model: "gemini-3.8-flash",
    key: "GEMINI_API_KEY",
    inputRate: 0.75,
    outputRate: 3.75,
    pricing: "https://ai.google.dev/gemini-api/docs/pricing"
  },
  {
    id: "deepseek",
    model: "deepseek-flash",
    key: "DEEPSEEK_API_KEY",
    inputRate: 0.3,
    outputRate: 1.2,
    pricing: "https://api-docs.deepseek.com/quick_start/pricing/"
  }
] as const;
export type Candidate = (typeof candidates)[number];
export type ProviderId = Candidate["id"];
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
};
export type ResponseFacts = {
  returnedModel: string | null;
  responseId: string | null;
  finishReason: string | null;
  usage: Usage | null;
  estimatedUncachedCostUsd: number | null;
};
export type Transport = (url: string, init: RequestInit) => Promise<Response>;
export type Limits = {
  maxOutputTokens: number;
  timeoutMs: number;
  maxInputBytes: number;
};
export const defaultLimits: Limits = {
  maxOutputTokens: 4096,
  timeoutMs: 45_000,
  maxInputBytes: 32_000
};
export const comparisonPromptVersion = "provider-comparison-v1";

export class ComparisonError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ComparisonError";
  }
}

export type AnthropicOutputMode = "native-schema" | "prompt-json";

export function anthropicOutputMode(env: NodeJS.ProcessEnv): AnthropicOutputMode {
  const mode = env["LUMA_EVAL_ANTHROPIC_OUTPUT"]?.trim() || "native-schema";
  if (mode !== "native-schema" && mode !== "prompt-json")
    throw new ComparisonError("invalid-anthropic-output-mode");
  return mode;
}

export type GoogleEndpoint =
  { backend: "developer" } | { backend: "vertex"; projectId?: string };

export function googleEndpoint(env: NodeJS.ProcessEnv): GoogleEndpoint {
  const backend = env["LUMA_EVAL_GOOGLE_BACKEND"]?.trim() || "developer";
  if (backend === "developer") return { backend };
  if (backend !== "vertex") throw new ComparisonError("invalid-google-backend");
  const projectId = env["VERTEX_PROJECT_ID"]?.trim();
  if (projectId && !/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]+)$/.test(projectId))
    throw new ComparisonError("invalid-vertex-project");
  return projectId ? { backend, projectId } : { backend };
}

function googleUrl(model: string, endpoint: GoogleEndpoint): string {
  if (endpoint.backend === "developer")
    return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const scope = endpoint.projectId
    ? `projects/${endpoint.projectId}/locations/global/`
    : "";
  return `https://aiplatform.googleapis.com/v1/${scope}publishers/google/models/${model}:generateContent`;
}

export function candidateKey(
  candidate: Candidate,
  env: NodeJS.ProcessEnv
): string | undefined {
  if (candidate.id === "google" && googleEndpoint(env).backend === "vertex")
    return env["VERTEX_API_KEY"]?.trim() || undefined;
  return (
    env[candidate.key]?.trim() ||
    (candidate.id === "google" ? env["GOOGLE_API_KEY"]?.trim() : undefined)
  );
}

/** Identical schema and input text for every candidate, including JSON-mode providers. */
export function comparisonPayload(request: StructuredReasoningRequest<unknown>) {
  const input = JSON.stringify({
    purpose: request.purpose,
    workspaceId: request.workspaceId,
    meetingId: request.meetingId,
    evidence: request.evidence,
    context: request.context,
    input: request.input
  });
  const instructions = `${MEETING_INTELLIGENCE_INSTRUCTIONS}\n\nReturn only JSON matching this schema:\n${JSON.stringify(meetingAnalysisJsonSchema)}`;
  return {
    instructions,
    input,
    hash: createHash("sha256")
      .update(instructions + "\n" + input)
      .digest("hex")
  };
}

export function createComparisonReasoningModel(options: {
  candidate: Candidate;
  apiKey: string;
  limits: Limits;
  transport?: Transport;
  googleEndpoint?: GoogleEndpoint;
  anthropicOutputMode?: AnthropicOutputMode;
  onResponse: (facts: ResponseFacts) => void;
}): ReasoningModel {
  const { candidate, limits } = options;
  if (!options.apiKey.trim()) throw new ComparisonError("missing-credential");
  if (
    !Object.values(limits).every((v) => Number.isSafeInteger(v) && v > 0) ||
    limits.timeoutMs > 60_000 ||
    limits.maxOutputTokens > 16_384 ||
    limits.maxInputBytes > 100_000
  )
    throw new ComparisonError("invalid-limits");
  return {
    async generateStructured<T>(request: StructuredReasoningRequest<T>) {
      if (request.schemaName !== "MeetingAnalysisProposalBatch")
        throw new ComparisonError("unsupported-schema");
      const payload = comparisonPayload(request);
      const { url, body, headers } = outbound(
        candidate,
        options.apiKey,
        payload,
        limits,
        options.googleEndpoint ?? { backend: "developer" },
        options.anthropicOutputMode ?? "native-schema"
      );
      if (Buffer.byteLength(JSON.stringify(body), "utf8") > limits.maxInputBytes)
        throw new ComparisonError("input-limit");
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          (async () => {
            const response = await (options.transport ?? fetch)(url, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: controller.signal,
              redirect: "error"
            });
            if (!response.ok) {
              await response.body?.cancel();
              throw new ComparisonError(`http-${response.status}`);
            }
            const raw: unknown = await response.json();
            return decode(candidate, raw);
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new ComparisonError("timeout-usage-unknown"));
            }, limits.timeoutMs);
          })
        ]);
        // Preserve reported usage even if output is incomplete or semantically invalid.
        options.onResponse(response.facts);
        if (!response.complete) throw new ComparisonError("incomplete-or-refused");
        let parsed: MeetingAnalysisProposalBatch;
        try {
          parsed = meetingAnalysisSchema.parse(JSON.parse(response.text) as unknown);
        } catch {
          throw new ComparisonError("invalid-json-or-schema");
        }
        const known = new Set(request.evidence.map((e) => e.evidenceId));
        if (
          Object.values(parsed)
            .flat()
            .some((item) => item.evidenceIds.some((id) => !known.has(id)))
        )
          throw new ComparisonError("unknown-evidence");
        return {
          value: parsed as T,
          metadata: {
            provider: candidate.id,
            model: response.facts.returnedModel ?? candidate.model,
            promptVersion: request.promptVersion
          }
        };
      } catch (error) {
        if (error instanceof ComparisonError) throw error;
        // Provider response/error bodies may contain prompts or credentials; do not log them.
        throw new ComparisonError("transport-or-response-error-usage-unknown");
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  };
}

function outbound(
  candidate: Candidate,
  key: string,
  payload: ReturnType<typeof comparisonPayload>,
  limits: Limits,
  endpoint: GoogleEndpoint,
  anthropicMode: AnthropicOutputMode
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const messages = [{ role: "user", content: payload.input }];
  switch (candidate.id) {
    case "openai":
      headers["authorization"] = `Bearer ${key}`;
      return {
        url: "https://api.openai.com/v1/responses",
        headers,
        body: {
          model: candidate.model,
          instructions: payload.instructions,
          input: payload.input,
          store: false,
          service_tier: "default",
          max_output_tokens: limits.maxOutputTokens,
          reasoning: { effort: "medium" },
          text: {
            format: {
              type: "json_schema",
              name: "MeetingAnalysisProposalBatch",
              strict: true,
              schema: meetingAnalysisJsonSchema
            }
          }
        }
      };
    case "anthropic":
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
      return {
        url: "https://api.anthropic.com/v1/messages",
        headers,
        body: {
          model: candidate.model,
          system: payload.instructions,
          messages,
          max_tokens: limits.maxOutputTokens,
          thinking: { type: "adaptive" },
          output_config: {
            effort: "medium",
            ...(anthropicMode === "native-schema"
              ? {
                  format: {
                    type: "json_schema",
                    schema: compatibleSchema(meetingAnalysisJsonSchema)
                  }
                }
              : {})
          }
        }
      };
    case "google":
      headers["x-goog-api-key"] = key;
      return {
        url: googleUrl(candidate.model, endpoint),
        headers,
        body: {
          systemInstruction: { parts: [{ text: payload.instructions }] },
          contents: [{ role: "user", parts: [{ text: payload.input }] }],
          generationConfig: {
            maxOutputTokens: limits.maxOutputTokens,
            responseMimeType: "application/json",
            responseJsonSchema: compatibleSchema(meetingAnalysisJsonSchema),
            thinkingConfig: { thinkingLevel: "MEDIUM" }
          }
        }
      };
    case "deepseek":
      headers["authorization"] = `Bearer ${key}`;
      return {
        url: "https://api.deepseek.com/chat/completions",
        headers,
        body: {
          model: candidate.model,
          messages: [{ role: "system", content: payload.instructions }, ...messages],
          max_tokens: limits.maxOutputTokens,
          thinking: { type: "enabled" },
          reasoning_effort: "high",
          response_format: { type: "json_object" }
        }
      };
  }
}

/** The original constraints remain in the shared prompt and local validator. */
function compatibleSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compatibleSchema);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["minItems", "minLength", "format"].includes(key))
        .map(([key, child]) => [key, compatibleSchema(child)])
    );
  return value;
}

const recordSchema = z.record(z.unknown());
function object(value: unknown): Record<string, unknown> {
  return recordSchema.parse(value);
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
function usage(input: unknown, output: unknown, reasoning: unknown): Usage | null {
  const inputTokens = integer(input),
    outputTokens = integer(output),
    reasoningTokens = integer(reasoning);
  return inputTokens === null ||
    outputTokens === null ||
    (reasoningTokens !== null && reasoningTokens > outputTokens)
    ? null
    : { inputTokens, outputTokens, reasoningTokens };
}
function decode(candidate: Candidate, value: unknown) {
  const raw = object(value);
  let text = "",
    complete = false,
    normalizedUsage: Usage | null = null,
    finish: string | null = null;
  const u = raw["usage"] ? object(raw["usage"]) : {};
  switch (candidate.id) {
    case "openai": {
      text = array(raw["output"])
        .flatMap((item) => array(object(item)["content"]))
        .map((item) => {
          const block = object(item);
          return block["type"] === "output_text" ? (string(block["text"]) ?? "") : "";
        })
        .join("");
      finish = string(raw["status"]);
      complete = finish === "completed";
      normalizedUsage = usage(
        u["input_tokens"],
        u["output_tokens"],
        u["output_tokens_details"]
          ? object(u["output_tokens_details"])["reasoning_tokens"]
          : null
      );
      break;
    }
    case "anthropic": {
      text = array(raw["content"])
        .map((item) => {
          const block = object(item);
          return block["type"] === "text" ? (string(block["text"]) ?? "") : "";
        })
        .join("");
      finish = string(raw["stop_reason"]);
      complete = finish === "end_turn";
      const counts = [
        u["input_tokens"],
        u["cache_read_input_tokens"] ?? 0,
        u["cache_creation_input_tokens"] ?? 0
      ].map(integer);
      normalizedUsage = usage(
        counts.every((n) => n !== null)
          ? counts.reduce<number>((sum, n) => sum + (n ?? 0), 0)
          : null,
        u["output_tokens"],
        null
      );
      break;
    }
    case "google": {
      const c = object(array(raw["candidates"])[0] ?? {});
      text = array(object(c["content"] ?? {})["parts"])
        .map((item) => {
          const block = object(item);
          return block["thought"] === true ? "" : (string(block["text"]) ?? "");
        })
        .join("");
      finish = string(c["finishReason"]);
      complete = finish === "STOP";
      const gu = raw["usageMetadata"] ? object(raw["usageMetadata"]) : {};
      const visible = integer(gu["candidatesTokenCount"]),
        thoughts = integer(gu["thoughtsTokenCount"] ?? 0);
      normalizedUsage = usage(
        gu["promptTokenCount"],
        visible !== null && thoughts !== null ? visible + thoughts : null,
        thoughts
      );
      break;
    }
    case "deepseek": {
      const c = object(array(raw["choices"])[0] ?? {});
      text = string(object(c["message"] ?? {})["content"]) ?? "";
      finish = string(c["finish_reason"]);
      complete = finish === "stop";
      normalizedUsage = usage(
        u["prompt_tokens"],
        u["completion_tokens"],
        u["completion_tokens_details"]
          ? object(u["completion_tokens_details"])["reasoning_tokens"]
          : null
      );
      break;
    }
  }
  return {
    text,
    complete,
    facts: {
      returnedModel: string(raw["model"] ?? raw["modelVersion"]),
      responseId: string(raw["id"] ?? raw["responseId"]),
      finishReason: finish,
      usage: normalizedUsage,
      estimatedUncachedCostUsd: normalizedUsage
        ? (normalizedUsage.inputTokens * candidate.inputRate +
            normalizedUsage.outputTokens * candidate.outputRate) /
          1_000_000
        : null
    } satisfies ResponseFacts
  };
}
