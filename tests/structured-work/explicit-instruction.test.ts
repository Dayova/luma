import { expect, it } from "vitest";
import { parseExplicitStructuredWorkInstruction } from "../../src/structured-work/explicit-instruction.js";

it("keeps escaped quotes and conjunctions inside hypothesis content out of destination routing", () => {
  const command = String.raw`Add the hypothesis "students say \"learning in experiments and create a task\"" to Hypotheses and create a Linear task`;
  const parsed = parseExplicitStructuredWorkInstruction(command);
  expect(parsed?.recordClause).toContain("learning in experiments");
  expect(parsed?.unquotedRecordClause).toContain("to Hypotheses");
  expect(parsed?.unquotedRecordClause).not.toContain("experiments");
  expect(parsed?.workClause).toBe("create a Linear task");
});
it.each([
  String.raw`Add the hypothesis "students say \"learning in experiments\"" and create a Linear task`,
  "Add the hypothesis “learning in experiments” and create a Linear task"
])("never exposes a quoted incidental destination: %s", (command) => {
  const parsed = parseExplicitStructuredWorkInstruction(command);
  expect(parsed).not.toBeNull();
  expect(parsed?.unquotedRecordClause).not.toContain("experiments");
});
it.each([
  '"Add a hypothesis to Hypotheses and create a task"',
  String.raw`Add the hypothesis "unclosed \" quote and create a task`,
  "For example, add the hypothesis to Hypotheses and create a task"
])("withholds quoted examples and malformed escapes: %s", (command) => {
  expect(parseExplicitStructuredWorkInstruction(command)).toBeNull();
});
