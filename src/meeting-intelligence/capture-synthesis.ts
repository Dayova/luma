import { createHash } from "node:crypto";
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
  WorkspaceConfig
} from "../domain/model.js";
import type { LogicalMeeting } from "../logical-meetings/interface.js";
import type { ContextAudience } from "../organizational-context/interface.js";
import type { LumaDatabase } from "../persistence/db.js";
import type {
  MeetingIntelligence,
  MeetingUpdate,
  ObserveMeeting,
  QueryMeeting
} from "./interface.js";
import type {
  CaptureSynthesisConfiguration,
  CurrentMeetingCaptureMaterial
} from "./meeting-capture-access.js";

type CaptureObservation = MeetingCaptureSetObserved | CaptureSynthesisJudgmentRecorded;
type Stored = {
  authorizationScopes: Record<string, string>;
  synthesis: LumaSynthesis;
  audience: ContextAudience;
  materialDigest: string;
  bindingDigest: string;
  judgments: CaptureSynthesisJudgmentRecorded[];
};
type Material = CurrentMeetingCaptureMaterial & {
  captureId: string;
  sourceRevision: number;
  evidenceId: string;
};
type Prepared = {
  authorizationScopes: Record<string, string>;
  meeting: LogicalMeeting;
  audience: ContextAudience;
  materials: Material[];
  bindingDigest: string;
  materialDigest: string;
  anchor: LumaSynthesis["canonicalAnchorRef"];
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
  `
      )
      .then(() => undefined));
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
  const prepare = async (
    workspaceId: string,
    meetingId: string,
    original?: ContextAudience
  ): Promise<Prepared> => {
    const config = input.configuration;
    if (!config) throw new Unavailable();
    const audience = await config.audience(workspaceId);
    if (
      !audience ||
      audience.workspaceId !== workspaceId ||
      !audience.personIds.length ||
      new Set(audience.personIds).size !== audience.personIds.length ||
      (original &&
        (original.workspaceId !== workspaceId ||
          audience.personIds.some((id) => !original.personIds.includes(id))))
    )
      throw new Unavailable();
    const boundAudience = { workspaceId, personIds: [...audience.personIds].sort() };
    const meeting = await config.logicalMeetings.get({
      workspaceId,
      logicalMeetingId: meetingId
    });
    if (!meeting || !meeting.captureRefs.length || meeting.captureRefs.length > 8)
      throw new Unavailable();
    const bindingDigest = digest(meeting);
    const materials: Material[] = [];
    const authorizationScopes: Record<string, string> = {};
    const anchors: NonNullable<LumaSynthesis["canonicalAnchorRef"]>[] = [];
    for (const capture of meeting.captureRefs) {
      const revision = capture.latestRevision;
      if (
        !["complete", "partial"].includes(revision.availability) ||
        !revision.materials.length
      )
        throw new Unavailable();
      const material = await config.access.readCurrent({
        workspaceId,
        capture: structuredClone(capture),
        audience: structuredClone(boundAudience)
      });
      if (!material.authorizationScopeId.trim()) throw new Unavailable();
      authorizationScopes[capture.id] = material.authorizationScopeId;
      if (material.canonicalAnchorRef) anchors.push(material.canonicalAnchorRef);
      if (
        digest(sorted(material.materials.map((item) => item.descriptor))) !==
        digest(sorted(revision.materials))
      )
        throw new Unavailable();
      for (const item of material.materials) {
        if (!item.text.trim() || item.text.length > 100_000) throw new Unavailable();
        materials.push({
          ...item,
          captureId: capture.id,
          sourceRevision: revision.sourceRevision,
          evidenceId: `capture-evidence:${digest([capture.id, revision.sourceRevision, item.descriptor])}`
        });
      }
    }
    if (
      materials.length > 64 ||
      materials.reduce((count, item) => count + item.text.length, 0) > 250_000 ||
      new Set(materials.map((item) => item.evidenceId)).size !== materials.length
    )
      throw new Unavailable();
    if (
      digest(
        await config.logicalMeetings.get({ workspaceId, logicalMeetingId: meetingId })
      ) !== bindingDigest ||
      digest(
        await config
          .audience(workspaceId)
          .then((value) =>
            value ? { ...value, personIds: [...value.personIds].sort() } : null
          )
      ) !== digest(boundAudience)
    )
      throw new Unavailable();
    const uniqueAnchors = new Map(
      anchors.map((anchor) => [digest([anchor.providerId, anchor.externalId]), anchor])
    );
    const anchor =
      meeting.canonicalAnchorRef ??
      (uniqueAnchors.size === 1 ? [...uniqueAnchors.values()][0]! : null);
    if (!anchor && uniqueAnchors.size > 1) throw new Unavailable();
    return {
      meeting,
      audience: boundAudience,
      materials,
      bindingDigest,
      materialDigest: digest(sorted(materials)),
      authorizationScopes,
      anchor
    };
  };
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
            current.materialDigest !== prior.materialDigest ||
            digest(current.authorizationScopes) !== digest(prior.authorizationScopes))
        )
          throw new Unavailable();
        await requireSame(
          workspaceId,
          meetingId,
          current,
          prior?.audience ?? current.audience
        );
        return update(
          observation,
          "not-needed",
          prior?.synthesis.revision ?? 0,
          false,
          true
        );
      }
      const prepared = await prepare(workspaceId, meetingId, prior?.audience);
      const currentCaptureIds = new Set(
        prepared.meeting.captureRefs.map((capture) => capture.id)
      );
      if (
        prior?.synthesis.claims.some(
          (claim) =>
            claim.authority !== "inferred" &&
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
          prepared.materialDigest !== prior.materialDigest ||
          digest(prepared.authorizationScopes) !== digest(prior.authorizationScopes)
        )
          throw new Unavailable();
        const claim = prior.synthesis.claims.find(
          (item) => item.id === observation.claimId
        );
        if (!claim) throw new Unavailable();
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
        const sourceSetDigest = digest([
          prepared.bindingDigest,
          prepared.materialDigest,
          prepared.authorizationScopes,
          workspace
        ]);
        if (prior?.synthesis.sourceSetDigest === sourceSetDigest) {
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
          return update(observation, "not-needed", prior.synthesis.revision, true);
        }
        attemptKey = digest([
          sourceSetDigest,
          digest(prior?.judgments ?? []),
          "capture-synthesis-v1"
        ]);
        const claimAttempt = await input.database.query(
          "INSERT INTO meeting_capture_synthesis_attempts(workspace_id,meeting_id,attempt_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING attempt_key",
          [workspaceId, meetingId, attemptKey]
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
                  ) ?? []
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
            claims: [
              ...claims.filter((claim) => !humanIds.has(claim.id)),
              ...humanClaims
            ],
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
        ...update(observation, "deferred", prior?.synthesis.revision ?? 0),
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
                partialResultAvailable: Boolean(prior)
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
        current.materialDigest !== state.materialDigest
      )
        throw new Unavailable();
      await requireSame(scope.workspaceId, scope.meetingId, current, state.audience);
      if (
        (await load(scope.workspaceId, scope.meetingId))?.synthesis.revision !==
        state.synthesis.revision
      )
        throw new Unavailable();
      return {
        type: "capture-synthesis",
        availability: "available",
        synthesis: structuredClone(state.synthesis)
      };
    } catch {
      return { type: "capture-synthesis", availability: "unavailable", synthesis: null };
    }
  };
  return {
    ...input.base,
    query: (scope) =>
      scope.query.type === "capture-synthesis"
        ? query(structuredClone(scope))
        : input.base.query(scope),
    observe: (request) => {
      if (!request.observations.some(isCaptureObservation))
        return input.base.observe(request);
      const bound = structuredClone(request);
      const key = digest([bound.workspace.workspaceId, bound.observations[0]?.meetingId]);
      const previous = flights.get(key);
      const next = previous
        ? previous.catch(() => undefined).then(() => observe(bound))
        : observe(bound);
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
    if (judgment.judgment.kind === "correct") {
      claim.text = judgment.judgment.text;
      claim.quotations = [];
    }
  }
  return result;
}
function sorted<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) =>
    canonical(left).localeCompare(canonical(right))
  );
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}
