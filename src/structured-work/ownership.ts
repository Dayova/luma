import { StructuredWorkClarification } from "./errors.js";
import type {
  StructuredWorkOwnership,
  StructuredWorkSource
} from "../domain/structured-work.js";

/** Source authorship is checked by the capture adapter. Model labels alone never assign work. */
export function requireStructuredWorkOwnership(
  source: StructuredWorkSource,
  ownership: StructuredWorkOwnership
): string | null {
  if (ownership.status === "unresolved")
    throw new StructuredWorkClarification(
      "Who owns the validation work? Confirm an owner or explicitly leave it unassigned."
    );
  const selected = ownership.evidenceIds.map((id) =>
    source.evidence.find((item) => item.id === id)
  );
  if (
    selected.some(
      (item) =>
        !item ||
        item.origin !== "human" ||
        !item.authorPersonId ||
        !source.audience.personIds.includes(item.authorPersonId)
    )
  )
    throw new StructuredWorkClarification(
      "Ownership needs original authenticated Human evidence"
    );
  const human = selected.filter((item) => item !== undefined);
  if (ownership.status === "intentionally-unassigned") {
    if (
      !human.some((item) =>
        /^(?:leave (?:this |the )?(?:task|work|issue) (?:intentionally )?unassigned|(?:diese |die )?aufgabe (?:bitte )?(?:bewusst |absichtlich )?unzugewiesen lassen)[.!]?$/iu.test(
          item.text.trim()
        )
      )
    )
      throw new StructuredWorkClarification(
        "Intentionally unassigned work needs an explicit Human instruction"
      );
    return null;
  }
  if (!source.audience.personIds.includes(ownership.personId))
    throw new StructuredWorkClarification(
      "The owner is outside the authorized source audience"
    );
  const own = human.filter((item) => item.authorPersonId === ownership.personId);
  const commitment = own.some((item) =>
    /^(?:I (?:will|shall) (?:validate|test|investigate)|I(?:'ll| will) (?:take|own) (?:this|the)|ich (?:übernehme|validiere|teste|untersuche)|ich werde (?:validieren|testen|untersuchen))/iu.test(
      item.text.trim()
    )
  );
  const acceptedAssignment = own.some((item) => {
    if (
      !/^(?:(?:so |also )?(?:should I|shall I|soll ich|sollte ich))\b/iu.test(
        item.text.trim()
      )
    )
      return false;
    const position = source.evidence.findIndex((candidate) => candidate.id === item.id);
    const response = source.evidence[position + 1];
    return (
      !!response &&
      response.origin === "human" &&
      response.authorPersonId !== ownership.personId &&
      !!response.authorPersonId &&
      human.some((candidate) => candidate.id === response.id) &&
      /^(?:yes|ja|genau|correct)(?:[.!]|$)/iu.test(response.text.trim())
    );
  });
  if (!commitment && !acceptedAssignment)
    throw new StructuredWorkClarification(
      "The proposed owner has not explicitly accepted this validation work"
    );
  return ownership.personId;
}
