type InstructionAction = "create" | "update" | "link";
const recordVerbs: Record<InstructionAction, string> = {
  create:
    "add|put|record|save|insert|create|füge|trage?|speichere|erfasse|erstelle|lege|erzeuge",
  update: "update|change|revise|aktualisiere|ändere|überarbeite",
  link: "link|reuse|verknüpfe|verwende"
};
const workVerbs: Record<InstructionAction, string> = {
  create: "create|add|open|erstelle|lege|erzeuge",
  update: recordVerbs.update,
  link: recordVerbs.link
};
const polite = "(?:(?:please|bitte)\\s+|(?:can|could|would) you (?:please )?)?";
const boundary = "(?=\\s|$)";

/** Shared native routing and domain admission; quoted examples are never commands. */
export function parseExplicitStructuredWorkInstruction(instruction: string): {
  recordClause: string;
  workClause: string;
  recordAction: InstructionAction;
  workAction: InstructionAction;
} | null {
  const text = instruction.trim().replace(/^<@!?[^>]+>\s*/u, "");
  if (
    !text ||
    text.length > 4000 ||
    /\b(?:don't|do not|not yet|never|nicht|keine?|noch nicht|without|ohne)\b/iu.test(
      text
    ) ||
    /["“”„«»`\n\r]/u.test(text)
  )
    return null;
  const workStart = new RegExp(
    `\\b(?:and|und)\\s+${polite}(?:${Object.values(workVerbs).join("|")})${boundary}`,
    "iu"
  );
  const split = workStart.exec(text);
  if (!split || split.index === 0) return null;
  const recordClause = text.slice(0, split.index).trim();
  const workClause = text
    .slice(split.index)
    .replace(/^(?:and|und)\s+/iu, "")
    .trim();
  const action = (clause: string, verbs: Record<InstructionAction, string>) =>
    (Object.keys(verbs) as InstructionAction[]).find((kind) =>
      new RegExp(`^${polite}(?:${verbs[kind]})${boundary}\\s+\\S`, "iu").test(clause)
    );
  const recordAction = action(recordClause, recordVerbs);
  const workAction = action(workClause, workVerbs);
  if (
    !recordAction ||
    !workAction ||
    !/\b(?:task|issue|work item|ticket|aufgabe)\b/iu.test(workClause) ||
    workStart.test(workClause)
  )
    return null;
  return { recordClause, workClause, recordAction, workAction };
}

/** Bounded Execute admission; conceptual, quoted and negated requests remain outside it. */
export function isExplicitStructuredWorkInstruction(instruction: string): boolean {
  return parseExplicitStructuredWorkInstruction(instruction) !== null;
}
