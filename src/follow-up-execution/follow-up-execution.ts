import { randomUUID } from "node:crypto";
import type { KnowledgeProvider } from "../knowledge/interface.js";
import type { WorkProvider } from "../work/interface.js";
import type { CodeProvider } from "../code/interface.js";
import type { IdentityDirectory } from "../identity/interface.js";
import {
  resolveProviderUserId,
  resolveProviderUserIds
} from "../identity/static-identity-directory.js";
import type {
  ExternalReference,
  FollowUpExecutionRecorded,
  FollowUpIntent,
  MeetingIntelligenceEvent,
  MeetingState
} from "../domain/model.js";
import type { MeetingIntelligence } from "../meeting-intelligence/interface.js";
import type { LumaDatabase } from "../persistence/db.js";
import type {
  ExecuteFollowUpInput,
  ExecuteFollowUpResult,
  FollowUpExecution
} from "./interface.js";

export type CreateFollowUpExecutionInput = {
  database: LumaDatabase;
  meetingIntelligence: MeetingIntelligence;
  identityDirectory?: IdentityDirectory;
  knowledgeProvider?: KnowledgeProvider;
  workProvider?: WorkProvider;
  codeProvider?: CodeProvider;
  now?: () => Date;
};

class NonRetryableExecutionError extends Error {
  constructor(
    readonly code:
      | "stale-work-item-version"
      | "stale-work-item-identity"
      | "conditional-work-update-not-supported"
      | "code-comment-write-not-supported",
    message: string
  ) {
    super(message);
    this.name = "NonRetryableExecutionError";
  }
}

/** The provider call crossed the mutation boundary but did not yield a result. */
class IndeterminateProviderMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndeterminateProviderMutationError";
  }
}

type ExecutionIdempotencyKeys = {
  current: string;
  legacy: string;
};

export function createFollowUpExecution(
  input: CreateFollowUpExecutionInput
): FollowUpExecution {
  const executionLocks = new Map<string, Promise<void>>();
  const now = input.now ?? (() => new Date());

  return {
    execute: (executeInput) => {
      const idempotencyKeys = executionIdempotencyKeys(executeInput);
      return withExecutionLock(executionLocks, idempotencyKeys.current, () =>
        executeClaimedIntent(input, executeInput, idempotencyKeys, now)
      );
    },
    recover: (executeInput) => {
      const idempotencyKeys = executionIdempotencyKeys(executeInput);
      return withExecutionLock(executionLocks, idempotencyKeys.current, () =>
        recoverClaimedIntent(input, executeInput, idempotencyKeys, now)
      );
    }
  };
}

async function executeClaimedIntent(
  dependencies: CreateFollowUpExecutionInput,
  executeInput: ExecuteFollowUpInput,
  idempotencyKeys: ExecutionIdempotencyKeys,
  now: () => Date
): Promise<ExecuteFollowUpResult> {
  const claim = await claimCanonicalExecution(
    dependencies.database,
    executeInput,
    idempotencyKeys,
    now(),
    "execute"
  );

  if (claim.type === "completed") {
    return claim.result;
  }

  const executionInput: CanonicalExecutionInput = {
    ...executeInput,
    intent: claim.intent,
    executionLeaseId: claim.executionLeaseId,
    // A fresh canonical reservation must not probe the ambiguous historical
    // colon key: another opaque tuple may have used that legacy marker.
    recoveryIdempotencyKeys: [claim.idempotencyKey]
  };
  const observation =
    claim.type === "stale"
      ? staleSourceExecutionObservation(executionInput, now)
      : await executeIntent(dependencies, executionInput, claim.idempotencyKey, now);

  return persistExecutionReceipt(
    dependencies,
    executeInput.workspace,
    executionInput,
    observation,
    claim.idempotencyKey,
    now
  );
}

async function recoverClaimedIntent(
  dependencies: CreateFollowUpExecutionInput,
  executeInput: ExecuteFollowUpInput,
  idempotencyKeys: ExecutionIdempotencyKeys,
  now: () => Date
): Promise<ExecuteFollowUpResult> {
  const claim = await claimCanonicalExecution(
    dependencies.database,
    executeInput,
    idempotencyKeys,
    now(),
    "recover"
  );

  if (claim.type === "completed") {
    return claim.result;
  }

  if (claim.type !== "recovery") {
    throw new Error(
      `Follow-up Intent ${executeInput.intentId} has no recoverable execution`
    );
  }

  const executionInput: CanonicalExecutionInput = {
    ...executeInput,
    intent: claim.intent,
    executionLeaseId: claim.executionLeaseId,
    // `claim.idempotencyKey` is tuple-bound by the durable reservation. It is
    // therefore the only provider marker this recovery may safely trust.
    recoveryIdempotencyKeys: [claim.idempotencyKey]
  };
  const externalReferences = await recoverCreatedReferences(dependencies, executionInput);
  const observation = externalReferences
    ? successfulExecutionObservation(executionInput, externalReferences, now)
    : indeterminateExecutionObservation(executionInput, now);

  return persistExecutionReceipt(
    dependencies,
    executeInput.workspace,
    executionInput,
    observation,
    claim.idempotencyKey,
    now
  );
}

async function persistExecutionReceipt(
  dependencies: CreateFollowUpExecutionInput,
  workspace: ExecuteFollowUpInput["workspace"],
  input: CanonicalExecutionInput,
  observation: FollowUpExecutionRecorded,
  idempotencyKey: string,
  now: () => Date
): Promise<ExecuteFollowUpResult> {
  const update = await dependencies.meetingIntelligence.observe({
    workspace,
    observations: [observation]
  });

  if (
    !update.acceptedObservationIds.includes(observation.observationId) ||
    update.errors.length > 0
  ) {
    throw new Error(
      `Execution receipt ${observation.observationId} was not accepted by Meeting Intelligence`
    );
  }

  const result: ExecuteFollowUpResult = {
    observation,
    events:
      update.events.length > 0
        ? update.events
        : receiptEventsFromObservation(observation),
    idempotencyKey
  };
  await completeExecution(dependencies.database, result, input.executionLeaseId, now());
  return result;
}

async function executeIntent(
  dependencies: CreateFollowUpExecutionInput,
  input: CanonicalExecutionInput,
  idempotencyKey: string,
  now: () => Date
): Promise<FollowUpExecutionRecorded> {
  const occurredAt = now().toISOString();

  try {
    const externalReferences = await runProviderMutation(
      dependencies,
      input,
      idempotencyKey
    );
    return successfulExecutionObservation(
      input,
      externalReferences,
      () => new Date(occurredAt)
    );
  } catch (error) {
    const nonRetryable = error instanceof NonRetryableExecutionError ? error : null;
    const indeterminate = error instanceof IndeterminateProviderMutationError;

    return {
      type: "follow-up-execution-recorded",
      observationId: `follow-up-execution:${input.intent.id}:${input.executionLeaseId}:failed`,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      occurredAt,
      observedAt: occurredAt,
      intentId: input.intent.id,
      executionLeaseId: input.executionLeaseId,
      outcome: {
        status: "failed",
        errorCode: indeterminate
          ? "provider-outcome-unknown"
          : (nonRetryable?.code ?? "provider-mutation-failed"),
        message: indeterminate
          ? `${error.message} Luma cannot prove whether the provider applied this mutation; inspect the provider before creating a fresh Intent.`
          : error instanceof Error
            ? error.message
            : "Provider mutation failed",
        retryable: !nonRetryable && !indeterminate
      }
    };
  }
}

function successfulExecutionObservation(
  input: CanonicalExecutionInput,
  externalReferences: ExternalReference[],
  now: () => Date
): FollowUpExecutionRecorded {
  const occurredAt = now().toISOString();

  return {
    type: "follow-up-execution-recorded",
    observationId: `follow-up-execution:${input.intent.id}:${input.executionLeaseId}:succeeded`,
    workspaceId: input.workspace.workspaceId,
    meetingId: input.meetingId,
    occurredAt,
    observedAt: occurredAt,
    intentId: input.intent.id,
    executionLeaseId: input.executionLeaseId,
    outcome: {
      status: "succeeded",
      externalReferences,
      summary: summarizeSuccess(input.intent, externalReferences)
    }
  };
}

function indeterminateExecutionObservation(
  input: CanonicalExecutionInput,
  now: () => Date
): FollowUpExecutionRecorded {
  const occurredAt = now().toISOString();

  return {
    type: "follow-up-execution-recorded",
    observationId: `follow-up-execution:${input.intent.id}:${input.executionLeaseId}:failed`,
    workspaceId: input.workspace.workspaceId,
    meetingId: input.meetingId,
    occurredAt,
    observedAt: occurredAt,
    intentId: input.intent.id,
    executionLeaseId: input.executionLeaseId,
    outcome: {
      status: "failed",
      errorCode: "provider-outcome-unknown",
      message:
        "Luma could not prove the outcome of an interrupted provider mutation. Inspect the provider before creating a fresh approved Intent.",
      retryable: false
    }
  };
}

async function runProviderMutation(
  dependencies: CreateFollowUpExecutionInput,
  input: CanonicalExecutionInput,
  idempotencyKey: string
): Promise<ExternalReference[]> {
  const { intent } = input;

  switch (intent.type) {
    case "record-meeting": {
      if (!dependencies.knowledgeProvider) {
        throw new Error("KnowledgeProvider is not configured");
      }

      const conclusion = await dependencies.meetingIntelligence.conclude({
        workspaceId: input.workspace.workspaceId,
        meetingId: input.meetingId
      });
      const participantProviderUserIds = await resolveProviderUserIds({
        identityDirectory: dependencies.identityDirectory,
        workspaceId: input.workspace.workspaceId,
        providerId:
          dependencies.knowledgeProvider.identityProviderId ??
          dependencies.knowledgeProvider.providerId,
        personIds: conclusion.participantBriefs.map((brief) => brief.participantId)
      });
      const reference = await createDocumentWithPositiveRecovery(
        dependencies.knowledgeProvider,
        {
          title: intent.title,
          contentMarkdown: renderMeetingRecord(intent.title, conclusion, intent.id),
          parentId: null,
          participantProviderUserIds,
          idempotencyKey
        },
        input.recoveryIdempotencyKeys
      );
      return [reference];
    }
    case "update-knowledge": {
      if (!dependencies.knowledgeProvider) {
        throw new Error("KnowledgeProvider is not configured");
      }

      const reference = await createDocumentWithPositiveRecovery(
        dependencies.knowledgeProvider,
        {
          title: intent.title,
          contentMarkdown: intent.bodyMarkdown,
          parentId: null,
          idempotencyKey
        },
        input.recoveryIdempotencyKeys
      );
      return [reference];
    }
    case "create-work-item": {
      if (!dependencies.workProvider) {
        throw new Error("WorkProvider is not configured");
      }

      assertCreateWorkProvider(intent, dependencies.workProvider);

      const assigneeProviderUserId = await resolveProviderUserId({
        identityDirectory: dependencies.identityDirectory,
        workspaceId: input.workspace.workspaceId,
        providerId:
          dependencies.workProvider.identityProviderId ??
          dependencies.workProvider.providerId,
        personId: intent.assigneeId
      });
      const mentionProviderUserIds = await resolveMentionProviderUserIds(
        dependencies.identityDirectory,
        input.workspace.workspaceId,
        dependencies.workProvider.identityProviderId ??
          dependencies.workProvider.providerId,
        intent
      );
      const reference = await createWorkItemWithPositiveRecovery(
        dependencies.workProvider,
        {
          title: intent.title,
          description: intent.description,
          assigneeProviderUserId,
          mentionProviderUserIds,
          dueDate: intent.dueDate,
          labels: [],
          idempotencyKey
        },
        input.recoveryIdempotencyKeys
      );
      return [reference];
    }
    case "update-work-item": {
      if (!dependencies.workProvider) {
        throw new Error("WorkProvider is not configured");
      }

      assertUpdateWorkProvider(intent, dependencies.workProvider);
      await assertCurrentWorkItemVersion(intent, dependencies.workProvider);

      const workProvider = dependencies.workProvider;

      if (!workProvider.updateWorkItemIfCurrent) {
        throw new NonRetryableExecutionError(
          "conditional-work-update-not-supported",
          `WorkProvider ${dependencies.workProvider.providerId} cannot atomically verify ${intent.externalReference.externalId} before an update`
        );
      }

      if (!intent.externalReference.version) {
        throw new NonRetryableExecutionError(
          "conditional-work-update-not-supported",
          `Follow-up Intent ${intent.id} does not carry a canonical work-item version`
        );
      }
      const expectedUpdatedAt = intent.externalReference.version;

      const reference = await providerMutationOutcome(
        () =>
          workProvider.updateWorkItemIfCurrent!(
            intent.providerObjectId ?? intent.externalReference.externalId,
            {
              ...(intent.description !== undefined
                ? { description: intent.description }
                : {}),
              ...(intent.dueDate !== undefined ? { dueDate: intent.dueDate } : {}),
              expectedUpdatedAt,
              idempotencyKey
            }
          ),
        `WorkProvider ${workProvider.providerId} did not return a conditional update result`
      );

      if (!reference) {
        throw new NonRetryableExecutionError(
          "stale-work-item-version",
          `Canonical work item ${intent.externalReference.externalId} changed immediately before execution; reconcile it again before execution`
        );
      }

      return [reference];
    }
    case "comment-on-code-change": {
      // CodeProvider is intentionally read-only today. Never turn an
      // unimplemented comment operation into a misleading success receipt.
      throw new NonRetryableExecutionError(
        "code-comment-write-not-supported",
        "Comment-on-code-change execution requires a write-capable CodeProvider"
      );
    }
  }
}

async function createDocumentWithPositiveRecovery(
  provider: KnowledgeProvider,
  input: Parameters<KnowledgeProvider["createDocument"]>[0],
  recoveryIdempotencyKeys: string[]
): Promise<ExternalReference> {
  return providerCreateWithPositiveRecovery(
    () => provider.createDocument(input),
    () => findKnownDocument(provider, recoveryIdempotencyKeys),
    `KnowledgeProvider ${provider.providerId} did not return a document creation result`
  );
}

async function createWorkItemWithPositiveRecovery(
  provider: WorkProvider,
  input: Parameters<WorkProvider["createWorkItem"]>[0],
  recoveryIdempotencyKeys: string[]
): Promise<ExternalReference> {
  return providerCreateWithPositiveRecovery(
    () => provider.createWorkItem(input),
    () => findKnownWorkItem(provider, recoveryIdempotencyKeys),
    `WorkProvider ${provider.providerId} did not return a work-item creation result`
  );
}

async function providerCreateWithPositiveRecovery(
  mutate: () => Promise<ExternalReference>,
  recover: () => Promise<ExternalReference | null>,
  indeterminateMessage: string
): Promise<ExternalReference> {
  let existing: ExternalReference | null;

  try {
    existing = await recover();
  } catch {
    // A failed marker probe cannot prove an earlier create did not succeed.
    // Do not begin another mutation from an unknowable idempotency boundary.
    throw new IndeterminateProviderMutationError(indeterminateMessage);
  }

  if (existing) {
    return existing;
  }

  try {
    return await mutate();
  } catch {
    // A response failure does not prove that the provider did not apply the
    // mutation. A positive marker match is success; every other result is
    // deliberately indeterminate and cannot be automatically retried.
    const recovered = await recover().catch(() => null);

    if (recovered) {
      return recovered;
    }

    throw new IndeterminateProviderMutationError(indeterminateMessage);
  }
}

async function providerMutationOutcome(
  mutate: () => Promise<ExternalReference | null>,
  indeterminateMessage: string
): Promise<ExternalReference | null> {
  try {
    return await mutate();
  } catch {
    throw new IndeterminateProviderMutationError(indeterminateMessage);
  }
}

async function findKnownDocument(
  provider: KnowledgeProvider,
  idempotencyKeys: string[]
): Promise<ExternalReference | null> {
  if (!provider.findCreatedDocumentByIdempotencyKey) {
    return null;
  }

  return findFirstPositiveReference(
    idempotencyKeys,
    provider.findCreatedDocumentByIdempotencyKey.bind(provider)
  );
}

async function findKnownWorkItem(
  provider: WorkProvider,
  idempotencyKeys: string[]
): Promise<ExternalReference | null> {
  if (!provider.findCreatedWorkItemByIdempotencyKey) {
    return null;
  }

  return findFirstPositiveReference(
    idempotencyKeys,
    provider.findCreatedWorkItemByIdempotencyKey.bind(provider)
  );
}

async function findFirstPositiveReference(
  idempotencyKeys: string[],
  find: (idempotencyKey: string) => Promise<ExternalReference | null>
): Promise<ExternalReference | null> {
  for (const idempotencyKey of idempotencyKeys) {
    const reference = await find(idempotencyKey);

    if (reference) {
      return reference;
    }
  }

  return null;
}

async function recoverCreatedReferences(
  dependencies: CreateFollowUpExecutionInput,
  input: CanonicalExecutionInput
): Promise<ExternalReference[] | null> {
  try {
    switch (input.intent.type) {
      case "record-meeting":
      case "update-knowledge": {
        const provider = dependencies.knowledgeProvider;
        return provider
          ? await findKnownDocument(provider, input.recoveryIdempotencyKeys).then(
              (reference) => (reference ? [reference] : null)
            )
          : null;
      }
      case "create-work-item": {
        const provider = dependencies.workProvider;
        return provider
          ? await findKnownWorkItem(provider, input.recoveryIdempotencyKeys).then(
              (reference) => (reference ? [reference] : null)
            )
          : null;
      }
      case "update-work-item":
      case "comment-on-code-change":
        return null;
    }
  } catch {
    return null;
  }
}

function assertCreateWorkProvider(
  intent: Extract<FollowUpIntent, { type: "create-work-item" }>,
  workProvider: WorkProvider
): void {
  if (intent.providerId && intent.providerId !== workProvider.providerId) {
    throw new Error(
      `Follow-up Intent ${intent.id} targets WorkProvider ${intent.providerId}, not configured provider ${workProvider.providerId}`
    );
  }
}

function assertUpdateWorkProvider(
  intent: Extract<FollowUpIntent, { type: "update-work-item" }>,
  workProvider: WorkProvider
): void {
  if (intent.externalReference.objectType !== "work-item") {
    throw new NonRetryableExecutionError(
      "stale-work-item-identity",
      `Follow-up Intent ${intent.id} does not target a work item`
    );
  }

  if (intent.externalReference.providerId !== workProvider.providerId) {
    throw new Error(
      `Follow-up Intent ${intent.id} targets WorkProvider ${intent.externalReference.providerId}, not configured provider ${workProvider.providerId}`
    );
  }
}

async function assertCurrentWorkItemVersion(
  intent: Extract<FollowUpIntent, { type: "update-work-item" }>,
  workProvider: WorkProvider
): Promise<void> {
  const lookupId = intent.providerObjectId ?? intent.externalReference.externalId;
  const current = await workProvider.getWorkItem(lookupId);

  if (
    current.providerId !== intent.externalReference.providerId ||
    current.externalId !== intent.externalReference.externalId
  ) {
    throw new NonRetryableExecutionError(
      "stale-work-item-identity",
      `Canonical WorkProvider returned a different work item for ${intent.externalReference.externalId}`
    );
  }

  if (
    intent.externalReference.version !== undefined &&
    current.updatedAt !== intent.externalReference.version
  ) {
    throw new NonRetryableExecutionError(
      "stale-work-item-version",
      `Canonical work item ${intent.externalReference.externalId} changed after Human Judgment; reconcile it again before execution`
    );
  }
}

function createIdempotencyKey(
  workspaceId: string,
  meetingId: string,
  intentId: string,
  operation: string
): string {
  // IDs are opaque and may themselves contain Luma's historical `:`
  // separator. A canonical tuple makes the database's one-key reservation
  // unambiguous across workspace/meeting/intent boundaries.
  return JSON.stringify([workspaceId, meetingId, intentId, operation]);
}

function executionIdempotencyKeys(input: ExecuteFollowUpInput): ExecutionIdempotencyKeys {
  const operation = "execute";
  const current = createIdempotencyKey(
    input.workspace.workspaceId,
    input.meetingId,
    input.intentId,
    operation
  );
  const legacy = `${input.workspace.workspaceId}:${input.meetingId}:${input.intentId}:${operation}`;

  return {
    current,
    legacy
  };
}

function renderMeetingRecord(
  title: string,
  conclusion: Awaited<ReturnType<MeetingIntelligence["conclude"]>>,
  intentId: string
): string {
  return [
    `# ${title}`,
    `## Summary\n\n${conclusion.summary.brief}`,
    conclusion.summary.detailed,
    renderMeetingRecordSection(
      "Decisions",
      conclusion.decisions.map(
        (decision) => `- **${decision.status}**: ${decision.statement}`
      )
    ),
    renderMeetingRecordSection(
      "Action Items",
      conclusion.actionItems.map((item) =>
        [
          `- **${item.status}**: ${item.description}`,
          item.ownerId ? `owner ${item.ownerId}` : "owner unconfirmed",
          item.dueDate ? `due ${item.dueDate}` : "due date unconfirmed"
        ].join("; ")
      )
    ),
    renderMeetingRecordSection(
      "Open Questions",
      conclusion.openQuestions.map(
        (question) => `- **${question.status}**: ${question.question}`
      )
    ),
    renderMeetingRecordSection(
      "Risks",
      conclusion.risks.map(
        (risk) =>
          `- **${risk.severity}**: ${risk.statement}${risk.mitigation ? `; mitigation: ${risk.mitigation}` : ""}`
      )
    ),
    `Generated from approved Luma Follow-up Intent \`${intentId}\` at Meeting Revision ${conclusion.revision}.`
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
}

function renderMeetingRecordSection(title: string, lines: string[]): string {
  return lines.length > 0 ? `## ${title}\n\n${lines.join("\n")}` : "";
}

function summarizeSuccess(
  intent: FollowUpIntent,
  externalReferences: ExternalReference[]
): string {
  const links = externalReferences.map((reference) => reference.url).join(", ");
  return `${intent.type} succeeded${links.length > 0 ? `: ${links}` : "."}`;
}

export function renderDiscordReceiptEvents(
  result: ExecuteFollowUpResult
): MeetingIntelligenceEvent[] {
  return result.events;
}

async function resolveMentionProviderUserIds(
  identityDirectory: IdentityDirectory | undefined,
  workspaceId: string,
  providerId: string,
  intent: Extract<FollowUpIntent, { type: "create-work-item" }>
): Promise<string[]> {
  const personIds = [intent.assigneeId, ...(intent.mentionPersonIds ?? [])].filter(
    (personId): personId is string => Boolean(personId)
  );
  return resolveProviderUserIds({
    identityDirectory,
    workspaceId,
    providerId,
    personIds
  });
}

type CanonicalExecutionInput = ExecuteFollowUpInput & {
  intent: FollowUpIntent;
  executionLeaseId: string;
  /** Tuple-bound provider markers safe for positive-only recovery. */
  recoveryIdempotencyKeys: string[];
};

type MeetingStateRow = {
  state_json: string;
};

type FollowUpExecutionRow = {
  workspace_id: string;
  meeting_id: string;
  intent_id: string;
  operation: string;
  idempotency_key: string;
  status: string;
  execution_lease_id: string | null;
  result_json: string | null;
  updated_at: string;
};

type FollowUpExecutionObservationRow = {
  payload_json: string;
};

type ExecutionClaim =
  | {
      type: "claimed";
      intent: FollowUpIntent;
      executionLeaseId: string;
      idempotencyKey: string;
    }
  | {
      type: "stale";
      intent: FollowUpIntent;
      executionLeaseId: string;
      idempotencyKey: string;
    }
  | {
      type: "recovery";
      intent: FollowUpIntent;
      executionLeaseId: string;
      idempotencyKey: string;
    }
  | { type: "completed"; result: ExecuteFollowUpResult };

/**
 * Atomically binds a provider mutation to the canonical persisted Intent.
 * Caller-supplied payloads never participate in execution; they only name an
 * intent ID. An in-progress reservation is deliberately not stolen because a
 * second mutation is less safe than requiring operator recovery.
 */
async function claimCanonicalExecution(
  database: LumaDatabase,
  input: ExecuteFollowUpInput,
  idempotencyKeys: ExecutionIdempotencyKeys,
  now: Date,
  mode: "execute" | "recover"
): Promise<ExecutionClaim> {
  const timestamp = now.toISOString();
  return database.transaction(async (transaction) => {
    // Match Meeting Intelligence's mutation order: the per-Meeting mutex and
    // Meeting row always precede the execution reservation. That prevents an
    // execution claim from deadlocking a concurrently accepted receipt.
    const state = await loadCanonicalMeetingStateForExecution(transaction, input);
    const existing = await transaction.query<FollowUpExecutionRow>(
      `SELECT workspace_id, meeting_id, intent_id, operation, idempotency_key,
              status, execution_lease_id, result_json, updated_at
         FROM follow_up_executions
        WHERE workspace_id = $1
          AND meeting_id = $2
          AND intent_id = $3
          AND operation = 'execute'
          AND (idempotency_key = $4 OR idempotency_key = $5)
        FOR UPDATE`,
      [
        input.workspace.workspaceId,
        input.meetingId,
        input.intentId,
        idempotencyKeys.current,
        idempotencyKeys.legacy
      ]
    );
    if (existing.rows.length > 1) {
      throw new Error(
        `Follow-up Intent ${input.intentId} has conflicting legacy and current execution reservations`
      );
    }

    const execution = existing.rows[0];
    const idempotencyKey = execution?.idempotency_key ?? idempotencyKeys.current;
    const previous = execution?.result_json
      ? parseExecutionResult(execution.result_json, idempotencyKey)
      : null;

    if (
      execution?.status === "completed" &&
      previous !== null &&
      previous.observation.outcome.status !== "failed"
    ) {
      return { type: "completed", result: previous };
    }

    if (execution?.status === "receipt-recorded") {
      const recovered = await recoverRecordedExecution(
        transaction,
        input,
        idempotencyKey,
        execution.execution_lease_id
      );

      if (recovered) {
        await transaction.query(
          `UPDATE follow_up_executions
              SET status = 'completed', result_json = $2, updated_at = $3
            WHERE idempotency_key = $1
              AND execution_lease_id = $4
              AND status = 'receipt-recorded'`,
          [
            idempotencyKey,
            JSON.stringify(recovered),
            timestamp,
            execution.execution_lease_id
          ]
        );
        return { type: "completed", result: recovered };
      }

      throw new Error(
        `Follow-up Intent ${input.intentId} has an incomplete execution receipt; manual recovery is required`
      );
    }

    const matchingIntents = state.followUpIntentions.filter(
      (candidate) => candidate.id === input.intentId
    );
    const intent = matchingIntents[0];

    if (matchingIntents.length > 1) {
      throw new Error(
        `Follow-up Intent ${input.intentId} is ambiguous in canonical Meeting state`
      );
    }

    if (!intent || intent.status !== "approved") {
      throw new Error(
        `Follow-up Intent ${input.intentId} must be canonically approved before execution`
      );
    }

    if (execution?.status === "executing") {
      if (mode === "recover" && execution.execution_lease_id) {
        return {
          type: "recovery",
          intent,
          executionLeaseId: execution.execution_lease_id,
          idempotencyKey
        };
      }

      throw new Error(
        `Follow-up Intent ${input.intentId} already has an execution in progress; use explicit recovery after verifying the provider outcome`
      );
    }

    if (mode === "recover") {
      throw new Error(
        `Follow-up Intent ${input.intentId} has no active execution to recover`
      );
    }

    const executionLeaseId = randomUUID();

    if (execution) {
      await transaction.query(
        `UPDATE follow_up_executions
            SET status = 'executing',
                attempts = attempts + 1,
                result_json = NULL,
                execution_lease_id = $2,
                updated_at = $3
          WHERE idempotency_key = $1 AND status = 'completed'`,
        [idempotencyKey, executionLeaseId, timestamp]
      );
    } else {
      await transaction.query(
        `INSERT INTO follow_up_executions (
           workspace_id, meeting_id, intent_id, operation, idempotency_key,
           status, attempts, result_json, execution_lease_id, created_at, updated_at
         ) VALUES ($1, $2, $3, 'execute', $4, 'executing', 1, NULL, $5, $6, $6)`,
        [
          input.workspace.workspaceId,
          input.meetingId,
          input.intentId,
          idempotencyKey,
          executionLeaseId,
          timestamp
        ]
      );
    }

    return isCurrentReconciliationIntent(state, intent)
      ? { type: "claimed", intent, executionLeaseId, idempotencyKey }
      : { type: "stale", intent, executionLeaseId, idempotencyKey };
  });
}

async function loadCanonicalMeetingStateForExecution(
  database: Pick<LumaDatabase, "query">,
  input: ExecuteFollowUpInput
): Promise<MeetingState> {
  await database.query(
    `INSERT INTO meeting_state_locks (workspace_id, meeting_id)
     VALUES ($1, $2)
     ON CONFLICT (workspace_id, meeting_id)
     DO UPDATE SET meeting_id = EXCLUDED.meeting_id`,
    [input.workspace.workspaceId, input.meetingId]
  );
  const meeting = await database.query<MeetingStateRow>(
    `SELECT state_json
       FROM meetings
      WHERE workspace_id = $1 AND meeting_id = $2
      FOR UPDATE`,
    [input.workspace.workspaceId, input.meetingId]
  );
  const stateJson = meeting.rows[0]?.state_json;

  if (!stateJson) {
    throw new Error(
      `Meeting ${input.meetingId} does not exist in workspace ${input.workspace.workspaceId}`
    );
  }

  return JSON.parse(stateJson) as MeetingState;
}

function staleSourceExecutionObservation(
  input: CanonicalExecutionInput,
  now: () => Date
): FollowUpExecutionRecorded {
  const occurredAt = now().toISOString();

  return {
    type: "follow-up-execution-recorded",
    observationId: `follow-up-execution:${input.intent.id}:${input.executionLeaseId}:failed`,
    workspaceId: input.workspace.workspaceId,
    meetingId: input.meetingId,
    occurredAt,
    observedAt: occurredAt,
    intentId: input.intent.id,
    executionLeaseId: input.executionLeaseId,
    outcome: {
      status: "failed",
      errorCode: "source-superseded-before-execution",
      message:
        "The source proposal was superseded before this Follow-up Intent began execution.",
      retryable: false
    }
  };
}

function parseExecutionResult(
  resultJson: string,
  idempotencyKey: string
): ExecuteFollowUpResult {
  try {
    return JSON.parse(resultJson) as ExecuteFollowUpResult;
  } catch {
    throw new Error(`Execution receipt ${idempotencyKey} is invalid`);
  }
}

async function recoverRecordedExecution(
  database: Pick<LumaDatabase, "query">,
  input: ExecuteFollowUpInput,
  idempotencyKey: string,
  executionLeaseId: string | null
): Promise<ExecuteFollowUpResult | null> {
  if (!executionLeaseId) {
    return null;
  }

  const observations = await database.query<FollowUpExecutionObservationRow>(
    `SELECT payload_json
       FROM meeting_observations
      WHERE workspace_id = $1
        AND meeting_id = $2
        AND type = 'follow-up-execution-recorded'
      ORDER BY accepted_revision DESC`,
    [input.workspace.workspaceId, input.meetingId]
  );
  const receipt = observations.rows
    .map((row) => parseFollowUpExecutionReceipt(row.payload_json))
    .find(
      (observation) =>
        observation?.intentId === input.intentId &&
        observation.executionLeaseId === executionLeaseId
    );

  return receipt
    ? {
        observation: receipt,
        events: receiptEventsFromObservation(receipt),
        idempotencyKey
      }
    : null;
}

function parseFollowUpExecutionReceipt(
  payload: string
): FollowUpExecutionRecorded | null {
  try {
    const value = JSON.parse(payload) as Partial<FollowUpExecutionRecorded>;

    return value.type === "follow-up-execution-recorded" &&
      typeof value.intentId === "string" &&
      typeof value.executionLeaseId === "string" &&
      value.outcome
      ? (value as FollowUpExecutionRecorded)
      : null;
  } catch {
    return null;
  }
}

function isCurrentReconciliationIntent(
  state: MeetingState,
  intent: FollowUpIntent
): boolean {
  const binding =
    intent.type === "create-work-item" || intent.type === "update-work-item"
      ? intent.reconciliation
      : undefined;

  if (!binding) {
    return true;
  }

  if (!state.currentImportedActionItemCandidateIds.includes(binding.candidateId)) {
    return false;
  }

  const review = state.actionItemReconciliationReviews.find(
    (candidate) =>
      candidate.id === binding.reviewId &&
      candidate.candidateId === binding.candidateId &&
      candidate.candidateLineageKey === binding.candidateLineageKey
  );
  const resolution = review
    ? state.actionItemReconciliationHumanResolutions.find(
        (candidate) => candidate.reviewId === review.id
      )
    : undefined;

  if (!review || !resolution) {
    return false;
  }

  if (intent.type === "create-work-item") {
    return resolution.outcome.type === "create-new";
  }

  if (intent.type !== "update-work-item") {
    return false;
  }

  return (
    resolution.outcome.type === "update-existing" &&
    resolution.outcome.workItem.providerId === intent.externalReference.providerId &&
    resolution.outcome.workItem.externalId === intent.externalReference.externalId &&
    (intent.providerObjectId === undefined ||
      resolution.outcome.workItem.lookupId === intent.providerObjectId) &&
    resolution.outcome.workItem.updatedAt === intent.externalReference.version
  );
}

function receiptEventsFromObservation(
  observation: FollowUpExecutionRecorded
): MeetingIntelligenceEvent[] {
  switch (observation.outcome.status) {
    case "succeeded":
      return [
        {
          type: "follow-up-execution-succeeded",
          intentId: observation.intentId,
          externalReferences: observation.outcome.externalReferences,
          summary: observation.outcome.summary ?? "Follow-up succeeded."
        }
      ];
    case "partially-succeeded":
      return [
        {
          type: "follow-up-execution-partially-succeeded",
          intentId: observation.intentId,
          externalReferences: observation.outcome.externalReferences,
          message: observation.outcome.message
        }
      ];
    case "failed":
      return [
        {
          type: "follow-up-execution-failed",
          intentId: observation.intentId,
          message: observation.outcome.message,
          retryable: observation.outcome.retryable
        }
      ];
  }
}

async function completeExecution(
  database: LumaDatabase,
  result: ExecuteFollowUpResult,
  executionLeaseId: string,
  now: Date
): Promise<void> {
  const completion = await database.query(
    `UPDATE follow_up_executions
        SET status = 'completed', result_json = $2, updated_at = $3
      WHERE idempotency_key = $1
        AND execution_lease_id = $4
        AND status = 'receipt-recorded'`,
    [result.idempotencyKey, JSON.stringify(result), now.toISOString(), executionLeaseId]
  );

  if (completion.affectedRows !== 1) {
    throw new Error(
      `Execution receipt ${result.idempotencyKey} no longer owns its active reservation`
    );
  }
}

async function withExecutionLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  locks.set(key, tail);
  await previous;

  try {
    return await operation();
  } finally {
    release();

    if (locks.get(key) === tail) {
      locks.delete(key);
    }
  }
}
