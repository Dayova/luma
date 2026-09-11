import { describe, expect, it } from "vitest";
import {
  discordDecisionRecordConfigFromEnv,
  isExplicitDecisionRecordInstruction
} from "../../src/discord/discord-decision-record-runtime.js";

describe("Explicit Decision Record instruction admission", () => {
  it.each([
    "create a decision record based on the discussion above",
    "update the existing decision based on what we just decided",
    "record this decision",
    "Please create a Decision Record from the discussion above.",
    "Could you please record this decision?",
    "Bitte erstelle einen Decision Record aus der Diskussion oben.",
    "Kannst du bitte diese Entscheidung dokumentieren?",
    "Dokumentiere bitte diese Entscheidung.",
    "Halte diese Entscheidung bitte fest.",
    "Aktualisiere den bestehenden Decision Record."
  ])("routes an authenticated explicit instruction: %s", (instruction) => {
    expect(isExplicitDecisionRecordInstruction(instruction)).toBe(true);
  });
  it.each([
    "What is a Decision Record?",
    "Should we record this decision?",
    "How can you create a decision record?",
    "Do not record this decision.",
    "Please don't update the existing decision.",
    "Create a decision record, but not yet.",
    "Please record this decision, not now.",
    "Update the existing decision; please don't do that.",
    "Make a decision record, but wait.",
    "Document this decision, however do not execute it.",
    "Erstelle einen Decision Record, aber bitte noch nicht.",
    "We could create a decision record later.",
    'Jakob said: "record this decision".',
    "> record this decision",
    "`record this decision`",
    "Sollten wir diese Entscheidung dokumentieren?",
    "Bitte dokumentiere diese Entscheidung nicht.",
    "",
    "record this decision" + "x".repeat(2_000)
  ])("keeps questions, quotes and non-instructions out of write routing: %s", (text) => {
    expect(isExplicitDecisionRecordInstruction(text)).toBe(false);
  });
  it("requires an independent explicit bounded source configuration", () => {
    expect(
      discordDecisionRecordConfigFromEnv({ LUMA_DISCORD_CONTEXT_ASK_ENABLED: "1" })
    ).toBeUndefined();
    expect(() =>
      discordDecisionRecordConfigFromEnv({ LUMA_DISCORD_DECISION_RECORDS_ENABLED: "1" })
    ).toThrow("LUMA_DISCORD_DECISION_RECORDS_PARENT_CHANNEL_IDS");
    expect(
      discordDecisionRecordConfigFromEnv({
        LUMA_DISCORD_DECISION_RECORDS_ENABLED: "1",
        LUMA_DISCORD_DECISION_RECORDS_PARENT_CHANNEL_IDS: "parent",
        LUMA_DISCORD_DECISION_RECORDS_ALLOWED_DISCORD_USER_IDS: "founder"
      })
    ).toMatchObject({ parentChannelIds: ["parent"], allowedDiscordUserIds: ["founder"] });
  });
});
