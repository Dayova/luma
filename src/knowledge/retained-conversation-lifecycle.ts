import { createHash } from "node:crypto";
import type { LumaDatabase } from "../persistence/db.js";
import type {
  CapturedConversationEvidence,
  ConversationEvidenceSource
} from "../context-intelligence/conversation-evidence-source.js";

export class ConversationLifecycleChangedError extends Error {}

/** Provider events are observations, not proof of complete provider history. */
export type ConversationLifecycleObservation = {
  eventId: string;
  observedAt: string;
  conversationId: string;
} & (
  | {
      kind: "created" | "edited";
      messageId: string;
      text: string | null;
      providerVersion: string | null;
    }
  | { kind: "deleted"; messageId: string }
  | { kind: "excluded" }
);

export interface RetainedConversationLifecycle {
  observe(observation: ConversationLifecycleObservation): Promise<void>;
  /** New process / disconnected Gateway: old proofs cannot cross this coverage gap. */
  gap(eventId: string, observedAt: string): Promise<void>;
  capture(
    source: ConversationEvidenceSource,
    input: Parameters<ConversationEvidenceSource["capture"]>[0]
  ): Promise<CapturedConversationEvidence>;
  tracks(conversationId: string): Promise<boolean>;
}

export async function migrateConversationLifecycle(
  database: LumaDatabase
): Promise<void> {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS conversation_lifecycle_roots (
      workspace_id TEXT NOT NULL, provider_id TEXT NOT NULL,
      generation BIGINT NOT NULL DEFAULT 0, gap_id TEXT,
      PRIMARY KEY(workspace_id,provider_id)
    );
    CREATE TABLE IF NOT EXISTS conversation_lifecycle_channels (
      workspace_id TEXT NOT NULL, provider_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      parent_id TEXT NOT NULL, excluded BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY(workspace_id,provider_id,conversation_id)
    );
    CREATE TABLE IF NOT EXISTS conversation_lifecycle_events (
      sequence BIGSERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL, provider_id TEXT NOT NULL, event_id TEXT NOT NULL,
      conversation_id TEXT, message_id TEXT, kind TEXT NOT NULL,
      observed_at TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
      UNIQUE(workspace_id,provider_id,event_id)
    );
    CREATE INDEX IF NOT EXISTS conversation_lifecycle_message_idx
      ON conversation_lifecycle_events(workspace_id,provider_id,conversation_id,message_id,sequence DESC);
  `);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Retains only previously admitted conversations; never discovers new source scope. */
export function createRetainedConversationLifecycle(input: {
  database: LumaDatabase;
  workspaceId: string;
  providerId: string;
  allowedParentIds: readonly string[];
}): RetainedConversationLifecycle {
  const key = [input.workspaceId, input.providerId];
  const db = input.database;
  const allowed = new Set(input.allowedParentIds);
  async function append(
    tx: Pick<LumaDatabase, "query">,
    event: {
      eventId: string;
      observedAt: string;
      conversationId?: string;
      messageId?: string;
      kind: string;
      payload: unknown;
    }
  ): Promise<boolean> {
    const payload = JSON.stringify(event.payload);
    const hash = digest([
      event.kind,
      event.conversationId ?? null,
      event.messageId ?? null,
      event.payload
    ]);
    const result = await tx.query<{ payload_hash: string }>(
      `INSERT INTO conversation_lifecycle_events(workspace_id,provider_id,event_id,conversation_id,message_id,kind,observed_at,payload_json,payload_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_id,provider_id,event_id) DO NOTHING RETURNING payload_hash`,
      [
        ...key,
        event.eventId,
        event.conversationId ?? null,
        event.messageId ?? null,
        event.kind,
        event.observedAt,
        payload,
        hash
      ]
    );
    if (result.rows.length) {
      await tx.query(
        `UPDATE conversation_lifecycle_roots SET generation=generation+1 WHERE workspace_id=$1 AND provider_id=$2`,
        key
      );
      return true;
    }
    const previous = await tx.query<{ payload_hash: string }>(
      `SELECT payload_hash FROM conversation_lifecycle_events WHERE workspace_id=$1 AND provider_id=$2 AND event_id=$3`,
      [...key, event.eventId]
    );
    if (previous.rows[0]?.payload_hash !== hash)
      throw new Error("Conflicting retained conversation event identity");
    return false;
  }
  async function root(tx: Pick<LumaDatabase, "query">) {
    await tx.query(
      `INSERT INTO conversation_lifecycle_roots(workspace_id,provider_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      key
    );
    const result = await tx.query<{ generation: string; gap_id: string | null }>(
      `SELECT generation,gap_id FROM conversation_lifecycle_roots WHERE workspace_id=$1 AND provider_id=$2`,
      key
    );
    return result.rows[0]!;
  }
  return {
    async tracks(conversationId) {
      const result = await db.query(
        `SELECT 1 FROM conversation_lifecycle_channels WHERE workspace_id=$1 AND provider_id=$2 AND conversation_id=$3`,
        [...key, conversationId]
      );
      return result.rows.length > 0;
    },
    async gap(eventId, observedAt) {
      await db.transaction(async (tx) => {
        await root(tx);
        const known = await tx.query<{
          conversation_id: string;
          parent_id: string;
          excluded: boolean;
        }>(
          `SELECT conversation_id,parent_id,excluded FROM conversation_lifecycle_channels WHERE workspace_id=$1 AND provider_id=$2`,
          key
        );
        for (const channel of known.rows) {
          if (!channel.excluded && !allowed.has(channel.parent_id)) {
            await append(tx, {
              eventId: `${eventId}:scope:${channel.conversation_id}`,
              observedAt,
              conversationId: channel.conversation_id,
              kind: "excluded",
              payload: { state: "excluded", reason: "configuration" }
            });
            await tx.query(
              `UPDATE conversation_lifecycle_channels SET excluded=TRUE WHERE workspace_id=$1 AND provider_id=$2 AND conversation_id=$3`,
              [...key, channel.conversation_id]
            );
          }
        }
        if (
          (await append(tx, {
            eventId,
            observedAt,
            kind: "gap",
            payload: { coverage: "unknown" }
          })) &&
          known.rows.length
        )
          await tx.query(
            `UPDATE conversation_lifecycle_roots SET gap_id=$3 WHERE workspace_id=$1 AND provider_id=$2`,
            [...key, eventId]
          );
      });
    },
    async observe(observation) {
      if (!observation.eventId || !Number.isFinite(Date.parse(observation.observedAt)))
        throw new Error("Invalid conversation observation identity or timestamp");
      await db.transaction(async (tx) => {
        await root(tx);
        const channel = await tx.query<{ parent_id: string; excluded: boolean }>(
          `SELECT parent_id,excluded FROM conversation_lifecycle_channels WHERE workspace_id=$1 AND provider_id=$2 AND conversation_id=$3`,
          [...key, observation.conversationId]
        );
        const state = channel.rows[0];
        if (!state) return;
        if (
          observation.kind !== "excluded" &&
          (state.excluded || !allowed.has(state.parent_id))
        )
          return;
        const messageId = "messageId" in observation ? observation.messageId : undefined;
        await append(tx, {
          eventId: observation.eventId,
          observedAt: observation.observedAt,
          conversationId: observation.conversationId,
          ...(messageId ? { messageId } : {}),
          kind: observation.kind,
          payload:
            observation.kind === "created" || observation.kind === "edited"
              ? { text: observation.text, providerVersion: observation.providerVersion }
              : { state: observation.kind === "deleted" ? "deleted" : "excluded" }
        });
        if (observation.kind === "excluded")
          await tx.query(
            `UPDATE conversation_lifecycle_channels SET excluded=TRUE WHERE workspace_id=$1 AND provider_id=$2 AND conversation_id=$3`,
            [...key, observation.conversationId]
          );
      });
    },
    async capture(source, request) {
      if (
        request.workspaceId !== input.workspaceId ||
        request.subject.providerId !== input.providerId
      )
        throw new Error("Retained conversation workspace/provider mismatch");
      const before = await db.transaction((tx) => root(tx));
      const captured = await source.capture(request);
      return db.transaction(async (tx) => {
        const after = await root(tx);
        if (String(before.generation) !== String(after.generation))
          throw new ConversationLifecycleChangedError(
            "Conversation changed during current-source verification"
          );
        const snapshot = structuredClone(captured.snapshot);
        const conversationId = snapshot.conversation.conversationObjectId;
        const parentId = snapshot.conversation.parentConversationObjectId;
        if (
          conversationId !== request.subject.conversationObjectId ||
          !parentId ||
          !allowed.has(parentId)
        )
          throw new Error("Conversation is excluded by current source scope");
        const existing = await tx.query<{ excluded: boolean; parent_id: string }>(
          `SELECT excluded,parent_id FROM conversation_lifecycle_channels WHERE workspace_id=$1 AND provider_id=$2 AND conversation_id=$3`,
          [...key, conversationId]
        );
        if (
          existing.rows[0]?.excluded ||
          (existing.rows[0] && existing.rows[0].parent_id !== parentId)
        )
          throw new Error("Retained conversation is excluded or moved");
        await tx.query(
          `INSERT INTO conversation_lifecycle_channels(workspace_id,provider_id,conversation_id,parent_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [...key, conversationId, parentId]
        );
        const revisions: string[] = [];
        for (const message of snapshot.messages) {
          const events = await tx.query<{
            event_id: string;
            kind: string;
            payload_json: string;
          }>(
            `SELECT event_id,kind,payload_json FROM conversation_lifecycle_events WHERE workspace_id=$1 AND provider_id=$2 AND conversation_id=$3 AND message_id=$4 AND kind<>'snapshot' ORDER BY sequence DESC LIMIT 1`,
            [...key, conversationId, message.id]
          );
          const latest = events.rows[0];
          // A positive deletion event cannot be undone by a stale provider reread.
          if (latest?.kind === "deleted" && message.state !== "deleted")
            throw new Error("A confirmed deleted message was returned by the source");
          if (latest?.kind === "edited") {
            const payload = JSON.parse(latest.payload_json) as {
              text: string | null;
              providerVersion: string | null;
            };
            const provenNewer =
              payload.providerVersion &&
              message.editedAt &&
              Date.parse(message.editedAt) > Date.parse(payload.providerVersion);
            if (payload.text !== null && !provenNewer && message.text !== payload.text)
              throw new Error("Source reread contradicts the observed edit");
            if (
              payload.providerVersion &&
              (!message.editedAt ||
                Date.parse(message.editedAt) < Date.parse(payload.providerVersion))
            )
              throw new Error("Source reread is older than the observed edit");
          }
          const content = {
            state: message.state,
            text: message.text,
            editedAt: message.editedAt
          };
          // Rereads retain observed revisions too, but never infer deletion from absence.
          const observedId = `snapshot:${conversationId}:${message.id}:${digest(content)}`;
          await append(tx, {
            eventId: observedId,
            conversationId,
            messageId: message.id,
            observedAt: captured.observedAt,
            kind: "snapshot",
            payload: content
          });
          revisions.push(digest([message.id, latest?.event_id ?? observedId]));
        }
        snapshot.lifecycle = {
          revision: digest([after.gap_id, revisions]),
          coverage: "observed-only",
          gapObserved: after.gap_id !== null
        };
        return { ...captured, snapshot };
      });
    }
  };
}
