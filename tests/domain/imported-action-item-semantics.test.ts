import { describe, expect, it } from "vitest";
import {
  importedActionItemModalityFor,
  mentionedGitHubImplementationReferencesFor
} from "../../src/domain/imported-action-item-semantics.js";

describe("imported Action Item semantics", () => {
  it("fails closed quickly for a whitespace-amplified acknowledgement near miss", () => {
    const sourceText = `Ja${" ".repeat(50_000)},${" ".repeat(50_000)}machex ich`;
    const startedAt = performance.now();

    expect(importedActionItemModalityFor(sourceText)).toEqual({
      kind: "unknown",
      sourceForm: null
    });
    expect(performance.now() - startedAt).toBeLessThan(500);
  }, 2_000);

  it.each([
    ["Ich übernehme die Notion-Quelle.", "commitment", "Ich übernehme"],
    ["Das mache ich.", "commitment", "Das mache ich"],
    ["Ja, übernehme ich.", "commitment", "Ja, übernehme ich"],
    ["Ja übernehme ich.", "commitment", "Ja übernehme ich"],
    ["Jaübernehme ich.", "commitment", "Jaübernehme ich"],
    ["Ich kümmere mich darum.", "commitment", "Ich kümmere mich"],
    ["Ich bearbeite die Quelle.", "commitment", "Ich bearbeite"],
    ["Ich mache das vielleicht.", "proposal", "Ich mache"],
    ["Ich mache das nicht.", "unknown", null],
    ["I will own the source.", "commitment", "will"]
  ] as const)(
    "preserves the modality and source form for %s",
    (sourceText, kind, sourceForm) => {
      expect(importedActionItemModalityFor(sourceText)).toEqual({ kind, sourceForm });
    }
  );

  it("keeps exact GitHub URLs after adversarial punctuation tails", () => {
    const commitSha = "0123456789abcdef0123456789abcdef01234567";
    const sourceText = `Review https://github.com/Dayova/Luma/pull/42${"!".repeat(100_000)} and https://github.com/Dayova/Luma/commit/${commitSha}${".,;:!)}]".repeat(10_000)}`;

    expect(mentionedGitHubImplementationReferencesFor(sourceText)).toEqual([
      {
        providerId: "github-code",
        objectType: "pull-request",
        externalId: "Dayova/Luma#42",
        url: "https://github.com/Dayova/Luma/pull/42"
      },
      {
        providerId: "github-code",
        objectType: "commit",
        externalId: `Dayova/Luma@${commitSha}`,
        url: `https://github.com/Dayova/Luma/commit/${commitSha}`
      }
    ]);
  });
});
