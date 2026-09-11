import { z } from "zod";

const optionId = z.string().min(1).max(64);
const count = z.object({ optionId, votes: z.number().int().nonnegative() }).strict();
export const conversationPollSchema = z
  .object({
    question: z.string().min(1).max(300),
    options: z
      .array(
        z
          .object({
            id: optionId,
            text: z.string().max(55).nullable(),
            emoji: z
              .object({
                id: z.string().max(64).nullable(),
                name: z.string().max(100).nullable()
              })
              .strict()
              .nullable()
          })
          .strict()
      )
      .min(1)
      .max(10),
    allowsMultiple: z.boolean(),
    closesAt: z.string().datetime({ offset: true }).nullable(),
    wordingOrigin: z.enum(["human", "luma-generated"]),
    results: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("unknown"),
          reason: z.enum(["missing", "malformed"])
        })
        .strict(),
      z
        .object({
          status: z.enum(["provisional", "finalized"]),
          counts: z.array(count).min(1).max(10)
        })
        .strict()
    ])
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.options.map((option) => option.id);
    if (
      new Set(ids).size !== ids.length ||
      value.options.some(
        (option) => !option.text && !option.emoji?.id && !option.emoji?.name
      )
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid poll options" });
    if (value.results.status !== "unknown") {
      const counted = value.results.counts.map((entry) => entry.optionId);
      if (
        new Set(counted).size !== counted.length ||
        ids.length !== counted.length ||
        counted.some((id) => !ids.includes(id))
      )
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid poll counts" });
    }
  });

/** Observed aggregate results are advisory Evidence, never Human Judgment or voter identity. */
export type ConversationPoll = z.infer<typeof conversationPollSchema>;
