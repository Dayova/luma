import {
  automaticRetryState,
  failedAutomaticAttempt,
  type AutomaticDetectionAttempt
} from "./automatic-retry.js";
import { z } from "zod";
import type {
  AutomaticDecisionBatch,
  ConcludeAutomaticDecisions,
  AutomaticDecisionConclusion,
  ObserveProcessedDecisionSource,
  QueryAutomaticDecisions,
  DecisionStandingGrant
} from "../domain/automatic-decisions.js";
import type {
  DecisionAuthoritySnapshot,
  DecisionCatalogSnapshot,
  DecisionSource,
  DecisionRequestState,
  CanonicalDecisionRecord
} from "../domain/decision-records.js";
import {
  canonicalDecisionRecordSchema,
  decisionAuthoritySnapshotSchema,
  decisionInterpretationSchema,
  decisionSourceSchema,
  decisionSubjectSchema
} from "../domain/decision-record-schemas.js";
import { withExecutionRunLock } from "../follow-up-execution/execution-run-lock.js";
import { createDecisionFollowUpExecution } from "../follow-up-execution/decision-execution.js";
import { AiServiceError } from "../ai/ai-service-error.js";
import {
  authorityFor,
  captureReviewConflict,
  reconcileDecision,
  requireDecisionRequestCurrent,
  type DecisionIntelligenceDependencies
} from "./decision-intelligence.js";
import {
  decisionStandingGrantSchema,
  requireAutomaticPolicyCurrent
} from "./automatic-policy.js";
import {
  decisionDigest,
  decisionSubjectKey,
  readDecisionRequest,
  readDecisionStages,
  saveDecisionObservation,
  saveDecisionRequest,
  type StoredDecisionRequest
} from "./persistence.js";
import type { DecisionIntelligence } from "./interface.js";

export interface AutomaticDecisionIntelligence {
  observe(input: ObserveProcessedDecisionSource): Promise<AutomaticDecisionBatch>;
  query(input: QueryAutomaticDecisions): Promise<AutomaticDecisionBatch>;
  conclude(input: ConcludeAutomaticDecisions): Promise<AutomaticDecisionConclusion>;
}
type StoredBatch = Omit<
  AutomaticDecisionBatch,
  "candidates" | "duplicate" | "analysisRetry"
> & {
  requestIds: string[];
  attempts?: AutomaticDetectionAttempt[];
};
const detectionSchema = z
  .object({
    complete: z.boolean(),
    candidates: z
      .array(
        z
          .object({
            confidence: z.enum(["high", "medium", "low"]),
            interpretation: decisionInterpretationSchema.refine(
              (value) => value.candidate !== null
            )
          })
          .strict()
      )
      .max(20)
  })
  .strict();

/** Processing, detection, approval and durable execution stay behind the MI facade. */
export function createAutomaticDecisionIntelligence(
  input: DecisionIntelligenceDependencies,
  decision: DecisionIntelligence
): AutomaticDecisionIntelligence {
  const configuration = input.automatic;
  if (!configuration) throw new Error("Automatic Decision processing is not configured");
  const executor = createDecisionFollowUpExecution(input);
  const now = input.now ?? (() => new Date());
  const requireSource = async (source: DecisionSource) => {
    const audience = await input.audience(source.audience.workspaceId);
    if (
      !audience ||
      decisionDigest({ ...audience, personIds: [...audience.personIds].sort() }) !==
        decisionDigest({
          ...source.audience,
          personIds: [...source.audience.personIds].sort()
        })
    )
      throw new Error("The automatic Decision's original audience changed");
    await configuration.evidenceSource.requireCurrent(source);
  };
  const save = async (workspaceId: string, batch: StoredBatch) => {
    await input.database.query(
      `INSERT INTO automatic_decision_batches(workspace_id,batch_id,payload_json,payload_hash) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,batch_id) DO UPDATE SET payload_json=excluded.payload_json,payload_hash=excluded.payload_hash`,
      [workspaceId, batch.batchId, JSON.stringify(batch), decisionDigest(batch)]
    );
  };
  const load = async (
    workspaceId: string,
    batchId: string
  ): Promise<StoredBatch | null> => {
    const row = (
      await input.database.query<{ payload_json: string; payload_hash: string }>(
        `SELECT payload_json,payload_hash FROM automatic_decision_batches WHERE workspace_id=$1 AND batch_id=$2`,
        [workspaceId, batchId]
      )
    ).rows[0];
    if (!row) return null;
    const value = JSON.parse(row.payload_json) as StoredBatch;
    if (decisionDigest(value) !== row.payload_hash)
      throw new Error("Automatic Decision batch integrity failed");
    return value;
  };
  const query = async (
    request: QueryAutomaticDecisions
  ): Promise<AutomaticDecisionBatch> => {
    request = structuredClone(request);
    decisionSubjectSchema.parse(request.subject);
    const batchId =
      request.query.batchId ??
      (
        await input.database.query<{ batch_id: string }>(
          `SELECT batch_id FROM automatic_decision_batches WHERE workspace_id=$1
        AND payload_json::jsonb->'subject'=$2::jsonb ORDER BY created_sequence DESC LIMIT 1`,
          [request.workspaceId, JSON.stringify(request.subject)]
        )
      ).rows[0]?.batch_id;
    const batch = batchId ? await load(request.workspaceId, batchId) : null;
    if (!batch || decisionDigest(batch.subject) !== decisionDigest(request.subject))
      throw new Error("Automatic Decision batch was not found in this subject");
    await requireSource(batch.source);
    const heads = await Promise.all(
      batch.requestIds.map((id) =>
        readDecisionRequest(input.database, request.workspaceId, id, request.subject)
      )
    );
    const stageHeads = await Promise.all(
      heads.map((head) =>
        head.intent
          ? readDecisionStages(input.database, request.workspaceId, head.intent.id)
          : Promise.resolve([])
      )
    );
    const candidates: DecisionRequestState[] = [];
    let withheld = 0;
    for (const requestId of batch.requestIds) {
      try {
        candidates.push(
          await decision.query({
            workspaceId: request.workspaceId,
            subject: request.subject,
            query: { type: "decision-request", requestId }
          })
        );
      } catch {
        const head = heads.find((entry) => entry.state.requestId === requestId)!;
        // Keep the retained request address visible, but never return stale catalog-derived content or references.
        candidates.push({
          ...head.state,
          candidate: null,
          approvedIntentId: null,
          execution: null,
          state: "needs-clarification" as const,
          message:
            "Current decision context could not be verified. This retained candidate needs a fresh review; no content or execution references are disclosed.",
          ...(head.state.automatic
            ? {
                automatic: {
                  ...head.state.automatic,
                  authority: "unresolved" as const,
                  reconciliation: {
                    action: "clarify" as const,
                    reason: "Current decision context unavailable"
                  },
                  recording: "review-only" as const
                }
              }
            : {})
        });
        withheld++;
      }
    }
    // A new Human observation during earlier candidate reads must not be hidden by a cached batch.
    await requireSource(batch.source);
    for (let index = 0; index < heads.length; index++) {
      const head = heads[index]!;
      if (!candidates[index]!.candidate) continue;
      try {
        const stages = head.intent
          ? await readDecisionStages(input.database, request.workspaceId, head.intent.id)
          : [];
        await requireDecisionRequestCurrent(
          input,
          { ...head, state: candidates[index]! },
          {
            catalog: !stages.length && !head.state.execution && !!head.catalog?.complete
          }
        );
      } catch {
        candidates[index] = {
          ...candidates[index]!,
          candidate: null,
          approvedIntentId: null,
          execution: null,
          state: "needs-clarification",
          message:
            "Current decision context changed before delivery. The candidate is retained for a fresh review.",
          ...(head.state.automatic
            ? {
                automatic: {
                  ...head.state.automatic,
                  authority: "unresolved",
                  reconciliation: {
                    action: "clarify",
                    reason: "Current context changed"
                  },
                  recording: "review-only"
                }
              }
            : {})
        };
        withheld++;
      }
    }
    await requireSource(batch.source);
    for (const [index, head] of heads.entries()) {
      const current = await readDecisionRequest(
        input.database,
        request.workspaceId,
        head.state.requestId,
        request.subject
      );
      const currentStages = current.intent
        ? await readDecisionStages(input.database, request.workspaceId, current.intent.id)
        : [];
      if (
        decisionDigest(head) !== decisionDigest(current) ||
        decisionDigest(stageHeads[index]) !== decisionDigest(currentStages)
      )
        throw new Error(
          "Automatic Decision review changed during delivery; read it again"
        );
    }
    if (
      decisionDigest(await load(request.workspaceId, batch.batchId)) !==
      decisionDigest(batch)
    )
      throw new Error("Automatic Decision batch changed during delivery");
    const { requestIds: _ids, attempts, ...value } = batch;
    const analysisRetry = automaticRetryState(attempts);
    void _ids;
    return {
      ...value,
      ...(analysisRetry ? { analysisRetry } : {}),
      candidates,
      duplicate: false,
      ...(withheld
        ? {
            complete: false,
            status: "needs-clarification" as const,
            message: `${withheld} retained candidate(s) need current context before their details can be shown. Other verified results remain available.`
          }
        : {})
    };
  };
  return {
    async observe(request) {
      request = structuredClone(request);
      decisionSubjectSchema.parse(request.subject);
      const observation = request.observations[0];
      if (
        !request.workspace.workspaceId.trim() ||
        request.observations.length !== 1 ||
        observation?.type !== "decision-source-processed" ||
        !observation.observationId.trim() ||
        observation.observationId.length > 512 ||
        (observation.retryBatchId !== undefined &&
          (!observation.retryBatchId.trim() || observation.retryBatchId.length > 512)) ||
        (observation.retryBeforeScheduled !== undefined &&
          (observation.retryBeforeScheduled !== true || !observation.retryBatchId))
      )
        throw new Error("One bounded processed-source Observation is required");
      const result = await withExecutionRunLock(
        input.database,
        `decision-write:${input.records.providerId}`,
        async () => {
          const audience = await input.audience(request.workspace.workspaceId);
          if (!audience || audience.workspaceId !== request.workspace.workspaceId)
            throw new Error("The automatic Decision audience is unavailable");
          const source = decisionSourceSchema.parse(
            await configuration.evidenceSource.captureProcessed({
              workspace: request.workspace,
              subject: request.subject,
              audience
            })
          );
          if (
            decisionDigest(source.subject) !== decisionDigest(request.subject) ||
            decisionDigest({
              ...source.audience,
              personIds: [...source.audience.personIds].sort()
            }) !==
              decisionDigest({ ...audience, personIds: [...audience.personIds].sort() })
          )
            throw new Error("The processed source changed its subject or audience");
          await requireSource(source);
          const batchId = `decision-batch:${decisionDigest({ workspaceId: request.workspace.workspaceId, subject: request.subject, authorizationHash: source.authorizationHash, contentHash: source.contentHash, revision: source.revision, audience: source.audience })}`;
          if (observation.retryBatchId && observation.retryBatchId !== batchId)
            throw new Error(
              "The retry source no longer matches its exact original batch"
            );
          await saveDecisionObservation(
            input.database,
            request.workspace.workspaceId,
            batchId,
            observation.observationId,
            {
              request,
              sourceBinding: {
                contentHash: source.contentHash,
                authorizationHash: source.authorizationHash,
                revision: source.revision,
                audience: source.audience
              }
            }
          );
          const prior = await load(request.workspace.workspaceId, batchId);
          const retry = prior ? automaticRetryState(prior.attempts) : undefined;
          if (observation.retryBatchId && !prior)
            throw new Error("The original retry batch is missing");
          if (
            prior &&
            (!retry?.canRetry ||
              prior.requestIds.length ||
              (observation.retryBeforeScheduled &&
                prior.attempts?.some(
                  (attempt) => attempt.observationId === observation.observationId
                )) ||
              (!observation.retryBeforeScheduled &&
                (!retry.nextAttemptAt ||
                  now().getTime() < Date.parse(retry.nextAttemptAt))))
          )
            return { batch: prior, duplicate: true };
          const attempt: AutomaticDetectionAttempt = {
            observationId: observation.observationId,
            startedAt: now().toISOString(),
            disposition: "unknown",
            retryAt: null
          };
          const attempts = [...(prior?.attempts ?? []), attempt];
          const batch: StoredBatch = {
            batchId,
            subject: request.subject,
            source,
            status: "needs-clarification",
            message:
              "Automatic interpretation is incomplete. It will not silently rerun after interruption.",
            complete: false,
            requestIds: [],
            attempts
          };
          await save(request.workspace.workspaceId, batch);
          // These reads may be unavailable; original evidence remains reviewable and inference cannot authorize a write.
          let authority: DecisionAuthoritySnapshot | null = null,
            catalog: DecisionCatalogSnapshot | null = null;
          try {
            authority = decisionAuthoritySnapshotSchema.parse(
              await input.authority.read({ audience })
            );
            await input.authority.requireCurrent({ audience, snapshot: authority });
          } catch {
            authority = null;
          }
          try {
            catalog = await input.records.discover({ audience, limit: 100 });
            if (
              catalog.records.length > 100 ||
              new Set(
                catalog.records.map(
                  (record) =>
                    `${record.reference.providerId}:${record.reference.externalId}`
                )
              ).size !== catalog.records.length
            )
              throw new Error("Ambiguous catalog");
            catalog.records = catalog.records.map((record) =>
              canonicalDecisionRecordSchema.parse(record)
            );
            await input.records.requireCurrent({ audience, snapshot: catalog });
          } catch {
            catalog = null;
          }
          let grants: DecisionStandingGrant[] = [];
          try {
            grants = z
              .array(decisionStandingGrantSchema)
              .max(20)
              .parse((await configuration.policy?.read({ audience })) ?? []);
          } catch {
            grants = [];
          }
          let detectorReturned = false;
          try {
            const detected = await configuration.detector.detect({
              workspace: request.workspace,
              batchId,
              source: structuredClone(source),
              authority: structuredClone(authority),
              catalog: structuredClone(catalog)
            });
            detectorReturned = true;
            const detection = detectionSchema.parse(detected);
            await requireSource(source);
            if (authority)
              await input.authority.requireCurrent({ audience, snapshot: authority });
            if (catalog)
              await input.records.requireCurrent({ audience, snapshot: catalog });
            const reviewed = (
              await input.database.query<{ payload_json: string; payload_hash: string }>(
                `SELECT payload_json,payload_hash FROM decision_requests WHERE workspace_id=$1 AND subject_key=$2`,
                [request.workspace.workspaceId, decisionSubjectKey(request.subject)]
              )
            ).rows
              .map((row) => {
                const value = JSON.parse(row.payload_json) as StoredDecisionRequest;
                if (decisionDigest(value) !== row.payload_hash)
                  throw new Error("Decision history integrity failed");
                return value;
              })
              .filter(
                (value) =>
                  value.humanReviewed ||
                  value.state.automatic?.humanReviewed ||
                  value.humanReviews?.some((review) => review.reviewToken !== null)
              );
            const pending: StoredDecisionRequest[] = [];
            for (const [index, detected] of detection.candidates.entries()) {
              const interpretation = detected.interpretation;
              const candidate = interpretation.candidate!;
              const evidenceIds = new Set(source.evidence.map((evidence) => evidence.id));
              const claims = [
                candidate.statement,
                ...(candidate.context ? [candidate.context] : []),
                ...candidate.rationale,
                ...candidate.alternatives,
                ...candidate.consequences,
                ...candidate.objections
              ];
              if (
                claims.some((claim) =>
                  claim.evidenceIds.some((id) => !evidenceIds.has(id))
                ) ||
                candidate.acceptanceEvidenceIds.some((id) => !evidenceIds.has(id)) ||
                candidate.decisionMakerPersonIds.some(
                  (person) => !audience.personIds.includes(person)
                )
              )
                throw new Error(
                  "Automatic candidate cites evidence or identity outside the admitted original source"
                );
              const requestId = `automatic-decision:${decisionDigest([batchId, index])}`;
              let stored: StoredDecisionRequest = {
                requestHash: decisionDigest([batchId, index, detected]),
                actor: null,
                requesterPersonId: null,
                authority,
                catalog,
                intent: null,
                interpretation: null,
                state: {
                  requestId,
                  subject: request.subject,
                  state: "candidate",
                  message: "Retained automatic candidate for review.",
                  candidate: null,
                  approvedIntentId: null,
                  execution: null,
                  source,
                  automatic: {
                    batchId,
                    confidence: detected.confidence,
                    authority: "unresolved",
                    reconciliation: interpretation.reconciliation,
                    recording: "review-only",
                    humanReviewed: false
                  }
                }
              };
              const verified = typeof authorityFor(candidate, stored) !== "string";
              stored.state.automatic!.authority = verified ? "verified" : "unresolved";
              const sameScopeBatch =
                detection.candidates.filter(
                  (entry) => entry.interpretation.candidate?.scopeId === candidate.scopeId
                ).length > 1;
              const humanConflict = reviewed.some(
                (value) => value.state.candidate?.scopeId === candidate.scopeId
              );
              stored = reconcileDecision(stored, interpretation, "", "", now());
              const tentative = candidate.acceptanceEvidenceIds.some((id) => {
                const text =
                  source.evidence.find((evidence) => evidence.id === id)?.text ?? "";
                return /\?|\b(?:should|could|might|maybe|perhaps|prefer|sollten|könnten|würden|vielleicht|bevorzuge|not (?:yet )?(?:decided|final)|no decision|noch nicht (?:entschieden|final)|nicht beschlossen|keine entscheidung)\b/iu.test(
                  text
                );
              });
              if (tentative)
                stored.state.message =
                  "Tentative source wording needs explicit Human acceptance before automatic recording.";
              if (
                verified &&
                !tentative &&
                detected.confidence === "high" &&
                detection.complete &&
                !humanConflict &&
                !sameScopeBatch &&
                !candidate.objections.length &&
                !candidate.unresolved.length &&
                ["candidate", "confirmed"].includes(stored.state.state)
              ) {
                const eligible: StoredDecisionRequest[] = [];
                for (const grant of grants) {
                  const proposed = reconcileDecision(
                    stored,
                    interpretation,
                    "",
                    "",
                    now(),
                    { basis: "standing-policy", grant }
                  );
                  if (!proposed.intent) continue;
                  try {
                    await requireAutomaticPolicyCurrent(input, proposed.intent);
                    eligible.push(proposed);
                  } catch {
                    /* Unproven standing grants cannot approve. */
                  }
                }
                if (eligible.length === 1) {
                  stored = eligible[0]!;
                  stored.state.automatic!.recording = "standing-policy";
                } else if (eligible.length > 1)
                  stored.state.message =
                    "Overlapping standing recording grants require a targeted Human review.";
              }
              if (detected.confidence !== "high")
                stored.state.message =
                  "Candidate classification is uncertain. Review it before recording.";
              if (candidate.objections.length)
                stored.state.message =
                  "Retained objections require explicit Human review before automatic recording, including a proposed pause or discard.";
              if (sameScopeBatch) {
                stored.state.message =
                  "Several candidates share this scope. Review their relationships together; automatic recording is not approved.";
              }
              if (humanConflict) {
                stored.intent = null;
                stored.state.approvedIntentId = null;
                stored.state.state = "needs-clarification";
                stored.state.message =
                  "A retained Human judgment exists in this scope. This later inference cannot replace it; review the successor candidate explicitly.";
              }
              if (!detection.complete) {
                stored.intent = null;
                stored.state.approvedIntentId = null;
                stored.state.message =
                  "Candidate detection was incomplete. Review the retained candidates; no automatic recording is approved.";
              }
              const captureConflict = captureReviewConflict(candidate, stored);
              if (captureConflict) {
                stored.intent = null;
                stored.state.approvedIntentId = null;
                stored.state.state = "needs-clarification";
                stored.state.message = captureConflict;
              }
              pending.push(stored);
              batch.requestIds.push(requestId);
            }
            batch.complete =
              detection.complete &&
              !!authority &&
              !!catalog?.complete &&
              !pending.some(
                (entry) =>
                  pending.filter(
                    (other) =>
                      other.state.candidate?.scopeId === entry.state.candidate?.scopeId
                  ).length > 1
              );
            attempts[attempts.length - 1] = { ...attempt, disposition: "completed" };
            batch.status = batch.complete ? "completed" : "needs-clarification";
            batch.message = batch.complete
              ? "Candidates retain their modality, reconciliation and independent recording authorization."
              : "Candidates are retained for review. Detection, responsibility or canonical-record coverage was incomplete; no complete reconciliation is claimed.";
            await input.database.transaction(async (transaction) => {
              for (const stored of pending)
                await saveDecisionRequest(
                  transaction,
                  request.workspace.workspaceId,
                  stored
                );
              await transaction.query(
                `UPDATE automatic_decision_batches SET payload_json=$3,payload_hash=$4 WHERE workspace_id=$1 AND batch_id=$2`,
                [
                  request.workspace.workspaceId,
                  batchId,
                  JSON.stringify(batch),
                  decisionDigest(batch)
                ]
              );
            });
          } catch (error) {
            attempts[attempts.length - 1] = failedAutomaticAttempt(
              attempt,
              // A later admission/persistence failure cannot undo a completed
              // detector call's possible charge, even if that error is unsent.
              detectorReturned ? undefined : error,
              now(),
              request.workspace.timezone,
              attempts.length
            );
            batch.status = "needs-clarification";
            batch.complete = false;
            batch.requestIds = [];
            batch.message =
              error instanceof AiServiceError
                ? error.message
                : "Automatic decision analysis is unavailable. Original evidence is retained; an interrupted paid request is not repeated.";
            await save(request.workspace.workspaceId, batch);
          }
          return { batch, duplicate: false };
        }
      );
      // Durable execution owns its lock and per-stage proofs. Replays never resend uncertain writes.
      const positive = new Map<string, CanonicalDecisionRecord>();
      if (!result.duplicate)
        for (const requestId of result.batch.requestIds) {
          let stored = await readDecisionRequest(
            input.database,
            request.workspace.workspaceId,
            requestId,
            request.subject
          );
          if (stored.intent?.authorization.basis !== "standing-policy") continue;
          try {
            if (positive.size)
              stored = await withExecutionRunLock(
                input.database,
                `decision-write:${input.records.providerId}`,
                async () => {
                  const current = await readDecisionRequest(
                    input.database,
                    request.workspace.workspaceId,
                    requestId,
                    request.subject
                  );
                  if (
                    !current.intent ||
                    current.intent.authorization.basis !== "standing-policy" ||
                    !current.catalog ||
                    current.state.execution ||
                    (
                      await readDecisionStages(
                        input.database,
                        request.workspace.workspaceId,
                        current.intent.id
                      )
                    ).length
                  )
                    throw new Error(
                      "Decision request entered another execution or review"
                    );
                  const catalog = await input.records.discover({
                    audience: current.state.source.audience,
                    limit: 100
                  });
                  const expected = new Map(
                    current.catalog.records.map((record) => [
                      `${record.reference.providerId}:${record.reference.externalId}`,
                      record
                    ])
                  );
                  for (const [key, record] of positive) expected.set(key, record);
                  const ordered = (records: CanonicalDecisionRecord[]) =>
                    [...records].sort((a, b) =>
                      `${a.reference.providerId}:${a.reference.externalId}`.localeCompare(
                        `${b.reference.providerId}:${b.reference.externalId}`
                      )
                    );
                  if (
                    !catalog.complete ||
                    catalog.records.length > 100 ||
                    decisionDigest(ordered(catalog.records)) !==
                      decisionDigest(ordered([...expected.values()]))
                  )
                    throw new Error(
                      "The canonical catalog has a change beyond this batch's exact positive receipts"
                    );
                  await input.records.requireCurrent({
                    audience: current.state.source.audience,
                    snapshot: catalog
                  });
                  const updated = reconcileDecision(
                    { ...current, catalog },
                    current.intent.interpretation,
                    "",
                    "",
                    now(),
                    current.intent.authorization
                  );
                  if (!updated.intent)
                    throw new Error("The current recording plan needs a new review");
                  await requireAutomaticPolicyCurrent(input, updated.intent);
                  await requireSource(updated.state.source);
                  await saveDecisionRequest(
                    input.database,
                    request.workspace.workspaceId,
                    updated
                  );
                  return updated;
                }
              );
            const execution = await executor.execute({
              workspace: request.workspace,
              subject: request.subject,
              decisionRequestId: requestId,
              intentId: stored.intent!.id
            });
            if (execution.record.outcome.status !== "succeeded") break;
            const stages = await readDecisionStages(
              input.database,
              request.workspace.workspaceId,
              stored.intent!.id
            );
            if (stages.some((stage) => stage.state !== "succeeded" || !stage.receipt))
              break;
            for (const stage of stages) {
              const record = stage.receipt!.record;
              positive.set(
                `${record.reference.providerId}:${record.reference.externalId}`,
                record
              );
            }
          } catch {
            break; /* The final governed query preserves available receipts and visible review needs. */
          }
        }
      return {
        ...(await query({
          workspaceId: request.workspace.workspaceId,
          subject: request.subject,
          query: { type: "automatic-decision-candidates", batchId: result.batch.batchId }
        })),
        duplicate: result.duplicate
      };
    },
    query,
    async conclude(request) {
      const batch = await query({
        workspaceId: request.workspaceId,
        subject: request.subject,
        query: { type: "automatic-decision-candidates", batchId: request.batchId }
      });
      return { batch, summary: batch.message };
    }
  };
}
