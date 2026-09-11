import { z } from "zod";
import type {
  StructuredWorkInterpretation,
  StructuredWorkSource
} from "../domain/structured-work.js";
import { decisionSourceSchema } from "../domain/decision-record-schemas.js";

const id = z.string().min(1).max(512);
const text = z.string().trim().min(1).max(12000);
export const structuredFieldValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), value: text }).strict(),
  z.object({ type: z.literal("choice"), value: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("number"), value: z.number().finite() }).strict(),
  z.object({ type: z.literal("boolean"), value: z.boolean() }).strict(),
  z.object({ type: z.literal("url"), value: z.string().url().max(2000) }).strict(),
  z
    .object({ type: z.literal("date"), value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u) })
    .strict()
]);
const evidenceIds = z.array(id).min(1).max(50);
const reconciliation = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create") }).strict(),
  z.object({ action: z.literal("link"), targetId: id }).strict(),
  z.object({ action: z.literal("update"), targetId: id }).strict(),
  z.object({ action: z.literal("clarify"), reason: text }).strict(),
  z.object({ action: z.literal("reject"), reason: text }).strict()
]);
export const structuredWorkInterpretationSchema = z
  .object({
    targetKey: id,
    record: z
      .object({
        fields: z
          .record(id, structuredFieldValueSchema)
          .refine((value) => Object.keys(value).length <= 25),
        evidenceIds,
        reconciliation
      })
      .strict(),
    work: z
      .object({
        title: z.string().trim().min(1).max(300),
        description: text,
        evidenceIds,
        ownership: z.discriminatedUnion("status", [
          z
            .object({ status: z.literal("confirmed"), personId: id, evidenceIds })
            .strict(),
          z
            .object({ status: z.literal("intentionally-unassigned"), evidenceIds })
            .strict(),
          z.object({ status: z.literal("unresolved"), reason: text }).strict()
        ]),
        reconciliation
      })
      .strict()
  })
  .strict()
  .transform((value): StructuredWorkInterpretation => value);
export const structuredWorkSourceSchema = z
  .unknown()
  .transform((value, ctx): StructuredWorkSource => {
    const fail = (): never => {
      ctx.addIssue({ code: "custom", message: "The structured source proof is invalid" });
      return z.NEVER;
    };
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    const { instructionSource, ...original } = value as Record<string, unknown>;
    const parsed = decisionSourceSchema.safeParse(original);
    if (!parsed.success) return fail();
    if (instructionSource === undefined) return parsed.data;
    const proof = decisionSourceSchema.safeParse(instructionSource);
    if (
      parsed.data.subject.type !== "meeting" ||
      !proof.success ||
      proof.data.subject.type !== "conversation-thread" ||
      proof.data.audience.workspaceId !== parsed.data.audience.workspaceId ||
      JSON.stringify([...proof.data.audience.personIds].sort()) !==
        JSON.stringify([...parsed.data.audience.personIds].sort())
    )
      return fail();
    const ids = [...parsed.data.evidence, ...proof.data.evidence].map(
      (entry) => entry.id
    );
    if (new Set(ids).size !== ids.length) return fail();
    return {
      ...parsed.data,
      instructionSource: { ...proof.data, subject: proof.data.subject }
    };
  });
