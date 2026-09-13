import { z } from "zod";
import type { ConversationPoll } from "../domain/conversation-poll.js";

const media = z.object({
  text: z.string().max(55).nullable().optional(),
  emoji: z
    .object({
      id: z.string().max(64).nullable().optional(),
      name: z.string().max(100).nullable().optional()
    })
    .optional()
});
const pollSchema = z.object({
  question: z.object({ text: z.string().min(1).max(300) }),
  answers: z
    .array(z.object({ answer_id: z.number().int().positive(), poll_media: media }))
    .min(1)
    .max(10),
  expiry: z.string().datetime({ offset: true }).nullable(),
  allow_multiselect: z.boolean(),
  layout_type: z.literal(1),
  results: z.unknown().optional()
});
const resultsSchema = z.object({
  is_finalized: z.boolean(),
  answer_counts: z
    .array(
      z.object({
        id: z.number().int().positive(),
        count: z.number().int().nonnegative(),
        me_voted: z.boolean().optional()
      })
    )
    .max(10)
});

/** Use the fresh REST poll object: discord.js defaults missing results to zero counts. */
export function discordPollEvidence(
  raw: unknown,
  wordingOrigin: ConversationPoll["wordingOrigin"]
): ConversationPoll | null {
  const parsed = pollSchema.safeParse(raw);
  if (!parsed.success) return null;
  const poll = parsed.data;
  const ids = poll.answers.map((answer) => answer.answer_id);
  if (
    new Set(ids).size !== ids.length ||
    poll.answers.some(
      (answer) =>
        !answer.poll_media.text &&
        !answer.poll_media.emoji?.id &&
        !answer.poll_media.emoji?.name
    )
  )
    return null;
  let results: ConversationPoll["results"] = {
    status: "unknown",
    reason: poll.results === undefined ? "missing" : "malformed"
  };
  const counted = resultsSchema.safeParse(poll.results);
  if (counted.success) {
    const counts = counted.data.answer_counts;
    if (
      new Set(counts.map((answer) => answer.id)).size === counts.length &&
      counts.every((answer) => ids.includes(answer.id))
    ) {
      results = {
        status: counted.data.is_finalized ? "finalized" : "provisional",
        // Zero is justified only for omitted options inside a valid complete results payload.
        counts: ids.map((id) => ({
          optionId: String(id),
          votes: counts.find((answer) => answer.id === id)?.count ?? 0
        }))
      };
    }
  }
  return {
    question: poll.question.text,
    options: poll.answers.map((answer) => ({
      id: String(answer.answer_id),
      text: answer.poll_media.text ?? null,
      emoji: answer.poll_media.emoji
        ? {
            id: answer.poll_media.emoji.id ?? null,
            name: answer.poll_media.emoji.name ?? null
          }
        : null
    })),
    allowsMultiple: poll.allow_multiselect,
    closesAt: poll.expiry,
    wordingOrigin,
    results
  };
}
