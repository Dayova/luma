/** Preserve the complete rendered answer when it cannot fit in one Discord message. */
export function discordAnswerDelivery(content: string, maxLength = 1_900) {
  if (content.length <= maxLength) return { content };
  const notice =
    "Full answer, sources and limitations are in the attached luma-answer.txt.";
  // Only reuse complete paragraphs; never cut a claim or source URL mid-sentence.
  const introduction = content.split("\n\n", 2).join("\n\n");
  return {
    content:
      introduction.length + notice.length + 2 <= maxLength
        ? `${introduction}\n\n${notice}`
        : notice,
    attachment: Buffer.from(content, "utf8")
  };
}
