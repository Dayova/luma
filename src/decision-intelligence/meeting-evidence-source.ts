import type { DecisionEvidenceSource } from "./ports.js";
import type { DecisionAudience, DecisionSource } from "../domain/decision-records.js";
import type { EvidenceReference, MeetingState } from "../domain/model.js";
import type { LumaDatabase } from "../persistence/db.js";
import { decisionEvidenceReferenceSchema } from "../domain/decision-record-schemas.js";
import { decisionDigest } from "./persistence.js";

/** Membership/attendance alone is not proof of permission to disclose original speech. */
export interface MeetingDecisionSourceAudience {
  requireCurrent(input: {
    workspaceId: string;
    meetingId: string;
    audience: DecisionAudience;
  }): Promise<{ grantId: string }>;
}
export function createMeetingDecisionEvidenceSource(input: {
  database: LumaDatabase;
  audience: MeetingDecisionSourceAudience;
  requireContextCurrent(state: MeetingState): Promise<void>;
  now?: () => Date;
}): DecisionEvidenceSource {
  const capture = async (
    workspaceId: string,
    meetingId: string,
    audience: DecisionAudience
  ): Promise<DecisionSource> => {
    if (audience.workspaceId !== workspaceId)
      throw new Error("Meeting Decision audience belongs to another workspace");
    const grant = await input.audience.requireCurrent({
      workspaceId,
      meetingId,
      audience
    });
    if (!grant.grantId.trim())
      throw new Error("An original and current Meeting audience grant is required");
    const stateRow = (
      await input.database.query<{ state_json: string }>(
        `SELECT state_json FROM meetings WHERE workspace_id=$1 AND meeting_id=$2`,
        [workspaceId, meetingId]
      )
    ).rows[0];
    if (!stateRow) throw new Error("The actual Meeting was not found");
    const state = JSON.parse(stateRow.state_json) as MeetingState;
    await input.requireContextCurrent(state);
    const rows = (
      await input.database.query<{
        evidence_id: string;
        reference_json: string;
        excerpt: string | null;
      }>(
        `SELECT evidence_id,reference_json,excerpt FROM evidence WHERE workspace_id=$1 AND meeting_id=$2 AND active=TRUE ORDER BY evidence_id LIMIT 101`,
        [workspaceId, meetingId]
      )
    ).rows;
    if (!rows.length || rows.length > 100)
      throw new Error("Select a smaller complete Meeting source for Decision recording");
    const evidence = rows.map((row) => {
      const reference: EvidenceReference = decisionEvidenceReferenceSchema.parse(
        JSON.parse(row.reference_json)
      );
      if (reference.evidenceId !== row.evidence_id)
        throw new Error("Meeting source evidence identity changed");
      const human =
        reference.source === "transcript" || reference.source === "human-judgment";
      const author =
        human &&
        reference.participantId &&
        audience.personIds.includes(reference.participantId)
          ? reference.participantId
          : null;
      return {
        id: row.evidence_id,
        reference,
        text: row.excerpt ?? reference.excerpt ?? "",
        authorPersonId: author,
        origin: human ? ("human" as const) : ("provider-derived" as const)
      };
    });
    if (
      evidence.some((item) => !item.text.trim()) ||
      evidence.reduce((size, item) => size + item.text.length, 0) > 64000
    )
      throw new Error("Meeting Decision evidence is incomplete or too large");
    const proof = {
      subject: { type: "meeting" as const, meetingId },
      revision: String(state.revision),
      audience,
      evidence,
      grantId: grant.grantId
    };
    await input.requireContextCurrent(state);
    const currentGrant = await input.audience.requireCurrent({
      workspaceId,
      meetingId,
      audience
    });
    const head = (
      await input.database.query<{ revision: number }>(
        `SELECT revision FROM meetings WHERE workspace_id=$1 AND meeting_id=$2`,
        [workspaceId, meetingId]
      )
    ).rows[0];
    if (currentGrant.grantId !== grant.grantId || head?.revision !== state.revision)
      throw new Error("Meeting source or original audience changed during capture");
    const hash = decisionDigest(proof);
    return {
      subject: proof.subject,
      revision: proof.revision,
      audience,
      evidence,
      contentHash: hash,
      authorizationHash: hash,
      capturedAt: (input.now ?? (() => new Date()))().toISOString()
    };
  };
  return {
    capture: (request) => {
      if (request.subject.type !== "meeting")
        throw new Error("Expected an actual Meeting subject");
      return capture(
        request.workspace.workspaceId,
        request.subject.meetingId,
        request.audience
      );
    },
    requireCurrent: async (source) => {
      if (source.subject.type !== "meeting")
        throw new Error("Expected an actual Meeting subject");
      const current = await capture(
        source.audience.workspaceId,
        source.subject.meetingId,
        source.audience
      );
      if (
        current.authorizationHash !== source.authorizationHash ||
        current.contentHash !== source.contentHash ||
        decisionDigest({ ...current, capturedAt: null }) !==
          decisionDigest({ ...source, capturedAt: null })
      )
        throw new Error("Meeting Decision source is no longer current");
    }
  };
}
