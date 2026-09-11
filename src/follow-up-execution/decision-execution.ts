import { randomUUID } from "node:crypto";
import type {
  DecisionExecutionRecord,
  DecisionFollowUpIntent,
  DecisionRecordContent,
  DecisionWriteReceipt,
  DecisionWriteStage
} from "../domain/decision-records.js";
import {
  canonicalDecisionRecordSchema,
  decisionWriteStageSchema
} from "../domain/decision-record-schemas.js";
import type { ExternalReference } from "../domain/model.js";
import { DecisionWriteNotAppliedError } from "../knowledge/decision-records.js";
import {
  requireDecisionRequestCurrent,
  type DecisionIntelligenceDependencies
} from "../decision-intelligence/decision-intelligence.js";
import {
  acquireDecisionFence,
  decisionDigest,
  readDecisionRequest,
  readDecisionStages,
  releaseDecisionFence,
  saveDecisionRequest,
  saveDecisionStage,
  type StoredDecisionStage
} from "../decision-intelligence/persistence.js";
import type {
  DecisionFollowUpExecution,
  ExecuteDecisionFollowUpInput,
  ExecuteDecisionFollowUpResult
} from "./interface.js";
import { withExecutionRunLock } from "./execution-run-lock.js";

function expectedContent(stage: DecisionWriteStage): DecisionRecordContent {
  switch (stage.type) {
    case "create-record":
    case "amend-record":
      return stage.record;
    case "retire-record":
      return {
        ...stage.target.content,
        status: stage.status,
        supersededBy: stage.successor
      };
    case "activate-record":
      return { ...stage.target.content, status: "active" };
  }
}
function verifyReceipt(
  receipt: DecisionWriteReceipt,
  stage: StoredDecisionStage,
  providerId: string
): DecisionWriteReceipt {
  const record = canonicalDecisionRecordSchema.parse(receipt.record);
  if (
    receipt.operationId !== stage.operationId ||
    !Number.isFinite(Date.parse(receipt.observedAt)) ||
    record.reference.providerId !== providerId ||
    decisionDigest(record.content) !== decisionDigest(expectedContent(stage.stage)) ||
    ("target" in stage.stage &&
      record.reference.externalId !== stage.stage.target.reference.externalId)
  )
    throw new Error("Provider did not prove the exact approved Decision write");
  return { ...receipt, record };
}
function references(stages: StoredDecisionStage[]): ExternalReference[] {
  const map = new Map<string, ExternalReference>();
  for (const stage of stages)
    if (stage.receipt) {
      const ref = stage.receipt.record.reference;
      map.set(`${ref.providerId}:${ref.externalId}`, ref);
    }
  return [...map.values()];
}
function nextStage(
  intent: DecisionFollowUpIntent,
  stages: StoredDecisionStage[],
  createdAt: string
): StoredDecisionStage | null {
  const action = intent.interpretation.reconciliation.action;
  let stage: DecisionWriteStage | undefined;
  if (stages.length === 0) {
    if (action === "create" || action === "supersede" || action === "reverse")
      stage = { type: "create-record", record: intent.record };
    else if (action === "amend" && intent.target)
      stage = { type: "amend-record", target: intent.target, record: intent.record };
  } else if (
    (action === "supersede" || action === "reverse") &&
    stages.every((value) => value.state === "succeeded")
  ) {
    const created = stages[0]?.receipt?.record;
    if (stages.length === 1 && created && intent.target)
      stage = {
        type: "retire-record",
        target: intent.target,
        status: action === "reverse" ? "reversed" : "superseded",
        successor: created.reference
      };
    else if (stages.length === 2 && created)
      stage = { type: "activate-record", target: created };
  }
  return stage
    ? {
        index: stages.length,
        createdAt,
        stage: decisionWriteStageSchema.parse(stage),
        operationId: `${intent.operationId}:${stages.length}`,
        state: "pending",
        receipt: null
      }
    : null;
}
export function createDecisionFollowUpExecution(
  input: DecisionIntelligenceDependencies
): DecisionFollowUpExecution {
  const now = input.now ?? (() => new Date());
  const run = (
    request: ExecuteDecisionFollowUpInput,
    recover: boolean
  ): Promise<ExecuteDecisionFollowUpResult> =>
    withExecutionRunLock(
      input.database,
      `decision-write:${input.records.providerId}`,
      async () => {
        const stored = await readDecisionRequest(
          input.database,
          request.workspace.workspaceId,
          request.decisionRequestId,
          request.subject
        );
        const intent = stored.intent;
        if (
          !intent ||
          intent.id !== request.intentId ||
          stored.state.approvedIntentId !== intent.id ||
          intent.status !== "approved"
        )
          throw new Error(
            "Load the current canonical approved Decision intent before execution"
          );
        await requireDecisionRequestCurrent(input, stored);
        if (stored.state.execution?.outcome.status === "succeeded")
          return { record: stored.state.execution, idempotencyKey: intent.operationId };
        const stages = await readDecisionStages(
          input.database,
          request.workspace.workspaceId,
          intent.id
        );
        const finish = async (
          outcome: DecisionExecutionRecord["outcome"]
        ): Promise<ExecuteDecisionFollowUpResult> => {
          const record: DecisionExecutionRecord = {
            type: "follow-up-execution-recorded",
            recordId: randomUUID(),
            workspaceId: request.workspace.workspaceId,
            subject: request.subject,
            requestId: request.decisionRequestId,
            intentId: intent.id,
            operationId: intent.operationId,
            recordedAt: now().toISOString(),
            outcome
          };
          stored.state = {
            ...stored.state,
            state:
              outcome.status === "succeeded"
                ? "recorded"
                : outcome.requiresManualRecovery
                  ? "unknown"
                  : "confirmed",
            message:
              outcome.status === "succeeded"
                ? "The canonical Decision Record is verified and recorded."
                : outcome.message,
            execution: record
          };
          await saveDecisionRequest(
            input.database,
            request.workspace.workspaceId,
            stored
          );
          if (outcome.status === "succeeded")
            await releaseDecisionFence(
              input.database,
              input.records.providerId,
              request.workspace.workspaceId,
              intent.id
            );
          await requireDecisionRequestCurrent(input, stored);
          return { record, idempotencyKey: intent.operationId };
        };
        const fail = (manual: boolean, message: string) =>
          finish({
            status: "failed",
            errorCode: manual ? "decision-write-unknown" : "decision-write-not-applied",
            message,
            requiresManualRecovery: manual,
            references: references(stages)
          });
        if (stored.state.execution && !recover)
          return { record: stored.state.execution, idempotencyKey: intent.operationId };
        if (intent.interpretation.reconciliation.action === "link") {
          await input.records.requireCurrent({
            audience: intent.source.audience,
            snapshot: intent.catalog
          });
          const target = intent.target;
          if (!target) throw new Error("The approved link has no canonical target");
          const current = await input.records.read({
            audience: intent.source.audience,
            recordId: target.reference.externalId
          });
          if (!current || decisionDigest(current) !== decisionDigest(target))
            throw new Error("The selected canonical decision changed");
          return finish({ status: "succeeded", references: [current.reference] });
        }
        await acquireDecisionFence(
          input.database,
          input.records.providerId,
          request.workspace.workspaceId,
          intent.id
        );
        try {
          for (let iteration = 0; iteration < 4; iteration++) {
            let active = stages.find((stage) => stage.state !== "succeeded");
            if (!active) {
              active = nextStage(intent, stages, now().toISOString()) ?? undefined;
              if (!active) {
                const result = await finish({
                  status: "succeeded",
                  references: references(stages)
                });
                await releaseDecisionFence(
                  input.database,
                  input.records.providerId,
                  request.workspace.workspaceId,
                  intent.id
                );
                return result;
              }
              await saveDecisionStage(
                input.database,
                request.workspace.workspaceId,
                intent.id,
                active
              );
              stages.push(active);
            }
            await requireDecisionRequestCurrent(input, stored);
            if (active.state === "executing" || active.state === "unknown") {
              if (!recover)
                return fail(
                  true,
                  "A prior Decision write may have happened. Explicit recovery can verify it without sending it again."
                );
              let receipt: DecisionWriteReceipt | null = null;
              try {
                receipt = await input.records.findWritten({
                  audience: intent.source.audience,
                  stage: structuredClone(active.stage),
                  operationId: active.operationId
                });
                if (receipt)
                  receipt = verifyReceipt(receipt, active, input.records.providerId);
              } catch {
                receipt = null;
              }
              if (!receipt) {
                active.state = "unknown";
                await saveDecisionStage(
                  input.database,
                  request.workspace.workspaceId,
                  intent.id,
                  active
                );
                return fail(
                  true,
                  "The provider cannot prove the original Decision write. No duplicate was sent."
                );
              }
              active.receipt = receipt;
              active.state = "succeeded";
              await saveDecisionStage(
                input.database,
                request.workspace.workspaceId,
                intent.id,
                active
              );
              continue;
            }
            if (active.state === "not-applied" && !recover)
              return fail(
                stages.some((stage) => stage.receipt !== null),
                "The approved write was not applied. Explicit recovery can retry only the proven pre-write refusal."
              );
            if (active.index === 0)
              await input.records.requireCurrent({
                audience: intent.source.audience,
                snapshot: intent.catalog
              });
            if ("target" in active.stage) {
              const current = await input.records.read({
                audience: intent.source.audience,
                recordId: active.stage.target.reference.externalId
              });
              if (
                !current ||
                decisionDigest(current) !== decisionDigest(active.stage.target)
              )
                throw new DecisionWriteNotAppliedError(
                  "decision-target-changed",
                  "The exact canonical Decision target changed before this stage"
                );
            }
            await requireDecisionRequestCurrent(input, stored);
            active.state = "executing";
            await saveDecisionStage(
              input.database,
              request.workspace.workspaceId,
              intent.id,
              active
            );
            // The pre-send stage is also visible after a process crash.
            stored.state = {
              ...stored.state,
              state: "unknown",
              message:
                "The approved Decision write is in progress or needs positive recovery.",
              execution: {
                type: "follow-up-execution-recorded",
                recordId: `${active.operationId}:claim`,
                workspaceId: request.workspace.workspaceId,
                subject: request.subject,
                requestId: request.decisionRequestId,
                intentId: intent.id,
                operationId: intent.operationId,
                recordedAt: now().toISOString(),
                outcome: {
                  status: "failed",
                  errorCode: "decision-write-in-progress",
                  message:
                    "The approved Decision write is in progress or needs positive recovery.",
                  requiresManualRecovery: true,
                  references: references(stages)
                }
              }
            };
            await saveDecisionRequest(
              input.database,
              request.workspace.workspaceId,
              stored
            );
            try {
              const receipt = await input.records.write({
                audience: intent.source.audience,
                stage: structuredClone(active.stage),
                operationId: active.operationId
              });
              active.receipt = verifyReceipt(receipt, active, input.records.providerId);
              active.state = "succeeded";
              await saveDecisionStage(
                input.database,
                request.workspace.workspaceId,
                intent.id,
                active
              );
            } catch (error) {
              active.state =
                error instanceof DecisionWriteNotAppliedError ? "not-applied" : "unknown";
              await saveDecisionStage(
                input.database,
                request.workspace.workspaceId,
                intent.id,
                active
              );
              if (
                active.state === "not-applied" &&
                !stages.some((stage) => stage.receipt)
              )
                await releaseDecisionFence(
                  input.database,
                  input.records.providerId,
                  request.workspace.workspaceId,
                  intent.id
                );
              return fail(
                active.state === "unknown" ||
                  stages.some((stage) => stage.receipt !== null),
                active.state === "unknown"
                  ? "The Decision write outcome is uncertain. Luma retained known references and will only perform positive recovery."
                  : "The provider refused the exact approved stage before writing. Earlier verified stages remain recorded."
              );
            }
          }
          return fail(
            true,
            "Decision settlement is incomplete; explicit recovery is required."
          );
        } catch (error) {
          const unresolved = stages.some(
            (stage) =>
              stage.state === "executing" ||
              stage.state === "unknown" ||
              stage.receipt !== null
          );
          if (!unresolved)
            await releaseDecisionFence(
              input.database,
              input.records.providerId,
              request.workspace.workspaceId,
              intent.id
            );
          if (error instanceof DecisionWriteNotAppliedError)
            return fail(
              unresolved,
              "The canonical Decision target changed before the next write. Known records are retained; request a fresh review."
            );
          throw error;
        }
      }
    );
  return {
    execute: (request) => run(request, false),
    recover: (request) => run(request, true)
  };
}
