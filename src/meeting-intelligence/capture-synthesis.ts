import {
  ensureSynthesisActionFences,
  requireUnfencedSynthesis
} from "./synthesis-action-state.js";
import { synthesisActionCandidates } from "./synthesis-action-candidates.js";
import { readProcessedCaptureEvidence } from "./processed-capture-evidence.js";
import {
  prepareCaptureSynthesisSources,
  matchesMaterialDigest,
  digest,
  sorted,
  type Material,
  type Prepared
} from "./capture-synthesis-sources.js";
import { z } from "zod";
import { AiServiceError } from "../ai/ai-service-error.js";
import {
  CAPTURE_SYNTHESIS_INSTRUCTIONS,
  captureSynthesisProposalSchema,
  type CaptureSynthesisProposal
} from "../ai/capture-synthesis-proposal.js";
import type { ReasoningModel } from "../ai/reasoning-model.js";
import type {
  CaptureSynthesisClaim,
  CaptureSynthesisJudgmentRecorded,
  CaptureSynthesisQueryResult,
  LumaSynthesis,
  MeetingCaptureSetObserved
} from "../domain/meeting-capture-synthesis.js";
import type {
  EvidenceReference,
  MeetingObservation,
  WorkspaceConfig,
  SynthesisActionItemCandidate,
  MeetingState
} from "../domain/model.js";
import type { ContextAudience } from "../organizational-context/interface.js";
import type { LumaDatabase } from "../persistence/db.js";
import type {
  MeetingIntelligence,
  MeetingUpdate,
  ObserveMeeting,
  QueryMeeting
} from "./interface.js";
import type { CaptureSynthesisConfiguration } from "./meeting-capture-access.js";
import {
  isSynthesisPublicationObservation,
  observeSynthesisPublication,
  projectSynthesisPublication
} from "./synthesis-publication-state.js";

type CaptureObservation = MeetingCaptureSetObserved | CaptureSynthesisJudgmentRecorded;
type Stored = {
  authorizationScopes: Record<string, string>;
  synthesis: LumaSynthesis;
  audience: ContextAudience;
  materialDigest: string;
  bindingDigest: string;
  judgments: CaptureSynthesisJudgmentRecorded[];
};
const scopeSchema = z.object({
  observationId: z.string().min(1).max(1024),
  workspaceId: z.string().min(1),
  meetingId: z.string().min(1),
  occurredAt: z.string().datetime({ offset: true }),
  observedAt: z.string().datetime({ offset: true })
});
const observationSchema = z.discriminatedUnion("type", [
  scopeSchema
    .extend({
      type: z.literal("meeting-capture-set-observed"),
      captures: z
        .array(
          z
            .object({
              captureId: z.string().min(1).max(512),
              sourceRevision: z.number().int().positive(),
              contentHash: z.string().min(1).max(1024)
            })
            .strict()
        )
        .max(8)
    })
    .strict(),
  scopeSchema
    .extend({
      type: z.literal("capture-synthesis-judgment-recorded"),
      participantId: z.string().min(1),
      expectedSynthesisRevision: z.number().int().positive(),
      claimId: z.string().min(1),
      judgment: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("confirm") }).strict(),
        z.object({ kind: z.literal("reject") }).strict(),
        z
          .object({
            kind: z.literal("resolve-action"),
            modality: z.enum(["commitment", "request"]),
            dueDate: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/u)
              .refine((value) => {
                const date = new Date(`${value}T00:00:00Z`);
                return (
                  Number.isFinite(date.getTime()) && date.toISOString().startsWith(value)
                );
              })
              .nullable(),
            ownerPersonId: z.string().min(1).nullable()
          })
          .strict(),
        z
          .object({ kind: z.literal("correct"), text: z.string().min(1).max(4000) })
          .strict()
      ])
    })
    .strict()
]);
class Unavailable extends Error {
  constructor() {
    super("Capture synthesis source, audience or binding is unavailable.");
  }
}

/** Private MI Implementation. Callers still observe, query and conclude a Meeting. */
export function withCaptureSynthesis(input: {
  base: MeetingIntelligence;
  database: LumaDatabase;
  reasoningModel: ReasoningModel;
  configuration?: CaptureSynthesisConfiguration;
  now: () => Date;
  workProviderId: string;
  actions: {
    bindCurrent(verify: (state: MeetingState) => Promise<void>): void;
    accept(input: {
      synthesis: LumaSynthesis;
      candidates: SynthesisActionItemCandidate[];
      requireCurrent: () => Promise<void>;
    }): Promise<void>;
  };
}): MeetingIntelligence {
  let migration: Promise<void> | undefined;
  const flights = new Map<string, Promise<MeetingUpdate>>();
  const migrate = () =>
    (migration ??= input.database
      .exec(
        `
    CREATE TABLE IF NOT EXISTS meeting_capture_synthesis (
      workspace_id TEXT NOT NULL, meeting_id TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL,
      PRIMARY KEY(workspace_id, meeting_id)
    );
    CREATE TABLE IF NOT EXISTS meeting_capture_synthesis_revisions (
      workspace_id TEXT NOT NULL, meeting_id TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL,
      PRIMARY KEY(workspace_id, meeting_id, revision)
    );
    CREATE TABLE IF NOT EXISTS meeting_capture_synthesis_observations (
      workspace_id TEXT NOT NULL, observation_id TEXT NOT NULL, meeting_id TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY(workspace_id, observation_id)
    );
    CREATE TABLE IF NOT EXISTS meeting_capture_synthesis_attempts (
      workspace_id TEXT NOT NULL, meeting_id TEXT NOT NULL, attempt_key TEXT NOT NULL,
      PRIMARY KEY(workspace_id, meeting_id, attempt_key)
    );
    ALTER TABLE meeting_capture_synthesis_attempts ADD COLUMN IF NOT EXISTS source_set_digest TEXT;
    ALTER TABLE meeting_capture_synthesis_attempts ADD COLUMN IF NOT EXISTS judgments_digest TEXT;
    ALTER TABLE meeting_capture_synthesis_attempts ADD COLUMN IF NOT EXISTS ordering_version TEXT;
  `
      )
      .then(() => ensureSynthesisActionFences(input.database))
      .catch((error: unknown) => {
        migration = undefined;
        throw error;
      }));
  const load = async (workspaceId: string, meetingId: string): Promise<Stored | null> => {
    const result = await input.database.query<{ state_json: string }>(
      "SELECT state_json FROM meeting_capture_synthesis WHERE workspace_id=$1 AND meeting_id=$2",
      [workspaceId, meetingId]
    );
    return result.rows[0] ? (JSON.parse(result.rows[0].state_json) as Stored) : null;
  };
  const claimWorkspace = (workspace: WorkspaceConfig) =>
    input.database.transaction(async (transaction) => {
      // Same durable configuration mutex as normal MI acceptance. Only verified
      // source intake reaches this point; rejected captures cannot claim policy.
      await transaction.query(
        "INSERT INTO workspace_config_locks(workspace_id) VALUES($1) ON CONFLICT(workspace_id) DO UPDATE SET workspace_id=excluded.workspace_id",
        [workspace.workspaceId]
      );
      await transaction.query(
        "INSERT INTO workspaces(workspace_id,timezone,config_json,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id) DO NOTHING",
        [
          workspace.workspaceId,
          workspace.timezone,
          JSON.stringify(workspace),
          input.now().toISOString()
        ]
      );
      const result = await transaction.query<{ config_json: string }>(
        "SELECT config_json FROM workspaces WHERE workspace_id=$1 FOR UPDATE",
        [workspace.workspaceId]
      );
      const config = JSON.parse(result.rows[0]!.config_json) as WorkspaceConfig;
      if (
        config.workspaceId !== workspace.workspaceId ||
        typeof config.timezone !== "string"
      )
        throw new Unavailable();
      new Intl.DateTimeFormat("en", { timeZone: config.timezone });
      return config;
    });
  const prepare = (workspaceId: string, meetingId: string, original?: ContextAudience) =>
    prepareCaptureSynthesisSources(input.configuration, workspaceId, meetingId, original);
  const requireSame = async (
    workspaceId: string,
    meetingId: string,
    prepared: Prepared,
    original: ContextAudience
  ) => {
    const latest = await prepare(workspaceId, meetingId, original);
    if (
      latest.bindingDigest !== prepared.bindingDigest ||
      latest.materialDigest !== prepared.materialDigest ||
      digest(latest.anchor) !== digest(prepared.anchor) ||
      digest(latest.authorizationScopes) !== digest(prepared.authorizationScopes) ||
      digest(latest.audience) !== digest(prepared.audience)
    )
      throw new Unavailable();
  };
  const update = (
    observation: CaptureObservation,
    status: MeetingUpdate["analysisStatus"],
    revision: number,
    accepted = false,
    duplicate = false
  ): MeetingUpdate => ({
    workspaceId: observation.workspaceId,
    meetingId: observation.meetingId,
    revision,
    acceptedObservationIds: accepted ? [observation.observationId] : [],
    duplicateObservationIds: duplicate ? [observation.observationId] : [],
    analysisStatus: status,
    interventions: [],
    events: [],
    errors: []
  });
  const save = async (
    observation: CaptureObservation,
    state: Stored,
    priorRevision: number
  ) =>
    input.database.transaction(async (transaction) => {
      await transaction.query(
        "SELECT revision FROM meeting_capture_synthesis WHERE workspace_id=$1 AND meeting_id=$2 FOR UPDATE",
        [observation.workspaceId, observation.meetingId]
      );
      await requireUnfencedSynthesis(
        transaction,
        observation.workspaceId,
        observation.meetingId
      );
      const existing = await transaction.query<{ revision: number }>(
        "SELECT revision FROM meeting_capture_synthesis WHERE workspace_id=$1 AND meeting_id=$2",
        [observation.workspaceId, observation.meetingId]
      );
      if ((existing.rows[0]?.revision ?? 0) !== priorRevision) throw new Unavailable();
      const inserted = await transaction.query(
        "INSERT INTO meeting_capture_synthesis_observations(workspace_id,observation_id,meeting_id,payload_json) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING observation_id",
        [
          observation.workspaceId,
          observation.observationId,
          observation.meetingId,
          JSON.stringify(observation)
        ]
      );
      if (!inserted.rows.length) throw new Unavailable();
      const values = [
        observation.workspaceId,
        observation.meetingId,
        state.synthesis.revision,
        JSON.stringify(state)
      ];
      await transaction.query(
        "INSERT INTO meeting_capture_synthesis_revisions(workspace_id,meeting_id,revision,state_json) VALUES($1,$2,$3,$4)",
        values
      );
      await transaction.query(
        "INSERT INTO meeting_capture_synthesis(workspace_id,meeting_id,revision,state_json) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,meeting_id) DO UPDATE SET revision=excluded.revision,state_json=excluded.state_json",
        values
      );
    });
  const acceptActions = async (
    state: Stored,
    prepared: Prepared,
    workspace: WorkspaceConfig
  ) => {
    const canonicalWorkspace = await claimWorkspace(workspace);
    const requireCurrent = async () => {
      await requireSame(
        state.synthesis.workspaceId,
        state.synthesis.logicalMeetingId,
        prepared,
        state.audience
      );
      if (
        (await load(state.synthesis.workspaceId, state.synthesis.logicalMeetingId))
          ?.synthesis.revision !== state.synthesis.revision
      )
        throw new Unavailable();
    };
    await requireCurrent();
    await input.actions.accept({
      synthesis: state.synthesis,
      candidates: synthesisActionCandidates({
        synthesis: state.synthesis,
        workspace: canonicalWorkspace,
        workProviderId: input.workProviderId,
        materials: prepared.materials,
        deadlineReferenceAt:
          prepared.meeting.captureRefs[0]?.latestRevision.identityFacts.interval
            ?.startedAt ?? null
      }),
      requireCurrent
    });
    await requireCurrent();
  };
  const observe = async (request: ObserveMeeting): Promise<MeetingUpdate> => {
    const parsed = observationSchema.safeParse(request.observations[0]);
    if (
      !parsed.success ||
      request.observations.length !== 1 ||
      parsed.data.workspaceId !== request.workspace.workspaceId
    )
      throw new Error("Capture synthesis requires one valid same-workspace Observation.");
    const observation = parsed.data;
    const workspaceId = observation.workspaceId,
      meetingId = observation.meetingId;
    let prior: Stored | null = null;
    let attemptKey: string | undefined;
    let dispatched = false;
    let acceptedRevision: number | undefined;
    let duplicateRevision: number | undefined;
    try {
      new Intl.DateTimeFormat("en", { timeZone: request.workspace.timezone });
      await migrate();
      prior = await load(workspaceId, meetingId);
      const existing = await input.database.query<{
        meeting_id: string;
        payload_json: string;
      }>(
        "SELECT meeting_id,payload_json FROM meeting_capture_synthesis_observations WHERE workspace_id=$1 AND observation_id=$2",
        [workspaceId, observation.observationId]
      );
      if (existing.rows[0]) {
        if (
          existing.rows[0].meeting_id !== meetingId ||
          digest(JSON.parse(existing.rows[0].payload_json) as unknown) !==
            digest(observation)
        )
          throw new Unavailable();
        const current = await prepare(workspaceId, meetingId, prior?.audience);
        if (
          prior &&
          (current.bindingDigest !== prior.bindingDigest ||
            !matchesMaterialDigest(current, prior.materialDigest) ||
            digest(current.authorizationScopes) !== digest(prior.authorizationScopes))
        )
          throw new Unavailable();
        await requireSame(
          workspaceId,
          meetingId,
          current,
          prior?.audience ?? current.audience
        );
        duplicateRevision = prior?.synthesis.revision ?? 0;
        if (prior) await acceptActions(prior, current, request.workspace);
        return update(
          observation,
          "not-needed",
          prior?.synthesis.revision ?? 0,
          false,
          true
        );
      }
      const prepared = await prepare(workspaceId, meetingId, prior?.audience);
      // An unchanged immutable source set with an unrecognized old material
      // order cannot be treated as new evidence to justify another paid call.
      if (
        prior &&
        prepared.bindingDigest === prior.bindingDigest &&
        !matchesMaterialDigest(prepared, prior.materialDigest)
      )
        throw new Unavailable();
      const currentCaptureIds = new Set(
        prepared.meeting.captureRefs.map((capture) => capture.id)
      );
      if (
        prior?.synthesis.claims.some(
          (claim) =>
            (claim.authority !== "inferred" || claim.conflictingClaimIds.length > 0) &&
            claim.citations.some(
              (citation) =>
                !currentCaptureIds.has(citation.captureId) ||
                prior?.authorizationScopes[citation.captureId] !==
                  prepared.authorizationScopes[citation.captureId]
            )
        )
      )
        throw new Unavailable();
      const audience = prior?.audience ?? prepared.audience;
      let state: Stored;
      if (observation.type === "capture-synthesis-judgment-recorded") {
        if (
          !prior ||
          observation.expectedSynthesisRevision !== prior.synthesis.revision ||
          !prepared.audience.personIds.includes(observation.participantId) ||
          prepared.bindingDigest !== prior.bindingDigest ||
          !matchesMaterialDigest(prepared, prior.materialDigest) ||
          digest(prepared.authorizationScopes) !== digest(prior.authorizationScopes)
        )
          throw new Unavailable();
        const claim = prior.synthesis.claims.find(
          (item) => item.id === observation.claimId
        );
        if (!claim) throw new Unavailable();
        if (
          observation.judgment.kind === "resolve-action" &&
          (!["action-item", "commitment"].includes(claim.kind) ||
            (observation.judgment.ownerPersonId !== null &&
              !prepared.audience.personIds.includes(observation.judgment.ownerPersonId)))
        )
          throw new Unavailable();
        state = structuredClone(prior);
        state.judgments.push(observation);
        state.synthesis.claims = applyJudgments(state.synthesis.claims, [observation]);
        state.synthesis.revision += 1;
        state.synthesis.producedAt = input.now().toISOString();
      } else {
        const actual = prepared.meeting.captureRefs.map((item) => ({
          captureId: item.id,
          sourceRevision: item.latestRevision.sourceRevision,
          contentHash: item.latestRevision.contentHash
        }));
        if (digest(sorted(actual)) !== digest(sorted(observation.captures)))
          throw new Unavailable();
        const workspace = await claimWorkspace(request.workspace);
        const sourceSetDigests = prepared.compatibleMaterialDigests.map(
          (materialDigest) =>
            digest([
              prepared.bindingDigest,
              materialDigest,
              prepared.authorizationScopes,
              workspace
            ])
        );
        const sourceSetDigest = sourceSetDigests[0]!;
        if (prior && sourceSetDigests.includes(prior.synthesis.sourceSetDigest)) {
          await requireSame(workspaceId, meetingId, prepared, audience);
          await input.database.query(
            "INSERT INTO meeting_capture_synthesis_observations(workspace_id,observation_id,meeting_id,payload_json) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            [
              workspaceId,
              observation.observationId,
              meetingId,
              JSON.stringify(observation)
            ]
          );
          acceptedRevision = prior.synthesis.revision;
          await acceptActions(prior, prepared, workspace);
          return update(observation, "not-needed", prior.synthesis.revision, true);
        }
        await requireUnfencedSynthesis(input.database, workspaceId, meetingId);
        const judgmentsDigest = digest(prior?.judgments ?? []);
        const compatibleAttemptKeys = sourceSetDigests.map((sourceDigest) =>
          digest([sourceDigest, judgmentsDigest, "capture-synthesis-v1"])
        );
        const previousAttempts = await input.database.query<{
          attempt_key: string;
          ordering_version: string | null;
        }>(
          "SELECT attempt_key,ordering_version FROM meeting_capture_synthesis_attempts WHERE workspace_id=$1 AND meeting_id=$2 AND (ordering_version IS NULL OR attempt_key=ANY($3::text[])) LIMIT 1001",
          [workspaceId, meetingId, compatibleAttemptKeys]
        );
        const unknownLegacy = previousAttempts.rows.filter(
          (attempt) =>
            attempt.ordering_version === null &&
            !compatibleAttemptKeys.includes(attempt.attempt_key)
        );
        let unresolvedLegacy = false;
        if (unknownLegacy.length) {
          const revisions = await input.database.query<{ state_json: string }>(
            "SELECT state_json FROM meeting_capture_synthesis_revisions WHERE workspace_id=$1 AND meeting_id=$2 ORDER BY revision DESC LIMIT 1001",
            [workspaceId, meetingId]
          );
          const completed = new Set(
            revisions.rows.map(({ state_json }) => {
              const state = JSON.parse(state_json) as Stored;
              return digest([
                state.synthesis.sourceSetDigest,
                digest(state.judgments),
                "capture-synthesis-v1"
              ]);
            })
          );
          unresolvedLegacy =
            revisions.rows.length > 1000 ||
            unknownLegacy.some((attempt) => !completed.has(attempt.attempt_key));
        }
        if (
          previousAttempts.rows.length > 1000 ||
          unresolvedLegacy ||
          previousAttempts.rows.some((attempt) =>
            compatibleAttemptKeys.includes(attempt.attempt_key)
          )
        )
          throw new AiServiceError(
            "request-indeterminate",
            "A retained synthesis attempt cannot be safely redispatched; its original charge and identity require recovery.",
            { requestDispatched: true }
          );
        attemptKey = digest([sourceSetDigest, judgmentsDigest, "capture-synthesis-v1"]);
        const claimAttempt = await input.database.query(
          "INSERT INTO meeting_capture_synthesis_attempts(workspace_id,meeting_id,attempt_key,source_set_digest,judgments_digest,ordering_version) VALUES($1,$2,$3,$4,$5,'code-unit-v1') ON CONFLICT DO NOTHING RETURNING attempt_key",
          [workspaceId, meetingId, attemptKey, sourceSetDigest, judgmentsDigest]
        );
        if (!claimAttempt.rows.length) {
          attemptKey = undefined;
          throw new AiServiceError(
            "request-indeterminate",
            "A dispatched synthesis attempt for these exact captures already exists.",
            { requestDispatched: true }
          );
        }
        const evidence: EvidenceReference[] = prepared.materials.map((material) => ({
          evidenceId: material.evidenceId,
          source:
            material.descriptor.provenance === "original-speech"
              ? "transcript"
              : "knowledge",
          sourceObjectId: material.descriptor.sourceObjectId,
          sourceVersion: material.descriptor.sourceVersion,
          excerpt: material.text,
          externalReference: material.descriptor.externalReference
        }));
        // Durable configuration/attempt admission awaited after the first proof.
        // Revalidate before disclosing any bytes or spending the reserved attempt.
        await requireSame(workspaceId, meetingId, prepared, audience);
        dispatched = true;
        const proposal =
          await input.reasoningModel.generateStructured<CaptureSynthesisProposal>({
            workspaceId,
            meetingId,
            purpose: "understand-discussion",
            promptVersion: "capture-synthesis-v1",
            schemaName: "CaptureSynthesisProposal",
            evidence,
            context: [
              CAPTURE_SYNTHESIS_INSTRUCTIONS,
              JSON.stringify({
                sources: prepared.meeting.captureRefs,
                materialKinds: prepared.materials.map(({ evidenceId, descriptor }) => ({
                  evidenceId,
                  kind: descriptor.kind,
                  provenance: descriptor.provenance
                })),
                humanJudgments: prior?.judgments ?? [],
                humanClaims:
                  prior?.synthesis.claims.filter(
                    (claim) => claim.authority !== "inferred"
                  ) ?? [],
                unresolvedConflicts: (prior?.synthesis.claims ?? []).filter(
                  (claim) => claim.conflictingClaimIds.length > 0
                )
              })
            ],
            input: {
              timezone: workspace.timezone,
              outputLanguagePolicy: workspace.outputLanguagePolicy ?? "meeting-majority"
            }
          });
        const claims = groundClaims(
          captureSynthesisProposalSchema.parse(proposal.value),
          prepared.materials
        );
        const humanClaims =
          prior?.synthesis.claims.filter((claim) => claim.authority !== "inferred") ?? [];
        // Existing Human Judgment keeps its own claim identity and authority even
        // if a later provider/model omits or renames that claim.
        const humanIds = new Set(humanClaims.map((claim) => claim.id));
        const mergedClaims = [
          ...claims.filter((claim) => !humanIds.has(claim.id)),
          ...structuredClone(humanClaims)
        ];
        // Known conflict edges cannot disappear when a later model changes its
        // flags or omits a counterpart: omission is not resolution evidence.
        for (const priorClaim of prior?.synthesis.claims ?? []) {
          if (!priorClaim.conflictingClaimIds.length) continue;
          const current = mergedClaims.find((claim) => claim.id === priorClaim.id);
          if (!current) throw new Unavailable();
          current.conflictingClaimIds = [
            ...new Set([
              ...current.conflictingClaimIds,
              ...priorClaim.conflictingClaimIds
            ])
          ];
        }
        // Restore reciprocity only
        // when both claims have current material or retained Human authority.
        for (const claim of mergedClaims) {
          for (const otherId of claim.conflictingClaimIds) {
            const other = mergedClaims.find((item) => item.id === otherId);
            if (!other) throw new Unavailable();
            if (!other.conflictingClaimIds.includes(claim.id))
              other.conflictingClaimIds.push(claim.id);
          }
        }
        state = {
          authorizationScopes: prepared.authorizationScopes,
          audience,
          bindingDigest: prepared.bindingDigest,
          materialDigest: prepared.materialDigest,
          judgments: prior?.judgments ?? [],
          synthesis: {
            workspaceId,
            logicalMeetingId: meetingId,
            revision: (prior?.synthesis.revision ?? 0) + 1,
            sourceSetDigest,
            producedAt: input.now().toISOString(),
            claims: mergedClaims,
            sources: prepared.meeting.captureRefs.map((capture) => ({
              captureId: capture.id,
              sourceRevision: capture.latestRevision.sourceRevision,
              contentHash: capture.latestRevision.contentHash,
              capabilities: capture.latestRevision.capabilities,
              externalReference: capture.latestRevision.externalReference
            })),
            canonicalAnchorRef: prepared.anchor,
            coverage: prepared.meeting.captureRefs.every(
              (capture) =>
                capture.latestRevision.availability === "complete" &&
                capture.latestRevision.capabilities.rawTranscript === "available"
            )
              ? "complete"
              : "partial"
          }
        };
      }
      await requireSame(workspaceId, meetingId, prepared, audience);
      await save(observation, state, prior?.synthesis.revision ?? 0);
      acceptedRevision = state.synthesis.revision;
      await acceptActions(state, prepared, request.workspace);
      await requireSame(workspaceId, meetingId, prepared, audience);
      return update(
        observation,
        observation.type === "meeting-capture-set-observed" ? "completed" : "not-needed",
        state.synthesis.revision,
        true
      );
    } catch (error) {
      if (
        attemptKey &&
        (!dispatched ||
          (error instanceof AiServiceError && error.requestDispatched === false))
      )
        await input.database.query(
          "DELETE FROM meeting_capture_synthesis_attempts WHERE workspace_id=$1 AND meeting_id=$2 AND attempt_key=$3",
          [workspaceId, meetingId, attemptKey]
        );
      return {
        ...update(
          observation,
          "deferred",
          acceptedRevision ?? duplicateRevision ?? prior?.synthesis.revision ?? 0,
          acceptedRevision !== undefined,
          duplicateRevision !== undefined
        ),
        errors: [
          error instanceof AiServiceError
            ? {
                code: `analysis-${error.code}`,
                retryable: ["rate-limited", "timeout", "unavailable"].includes(
                  error.code
                ),
                ...(error.limitScope ? { limitScope: error.limitScope } : {}),
                ...(error.resetAt ? { resetAt: error.resetAt } : {}),
                ...(error.timezone ? { timezone: error.timezone } : {}),
                ...(error.retryAfterSeconds !== undefined
                  ? { retryAfterSeconds: error.retryAfterSeconds }
                  : {})
              }
            : {
                code: "context-unavailable",
                retryable: true,
                partialResultAvailable: Boolean(prior) || acceptedRevision !== undefined
              }
        ]
      };
    }
  };
  const query = async (scope: QueryMeeting): Promise<CaptureSynthesisQueryResult> => {
    if (!input.configuration)
      return {
        type: "capture-synthesis",
        availability: "not-configured",
        synthesis: null
      };
    try {
      await migrate();
      const state = await load(scope.workspaceId, scope.meetingId);
      if (!state)
        return {
          type: "capture-synthesis",
          availability: "not-produced",
          synthesis: null
        };
      const current = await prepare(scope.workspaceId, scope.meetingId, state.audience);
      if (
        current.bindingDigest !== state.bindingDigest ||
        digest(current.authorizationScopes) !== digest(state.authorizationScopes) ||
        !matchesMaterialDigest(current, state.materialDigest)
      )
        throw new Unavailable();
      await requireSame(scope.workspaceId, scope.meetingId, current, state.audience);
      const publicationIntent = await projectSynthesisPublication(
        input.database,
        state.synthesis,
        current.audience
      );
      await requireSame(scope.workspaceId, scope.meetingId, current, state.audience);
      if (
        (await load(scope.workspaceId, scope.meetingId))?.synthesis.revision !==
        state.synthesis.revision
      )
        throw new Unavailable();
      return {
        type: "capture-synthesis",
        availability: "available",
        synthesis: {
          ...structuredClone(state.synthesis),
          canonicalAnchorRef: current.anchor
        },
        followUpIntentions: [publicationIntent]
      };
    } catch {
      return { type: "capture-synthesis", availability: "unavailable", synthesis: null };
    }
  };
  input.actions.bindCurrent(async (state) => {
    if (!state.captureSynthesisActionSource) return;
    const current = await query({
      workspaceId: state.workspaceId,
      meetingId: state.meetingId,
      query: { type: "capture-synthesis" }
    });
    if (
      !current.synthesis ||
      current.synthesis.revision !== state.captureSynthesisActionSource.revision ||
      current.synthesis.sourceSetDigest !==
        state.captureSynthesisActionSource.sourceSetDigest
    )
      throw new Unavailable();
  });
  return {
    ...input.base,
    conclude: async (scope) => {
      await migrate();
      if (!(await load(scope.workspaceId, scope.meetingId)))
        return input.base.conclude(scope);
      const result = await query({ ...scope, query: { type: "capture-synthesis" } });
      if (
        result.availability !== "available" ||
        !result.synthesis ||
        !result.followUpIntentions?.[0]
      )
        throw new Unavailable();
      const synthesis = result.synthesis,
        intent = result.followUpIntentions[0];
      const actions = await input.base.query({ ...scope, query: { type: "snapshot" } });
      const actionIntents =
        actions.type === "snapshot" &&
        actions.state.captureSynthesisActionSource?.revision === synthesis.revision &&
        actions.state.captureSynthesisActionSource.sourceSetDigest ===
          synthesis.sourceSetDigest
          ? actions.state.followUpIntentions.filter(
              (item) => item.type === "settle-operational-outcome"
            )
          : [];
      const final = await query({ ...scope, query: { type: "capture-synthesis" } });
      if (!final.synthesis || digest(final.synthesis) !== digest(synthesis))
        throw new Unavailable();
      return {
        workspaceId: scope.workspaceId,
        meetingId: scope.meetingId,
        revision: synthesis.revision,
        summary: {
          brief: `Luma Synthesis revision ${synthesis.revision} (${synthesis.coverage} coverage).`,
          detailed: synthesis.claims
            .map((claim) => `${claim.kind} (${claim.authority}): ${claim.text}`)
            .join("\n\n")
        },
        topics: [],
        decisions: [],
        actionItems: [],
        openQuestions: [],
        risks: [],
        followUpIntentions: [intent, ...actionIntents],
        participantBriefs: [],
        outputLanguage: scope.outputLanguage ?? "de",
        provenance: intent.provenance,
        createdAt: synthesis.producedAt,
        captureSynthesis: synthesis
      };
    },
    query: async (scope) => {
      if (scope.query.type === "capture-synthesis") return query(structuredClone(scope));
      await migrate();
      if (!(await load(scope.workspaceId, scope.meetingId)))
        return input.base.query(scope);
      const before = await query({ ...scope, query: { type: "capture-synthesis" } });
      if (!before.synthesis) throw new Unavailable();
      const snapshot = await input.base.query({ ...scope, query: { type: "snapshot" } });
      if (
        snapshot.type !== "snapshot" ||
        snapshot.state.captureSynthesisActionSource?.revision !==
          before.synthesis.revision ||
        snapshot.state.captureSynthesisActionSource.sourceSetDigest !==
          before.synthesis.sourceSetDigest
      )
        throw new Unavailable();
      const result =
        scope.query.type === "snapshot" ? snapshot : await input.base.query(scope);
      const after = await query({ ...scope, query: { type: "capture-synthesis" } });
      if (!after.synthesis || digest(before.synthesis) !== digest(after.synthesis))
        throw new Unavailable();
      if (result.type === "snapshot")
        result.state.captureSynthesisActionSource = {
          revision: after.synthesis.revision,
          sourceSetDigest: after.synthesis.sourceSetDigest,
          canonicalAnchorRef: after.synthesis.canonicalAnchorRef
        };
      return result;
    },
    observe: (request) => {
      if (request.observations.some(isSynthesisPublicationObservation)) {
        const bound = structuredClone(request);
        return observeSynthesisPublication({
          database: input.database,
          request: bound,
          current: async () => {
            const result = await query({
              workspaceId: bound.workspace.workspaceId,
              meetingId: bound.observations[0]!.meetingId,
              query: { type: "capture-synthesis" }
            });
            if (
              result.availability !== "available" ||
              !result.synthesis ||
              !result.followUpIntentions?.[0]
            )
              throw new Unavailable();
            return { synthesis: result.synthesis, intent: result.followUpIntentions[0] };
          }
        });
      }
      if (!request.observations.some(isCaptureObservation)) {
        return (async () => {
          await migrate();
          const ids = [
            ...new Set(
              request.observations
                .filter((item) => item.type !== "follow-up-execution-recorded")
                .map((item) => item.meetingId)
            )
          ];
          const proofs: Array<{ meetingId: string; synthesis: LumaSynthesis }> = [];
          for (const meetingId of ids) {
            if (!(await load(request.workspace.workspaceId, meetingId))) continue;
            const current = await query({
              workspaceId: request.workspace.workspaceId,
              meetingId,
              query: { type: "capture-synthesis" }
            });
            if (!current.synthesis) throw new Unavailable();
            proofs.push({ meetingId, synthesis: current.synthesis });
          }
          const result = await input.base.observe(request);
          for (const proof of proofs) {
            const current = await query({
              workspaceId: request.workspace.workspaceId,
              meetingId: proof.meetingId,
              query: { type: "capture-synthesis" }
            });
            if (
              !current.synthesis ||
              digest(current.synthesis) !== digest(proof.synthesis)
            )
              throw new Unavailable();
          }
          return result;
        })();
      }
      const bound = structuredClone(request);
      const key = digest([bound.workspace.workspaceId, bound.observations[0]?.meetingId]);
      const previous = flights.get(key);
      const process = async (): Promise<MeetingUpdate> => {
        const result = await observe(bound);
        const callback = input.configuration?.onProcessedSource;
        const observation = bound.observations[0];
        if (
          callback &&
          input.configuration &&
          observation &&
          (result.acceptedObservationIds.includes(observation.observationId) ||
            result.duplicateObservationIds.includes(observation.observationId))
        ) {
          try {
            const audience = await input.configuration.audience(
              bound.workspace.workspaceId
            );
            if (!audience) throw new Unavailable();
            const current = await readProcessedCaptureEvidence({
              database: input.database,
              configuration: input.configuration,
              workspaceId: bound.workspace.workspaceId,
              meetingId: observation.meetingId,
              audience
            });
            await callback({
              workspaceId: bound.workspace.workspaceId,
              meetingId: observation.meetingId,
              observationId: observation.observationId,
              sourceRevision: current.revision,
              contentHash: digest([
                current.bindingDigest,
                current.materialDigest,
                current.authorizationScopes,
                current.audience,
                current.reviews
              ])
            });
          } catch {
            return {
              ...result,
              analysisStatus: "deferred" as const,
              errors: [
                ...result.errors,
                {
                  code: "context-unavailable" as const,
                  retryable: true,
                  partialResultAvailable: true
                }
              ]
            };
          }
        }
        return result;
      };
      const next = previous ? previous.catch(() => undefined).then(process) : process();
      flights.set(key, next);
      void next
        .finally(() => {
          if (flights.get(key) === next) flights.delete(key);
        })
        .catch(() => undefined);
      return next;
    }
  };
}
function isCaptureObservation(
  observation: MeetingObservation
): observation is CaptureObservation {
  return (
    observation.type === "meeting-capture-set-observed" ||
    observation.type === "capture-synthesis-judgment-recorded"
  );
}
function groundClaims(
  proposal: CaptureSynthesisProposal,
  materials: Material[]
): CaptureSynthesisClaim[] {
  const keys = new Set(proposal.claims.map((claim) => claim.key));
  if (keys.size !== proposal.claims.length) throw new Unavailable();
  const evidence = new Map(materials.map((material) => [material.evidenceId, material]));
  const id = (key: string) => `synthesis-claim:${digest(key)}`;
  const claims = proposal.claims.map((claim): CaptureSynthesisClaim => {
    if (/["“”„«»]/u.test(claim.text)) throw new Unavailable();
    if (claim.conflictingKeys.some((key) => key === claim.key || !keys.has(key)))
      throw new Unavailable();
    const citations = [...new Set(claim.evidenceIds)].map((evidenceId) => {
      const material = evidence.get(evidenceId);
      if (!material) throw new Unavailable();
      return {
        evidenceId,
        captureId: material.captureId,
        materialId: material.descriptor.sourceObjectId,
        sourceRevision: material.sourceRevision,
        externalReference: material.descriptor.externalReference
      };
    });
    for (const quote of claim.quotations) {
      const material = evidence.get(quote.evidenceId);
      if (
        !claim.evidenceIds.includes(quote.evidenceId) ||
        material?.descriptor.kind !== "verbatim-transcript" ||
        material.descriptor.provenance !== "original-speech" ||
        !material.text.includes(quote.text)
      )
        throw new Unavailable();
    }
    return {
      id: id(claim.key),
      stableKey: claim.key,
      kind: claim.kind,
      text: claim.text,
      authority: "inferred",
      confidence: claim.confidence,
      citations,
      quotations: claim.quotations,
      conflictingClaimIds: [...new Set(claim.conflictingKeys.map(id))]
    };
  });
  // A one-sided model conflict is still a conflict on both claims.
  for (const claim of claims)
    for (const otherId of [...claim.conflictingClaimIds]) {
      const other = claims.find((item) => item.id === otherId)!;
      if (!other.conflictingClaimIds.includes(claim.id))
        other.conflictingClaimIds.push(claim.id);
    }
  return claims;
}
function applyJudgments(
  claims: CaptureSynthesisClaim[],
  judgments: CaptureSynthesisJudgmentRecorded[]
): CaptureSynthesisClaim[] {
  const result = structuredClone(claims);
  for (const judgment of judgments) {
    const claim = result.find((item) => item.id === judgment.claimId);
    if (!claim) throw new Unavailable();
    claim.authority =
      judgment.judgment.kind === "confirm"
        ? "human-confirmed"
        : judgment.judgment.kind === "reject"
          ? "human-rejected"
          : "human-corrected";
    if (judgment.judgment.kind === "resolve-action") {
      claim.actionReview = {
        modality: judgment.judgment.modality,
        dueDate: judgment.judgment.dueDate,
        ownerPersonId: judgment.judgment.ownerPersonId,
        participantId: judgment.participantId,
        judgedAt: judgment.observedAt
      };
    }
    if (judgment.judgment.kind === "correct") {
      delete claim.actionReview;
      claim.text = judgment.judgment.text;
      claim.quotations = [];
    }
  }
  return result;
}
