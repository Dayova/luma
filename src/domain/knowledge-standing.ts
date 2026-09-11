/** Explicit knowledge lifecycle metadata; it does not establish Human authority. */
export type KnowledgeStanding =
  "current" | "proposed" | "disputed" | "superseded" | "historical";

export function isKnowledgeStanding(value: unknown): value is KnowledgeStanding {
  return (
    value === "current" ||
    value === "proposed" ||
    value === "disputed" ||
    value === "superseded" ||
    value === "historical"
  );
}
