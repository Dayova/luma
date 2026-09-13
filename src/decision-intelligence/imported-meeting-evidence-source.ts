import type { DecisionAudience, DecisionSource } from "../domain/decision-records.js";
import { decisionSourceSchema } from "../domain/decision-record-schemas.js";
import type { MeetingImportedFromSource, MeetingState } from "../domain/model.js";
import { importedSourceObservationId } from "../domain/imported-source-provenance.js";
import type { ObservedSourceLedger } from "../knowledge/observed-source-ledger.js";
import { observedMeetingNoteToObservation } from "../knowledge/meeting-notes-ingestion.js";
import {
  currentImportedSourceReceiptIds,
  readImportedSourceAnalysisReceipt,
  type ImportedSourceAnalysisReceipt,
  type ImportedSourceHistoryAccess
} from "../meeting-intelligence/imported-source-analysis.js";
import type { LumaDatabase } from "../persistence/db.js";
import type { DecisionEvidenceSource, ProcessedDecisionEvidenceSource } from "./ports.js";
import { decisionDigest } from "./persistence.js";

export interface ImportedMeetingDecisionEvidenceSource
  extends DecisionEvidenceSource, ProcessedDecisionEvidenceSource {
  /** Read-only historical projection; exact current proof remains mandatory for writes. */
  authorizeRetained(input: {
    audience: DecisionAudience;
    source: DecisionSource;
  }): Promise<boolean>;
}

/** Only admitted original source leaves are included; analysis never becomes Human speech. */
export function createImportedMeetingDecisionEvidenceSource(input: {
  database: LumaDatabase;
  ledger: Pick<ObservedSourceLedger, "get">;
  sourceAccess: ImportedSourceHistoryAccess;
}): ImportedMeetingDecisionEvidenceSource {
  const load = async (workspaceId: string, meetingId: string, revision?: string) => {
    if (
      revision !== undefined &&
      (!/^[1-9]\d*$/u.test(revision) || !Number.isSafeInteger(Number(revision)))
    )
      throw unavailable();
    const rows = await input.database.query<{ state_json: string; created_at: string }>(
      revision === undefined
        ? "SELECT state_json,created_at FROM meeting_revisions WHERE workspace_id=$1 AND meeting_id=$2 AND revision=(SELECT revision FROM meetings WHERE workspace_id=$1 AND meeting_id=$2)"
        : "SELECT state_json,created_at FROM meeting_revisions WHERE workspace_id=$1 AND meeting_id=$2 AND revision=$3",
      revision === undefined
        ? [workspaceId, meetingId]
        : [workspaceId, meetingId, Number(revision)]
    );
    const row = rows.rows[0];
    if (!row) throw unavailable();
    const state = JSON.parse(row.state_json) as MeetingState;
    if (
      state.workspaceId !== workspaceId ||
      state.meetingId !== meetingId ||
      (revision !== undefined && String(state.revision) !== revision)
    )
      throw unavailable();
    return { state, capturedAt: row.created_at };
  };
  const assemble = async (
    workspaceId: string,
    meetingId: string,
    audience: DecisionAudience,
    revision?: string
  ) => {
    if (!validAudience(audience) || audience.workspaceId !== workspaceId)
      throw unavailable();
    const { state, capturedAt } = await load(workspaceId, meetingId, revision);
    const ids = await currentImportedSourceReceiptIds(input.database, state, true);
    if (!ids.length || ids.length > 20) throw unavailable();
    const receipts: ImportedSourceAnalysisReceipt[] = [];
    const evidence: DecisionSource["evidence"] = [];
    for (const id of ids) {
      const receipt = await readImportedSourceAnalysisReceipt(
        input.database,
        workspaceId,
        meetingId,
        id
      );
      if (
        !validAudience(receipt.audience) ||
        audience.personIds.some((person) => !receipt.audience.personIds.includes(person))
      )
        throw unavailable();
      const original = await input.ledger.get({
        workspaceId,
        source: {
          providerId: receipt.source.providerId,
          sourceKind: "meeting-note",
          sourceObjectId: receipt.source.sourceObjectId
        },
        revision: receipt.source.sourceRevision
      });
      if (!original || original.contentHash !== receipt.source.contentHash)
        throw unavailable();
      const expected = observedMeetingNoteToObservation(
        {
          workspace: { workspaceId, timezone: "UTC" },
          source: { ...original, change: "unchanged" }
        },
        receipt.source.workItemProviderId,
        receipt.source.implementationReferenceProviderId
      );
      const accepted = await input.database.query<{ payload_json: string }>(
        "SELECT payload_json FROM meeting_observations WHERE workspace_id=$1 AND meeting_id=$2 AND observation_id=$3 AND type='meeting-imported-from-source' AND accepted_revision<=$4",
        [
          workspaceId,
          meetingId,
          importedSourceObservationId(receipt.source),
          state.revision
        ]
      );
      const observation = accepted.rows[0]
        ? (JSON.parse(accepted.rows[0].payload_json) as MeetingImportedFromSource)
        : null;
      if (
        !observation ||
        expected.meetingId !== meetingId ||
        decisionDigest(expected.source) !== decisionDigest(receipt.source) ||
        decisionDigest(observation.source) !== decisionDigest(receipt.source) ||
        decisionDigest(observation.evidence) !== decisionDigest(expected.evidence) ||
        decisionDigest([...receipt.evidenceIds].sort()) !==
          decisionDigest(expected.evidence.map((entry) => entry.evidenceId).sort())
      )
        throw unavailable();
      receipts.push(receipt);
      for (const reference of expected.evidence) {
        if (!reference.excerpt?.trim()) continue;
        evidence.push({
          id: reference.evidenceId,
          reference,
          text: reference.excerpt,
          // Imported transcript sections contain no provider identity proof for
          // a particular utterance. Names, attendees and summaries cannot supply it.
          authorPersonId: null,
          origin: reference.source === "transcript" ? "human" : "provider-derived"
        });
      }
    }
    evidence.sort((left, right) => left.id.localeCompare(right.id));
    if (evidence.reduce((size, entry) => size + entry.text.length, 0) > 64_000)
      throw unavailable();
    const proof = {
      subject: { type: "meeting" as const, meetingId },
      revision: String(state.revision),
      audience: { workspaceId, personIds: [...audience.personIds].sort() },
      evidence,
      receiptIds: receipts.map((receipt) => receipt.id).sort(),
      capturedAt
    };
    const digest = decisionDigest(proof);
    const source = decisionSourceSchema.parse({
      subject: proof.subject,
      revision: proof.revision,
      audience: proof.audience,
      evidence,
      contentHash: digest,
      authorizationHash: digest,
      capturedAt
    });
    return { source, receipts };
  };
  const prove = async (
    source: DecisionSource,
    receipts: ImportedSourceAnalysisReceipt[],
    audience: DecisionAudience,
    retained: boolean
  ) => {
    for (const receipt of receipts) {
      const request = {
        source: structuredClone(receipt.source),
        audience: structuredClone(audience)
      };
      if (retained) await input.sourceAccess.requireRetained(request);
      else await input.sourceAccess.requireCurrent(request);
    }
    if (!retained) {
      if (source.subject.type !== "meeting") throw unavailable();
      const head = await load(source.audience.workspaceId, source.subject.meetingId);
      if (String(head.state.revision) !== source.revision) throw unavailable();
    }
  };
  const original = async (source: DecisionSource) => {
    if (source.subject.type !== "meeting") throw unavailable();
    const proof = await assemble(
      source.audience.workspaceId,
      source.subject.meetingId,
      source.audience,
      source.revision
    );
    if (decisionDigest(proof.source) !== decisionDigest(source)) throw unavailable();
    return proof;
  };
  const captureProcessed: ProcessedDecisionEvidenceSource["captureProcessed"] = async (
    request
  ) => {
    request = structuredClone(request);
    if (request.subject.type !== "meeting") throw unavailable();
    const proof = await assemble(
      request.workspace.workspaceId,
      request.subject.meetingId,
      request.audience
    );
    await prove(proof.source, proof.receipts, request.audience, false);
    return proof.source;
  };
  return {
    captureProcessed,
    capture: captureProcessed,
    async requireCurrent(source) {
      source = structuredClone(source);
      const proof = await original(source);
      await prove(source, proof.receipts, source.audience, false);
    },
    async authorizeRetained(request) {
      try {
        const { source, audience } = structuredClone(request);
        if (
          !validAudience(audience) ||
          audience.workspaceId !== source.audience.workspaceId ||
          audience.personIds.some((person) => !source.audience.personIds.includes(person))
        )
          return false;
        const proof = await original(source);
        await prove(source, proof.receipts, audience, true);
        return true;
      } catch {
        return false;
      }
    }
  };
}
function validAudience(audience: DecisionAudience): boolean {
  return (
    !!audience.workspaceId.trim() &&
    audience.personIds.length > 0 &&
    audience.personIds.length <= 100 &&
    new Set(audience.personIds).size === audience.personIds.length &&
    audience.personIds.every((id) => !!id.trim())
  );
}
function unavailable(): Error {
  return new Error(
    "The imported Meeting's original evidence, admitted audience or current source access could not be verified."
  );
}
