import type { MeetingState } from "../domain/model.js";
import type {
  DecisionAudience,
  DecisionSource,
  DecisionEvidence
} from "../domain/decision-records.js";
import { decisionSourceSchema } from "../domain/decision-record-schemas.js";
import type { CaptureSynthesisConfiguration } from "../meeting-intelligence/meeting-capture-access.js";
import { readProcessedCaptureEvidence } from "../meeting-intelligence/processed-capture-evidence.js";
import type { LogicalMeetingCaptureRef } from "../logical-meetings/interface.js";
import type { LumaDatabase } from "../persistence/db.js";
import type { DecisionEvidenceSource, ProcessedDecisionEvidenceSource } from "./ports.js";
import { decisionDigest } from "./persistence.js";

export const LOGICAL_CAPTURE_DECISION_REVISION_PREFIX = "logical-capture:";
export interface LogicalMeetingDecisionEvidenceSource
  extends DecisionEvidenceSource, ProcessedDecisionEvidenceSource {
  /** Resolve a current positive LogicalMeeting or admitted imported Meeting binding, read-only. */
  resolveMeeting(input: {
    workspaceId: string;
    meetingId: string;
    audience: DecisionAudience;
  }): Promise<string | null>;
  authorizeRetained(input: {
    audience: DecisionAudience;
    source: DecisionSource;
  }): Promise<boolean>;
}
type Receipt = {
  sourceHash: string;
  originalAudience: DecisionAudience;
  captures: Array<{
    id: string;
    bindingHash: string;
    authorizationScopeId: string;
    materialIds: string[];
  }>;
};
const unavailable = () =>
  new Error(
    "Logical Meeting Decision source, original audience or Human review changed."
  );
const bindingHash = (capture: LogicalMeetingCaptureRef) =>
  decisionDigest({
    id: capture.id,
    address: capture.address,
    binding: capture.binding,
    admission: capture.admission
  });
const sortedAudience = (audience: DecisionAudience) => ({
  ...audience,
  personIds: [...audience.personIds].sort()
});
const validAudience = (audience: DecisionAudience) =>
  audience.personIds.length > 0 &&
  new Set(audience.personIds).size === audience.personIds.length;
/** Actual original captures, independently admitted for Decisions; no fabricated Meeting state. */
export function createLogicalMeetingDecisionEvidenceSource(input: {
  database: LumaDatabase;
  configuration: CaptureSynthesisConfiguration;
}): LogicalMeetingDecisionEvidenceSource {
  let migration: Promise<void> | undefined;
  const migrate = () =>
    (migration ??= input.database
      .exec(
        `CREATE TABLE IF NOT EXISTS logical_meeting_decision_source_receipts(workspace_id TEXT NOT NULL, meeting_id TEXT NOT NULL, content_hash TEXT NOT NULL, receipt_json TEXT NOT NULL, receipt_hash TEXT NOT NULL, PRIMARY KEY(workspace_id,meeting_id,content_hash))`
      )
      .then(() => undefined));
  const assemble = async (
    workspaceId: string,
    meetingId: string,
    audience: DecisionAudience
  ) => {
    if (!validAudience(audience) || workspaceId !== audience.workspaceId)
      throw unavailable();
    const prepared = await readProcessedCaptureEvidence({
      ...input,
      workspaceId,
      meetingId,
      audience: sortedAudience(audience)
    });
    const evidence: DecisionEvidence[] = prepared.materials.map((material) => ({
      id: material.evidenceId,
      reference: {
        evidenceId: material.evidenceId,
        source:
          material.descriptor.provenance === "original-speech"
            ? "transcript"
            : "knowledge",
        sourceObjectId: material.descriptor.sourceObjectId,
        sourceVersion: material.descriptor.sourceVersion,
        externalReference: material.descriptor.externalReference,
        excerpt: material.text
      },
      text: material.text,
      authorPersonId: null,
      origin:
        material.descriptor.provenance === "original-speech"
          ? "human"
          : "provider-derived"
    }));
    for (const { observation, claim } of prepared.reviews) {
      const id = `capture-review:${decisionDigest(observation)}`;
      const text = JSON.stringify({
        type: observation.type,
        judgment: observation.judgment,
        claimId: observation.claimId,
        expectedSynthesisRevision: observation.expectedSynthesisRevision
      });
      evidence.push({
        id,
        text,
        authorPersonId: observation.participantId,
        origin: "human",
        purpose: "capture-synthesis-review",
        captureReview: {
          action: observation.judgment.kind,
          claimId: claim.id,
          revision: observation.expectedSynthesisRevision,
          reviewedText: claim.text,
          evidenceIds: [
            ...new Set(
              claim.citations.flatMap((citation) => [
                citation.evidenceId,
                ...prepared.materials
                  .filter(
                    (material) =>
                      material.captureId === citation.captureId &&
                      material.descriptor.sourceObjectId === citation.materialId
                  )
                  .map((material) => material.evidenceId)
              ])
            )
          ],
          ...(observation.judgment.kind === "correct"
            ? { correctedText: observation.judgment.text }
            : {})
        },
        reference: {
          evidenceId: id,
          source: "human-judgment",
          sourceObjectId: observation.observationId,
          sourceVersion: String(observation.expectedSynthesisRevision),
          participantId: observation.participantId,
          excerpt: text
        }
      });
    }
    evidence.sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    );
    if (
      evidence.reduce(
        (total, item) =>
          total + item.text.length + (item.captureReview?.reviewedText.length ?? 0),
        0
      ) > 64_000
    )
      throw unavailable();
    const captures = prepared.meeting.captureRefs
      .map((capture) => ({
        id: capture.id,
        bindingHash: bindingHash(capture),
        sourceRevision: capture.latestRevision.sourceRevision,
        contentHash: capture.latestRevision.contentHash,
        materialIds: capture.latestRevision.materials
          .map((material) => material.sourceObjectId)
          .sort(),
        authorizationScopeId: prepared.authorizationScopes[capture.id]!
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const proof = {
      subject: { type: "meeting" as const, meetingId },
      audience: sortedAudience(audience),
      evidence,
      captures
    };
    const hash = decisionDigest(proof);
    const source = decisionSourceSchema.parse({
      subject: proof.subject,
      audience: proof.audience,
      evidence,
      revision: `${LOGICAL_CAPTURE_DECISION_REVISION_PREFIX}${hash}`,
      contentHash: hash,
      authorizationHash: hash,
      capturedAt: [
        ...prepared.meeting.captureRefs.map(
          (capture) => capture.latestRevision.capturedAt
        ),
        ...prepared.reviews.map((review) => review.observation.observedAt)
      ]
        .sort()
        .at(-1)!
    });
    const receipt: Receipt = {
      sourceHash: decisionDigest(source),
      originalAudience: sortedAudience(audience),
      captures: captures.map(
        ({ id, bindingHash, authorizationScopeId, materialIds }) => ({
          id,
          bindingHash,
          authorizationScopeId,
          materialIds
        })
      )
    };
    return { source, receipt };
  };
  const original = async (source: DecisionSource) => {
    source = decisionSourceSchema.parse(source);
    if (
      source.subject.type !== "meeting" ||
      !source.revision.startsWith(LOGICAL_CAPTURE_DECISION_REVISION_PREFIX)
    )
      throw unavailable();
    // Read-only proof never creates a receipt or migration.
    const result = await input.database.query<{
      receipt_json: string;
      receipt_hash: string;
    }>(
      "SELECT receipt_json,receipt_hash FROM logical_meeting_decision_source_receipts WHERE workspace_id=$1 AND meeting_id=$2 AND content_hash=$3",
      [source.audience.workspaceId, source.subject.meetingId, source.contentHash]
    );
    if (!result.rows[0]) throw unavailable();
    const receipt = JSON.parse(result.rows[0].receipt_json) as Receipt;
    if (
      result.rows[0].receipt_hash !== decisionDigest(receipt) ||
      receipt.sourceHash !== decisionDigest(source) ||
      decisionDigest(receipt.originalAudience) !==
        decisionDigest(sortedAudience(source.audience))
    )
      throw unavailable();
    return receipt;
  };
  const requireCurrent = async (source: DecisionSource) => {
    source = structuredClone(source);
    await original(source);
    if (source.subject.type !== "meeting") throw unavailable();
    const current = await assemble(
      source.audience.workspaceId,
      source.subject.meetingId,
      source.audience
    );
    if (decisionDigest(current.source) !== decisionDigest(source)) throw unavailable();
  };
  const captureProcessed: ProcessedDecisionEvidenceSource["captureProcessed"] = async (
    request
  ) => {
    request = structuredClone(request);
    if (request.subject.type !== "meeting") throw unavailable();
    const current = await assemble(
      request.workspace.workspaceId,
      request.subject.meetingId,
      request.audience
    );
    await migrate();
    await input.database.query(
      "INSERT INTO logical_meeting_decision_source_receipts(workspace_id,meeting_id,content_hash,receipt_json,receipt_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,meeting_id,content_hash) DO NOTHING",
      [
        request.workspace.workspaceId,
        request.subject.meetingId,
        current.source.contentHash,
        JSON.stringify(current.receipt),
        decisionDigest(current.receipt)
      ]
    );
    await requireCurrent(current.source);
    return current.source;
  };
  return {
    async resolveMeeting({ workspaceId, meetingId, audience }) {
      try {
        const direct = await input.configuration.logicalMeetings.get({
          workspaceId,
          logicalMeetingId: meetingId
        });
        if (direct) {
          await readProcessedCaptureEvidence({
            ...input,
            workspaceId,
            meetingId,
            audience
          });
          return meetingId;
        }
        const load = () =>
          input.database.query<{ state_json: string }>(
            "SELECT state_json FROM meetings WHERE workspace_id=$1 AND meeting_id=$2",
            [workspaceId, meetingId]
          );
        const row = (await load()).rows[0];
        if (!row) return null;
        const state = JSON.parse(row.state_json) as MeetingState;
        if (
          state.workspaceId !== workspaceId ||
          state.meetingId !== meetingId ||
          !state.importedSources.length
        )
          return null;
        const latest = new Map<string, MeetingState["importedSources"][number]>();
        for (const source of state.importedSources) {
          const key = decisionDigest([source.providerId, source.sourceObjectId]);
          if (!latest.has(key) || latest.get(key)!.sourceRevision < source.sourceRevision)
            latest.set(key, source);
        }
        if (latest.size > 8) return null;
        const ids = new Set<string>();
        const matched: Array<{ captureId: string; revision: number; hash: string }> = [];
        for (const source of latest.values()) {
          const rows = await input.database.query<{ capture_id: string }>(
            "SELECT capture_id FROM meeting_captures WHERE workspace_id=$1 AND provider_id=$2 AND external_capture_id=$3 AND source_kind='meeting-note' LIMIT 2",
            [workspaceId, source.providerId, source.sourceObjectId]
          );
          if (rows.rows.length !== 1) return null;
          const meeting = await input.configuration.logicalMeetings.get({
            workspaceId,
            captureId: rows.rows[0]!.capture_id
          });
          const capture = meeting?.captureRefs.find(
            (item) => item.id === rows.rows[0]!.capture_id
          );
          if (
            !meeting ||
            !capture ||
            capture.latestRevision.sourceRevision !== source.sourceRevision ||
            capture.latestRevision.contentHash !== source.contentHash
          )
            return null;
          ids.add(meeting.id);
          matched.push({
            captureId: capture.id,
            revision: source.sourceRevision,
            hash: source.contentHash
          });
        }
        if (ids.size !== 1) return null;
        const logicalMeetingId = [...ids][0]!;
        const current = await readProcessedCaptureEvidence({
          ...input,
          workspaceId,
          meetingId: logicalMeetingId,
          audience
        });
        if (
          matched.some(
            (original) =>
              !current.meeting.captureRefs.some(
                (capture) =>
                  capture.id === original.captureId &&
                  capture.latestRevision.sourceRevision === original.revision &&
                  capture.latestRevision.contentHash === original.hash
              )
          )
        )
          return null;
        if ((await load()).rows[0]?.state_json !== row.state_json) return null;
        return logicalMeetingId;
      } catch {
        return null;
      }
    },
    captureProcessed,
    capture: captureProcessed,
    requireCurrent,
    async authorizeRetained({ audience, source }) {
      try {
        source = structuredClone(source);
        audience = sortedAudience(audience);
        const receipt = await original(source);
        if (
          source.subject.type !== "meeting" ||
          !validAudience(audience) ||
          audience.workspaceId !== source.audience.workspaceId ||
          audience.personIds.some(
            (person) => !receipt.originalAudience.personIds.includes(person)
          )
        )
          return false;
        const allowed = await input.configuration.audience(audience.workspaceId);
        if (
          !allowed ||
          audience.personIds.some((person) => !allowed.personIds.includes(person))
        )
          return false;
        const meeting = await input.configuration.logicalMeetings.get({
          workspaceId: audience.workspaceId,
          logicalMeetingId: source.subject.meetingId
        });
        if (!meeting || receipt.captures.length !== meeting.captureRefs.length)
          return false;
        for (const capture of meeting.captureRefs) {
          const prior = receipt.captures.find((value) => value.id === capture.id);
          if (
            !prior ||
            prior.bindingHash !== bindingHash(capture) ||
            prior.materialIds.some(
              (id) =>
                !capture.latestRevision.materials.some(
                  (material) => material.sourceObjectId === id
                )
            ) ||
            !["bound-high-confidence", "separate", "human-bound"].includes(
              capture.binding.state
            )
          )
            return false;
          const current = await input.configuration.access.readCurrent({
            workspaceId: audience.workspaceId,
            capture,
            audience
          });
          if (current.authorizationScopeId !== prior.authorizationScopeId) return false;
        }
        const final = await input.configuration.logicalMeetings.get({
          workspaceId: audience.workspaceId,
          logicalMeetingId: source.subject.meetingId
        });
        const finalAudience = await input.configuration.audience(audience.workspaceId);
        return (
          decisionDigest(meeting) === decisionDigest(final) &&
          !!finalAudience &&
          audience.personIds.every((person) => finalAudience.personIds.includes(person))
        );
      } catch {
        return false;
      }
    }
  };
}
