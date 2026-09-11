/** Bounded Execute admission; conceptual, quoted and negated requests remain outside this capability. */
export function isExplicitStructuredWorkInstruction(instruction: string): boolean {
  const text = instruction.trim().replace(/^<@!?[^>]+>\s*/u, "");
  if (
    text.length > 4000 ||
    /\b(?:don't|do not|not yet|nicht|keine?|noch nicht)\b/iu.test(text)
  )
    return false;
  return /^(?:(?:please|bitte)\s+|(?:can|could|would) you (?:please )?)?(?:add|put|record|save|insert|füge|trage?|speichere|erfasse)\b[\s\S]+\b(?:and|und)\b\s+(?:please\s+|bitte\s+)?(?:create|add|open|erstelle|lege|erzeuge)\b[\s\S]*\b(?:task|issue|work item|ticket|aufgabe)\b/iu.test(
    text
  );
}
