import { describe, expect, it } from "vitest";
import { discordPollEvidence } from "../../src/discord/discord-poll-evidence.js";

const poll = () => ({
  question: { text: "Adopt the idea?" },
  answers: [
    { answer_id: 5, poll_media: { text: "Pause" } },
    { answer_id: 9, poll_media: { text: "Adopt", emoji: { name: "✅" } } }
  ],
  expiry: "2026-09-10T12:00:00Z",
  allow_multiselect: true,
  layout_type: 1
});
describe("fresh Discord poll result semantics", () => {
  it("keeps missing results unknown even after expiry", () => {
    expect(discordPollEvidence(poll(), "human")).toMatchObject({
      wordingOrigin: "human",
      allowsMultiple: true,
      options: [{ id: "5" }, { id: "9" }],
      results: { status: "unknown", reason: "missing" }
    });
  });
  it("assigns zero only to omitted options within valid provider results and preserves generated wording", () => {
    expect(
      discordPollEvidence(
        {
          ...poll(),
          results: {
            is_finalized: false,
            answer_counts: [{ id: 5, count: 2, me_voted: false }]
          }
        },
        "luma-generated"
      )
    ).toMatchObject({
      wordingOrigin: "luma-generated",
      results: {
        status: "provisional",
        counts: [
          { optionId: "5", votes: 2 },
          { optionId: "9", votes: 0 }
        ]
      }
    });
  });
  it("uses provider finalization, not time or an inferred voter total", () => {
    const result = discordPollEvidence(
      {
        ...poll(),
        results: {
          is_finalized: true,
          answer_counts: [
            { id: 5, count: 3 },
            { id: 9, count: 3 }
          ]
        }
      },
      "human"
    );
    expect(result?.results.status).toBe("finalized");
    expect(result).not.toHaveProperty("voterCount");
    expect(result).not.toHaveProperty("consensus");
  });
  it.each([
    null,
    {},
    { is_finalized: true, answer_counts: [{ id: 77, count: 1 }] },
    {
      is_finalized: true,
      answer_counts: [
        { id: 5, count: 1 },
        { id: 5, count: 1 }
      ]
    }
  ])("keeps malformed results unknown: %j", (results) => {
    expect(discordPollEvidence({ ...poll(), results }, "human")?.results).toEqual({
      status: "unknown",
      reason: "malformed"
    });
  });
  it("refuses unsupported layouts and duplicate or empty options", () => {
    expect(discordPollEvidence({ ...poll(), layout_type: 9 }, "human")).toBeNull();
    expect(
      discordPollEvidence(
        { ...poll(), answers: [poll().answers[0], poll().answers[0]] },
        "human"
      )
    ).toBeNull();
    expect(
      discordPollEvidence(
        { ...poll(), answers: [{ answer_id: 1, poll_media: {} }] },
        "human"
      )
    ).toBeNull();
  });
});
