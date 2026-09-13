import { randomUUID } from "node:crypto";
import {
  ConsultationNotPublishedError,
  type ConsultationProvider,
  type ConsultationReceipt
} from "../consultation/interface.js";
import { conversationPollSchema } from "../domain/conversation-poll.js";
import {
  appendConsultationEvent,
  consultationDigest,
  consultationSubjectKey,
  readConsultationOperation,
  type ConversationConsultations,
  type ConversationConsultationExecutionRecord,
  type StoredConsultationOperation,
  ConversationConsultationError
} from "../context-intelligence/conversation-consultations.js";
import type { LumaDatabase } from "../persistence/db.js";
import type {
  ConversationFollowUpExecution,
  ExecuteConversationFollowUpInput,
  ExecuteConversationFollowUpResult
} from "./interface.js";
import { withExecutionRunLock } from "./execution-run-lock.js";

export function createConversationFollowUpExecution(input: {
  database: LumaDatabase;
  consultations: ConversationConsultations;
  provider: ConsultationProvider;
  now?: () => Date;
}): ConversationFollowUpExecution {
  const now = input.now ?? (() => new Date());
  const address = (request: ExecuteConversationFollowUpInput) => ({
    workspaceId: request.workspace.workspaceId,
    subject: request.subject,
    intentId: request.intentId
  });
  const key = (request: ExecuteConversationFollowUpInput) =>
    JSON.stringify([
      "conversation",
      request.workspace.workspaceId,
      request.subject.providerId,
      request.subject.conversationObjectId
    ]);
  async function load(request: ExecuteConversationFollowUpInput) {
    const operation = await readConsultationOperation(input.database, address(request));
    await input.consultations.requireCurrent(operation.consultation);
    return operation;
  }
  function result(
    record: ConversationConsultationExecutionRecord
  ): ExecuteConversationFollowUpResult {
    return {
      observation: record,
      events: [{ type: "consultation-execution-recorded", record }],
      idempotencyKey: record.operationId
    };
  }
  async function record(
    request: ExecuteConversationFollowUpInput,
    operation: StoredConsultationOperation,
    outcome: ConversationConsultationExecutionRecord["outcome"]
  ): Promise<ExecuteConversationFollowUpResult> {
    const receipt: ConversationConsultationExecutionRecord = {
      type: "follow-up-execution-recorded",
      recordId: randomUUID(),
      workspaceId: request.workspace.workspaceId,
      subject: structuredClone(request.subject),
      intentId: operation.intent.id,
      consultationId: operation.intent.consultationId,
      operationId: operation.operationId,
      recordedAt: now().toISOString(),
      outcome
    };
    const state =
      outcome.status === "succeeded"
        ? "succeeded"
        : outcome.requiresManualRecovery
          ? "unknown"
          : "not-applied";
    await input.database.transaction(async (transaction) => {
      const updated = await transaction.query(
        `UPDATE conversation_consultation_operations SET state=$4,record_json=$5,record_digest=$6
        WHERE workspace_id=$1 AND subject_key=$2 AND intent_id=$3 AND operation_id=$7 AND state IN ('executing','unknown')`,
        [
          request.workspace.workspaceId,
          consultationSubjectKey(request.subject),
          operation.intent.id,
          state,
          JSON.stringify(receipt),
          consultationDigest(receipt),
          operation.operationId
        ]
      );
      if (updated.affectedRows !== 1)
        throw new ConversationConsultationError(
          "consultation-receipt-conflict",
          "The consultation execution no longer owns its durable claim."
        );
      if (
        outcome.status === "succeeded" &&
        operation.intent.type === "publish-consultation"
      ) {
        const published = await transaction.query(
          `UPDATE conversation_consultations SET publication_json=$4,publication_digest=$5
          WHERE workspace_id=$1 AND subject_key=$2 AND consultation_id=$3 AND publication_json IS NULL`,
          [
            request.workspace.workspaceId,
            consultationSubjectKey(request.subject),
            operation.intent.consultationId,
            JSON.stringify(outcome.receipt),
            consultationDigest(outcome.receipt)
          ]
        );
        if (published.affectedRows !== 1)
          throw new ConversationConsultationError(
            "consultation-publication-conflict",
            "A different publication already owns this consultation."
          );
      }
      await appendConsultationEvent(
        transaction,
        {
          workspaceId: request.workspace.workspaceId,
          subject: request.subject,
          consultationId: operation.intent.consultationId
        },
        receipt.recordId,
        "execution",
        receipt,
        now()
      );
    });
    // Persist before delivery, even when access disappears during the provider call.
    await input.consultations.requireCurrent(operation.consultation);
    return result(receipt);
  }
  function assertReceipt(
    operation: StoredConsultationOperation,
    receipt: ConsultationReceipt
  ): void {
    const plan = operation.consultation.consultation;
    if (
      receipt.reference.providerId !== input.provider.providerId ||
      !receipt.reference.externalId ||
      !receipt.reference.version ||
      !conversationPollSchema.safeParse(receipt.poll).success ||
      receipt.poll.question !== plan.question ||
      receipt.poll.allowsMultiple !== plan.allowsMultiple ||
      receipt.poll.options.length !== plan.options.length ||
      receipt.poll.options.some((option, index) => option.text !== plan.options[index]) ||
      !["verified-role", "incomplete", "not-requested", "unknown"].includes(
        receipt.mention
      )
    )
      throw new Error("The provider did not return an exact bound consultation receipt");
    if (operation.intent.type === "close-consultation") {
      const published = operation.consultation.publication;
      if (
        !published ||
        published.origin !== "luma" ||
        receipt.origin !== "luma" ||
        receipt.reference.externalId !== published.reference.externalId ||
        receipt.reference.version !== published.reference.version ||
        !isClosed(receipt, now())
      )
        throw new Error("The closure was not positively proven for the stored Luma poll");
    }
  }
  async function run(
    request: ExecuteConversationFollowUpInput,
    recover: boolean
  ): Promise<ExecuteConversationFollowUpResult> {
    const operation = await load(request);
    if (operation.state === "succeeded" || operation.state === "not-applied") {
      if (!operation.record)
        throw new ConversationConsultationError(
          "consultation-corrupt",
          "The completed operation has no durable Execution Record."
        );
      return result(operation.record);
    }
    if (operation.state === "executing" || operation.state === "unknown") {
      if (!recover) {
        return operation.record
          ? result(operation.record)
          : record(request, operation, unknownOutcome());
      }
      let found: ConsultationReceipt | null = null;
      try {
        const plan = operation.consultation.consultation;
        found =
          operation.intent.type === "publish-consultation"
            ? await input.provider.findPublished({
                consultation: plan,
                operationId: operation.operationId
              })
            : operation.consultation.publication
              ? await input.provider.read({
                  consultation: plan,
                  reference: operation.consultation.publication.reference
                })
              : null;
        if (found) assertReceipt(operation, found);
      } catch {
        found = null;
      }
      return record(
        request,
        operation,
        found ? { status: "succeeded", receipt: found } : unknownOutcome()
      );
    }
    const claimed = await input.database.query(
      `UPDATE conversation_consultation_operations SET state='executing'
      WHERE workspace_id=$1 AND subject_key=$2 AND intent_id=$3 AND operation_id=$4 AND state='approved'`,
      [
        request.workspace.workspaceId,
        consultationSubjectKey(request.subject),
        operation.intent.id,
        operation.operationId
      ]
    );
    if (claimed.affectedRows !== 1)
      throw new ConversationConsultationError(
        "consultation-execution-busy",
        "Another run owns this consultation intent."
      );
    let sent = false;
    let outcome: ConversationConsultationExecutionRecord["outcome"];
    try {
      await input.consultations.requireCurrent(operation.consultation);
      const plan = operation.consultation.consultation;
      if (
        operation.intent.type === "close-consultation" &&
        operation.consultation.publication?.origin !== "luma"
      )
        throw new ConsultationNotPublishedError(
          "consultation-close-refused",
          "Only a positively recorded Luma poll can be closed."
        );
      if (operation.intent.type === "publish-consultation") {
        const pending = await input.database.query(
          `SELECT o.operation_id FROM conversation_consultation_operations o JOIN conversation_consultations c
          ON c.workspace_id=o.workspace_id AND c.subject_key=o.subject_key AND c.consultation_id=o.consultation_id
          WHERE o.workspace_id=$1 AND o.operation_id<>$2 AND o.state IN ('executing','unknown')
          AND o.intent_json::jsonb->>'type'='publish-consultation'
          AND c.plan_json::jsonb#>>'{source,subject,providerId}'=$3
          AND c.plan_json::jsonb#>>'{source,subject,conversationObjectId}'=$4 LIMIT 1`,
          [
            request.workspace.workspaceId,
            operation.operationId,
            request.subject.providerId,
            request.subject.conversationObjectId
          ]
        );
        if (pending.rows.length)
          throw new ConsultationNotPublishedError(
            "consultation-prior-outcome-unknown",
            "Recover the earlier uncertain consultation in this discussion before authorizing another publication."
          );
      }
      sent = true;
      const receipt =
        operation.intent.type === "publish-consultation"
          ? await input.provider.publish({
              consultation: plan,
              operationId: operation.operationId
            })
          : await input.provider.close({
              consultation: plan,
              reference: operation.consultation.publication!.reference
            });
      assertReceipt(operation, receipt);
      outcome = { status: "succeeded", receipt };
    } catch (error) {
      outcome =
        error instanceof ConsultationNotPublishedError || !sent
          ? {
              status: "failed",
              errorCode:
                error instanceof ConsultationNotPublishedError
                  ? error.code
                  : "consultation-preflight-refused",
              message:
                error instanceof ConsultationNotPublishedError
                  ? error.message
                  : "The source or authorization could not be verified; no consultation was sent.",
              requiresManualRecovery: false
            }
          : unknownOutcome();
    }
    return record(request, operation, outcome);
  }
  return {
    execute: (request) =>
      withExecutionRunLock(input.database, key(request), () => run(request, false)),
    recover: (request) =>
      withExecutionRunLock(input.database, key(request), () => run(request, true)),
    async readConsultation(request) {
      return withExecutionRunLock(input.database, key(request), async () => {
        const operation = await load(request);
        const publication = operation.consultation.publication;
        if (!publication)
          throw new ConversationConsultationError(
            "consultation-not-published",
            "No positive publication receipt is available; recover the original publication first."
          );
        const current = await input.provider.read({
          consultation: operation.consultation.consultation,
          reference: publication.reference
        });
        if (
          !current ||
          current.reference.externalId !== publication.reference.externalId ||
          current.reference.version !== publication.reference.version
        )
          throw new ConversationConsultationError(
            "consultation-result-unavailable",
            "The stored poll could not be read with its original binding."
          );
        assertReceipt(
          { ...operation, intent: { ...operation.intent, type: "publish-consultation" } },
          current
        );
        await appendConsultationEvent(
          input.database,
          {
            workspaceId: request.workspace.workspaceId,
            subject: request.subject,
            consultationId: operation.intent.consultationId
          },
          randomUUID(),
          "poll-result",
          current,
          now()
        );
        await input.consultations.requireCurrent(operation.consultation);
        return current;
      });
    }
  };
}
function isClosed(receipt: ConsultationReceipt, now: Date): boolean {
  return (
    receipt.poll.results.status === "finalized" ||
    (receipt.poll.closesAt !== null && Date.parse(receipt.poll.closesAt) <= now.getTime())
  );
}
function unknownOutcome(): Extract<
  ConversationConsultationExecutionRecord["outcome"],
  { status: "failed" }
> {
  return {
    status: "failed",
    errorCode: "consultation-outcome-unknown",
    message:
      "The consultation outcome is uncertain. Recover its original operation; Luma will not send another poll or role mention without exact positive evidence.",
    requiresManualRecovery: true
  };
}
