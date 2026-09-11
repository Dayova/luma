/** A later explicit refusal cannot authorize recording, including native commands. */
export function hasDecisionRecordingRefusal(instruction: string): boolean {
  return (
    /\bnot\s+(?:yet|now|today|until|before)\b/iu.test(instruction) ||
    /(?:^|[,;.!?]|\b(?:but|however|actually|instead)\b)\s*(?:please\s+)?(?:not\b|(?:do\s+not|don['’]t|never)\s+(?:create|make|record|document|update|do|proceed|execute)\b|(?:wait|hold\s+off|pause)\b)/iu.test(
      instruction
    ) ||
    /^(?:bitte\s+)?(?:dokumentiere|halte|erstelle|erstell|aktualisiere)\s+(?:bitte\s+)?(?:(?:diese|die|unsere|einen|den|diesen)\s+)?(?:bestehenden?\s+)?(?:entscheidung|decision\s+record|entscheidungsvermerk|entscheidungsdatensatz)\s+(?:bitte\s+)?(?:noch\s+)?nicht\b/iu.test(
      instruction
    ) ||
    /\b(?:aber|jedoch|doch)\s+(?:bitte\s+)?(?:noch\s+)?nicht\b/iu.test(instruction)
  );
}
