import { z } from "zod";

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
export const meetingAnalysisSchema = z
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

export const MEETING_INTELLIGENCE_INSTRUCTIONS = `You are the reasoning adapter for Luma Meeting Intelligence.

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

export const meetingAnalysisJsonSchema: Record<string, unknown> = objectSchema(
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
