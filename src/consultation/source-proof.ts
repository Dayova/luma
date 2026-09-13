import {
  conversationSnapshotContentHash,
  type RawConversationSnapshot
} from "../knowledge/observed-source-ledger.js";

/** Poll results/closure evolve without rewriting the instruction authorizing consultation. */
export function consultationSourceAuthorizationHash(
  snapshot: RawConversationSnapshot
): string {
  const stable = structuredClone(snapshot);
  for (const message of stable.messages) {
    if (message.state !== "available" || !message.poll) continue;
    message.poll.results = { status: "unknown", reason: "missing" };
    message.poll.closesAt = null;
  }
  return conversationSnapshotContentHash(stable);
}
