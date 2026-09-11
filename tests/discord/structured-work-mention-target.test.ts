import { describe, expect, it } from "vitest";
import { resolveStructuredWorkMentionTarget } from "../../src/discord/discord-structured-work-mention.js";

describe("Configured compound command destinations", () => {
  const targets = [
    { key: "experiments", label: "Product Experiments & Validation" },
    { key: "customer-feedback", label: "Customer Feedback" }
  ];
  it.each([
    ["Add this to experiments and create a task", "experiments"],
    ["Add this to Product Experiments & Validation and create a task", "experiments"],
    ["Trage das in Customer Feedback ein und erstelle eine Aufgabe", "customer-feedback"],
    ["Add this to customer-feedback and create a task", "customer-feedback"]
  ])("selects only the explicit configured destination in %s", (instruction, key) => {
    expect(resolveStructuredWorkMentionTarget(instruction, targets)).toEqual({
      type: "selected",
      key
    });
  });
  it.each([
    "Add this to experiments or Customer Feedback and create a task",
    "Add this to a table and create an experiments task",
    "Add this to experimentsarchive and create a task"
  ])("asks for clarification without guessing for %s", (instruction) => {
    expect(resolveStructuredWorkMentionTarget(instruction, targets)).toMatchObject({
      type: "clarify"
    });
  });
  it("does not choose the first of colliding configured aliases or labels", () => {
    expect(
      resolveStructuredWorkMentionTarget("Add this to experiments and create a task", [
        ...targets,
        { key: "other", label: "Experiments" }
      ])
    ).toMatchObject({ type: "clarify" });
  });
});
