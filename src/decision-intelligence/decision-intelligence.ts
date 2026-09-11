import { AiServiceError } from "../ai/ai-service-error.js";
import { randomUUID } from "node:crypto";
import {
  decisionInterpretationSchema,
  decisionCandidateSchema,
  decisionSourceSchema,
  decisionAuthoritySnapshotSchema,
  canonicalDecisionRecordSchema
} from "../domain/decision-record-schemas.js";
import type { WorkspaceAccessPolicy } from "../access/workspace-access-policy.js";
import type {
  DecisionAudience,
  DecisionAuthorityProof,
  DecisionCandidate,
  DecisionInterpretation,
  DecisionRequestState,
  DecisionRecordContent,
  ObserveDecision,
  QueryDecision
} from "../domain/decision-records.js";
import type { DecisionRecords } from "../knowledge/decision-records.js";
import type { LumaDatabase } from "../persistence/db.js";
import { withExecutionRunLock } from "../follow-up-execution/execution-run-lock.js";
import type { DecisionIntelligence } from "./interface.js";
import type {
  DecisionAuthority,
  DecisionEvidenceSource,
  DecisionInterpreter
} from "./ports.js";
import {
  decisionDigest,
  findDecisionRequest,
  readDecisionRequest,
  readDecisionStages,
  saveDecisionObservation,
  saveDecisionRequest,
  type StoredDecisionRequest
} from "./persistence.js";

export type DecisionIntelligenceConfiguration = {
  evidenceSource: DecisionEvidenceSource;
  authority: DecisionAuthority;
  interpreter: DecisionInterpreter;
  records: DecisionRecords;
  accessPolicy: WorkspaceAccessPolicy;
  audience(workspaceId: string): Promise<DecisionAudience | null>;
};
export type DecisionIntelligenceDependencies = DecisionIntelligenceConfiguration & {
  database: LumaDatabase;
  now?: () => Date;
};

/** Fresh output fencing is also used by Follow-up Execution before claim, send and replay. */
export async function requireDecisionRequestCurrent(
  input: DecisionIntelligenceDependencies,
  stored: StoredDecisionRequest,
  options: { catalog?: boolean } = {}
): Promise<void> {
  const audience = await input.audience(stored.state.source.audience.workspaceId);
  if (
    !audience ||
    decisionDigest({ ...audience, personIds: [...audience.personIds].sort() }) !==
      decisionDigest({
        ...stored.state.source.audience,
        personIds: [...stored.state.source.audience.personIds].sort()
      })
  )
    throw new Error("Decision audience changed; request a fresh review");
  const actor = await input.accessPolicy.authorize({
    workspaceId: audience.workspaceId,
    ...stored.actor
  });
  if (
    actor?.personId !== stored.requesterPersonId ||
    !audience.personIds.includes(actor.personId)
  )
    throw new Error("Decision requester is no longer authorized");
  await input.evidenceSource.requireCurrent(stored.state.source);
  await input.authority.requireCurrent({ audience, snapshot: stored.authority });
  if (options.catalog)
    await input.records.requireCurrent({ audience, snapshot: stored.catalog });
  const refs = stored.state.execution?.outcome.references ?? [];
  for (const ref of refs) {
    const record = await input.records.read({ audience, recordId: ref.externalId });
    if (
      !record ||
      record.reference.providerId !== ref.providerId ||
      record.reference.externalId !== ref.externalId ||
      record.reference.url !== ref.url
    )
      throw new Error("Recorded Decision reference is no longer current or readable");
  }
}

function authorityFor(
  candidate: DecisionCandidate,
  stored: StoredDecisionRequest
): DecisionAuthorityProof | string {
  const evidence = new Map(stored.state.source.evidence.map((item) => [item.id, item]));
  const claims = [
    candidate.statement,
    ...(candidate.context ? [candidate.context] : []),
    ...candidate.rationale,
    ...candidate.alternatives,
    ...candidate.consequences,
    ...candidate.objections
  ];
  if (
    claims.some(
      (claim) =>
        !claim.text.trim() ||
        !claim.evidenceIds.length ||
        claim.evidenceIds.some((id) => !evidence.has(id))
    )
  )
    return "Every decision detail needs exact source evidence; omit unsupported rationale or consequences.";
  if (!candidate.scopeId) return "The accountable decision scope is unclear.";
  if (candidate.unresolved.length)
    return "The decision still has unresolved qualifications.";
  if (
    candidate.objections.length &&
    candidate.disposition !== "pause" &&
    candidate.disposition !== "discard"
  )
    return "The source contains objections that need an explicit Human resolution.";
  if (!["final-decision", "accepted-proposal", "reversal"].includes(candidate.modality))
    return "This is not yet an evidenced final Human decision.";
  const grants = stored.authority.grants.filter(
    (grant) =>
      grant.scopeId === candidate.scopeId &&
      grant.standing === "current" &&
      grant.kind !== "provisional-role" &&
      grant.evidence.length > 0
  );
  const priority = (kind: string) =>
    kind === "delegation" ? 3 : kind === "project-ownership" ? 2 : 1;
  const highest = Math.max(0, ...grants.map((grant) => priority(grant.kind)));
  const selected = grants.filter((grant) => priority(grant.kind) === highest);
  const owners = [...new Set(selected.map((grant) => grant.personId))];
  if (
    owners.length !== 1 ||
    candidate.decisionMakerPersonIds.length !== 1 ||
    owners[0] !== candidate.decisionMakerPersonIds[0]
  )
    return "Current responsibility evidence does not establish one unambiguous accountable decision-maker.";
  if (
    selected.some(
      (grant) =>
        grant.kind === "delegation" &&
        (!grant.delegatedBy ||
          !stored.authority.grants.some(
            (parent) =>
              parent.personId === grant.delegatedBy &&
              parent.scopeId === grant.scopeId &&
              parent.standing === "current" &&
              parent.kind !== "provisional-role" &&
              parent.kind !== "delegation"
          ))
    )
  )
    return "The delegation does not have current authority evidence.";
  if (
    !candidate.acceptanceEvidenceIds.length ||
    candidate.acceptanceEvidenceIds.some((id) => {
      const item = evidence.get(id);
      return !item || item.origin !== "human" || item.authorPersonId !== owners[0];
    })
  )
    return "A poll, summary, or another speaker cannot establish the owner's acceptance.";
  if (
    !candidate.statement.evidenceIds.some((id) =>
      candidate.acceptanceEvidenceIds.includes(id)
    ) &&
    candidate.modality !== "accepted-proposal"
  )
    return "The final decision statement needs the accountable owner's Human evidence.";
  const consulted = [...new Set(selected.flatMap((grant) => grant.consultedPersonIds))];
  if (
    consulted.some(
      (personId) =>
        ![...evidence.values()].some(
          (item) =>
            item.origin === "human" &&
            item.authorPersonId === personId &&
            claims.some((claim) => claim.evidenceIds.includes(item.id))
        )
    )
  )
    return "Required affected stakeholders have not been evidenced in the discussion.";
  return {
    snapshot: stored.authority,
    grantIds: selected.map((grant) => grant.id),
    decisionMakerPersonIds: owners,
    acceptanceEvidenceIds: [...candidate.acceptanceEvidenceIds]
  };
}

/** Inference selects a candidate; deterministic reconciliation alone grants a write plan. */
export function reconcileDecision(
  stored: StoredDecisionRequest,
  interpretation: DecisionInterpretation,
  instruction: string,
  evidenceId: string,
  now: Date
): StoredDecisionRequest {
  const result = structuredClone(stored);
  result.intent = null;
  result.interpretation = interpretation;
  const candidate = interpretation.candidate;
  const clarify = (message: string) => {
    result.state = {
      ...result.state,
      state: "needs-clarification",
      message,
      candidate,
      approvedIntentId: null
    };
    return result;
  };
  if (interpretation.reconciliation.action === "reject") {
    result.state = {
      ...result.state,
      state: "rejected",
      message: interpretation.reconciliation.reason,
      candidate,
      approvedIntentId: null
    };
    return result;
  }
  if (interpretation.reconciliation.action === "clarify")
    return clarify(interpretation.reconciliation.reason);
  if (!candidate) return clarify("No supported decision was identified.");
  const knownReferences = new Set([
    ...stored.state.source.evidence.flatMap((item) =>
      item.reference.externalReference
        ? [decisionDigest(item.reference.externalReference)]
        : []
    ),
    ...stored.catalog.records.flatMap((record) => [
      decisionDigest(record.reference),
      ...record.content.candidate.relatedWork.map(decisionDigest),
      ...record.content.candidate.implementationEvidence.map(decisionDigest)
    ])
  ]);
  if (
    [...candidate.relatedWork, ...candidate.implementationEvidence].some(
      (reference) => !knownReferences.has(decisionDigest(reference))
    )
  )
    return clarify(
      "Related work or implementation evidence must name a verified existing source reference."
    );
  const authority = authorityFor(candidate, stored);
  if (typeof authority === "string") return clarify(authority);
  if (!stored.catalog.complete)
    return clarify("The canonical Decision Record search was incomplete.");
  const action = interpretation.reconciliation;
  const targets =
    "targetRecordId" in action
      ? stored.catalog.records.filter(
          (record) =>
            record.content.id === action.targetRecordId ||
            record.reference.externalId === action.targetRecordId
        )
      : [];
  if (targets.length > 1)
    return clarify(
      "The selected record identity is ambiguous in the current canonical catalog."
    );
  const target = targets[0];
  if ("targetRecordId" in action && !target)
    return clarify(
      "The selected canonical record was not found in the complete current catalog."
    );
  if (target && target.content.status !== "active")
    return clarify(
      "The selected record is no longer active; select the current record explicitly."
    );
  if (target && target.content.candidate.scopeId !== candidate.scopeId)
    return clarify("The selected record belongs to a different decision scope.");
  if (
    action.action === "create" &&
    stored.catalog.records.some(
      (record) =>
        record.content.status === "active" &&
        record.content.candidate.scopeId === candidate.scopeId &&
        record.content.candidate.statement.text.trim().toLocaleLowerCase() ===
          candidate.statement.text.trim().toLocaleLowerCase()
    )
  )
    return clarify(
      "An active record already states this decision; link or update it explicitly."
    );
  if (action.action === "reverse" && candidate.modality !== "reversal")
    return clarify("A reversal requires explicit Human reversal evidence.");
  if (
    action.action === "amend" &&
    target &&
    target.content.candidate.statement.text !== candidate.statement.text
  )
    return clarify(
      "Changing a decision statement requires a linked superseding record, preserving its history."
    );
  if (
    action.action === "link" &&
    target &&
    target.content.candidate.statement.text.trim() !== candidate.statement.text.trim()
  )
    return clarify(
      "The selected record does not state this exact decision; choose an explicit amendment or replacement."
    );
  const operationId = randomUUID(),
    intentId = `decision-intent:${randomUUID()}`;
  const record: DecisionRecordContent = {
    id:
      action.action === "amend" && target
        ? target.content.id
        : `decision:${randomUUID()}`,
    candidate,
    authority,
    source: result.state.source,
    status:
      action.action === "supersede" || action.action === "reverse" ? "pending" : "active",
    recordedAt: now.toISOString(),
    supersedes:
      action.action === "amend" && target
        ? structuredClone(target.content.supersedes)
        : target && (action.action === "supersede" || action.action === "reverse")
          ? [target.reference]
          : [],
    supersededBy: null
  };
  result.intent = {
    id: intentId,
    type: "record-decision",
    status: "approved",
    requestId: result.state.requestId,
    operationId,
    interpretation: { ...interpretation, candidate },
    source: result.state.source,
    authority,
    catalog: stored.catalog,
    record,
    target: target ?? null,
    authorization: {
      basis: "explicit-instruction",
      authorizedBy: stored.requesterPersonId,
      instruction,
      evidenceId
    }
  };
  result.state = {
    ...result.state,
    state: "confirmed",
    message:
      action.action === "link"
        ? "The existing canonical decision is selected for a verified link."
        : "The evidenced decision is confirmed and its exact recording plan is approved.",
    candidate,
    approvedIntentId: intentId
  };
  return result;
}

export function createDecisionIntelligence(
  input: DecisionIntelligenceDependencies
): DecisionIntelligence {
  const now = input.now ?? (() => new Date());
  const read = async (request: QueryDecision): Promise<DecisionRequestState> => {
    const stored = await readDecisionRequest(
      input.database,
      request.workspaceId,
      request.query.requestId,
      request.subject
    );
    const requestHead = decisionDigest(stored);
    const stages = stored.intent
      ? await readDecisionStages(input.database, request.workspaceId, stored.intent.id)
      : [];
    const stageHead = decisionDigest(stages);
    const provenRefusal =
      stored.state.execution?.outcome.status === "failed" &&
      !stored.state.execution.outcome.requiresManualRecovery &&
      stages.every((stage) => stage.state === "not-applied" && stage.receipt === null);
    if (
      stages.length &&
      !provenRefusal &&
      stored.state.execution?.outcome.status !== "succeeded"
    ) {
      const known = new Map(
        (stored.state.execution?.outcome.references ?? []).map((reference) => [
          `${reference.providerId}:${reference.externalId}`,
          reference
        ])
      );
      for (const stage of stages)
        if (stage.receipt) {
          const reference = stage.receipt.record.reference;
          known.set(`${reference.providerId}:${reference.externalId}`, reference);
        }
      stored.state = {
        ...stored.state,
        state: "unknown",
        message:
          "Decision settlement is incomplete or in progress. Known records are retained; use explicit recovery.",
        execution: {
          type: "follow-up-execution-recorded",
          recordId: `${stored.intent!.operationId}:stage-state`,
          workspaceId: request.workspaceId,
          subject: request.subject,
          requestId: request.query.requestId,
          intentId: stored.intent!.id,
          operationId: stored.intent!.operationId,
          recordedAt: stages[0]!.createdAt,
          outcome: {
            status: "failed",
            errorCode: "decision-settlement-incomplete",
            message:
              "Decision settlement is incomplete or in progress. Known records are retained; use explicit recovery.",
            requiresManualRecovery: true,
            references: [...known.values()]
          }
        }
      };
    }
    await requireDecisionRequestCurrent(input, stored, {
      catalog: !stages.length && !stored.state.execution && stored.catalog.complete
    });
    await input.database.transaction(async (transaction) => {
      const current = await readDecisionRequest(
        transaction,
        request.workspaceId,
        request.query.requestId,
        request.subject
      );
      const currentStages = current.intent
        ? await readDecisionStages(transaction, request.workspaceId, current.intent.id)
        : [];
      if (
        decisionDigest(current) !== requestHead ||
        decisionDigest(currentStages) !== stageHead
      )
        throw new Error(
          "Decision state changed during its final currentness check; read the current request again"
        );
    });
    return structuredClone(stored.state);
  };
  return {
    observe: (request) =>
      withExecutionRunLock(
        input.database,
        `decision-write:${input.records.providerId}`,
        async () => {
          const bound = structuredClone(request);
          validateRequest(bound);
          const observation = bound.observations[0];
          const requestId =
            observation.type === "decision-record-requested"
              ? observation.observationId
              : observation.requestId;
          const prior = await findDecisionRequest(
            input.database,
            bound.workspace.workspaceId,
            requestId
          );
          if (observation.type === "decision-record-requested" && prior) {
            if (prior.requestHash !== decisionDigest(bound))
              throw new Error(
                "Decision request ID has a different immutable instruction or subject"
              );
            return {
              ...(await read({
                workspaceId: bound.workspace.workspaceId,
                subject: bound.subject,
                query: { type: "decision-request", requestId }
              })),
              duplicate: true
            };
          }
          const audience = await input.audience(bound.workspace.workspaceId);
          const person = await input.accessPolicy.authorize({
            workspaceId: bound.workspace.workspaceId,
            ...observation.actor
          });
          if (
            !audience ||
            audience.workspaceId !== bound.workspace.workspaceId ||
            !person ||
            !audience.personIds.includes(person.personId) ||
            new Set(audience.personIds).size !== audience.personIds.length ||
            !audience.personIds.length
          )
            throw new Error("Decision requester or audience is not authorized");
          if (observation.type === "decision-candidate-corrected") {
            if (
              !prior ||
              decisionDigest(prior.state.subject) !== decisionDigest(bound.subject)
            )
              throw new Error("Select an existing decision candidate in this subject");
            await requireDecisionRequestCurrent(input, prior, { catalog: true });
            const stages = prior.intent
              ? await readDecisionStages(
                  input.database,
                  bound.workspace.workspaceId,
                  prior.intent.id
                )
              : [];
            if (prior.state.execution || stages.length)
              throw new Error(
                "This recording already entered execution; use an explicit new update instruction"
              );
            if (!prior.interpretation)
              throw new Error(
                "A clarified recording instruction is required before correcting this candidate"
              );
            const updated = reconcileDecision(
              { ...prior, actor: observation.actor, requesterPersonId: person.personId },
              {
                ...prior.interpretation,
                candidate: decisionCandidateSchema.parse(observation.candidate)
              },
              observation.reason,
              observation.observationId,
              now()
            );
            const fresh = await input.database.transaction(async (transaction) => {
              const accepted = await saveDecisionObservation(
                transaction,
                bound.workspace.workspaceId,
                requestId,
                observation.observationId,
                bound
              );
              if (accepted)
                await saveDecisionRequest(
                  transaction,
                  bound.workspace.workspaceId,
                  updated
                );
              return accepted;
            });
            if (!fresh)
              return {
                ...(await read({
                  workspaceId: bound.workspace.workspaceId,
                  subject: bound.subject,
                  query: { type: "decision-request", requestId }
                })),
                duplicate: true
              };
            return {
              ...(await read({
                workspaceId: bound.workspace.workspaceId,
                subject: bound.subject,
                query: { type: "decision-request", requestId }
              })),
              duplicate: false
            };
          }
          const source = decisionSourceSchema.parse(
            await input.evidenceSource.capture({
              workspace: bound.workspace,
              subject: bound.subject,
              instruction: observation.instruction,
              actor: observation.actor,
              audience
            })
          );
          if (
            decisionDigest(source.subject) !== decisionDigest(bound.subject) ||
            decisionDigest({
              ...source.audience,
              personIds: [...source.audience.personIds].sort()
            }) !==
              decisionDigest({ ...audience, personIds: [...audience.personIds].sort() })
          )
            throw new Error("Captured decision source changed its subject or recipients");
          const authority = decisionAuthoritySnapshotSchema.parse(
            await input.authority.read({ audience })
          );
          const catalog = await input.records.discover({ audience, limit: 100 });
          if (
            catalog.records.length > 100 ||
            new Set(catalog.records.map((record) => record.reference.externalId)).size !==
              catalog.records.length
          )
            throw new Error("Canonical decision catalog is ambiguous or unbounded");
          catalog.records = catalog.records.map((record) =>
            canonicalDecisionRecordSchema.parse(record)
          );
          let stored: StoredDecisionRequest = {
            requestHash: decisionDigest(bound),
            actor: observation.actor,
            requesterPersonId: person.personId,
            authority,
            catalog,
            intent: null,
            interpretation: null,
            state: {
              requestId,
              subject: bound.subject,
              state: "candidate",
              message:
                "Decision interpretation is incomplete; an interrupted request is never silently replayed.",
              candidate: null,
              approvedIntentId: null,
              execution: null,
              source
            }
          };
          await requireDecisionRequestCurrent(input, stored, { catalog: true });
          await saveDecisionObservation(
            input.database,
            bound.workspace.workspaceId,
            requestId,
            observation.observationId,
            bound
          );
          await saveDecisionRequest(input.database, bound.workspace.workspaceId, stored);
          if (!catalog.complete) {
            stored.state.state = "needs-clarification";
            stored.state.message = "The canonical Decision Record search was incomplete.";
            await saveDecisionRequest(
              input.database,
              bound.workspace.workspaceId,
              stored
            );
            return {
              ...(await read({
                workspaceId: bound.workspace.workspaceId,
                subject: bound.subject,
                query: { type: "decision-request", requestId }
              })),
              duplicate: false
            };
          }
          try {
            const interpretation = decisionInterpretationSchema.parse(
              await input.interpreter.interpret(
                structuredClone({
                  workspace: bound.workspace,
                  requestId,
                  instruction: observation.instruction,
                  requesterPersonId: person.personId,
                  source,
                  authority,
                  catalog,
                  ...(observation.targetRecordId
                    ? { targetRecordId: observation.targetRecordId }
                    : {})
                })
              )
            );
            if (
              observation.targetRecordId &&
              !(
                "targetRecordId" in interpretation.reconciliation &&
                interpretation.reconciliation.targetRecordId ===
                  observation.targetRecordId
              ) &&
              !["reject", "clarify"].includes(interpretation.reconciliation.action)
            )
              throw new Error("The model changed the explicitly selected target");
            await requireDecisionRequestCurrent(input, stored, { catalog: true });
            stored = reconcileDecision(
              stored,
              interpretation,
              observation.instruction,
              observation.observationId,
              now()
            );
          } catch (error) {
            stored.state = {
              ...stored.state,
              state: "needs-clarification",
              message: decisionFailureMessage(error)
            };
          }
          await saveDecisionRequest(input.database, bound.workspace.workspaceId, stored);
          return {
            ...(await read({
              workspaceId: bound.workspace.workspaceId,
              subject: bound.subject,
              query: { type: "decision-request", requestId }
            })),
            duplicate: false
          };
        }
      ),
    query: read,
    conclude: async (request) => {
      const state = await read({
        workspaceId: request.workspaceId,
        subject: request.subject,
        query: { type: "decision-request", requestId: request.requestId }
      });
      return { request: state, summary: state.message };
    }
  };
}
function validateRequest(request: ObserveDecision): void {
  const id = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 && value.length <= 512;
  const subject = request.subject;
  if (
    !id(request.workspace.workspaceId) ||
    !subject ||
    (subject.type === "meeting"
      ? !id(subject.meetingId)
      : subject.type !== "conversation-thread" ||
        ![
          subject.providerId,
          subject.conversationObjectId,
          subject.anchorMessageId
        ].every(id)) ||
    request.observations.length !== 1
  )
    throw new Error("Select one bounded Decision subject and instruction");
  const observation = request.observations[0];
  if (
    !id(observation.observationId) ||
    !id(observation.actor.providerId) ||
    !id(observation.actor.providerUserId)
  )
    throw new Error("An authenticated explicit Decision request is required");
  if (
    observation.type === "decision-record-requested" &&
    (!observation.instruction.trim() || observation.instruction.length > 4000)
  )
    throw new Error("The explicit recording instruction must be bounded");
  if (
    observation.type === "decision-candidate-corrected" &&
    (!id(observation.requestId) ||
      !observation.reason.trim() ||
      observation.reason.length > 2000)
  )
    throw new Error("A bounded Human correction reason is required");
}

function decisionFailureMessage(error: unknown): string {
  if (!(error instanceof AiServiceError))
    return "Decision interpretation could not be completed safely. Use a fresh explicit instruction after the source, model or catalog becomes available.";
  const reasons: Record<AiServiceError["code"], string> = {
    "budget-exhausted": "Luma's AI usage budget is exhausted.",
    "provider-quota": "The AI provider quota or credits are exhausted.",
    "rate-limited": "The AI provider is rate limiting requests.",
    timeout: "The AI interpretation timed out.",
    unavailable: "The AI service is temporarily unavailable.",
    "not-configured": "The AI service is not configured.",
    "request-too-large": "This decision source exceeds the AI request limit.",
    "request-indeterminate":
      "The AI request outcome is uncertain; it will not be replayed automatically."
  };
  const reset =
    error.resetAt && Number.isFinite(Date.parse(error.resetAt))
      ? ` Budget reset: ${new Date(error.resetAt).toISOString()}.`
      : "";
  return `${reasons[error.code]}${reset} The source was retained and no canonical write was sent. Use a fresh recording instruction when the service is available.`;
}
