import type { LumaDatabase } from "../persistence/db.js";
import type {
  LumaSynthesis,
  PublishMeetingSynthesisIntent
} from "../domain/meeting-capture-synthesis.js";
import type { ContextAudience } from "../organizational-context/interface.js";
import type {
  FollowUpExecutionRecorded,
  FollowUpIntentApproved,
  FollowUpIntentRejected,
  MeetingObservation
} from "../domain/model.js";
import type { MeetingUpdate, ObserveMeeting } from "./interface.js";
import type {
  MeetingSynthesisPublication,
  MeetingSynthesisPublicationReceipt
} from "../knowledge/meeting-synthesis-writer.js";
import { synthesisDigest } from "../knowledge/meeting-synthesis-markdown.js";

export type SynthesisPublicationObservation =
  FollowUpIntentApproved | FollowUpIntentRejected | FollowUpExecutionRecorded;
export type SynthesisPublicationState = {
  intent: PublishMeetingSynthesisIntent;
  audience: ContextAudience;
  plan: MeetingSynthesisPublication | null;
  executionLeaseId: string | null;
  phase: "unclaimed" | "prepared" | "dispatching" | "applied" | "recorded";
  applied: MeetingSynthesisPublicationReceipt | null;
  anchorStatus?: "recorded" | "conflict";
  pendingObservation: FollowUpExecutionRecorded | null;
};
const migrations = new WeakMap<LumaDatabase, Promise<void>>();
class InvalidPublicationObservation extends Error {}
export function isSynthesisPublicationIntent(id: string): boolean {
  return /^publish-synthesis:[a-f0-9]{64}$/u.test(id);
}
export function isSynthesisPublicationObservation(
  o: MeetingObservation
): o is SynthesisPublicationObservation {
  return (
    (o.type === "follow-up-intent-approved" ||
      o.type === "follow-up-intent-rejected" ||
      o.type === "follow-up-execution-recorded") &&
    isSynthesisPublicationIntent(o.intentId)
  );
}
export function migrateSynthesisPublications(database: LumaDatabase): Promise<void> {
  let result = migrations.get(database);
  if (!result) {
    result = database
      .exec(
        `
    CREATE TABLE IF NOT EXISTS meeting_synthesis_publications (workspace_id TEXT NOT NULL, meeting_id TEXT NOT NULL, intent_id TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(workspace_id,meeting_id,intent_id));
    CREATE TABLE IF NOT EXISTS meeting_synthesis_publication_observations (workspace_id TEXT NOT NULL, observation_id TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(workspace_id,observation_id));
    CREATE TABLE IF NOT EXISTS meeting_synthesis_publication_locks (workspace_id TEXT NOT NULL, meeting_id TEXT NOT NULL, intent_id TEXT NOT NULL, PRIMARY KEY(workspace_id,meeting_id));
  `
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        migrations.delete(database);
        throw error;
      });
    migrations.set(database, result);
  }
  return result;
}
export async function readSynthesisPublication(
  database: LumaDatabase,
  workspaceId: string,
  meetingId: string,
  intentId: string
): Promise<SynthesisPublicationState | null> {
  await migrateSynthesisPublications(database);
  const result = await database.query<{ state_json: string }>(
    "SELECT state_json FROM meeting_synthesis_publications WHERE workspace_id=$1 AND meeting_id=$2 AND intent_id=$3",
    [workspaceId, meetingId, intentId]
  );
  return result.rows[0]
    ? (JSON.parse(result.rows[0].state_json) as SynthesisPublicationState)
    : null;
}
export async function projectSynthesisPublication(
  database: LumaDatabase,
  synthesis: LumaSynthesis,
  audience: ContextAudience
): Promise<PublishMeetingSynthesisIntent> {
  await migrateSynthesisPublications(database);
  const id = `publish-synthesis:${synthesisDigest([synthesis.workspaceId, synthesis.logicalMeetingId, synthesis.revision, synthesis.sourceSetDigest, audience])}`;
  const intent: PublishMeetingSynthesisIntent = {
    id,
    type: "publish-meeting-synthesis",
    title: `Publish Luma Synthesis revision ${synthesis.revision}`,
    synthesisRevision: synthesis.revision,
    sourceSetDigest: synthesis.sourceSetDigest,
    status: "suggested",
    relatedMeetingItemIds: synthesis.claims.map((claim) => claim.id),
    provenance: {
      evidence: synthesis.claims.flatMap((claim) =>
        claim.citations.map((citation) => ({
          evidenceId: citation.evidenceId,
          source: "knowledge" as const,
          sourceObjectId: citation.materialId,
          sourceVersion: String(citation.sourceRevision),
          externalReference: citation.externalReference
        }))
      ),
      confidence: "medium",
      producedAtRevision: synthesis.revision,
      analysisVersion: "capture-synthesis-v1"
    }
  };
  const state: SynthesisPublicationState = {
    intent,
    audience: structuredClone(audience),
    plan: null,
    executionLeaseId: null,
    phase: "unclaimed",
    applied: null,
    pendingObservation: null
  };
  await database.query(
    "INSERT INTO meeting_synthesis_publications(workspace_id,meeting_id,intent_id,state_json) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [synthesis.workspaceId, synthesis.logicalMeetingId, id, JSON.stringify(state)]
  );
  return (await readSynthesisPublication(
    database,
    synthesis.workspaceId,
    synthesis.logicalMeetingId,
    id
  ))!.intent;
}
export async function observeSynthesisPublication(input: {
  database: LumaDatabase;
  request: ObserveMeeting;
  current(): Promise<{ synthesis: LumaSynthesis; intent: PublishMeetingSynthesisIntent }>;
}): Promise<MeetingUpdate> {
  const observation = input.request.observations[0];
  if (
    !observation ||
    !isSynthesisPublicationObservation(observation) ||
    input.request.observations.length !== 1 ||
    observation.workspaceId !== input.request.workspace.workspaceId
  )
    throw new Error("Invalid synthesis publication Observation");
  const result: MeetingUpdate = {
    workspaceId: observation.workspaceId,
    meetingId: observation.meetingId,
    revision: 0,
    acceptedObservationIds: [],
    duplicateObservationIds: [],
    analysisStatus: "not-needed",
    interventions: [],
    events: [],
    errors: []
  };
  let stage: "validation" | "source-proof" | "migration" | "transaction" = "validation";
  try {
    for (const value of [
      observation.observationId,
      observation.meetingId,
      observation.workspaceId
    ])
      if (typeof value !== "string" || !value.trim() || value.length > 1024)
        throw new InvalidPublicationObservation("Invalid publication scope");
    for (const value of [observation.occurredAt, observation.observedAt])
      if (!Number.isFinite(Date.parse(value)))
        throw new InvalidPublicationObservation("Invalid publication timestamp");
    if (observation.type !== "follow-up-execution-recorded") {
      stage = "source-proof";
      const current = await input.current();
      result.revision = current.synthesis.revision;
      if (current.intent.id !== observation.intentId)
        throw new InvalidPublicationObservation("Synthesis approval is stale");
    }
    stage = "migration";
    await migrateSynthesisPublications(input.database);
    stage = "transaction";
    await input.database.transaction(async (tx) => {
      const row = await tx.query<{ state_json: string }>(
        "SELECT state_json FROM meeting_synthesis_publications WHERE workspace_id=$1 AND meeting_id=$2 AND intent_id=$3 FOR UPDATE",
        [observation.workspaceId, observation.meetingId, observation.intentId]
      );
      if (!row.rows[0])
        throw new InvalidPublicationObservation("Publication intent not found");
      const state = JSON.parse(row.rows[0].state_json) as SynthesisPublicationState;
      result.revision = state.intent.synthesisRevision;
      const duplicate = await tx.query<{ payload_json: string }>(
        "SELECT payload_json FROM meeting_synthesis_publication_observations WHERE workspace_id=$1 AND observation_id=$2",
        [observation.workspaceId, observation.observationId]
      );
      if (duplicate.rows[0]) {
        if (
          synthesisDigest(JSON.parse(duplicate.rows[0].payload_json)) !==
          synthesisDigest(observation)
        )
          throw new InvalidPublicationObservation("Conflicting publication Observation");
        result.duplicateObservationIds = [observation.observationId];
        return;
      }
      if (observation.type === "follow-up-execution-recorded") {
        if (
          state.executionLeaseId !== observation.executionLeaseId ||
          !state.pendingObservation ||
          synthesisDigest(state.pendingObservation) !== synthesisDigest(observation)
        )
          throw new InvalidPublicationObservation("Unclaimed publication outcome");
        state.intent.status =
          observation.outcome.status === "succeeded"
            ? "succeeded"
            : observation.outcome.status === "partially-succeeded"
              ? "partially-succeeded"
              : observation.outcome.requiresManualRecovery
                ? "requires-manual-recovery"
                : "failed";
        state.phase = "recorded";
        if (observation.outcome.status === "succeeded")
          result.events = [
            {
              type: "follow-up-execution-succeeded",
              intentId: observation.intentId,
              externalReferences: observation.outcome.externalReferences,
              summary: "Luma Synthesis published."
            }
          ];
        else
          result.events = [
            {
              type: "follow-up-execution-failed",
              intentId: observation.intentId,
              message: "Synthesis publication requires review.",
              retryable: false
            }
          ];
      } else {
        if (
          !["suggested", "approved", "rejected"].includes(state.intent.status) ||
          state.phase !== "unclaimed"
        )
          throw new InvalidPublicationObservation(
            "Publication has already entered execution"
          );
        const actor =
          observation.type === "follow-up-intent-approved"
            ? observation.approvedBy
            : observation.rejectedBy;
        if (!state.audience.personIds.includes(actor))
          throw new InvalidPublicationObservation(
            "Publication actor is outside its recipients"
          );
        state.intent.status =
          observation.type === "follow-up-intent-approved" ? "approved" : "rejected";
      }
      await tx.query(
        "INSERT INTO meeting_synthesis_publication_observations(workspace_id,observation_id,payload_json) VALUES($1,$2,$3)",
        [observation.workspaceId, observation.observationId, JSON.stringify(observation)]
      );
      await tx.query(
        "UPDATE meeting_synthesis_publications SET state_json=$4 WHERE workspace_id=$1 AND meeting_id=$2 AND intent_id=$3",
        [
          observation.workspaceId,
          observation.meetingId,
          observation.intentId,
          JSON.stringify(state)
        ]
      );
      result.acceptedObservationIds = [observation.observationId];
    });
    if (observation.type !== "follow-up-execution-recorded") {
      stage = "source-proof";
      const current = await input.current();
      if (current.intent.id !== observation.intentId)
        throw new InvalidPublicationObservation(
          "Synthesis source changed during approval"
        );
    }
    return result;
  } catch (error) {
    const invalid = error instanceof InvalidPublicationObservation;
    if (!invalid) {
      // Raw database errors can contain source text and credentials in query
      // parameters. Retain the operational category, never their message/stack.
      console.error("Luma synthesis publication unavailable", {
        event: "synthesis-publication-unavailable",
        stage,
        errorKind:
          error instanceof SyntaxError ? "invalid-persisted-json" : "operation-failed"
      });
    }
    return {
      ...result,
      acceptedObservationIds: [],
      duplicateObservationIds: [],
      events: [],
      errors: [
        invalid
          ? {
              code: "invalid-observation",
              observationId: observation.observationId,
              message:
                "Synthesis publication is unavailable, stale, or not authorized for this actor.",
              retryable: false
            }
          : {
              code: "publication-unavailable",
              observationId: observation.observationId,
              message:
                "Synthesis publication is unavailable, stale, or not authorized for this actor.",
              retryable: true
            }
      ]
    };
  }
}
