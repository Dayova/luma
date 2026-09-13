import { describe, expect, it } from "vitest";
import { retrievalConcepts } from "../../src/organizational-context/retrieval-concepts.js";

describe("bounded multilingual retrieval discovery", () => {
  it("removes question scaffolding and preserves literal technical names without adding query qualifiers", () => {
    expect(
      retrievalConcepts([
        'Wie wird "monthlyLimitUsd" in Dayova/luma für LUM-4 verwendet: monthlyLimitUsd und AI_BUDGET?'
      ])
    ).toEqual(["monthlyLimitUsd", "Dayova/luma", "LUM-4", "verwendet", "AI_BUDGET"]);
    expect(retrievalConcepts(['What: "budget" repo:other/private \\ budget?'])).toEqual([
      "budget",
      "repo",
      "other/private"
    ]);
  });

  it("bounds discovery by both input size and distinct terms without inventing terms for an empty question", () => {
    expect(retrievalConcepts(["Budget budget BUDGET"])).toEqual(["Budget"]);
    expect(retrievalConcepts(["How? Was? !!!"])).toEqual([]);
    expect(retrievalConcepts([" ".repeat(8_000), "privateLaterText"])).toEqual([]);
    expect(
      retrievalConcepts(["one two three four five six seven eight nine ten"])
    ).toHaveLength(8);
  });
});
