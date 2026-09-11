import { describe, expect, it } from "vitest";
import {
  canonicalSynthesisJson,
  parseMeetingSynthesisSection,
  renderMeetingSynthesisSection
} from "../../src/knowledge/meeting-synthesis-markdown.js";
import type { MeetingSynthesisPublication } from "../../src/knowledge/meeting-synthesis-writer.js";
const key = "local-only-synthesis-format-key-at-least-thirty-two-bytes";
function publication(text: string): MeetingSynthesisPublication {
  return {
    workspaceId: "dayova",
    logicalMeetingId: "meeting-1",
    intentId: "approved-1",
    operationToken: "retained-1",
    audience: { workspaceId: "dayova", personIds: ["person_jakob"] },
    anchor: null,
    synthesis: {
      workspaceId: "dayova",
      logicalMeetingId: "meeting-1",
      revision: 1,
      sourceSetDigest: "original-source-set",
      producedAt: "2026-09-11T09:00:00Z",
      sources: [],
      canonicalAnchorRef: null,
      coverage: "partial",
      claims: [
        {
          id: "claim-1",
          stableKey: "action-1",
          kind: "action-item",
          text,
          authority: "human-corrected",
          confidence: "high",
          citations: [],
          quotations: [],
          conflictingClaimIds: [],
          actionReview: {
            modality: "request",
            ownerPersonId: null,
            dueDate: null,
            participantId: "person_jakob",
            judgedAt: "2026-09-11T09:00:00Z"
          }
        }
      ]
    }
  };
}
describe("signed synthesis text round trips", () => {
  it.each([
    ["- First action", "\\- First action"],
    ["+ First action", "\\+ First action"],
    ["12. First action", "12\\. First action"],
    ["  - First action", "  \\- First action"]
  ])("keeps %s literal alongside retained Human action details", (text, escaped) => {
    const plan = publication(text),
      rendered = renderMeetingSynthesisSection(plan, key);
    expect(rendered).toContain(`\n${escaped}\n`);
    expect(rendered).toContain(
      "Human action details: request · Owner: intentionally unassigned · Due: explicitly none · Reviewed by: person\\_jakob"
    );
    const roundTrip = rendered
      .split("\n")
      .filter((line) => line !== "")
      .join("\n");
    expect(parseMeetingSynthesisSection(roundTrip, key)?.publication).toEqual(plan);
  });
  it("uses fixed code-unit ordering independent of object insertion order", () => {
    const value = { z: 0, ä: 1, Z: 2, a: { z: 3, A: 4 }, "😀": 5, "\uE000": 6 };
    const expected = '{"Z":2,"a":{"A":4,"z":3},"z":0,"ä":1,"😀":5,"\uE000":6}';
    expect(canonicalSynthesisJson(value)).toBe(expected);
    expect(
      canonicalSynthesisJson(Object.fromEntries(Object.entries(value).reverse()))
    ).toBe(expected);
  });
});
