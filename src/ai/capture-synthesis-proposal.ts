import { z } from "zod";

export const captureSynthesisProposalSchema = z
  .object({
    claims: z
      .array(
        z
          .object({
            key: z.string().min(1).max(160),
            kind: z.enum([
              "summary",
              "decision",
              "commitment",
              "action-item",
              "question",
              "risk"
            ]),
            text: z.string().min(1).max(4000),
            evidenceIds: z.array(z.string().min(1)).min(1).max(32),
            quotations: z
              .array(
                z
                  .object({
                    evidenceId: z.string().min(1),
                    text: z.string().min(1).max(2000)
                  })
                  .strict()
              )
              .max(8),
            conflictingKeys: z.array(z.string().min(1)).max(32),
            confidence: z.enum(["low", "medium", "high"])
          })
          .strict()
      )
      .max(80)
  })
  .strict();

export type CaptureSynthesisProposal = z.infer<typeof captureSynthesisProposalSchema>;

export const captureSynthesisJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "key",
          "kind",
          "text",
          "evidenceIds",
          "quotations",
          "conflictingKeys",
          "confidence"
        ],
        properties: {
          key: { type: "string" },
          kind: {
            type: "string",
            enum: ["summary", "decision", "commitment", "action-item", "question", "risk"]
          },
          text: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } },
          quotations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["evidenceId", "text"],
              properties: { evidenceId: { type: "string" }, text: { type: "string" } }
            }
          },
          conflictingKeys: { type: "array", items: { type: "string" } },
          confidence: { type: "string", enum: ["low", "medium", "high"] }
        }
      }
    }
  }
};

export const CAPTURE_SYNTHESIS_INSTRUCTIONS = `Produce Luma Synthesis, derived understanding of one Logical Meeting. Every claim must cite the supplied exact material evidence IDs. Keep sources independent; never fabricate a combined transcript. Preserve German, English, mixed language and modality (could is not will). Describe decisions, commitments, action items, questions and risk without inventing speaker or owner identity. Keep contradictory claims as separate claims with reciprocal conflictingKeys, even if one provider sounds more confident. Provider brand is not authority. Human judgments supplied in context are authoritative; never contradict or omit them to favor model inference. Quotations require exact substrings of material marked original-speech/verbatim-transcript; derived notes cannot support exact quotes. Use quotations only in the structured quotations field. This output is not a canonical Decision Record, work assignment, external write authorization, or Operational Outcome. Return only the requested structured proposal.`;
