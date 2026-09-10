import OpenAI from "openai";
import { AiServiceError } from "./ai-service-error.js";
import type { AiUsageBudget } from "./ai-usage-budget.js";
import {
  normalizedOpenAiUsage,
  resolveAiRequestLimits,
  runBudgetedAiRequest,
  type AiRequestLimits,
  type AiResponse
} from "./ai-request.js";
import {
  meetingAnalysisSchema,
  meetingAnalysisJsonSchema,
  MEETING_INTELLIGENCE_INSTRUCTIONS
} from "./meeting-analysis-contract.js";
import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "./reasoning-model.js";
import {
  DEFAULT_OPENAI_REASONING_MODEL,
  openAIReasoningModelNameFromEnv
} from "./openai-model-config.js";

export type OpenAIResponseRequest = {
  model: string;
  instructions: string;
  input: string;
  schemaName: string;
  schema: Record<string, unknown>;
  strict: true;
  maxOutputTokens: number;
  signal?: AbortSignal;
};

export interface OpenAIResponseClient {
  create(request: OpenAIResponseRequest): Promise<AiResponse>;
}

export type OpenAIReasoningModelConfig = {
  model?: string;
  apiKey?: string;
  client?: OpenAIResponseClient;
  budget?: AiUsageBudget;
  limits?: Partial<AiRequestLimits>;
};

export class OpenAIReasoningModelError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OpenAIReasoningModelError";
    this.code = code;
  }
}

export function createOpenAIReasoningModel(
  config: OpenAIReasoningModelConfig
): ReasoningModel {
  const model = config.model ?? DEFAULT_OPENAI_REASONING_MODEL;
  const limits = resolveAiRequestLimits(config.limits);
  const client = config.client ?? createOpenAISdkResponseClient(config.apiKey, limits);

  return {
    async generateStructured<T>(
      request: StructuredReasoningRequest<T>
    ): Promise<StructuredReasoningResult<T>> {
      if (request.schemaName !== "MeetingAnalysisProposalBatch") {
        throw new OpenAIReasoningModelError(
          "openai-schema-unsupported",
          `Unsupported structured reasoning schema: ${request.schemaName}`
        );
      }

      if (!config.client && !config.budget) {
        throw new AiServiceError(
          "not-configured",
          "A durable AI usage budget is required before paid requests."
        );
      }
      const outbound = {
        model,
        instructions: MEETING_INTELLIGENCE_INSTRUCTIONS,
        input: JSON.stringify({
          purpose: request.purpose,
          workspaceId: request.workspaceId,
          meetingId: request.meetingId,
          evidence: request.evidence,
          context: request.context,
          input: request.input
        }),
        schemaName: request.schemaName,
        schema: meetingAnalysisJsonSchema,
        strict: true as const,
        maxOutputTokens: limits.maxOutputTokens
      };
      const response = await runBudgetedAiRequest({
        ...(config.budget ? { budget: config.budget } : {}),
        workspaceId: request.workspaceId,
        workflow: { model, ...request },
        capability: `meeting-${request.purpose}`,
        model,
        instructions: outbound.instructions,
        input: outbound.input,
        schema: outbound.schema,
        limits,
        invoke: (signal) => client.create({ ...outbound, signal })
      });

      if (!response.outputText) {
        throw new OpenAIReasoningModelError(
          "openai-structured-output-empty",
          "OpenAI returned no structured output"
        );
      }

      const parsed = meetingAnalysisSchema.parse(
        JSON.parse(response.outputText) as unknown
      );
      assertKnownEvidenceIds(parsed, request);

      return {
        value: parsed as T,
        metadata: {
          provider: "openai",
          model,
          promptVersion: request.promptVersion
        }
      };
    }
  };
}

export function createOpenAIReasoningModelFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options?: { budget: AiUsageBudget; limits?: Partial<AiRequestLimits> }
): ReasoningModel {
  return createOpenAIReasoningModel({
    apiKey: requireEnv(env, "OPENAI_API_KEY"),
    model: openAIReasoningModelNameFromEnv(env),
    ...options
  });
}

function createOpenAISdkResponseClient(
  apiKey: string | undefined,
  limits: AiRequestLimits
): OpenAIResponseClient {
  if (!apiKey) {
    throw new OpenAIReasoningModelError(
      "openai-api-key-missing",
      "OPENAI_API_KEY is required for the OpenAI ReasoningModel"
    );
  }

  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: limits.timeoutMs });

  return {
    async create(request) {
      const response = await client.responses.create(
        {
          model: request.model,
          instructions: request.instructions,
          input: request.input,
          store: false,
          service_tier: "default",
          prompt_cache_options: { ttl: "30m" },
          max_output_tokens: request.maxOutputTokens,
          text: {
            format: {
              type: "json_schema",
              name: request.schemaName,
              schema: request.schema,
              strict: request.strict
            }
          }
        },
        { signal: request.signal }
      );
      const usage = normalizedOpenAiUsage(response.usage);
      return {
        outputText: response.output_text,
        providerResponseId: response.id,
        ...(response._request_id ? { providerRequestId: response._request_id } : {}),
        model: response.model,
        ...(response.status ? { status: response.status } : {}),
        ...(response.incomplete_details?.reason
          ? { incompleteReason: response.incomplete_details.reason }
          : {}),
        ...(response.service_tier ? { serviceTier: response.service_tier } : {}),
        ...(usage ? { usage } : {})
      };
    }
  };
}

function assertKnownEvidenceIds<T>(
  analysis: MeetingAnalysisProposalBatch,
  request: StructuredReasoningRequest<T>
): void {
  const knownEvidenceIds = new Set(
    request.evidence.map((evidence) => evidence.evidenceId)
  );
  const citedEvidenceIds = [
    ...analysis.actionItems.flatMap((item) => item.evidenceIds),
    ...analysis.decisions.flatMap((item) => item.evidenceIds),
    ...analysis.openQuestions.flatMap((item) => item.evidenceIds),
    ...analysis.risks.flatMap((item) => item.evidenceIds),
    ...analysis.followUpIntentions.flatMap((intent) => intent.evidenceIds)
  ];
  const unknownEvidenceId = citedEvidenceIds.find(
    (evidenceId) => !knownEvidenceIds.has(evidenceId)
  );

  if (unknownEvidenceId) {
    throw new OpenAIReasoningModelError(
      "openai-evidence-reference-invalid",
      `Model output cited unknown evidence ID: ${unknownEvidenceId}`
    );
  }
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = nonBlank(env[key]);

  if (!value) {
    throw new OpenAIReasoningModelError(
      "openai-config-incomplete",
      `${key} is required for the OpenAI ReasoningModel`
    );
  }

  return value;
}

function nonBlank(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
