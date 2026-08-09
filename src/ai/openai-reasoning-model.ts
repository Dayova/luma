import OpenAI from "openai";
import { z } from "zod";
import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "./reasoning-model.js";

const DEFAULT_OPENAI_REASONING_MODEL = "gpt-5.6-luna";

const confidenceSchema = z.enum(["low", "medium", "high"]);
const evidenceIdsSchema = z.array(z.string().min(1)).min(1);
const externalReferenceSchema = z
  .object({
    providerId: z.string().min(1),
    objectType: z.enum([
      "document",
      "work-item",
      "pull-request",
      "commit",
      "comment",
      "project",
      "other"
    ]),
    externalId: z.string().min(1),
    url: z.string().url()
  })
  .strict();
const followUpBase = {
  id: z.string().min(1),
  relatedMeetingItemIds: z.array(z.string()),
  evidenceIds: evidenceIdsSchema,
  confidence: confidenceSchema
};
const meetingAnalysisSchema = z
  .object({
    actionItems: z.array(
      z
        .object({
          stableKey: z.string().min(1),
          description: z.string().min(1),
          ownerId: z.string().nullable(),
          dueDate: z
            .object({
              originalPhrase: z.string().nullable(),
              normalizedDate: z.string().nullable(),
              confidence: z.enum(["exact", "normalized", "ambiguous", "unknown"]),
              timezone: z.string().min(1)
            })
            .strict(),
          status: z.enum([
            "candidate",
            "confirmed",
            "planned",
            "in-progress",
            "blocked",
            "completed",
            "cancelled"
          ]),
          relatedDecisionIds: z.array(z.string()),
          evidenceIds: evidenceIdsSchema,
          confidence: confidenceSchema
        })
        .strict()
    ),
    decisions: z.array(
      z
        .object({
          stableKey: z.string().min(1),
          statement: z.string().min(1),
          rationale: z.array(z.string()),
          status: z.enum(["candidate", "confirmed", "rejected", "superseded"]),
          supportingParticipantIds: z.array(z.string()),
          objectingParticipantIds: z.array(z.string()),
          relatedTopicIds: z.array(z.string()),
          evidenceIds: evidenceIdsSchema,
          confidence: confidenceSchema
        })
        .strict()
    ),
    openQuestions: z.array(
      z
        .object({
          stableKey: z.string().min(1),
          question: z.string().min(1),
          raisedBy: z.string().nullable(),
          evidenceIds: evidenceIdsSchema,
          confidence: confidenceSchema
        })
        .strict()
    ),
    risks: z.array(
      z
        .object({
          stableKey: z.string().min(1),
          statement: z.string().min(1),
          severity: z.enum(["low", "medium", "high", "unknown"]),
          mitigation: z.string().nullable(),
          evidenceIds: evidenceIdsSchema,
          confidence: confidenceSchema
        })
        .strict()
    ),
    followUpIntentions: z.array(
      z.discriminatedUnion("type", [
        z
          .object({
            ...followUpBase,
            type: z.literal("record-meeting"),
            title: z.string().min(1)
          })
          .strict(),
        z
          .object({
            ...followUpBase,
            type: z.literal("create-work-item"),
            title: z.string().min(1),
            description: z.string().min(1),
            assigneeId: z.string().nullable(),
            mentionPersonIds: z.array(z.string()),
            dueDate: z.string().nullable()
          })
          .strict(),
        z
          .object({
            ...followUpBase,
            type: z.literal("update-work-item"),
            externalReference: externalReferenceSchema,
            description: z.string().min(1)
          })
          .strict(),
        z
          .object({
            ...followUpBase,
            type: z.literal("comment-on-code-change"),
            externalReference: externalReferenceSchema,
            bodyMarkdown: z.string().min(1)
          })
          .strict()
      ])
    )
  })
  .strict();

export type OpenAIResponseRequest = {
  model: string;
  instructions: string;
  input: string;
  schemaName: string;
  schema: Record<string, unknown>;
  strict: true;
};

export interface OpenAIResponseClient {
  create(request: OpenAIResponseRequest): Promise<{ outputText: string }>;
}

export type OpenAIReasoningModelConfig = {
  model?: string;
  apiKey?: string;
  client?: OpenAIResponseClient;
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
  const client = config.client ?? createOpenAISdkResponseClient(config.apiKey);

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

      const response = await client.create({
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
        strict: true
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
  env: NodeJS.ProcessEnv = process.env
): ReasoningModel {
  const model = nonBlank(env["LUMA_REASONING_MODEL_NAME"]);
  return createOpenAIReasoningModel({
    apiKey: requireEnv(env, "OPENAI_API_KEY"),
    ...(model ? { model } : {})
  });
}

function createOpenAISdkResponseClient(apiKey: string | undefined): OpenAIResponseClient {
  if (!apiKey) {
    throw new OpenAIReasoningModelError(
      "openai-api-key-missing",
      "OPENAI_API_KEY is required for the OpenAI ReasoningModel"
    );
  }

  const client = new OpenAI({ apiKey });

  return {
    async create(request) {
      const response = await client.responses.create({
        model: request.model,
        instructions: request.instructions,
        input: request.input,
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: request.schemaName,
            schema: request.schema,
            strict: request.strict
          }
        }
      });
      return { outputText: response.output_text };
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

const MEETING_INTELLIGENCE_INSTRUCTIONS = `You are the reasoning adapter for Luma Meeting Intelligence.

Use only the supplied evidence. Cite every factual output with one or more supplied evidence IDs. Preserve the source language, modality, names, repository identifiers, issue identifiers, dates, and technical terms. Do not turn "might" into "will" or "could" into "must".

Linear owns executable work. Propose create-work-item or update-work-item when something needs to be done. Notion owns meeting records and decisions. Propose record-meeting for a durable meeting record. Do not propose generic knowledge-document creation or updates: safe canonical knowledge patches require a Human-selected target, exact region, and conflict policy. Do not duplicate executable tasks in Notion. GitHub owns code changes and pull requests.

External mutations are proposals only. Every Follow-up Intent must remain subject to explicit human approval.`;

const stringSchema = { type: "string" } as const;
const nullableStringSchema = { type: ["string", "null"] } as const;
const confidenceJsonSchema = {
  type: "string",
  enum: ["low", "medium", "high"]
} as const;
const stringArraySchema = { type: "array", items: stringSchema } as const;
const evidenceArraySchema = {
  type: "array",
  items: stringSchema,
  minItems: 1
} as const;
const externalReferenceJsonSchema = objectSchema(
  {
    providerId: stringSchema,
    objectType: {
      type: "string",
      enum: [
        "document",
        "work-item",
        "pull-request",
        "commit",
        "comment",
        "project",
        "other"
      ]
    },
    externalId: stringSchema,
    url: stringSchema
  },
  ["providerId", "objectType", "externalId", "url"]
);
const followUpCommonJsonProperties = {
  id: stringSchema,
  relatedMeetingItemIds: stringArraySchema,
  evidenceIds: evidenceArraySchema,
  confidence: confidenceJsonSchema
};

const meetingAnalysisJsonSchema: Record<string, unknown> = objectSchema(
  {
    actionItems: {
      type: "array",
      items: objectSchema(
        {
          stableKey: stringSchema,
          description: stringSchema,
          ownerId: nullableStringSchema,
          dueDate: objectSchema(
            {
              originalPhrase: nullableStringSchema,
              normalizedDate: nullableStringSchema,
              confidence: {
                type: "string",
                enum: ["exact", "normalized", "ambiguous", "unknown"]
              },
              timezone: stringSchema
            },
            ["originalPhrase", "normalizedDate", "confidence", "timezone"]
          ),
          status: {
            type: "string",
            enum: [
              "candidate",
              "confirmed",
              "planned",
              "in-progress",
              "blocked",
              "completed",
              "cancelled"
            ]
          },
          relatedDecisionIds: stringArraySchema,
          evidenceIds: evidenceArraySchema,
          confidence: confidenceJsonSchema
        },
        [
          "stableKey",
          "description",
          "ownerId",
          "dueDate",
          "status",
          "relatedDecisionIds",
          "evidenceIds",
          "confidence"
        ]
      )
    },
    decisions: {
      type: "array",
      items: objectSchema(
        {
          stableKey: stringSchema,
          statement: stringSchema,
          rationale: stringArraySchema,
          status: {
            type: "string",
            enum: ["candidate", "confirmed", "rejected", "superseded"]
          },
          supportingParticipantIds: stringArraySchema,
          objectingParticipantIds: stringArraySchema,
          relatedTopicIds: stringArraySchema,
          evidenceIds: evidenceArraySchema,
          confidence: confidenceJsonSchema
        },
        [
          "stableKey",
          "statement",
          "rationale",
          "status",
          "supportingParticipantIds",
          "objectingParticipantIds",
          "relatedTopicIds",
          "evidenceIds",
          "confidence"
        ]
      )
    },
    openQuestions: {
      type: "array",
      items: objectSchema(
        {
          stableKey: stringSchema,
          question: stringSchema,
          raisedBy: nullableStringSchema,
          evidenceIds: evidenceArraySchema,
          confidence: confidenceJsonSchema
        },
        ["stableKey", "question", "raisedBy", "evidenceIds", "confidence"]
      )
    },
    risks: {
      type: "array",
      items: objectSchema(
        {
          stableKey: stringSchema,
          statement: stringSchema,
          severity: {
            type: "string",
            enum: ["low", "medium", "high", "unknown"]
          },
          mitigation: nullableStringSchema,
          evidenceIds: evidenceArraySchema,
          confidence: confidenceJsonSchema
        },
        ["stableKey", "statement", "severity", "mitigation", "evidenceIds", "confidence"]
      )
    },
    followUpIntentions: {
      type: "array",
      items: {
        anyOf: [
          followUpIntentJsonSchema("record-meeting", { title: stringSchema }),
          followUpIntentJsonSchema("create-work-item", {
            title: stringSchema,
            description: stringSchema,
            assigneeId: nullableStringSchema,
            mentionPersonIds: stringArraySchema,
            dueDate: nullableStringSchema
          }),
          followUpIntentJsonSchema("update-work-item", {
            externalReference: externalReferenceJsonSchema,
            description: stringSchema
          }),
          followUpIntentJsonSchema("comment-on-code-change", {
            externalReference: externalReferenceJsonSchema,
            bodyMarkdown: stringSchema
          })
        ]
      }
    }
  },
  ["actionItems", "decisions", "openQuestions", "risks", "followUpIntentions"]
);

function objectSchema(
  properties: Record<string, unknown>,
  required: string[]
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

function followUpIntentJsonSchema(
  type: string,
  specificProperties: Record<string, unknown>
): Record<string, unknown> {
  const properties = {
    ...followUpCommonJsonProperties,
    type: { type: "string", const: type },
    ...specificProperties
  };
  return objectSchema(properties, Object.keys(properties));
}
