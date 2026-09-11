import { describe, expect, it } from "vitest";
import {
  canonicalDecisionJson,
  decisionDigest,
  parseNotionDecisionRecord,
  renderNotionDecisionRecord,
  type DecisionRecordArchive
} from "../../src/knowledge/notion-decision-record-format.js";
import { decisionRecord } from "./decision-record-fixture.js";

const signingKey = "test-only-format-key-longer-than-thirty-two-bytes";
const dataSourceId = "3bc2e872-28bf-8193-9669-ec8c5a94aae3";
function archive(text: string): DecisionRecordArchive {
  const content = decisionRecord();
  content.candidate.statement.text = text;
  content.candidate.context = { text, evidenceIds: ["source-1"] };
  content.candidate.rationale = [{ text, evidenceIds: ["source-1"] }];
  content.candidate.unresolved = [text];
  return {
    format: 1,
    workspaceId: "dayova",
    dataSourceId,
    revisions: [
      { operationId: "approved-format-fixture", stageDigest: "a".repeat(64), content }
    ]
  };
}
describe("signed Decision Record format", () => {
  it.each([
    ["- First decision", "\\- First decision"],
    ["+ First decision", "\\+ First decision"],
    ["12. First decision", "12\\. First decision"],
    ["  - First decision", "  \\- First decision"],
    ["   123. First decision", "   123\\. First decision"]
  ])(
    "keeps %s literal in standalone prose and existing list entries",
    (text, escaped) => {
      const source = archive(text);
      const rendered = renderNotionDecisionRecord(source, signingKey);
      expect(rendered).toContain(`\n${escaped}\n`);
      expect(rendered).toContain(`\n- ${escaped}\n`);
      // Notion removes plain empty lines while retaining code and explicit escapes.
      const read = rendered
        .split("\n")
        .filter((line) => line !== "")
        .join("\n");
      const parsed = parseNotionDecisionRecord({
        markdown: read,
        signingKey,
        workspaceId: "dayova",
        dataSourceId
      });
      expect(parsed.archive).toEqual(source);
      expect(renderNotionDecisionRecord(parsed.archive, signingKey)).toBe(rendered);
    }
  );
  it("preserves inline punctuation and rejects a changed readable region", () => {
    const source = archive("Ship - calmly + keep 12. unchanged.");
    const rendered = renderNotionDecisionRecord(source, signingKey);
    expect(rendered).toContain("\nShip - calmly + keep 12. unchanged.\n");
    expect(() =>
      parseNotionDecisionRecord({
        markdown: rendered.replace("\nShip - calmly", "\nShip aggressively"),
        signingKey,
        workspaceId: "dayova",
        dataSourceId
      })
    ).toThrow("changed outside");
  });
  it("uses fixed UTF-16 code-unit ordering for nested signed values", () => {
    const input = {
      z: 1,
      ä: 2,
      Z: 3,
      a: { z: 0, A: 1 },
      _: 4,
      "\uE000": 5,
      "😀": ["z", "a"]
    };
    const expected =
      '{"Z":3,"_":4,"a":{"A":1,"z":0},"z":1,"ä":2,"😀":["z","a"],"\uE000":5}';
    expect(canonicalDecisionJson(input)).toBe(expected);
    expect(
      canonicalDecisionJson(Object.fromEntries(Object.entries(input).reverse()))
    ).toBe(expected);
    expect(decisionDigest(input)).toBe(decisionDigest(JSON.parse(expected)));
  });
});
