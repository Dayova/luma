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

/** Hide quoted content from imperative/destination parsing without changing offsets. */
function unquoted(text: string): string | null {
  const endings: Record<string, string> = {
    '"': '"',
    "'": "'",
    "`": "`",
    "“": "”",
    "„": "“",
    "«": "»",
    "‘": "’"
  };
  let end: string | null = null;
  let result = "";
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    const apostrophe =
      (character === "'" || character === "’") &&
      /[\p{L}\p{N}]/u.test(text[index - 1] ?? "") &&
      /[\p{L}\p{N}]/u.test(text[index + 1] ?? "");
    if (end) {
      result += " ";
      if (character === "\\") {
        if (index + 1 === text.length) return null;
        result += " ";
        index++;
      } else if (character === end && !apostrophe) end = null;
    } else if (endings[character] && !apostrophe) {
      end = endings[character]!;
      result += " ";
    } else if (/[”»’]/u.test(character) && !apostrophe) return null;
    else result += character;
  }
  return end ? null : result;
}

/** Shared native routing and domain admission; quoted examples are never commands. */
export function parseExplicitStructuredWorkInstruction(instruction: string): {
  recordClause: string;
  /** Only this clause may resolve unquoted configured destination names. */
  unquotedRecordClause: string;
  workClause: string;
  recordAction: InstructionAction;
  workAction: InstructionAction;
} | null {
  const text = instruction.trim().replace(/^<@!?[^>]+>\s*/u, "");
  const routing = unquoted(text);
  if (
    !text ||
    text.length > 4000 ||
    !routing ||
    /\b(?:don't|do not|not yet|never|nicht|keine?|noch nicht|without|ohne)\b/iu.test(
      routing
    )
  )
    return null;
  const workStart = new RegExp(
    `\\b(?:and|und)\\s+${polite}(?:${Object.values(workVerbs).join("|")})${boundary}`,
    "iu"
  );
  const split = workStart.exec(routing);
  if (!split || split.index === 0) return null;
  const recordClause = text.slice(0, split.index).trim();
  const unquotedRecordClause = routing.slice(0, split.index).trim();
  const workClause = text
    .slice(split.index)
    .replace(/^(?:and|und)\s+/iu, "")
    .trim();
  const unquotedWorkClause = routing
    .slice(split.index)
    .replace(/^(?:and|und)\s+/iu, "")
    .trim();
  const action = (clause: string, verbs: Record<InstructionAction, string>) =>
    (Object.keys(verbs) as InstructionAction[]).find((kind) =>
      new RegExp(`^${polite}(?:${verbs[kind]})${boundary}\\s+\\S`, "iu").test(clause)
    );
  const recordAction = action(unquotedRecordClause, recordVerbs);
  const workAction = action(unquotedWorkClause, workVerbs);
  if (
    !recordAction ||
    !workAction ||
    !/\b(?:task|issue|work item|ticket|aufgabe)\b/iu.test(unquotedWorkClause) ||
    workStart.test(unquotedWorkClause)
  )
    return null;
  return { recordClause, unquotedRecordClause, workClause, recordAction, workAction };
}

/** Bounded Execute admission; conceptual, quoted and negated requests remain outside it. */
export function isExplicitStructuredWorkInstruction(instruction: string): boolean {
  return parseExplicitStructuredWorkInstruction(instruction) !== null;
}
