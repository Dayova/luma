import { createHash, randomUUID } from "node:crypto";
import type { LumaDatabase } from "../persistence/db.js";
import type {
  CaptureCapability,
  CaptureBindingDecision,
  CaptureBindingState,
  CaptureMatchEvidence,
  CaptureRevisionVerifier,
  HumanCaptureImportJudgment,
  HumanCaptureBindingJudgment,
  LogicalMeeting,
  LogicalMeetingBindingResult,
  LogicalMeetingCaptureRef,
  LogicalMeetingId,
  LogicalMeetingMatchCandidate,
  LogicalMeetings,
  MeetingCaptureAddress,
  MeetingCaptureCapabilities,
  MeetingCaptureEligibility,
  MeetingCaptureId,
  MeetingCaptureMaterial,
  MeetingCaptureRevision,
  MeetingIdentityFacts
} from "./interface.js";

const AUTOMATIC_POLICY_VERSION = "logical-meetings-v1";
const ACTIVE_CAPTURE_AVAILABILITY = new Set(["complete", "partial"]);
const CAPTURE_CAPABILITIES = new Set<CaptureCapability>([
  "available",
  "partial",
  "unavailable",
  "unknown"
]);
const MATERIAL_KINDS = new Set<MeetingCaptureMaterial["kind"]>([
  "verbatim-transcript",
  "derived-notes",
  "provider-summary",
  "provider-action-items",
  "attendees",
  "calendar-metadata",
  "other"
]);
const MATERIAL_PROVENANCE = new Set<MeetingCaptureMaterial["provenance"]>([
  "original-speech",
  "provider-derived",
  "provider-metadata"
]);

type DatabaseQuery = Pick<LumaDatabase, "query">;

type CaptureRow = {
  capture_id: string;
  provider_id: string;
  provider_connection_id: string;
  external_capture_id: string;
  source_kind: string;
};

type RevisionRow = {
  capture_id: string;
  source_revision: number;
  content_hash: string;
  provider_version: string | null;
  captured_at: string;
  eligibility_json: string;
  availability: MeetingCaptureRevision["availability"];
  capabilities_json: string;
  identity_facts_json: string;
  materials_json: string;
  external_reference_json: string;
};

type LogicalMeetingRow = {
  logical_meeting_id: string;
  canonical_anchor_ref_json: string | null;
  created_at: string;
  updated_at: string;
};

type BindingRow = {
  binding_id: string;
  capture_id: string;
  logical_meeting_id: string;
  state: CaptureBindingState;
  origin: "automatic" | "human";
  match_evidence_json: string;
  match_facts_digest: string | null;
  created_at: string;
};

type CandidateRow = {
  capture_id: string;
  logical_meeting_id: string;
  state: "high-confidence" | "candidate";
  evidence_json: string;
  match_facts_digest: string;
};

type JudgmentRow = {
  capture_id: string;
  actor_person_id: string;
  judgment_type: "bind" | "make-separate";
  requested_logical_meeting_id: string | null;
  observed_at: string;
  reason: string | null;
  binding_id: string;
};

type EligibilityWatermarkRow = {
  provider_id: string;
  provider_connection_id: string;
  external_capture_id: string;
  source_kind: string;
  source_revision: number;
  content_hash: string;
  eligibility_state: "excluded" | "requires-human-import";
  eligibility_reason: "private" | "ambiguous" | "policy" | null;
  captured_at: string;
  recorded_at: string;
};

type TerminalEligibilityWithdrawalRow = {
  provider_id: string;
  provider_connection_id: string;
  external_capture_id: string;
  source_kind: string;
  source_revision: number;
  content_hash: string;
  eligibility_reason: "private" | "policy";
  captured_at: string;
  recorded_at: string;
};

type EligibilityFence =
  | { kind: "watermark"; row: EligibilityWatermarkRow }
  | { kind: "terminal-withdrawal"; row: TerminalEligibilityWithdrawalRow };

type ImportJudgmentRow = {
  judgment_id: string;
  provider_id: string;
  provider_connection_id: string;
  external_capture_id: string;
  source_kind: string;
  source_revision: number;
  content_hash: string;
  revision_digest: string;
  actor_person_id: string;
  reason: string | null;
  observed_at: string;
};

type CaptureAdmission =
  | { state: "eligible" }
  | {
      state: "human-imported";
      judgmentId: string;
      actorPersonId: string;
      observedAt: string;
      reason: string | null;
    };

type CurrentCaptureState =
  | {
      state: "admitted";
      revision: MeetingCaptureRevision;
      admission: CaptureAdmission;
    }
  | { state: "withheld"; fence: EligibilityFence | null };

type MatchingCapture = {
  captureId: MeetingCaptureId;
  logicalMeetingId: LogicalMeetingId;
  revision: MeetingCaptureRevision;
};

type CandidateAssessment = {
  logicalMeetingId: LogicalMeetingId;
  category: "high-confidence" | "candidate";
  evidence: CaptureMatchEvidence[];
  matchFactsDigest: string;
};

type MatchAssessment = Omit<CandidateAssessment, "logicalMeetingId">;

export type CreateLogicalMeetingsInput = {
  database: LumaDatabase;
  captureRevisionVerifier: CaptureRevisionVerifier;
  now?: () => Date;
  /** Test seam; values are prefixed by the implementation before storage. */
  createOpaqueId?: () => string;
};

/**
 * Owns the durable relationship between independently archived provider
 * captures and Luma-owned LogicalMeetings. It deliberately does not mutate
 * Meeting Intelligence, source ledgers, or external providers.
 */
export function createLogicalMeetings(
  input: CreateLogicalMeetingsInput
): LogicalMeetings {
  const now = input.now ?? (() => new Date());
  const createOpaqueId = input.createOpaqueId ?? randomUUID;

  const logicalMeetings: LogicalMeetings = {
    async resolveCapture(resolveInput) {
      const invalid = validateCaptureRevision(resolveInput.revision);

      if (invalid) {
        return rejected("invalid-capture-revision", invalid, false);
      }

      const verification = await input.captureRevisionVerifier.verify({
        workspaceId: resolveInput.workspaceId,
        revision: resolveInput.revision
      });

      if (verification.status !== "verified") {
        return rejected(
          "capture-revision-unverified",
          verification.message,
          verification.status === "unavailable" ? verification.retryable : false,
          verification.status === "unavailable" ? "unavailable" : "rejected"
        );
      }

      return input.database.transaction(async (transaction) => {
        const capturedAt = now().toISOString();
        await lockWorkspace(transaction, resolveInput.workspaceId);

        const existingCapture = await captureByAddress(
          transaction,
          resolveInput.workspaceId,
          resolveInput.revision.address
        );
        const importAuthorization = await importAuthorizationForRevision(
          transaction,
          resolveInput.workspaceId,
          resolveInput.revision
        );
        const captureIsAdmitted =
          resolveInput.revision.eligibility.state === "eligible" ||
          importAuthorization !== null;

        if (resolveInput.revision.eligibility.state !== "eligible") {
          const watermarkError = await recordEligibilityDecision(
            transaction,
            resolveInput.workspaceId,
            resolveInput.revision,
            capturedAt
          );

          if (watermarkError) {
            return rejected("invalid-capture-revision", watermarkError, false);
          }
        }

        const latestFence = await latestEligibilityFence(
          transaction,
          resolveInput.workspaceId,
          resolveInput.revision.address
        );
        const latestStored = existingCapture
          ? await latestRevisionByCapture(
              transaction,
              resolveInput.workspaceId,
              existingCapture.capture_id
            )
          : null;

        if (
          latestFence &&
          fenceSourceRevision(latestFence) > resolveInput.revision.sourceRevision
        ) {
          return currentAdmissionResult(
            transaction,
            resolveInput.workspaceId,
            existingCapture,
            latestStored,
            latestFence
          );
        }

        if (
          latestFence &&
          fenceSourceRevision(latestFence) === resolveInput.revision.sourceRevision &&
          fenceContentHash(latestFence) !== resolveInput.revision.contentHash
        ) {
          return rejected(
            "invalid-capture-revision",
            "A withheld capture revision conflicts with the immutable content hash already recorded for this provider revision.",
            false
          );
        }

        if (
          latestFence &&
          fenceSourceRevision(latestFence) === resolveInput.revision.sourceRevision &&
          resolveInput.revision.eligibility.state === "eligible"
        ) {
          return rejected(
            "invalid-capture-revision",
            "A previously withheld provider revision may be admitted only by an exact Human import judgment, never by an adapter-only eligibility change.",
            false
          );
        }

        if (
          latestFence &&
          fenceSourceRevision(latestFence) === resolveInput.revision.sourceRevision &&
          isTerminalEligibilityFence(latestFence)
        ) {
          return excluded(
            existingCapture?.capture_id ?? null,
            "A private or policy eligibility withdrawal is terminal for this source revision and cannot be admitted into matching or synthesis."
          );
        }

        if (!captureIsAdmitted) {
          return excluded(
            existingCapture?.capture_id ?? null,
            `This capture is ${resolveInput.revision.eligibility.state}; Luma retained only its minimal eligibility watermark and excluded it from matching and synthesis.`
          );
        }

        const captureId =
          existingCapture?.capture_id ?? mintId("capture", createOpaqueId);

        if (!existingCapture) {
          await transaction.query(
            `INSERT INTO meeting_captures (
               workspace_id, capture_id, provider_id, provider_connection_id,
               external_capture_id, source_kind, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
            [
              resolveInput.workspaceId,
              captureId,
              resolveInput.revision.address.providerId,
              resolveInput.revision.address.providerConnectionId,
              resolveInput.revision.address.externalCaptureId,
              resolveInput.revision.address.sourceKind,
              capturedAt
            ]
          );
        }

        const existingRevision = await revisionByNumber(
          transaction,
          resolveInput.workspaceId,
          captureId,
          resolveInput.revision.sourceRevision
        );

        if (existingRevision) {
          const stored = revisionFromRow(existingRevision, resolveInput.revision.address);

          if (!sameCaptureRevisionMaterial(stored, resolveInput.revision)) {
            return rejected(
              "invalid-capture-revision",
              "The provider capture revision conflicts with immutable stored metadata.",
              false
            );
          }

          if (
            latestStored &&
            latestStored.source_revision > resolveInput.revision.sourceRevision
          ) {
            return currentAdmissionResult(
              transaction,
              resolveInput.workspaceId,
              existingCapture,
              latestStored,
              latestFence
            );
          }

          const binding = await bindingHead(
            transaction,
            resolveInput.workspaceId,
            captureId
          );

          if (!binding) {
            throw new Error("A persisted capture revision is missing its binding head");
          }

          return accepted(
            await decisionForBinding(transaction, resolveInput.workspaceId, binding, {
              effect: "unchanged",
              candidates: await persistedCandidates(
                transaction,
                resolveInput.workspaceId,
                captureId,
                resolveInput.revision.sourceRevision
              )
            })
          );
        }

        if (
          latestStored &&
          latestStored.source_revision > resolveInput.revision.sourceRevision
        ) {
          await insertRevision(
            transaction,
            resolveInput.workspaceId,
            captureId,
            resolveInput.revision
          );
          await transaction.query(
            `UPDATE meeting_captures
                SET updated_at = $3
              WHERE workspace_id = $1 AND capture_id = $2`,
            [resolveInput.workspaceId, captureId, capturedAt]
          );
          return currentAdmissionResult(
            transaction,
            resolveInput.workspaceId,
            existingCapture,
            latestStored,
            latestFence
          );
        }

        await insertRevision(
          transaction,
          resolveInput.workspaceId,
          captureId,
          resolveInput.revision
        );
        await transaction.query(
          `UPDATE meeting_captures
              SET updated_at = $3
            WHERE workspace_id = $1 AND capture_id = $2`,
          [resolveInput.workspaceId, captureId, capturedAt]
        );

        const inheritedBinding = await bindingHead(
          transaction,
          resolveInput.workspaceId,
          captureId
        );

        if (inheritedBinding) {
          if (
            !canReassessAutomaticBinding(
              inheritedBinding,
              resolveInput.revision,
              captureIsAdmitted
            )
          ) {
            await touchLogicalMeeting(
              transaction,
              resolveInput.workspaceId,
              inheritedBinding.logical_meeting_id,
              capturedAt
            );
            return accepted(
              await decisionForBinding(
                transaction,
                resolveInput.workspaceId,
                inheritedBinding,
                {
                  effect: "revised",
                  candidates: []
                }
              )
            );
          }

          const assessments = await assessCandidates(
            transaction,
            resolveInput.workspaceId,
            captureId,
            resolveInput.revision,
            captureIsAdmitted
          );
          await insertAssessments(
            transaction,
            resolveInput.workspaceId,
            captureId,
            resolveInput.revision.sourceRevision,
            assessments,
            capturedAt
          );
          const updatedBinding = await reassessAutomaticBinding(transaction, {
            workspaceId: resolveInput.workspaceId,
            captureId,
            current: inheritedBinding,
            assessments,
            createdAt: capturedAt,
            createOpaqueId
          });
          await touchLogicalMeeting(
            transaction,
            resolveInput.workspaceId,
            inheritedBinding.logical_meeting_id,
            capturedAt
          );

          if (updatedBinding.logical_meeting_id !== inheritedBinding.logical_meeting_id) {
            await touchLogicalMeeting(
              transaction,
              resolveInput.workspaceId,
              updatedBinding.logical_meeting_id,
              capturedAt
            );
          }

          return accepted(
            await decisionForBinding(
              transaction,
              resolveInput.workspaceId,
              updatedBinding,
              {
                effect: "revised",
                candidates: toCandidates(assessments)
              }
            )
          );
        }

        const assessments = await assessCandidates(
          transaction,
          resolveInput.workspaceId,
          captureId,
          resolveInput.revision,
          captureIsAdmitted
        );
        await insertAssessments(
          transaction,
          resolveInput.workspaceId,
          captureId,
          resolveInput.revision.sourceRevision,
          assessments,
          capturedAt
        );

        const strongCandidates = strongestIdentityCandidates(assessments);
        const candidateAssessments = assessments.filter(
          (assessment) => assessment.category === "candidate"
        );
        const candidates = toCandidates(assessments);
        let logicalMeetingId: LogicalMeetingId;
        let state: CaptureBindingState;
        let matchEvidence: CaptureMatchEvidence[];
        let matchFactsDigest: string | null;

        if (strongCandidates.length === 1) {
          const target = strongCandidates[0];

          if (!target) {
            throw new Error("Expected one strong capture candidate");
          }

          logicalMeetingId = target.logicalMeetingId;
          state = "bound-high-confidence";
          matchEvidence = target.evidence;
          matchFactsDigest = target.matchFactsDigest;
          await touchLogicalMeeting(
            transaction,
            resolveInput.workspaceId,
            logicalMeetingId,
            capturedAt
          );
        } else {
          logicalMeetingId = mintId("logical-meeting", createOpaqueId);
          await createLogicalMeeting(
            transaction,
            resolveInput.workspaceId,
            logicalMeetingId,
            capturedAt
          );

          if (strongCandidates.length > 1 || candidateAssessments.length > 1) {
            state = "ambiguous";
            matchEvidence = [];
            matchFactsDigest = null;
          } else if (candidateAssessments.length === 1) {
            const candidate = candidateAssessments[0];

            if (!candidate) {
              throw new Error("Expected one candidate capture match");
            }

            state = "candidate-match";
            matchEvidence = candidate.evidence;
            matchFactsDigest = candidate.matchFactsDigest;
          } else {
            state = "separate";
            matchEvidence = [];
            matchFactsDigest = null;
          }
        }

        const binding = await appendBinding(transaction, {
          workspaceId: resolveInput.workspaceId,
          captureId,
          logicalMeetingId,
          state,
          origin: "automatic",
          matchEvidence,
          matchFactsDigest,
          createdAt: capturedAt,
          createOpaqueId
        });

        return accepted(
          await decisionForBinding(transaction, resolveInput.workspaceId, binding, {
            effect: "created",
            candidates
          })
        );
      });
    },

    async recordBindingJudgment(judgment) {
      const invalid = validateHumanJudgment(judgment);

      if (invalid) {
        return rejected("conflicting-human-judgment", invalid, false);
      }

      return input.database.transaction(async (transaction) => {
        await lockWorkspace(transaction, judgment.workspaceId);
        const existing = await judgmentById(
          transaction,
          judgment.workspaceId,
          judgment.judgmentId
        );

        if (existing && !sameHumanJudgment(existing, judgment)) {
          return rejected(
            "conflicting-human-judgment",
            "A Human binding judgment ID is already bound to different content.",
            false
          );
        }

        const capture = await captureById(
          transaction,
          judgment.workspaceId,
          judgment.captureId
        );

        if (!capture) {
          return (await captureExistsElsewhere(transaction, judgment.captureId))
            ? rejected(
                "cross-workspace-binding",
                "A capture may not be bound from another workspace.",
                false
              )
            : rejected("unknown-capture", "The capture does not exist.", false);
        }

        const currentCapture = await currentCaptureState(
          transaction,
          judgment.workspaceId,
          capture
        );

        if (currentCapture.state === "withheld") {
          return rejected(
            "ineligible-capture",
            "A withdrawn or policy-ineligible capture may not receive a new Human binding.",
            false
          );
        }

        const current = await bindingHead(
          transaction,
          judgment.workspaceId,
          judgment.captureId
        );

        if (!current) {
          throw new Error("A persisted capture is missing its binding head");
        }

        if (existing) {
          return accepted(
            await decisionForBinding(transaction, judgment.workspaceId, current, {
              effect: "unchanged",
              candidates: []
            })
          );
        }

        const createdAt = now().toISOString();
        let logicalMeetingId: LogicalMeetingId;
        let state: CaptureBindingState;
        const matchEvidence: CaptureMatchEvidence[] = [];

        if (judgment.judgment.type === "bind") {
          const target = await logicalMeetingById(
            transaction,
            judgment.workspaceId,
            judgment.judgment.logicalMeetingId
          );

          if (!target) {
            return (await logicalMeetingExistsElsewhere(
              transaction,
              judgment.judgment.logicalMeetingId
            ))
              ? rejected(
                  "cross-workspace-binding",
                  "A capture may not be bound to a LogicalMeeting in another workspace.",
                  false
                )
              : rejected(
                  "unknown-logical-meeting",
                  "The requested LogicalMeeting does not exist.",
                  false
                );
          }

          logicalMeetingId = target.logical_meeting_id;
          state = "human-bound";
        } else {
          const rejectedTarget = await logicalMeetingById(
            transaction,
            judgment.workspaceId,
            judgment.judgment.rejectedLogicalMeetingId
          );

          if (!rejectedTarget) {
            return (await logicalMeetingExistsElsewhere(
              transaction,
              judgment.judgment.rejectedLogicalMeetingId
            ))
              ? rejected(
                  "cross-workspace-binding",
                  "A Human separation may not name a LogicalMeeting in another workspace.",
                  false
                )
              : rejected(
                  "unknown-logical-meeting",
                  "The LogicalMeeting rejected by this separation does not exist.",
                  false
                );
          }

          if (current.logical_meeting_id === rejectedTarget.logical_meeting_id) {
            logicalMeetingId = mintId("logical-meeting", createOpaqueId);
            await createLogicalMeeting(
              transaction,
              judgment.workspaceId,
              logicalMeetingId,
              createdAt
            );
          } else {
            logicalMeetingId = current.logical_meeting_id;
          }

          state = "separate";
          await addHumanSeparationExclusions(
            transaction,
            judgment.workspaceId,
            judgment.captureId,
            rejectedTarget.logical_meeting_id,
            judgment.judgmentId,
            createdAt
          );
        }

        const binding = await appendBinding(transaction, {
          workspaceId: judgment.workspaceId,
          captureId: judgment.captureId,
          logicalMeetingId,
          state,
          origin: "human",
          matchEvidence,
          matchFactsDigest: null,
          createdAt,
          createOpaqueId
        });
        await transaction.query(
          `INSERT INTO logical_meeting_capture_binding_judgments (
             workspace_id, judgment_id, capture_id, actor_person_id,
             judgment_type, requested_logical_meeting_id, reason, observed_at,
             binding_id, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            judgment.workspaceId,
            judgment.judgmentId,
            judgment.captureId,
            judgment.actorPersonId,
            judgment.judgment.type,
            judgment.judgment.type === "bind"
              ? judgment.judgment.logicalMeetingId
              : judgment.judgment.rejectedLogicalMeetingId,
            judgment.reason,
            judgment.observedAt,
            binding.binding_id,
            createdAt
          ]
        );
        await touchLogicalMeeting(
          transaction,
          judgment.workspaceId,
          current.logical_meeting_id,
          createdAt
        );
        await touchLogicalMeeting(
          transaction,
          judgment.workspaceId,
          logicalMeetingId,
          createdAt
        );

        return accepted(
          await decisionForBinding(transaction, judgment.workspaceId, binding, {
            effect: "revised",
            candidates: []
          })
        );
      });
    },

    async importCapture(judgment) {
      const invalid = validateHumanImportJudgment(judgment);

      if (invalid) {
        return rejected("conflicting-human-judgment", invalid, false);
      }

      const verification = await input.captureRevisionVerifier.verify({
        workspaceId: judgment.workspaceId,
        revision: judgment.revision
      });

      if (verification.status !== "verified") {
        return rejected(
          "capture-revision-unverified",
          verification.message,
          verification.status === "unavailable" ? verification.retryable : false,
          verification.status === "unavailable" ? "unavailable" : "rejected"
        );
      }

      const prepared = await input.database.transaction(async (transaction) => {
        const createdAt = now().toISOString();
        await lockWorkspace(transaction, judgment.workspaceId);

        const existing = await importJudgmentById(
          transaction,
          judgment.workspaceId,
          judgment.judgmentId
        );

        if (existing) {
          return sameHumanImportJudgment(existing, judgment)
            ? { status: "prepared" as const }
            : {
                status: "rejected" as const,
                result: rejected(
                  "conflicting-human-judgment",
                  "A Human import judgment ID is already bound to different content.",
                  false
                )
              };
        }

        const existingForRevision = await importJudgmentForAddressRevision(
          transaction,
          judgment.workspaceId,
          judgment.revision.address,
          judgment.revision.sourceRevision
        );

        if (existingForRevision) {
          return {
            status: "rejected" as const,
            result: rejected(
              "conflicting-human-judgment",
              "This exact capture revision already has a different Human import judgment.",
              false
            )
          };
        }

        const latestFence = await latestEligibilityFence(
          transaction,
          judgment.workspaceId,
          judgment.revision.address
        );

        if (
          latestFence &&
          fenceSourceRevision(latestFence) === judgment.revision.sourceRevision &&
          fenceContentHash(latestFence) !== judgment.revision.contentHash
        ) {
          return {
            status: "rejected" as const,
            result: rejected(
              "invalid-capture-revision",
              "A withheld capture revision conflicts with the immutable content hash already recorded for this provider revision.",
              false
            )
          };
        }

        if (
          latestFence &&
          fenceSourceRevision(latestFence) >= judgment.revision.sourceRevision &&
          isTerminalEligibilityFence(latestFence)
        ) {
          return {
            status: "rejected" as const,
            result: rejected(
              "ineligible-capture",
              "A terminal private or policy eligibility withdrawal prevents a new Human import authorization for this capture revision.",
              false
            )
          };
        }

        const watermarkError = await recordEligibilityDecision(
          transaction,
          judgment.workspaceId,
          judgment.revision,
          createdAt
        );

        if (watermarkError) {
          return {
            status: "rejected" as const,
            result: rejected("invalid-capture-revision", watermarkError, false)
          };
        }

        await insertHumanImportJudgment(transaction, judgment, createdAt);
        return { status: "prepared" as const };
      });

      if (prepared.status === "rejected") {
        return prepared.result;
      }

      const result = await logicalMeetings.resolveCapture({
        workspaceId: judgment.workspaceId,
        revision: judgment.revision
      });

      if (result.status !== "accepted") {
        return result;
      }

      const importedCapture = result.decision.logicalMeeting.captureRefs.find(
        (capture) => capture.id === result.decision.captureId
      );

      if (
        !importedCapture ||
        importedCapture.latestRevision.sourceRevision !==
          judgment.revision.sourceRevision ||
        importedCapture.latestRevision.contentHash !== judgment.revision.contentHash
      ) {
        return rejected(
          "superseded-capture-revision",
          "The Human import was recorded, but a newer capture revision is current and the withheld revision was not admitted into matching.",
          false
        );
      }

      return result;
    },

    async get(query) {
      if ("logicalMeetingId" in query) {
        return readLogicalMeeting(
          input.database,
          query.workspaceId,
          query.logicalMeetingId
        );
      }

      const binding = await bindingHead(
        input.database,
        query.workspaceId,
        query.captureId
      );

      return binding
        ? readLogicalMeeting(
            input.database,
            query.workspaceId,
            binding.logical_meeting_id
          )
        : null;
    }
  };

  return logicalMeetings;
}

function accepted(decision: CaptureBindingDecision): LogicalMeetingBindingResult {
  return { status: "accepted", decision };
}

function rejected(
  code: Extract<
    LogicalMeetingBindingResult,
    { status: "rejected" | "unavailable" }
  >["code"],
  message: string,
  retryable: boolean,
  status: "rejected" | "unavailable" = "rejected"
): LogicalMeetingBindingResult {
  return { status, code, message, retryable };
}

function excluded(
  captureId: MeetingCaptureId | null,
  message: string
): LogicalMeetingBindingResult {
  return { status: "excluded", captureId, message };
}

function canReassessAutomaticBinding(
  binding: BindingRow,
  revision: MeetingCaptureRevision,
  captureIsAdmitted: boolean
): boolean {
  // Human decisions are stable. Automatic evidence, including a former
  // high-confidence match, is revisable when a strictly newer usable provider
  // revision corrects its identity facts. The previous binding remains in
  // append-only history, but it must not survive as false current certainty.
  return (
    binding.origin === "automatic" &&
    captureIsAdmitted &&
    ACTIVE_CAPTURE_AVAILABILITY.has(revision.availability)
  );
}

async function reassessAutomaticBinding(
  database: DatabaseQuery,
  input: {
    workspaceId: string;
    captureId: MeetingCaptureId;
    current: BindingRow;
    assessments: readonly CandidateAssessment[];
    createdAt: string;
    createOpaqueId: () => string;
  }
): Promise<BindingRow> {
  const strongCandidates = strongestIdentityCandidates(input.assessments);
  const candidateAssessments = input.assessments.filter(
    (assessment) => assessment.category === "candidate"
  );

  if (strongCandidates.length === 1) {
    const target = strongCandidates[0];

    if (!target) {
      throw new Error("Expected one strong capture candidate");
    }

    return appendBinding(database, {
      workspaceId: input.workspaceId,
      captureId: input.captureId,
      logicalMeetingId: target.logicalMeetingId,
      state: "bound-high-confidence",
      origin: "automatic",
      matchEvidence: target.evidence,
      matchFactsDigest: target.matchFactsDigest,
      createdAt: input.createdAt,
      createOpaqueId: input.createOpaqueId
    });
  }

  if (strongCandidates.length > 1 || candidateAssessments.length > 1) {
    const logicalMeetingId = await safeAutomaticLogicalMeeting(
      database,
      input.workspaceId,
      input.current,
      input.createdAt,
      input.createOpaqueId
    );
    return appendBinding(database, {
      workspaceId: input.workspaceId,
      captureId: input.captureId,
      logicalMeetingId,
      state: "ambiguous",
      origin: "automatic",
      matchEvidence: [],
      matchFactsDigest: null,
      createdAt: input.createdAt,
      createOpaqueId: input.createOpaqueId
    });
  }

  const candidate = candidateAssessments[0];

  if (!candidate) {
    const logicalMeetingId = await safeAutomaticLogicalMeeting(
      database,
      input.workspaceId,
      input.current,
      input.createdAt,
      input.createOpaqueId
    );
    if (
      input.current.state !== "separate" ||
      logicalMeetingId !== input.current.logical_meeting_id
    ) {
      return appendBinding(database, {
        workspaceId: input.workspaceId,
        captureId: input.captureId,
        logicalMeetingId,
        state: "separate",
        origin: "automatic",
        matchEvidence: [],
        matchFactsDigest: null,
        createdAt: input.createdAt,
        createOpaqueId: input.createOpaqueId
      });
    }

    return input.current;
  }

  const logicalMeetingId = await safeAutomaticLogicalMeeting(
    database,
    input.workspaceId,
    input.current,
    input.createdAt,
    input.createOpaqueId
  );

  return appendBinding(database, {
    workspaceId: input.workspaceId,
    captureId: input.captureId,
    logicalMeetingId,
    state: "candidate-match",
    origin: "automatic",
    matchEvidence: candidate.evidence,
    matchFactsDigest: candidate.matchFactsDigest,
    createdAt: input.createdAt,
    createOpaqueId: input.createOpaqueId
  });
}

async function safeAutomaticLogicalMeeting(
  database: DatabaseQuery,
  workspaceId: string,
  current: BindingRow,
  createdAt: string,
  createOpaqueId: () => string
): Promise<LogicalMeetingId> {
  // The founding capture may still say "separate" after other captures joined it.
  const otherMembers = await database.query<{ capture_id: string }>(
    `SELECT head.capture_id
       FROM logical_meeting_capture_binding_heads AS head
       JOIN logical_meeting_capture_binding_history AS binding
         ON binding.workspace_id = head.workspace_id
        AND binding.binding_id = head.binding_id
      WHERE head.workspace_id = $1 AND binding.logical_meeting_id = $2
        AND head.capture_id <> $3
      LIMIT 1`,
    [workspaceId, current.logical_meeting_id, current.capture_id]
  );
  if (otherMembers.rows.length === 0) {
    return current.logical_meeting_id;
  }

  const logicalMeetingId = mintId("logical-meeting", createOpaqueId);
  await createLogicalMeeting(database, workspaceId, logicalMeetingId, createdAt);
  return logicalMeetingId;
}

function mintId(prefix: string, createOpaqueId: () => string): string {
  const value = createOpaqueId().trim();

  if (value.length === 0) {
    throw new Error("LogicalMeetings ID generator returned an empty value");
  }

  return `${prefix}:${value}`;
}

async function lockWorkspace(
  database: DatabaseQuery,
  workspaceId: string
): Promise<void> {
  await database.query(
    `INSERT INTO logical_meeting_workspace_locks (workspace_id)
     VALUES ($1)
     ON CONFLICT (workspace_id)
     DO UPDATE SET workspace_id = EXCLUDED.workspace_id`,
    [workspaceId]
  );
  await database.query(
    `SELECT workspace_id
       FROM logical_meeting_workspace_locks
      WHERE workspace_id = $1
      FOR UPDATE`,
    [workspaceId]
  );
}

async function captureByAddress(
  database: DatabaseQuery,
  workspaceId: string,
  address: MeetingCaptureAddress
): Promise<CaptureRow | null> {
  const result = await database.query<CaptureRow>(
    `SELECT capture_id, provider_id, provider_connection_id,
            external_capture_id, source_kind
       FROM meeting_captures
      WHERE workspace_id = $1
        AND provider_id = $2
        AND provider_connection_id = $3
        AND external_capture_id = $4
        AND source_kind = $5
      FOR UPDATE`,
    [
      workspaceId,
      address.providerId,
      address.providerConnectionId,
      address.externalCaptureId,
      address.sourceKind
    ]
  );

  return result.rows[0] ?? null;
}

async function captureById(
  database: DatabaseQuery,
  workspaceId: string,
  captureId: MeetingCaptureId
): Promise<CaptureRow | null> {
  const result = await database.query<CaptureRow>(
    `SELECT capture_id, provider_id, provider_connection_id,
            external_capture_id, source_kind
       FROM meeting_captures
      WHERE workspace_id = $1 AND capture_id = $2
      FOR UPDATE`,
    [workspaceId, captureId]
  );

  return result.rows[0] ?? null;
}

async function captureExistsElsewhere(
  database: DatabaseQuery,
  captureId: MeetingCaptureId
): Promise<boolean> {
  const result = await database.query<{ capture_id: string }>(
    `SELECT capture_id FROM meeting_captures WHERE capture_id = $1 LIMIT 1`,
    [captureId]
  );

  return result.rows.length > 0;
}

async function revisionByNumber(
  database: DatabaseQuery,
  workspaceId: string,
  captureId: MeetingCaptureId,
  sourceRevision: number
): Promise<RevisionRow | null> {
  const result = await database.query<RevisionRow>(
    `SELECT capture_id, source_revision, content_hash, provider_version,
            captured_at, eligibility_json, availability, capabilities_json,
            identity_facts_json, materials_json, external_reference_json
       FROM meeting_capture_revisions
      WHERE workspace_id = $1 AND capture_id = $2 AND source_revision = $3
      FOR UPDATE`,
    [workspaceId, captureId, sourceRevision]
  );

  return result.rows[0] ?? null;
}

async function latestRevisionByCapture(
  database: DatabaseQuery,
  workspaceId: string,
  captureId: MeetingCaptureId
): Promise<RevisionRow | null> {
  const result = await database.query<RevisionRow>(
    `SELECT capture_id, source_revision, content_hash, provider_version,
            captured_at, eligibility_json, availability, capabilities_json,
            identity_facts_json, materials_json, external_reference_json
       FROM meeting_capture_revisions
      WHERE workspace_id = $1 AND capture_id = $2
      ORDER BY source_revision DESC
      LIMIT 1
      FOR UPDATE`,
    [workspaceId, captureId]
  );

  return result.rows[0] ?? null;
}

async function eligibilityWatermarkByRevision(
  database: DatabaseQuery,
  workspaceId: string,
  address: MeetingCaptureAddress,
  sourceRevision: number
): Promise<EligibilityWatermarkRow | null> {
  const result = await database.query<EligibilityWatermarkRow>(
    `SELECT provider_id, provider_connection_id, external_capture_id, source_kind,
            source_revision, content_hash, eligibility_state, eligibility_reason,
            captured_at, recorded_at
       FROM meeting_capture_eligibility_watermarks
      WHERE workspace_id = $1
        AND provider_id = $2
        AND provider_connection_id = $3
        AND external_capture_id = $4
        AND source_kind = $5
        AND source_revision = $6
      FOR UPDATE`,
    [
      workspaceId,
      address.providerId,
      address.providerConnectionId,
      address.externalCaptureId,
      address.sourceKind,
      sourceRevision
    ]
  );

  return result.rows[0] ?? null;
}

async function latestOrdinaryEligibilityWatermark(
  database: DatabaseQuery,
  workspaceId: string,
  address: MeetingCaptureAddress
): Promise<EligibilityWatermarkRow | null> {
  const result = await database.query<EligibilityWatermarkRow>(
    `SELECT provider_id, provider_connection_id, external_capture_id, source_kind,
            source_revision, content_hash, eligibility_state, eligibility_reason,
            captured_at, recorded_at
       FROM meeting_capture_eligibility_watermarks
      WHERE workspace_id = $1
        AND provider_id = $2
        AND provider_connection_id = $3
        AND external_capture_id = $4
        AND source_kind = $5
      ORDER BY source_revision DESC
      LIMIT 1
      FOR UPDATE`,
    [
      workspaceId,
      address.providerId,
      address.providerConnectionId,
      address.externalCaptureId,
      address.sourceKind
    ]
  );

  return result.rows[0] ?? null;
}

async function terminalEligibilityWithdrawalsByRevision(
  database: DatabaseQuery,
  workspaceId: string,
  address: MeetingCaptureAddress,
  sourceRevision: number
): Promise<readonly TerminalEligibilityWithdrawalRow[]> {
  const result = await database.query<TerminalEligibilityWithdrawalRow>(
    `SELECT provider_id, provider_connection_id, external_capture_id, source_kind,
            source_revision, content_hash, eligibility_reason, captured_at,
            recorded_at
       FROM meeting_capture_terminal_eligibility_withdrawals
      WHERE workspace_id = $1
        AND provider_id = $2
        AND provider_connection_id = $3
        AND external_capture_id = $4
        AND source_kind = $5
        AND source_revision = $6
      ORDER BY recorded_at DESC, eligibility_reason ASC
      FOR UPDATE`,
    [
      workspaceId,
      address.providerId,
      address.providerConnectionId,
      address.externalCaptureId,
      address.sourceKind,
      sourceRevision
    ]
  );

  return result.rows;
}

async function latestTerminalEligibilityWithdrawal(
  database: DatabaseQuery,
  workspaceId: string,
  address: MeetingCaptureAddress
): Promise<TerminalEligibilityWithdrawalRow | null> {
  const result = await database.query<TerminalEligibilityWithdrawalRow>(
    `SELECT provider_id, provider_connection_id, external_capture_id, source_kind,
            source_revision, content_hash, eligibility_reason, captured_at,
            recorded_at
       FROM meeting_capture_terminal_eligibility_withdrawals
      WHERE workspace_id = $1
        AND provider_id = $2
        AND provider_connection_id = $3
        AND external_capture_id = $4
        AND source_kind = $5
      ORDER BY source_revision DESC, recorded_at DESC, eligibility_reason ASC
      LIMIT 1
      FOR UPDATE`,
    [
      workspaceId,
      address.providerId,
      address.providerConnectionId,
      address.externalCaptureId,
      address.sourceKind
    ]
  );

  return result.rows[0] ?? null;
}

async function latestEligibilityFence(
  database: DatabaseQuery,
  workspaceId: string,
  address: MeetingCaptureAddress
): Promise<EligibilityFence | null> {
  const [watermark, terminalWithdrawal] = await Promise.all([
    latestOrdinaryEligibilityWatermark(database, workspaceId, address),
    latestTerminalEligibilityWithdrawal(database, workspaceId, address)
  ]);

  if (!watermark) {
    return terminalWithdrawal
      ? { kind: "terminal-withdrawal", row: terminalWithdrawal }
      : null;
  }

  if (!terminalWithdrawal) {
    return { kind: "watermark", row: watermark };
  }

  return terminalWithdrawal.source_revision >= watermark.source_revision
    ? { kind: "terminal-withdrawal", row: terminalWithdrawal }
    : { kind: "watermark", row: watermark };
}

async function recordEligibilityDecision(
  database: DatabaseQuery,
  workspaceId: string,
  revision: MeetingCaptureRevision,
  recordedAt: string
): Promise<string | null> {
  if (revision.eligibility.state === "eligible") {
    return "An eligible capture revision must not be written as a withholding watermark.";
  }

  return isTerminalEligibility(revision.eligibility)
    ? recordTerminalEligibilityWithdrawal(database, workspaceId, revision, recordedAt)
    : recordHumanImportableEligibilityWatermark(
        database,
        workspaceId,
        revision,
        recordedAt
      );
}

async function recordTerminalEligibilityWithdrawal(
  database: DatabaseQuery,
  workspaceId: string,
  revision: MeetingCaptureRevision,
  recordedAt: string
): Promise<string | null> {
  if (!isTerminalEligibility(revision.eligibility)) {
    return "Only a private or policy exclusion may create a terminal eligibility withdrawal.";
  }

  const terminalReason = revision.eligibility.reason;

  const existing = await eligibilityWatermarkByRevision(
    database,
    workspaceId,
    revision.address,
    revision.sourceRevision
  );
  const existingTerminalWithdrawals = await terminalEligibilityWithdrawalsByRevision(
    database,
    workspaceId,
    revision.address,
    revision.sourceRevision
  );

  if (
    (existing && !sameEligibilityFenceSource(existing, revision)) ||
    existingTerminalWithdrawals.some(
      (withdrawal) => !sameEligibilityFenceSource(withdrawal, revision)
    )
  ) {
    return "The provider capture revision conflicts with the immutable source hash or captured time already recorded for this eligibility decision.";
  }

  // A legacy ordinary watermark may already contain this terminal fact from
  // before terminal withdrawals were split into their own append-only table.
  if (existing && isTerminalEligibilityWatermark(existing)) {
    return null;
  }

  if (
    existingTerminalWithdrawals.some(
      (withdrawal) => withdrawal.eligibility_reason === terminalReason
    )
  ) {
    return null;
  }

  await database.query(
    `INSERT INTO meeting_capture_terminal_eligibility_withdrawals (
       workspace_id, provider_id, provider_connection_id, external_capture_id,
       source_kind, source_revision, content_hash, eligibility_reason,
       captured_at, recorded_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      workspaceId,
      revision.address.providerId,
      revision.address.providerConnectionId,
      revision.address.externalCaptureId,
      revision.address.sourceKind,
      revision.sourceRevision,
      revision.contentHash,
      terminalReason,
      revision.capturedAt,
      recordedAt
    ]
  );

  return null;
}

async function recordHumanImportableEligibilityWatermark(
  database: DatabaseQuery,
  workspaceId: string,
  revision: MeetingCaptureRevision,
  recordedAt: string
): Promise<string | null> {
  if (!isHumanImportableEligibility(revision.eligibility)) {
    return "Only an ambiguous or requires-human-import decision may create an importable eligibility watermark.";
  }

  const existing = await eligibilityWatermarkByRevision(
    database,
    workspaceId,
    revision.address,
    revision.sourceRevision
  );
  const existingTerminalWithdrawals = await terminalEligibilityWithdrawalsByRevision(
    database,
    workspaceId,
    revision.address,
    revision.sourceRevision
  );

  if (
    (existing && !sameEligibilityFenceSource(existing, revision)) ||
    existingTerminalWithdrawals.some(
      (withdrawal) => !sameEligibilityFenceSource(withdrawal, revision)
    )
  ) {
    return "The provider capture revision conflicts with the immutable source hash or captured time already recorded for this eligibility decision.";
  }

  // A later terminal withdrawal is never weakened by a delayed importable
  // eligibility report.
  if (
    (existing && isTerminalEligibilityWatermark(existing)) ||
    existingTerminalWithdrawals.length > 0
  ) {
    return null;
  }

  const eligibilityReason =
    revision.eligibility.state === "excluded" ? revision.eligibility.reason : null;

  if (existing) {
    return sameEligibilityWatermark(existing, revision, eligibilityReason)
      ? null
      : "The provider capture revision conflicts with an immutable importable eligibility watermark.";
  }

  await database.query(
    `INSERT INTO meeting_capture_eligibility_watermarks (
       workspace_id, provider_id, provider_connection_id, external_capture_id,
       source_kind, source_revision, content_hash, eligibility_state,
       eligibility_reason, captured_at, recorded_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      workspaceId,
      revision.address.providerId,
      revision.address.providerConnectionId,
      revision.address.externalCaptureId,
      revision.address.sourceKind,
      revision.sourceRevision,
      revision.contentHash,
      revision.eligibility.state,
      eligibilityReason,
      revision.capturedAt,
      recordedAt
    ]
  );

  return null;
}

function sameEligibilityWatermark(
  stored: EligibilityWatermarkRow,
  revision: MeetingCaptureRevision,
  eligibilityReason: EligibilityWatermarkRow["eligibility_reason"]
): boolean {
  return (
    stored.content_hash === revision.contentHash &&
    stored.eligibility_state === revision.eligibility.state &&
    stored.eligibility_reason === eligibilityReason &&
    stored.captured_at === revision.capturedAt
  );
}

function sameEligibilityFenceSource(
  stored: { content_hash: string; captured_at: string },
  revision: MeetingCaptureRevision
): boolean {
  return (
    stored.content_hash === revision.contentHash &&
    stored.captured_at === revision.capturedAt
  );
}

function isTerminalEligibility(
  eligibility: MeetingCaptureEligibility
): eligibility is { state: "excluded"; reason: "private" | "policy" } {
  return (
    eligibility.state === "excluded" &&
    (eligibility.reason === "private" || eligibility.reason === "policy")
  );
}

function isHumanImportableEligibility(
  eligibility: MeetingCaptureEligibility
): eligibility is
  { state: "requires-human-import" } | { state: "excluded"; reason: "ambiguous" } {
  return (
    eligibility.state === "requires-human-import" ||
    (eligibility.state === "excluded" && eligibility.reason === "ambiguous")
  );
}

function isTerminalEligibilityWatermark(watermark: EligibilityWatermarkRow): boolean {
  return (
    watermark.eligibility_state === "excluded" &&
    (watermark.eligibility_reason === "private" ||
      watermark.eligibility_reason === "policy")
  );
}

function isTerminalEligibilityFence(fence: EligibilityFence): boolean {
  return (
    fence.kind === "terminal-withdrawal" || isTerminalEligibilityWatermark(fence.row)
  );
}

function fenceSourceRevision(fence: EligibilityFence): number {
  return fence.row.source_revision;
}

function fenceContentHash(fence: EligibilityFence): string {
  return fence.row.content_hash;
}

function humanImportableEligibilityForFence(
  fence: EligibilityFence
): MeetingCaptureEligibility | null {
  if (fence.kind === "terminal-withdrawal") {
    return null;
  }

  if (fence.row.eligibility_state === "requires-human-import") {
    if (fence.row.eligibility_reason !== null) {
      throw new Error("A requires-human-import eligibility watermark has a reason");
    }

    return { state: "requires-human-import" };
  }

  if (
    fence.row.eligibility_state === "excluded" &&
    fence.row.eligibility_reason === "ambiguous"
  ) {
    return { state: "excluded", reason: "ambiguous" };
  }

  if (isTerminalEligibilityWatermark(fence.row)) {
    return null;
  }

  throw new Error("An eligibility watermark has an invalid state or reason");
}

async function importJudgmentById(
  database: DatabaseQuery,
  workspaceId: string,
  judgmentId: string
): Promise<ImportJudgmentRow | null> {
  const result = await database.query<ImportJudgmentRow>(
    `SELECT judgment_id, provider_id, provider_connection_id,
            external_capture_id, source_kind, source_revision, content_hash,
            revision_digest, actor_person_id, reason, observed_at
       FROM logical_meeting_capture_import_judgments
      WHERE workspace_id = $1 AND judgment_id = $2
      FOR UPDATE`,
    [workspaceId, judgmentId]
  );

  return result.rows[0] ?? null;
}

async function importAuthorizationForRevision(
  database: DatabaseQuery,
  workspaceId: string,
  revision: MeetingCaptureRevision
): Promise<ImportJudgmentRow | null> {
  const authorization = await importJudgmentForAddressRevision(
    database,
    workspaceId,
    revision.address,
    revision.sourceRevision
  );

  return authorization &&
    authorization.content_hash === revision.contentHash &&
    authorization.revision_digest === captureRevisionDigest(revision)
    ? authorization
    : null;
}

async function importJudgmentForAddressRevision(
  database: DatabaseQuery,
  workspaceId: string,
  address: MeetingCaptureAddress,
  sourceRevision: number
): Promise<ImportJudgmentRow | null> {
  const result = await database.query<ImportJudgmentRow>(
    `SELECT judgment_id, provider_id, provider_connection_id,
            external_capture_id, source_kind, source_revision, content_hash,
            revision_digest, actor_person_id, reason, observed_at
       FROM logical_meeting_capture_import_judgments
      WHERE workspace_id = $1
        AND provider_id = $2
        AND provider_connection_id = $3
        AND external_capture_id = $4
        AND source_kind = $5
        AND source_revision = $6
      FOR UPDATE`,
    [
      workspaceId,
      address.providerId,
      address.providerConnectionId,
      address.externalCaptureId,
      address.sourceKind,
      sourceRevision
    ]
  );

  return result.rows[0] ?? null;
}

async function insertHumanImportJudgment(
  database: DatabaseQuery,
  judgment: HumanCaptureImportJudgment,
  createdAt: string
): Promise<void> {
  await database.query(
    `INSERT INTO logical_meeting_capture_import_judgments (
       workspace_id, judgment_id, provider_id, provider_connection_id,
       external_capture_id, source_kind, source_revision, content_hash,
       revision_digest, actor_person_id, reason, observed_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      judgment.workspaceId,
      judgment.judgmentId,
      judgment.revision.address.providerId,
      judgment.revision.address.providerConnectionId,
      judgment.revision.address.externalCaptureId,
      judgment.revision.address.sourceKind,
      judgment.revision.sourceRevision,
      judgment.revision.contentHash,
      captureRevisionDigest(judgment.revision),
      judgment.actorPersonId,
      judgment.reason,
      judgment.observedAt,
      createdAt
    ]
  );
}

function sameHumanImportJudgment(
  stored: ImportJudgmentRow,
  next: HumanCaptureImportJudgment
): boolean {
  return (
    stored.provider_id === next.revision.address.providerId &&
    stored.provider_connection_id === next.revision.address.providerConnectionId &&
    stored.external_capture_id === next.revision.address.externalCaptureId &&
    stored.source_kind === next.revision.address.sourceKind &&
    stored.source_revision === next.revision.sourceRevision &&
    stored.content_hash === next.revision.contentHash &&
    stored.revision_digest === captureRevisionDigest(next.revision) &&
    stored.actor_person_id === next.actorPersonId &&
    stored.reason === next.reason &&
    stored.observed_at === next.observedAt
  );
}

async function currentCaptureState(
  database: DatabaseQuery,
  workspaceId: string,
  capture: CaptureRow
): Promise<CurrentCaptureState> {
  const [latestRevision, fence] = await Promise.all([
    latestRevisionByCapture(database, workspaceId, capture.capture_id),
    latestEligibilityFence(database, workspaceId, addressFromRow(capture))
  ]);

  if (
    !latestRevision ||
    (fence && fenceSourceRevision(fence) > latestRevision.source_revision)
  ) {
    return { state: "withheld", fence };
  }

  if (
    fence &&
    fenceSourceRevision(fence) === latestRevision.source_revision &&
    fenceContentHash(fence) !== latestRevision.content_hash
  ) {
    throw new Error("Current capture revision conflicts with its eligibility watermark");
  }

  const storedRevision = revisionFromRow(latestRevision, addressFromRow(capture));

  if (fence && fenceSourceRevision(fence) === latestRevision.source_revision) {
    if (isTerminalEligibilityFence(fence)) {
      return { state: "withheld", fence };
    }

    const eligibility = humanImportableEligibilityForFence(fence);

    if (!eligibility) {
      return { state: "withheld", fence };
    }

    const revision = revisionWithEligibility(storedRevision, eligibility);
    const importAuthorization = await importAuthorizationForRevision(
      database,
      workspaceId,
      revision
    );

    if (!importAuthorization) {
      return { state: "withheld", fence };
    }

    return {
      state: "admitted",
      revision,
      admission: {
        state: "human-imported",
        judgmentId: importAuthorization.judgment_id,
        actorPersonId: importAuthorization.actor_person_id,
        observedAt: importAuthorization.observed_at,
        reason: importAuthorization.reason
      }
    };
  }

  if (storedRevision.eligibility.state === "eligible") {
    return {
      state: "admitted",
      revision: storedRevision,
      admission: { state: "eligible" }
    };
  }

  const importAuthorization = await importAuthorizationForRevision(
    database,
    workspaceId,
    storedRevision
  );

  if (!importAuthorization) {
    return { state: "withheld", fence };
  }

  return {
    state: "admitted",
    revision: storedRevision,
    admission: {
      state: "human-imported",
      judgmentId: importAuthorization.judgment_id,
      actorPersonId: importAuthorization.actor_person_id,
      observedAt: importAuthorization.observed_at,
      reason: importAuthorization.reason
    }
  };
}

async function currentAdmissionResult(
  database: DatabaseQuery,
  workspaceId: string,
  capture: CaptureRow | null,
  latestStored: RevisionRow | null,
  fence: EligibilityFence | null
): Promise<LogicalMeetingBindingResult> {
  if (
    !capture ||
    !latestStored ||
    (fence && fenceSourceRevision(fence) > latestStored.source_revision)
  ) {
    return excluded(
      capture?.capture_id ?? null,
      "A newer withheld capture revision is current, so this delayed revision cannot affect matching or synthesis."
    );
  }

  const current = await currentCaptureState(database, workspaceId, capture);

  if (current.state === "withheld") {
    return excluded(
      capture.capture_id,
      "The current capture revision is withheld from organizational matching and synthesis."
    );
  }

  const binding = await bindingHead(database, workspaceId, capture.capture_id);

  if (!binding) {
    return rejected(
      "ineligible-capture",
      "The current capture revision has no admitted binding head.",
      false
    );
  }

  return accepted(
    await decisionForBinding(database, workspaceId, binding, {
      effect: "unchanged",
      candidates: []
    })
  );
}

async function insertRevision(
  database: DatabaseQuery,
  workspaceId: string,
  captureId: MeetingCaptureId,
  revision: MeetingCaptureRevision
): Promise<void> {
  await database.query(
    `INSERT INTO meeting_capture_revisions (
       workspace_id, capture_id, source_revision, content_hash,
       provider_version, captured_at, eligibility_json, availability,
       capabilities_json, identity_facts_json, materials_json,
       external_reference_json
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      workspaceId,
      captureId,
      revision.sourceRevision,
      revision.contentHash,
      revision.providerVersion,
      revision.capturedAt,
      canonicalJson(revision.eligibility),
      revision.availability,
      canonicalJson(revision.capabilities),
      canonicalJson(normalizeIdentityFacts(revision.identityFacts)),
      canonicalJson(revision.materials),
      canonicalJson(revision.externalReference)
    ]
  );
}

async function logicalMeetingById(
  database: DatabaseQuery,
  workspaceId: string,
  logicalMeetingId: LogicalMeetingId
): Promise<LogicalMeetingRow | null> {
  const result = await database.query<LogicalMeetingRow>(
    `SELECT logical_meeting_id, canonical_anchor_ref_json, created_at, updated_at
       FROM logical_meetings
      WHERE workspace_id = $1 AND logical_meeting_id = $2
      FOR UPDATE`,
    [workspaceId, logicalMeetingId]
  );

  return result.rows[0] ?? null;
}

async function logicalMeetingExistsElsewhere(
  database: DatabaseQuery,
  logicalMeetingId: LogicalMeetingId
): Promise<boolean> {
  const result = await database.query<{ logical_meeting_id: string }>(
    `SELECT logical_meeting_id FROM logical_meetings WHERE logical_meeting_id = $1 LIMIT 1`,
    [logicalMeetingId]
  );

  return result.rows.length > 0;
}

async function createLogicalMeeting(
  database: DatabaseQuery,
  workspaceId: string,
  logicalMeetingId: LogicalMeetingId,
  createdAt: string
): Promise<void> {
  await database.query(
    `INSERT INTO logical_meetings (
       workspace_id, logical_meeting_id, canonical_anchor_ref_json,
       created_at, updated_at
     ) VALUES ($1, $2, NULL, $3, $3)`,
    [workspaceId, logicalMeetingId, createdAt]
  );
}

async function touchLogicalMeeting(
  database: DatabaseQuery,
  workspaceId: string,
  logicalMeetingId: LogicalMeetingId,
  updatedAt: string
): Promise<void> {
  await database.query(
    `UPDATE logical_meetings
        SET updated_at = $3
      WHERE workspace_id = $1 AND logical_meeting_id = $2`,
    [workspaceId, logicalMeetingId, updatedAt]
  );
}

async function bindingHead(
  database: DatabaseQuery,
  workspaceId: string,
  captureId: MeetingCaptureId
): Promise<BindingRow | null> {
  const result = await database.query<BindingRow>(
    `SELECT binding.binding_id, binding.capture_id, binding.logical_meeting_id,
            binding.state, binding.origin, binding.match_evidence_json,
            binding.match_facts_digest, binding.created_at
       FROM logical_meeting_capture_binding_heads AS head
       JOIN logical_meeting_capture_binding_history AS binding
         ON binding.workspace_id = head.workspace_id
        AND binding.binding_id = head.binding_id
      WHERE head.workspace_id = $1 AND head.capture_id = $2
      FOR UPDATE`,
    [workspaceId, captureId]
  );

  return result.rows[0] ?? null;
}

async function appendBinding(
  database: DatabaseQuery,
  input: {
    workspaceId: string;
    captureId: MeetingCaptureId;
    logicalMeetingId: LogicalMeetingId;
    state: CaptureBindingState;
    origin: "automatic" | "human";
    matchEvidence: readonly CaptureMatchEvidence[];
    matchFactsDigest: string | null;
    createdAt: string;
    createOpaqueId: () => string;
  }
): Promise<BindingRow> {
  const prior = await bindingHead(database, input.workspaceId, input.captureId);
  const bindingId = mintId("capture-binding", input.createOpaqueId);
  await database.query(
    `INSERT INTO logical_meeting_capture_binding_history (
       workspace_id, binding_id, capture_id, logical_meeting_id, state,
       origin, match_evidence_json, match_facts_digest, policy_version,
       supersedes_binding_id, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.workspaceId,
      bindingId,
      input.captureId,
      input.logicalMeetingId,
      input.state,
      input.origin,
      canonicalJson(input.matchEvidence),
      input.matchFactsDigest,
      AUTOMATIC_POLICY_VERSION,
      prior?.binding_id ?? null,
      input.createdAt
    ]
  );
  await database.query(
    `INSERT INTO logical_meeting_capture_binding_heads (
       workspace_id, capture_id, binding_id
     ) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, capture_id)
     DO UPDATE SET binding_id = EXCLUDED.binding_id`,
    [input.workspaceId, input.captureId, bindingId]
  );

  return {
    binding_id: bindingId,
    capture_id: input.captureId,
    logical_meeting_id: input.logicalMeetingId,
    state: input.state,
    origin: input.origin,
    match_evidence_json: canonicalJson(input.matchEvidence),
    match_facts_digest: input.matchFactsDigest,
    created_at: input.createdAt
  };
}

async function assessCandidates(
  database: DatabaseQuery,
  workspaceId: string,
  captureId: MeetingCaptureId,
  revision: MeetingCaptureRevision,
  captureIsAdmitted: boolean
): Promise<CandidateAssessment[]> {
  if (!captureIsAdmitted || !ACTIVE_CAPTURE_AVAILABILITY.has(revision.availability)) {
    return [];
  }

  const matchingCaptures = await activeCapturesForMatching(database, workspaceId);
  const excludedMeetings = await excludedLogicalMeetings(
    database,
    workspaceId,
    captureId
  );
  const byLogicalMeeting = new Map<string, CandidateAssessment>();

  for (const existing of matchingCaptures) {
    if (
      existing.captureId === captureId ||
      excludedMeetings.has(existing.logicalMeetingId) ||
      !ACTIVE_CAPTURE_AVAILABILITY.has(existing.revision.availability)
    ) {
      continue;
    }

    const assessment = matchCaptureRevisions(revision, existing.revision);

    if (!assessment) {
      continue;
    }

    const prior = byLogicalMeeting.get(existing.logicalMeetingId);

    if (!prior || isStrongerAssessment(assessment, prior)) {
      byLogicalMeeting.set(existing.logicalMeetingId, {
        logicalMeetingId: existing.logicalMeetingId,
        category: assessment.category,
        evidence: assessment.evidence,
        matchFactsDigest: assessment.matchFactsDigest
      });
    }
  }

  return [...byLogicalMeeting.values()].sort((left, right) =>
    left.logicalMeetingId.localeCompare(right.logicalMeetingId)
  );
}

async function activeCapturesForMatching(
  database: DatabaseQuery,
  workspaceId: string
): Promise<MatchingCapture[]> {
  const bindings = await database.query<BindingRow>(
    `SELECT binding.binding_id, binding.capture_id, binding.logical_meeting_id,
            binding.state, binding.origin, binding.match_evidence_json,
            binding.match_facts_digest, binding.created_at
       FROM logical_meeting_capture_binding_heads AS head
       JOIN logical_meeting_capture_binding_history AS binding
         ON binding.workspace_id = head.workspace_id
        AND binding.binding_id = head.binding_id
      WHERE head.workspace_id = $1`,
    [workspaceId]
  );

  if (bindings.rows.length === 0) {
    return [];
  }

  const captures = await database.query<CaptureRow>(
    `SELECT capture_id, provider_id, provider_connection_id,
            external_capture_id, source_kind
       FROM meeting_captures
      WHERE workspace_id = $1`,
    [workspaceId]
  );
  const bindingByCapture = new Map(
    bindings.rows.map((binding) => [binding.capture_id, binding])
  );

  const active = await Promise.all(
    captures.rows.map(async (capture) => {
      const binding = bindingByCapture.get(capture.capture_id);

      if (!binding) {
        return null;
      }

      const current = await currentCaptureState(database, workspaceId, capture);

      if (current.state === "withheld") {
        return null;
      }

      return {
        captureId: capture.capture_id,
        logicalMeetingId: binding.logical_meeting_id,
        revision: current.revision
      } satisfies MatchingCapture;
    })
  );

  return active.filter((capture): capture is MatchingCapture => capture !== null);
}

function matchCaptureRevisions(
  left: MeetingCaptureRevision,
  right: MeetingCaptureRevision
): MatchAssessment | null {
  if (
    shares(left.identityFacts.calendarEventKeys, right.identityFacts.calendarEventKeys)
  ) {
    return matchAssessment(left, right, "high-confidence", [
      { kind: "shared-calendar-event" }
    ]);
  }

  if (shares(left.identityFacts.conferenceKeys, right.identityFacts.conferenceKeys)) {
    return matchAssessment(left, right, "high-confidence", [
      { kind: "shared-conference" }
    ]);
  }

  const sharedAttendeeCount = sharedCount(
    left.identityFacts.attendeePersonIds,
    right.identityFacts.attendeePersonIds
  );

  if (
    intervalsStronglyOverlap(left.identityFacts.interval, right.identityFacts.interval) &&
    hasStrongAttendeeOverlap(
      left.identityFacts.attendeePersonIds,
      right.identityFacts.attendeePersonIds,
      sharedAttendeeCount
    )
  ) {
    return matchAssessment(left, right, "high-confidence", [
      { kind: "time-and-attendees", sharedAttendeeCount }
    ]);
  }

  if (
    intervalsStronglyOverlap(left.identityFacts.interval, right.identityFacts.interval) &&
    left.identityFacts.titleFingerprint !== null &&
    left.identityFacts.titleFingerprint === right.identityFacts.titleFingerprint &&
    shares(left.identityFacts.contextKeys, right.identityFacts.contextKeys)
  ) {
    return matchAssessment(left, right, "candidate", [{ kind: "title-time-context" }]);
  }

  return null;
}

function matchAssessment(
  left: MeetingCaptureRevision,
  right: MeetingCaptureRevision,
  category: MatchAssessment["category"],
  evidence: CaptureMatchEvidence[]
): MatchAssessment {
  return {
    category,
    evidence,
    matchFactsDigest: digest(
      canonicalJson({
        policyVersion: AUTOMATIC_POLICY_VERSION,
        left: normalizeIdentityFacts(left.identityFacts),
        right: normalizeIdentityFacts(right.identityFacts),
        evidence
      })
    )
  };
}

function isStrongerAssessment(
  next: MatchAssessment,
  previous: CandidateAssessment
): boolean {
  return identityRank(next) > identityRank(previous);
}

function strongestIdentityCandidates(
  assessments: readonly CandidateAssessment[]
): CandidateAssessment[] {
  const strong = assessments.filter(
    (assessment) => assessment.category === "high-confidence"
  );
  const strongestRank = Math.max(0, ...strong.map(identityRank));
  return strong.filter((assessment) => identityRank(assessment) === strongestRank);
}

function identityRank(assessment: MatchAssessment): number {
  return Math.max(
    0,
    ...assessment.evidence.map((evidence) => {
      switch (evidence.kind) {
        case "shared-calendar-event":
          return 4;
        case "shared-conference":
          return 3;
        case "time-and-attendees":
          return 2;
        case "title-time-context":
          return 1;
      }
    })
  );
}

function shares(left: readonly string[], right: readonly string[]): boolean {
  const rightValues = new Set(right);
  return left.some((value) => rightValues.has(value));
}

function sharedCount(left: readonly string[], right: readonly string[]): number {
  const rightValues = new Set(right);
  return new Set(left.filter((value) => rightValues.has(value))).size;
}

function hasStrongAttendeeOverlap(
  left: readonly string[],
  right: readonly string[],
  shared: number
): boolean {
  return (
    shared >= 2 &&
    left.length > 0 &&
    right.length > 0 &&
    shared / Math.min(left.length, right.length) >= 0.75
  );
}

function intervalsStronglyOverlap(
  left: MeetingIdentityFacts["interval"],
  right: MeetingIdentityFacts["interval"]
): boolean {
  if (!left || !right) {
    return false;
  }

  const leftStart = Date.parse(left.startedAt);
  const leftEnd = Date.parse(left.endedAt);
  const rightStart = Date.parse(right.startedAt);
  const rightEnd = Date.parse(right.endedAt);

  if (
    !Number.isFinite(leftStart) ||
    !Number.isFinite(leftEnd) ||
    !Number.isFinite(rightStart) ||
    !Number.isFinite(rightEnd) ||
    leftEnd <= leftStart ||
    rightEnd <= rightStart
  ) {
    return false;
  }

  const overlap = Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart);
  const shorterDuration = Math.min(leftEnd - leftStart, rightEnd - rightStart);
  return overlap > 0 && overlap / shorterDuration >= 0.5;
}

async function insertAssessments(
  database: DatabaseQuery,
  workspaceId: string,
  captureId: MeetingCaptureId,
  sourceRevision: number,
  assessments: readonly CandidateAssessment[],
  createdAt: string
): Promise<void> {
  for (const assessment of assessments) {
    await database.query(
      `INSERT INTO logical_meeting_match_assessments (
         workspace_id, capture_id, source_revision, candidate_logical_meeting_id,
         state, evidence_json, match_facts_digest, policy_version, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        workspaceId,
        captureId,
        sourceRevision,
        assessment.logicalMeetingId,
        assessment.category,
        canonicalJson(assessment.evidence),
        assessment.matchFactsDigest,
        AUTOMATIC_POLICY_VERSION,
        createdAt
      ]
    );
  }
}

async function persistedCandidates(
  database: DatabaseQuery,
  workspaceId: string,
  captureId: MeetingCaptureId,
  sourceRevision: number
): Promise<LogicalMeetingMatchCandidate[]> {
  const result = await database.query<CandidateRow>(
    `SELECT capture_id, candidate_logical_meeting_id AS logical_meeting_id,
            state, evidence_json, match_facts_digest
       FROM logical_meeting_match_assessments
      WHERE workspace_id = $1 AND capture_id = $2 AND source_revision = $3
      ORDER BY candidate_logical_meeting_id ASC`,
    [workspaceId, captureId, sourceRevision]
  );

  return result.rows.map((row) => ({
    logicalMeetingId: row.logical_meeting_id,
    evidence: parseJson<readonly CaptureMatchEvidence[]>(row.evidence_json)
  }));
}

function toCandidates(
  assessments: readonly CandidateAssessment[]
): LogicalMeetingMatchCandidate[] {
  return assessments.map((assessment) => ({
    logicalMeetingId: assessment.logicalMeetingId,
    evidence: assessment.evidence
  }));
}

async function excludedLogicalMeetings(
  database: DatabaseQuery,
  workspaceId: string,
  captureId: MeetingCaptureId
): Promise<Set<string>> {
  // Use binding heads, including withheld captures, so a third capture cannot
  // bypass a Human separation by providing fresh identity evidence.
  const result = await database.query<{ logical_meeting_id: string }>(
    `SELECT DISTINCT binding.logical_meeting_id
       FROM logical_meeting_capture_exclusions AS exclusion
       JOIN logical_meeting_capture_binding_heads AS head
         ON head.workspace_id = exclusion.workspace_id
        AND ((exclusion.left_capture_id = $2 AND head.capture_id = exclusion.right_capture_id)
          OR (exclusion.right_capture_id = $2 AND head.capture_id = exclusion.left_capture_id))
       JOIN logical_meeting_capture_binding_history AS binding
         ON binding.workspace_id = head.workspace_id
        AND binding.binding_id = head.binding_id
      WHERE exclusion.workspace_id = $1`,
    [workspaceId, captureId]
  );

  return new Set(result.rows.map((row) => row.logical_meeting_id));
}

async function addHumanSeparationExclusions(
  database: DatabaseQuery,
  workspaceId: string,
  captureId: MeetingCaptureId,
  priorLogicalMeetingId: LogicalMeetingId,
  judgmentId: string,
  createdAt: string
): Promise<void> {
  const result = await database.query<{ capture_id: string }>(
    `SELECT head.capture_id
       FROM logical_meeting_capture_binding_heads AS head
       JOIN logical_meeting_capture_binding_history AS binding
         ON binding.workspace_id = head.workspace_id
        AND binding.binding_id = head.binding_id
      WHERE head.workspace_id = $1 AND binding.logical_meeting_id = $2`,
    [workspaceId, priorLogicalMeetingId]
  );

  for (const row of result.rows) {
    if (row.capture_id === captureId) {
      continue;
    }

    const [leftCaptureId, rightCaptureId] = [captureId, row.capture_id].sort(
      (left, right) => left.localeCompare(right)
    );
    await database.query(
      `INSERT INTO logical_meeting_capture_exclusions (
         workspace_id, left_capture_id, right_capture_id, human_judgment_id,
         created_at
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, left_capture_id, right_capture_id)
       DO NOTHING`,
      [workspaceId, leftCaptureId, rightCaptureId, judgmentId, createdAt]
    );
  }
}

async function judgmentById(
  database: DatabaseQuery,
  workspaceId: string,
  judgmentId: string
): Promise<JudgmentRow | null> {
  const result = await database.query<JudgmentRow>(
    `SELECT capture_id, actor_person_id, judgment_type,
            requested_logical_meeting_id, observed_at, reason, binding_id
       FROM logical_meeting_capture_binding_judgments
      WHERE workspace_id = $1 AND judgment_id = $2
      FOR UPDATE`,
    [workspaceId, judgmentId]
  );

  return result.rows[0] ?? null;
}

function sameHumanJudgment(
  stored: JudgmentRow,
  next: HumanCaptureBindingJudgment
): boolean {
  return (
    stored.capture_id === next.captureId &&
    stored.actor_person_id === next.actorPersonId &&
    stored.judgment_type === next.judgment.type &&
    stored.requested_logical_meeting_id ===
      (next.judgment.type === "bind"
        ? next.judgment.logicalMeetingId
        : next.judgment.rejectedLogicalMeetingId) &&
    stored.observed_at === next.observedAt &&
    stored.reason === next.reason
  );
}

async function decisionForBinding(
  database: DatabaseQuery,
  workspaceId: string,
  binding: BindingRow,
  input: {
    effect: "created" | "unchanged" | "revised";
    candidates: readonly LogicalMeetingMatchCandidate[];
  }
): Promise<CaptureBindingDecision> {
  const logicalMeeting = await readLogicalMeeting(
    database,
    workspaceId,
    binding.logical_meeting_id
  );

  if (!logicalMeeting) {
    throw new Error("A capture binding points at an absent LogicalMeeting");
  }

  return {
    logicalMeeting,
    captureId: binding.capture_id,
    state: binding.state,
    origin: binding.origin,
    effect: input.effect,
    matchEvidence: parseJson<readonly CaptureMatchEvidence[]>(
      binding.match_evidence_json
    ),
    matchFactsDigest: binding.match_facts_digest,
    candidates: input.candidates
  };
}

async function readLogicalMeeting(
  database: DatabaseQuery,
  workspaceId: string,
  logicalMeetingId: LogicalMeetingId
): Promise<LogicalMeeting | null> {
  const meeting = await logicalMeetingById(database, workspaceId, logicalMeetingId);

  if (!meeting) {
    return null;
  }

  const rows = await database.query<CaptureRow & BindingRow>(
    `SELECT capture.capture_id, capture.provider_id, capture.provider_connection_id,
            capture.external_capture_id, capture.source_kind,
            binding.binding_id, binding.logical_meeting_id, binding.state,
            binding.origin, binding.match_evidence_json,
            binding.match_facts_digest, binding.created_at
       FROM logical_meeting_capture_binding_heads AS head
       JOIN logical_meeting_capture_binding_history AS binding
         ON binding.workspace_id = head.workspace_id
        AND binding.binding_id = head.binding_id
       JOIN meeting_captures AS capture
         ON capture.workspace_id = head.workspace_id
        AND capture.capture_id = head.capture_id
      WHERE head.workspace_id = $1 AND binding.logical_meeting_id = $2`,
    [workspaceId, logicalMeetingId]
  );
  const captureRefs = (
    await Promise.all(
      rows.rows.map(async (row) => {
        const current = await currentCaptureState(database, workspaceId, row);

        if (current.state === "withheld") {
          return null;
        }

        return {
          id: row.capture_id,
          address: addressFromRow(row),
          latestRevision: current.revision,
          admission: current.admission,
          binding: {
            state: row.state,
            origin: row.origin,
            updatedAt: row.created_at
          }
        } satisfies LogicalMeetingCaptureRef;
      })
    )
  )
    .filter((capture): capture is LogicalMeetingCaptureRef => capture !== null)
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    id: meeting.logical_meeting_id,
    captureRefs,
    canonicalAnchorRef: meeting.canonical_anchor_ref_json
      ? parseJson(meeting.canonical_anchor_ref_json)
      : null,
    createdAt: meeting.created_at,
    updatedAt: meeting.updated_at
  };
}

function addressFromRow(row: CaptureRow): MeetingCaptureAddress {
  return {
    providerId: row.provider_id,
    providerConnectionId: row.provider_connection_id,
    externalCaptureId: row.external_capture_id,
    sourceKind: row.source_kind
  };
}

function revisionFromRow(
  row: RevisionRow,
  address: MeetingCaptureAddress
): MeetingCaptureRevision {
  return {
    address,
    sourceRevision: row.source_revision,
    contentHash: row.content_hash,
    providerVersion: row.provider_version,
    capturedAt: row.captured_at,
    eligibility: parseJson<MeetingCaptureEligibility>(row.eligibility_json),
    availability: row.availability,
    capabilities: parseJson<MeetingCaptureCapabilities>(row.capabilities_json),
    identityFacts: parseJson<MeetingIdentityFacts>(row.identity_facts_json),
    materials: parseJson<readonly MeetingCaptureMaterial[]>(row.materials_json),
    externalReference: parseJson(row.external_reference_json)
  };
}

function sameCaptureRevisionMaterial(
  left: MeetingCaptureRevision,
  right: MeetingCaptureRevision
): boolean {
  return (
    canonicalJson(captureRevisionMaterial(left)) ===
    canonicalJson(captureRevisionMaterial(right))
  );
}

function captureRevisionMaterial(
  revision: MeetingCaptureRevision
): Omit<MeetingCaptureRevision, "eligibility"> {
  const { eligibility, ...material } = normalizeCaptureRevision(revision);
  void eligibility;
  return material;
}

function revisionWithEligibility(
  revision: MeetingCaptureRevision,
  eligibility: MeetingCaptureEligibility
): MeetingCaptureRevision {
  return { ...revision, eligibility };
}

function normalizeCaptureRevision(
  revision: MeetingCaptureRevision
): MeetingCaptureRevision {
  return {
    ...revision,
    identityFacts: normalizeIdentityFacts(revision.identityFacts),
    materials: [...revision.materials]
  };
}

function normalizeIdentityFacts(facts: MeetingIdentityFacts): MeetingIdentityFacts {
  return {
    calendarEventKeys: normalizedStringSet(facts.calendarEventKeys),
    conferenceKeys: normalizedStringSet(facts.conferenceKeys),
    interval: facts.interval
      ? { startedAt: facts.interval.startedAt, endedAt: facts.interval.endedAt }
      : null,
    attendeePersonIds: normalizedStringSet(facts.attendeePersonIds),
    titleFingerprint: facts.titleFingerprint,
    contextKeys: normalizedStringSet(facts.contextKeys)
  };
}

function normalizedStringSet(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right)
  );
}

function validateCaptureRevision(revision: MeetingCaptureRevision): string | null {
  const address = revision.address;

  if (
    !isNonBlankString(address.providerId) ||
    !isNonBlankString(address.providerConnectionId) ||
    !isNonBlankString(address.externalCaptureId) ||
    !isNonBlankString(address.sourceKind)
  ) {
    return "A capture address requires provider, connection, external capture, and source-kind identities.";
  }

  if (!Number.isSafeInteger(revision.sourceRevision) || revision.sourceRevision < 1) {
    return "A capture source revision must be a positive integer.";
  }

  if (
    !isNonBlankString(revision.contentHash) ||
    !isOffsetBearingInstant(revision.capturedAt)
  ) {
    return "A capture revision requires a content hash and offset-bearing capturedAt instant.";
  }

  if (
    revision.externalReference.providerId !== address.providerId ||
    !isNonBlankString(revision.externalReference.externalId) ||
    !isNonBlankString(revision.externalReference.url)
  ) {
    return "A capture revision must retain an external reference owned by its provider.";
  }

  if (
    !validEligibility(revision.eligibility) ||
    !validAvailability(revision.availability) ||
    !validCapabilities(revision.capabilities)
  ) {
    return "A capture revision has invalid eligibility, availability, or capability metadata.";
  }

  const identityError = validateIdentityFacts(revision.identityFacts);

  if (identityError) {
    return identityError;
  }

  if (!Array.isArray(revision.materials)) {
    return "Capture materials must be an array.";
  }

  for (const material of revision.materials as unknown[]) {
    if (!isMeetingCaptureMaterial(material)) {
      return "A capture material has an invalid provider-neutral descriptor.";
    }

    if (
      !isNonBlankString(material.sourceObjectId) ||
      !isNonBlankString(material.sourceVersion) ||
      material.externalReference.providerId !== address.providerId
    ) {
      return "A capture material must retain a provider-owned immutable source reference.";
    }

    if (
      material.kind === "verbatim-transcript" &&
      (material.provenance !== "original-speech" ||
        revision.capabilities.rawTranscript === "unavailable" ||
        revision.capabilities.rawTranscript === "unknown")
    ) {
      return "Verbatim transcript material requires original-speech provenance and a known transcript capability.";
    }

    if (
      (material.kind === "derived-notes" ||
        material.kind === "provider-summary" ||
        material.kind === "provider-action-items") &&
      (material.provenance !== "provider-derived" ||
        revision.capabilities.enhancedNotes === "unavailable" ||
        revision.capabilities.enhancedNotes === "unknown")
    ) {
      return "Derived note material requires provider-derived provenance and a known enhancedNotes capability.";
    }

    if (
      (material.kind === "attendees" || material.kind === "calendar-metadata") &&
      material.provenance !== "provider-metadata"
    ) {
      return "Provider metadata material must retain provider-metadata provenance.";
    }

    if (
      material.kind === "attendees" &&
      (revision.capabilities.attendees === "unavailable" ||
        revision.capabilities.attendees === "unknown")
    ) {
      return "Attendee material requires a known attendee capability.";
    }
  }

  if (revision.availability === "removed" && revision.materials.length > 0) {
    return "A removed capture revision may not expose reusable material descriptors.";
  }

  return null;
}

function validAvailability(
  value: unknown
): value is MeetingCaptureRevision["availability"] {
  return (
    value === "complete" ||
    value === "partial" ||
    value === "not-ready" ||
    value === "failed" ||
    value === "removed"
  );
}

function validEligibility(value: unknown): value is MeetingCaptureEligibility {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const eligibility = value as Record<string, unknown>;

  if (
    eligibility["state"] === "eligible" ||
    eligibility["state"] === "requires-human-import"
  ) {
    return true;
  }

  return (
    eligibility["state"] === "excluded" &&
    (eligibility["reason"] === "private" ||
      eligibility["reason"] === "ambiguous" ||
      eligibility["reason"] === "policy")
  );
}

function validCapabilities(value: unknown): value is MeetingCaptureCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const capabilities = value as Record<string, unknown>;

  return (
    CAPTURE_CAPABILITIES.has(capabilities["enhancedNotes"] as CaptureCapability) &&
    CAPTURE_CAPABILITIES.has(capabilities["rawTranscript"] as CaptureCapability) &&
    CAPTURE_CAPABILITIES.has(capabilities["speakerIdentity"] as CaptureCapability) &&
    CAPTURE_CAPABILITIES.has(capabilities["attendees"] as CaptureCapability) &&
    CAPTURE_CAPABILITIES.has(capabilities["revisionMetadata"] as CaptureCapability)
  );
}

function isMeetingCaptureMaterial(value: unknown): value is MeetingCaptureMaterial {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const material = value as Record<string, unknown>;
  const reference = material["externalReference"];

  return (
    MATERIAL_KINDS.has(material["kind"] as MeetingCaptureMaterial["kind"]) &&
    MATERIAL_PROVENANCE.has(
      material["provenance"] as MeetingCaptureMaterial["provenance"]
    ) &&
    isNonBlankString(material["sourceObjectId"]) &&
    isNonBlankString(material["sourceVersion"]) &&
    reference !== null &&
    typeof reference === "object" &&
    !Array.isArray(reference) &&
    isNonBlankString((reference as Record<string, unknown>)["providerId"]) &&
    isNonBlankString((reference as Record<string, unknown>)["externalId"]) &&
    isNonBlankString((reference as Record<string, unknown>)["url"])
  );
}

function validateIdentityFacts(facts: MeetingIdentityFacts): string | null {
  const values = [
    ...facts.calendarEventKeys,
    ...facts.conferenceKeys,
    ...facts.attendeePersonIds,
    ...facts.contextKeys
  ];

  if (values.some((value) => !isNonBlankString(value))) {
    return "Capture identity facts may not contain empty values.";
  }

  if (facts.titleFingerprint !== null && !isNonBlankString(facts.titleFingerprint)) {
    return "A title fingerprint must be non-empty when present.";
  }

  if (facts.interval) {
    if (
      !isOffsetBearingInstant(facts.interval.startedAt) ||
      !isOffsetBearingInstant(facts.interval.endedAt) ||
      Date.parse(facts.interval.endedAt) <= Date.parse(facts.interval.startedAt)
    ) {
      return "A capture interval must contain valid ordered offset-bearing instants.";
    }
  }

  return null;
}

function validateHumanJudgment(judgment: HumanCaptureBindingJudgment): string | null {
  if (
    !isNonBlankString(judgment.judgmentId) ||
    !isNonBlankString(judgment.workspaceId) ||
    !isNonBlankString(judgment.actorPersonId) ||
    !isNonBlankString(judgment.captureId) ||
    !isOffsetBearingInstant(judgment.observedAt)
  ) {
    return "A Human capture-binding judgment is missing its immutable envelope.";
  }

  if (
    judgment.reason !== null &&
    (typeof judgment.reason !== "string" || judgment.reason.trim().length === 0)
  ) {
    return "A Human capture-binding reason must be null or non-empty.";
  }

  if (
    judgment.judgment.type === "bind" &&
    !isNonBlankString(judgment.judgment.logicalMeetingId)
  ) {
    return "A Human bind judgment requires a LogicalMeeting identity.";
  }

  if (
    judgment.judgment.type === "make-separate" &&
    !isNonBlankString(judgment.judgment.rejectedLogicalMeetingId)
  ) {
    return "A Human separation judgment requires the rejected LogicalMeeting identity.";
  }

  return null;
}

function validateHumanImportJudgment(
  judgment: HumanCaptureImportJudgment
): string | null {
  if (
    !isNonBlankString(judgment.judgmentId) ||
    !isNonBlankString(judgment.workspaceId) ||
    !isNonBlankString(judgment.actorPersonId) ||
    !isOffsetBearingInstant(judgment.observedAt)
  ) {
    return "A Human capture-import judgment is missing its immutable envelope.";
  }

  if (
    judgment.reason !== null &&
    (typeof judgment.reason !== "string" || judgment.reason.trim().length === 0)
  ) {
    return "A Human capture-import reason must be null or non-empty.";
  }

  const revisionError = validateCaptureRevision(judgment.revision);

  if (revisionError) {
    return revisionError;
  }

  return isHumanImportableEligibility(judgment.revision.eligibility)
    ? null
    : "Only a requires-human-import or ambiguous capture revision may be admitted by a Human import judgment.";
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOffsetBearingInstant(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value));
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("LogicalMeeting metadata contains an unsupported number");
    }

    return JSON.stringify(value);
  }

  if (
    typeof value === "undefined" ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new Error("LogicalMeeting metadata contains an unsupported value");
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((left, right) => left.localeCompare(right))
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function captureRevisionDigest(revision: MeetingCaptureRevision): string {
  return digest(canonicalJson(normalizeCaptureRevision(revision)));
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
