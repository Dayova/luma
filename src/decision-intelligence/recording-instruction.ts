/** Check command clauses, preserving negation inside the decision being recorded. */
export function hasDecisionRecordingRefusal(instruction: string): boolean {
  // Quoted decision wording is evidence, not an instruction to the recorder.
  // Apostrophes inside words (Jakob's, don't) are not quotation delimiters.
  const command = instruction.replace(
    /"[^"\n]*"|„[^“\n]*“|“[^”\n]*”|‘[^’\n]*’|(?<!\p{L})'[^'\n]*'(?!\p{L})|`[^`]*`/gu,
    " quoted-content "
  );
  return (
    /(?:^|[,;.!?]|\b(?:but|however|actually|instead)\b)\s*(?:please\s+)?(?:not(?:\s+(?:yet|now|today))?\s*(?=[,;.!?]|$)|not\s+(?:until|before)\b|(?:do\s+not|don['’]t|never)\s+(?:create|make|record|document|update|do|proceed|execute)\b|(?:wait|hold\s+off|pause)\s*(?=[,;.!?]|$))/iu.test(
      command
    ) ||
    /^(?:bitte\s+)?(?:dokumentiere|halte|erstelle|erstell|aktualisiere)\s+(?:bitte\s+)?(?:(?:diese|die|unsere|einen|den|diesen)\s+)?(?:bestehenden?\s+)?(?:entscheidung|decision\s+record|entscheidungsvermerk|entscheidungsdatensatz)\s+(?:bitte\s+)?(?:noch\s+)?nicht\b/iu.test(
      command
    ) ||
    /(?:^|[,;.!?]|\b(?:aber|jedoch|doch)\b)\s*(?:bitte\s+)?(?:noch\s+)?nicht\s*(?=[,;.!?]|$)/iu.test(
      command
    )
  );
}
