import { describe, expect, it } from "vitest";
import { consultationSourceAuthorizationHash } from "../../src/consultation/source-proof.js";
import {
  conversationSnapshotContentHash,
  type RawConversationSnapshot
} from "../../src/knowledge/observed-source-ledger.js";

function snapshot(): RawConversationSnapshot {
  return {
    schemaVersion: 1,
    conversation: {
      conversationObjectId: "thread",
      parentConversationObjectId: "parent",
      title: "Release",
      url: "https://discord.com/channels/guild/thread"
    },
    boundary: {
      mode: "thread",
      anchorMessageId: "source",
      firstMessageId: "source",
      lastMessageId: "source",
      messageIds: ["source"]
    },
    messages: [
      {
        id: "source",
        ordinal: 0,
        author: { providerUserId: "founder", displayName: "Jakob", personId: "jakob" },
        createdAt: "2026-09-11T12:00:00Z",
        editedAt: null,
        replyToMessageId: null,
        url: "https://discord.com/channels/guild/thread/source",
        state: "available",
        text: "Consult the founders on the release.",
        poll: {
          question: "Release?",
          options: [
            { id: "1", text: "Proceed", emoji: null },
            { id: "2", text: "Pause", emoji: null }
          ],
          allowsMultiple: false,
          closesAt: "2026-09-12T12:00:00Z",
          wordingOrigin: "human",
          results: { status: "unknown", reason: "missing" }
        }
      }
    ],
    completeness: { state: "complete" }
  };
}

describe("consultation source authorization", () => {
  it("keeps authorization stable as votes and closure evolve while retaining full Evidence differences", () => {
    const original = snapshot();
    const unchanged = structuredClone(original);
    const authorization = consultationSourceAuthorizationHash(original);
    expect(original).toEqual(unchanged);
    const evolved = structuredClone(original);
    const message = evolved.messages[0]!;
    if (message.state !== "available" || !message.poll) throw new Error("fixture");
    message.poll.results = {
      status: "finalized",
      counts: [
        { optionId: "1", votes: 2 },
        { optionId: "2", votes: 1 }
      ]
    };
    message.poll.closesAt = "2026-09-11T12:05:00Z";
    expect(consultationSourceAuthorizationHash(evolved)).toBe(authorization);
    expect(conversationSnapshotContentHash(evolved)).not.toBe(
      conversationSnapshotContentHash(original)
    );
    expect(original).toEqual(unchanged);
  });

  it.each([
    "text",
    "question",
    "options",
    "author",
    "boundary",
    "deletion",
    "completeness",
    "editedAt",
    "multiple"
  ])("invalidates authorization when %s changes", (variant) => {
    const original = snapshot();
    const changed = structuredClone(original);
    const message = changed.messages[0]!;
    if (message.state !== "available" || !message.poll) throw new Error("fixture");
    if (variant === "text") message.text = "Do not publish this poll.";
    if (variant === "question") message.poll.question = "Purchase a server?";
    if (variant === "options") message.poll.options[0]!.text = "Defer";
    if (variant === "author") message.author.personId = "fabius";
    if (variant === "boundary") changed.boundary.anchorMessageId = "different-anchor";
    if (variant === "deletion") {
      const withoutPoll = { ...message };
      delete withoutPoll.poll;
      changed.messages[0] = { ...withoutPoll, state: "deleted", text: null };
    }
    if (variant === "completeness")
      changed.completeness = {
        state: "partial",
        reasons: [{ code: "history-truncated", message: "History is incomplete" }]
      };
    if (variant === "editedAt") message.editedAt = "2026-09-11T12:01:00Z";
    if (variant === "multiple") message.poll.allowsMultiple = true;
    expect(consultationSourceAuthorizationHash(changed)).not.toBe(
      consultationSourceAuthorizationHash(original)
    );
  });
});
