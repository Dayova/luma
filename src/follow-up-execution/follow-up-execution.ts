import { randomUUID } from "node:crypto";
import type { KnowledgeProvider } from "../knowledge/interface.js";
import type { OperationalOutcomeSourceCurrentnessVerifier } from "../knowledge/ledger-backed-operational-outcome-source-currentness.js";
import type { OperationalOutcomeSourceExecutionFence } from "../knowledge/ledger-backed-operational-outcome-source-execution-fence.js";
import type {
  OperationalOutcome,
  OperationalOutcomeEntry,
  OperationalOutcomeReceipt,
  OperationalOutcomeTarget,
  OperationalOutcomeWriter
} from "../knowledge/operational-outcome-writer.js";
import { OperationalOutcomeWriteNotAppliedError } from "../knowledge/operational-outcome-writer.js";
import { renderOperationalOutcomeMarkdown } from "../knowledge/operational-outcome-markdown.js";
import type { WorkProvider } from "../work/interface.js";
import type { CodeProvider } from "../code/interface.js";
import type { IdentityDirectory } from "../identity/interface.js";
import {
  resolveProviderUserId,
  resolveProviderUserIds
} from "../identity/static-identity-directory.js";
import {
  ownershipCanMutateCanonicalWork,
  sameActionItemOwnership
} from "../domain/action-item-ownership.js";
import type {
  ActionItem,
  ActionItemOwnershipAttribution,
  ExternalReference,
  FollowUpExecutionRecorded,
  FollowUpIntent,
  MeetingIntelligenceEvent,
  MeetingState,
  ReconciliationWorkItemSnapshot
} from "../domain/model.js";
import type { MeetingIntelligence } from "../meeting-intelligence/interface.js";
import type { LumaDatabase } from "../persistence/db.js";
import type {
  ExecuteFollowUpInput,
  ExecuteFollowUpResult,
  FollowUpExecution
} from "./interface.js";
import {
  acquireOperationalOutcomePageLease,
  abandonProvenPrewriteOperationalOutcomeAndReleasePageLease,
  claimOperationalOutcomeSettlementStage,
  completeOperationalOutcomeSettlementStage,
  completeOperationalOutcomeSettlementManualOutputAndReleasePageLease,
  completeOperationalOutcomeSettlementOutputAndReleasePageLease,
  ensureOperationalOutcomeSettlement,
  ensureOperationalOutcomePageWorkspaceOwnership,
  listOperationalOutcomeSettlementsForPage,
  markOperationalOutcomeSettlementOutputPendingAndReleasePageLease,
  markOperationalOutcomeSettlementStageTerminal as persistOperationalOutcomeSettlementStageTerminal,
  prepareOperationalOutcomeSettlementOutput,
  readOperationalOutcomeSettlement,
  recordOperationalOutcomeKnownNotApplied,
  resetProvenNotAppliedExecutingOperationalOutcomeAndReleasePageLease,
  resetProvenNotAppliedManualOperationalOutcomeAndReleasePageLease,
  type NewOperationalOutcomeSettlementPlan,
  type OperationalOutcomeSettlement,
  type OperationalOutcomeSettlementPlan
} from "./operational-outcome-settlement.js";

export type CreateFollowUpExecutionInput = {
  database: LumaDatabase;
  meetingIntelligence: MeetingIntelligence;
  identityDirectory?: IdentityDirectory;
  knowledgeProvider?: KnowledgeProvider;
  operationalOutcomeWriter?: OperationalOutcomeWriter;
  /** Production ledger guard for source freshness before settlement mutation. */
  operationalOutcomeSourceCurrentnessVerifier?: OperationalOutcomeSourceCurrentnessVerifier;
  /** Atomically freezes the observed source head through one active execution. */
  operationalOutcomeSourceExecutionFence?: OperationalOutcomeSourceExecutionFence;
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
      | "operational-outcome-settlement-not-supported"
      | "operational-outcome-writer-not-configured"
      | "operational-outcome-source-ledger-superseded"
      | "action-item-ownership-not-executable"
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

/** A known-safe outcome write did not happen after prior work settled. */
class PartialOperationalOutcomeSettlementError extends Error {
  constructor(
    readonly externalReferences: ExternalReference[],
    readonly code: string,
    message: string,
    readonly disposition: "resumable" | "failed" | "manual" = "resumable"
  ) {
    super(message);
    this.name = "PartialOperationalOutcomeSettlementError";
  }
}

type ExecutionIdempotencyKeys = {
  current: string;
  legacy: string;
};

/**
 * Luma's production PGlite deployment has one in-process database instance.
 * Keep a run mutex beside that instance—not beside an executor facade—so two
 * Discord/API adapters cannot share one durable lease and race a provider
 * mutation. A process stop drops this memory-only guard; the durable
 * execution/stage recovery protocol then takes over after restart.
 */
const activeExecutionKeysByDatabase = new WeakMap<LumaDatabase, Set<string>>();

function activeExecutionKeysFor(database: LumaDatabase): Set<string> {
  const existing = activeExecutionKeysByDatabase.get(database);

  if (existing) {
    return existing;
  }

  const created = new Set<string>();
  activeExecutionKeysByDatabase.set(database, created);
  return created;
}

export function createFollowUpExecution(
  input: CreateFollowUpExecutionInput
): FollowUpExecution {
  const executionLocks = activeExecutionKeysFor(input.database);
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
    dependencies,
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
    dependencies,
    executeInput,
    idempotencyKeys,
    now(),
    "recover"
  );

  if (claim.type === "completed") {
    return claim.result;
  }

  if (claim.type === "stale") {
    const executionInput: CanonicalExecutionInput = {
      ...executeInput,
      intent: claim.intent,
      executionLeaseId: claim.executionLeaseId,
      recoveryIdempotencyKeys: [claim.idempotencyKey]
    };

    return persistExecutionReceipt(
      dependencies,
      executeInput.workspace,
      executionInput,
      staleSourceExecutionObservation(executionInput, now),
      claim.idempotencyKey,
      now
    );
  }

  if (
    (claim.type === "claimed" || claim.type === "recovery") &&
    claim.intent.type === "settle-operational-outcome"
  ) {
    const executionInput: CanonicalExecutionInput = {
      ...executeInput,
      intent: claim.intent,
      executionLeaseId: claim.executionLeaseId,
      recoveryIdempotencyKeys: [claim.idempotencyKey]
    };
    const observation =
      claim.type === "recovery" || claim.intent.status === "requires-manual-recovery"
        ? await recoverOperationalOutcomeSettlement(
            dependencies,
            executionInput,
            claim.idempotencyKey,
            now
          )
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
  await completeExecution(dependencies, result, input.executionLeaseId, now());
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
    return executionFailureObservation(input, error, occurredAt);
  }
}

function executionFailureObservation(
  input: CanonicalExecutionInput,
  error: unknown,
  occurredAt: string
): FollowUpExecutionRecorded {
  const nonRetryable = error instanceof NonRetryableExecutionError ? error : null;
  const indeterminate = error instanceof IndeterminateProviderMutationError;
  const partial =
    error instanceof PartialOperationalOutcomeSettlementError ? error : null;

  if (partial) {
    if (partial.disposition !== "resumable") {
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
          errorCode: partial.code,
          message: partial.message,
          retryable: false,
          requiresManualRecovery: partial.disposition === "manual",
          externalReferences: partial.externalReferences
        }
      };
    }

    return {
      type: "follow-up-execution-recorded",
      observationId: `follow-up-execution:${input.intent.id}:${input.executionLeaseId}:partial`,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      occurredAt,
      observedAt: occurredAt,
      intentId: input.intent.id,
      executionLeaseId: input.executionLeaseId,
      outcome: {
        status: "partially-succeeded",
        externalReferences: partial.externalReferences,
        errorCode: partial.code,
        message: partial.message
      }
    };
  }

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
      retryable: !nonRetryable && !indeterminate,
      requiresManualRecovery: indeterminate
    }
  };
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
    case "settle-operational-outcome": {
      return settleOperationalOutcome(dependencies, input, idempotencyKey);
    }
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
      throw new NonRetryableExecutionError(
        "action-item-ownership-not-executable",
        "Generic create-work-item Intents do not carry a durable ownership confirmation. Use the source-bound reconciliation settlement, where a Human confirms an owner or explicitly records intentionally-unassigned work."
      );
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

async function settleOperationalOutcome(
  dependencies: CreateFollowUpExecutionInput,
  input: CanonicalExecutionInput,
  _idempotencyKey: string
): Promise<ExternalReference[]> {
  void _idempotencyKey;
  const intent = input.intent;

  if (intent.type !== "settle-operational-outcome") {
    throw new Error("expected an Operational Outcome settlement Intent");
  }

  const writer = dependencies.operationalOutcomeWriter;

  if (!writer) {
    throw new NonRetryableExecutionError(
      "operational-outcome-writer-not-configured",
      "Operational Outcome Writer is not configured"
    );
  }

  const state = await canonicalMeetingStateForSettlement(dependencies, input);
  const settlement = settlementFromCanonicalState(state, intent);

  if (!settlement) {
    throw new NonRetryableExecutionError(
      "operational-outcome-settlement-not-supported",
      "The approved reconciliation source is no longer current"
    );
  }

  if (writer.providerId !== settlement.target.providerId) {
    throw new NonRetryableExecutionError(
      "operational-outcome-writer-not-configured",
      `Operational Outcome Writer ${writer.providerId} does not own source provider ${settlement.target.providerId}`
    );
  }

  const plan = operationalOutcomeSettlementPlan(intent, settlement);
  await assertOperationalOutcomeSourceCurrentness(dependencies, plan.target);
  const durable = await ensureOperationalOutcomeSettlement({
    database: dependencies.database,
    workspaceId: input.workspace.workspaceId,
    meetingId: input.meetingId,
    plan,
    now: new Date()
  });
  const ownsPage = await ensureOperationalOutcomePageWorkspaceOwnership({
    database: dependencies.database,
    workspaceId: input.workspace.workspaceId,
    target: plan.target,
    now: new Date()
  });

  if (!ownsPage) {
    throw new NonRetryableExecutionError(
      "operational-outcome-settlement-not-supported",
      `Source page ${plan.target.page.externalId} is already owned by another Luma workspace`
    );
  }

  // This is the last source-side serialization point before the Work provider
  // can mutate. A blocked scan can invalidate the held fence without moving
  // the mutable ledger head, so verify the exact owner too.
  await acquireOperationalOutcomeSourceExecutionFence(dependencies, input, plan.target);
  await assertOperationalOutcomeSourceExecutionFenceHeldCurrent(
    dependencies,
    input,
    plan.target
  );
  const work = await settleOperationalOutcomeWorkStage(dependencies, input, durable);

  try {
    await assertOperationalOutcomeSourceExecutionFenceHeldCurrent(
      dependencies,
      input,
      plan.target
    );
    await assertOperationalOutcomeSourceCurrentness(dependencies, plan.target);
  } catch (error) {
    if (error instanceof NonRetryableExecutionError) {
      throw new PartialOperationalOutcomeSettlementError(
        work.externalReferences,
        "operational-outcome-source-ledger-superseded-after-work",
        error.message,
        "failed"
      );
    }

    throw new PartialOperationalOutcomeSettlementError(
      work.externalReferences,
      "operational-outcome-source-ledger-unavailable-after-work",
      `Luma settled the Work stage but could not verify the current observed source before writing the outcome: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
      "resumable"
    );
  }
  let latestState: MeetingState;

  try {
    latestState = await canonicalMeetingStateForSettlement(dependencies, input);
  } catch (error) {
    throw new PartialOperationalOutcomeSettlementError(
      work.externalReferences,
      "operational-outcome-source-check-failed",
      `Luma settled the Work stage but could not re-read its canonical source before writing the outcome: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
      "resumable"
    );
  }
  const latest = settlementFromCanonicalState(latestState, intent);

  if (!latest || !sameOperationalOutcomeSettlementPlan(plan, latest)) {
    throw new PartialOperationalOutcomeSettlementError(
      work.externalReferences,
      "operational-outcome-source-superseded-after-work",
      "The reconciliation source was superseded after Luma settled its Work stage and before it could write the Operational Outcome.",
      "failed"
    );
  }

  const receipt = await settleOperationalOutcomeWriteStage(
    dependencies,
    input,
    durable,
    writer,
    work.externalReferences
  );

  const externalReferences = uniqueExternalReferences([
    ...work.externalReferences,
    receipt.externalReference
  ]);

  if (work.unresolved.length > 0) {
    throw new PartialOperationalOutcomeSettlementError(
      externalReferences,
      "operational-outcome-work-unresolved",
      work.unresolved.join(" "),
      "failed"
    );
  }

  return externalReferences;
}

async function assertOperationalOutcomeSourceCurrentness(
  dependencies: CreateFollowUpExecutionInput,
  target: OperationalOutcomeTarget
): Promise<void> {
  const verifier = dependencies.operationalOutcomeSourceCurrentnessVerifier;

  if (!verifier) {
    return;
  }

  const currentness = await verifier.verifyCurrent(target);

  if (currentness.status === "current") {
    return;
  }

  if (currentness.status === "superseded") {
    throw new NonRetryableExecutionError(
      "operational-outcome-source-ledger-superseded",
      currentness.message
    );
  }

  throw new Error(currentness.message);
}

async function acquireOperationalOutcomeSourceExecutionFence(
  dependencies: CreateFollowUpExecutionInput,
  input: CanonicalExecutionInput,
  target: OperationalOutcomeTarget
): Promise<void> {
  const sourceExecutionFence = dependencies.operationalOutcomeSourceExecutionFence;

  if (!sourceExecutionFence) {
    return;
  }

  const acquisition = await sourceExecutionFence.acquire({
    target,
    owner: {
      meetingId: input.meetingId,
      intentId: input.intent.id,
      executionLeaseId: input.executionLeaseId
    },
    now: new Date()
  });

  if (acquisition.status === "acquired") {
    return;
  }

  if (acquisition.status === "superseded") {
    throw new NonRetryableExecutionError(
      "operational-outcome-source-ledger-superseded",
      "The observed-source ledger current head no longer matches this approved Operational Outcome settlement."
    );
  }

  throw new PartialOperationalOutcomeSettlementError(
    [],
    "operational-outcome-source-execution-fenced",
    `The observed source is currently fenced by active settlement ${acquisition.owner.intentId}.`,
    "resumable"
  );
}

/**
 * A fenced source head can be invalidated by a scan that observes a newer
 * upstream source while the ledger intentionally holds its mutable head. The
 * exact execution owner must observe that durable signal before every external
 * settlement boundary.
 */
async function assertOperationalOutcomeSourceExecutionFenceHeldCurrent(
  dependencies: CreateFollowUpExecutionInput,
  input: CanonicalExecutionInput,
  target: OperationalOutcomeTarget
): Promise<void> {
  const sourceExecutionFence = dependencies.operationalOutcomeSourceExecutionFence;

  if (!sourceExecutionFence) {
    return;
  }

  const currentness = await sourceExecutionFence.verifyHeldCurrent({
    target,
    owner: {
      meetingId: input.meetingId,
      intentId: input.intent.id,
      executionLeaseId: input.executionLeaseId
    }
  });

  if (currentness.status === "current") {
    return;
  }

  if (currentness.status === "superseded") {
    throw new NonRetryableExecutionError(
      "operational-outcome-source-ledger-superseded",
      currentness.message
    );
  }

  throw new Error(currentness.message);
}

/**
 * Recover only durable, positively provable settlement progress. In
 * particular, an executing create stage is never repeated: its own fixed
 * stage marker must be found first, and an executing page write must match
 * the exact aggregate prepared before the write boundary.
 */
async function recoverOperationalOutcomeSettlement(
  dependencies: CreateFollowUpExecutionInput,
  input: CanonicalExecutionInput,
  idempotencyKey: string,
  now: () => Date
): Promise<FollowUpExecutionRecorded> {
  const occurredAt = now().toISOString();

  try {
    if (input.intent.type !== "settle-operational-outcome") {
      throw new Error("expected an Operational Outcome settlement Intent");
    }

    const durable = await readOperationalOutcomeSettlement({
      database: dependencies.database,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      intentId: input.intent.id
    });
    const state = await canonicalMeetingStateForSettlement(dependencies, input);
    const canonical = settlementFromCanonicalState(state, input.intent);

    const finalized = durable
      ? finalizedOperationalOutcomeSettlementObservation(
          input,
          durable,
          canonical !== null,
          now
        )
      : null;

    if (finalized) {
      return finalized;
    }

    if (!canonical) {
      if (durable && canAbandonProvenPrewriteOperationalOutcome(durable)) {
        await abandonProvenPrewriteOperationalOutcomeAndReleaseWithReadback({
          database: dependencies.database,
          workspaceId: input.workspace.workspaceId,
          meetingId: input.meetingId,
          intentId: durable.plan.intentId,
          target: durable.plan.target,
          now: new Date()
        });
        return staleSourceExecutionObservation(input, now);
      }

      const pendingKnownNotApplied =
        input.intent.status !== "partially-succeeded" && durable
          ? knownNotAppliedPendingOperationalOutcome(durable)
          : null;

      if (durable && pendingKnownNotApplied) {
        return staleSourceExecutionAfterDurableSettlement(
          input,
          settlementDurableExternalReferences(durable),
          now
        );
      }

      const executingKnownNotApplied = durable
        ? knownNotAppliedExecutingOperationalOutcome(durable)
        : null;

      if (durable && executingKnownNotApplied) {
        await resetProvenNotAppliedExecutingOperationalOutcomeAndReleaseWithReadback({
          database: dependencies.database,
          workspaceId: input.workspace.workspaceId,
          meetingId: input.meetingId,
          intentId: durable.plan.intentId,
          target: durable.plan.target,
          previousExecutionLeaseId: executingKnownNotApplied.previousExecutionLeaseId,
          previousErrorCode: executingKnownNotApplied.previousErrorCode,
          error: {
            code: executingKnownNotApplied.outcomeErrorCode,
            message: executingKnownNotApplied.message
          },
          now: new Date()
        });
        return staleSourceExecutionAfterDurableSettlement(
          input,
          settlementDurableExternalReferences(durable),
          now
        );
      }

      const knownNotApplied = durable
        ? knownNotAppliedManualOperationalOutcome(durable)
        : null;

      if (durable && knownNotApplied) {
        await resetProvenNotAppliedManualOperationalOutcomeAndReleaseWithReadback({
          database: dependencies.database,
          workspaceId: input.workspace.workspaceId,
          meetingId: input.meetingId,
          intentId: durable.plan.intentId,
          target: durable.plan.target,
          previousErrorCode: knownNotApplied.previousErrorCode,
          error: {
            code: knownNotApplied.outcomeErrorCode,
            message: knownNotApplied.message
          },
          now: new Date()
        });
        return staleSourceExecutionAfterDurableSettlement(
          input,
          settlementDurableExternalReferences(durable),
          now
        );
      }

      // A stale settlement may still hold an unknown page-write lease. It may
      // never build or write a new aggregate, but an exact prepared-marker
      // proof is safe and is the only automatic way to release that lease.
      if (durable && canReadOnlyProbeManualOperationalOutcome(input, durable)) {
        const proof = await recoverManualOperationalOutcomeWriteProof(
          dependencies,
          input,
          durable,
          now
        );

        return proof.outcome.status === "succeeded"
          ? staleSourceExecutionAfterDurableSettlement(
              input,
              proof.outcome.externalReferences,
              now
            )
          : proof;
      }

      // A terminal Work stage with an untouched Outcome stage proves no page
      // mutation began. If its outer receipt was interrupted after a source
      // supersession, preserve the known work reference in a stale receipt
      // rather than inventing a manual page-write ambiguity.
      if (durable && canRecordStaleTerminalWorkWithoutOutcome(durable)) {
        return staleSourceExecutionAfterDurableSettlement(
          input,
          settlementDurableExternalReferences(durable),
          now
        );
      }

      if (durable) {
        return executionFailureObservation(
          input,
          new PartialOperationalOutcomeSettlementError(
            settlementDurableExternalReferences(durable),
            "operational-outcome-source-superseded-during-recovery",
            "The source is no longer current while a durable Operational Outcome settlement remains; manual recovery is required.",
            "manual"
          ),
          occurredAt
        );
      }

      return staleSourceExecutionObservation(input, now);
    }

    const expectedPlan = operationalOutcomeSettlementPlan(input.intent, canonical);

    // The outer execution reservation commits before the settlement plan is
    // first persisted. An interruption in that local gap has not reached a
    // provider boundary, so recovery may safely re-enter normal execution.
    if (!durable) {
      return await executeIntent(dependencies, input, idempotencyKey, now);
    }

    if (!sameOperationalOutcomeSettlementPlan(durable.plan, canonical)) {
      throw new IndeterminateProviderMutationError(
        "Luma cannot recover an Operational Outcome settlement without its immutable canonical plan"
      );
    }

    if (durable.plan.intentId !== expectedPlan.intentId) {
      throw new IndeterminateProviderMutationError(
        "Luma found a conflicting Operational Outcome settlement identity"
      );
    }

    if (durable.work.status === "executing") {
      await recoverExecutingOperationalOutcomeWorkStage(dependencies, input, durable);
    }

    const afterWork = await readOperationalOutcomeSettlement({
      database: dependencies.database,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      intentId: input.intent.id
    });

    if (!afterWork) {
      throw new IndeterminateProviderMutationError(
        "Operational Outcome settlement disappeared during recovery"
      );
    }

    if (afterWork.outcome.status === "executing") {
      const executingKnownNotApplied =
        knownNotAppliedExecutingOperationalOutcome(afterWork);

      if (executingKnownNotApplied) {
        await resetProvenNotAppliedExecutingOperationalOutcomeAndReleaseWithReadback({
          database: dependencies.database,
          workspaceId: input.workspace.workspaceId,
          meetingId: input.meetingId,
          intentId: afterWork.plan.intentId,
          target: afterWork.plan.target,
          previousExecutionLeaseId: executingKnownNotApplied.previousExecutionLeaseId,
          previousErrorCode: executingKnownNotApplied.previousErrorCode,
          error: {
            code: executingKnownNotApplied.outcomeErrorCode,
            message: executingKnownNotApplied.message
          },
          now: new Date()
        });
        return executionFailureObservation(
          input,
          new PartialOperationalOutcomeSettlementError(
            settlementDurableExternalReferences(afterWork),
            executingKnownNotApplied.outcomeErrorCode,
            executingKnownNotApplied.message,
            executingKnownNotApplied.disposition
          ),
          occurredAt
        );
      }

      if (canReadOnlyProbeManualOperationalOutcome(input, afterWork)) {
        return recoverManualOperationalOutcomeWriteProof(
          dependencies,
          input,
          afterWork,
          now
        );
      }

      await recoverExecutingOperationalOutcomeWriteStage(dependencies, input, afterWork);
    }

    const afterOutput = await readOperationalOutcomeSettlement({
      database: dependencies.database,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      intentId: input.intent.id
    });

    if (!afterOutput) {
      throw new IndeterminateProviderMutationError(
        "Operational Outcome settlement disappeared after recovery"
      );
    }

    const finalizedAfterRecovery = finalizedOperationalOutcomeSettlementObservation(
      input,
      afterOutput,
      true,
      now
    );

    if (finalizedAfterRecovery) {
      return finalizedAfterRecovery;
    }

    if (canAbandonProvenPrewriteOperationalOutcome(afterOutput)) {
      await abandonProvenPrewriteOperationalOutcomeAndReleaseWithReadback({
        database: dependencies.database,
        workspaceId: input.workspace.workspaceId,
        meetingId: input.meetingId,
        intentId: afterOutput.plan.intentId,
        target: afterOutput.plan.target,
        now: new Date()
      });
      return executionFailureObservation(
        input,
        new PartialOperationalOutcomeSettlementError(
          settlementDurableExternalReferences(afterOutput),
          "operational-outcome-prewrite-abandoned",
          "Luma proved this manual stage stopped before any page write and released its lease. Create a fresh reviewed outcome before trying again.",
          "failed"
        ),
        occurredAt
      );
    }

    const pendingKnownNotApplied =
      input.intent.status !== "partially-succeeded"
        ? knownNotAppliedPendingOperationalOutcome(afterOutput)
        : null;

    if (pendingKnownNotApplied) {
      return executionFailureObservation(
        input,
        new PartialOperationalOutcomeSettlementError(
          settlementDurableExternalReferences(afterOutput),
          pendingKnownNotApplied.outcomeErrorCode,
          pendingKnownNotApplied.message,
          pendingKnownNotApplied.disposition
        ),
        occurredAt
      );
    }

    const knownNotApplied = knownNotAppliedManualOperationalOutcome(afterOutput);

    if (knownNotApplied) {
      await resetProvenNotAppliedManualOperationalOutcomeAndReleaseWithReadback({
        database: dependencies.database,
        workspaceId: input.workspace.workspaceId,
        meetingId: input.meetingId,
        intentId: afterOutput.plan.intentId,
        target: afterOutput.plan.target,
        previousErrorCode: knownNotApplied.previousErrorCode,
        error: {
          code: knownNotApplied.outcomeErrorCode,
          message: knownNotApplied.message
        },
        now: new Date()
      });
      return executionFailureObservation(
        input,
        new PartialOperationalOutcomeSettlementError(
          settlementDurableExternalReferences(afterOutput),
          knownNotApplied.outcomeErrorCode,
          knownNotApplied.message,
          knownNotApplied.disposition
        ),
        occurredAt
      );
    }

    if (afterOutput.outcome.status === "requires-manual-recovery") {
      return recoverManualOperationalOutcomeWriteProof(
        dependencies,
        input,
        afterOutput,
        now
      );
    }

    if (input.intent.status === "requires-manual-recovery") {
      return executionFailureObservation(
        input,
        new IndeterminateProviderMutationError(
          `Operational Outcome settlement ${afterOutput.plan.intentId} is manual and has no exact prepared page write to prove`
        ),
        occurredAt
      );
    }

    return await executeIntent(dependencies, input, idempotencyKey, now);
  } catch (error) {
    return executionFailureObservation(
      input,
      error instanceof PartialOperationalOutcomeSettlementError ||
        error instanceof IndeterminateProviderMutationError ||
        error instanceof NonRetryableExecutionError
        ? error
        : new IndeterminateProviderMutationError(
            `Luma could not safely inspect the durable Operational Outcome recovery state: ${
              error instanceof Error ? error.message : "unknown error"
            }`
          ),
      occurredAt
    );
  }
}

async function recoverExecutingOperationalOutcomeWorkStage(
  dependencies: CreateFollowUpExecutionInput,
  input: CanonicalExecutionInput,
  settlement: OperationalOutcomeSettlement
): Promise<void> {
  const { plan, work } = settlement;

  if (work.executionLeaseId !== input.executionLeaseId) {
    throw new IndeterminateProviderMutationError(
      `Operational Outcome work stage for ${plan.intentId} is owned by a different execution lease`
    );
  }

  if (plan.resolution.outcome.type !== "create-new") {
    await markOperationalOutcomeSettlementStageTerminal({
      database: dependencies.database,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      intentId: plan.intentId,
      stage: "work",
      executionLeaseId: input.executionLeaseId,
      status: "requires-manual-recovery",
      error: {
        code: "work-outcome-unknown",
        message: "Luma cannot positively recover an interrupted non-create work mutation"
      },
      now: new Date()
    });
    throw new IndeterminateProviderMutationError(
      `Operational Outcome work stage for ${plan.intentId} requires manual recovery`
    );
  }

  const provider = dependencies.workProvider;
  const expectedProviderId = plan.candidate.source.source.workItemProviderId;

  if (!provider || provider.providerId !== expectedProviderId) {
    await markOperationalOutcomeSettlementStageTerminal({
      database: dependencies.database,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      intentId: plan.intentId,
      stage: "work",
      executionLeaseId: input.executionLeaseId,
      status: "requires-manual-recovery",
      error: {
        code: "work-outcome-unknown",
        message: "The canonical WorkProvider is unavailable for positive create recovery"
      },
      now: new Date()
    });
    throw new IndeterminateProviderMutationError(
      `Operational Outcome create stage for ${plan.intentId} requires manual provider inspection`
    );
  }

  const reference = await findKnownWorkItem(provider, [work.idempotencyKey]).catch(
    () => null
  );

  if (!reference) {
    await markOperationalOutcomeSettlementStageTerminal({
      database: dependencies.database,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      intentId: plan.intentId,
      stage: "work",
      executionLeaseId: input.executionLeaseId,
      status: "requires-manual-recovery",
      error: {
        code: "work-outcome-unknown",
        message:
          "Luma could not positively find work created before the interrupted receipt"
      },
      now: new Date()
    });
    throw new IndeterminateProviderMutationError(
      `Operational Outcome create stage for ${plan.intentId} has an unknown provider outcome`
    );
  }

  await completeOperationalOutcomeWorkStageWithReadback({
    database: dependencies.database,
    workspaceId: input.workspace.workspaceId,
    meetingId: input.meetingId,
    intentId: plan.intentId,
    stage: "work",
    executionLeaseId: input.executionLeaseId,
    externalReferences: [reference],
    now: new Date()
  });
}

async function recoverExecutingOperationalOutcomeWriteStage(
  dependencies: CreateFollowUpExecutionInput,
  input: CanonicalExecutionInput,
  settlement: OperationalOutcomeSettlement
): Promise<void> {
  const { plan, outcome: stage } = settlement;
  const writer = dependencies.operationalOutcomeWriter;

  // The stage becomes executing before Luma acquires the page lease and
  // persists a prepared aggregate. If a process stops in that short local
  // window, no provider write was attempted; reset it safely and let the
  // normal settlement path rebuild a fresh aggregate.
  if (
    stage.executionLeaseId === input.executionLeaseId &&
    stage.preparedOutcomeJson === null
  ) {
    await markOperationalOutcomeSettlementOutputPendingAndReleaseWithReadback({
      database: dependencies.database,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      intentId: plan.intentId,
      executionLeaseId: input.executionLeaseId,
      target: plan.target,
      error: {
        code: "operational-outcome-prewrite-interrupted",
        message: "Luma stopped before preparing any Operational Outcome provider write"
      },
      now: new Date()
    });
    return;
  }

  if (
    stage.executionLeaseId !== input.executionLeaseId ||
    !stage.preparedOutcomeJson ||
    !stage.preparedOperationToken ||
    !stage.payloadDigest ||
    !stage.contentDigest ||
    !stage.operationDigest ||
    !writer ||
    writer.providerId !== plan.target.providerId
  ) {
    await markOperationalOutcomeSettlementStageTerminal({
      database: dependencies.database,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      intentId: plan.intentId,
      stage: "outcome",
      executionLeaseId: input.executionLeaseId,
      status: "requires-manual-recovery",
      error: {
        code: "operational-outcome-unknown",
        message: "Luma cannot positively recover the prepared Operational Outcome write"
      },
      now: new Date()
    });
    throw new IndeterminateProviderMutationError(
      `Operational Outcome write stage for ${plan.intentId} requires manual recovery`
    );
  }

  let prepared: OperationalOutcome;
  let rendered: ReturnType<typeof renderOperationalOutcomeMarkdown>;

  try {
    prepared = parsePreparedOperationalOutcome(stage.preparedOutcomeJson);
    rendered = renderOperationalOutcomeMarkdown({
      outcome: prepared,
      idempotencyKey: stage.idempotencyKey
    });
  } catch (error) {
    await markOperationalOutcomeRecoveryManual(
      dependencies,
      input,
      plan,
      `Prepared Operational Outcome is invalid: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
    throw new IndeterminateProviderMutationError(
      `Operational Outcome write stage for ${plan.intentId} requires manual recovery`
    );
  }

  if (
    prepared.operationToken !== stage.preparedOperationToken ||
    rendered.payloadDigest !== stage.payloadDigest ||
    rendered.contentDigest !== stage.contentDigest ||
    rendered.operationDigest !== stage.operationDigest
  ) {
    await markOperationalOutcomeSettlementStageTerminal({
      database: dependencies.database,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      intentId: plan.intentId,
      stage: "outcome",
      executionLeaseId: input.executionLeaseId,
      status: "requires-manual-recovery",
      error: {
        code: "operational-outcome-unknown",
        message:
          "Prepared Operational Outcome checksums no longer match its durable aggregate"
      },
      now: new Date()
    });
    throw new IndeterminateProviderMutationError(
      `Operational Outcome write stage for ${plan.intentId} requires manual recovery`
    );
  }

  const receipt = await writer
    .findWrittenOutcome({
      target: plan.target,
      outcome: prepared,
      idempotencyKey: stage.idempotencyKey
    })
    .catch(() => null);

  if (!receipt) {
    await markOperationalOutcomeSettlementStageTerminal({
      database: dependencies.database,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      intentId: plan.intentId,
      stage: "outcome",
      executionLeaseId: input.executionLeaseId,
      status: "requires-manual-recovery",
      error: {
        code: "operational-outcome-unknown",
        message: "Luma could not positively reread the exact prepared Operational Outcome"
      },
      now: new Date()
    });
    throw new IndeterminateProviderMutationError(
      `Operational Outcome write stage for ${plan.intentId} has an unknown provider outcome`
    );
  }

  try {
    assertOperationalOutcomeReceipt(receipt, plan.target, rendered);
    await completeOperationalOutcomeWriteStageWithReadback({
      database: dependencies.database,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      intentId: plan.intentId,
      executionLeaseId: input.executionLeaseId,
      target: plan.target,
      externalReferences: [receipt.externalReference],
      payloadDigest: receipt.payloadDigest,
      contentDigest: receipt.contentDigest,
      operationDigest: receipt.operationDigest,
      now: new Date()
    });
  } catch (error) {
    await markOperationalOutcomeRecoveryManual(
      dependencies,
      input,
      plan,
      error instanceof Error
        ? error.message
        : "Luma could not validate the recovered Operational Outcome receipt"
    );
    throw new IndeterminateProviderMutationError(
      `Operational Outcome write stage for ${plan.intentId} requires manual recovery`
    );
  }
}

/**
 * A manual outcome stage is never re-written. Recovery only performs the
 * writer's positive exact-marker probe; a match proves the prior write and
 * can atomically complete the stage and release its page lease. A miss keeps
 * the manual lease intact for provider-specific/operator recovery.
 */
async function recoverManualOperationalOutcomeWriteProof(
  dependencies: CreateFollowUpExecutionInput,
  input: CanonicalExecutionInput,
  settlement: OperationalOutcomeSettlement,
  now: () => Date
): Promise<FollowUpExecutionRecorded> {
  const { plan, outcome: stage } = settlement;
  const work = durableWorkResult(plan, settlement.work);
  const completesManualStage = stage.status === "requires-manual-recovery";
  const completesOrphanedExecutingStage =
    stage.status === "executing" &&
    input.intent.type === "settle-operational-outcome" &&
    input.intent.status === "requires-manual-recovery" &&
    stage.executionLeaseId !== null &&
    stage.executionLeaseId !== input.executionLeaseId;

  if (!work || (!completesManualStage && !completesOrphanedExecutingStage)) {
    return executionFailureObservation(
      input,
      new IndeterminateProviderMutationError(
        `Operational Outcome settlement ${plan.intentId} has an unresolved Work stage; its page write cannot be probed automatically`
      ),
      now().toISOString()
    );
  }

  const writer = dependencies.operationalOutcomeWriter;

  if (
    !stage.preparedOutcomeJson ||
    !stage.preparedOperationToken ||
    !stage.payloadDigest ||
    !stage.contentDigest ||
    !stage.operationDigest ||
    !writer ||
    writer.providerId !== plan.target.providerId
  ) {
    return executionFailureObservation(
      input,
      new IndeterminateProviderMutationError(
        `Operational Outcome write stage for ${plan.intentId} lacks a verifiable prepared aggregate`
      ),
      now().toISOString()
    );
  }

  let prepared: OperationalOutcome;
  let rendered: ReturnType<typeof renderOperationalOutcomeMarkdown>;

  try {
    prepared = parsePreparedOperationalOutcome(stage.preparedOutcomeJson);
    rendered = renderOperationalOutcomeMarkdown({
      outcome: prepared,
      idempotencyKey: stage.idempotencyKey
    });
  } catch (error) {
    return executionFailureObservation(
      input,
      new IndeterminateProviderMutationError(
        `Operational Outcome write stage for ${plan.intentId} has an invalid prepared aggregate: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      ),
      now().toISOString()
    );
  }

  if (
    prepared.operationToken !== stage.preparedOperationToken ||
    rendered.payloadDigest !== stage.payloadDigest ||
    rendered.contentDigest !== stage.contentDigest ||
    rendered.operationDigest !== stage.operationDigest
  ) {
    return executionFailureObservation(
      input,
      new IndeterminateProviderMutationError(
        `Operational Outcome write stage for ${plan.intentId} no longer matches its prepared aggregate`
      ),
      now().toISOString()
    );
  }

  const receipt = await writer
    .findWrittenOutcome({
      target: plan.target,
      outcome: prepared,
      idempotencyKey: stage.idempotencyKey
    })
    .catch(() => null);

  if (!receipt) {
    return executionFailureObservation(
      input,
      new IndeterminateProviderMutationError(
        `Operational Outcome write stage for ${plan.intentId} remains unproven after its exact marker probe`
      ),
      now().toISOString()
    );
  }

  try {
    assertOperationalOutcomeReceipt(receipt, plan.target, rendered);
    await completeOperationalOutcomeWriteStageWithReadback({
      database: dependencies.database,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      intentId: plan.intentId,
      executionLeaseId: input.executionLeaseId,
      target: plan.target,
      externalReferences: [receipt.externalReference],
      payloadDigest: receipt.payloadDigest,
      contentDigest: receipt.contentDigest,
      operationDigest: receipt.operationDigest,
      now: new Date(),
      manualRecovery: completesManualStage,
      ...(completesOrphanedExecutingStage && stage.executionLeaseId
        ? { stageExecutionLeaseId: stage.executionLeaseId }
        : {})
    });
  } catch (error) {
    return executionFailureObservation(
      input,
      new IndeterminateProviderMutationError(
        `Operational Outcome write stage for ${plan.intentId} could not complete its positive recovery: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      ),
      now().toISOString()
    );
  }

  const externalReferences = uniqueExternalReferences([
    ...work.externalReferences,
    receipt.externalReference
  ]);

  if (work.unresolved.length > 0) {
    return executionFailureObservation(
      input,
      new PartialOperationalOutcomeSettlementError(
        externalReferences,
        "operational-outcome-work-unresolved",
        work.unresolved.join(" "),
        "failed"
      ),
      now().toISOString()
    );
  }

  return successfulExecutionObservation(input, externalReferences, now);
}

function durableWorkResult(
  plan: OperationalOutcomeSettlementPlan,
  work: OperationalOutcomeSettlement["work"]
): OperationalOutcomeWorkStageResult | null {
  switch (work.status) {
    case "succeeded":
      return { externalReferences: work.externalReferences, unresolved: [] };
    case "unresolved":
      return {
        externalReferences: work.externalReferences,
        unresolved: work.error ? [work.error.message] : []
      };
    case "not-required":
      return {
        externalReferences:
          plan.resolution.outcome.type === "link-existing"
            ? [
                externalReferenceForReconciliationWorkItem(
                  plan.resolution.outcome.workItem
                )
              ]
            : [],
        unresolved: []
      };
    case "pending":
    case "executing":
    case "requires-manual-recovery":
      return null;
  }
}

/**
 * Once the outcome stage is durably complete there is no provider action left
 * to recover. A later receipt can safely reflect that fact, including when
 * the source has since changed; in that case it reports stale rather than
 * claiming the old proposal is still current.
 */
function finalizedOperationalOutcomeSettlementObservation(
  input: CanonicalExecutionInput,
  settlement: OperationalOutcomeSettlement,
  sourceIsCurrent: boolean,
  now: () => Date
): FollowUpExecutionRecorded | null {
  if (settlement.outcome.status !== "succeeded") {
    return null;
  }

  const work = durableWorkResult(settlement.plan, settlement.work);

  if (!work || settlement.outcome.externalReferences.length === 0) {
    return null;
  }

  const externalReferences = uniqueExternalReferences([
    ...work.externalReferences,
    ...settlement.outcome.externalReferences
  ]);

  if (!sourceIsCurrent) {
    return staleSourceExecutionAfterDurableSettlement(input, externalReferences, now);
  }

  if (work.unresolved.length > 0) {
    return executionFailureObservation(
      input,
      new PartialOperationalOutcomeSettlementError(
        externalReferences,
        "operational-outcome-work-unresolved",
        work.unresolved.join(" "),
        "failed"
      ),
      now().toISOString()
    );
  }

  return successfulExecutionObservation(input, externalReferences, now);
}

async function markOperationalOutcomeRecoveryManual(
  dependencies: CreateFollowUpExecutionInput,
  input: CanonicalExecutionInput,
  plan: OperationalOutcomeSettlementPlan,
  message: string
): Promise<void> {
  await markOperationalOutcomeSettlementStageTerminal({
    database: dependencies.database,
    workspaceId: input.workspace.workspaceId,
    meetingId: input.meetingId,
    intentId: plan.intentId,
    stage: "outcome",
    executionLeaseId: input.executionLeaseId,
    status: "requires-manual-recovery",
    error: { code: "operational-outcome-unknown", message },
    now: new Date()
  }).catch(() => undefined);
}

function parsePreparedOperationalOutcome(json: string): OperationalOutcome {
  try {
    const parsed: unknown = JSON.parse(json);

    if (!parsed || typeof parsed !== "object") {
      throw new Error("prepared aggregate is not an object");
    }

    return parsed as OperationalOutcome;
  } catch (error) {
    throw new IndeterminateProviderMutationError(
      `Prepared Operational Outcome is invalid: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  }
}

type CanonicalOperationalOutcomeSettlement = {
  target: OperationalOutcomeTarget;
  review: MeetingState["actionItemReconciliationReviews"][number];
  resolution: MeetingState["actionItemReconciliationHumanResolutions"][number];
};

async function operationalOutcomeForPage(
  database: LumaDatabase,
  workspaceId: string,
  target: OperationalOutcomeTarget,
  currentExecutingIntentId: string,
  operationToken: string
): Promise<OperationalOutcome> {
  const settlements = await listOperationalOutcomeSettlementsForPage({
    database,
    workspaceId,
    target
  });
  const entries = settlements.flatMap((settlement) => {
    const entry = operationalOutcomeEntryForSettlement(
      settlement,
      currentExecutingIntentId
    );
    return entry ? [entry] : [];
  });

  if (entries.length === 0) {
    throw new Error(
      `Operational Outcome page ${target.page.externalId} has no terminal settlement entries`
    );
  }

  return {
    formatVersion: 1,
    operationToken,
    scope: {
      workspaceId,
      providerId: target.providerId,
      pageExternalId: target.page.externalId
    },
    entries
  };
}

function operationalOutcomeEntryForSettlement(
  settlement: OperationalOutcomeSettlement,
  currentExecutingIntentId: string
): OperationalOutcomeEntry | null {
  const { plan, work } = settlement;

  // The current writer is allowed to publish only its own work result. Other
  // pending settlements have not revalidated their sources at this mutation
  // boundary, so materializing them here could publish a stale action merely
  // because a different settlement happened to acquire the page lease first.
  if (
    settlement.outcome.status !== "succeeded" &&
    !(
      settlement.outcome.status === "executing" &&
      settlement.plan.intentId === currentExecutingIntentId
    )
  ) {
    return null;
  }

  let workReferences: ExternalReference[];
  let workUnresolved: string[];

  switch (work.status) {
    case "succeeded":
      workReferences = work.externalReferences;
      workUnresolved = [];
      break;
    case "unresolved":
      workReferences = work.externalReferences;
      workUnresolved = work.error ? [work.error.message] : [];
      break;
    case "not-required":
      workReferences =
        plan.resolution.outcome.type === "link-existing"
          ? [externalReferenceForReconciliationWorkItem(plan.resolution.outcome.workItem)]
          : [];
      workUnresolved = [];
      break;
    case "pending":
    case "executing":
    case "requires-manual-recovery":
      return null;
  }

  return {
    settlementIntentId: plan.intentId,
    source: {
      sourceObjectId: plan.target.sourceObjectId,
      sourceRevision: plan.target.sourceRevision,
      sourceContentHash: plan.target.sourceContentHash
    },
    ownership: plan.ownership,
    resolution: plan.resolution.outcome,
    workReferences,
    knowledgeReferences: [],
    githubReferences: [],
    unresolved: [
      ...(plan.resolution.outcome.type === "needs-clarification"
        ? [plan.resolution.outcome.rationale]
        : []),
      ...workUnresolved
    ]
  };
}

function operationalOutcomeSettlementPlan(
  intent: Extract<FollowUpIntent, { type: "settle-operational-outcome" }>,
  settlement: CanonicalOperationalOutcomeSettlement
): NewOperationalOutcomeSettlementPlan {
  return {
    version: 2,
    intentId: intent.id,
    binding: intent.reconciliation,
    target: settlement.target,
    candidate: settlement.review.candidate,
    ownership: settlement.review.ownership,
    resolution: settlement.resolution
  };
}

function sameOperationalOutcomeSettlementPlan(
  plan: OperationalOutcomeSettlementPlan,
  settlement: CanonicalOperationalOutcomeSettlement
): boolean {
  return (
    plan.binding.reviewId === settlement.review.id &&
    plan.binding.candidateId === settlement.review.candidateId &&
    plan.binding.candidateLineageKey === settlement.review.candidateLineageKey &&
    plan.target.workspaceId === settlement.target.workspaceId &&
    plan.target.providerId === settlement.target.providerId &&
    plan.target.page.externalId === settlement.target.page.externalId &&
    plan.target.sourceObjectId === settlement.target.sourceObjectId &&
    plan.target.sourceRevision === settlement.target.sourceRevision &&
    plan.target.sourceContentHash === settlement.target.sourceContentHash &&
    sameActionItemOwnership(plan.ownership, settlement.review.ownership) &&
    plan.resolution.id === settlement.resolution.id
  );
}

async function canonicalMeetingStateForSettlement(
  dependencies: CreateFollowUpExecutionInput,
  input: CanonicalExecutionInput
): Promise<MeetingState> {
  const snapshot = await dependencies.meetingIntelligence.query({
    workspaceId: input.workspace.workspaceId,
    meetingId: input.meetingId,
    query: { type: "snapshot" }
  });

  if (snapshot.type !== "snapshot") {
    throw new Error("Meeting Intelligence returned an unexpected settlement snapshot");
  }

  return snapshot.state;
}

function settlementFromCanonicalState(
  state: MeetingState,
  intent: Extract<FollowUpIntent, { type: "settle-operational-outcome" }>
): CanonicalOperationalOutcomeSettlement | null {
  const binding = intent.reconciliation;

  if (!state.currentImportedActionItemCandidateIds.includes(binding.candidateId)) {
    return null;
  }

  const review = state.actionItemReconciliationReviews.find(
    (candidate) =>
      candidate.id === binding.reviewId &&
      candidate.candidateId === binding.candidateId &&
      candidate.candidateLineageKey === binding.candidateLineageKey
  );

  const currentReview = state.actionItemReconciliationReviews
    .filter(
      (candidate) =>
        candidate.candidateId === binding.candidateId &&
        candidate.policyVersion === review?.policyVersion
    )
    .sort(
      (left, right) =>
        right.attempt - left.attempt ||
        right.reviewedAt.localeCompare(left.reviewedAt) ||
        right.id.localeCompare(left.id)
    )[0];

  if (!review || currentReview?.id !== review.id) {
    return null;
  }
  const resolution = review
    ? state.actionItemReconciliationHumanResolutions.find(
        (candidate) => candidate.reviewId === review.id
      )
    : undefined;

  if (!review || !resolution) {
    return null;
  }

  const source = review.candidate.source.source;
  const page = source.externalReference;

  if (
    source.completeness !== "complete" ||
    source.actionItemsAvailability !== "available" ||
    !isDocumentReference(page)
  ) {
    return null;
  }

  return {
    target: {
      workspaceId: state.workspaceId,
      providerId: source.providerId,
      page,
      sourceObjectId: source.sourceObjectId,
      sourceRevision: source.sourceRevision,
      sourceContentHash: source.contentHash
    },
    review,
    resolution
  };
}

function isDocumentReference(
  reference: ExternalReference
): reference is ExternalReference & { objectType: "document" } {
  return reference.objectType === "document";
}

type OperationalOutcomeWorkStageResult = {
  externalReferences: ExternalReference[];
  unresolved: string[];
};

async function settleOperationalOutcomeWorkStage(
  dependencies: CreateFollowUpExecutionInput,
  input: CanonicalExecutionInput,
  settlement: OperationalOutcomeSettlement
): Promise<OperationalOutcomeWorkStageResult> {
  const { plan, work } = settlement;

  if (work.status === "succeeded") {
    return { externalReferences: work.externalReferences, unresolved: [] };
  }

  if (work.status === "unresolved") {
    return {
      externalReferences: work.externalReferences,
      unresolved: work.error ? [work.error.message] : []
    };
  }

  if (work.status === "not-required") {
    return {
      externalReferences:
        plan.resolution.outcome.type === "link-existing"
          ? [externalReferenceForReconciliationWorkItem(plan.resolution.outcome.workItem)]
          : [],
      unresolved: []
    };
  }

  if (work.status === "executing" || work.status === "requires-manual-recovery") {
    throw new IndeterminateProviderMutationError(
      `Operational Outcome work stage for ${plan.intentId} requires manual recovery`
    );
  }

  const claimed = await claimOperationalOutcomeSettlementStage({
    database: dependencies.database,
    workspaceId: input.workspace.workspaceId,
    meetingId: input.meetingId,
    intentId: plan.intentId,
    stage: "work",
    executionLeaseId: input.executionLeaseId,
    now: new Date()
  });

  if (claimed.status !== "executing") {
    return settleOperationalOutcomeWorkStage(dependencies, input, {
      ...settlement,
      work: claimed
    });
  }

  let knownWorkReferences: ExternalReference[] = [];

  try {
    const result = await executeOperationalOutcomeWorkStage(
      dependencies,
      input,
      plan,
      claimed.idempotencyKey
    );
    knownWorkReferences = result.externalReferences;

    if (result.unresolved) {
      await markOperationalOutcomeSettlementStageTerminal({
        database: dependencies.database,
        workspaceId: input.workspace.workspaceId,
        meetingId: input.meetingId,
        intentId: plan.intentId,
        stage: "work",
        executionLeaseId: input.executionLeaseId,
        status: "unresolved",
        externalReferences: result.externalReferences,
        error: result.unresolved,
        now: new Date()
      });
      return {
        externalReferences: result.externalReferences,
        unresolved: [result.unresolved.message]
      };
    }

    await completeOperationalOutcomeWorkStageWithReadback({
      database: dependencies.database,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      intentId: plan.intentId,
      stage: "work",
      executionLeaseId: input.executionLeaseId,
      externalReferences: result.externalReferences,
      now: new Date()
    });

    return { externalReferences: result.externalReferences, unresolved: [] };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Luma could not prove the work stage outcome";

    try {
      await markOperationalOutcomeSettlementStageTerminal({
        database: dependencies.database,
        workspaceId: input.workspace.workspaceId,
        meetingId: input.meetingId,
        intentId: plan.intentId,
        stage: "work",
        executionLeaseId: input.executionLeaseId,
        status: "requires-manual-recovery",
        error: {
          code: "work-outcome-unknown",
          message
        },
        now: new Date()
      });
    } catch (terminalizationError) {
      throw new PartialOperationalOutcomeSettlementError(
        knownWorkReferences,
        "work-outcome-terminalization-unknown",
        `${message} Luma could not durably mark the work-stage boundary: ${
          terminalizationError instanceof Error
            ? terminalizationError.message
            : "unknown error"
        }`,
        "manual"
      );
    }

    throw new PartialOperationalOutcomeSettlementError(
      knownWorkReferences,
      "work-outcome-unknown",
      `${message} Manual provider inspection is required before this settlement can continue.`,
      "manual"
    );
  }
}

type OperationalOutcomeWorkExecutionResult =
  | { externalReferences: ExternalReference[]; unresolved: null }
  | {
      externalReferences: ExternalReference[];
      unresolved: { code: string; message: string };
    };

async function executeOperationalOutcomeWorkStage(
  dependencies: CreateFollowUpExecutionInput,
  input: CanonicalExecutionInput,
  plan: OperationalOutcomeSettlementPlan,
  idempotencyKey: string
): Promise<OperationalOutcomeWorkExecutionResult> {
  const { outcome } = plan.resolution;

  switch (outcome.type) {
    case "link-existing":
    case "reject-not-work":
    case "needs-clarification":
      return { externalReferences: [], unresolved: null };
    case "create-new": {
      const provider = dependencies.workProvider;

      if (!provider) {
        return {
          externalReferences: [],
          unresolved: {
            code: "work-provider-not-configured",
            message:
              "WorkProvider is not configured for the approved create-new reconciliation"
          }
        };
      }

      const expectedProviderId = plan.candidate.source.source.workItemProviderId;

      if (provider.providerId !== expectedProviderId) {
        return {
          externalReferences: [],
          unresolved: {
            code: "work-provider-mismatch",
            message: `WorkProvider ${provider.providerId} does not own source work provider ${expectedProviderId}`
          }
        };
      }

      const assignee = await assigneeProviderUserIdForOperationalOutcomeOwnership(
        dependencies,
        input,
        provider,
        plan.ownership
      );

      if ("unresolved" in assignee) {
        return { externalReferences: [], unresolved: assignee.unresolved };
      }

      const reference = await createWorkItemWithPositiveRecovery(
        provider,
        {
          title: plan.candidate.description,
          description: plan.candidate.originalText,
          assigneeProviderUserId: assignee.assigneeProviderUserId,
          mentionProviderUserIds: [],
          dueDate: plan.candidate.deadline.normalizedDate,
          labels: [],
          idempotencyKey
        },
        [idempotencyKey]
      );

      return { externalReferences: [reference], unresolved: null };
    }
    case "update-existing": {
      const provider = dependencies.workProvider;
      const canonicalReference = externalReferenceForReconciliationWorkItem(
        outcome.workItem
      );

      if (!ownershipCanMutateCanonicalWork(plan.ownership)) {
        return {
          externalReferences: [canonicalReference],
          unresolved: {
            code: "action-item-ownership-not-executable",
            message:
              "Action Item ownership is proposed or unresolved; Luma will not mutate canonical work until a targeted Human ownership decision is recorded."
          }
        };
      }

      if (!provider) {
        return {
          externalReferences: [canonicalReference],
          unresolved: {
            code: "work-provider-not-configured",
            message:
              "WorkProvider is not configured for the approved update-existing reconciliation"
          }
        };
      }

      const updateIntent = {
        id: input.intent.id,
        type: "update-work-item" as const,
        externalReference: canonicalReference,
        providerObjectId: outcome.workItem.lookupId,
        ...(plan.candidate.deadline.normalizedDate !== null
          ? { dueDate: plan.candidate.deadline.normalizedDate }
          : {}),
        relatedMeetingItemIds: [],
        status: "approved" as const,
        provenance: input.intent.provenance
      };

      if (!provider.updateWorkItemIfCurrent || !updateIntent.externalReference.version) {
        return {
          externalReferences: [canonicalReference],
          unresolved: {
            code: "conditional-work-update-not-supported",
            message: `WorkProvider ${provider.providerId} cannot atomically verify ${outcome.workItem.externalId} before an update`
          }
        };
      }

      try {
        assertUpdateWorkProvider(updateIntent, provider);
        await assertCurrentWorkItemVersion(updateIntent, provider);
      } catch (error) {
        return {
          externalReferences: [canonicalReference],
          unresolved: {
            code: "stale-work-item-version",
            message:
              error instanceof Error
                ? error.message
                : "Canonical work item could not be verified before update"
          }
        };
      }

      const reference = await providerMutationOutcome(
        () =>
          provider.updateWorkItemIfCurrent!(outcome.workItem.lookupId, {
            ...(updateIntent.dueDate !== undefined
              ? { dueDate: updateIntent.dueDate }
              : {}),
            expectedUpdatedAt: updateIntent.externalReference.version!,
            idempotencyKey
          }),
        `WorkProvider ${provider.providerId} did not return a conditional update result`
      );

      if (!reference) {
        return {
          externalReferences: [canonicalReference],
          unresolved: {
            code: "stale-work-item-version",
            message: `Canonical work item ${outcome.workItem.externalId} changed immediately before execution; reconcile it again before execution`
          }
        };
      }

      return { externalReferences: [reference], unresolved: null };
    }
  }
}

async function assigneeProviderUserIdForOperationalOutcomeOwnership(
  dependencies: CreateFollowUpExecutionInput,
  input: CanonicalExecutionInput,
  provider: WorkProvider,
  ownership: ActionItemOwnershipAttribution
): Promise<
  | { assigneeProviderUserId: string | null }
  | { unresolved: { code: string; message: string } }
> {
  if (ownership.status === "intentionally-unassigned") {
    return { assigneeProviderUserId: null };
  }

  if (ownership.status !== "confirmed") {
    return {
      unresolved: {
        code: "action-item-ownership-not-executable",
        message:
          "Action Item ownership is proposed or unresolved; Luma will not create canonical work with a guessed or accidental unassigned assignee."
      }
    };
  }

  const assigneeProviderUserId = await resolveProviderUserId({
    identityDirectory: dependencies.identityDirectory,
    workspaceId: input.workspace.workspaceId,
    providerId: provider.identityProviderId ?? provider.providerId,
    personId: ownership.ownerPersonId
  });

  if (!assigneeProviderUserId) {
    return {
      unresolved: {
        code: "action-item-owner-provider-identity-unavailable",
        message: `Confirmed Action Item owner ${ownership.ownerPersonId} has no current ${provider.providerId} identity mapping; Luma will not create it unassigned.`
      }
    };
  }

  return { assigneeProviderUserId };
}

function externalReferenceForReconciliationWorkItem(
  workItem: ReconciliationWorkItemSnapshot
): ExternalReference {
  return {
    providerId: workItem.providerId,
    objectType: "work-item",
    externalId: workItem.externalId,
    url: workItem.url,
    version: workItem.updatedAt
  };
}

async function settleOperationalOutcomeWriteStage(
  dependencies: CreateFollowUpExecutionInput,
  input: CanonicalExecutionInput,
  settlement: OperationalOutcomeSettlement,
  writer: OperationalOutcomeWriter,
  settledWorkReferences: ExternalReference[]
): Promise<OperationalOutcomeReceipt> {
  const { plan, outcome: stage } = settlement;

  if (stage.status === "succeeded") {
    const reference = stage.externalReferences[0];

    if (!reference) {
      throw new Error(
        `Operational Outcome settlement ${plan.intentId} lost its outcome reference`
      );
    }

    return {
      externalReference: reference,
      status: "already-current",
      payloadDigest: stage.payloadDigest ?? "durable-stage-receipt",
      contentDigest: stage.contentDigest ?? "durable-stage-receipt",
      operationDigest: stage.operationDigest ?? "durable-stage-receipt"
    };
  }

  if (stage.status === "requires-manual-recovery" || stage.status === "executing") {
    throw new IndeterminateProviderMutationError(
      `Operational Outcome write stage for ${plan.intentId} requires manual recovery`
    );
  }

  const claimed = await claimOperationalOutcomeSettlementStage({
    database: dependencies.database,
    workspaceId: input.workspace.workspaceId,
    meetingId: input.meetingId,
    intentId: plan.intentId,
    stage: "outcome",
    executionLeaseId: input.executionLeaseId,
    now: new Date()
  });

  if (claimed.status !== "executing") {
    return settleOperationalOutcomeWriteStage(
      dependencies,
      input,
      { ...settlement, outcome: claimed },
      writer,
      settledWorkReferences
    );
  }

  const externalReferences = settlementExecutionReferences(plan, settledWorkReferences);
  let providerWriteStarted = false;
  let writerInput: Parameters<OperationalOutcomeWriter["upsert"]>[0] | null = null;
  let rendered: ReturnType<typeof renderOperationalOutcomeMarkdown> | null = null;

  try {
    const pageLease = await acquireOperationalOutcomePageLease({
      database: dependencies.database,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      intentId: plan.intentId,
      target: plan.target,
      executionLeaseId: input.executionLeaseId,
      now: new Date()
    });

    if (pageLease === "workspace-mismatch") {
      await markOperationalOutcomeSettlementStageTerminal({
        database: dependencies.database,
        workspaceId: input.workspace.workspaceId,
        meetingId: input.meetingId,
        intentId: plan.intentId,
        stage: "outcome",
        executionLeaseId: input.executionLeaseId,
        status: "requires-manual-recovery",
        error: {
          code: "operational-outcome-page-workspace-mismatch",
          message:
            "Another Luma workspace permanently owns this source page's Operational Outcome section"
        },
        now: new Date()
      });
      throw new PartialOperationalOutcomeSettlementError(
        externalReferences,
        "operational-outcome-page-workspace-mismatch",
        "Another Luma workspace owns this source page's Operational Outcome section; manual intervention is required.",
        "manual"
      );
    }

    if (pageLease === "busy") {
      await markOperationalOutcomeSettlementOutputPendingAndReleaseWithReadback({
        database: dependencies.database,
        workspaceId: input.workspace.workspaceId,
        meetingId: input.meetingId,
        intentId: plan.intentId,
        executionLeaseId: input.executionLeaseId,
        target: plan.target,
        error: {
          code: "operational-outcome-page-busy",
          message:
            "Another current settlement owns this source page's Operational Outcome section"
        },
        now: new Date()
      });
      throw new PartialOperationalOutcomeSettlementError(
        externalReferences,
        "operational-outcome-page-busy",
        "The source page is currently settling another approved outcome; run explicit recovery later."
      );
    }

    // The aggregate is deliberately read only after this settlement owns the
    // page lease. A recovery of A therefore cannot replace B with a stale {A}
    // aggregate after B has already written {A,B}.
    const outcome = await operationalOutcomeForPage(
      dependencies.database,
      input.workspace.workspaceId,
      plan.target,
      plan.intentId,
      randomUUID()
    );
    rendered = renderOperationalOutcomeMarkdown({
      outcome,
      idempotencyKey: claimed.idempotencyKey
    });
    await prepareOperationalOutcomeSettlementOutput({
      database: dependencies.database,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      intentId: plan.intentId,
      executionLeaseId: input.executionLeaseId,
      outcome,
      operationToken: outcome.operationToken,
      payloadDigest: rendered.payloadDigest,
      contentDigest: rendered.contentDigest,
      operationDigest: rendered.operationDigest,
      now: new Date()
    });
    writerInput = {
      target: plan.target,
      outcome,
      idempotencyKey: claimed.idempotencyKey
    };

    providerWriteStarted = true;
    const receipt = await writer.upsert(writerInput);
    assertOperationalOutcomeReceipt(receipt, plan.target, rendered);
    await completeOperationalOutcomeWriteStageWithReadback({
      database: dependencies.database,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      intentId: plan.intentId,
      executionLeaseId: input.executionLeaseId,
      target: plan.target,
      externalReferences: [receipt.externalReference],
      payloadDigest: receipt.payloadDigest,
      contentDigest: receipt.contentDigest,
      operationDigest: receipt.operationDigest,
      now: new Date()
    });
    return receipt;
  } catch (error) {
    if (error instanceof PartialOperationalOutcomeSettlementError) {
      throw error;
    }

    if (!providerWriteStarted && writerInput === null) {
      return resetOperationalOutcomePrewriteFailure(
        dependencies,
        input,
        plan,
        externalReferences,
        error
      );
    }

    if (!writerInput || !rendered) {
      throw new IndeterminateProviderMutationError(
        `Operational Outcome settlement ${plan.intentId} crossed an incomplete provider boundary`
      );
    }

    if (error instanceof OperationalOutcomeWriteNotAppliedError) {
      const code = error.retryable
        ? "operational-outcome-not-written"
        : "operational-outcome-not-writable";
      const providerConfirmedCode = error.retryable
        ? "operational-outcome-not-written-provider-confirmed"
        : "operational-outcome-not-writable-provider-confirmed";

      try {
        await recordOperationalOutcomeKnownNotAppliedWithReadback({
          database: dependencies.database,
          workspaceId: input.workspace.workspaceId,
          meetingId: input.meetingId,
          intentId: plan.intentId,
          executionLeaseId: input.executionLeaseId,
          error: { code: providerConfirmedCode, message: error.message },
          now: new Date()
        });
      } catch (recordingError) {
        throw new PartialOperationalOutcomeSettlementError(
          externalReferences,
          "operational-outcome-not-applied-recording-unknown",
          `Luma could not persist the provider's explicit no-write result: ${
            recordingError instanceof Error ? recordingError.message : "unknown error"
          }`,
          "manual"
        );
      }

      try {
        await markOperationalOutcomeSettlementOutputPendingAndReleaseWithReadback({
          database: dependencies.database,
          workspaceId: input.workspace.workspaceId,
          meetingId: input.meetingId,
          intentId: plan.intentId,
          executionLeaseId: input.executionLeaseId,
          target: plan.target,
          error: { code, message: error.message },
          now: new Date()
        });
      } catch (cleanupError) {
        await markOperationalOutcomeSettlementStageTerminal({
          database: dependencies.database,
          workspaceId: input.workspace.workspaceId,
          meetingId: input.meetingId,
          intentId: plan.intentId,
          stage: "outcome",
          executionLeaseId: input.executionLeaseId,
          status: "requires-manual-recovery",
          error: {
            code: `${code}-cleanup-unknown`,
            message: `${error.message} Luma could not confirm durable cleanup: ${
              cleanupError instanceof Error ? cleanupError.message : "unknown error"
            }`
          },
          now: new Date()
        }).catch(() => undefined);
        throw new PartialOperationalOutcomeSettlementError(
          externalReferences,
          `${code}-cleanup-unknown`,
          "Luma knows the page write was not applied but could not prove durable cleanup; manual recovery is required.",
          "manual"
        );
      }

      throw new PartialOperationalOutcomeSettlementError(
        externalReferences,
        code,
        error.message,
        error.retryable ? "resumable" : "failed"
      );
    }

    if (error instanceof NonRetryableExecutionError) {
      await markOperationalOutcomeSettlementStageTerminal({
        database: dependencies.database,
        workspaceId: input.workspace.workspaceId,
        meetingId: input.meetingId,
        intentId: plan.intentId,
        stage: "outcome",
        executionLeaseId: input.executionLeaseId,
        status: "requires-manual-recovery",
        error: {
          code: "operational-outcome-invalid-receipt",
          message: error.message
        },
        now: new Date()
      }).catch(() => undefined);
      throw new PartialOperationalOutcomeSettlementError(
        externalReferences,
        "operational-outcome-invalid-receipt",
        error.message,
        "manual"
      );
    }

    const recovered = await writer.findWrittenOutcome(writerInput).catch(() => null);

    if (recovered) {
      try {
        assertOperationalOutcomeReceipt(recovered, plan.target, rendered);
        await completeOperationalOutcomeWriteStageWithReadback({
          database: dependencies.database,
          workspaceId: input.workspace.workspaceId,
          meetingId: input.meetingId,
          intentId: plan.intentId,
          executionLeaseId: input.executionLeaseId,
          target: plan.target,
          externalReferences: [recovered.externalReference],
          payloadDigest: recovered.payloadDigest,
          contentDigest: recovered.contentDigest,
          operationDigest: recovered.operationDigest,
          now: new Date()
        });
        return recovered;
      } catch (recoveryError) {
        await markOperationalOutcomeSettlementStageTerminal({
          database: dependencies.database,
          workspaceId: input.workspace.workspaceId,
          meetingId: input.meetingId,
          intentId: plan.intentId,
          stage: "outcome",
          executionLeaseId: input.executionLeaseId,
          status: "requires-manual-recovery",
          error: {
            code: "operational-outcome-invalid-receipt",
            message:
              recoveryError instanceof Error
                ? recoveryError.message
                : "Luma could not validate the recovered Operational Outcome receipt"
          },
          now: new Date()
        }).catch(() => undefined);
        throw new PartialOperationalOutcomeSettlementError(
          externalReferences,
          "operational-outcome-invalid-receipt",
          recoveryError instanceof Error
            ? recoveryError.message
            : "Luma could not validate the recovered Operational Outcome receipt",
          "manual"
        );
      }
    }

    try {
      await markOperationalOutcomeSettlementStageTerminal({
        database: dependencies.database,
        workspaceId: input.workspace.workspaceId,
        meetingId: input.meetingId,
        intentId: plan.intentId,
        stage: "outcome",
        executionLeaseId: input.executionLeaseId,
        status: "requires-manual-recovery",
        error: {
          code: "operational-outcome-unknown",
          message:
            error instanceof Error
              ? error.message
              : "Luma could not prove the Operational Outcome write"
        },
        now: new Date()
      });
    } catch (terminalizationError) {
      throw new PartialOperationalOutcomeSettlementError(
        externalReferences,
        "operational-outcome-terminalization-unknown",
        `Luma could not record the indeterminate Operational Outcome write: ${
          terminalizationError instanceof Error
            ? terminalizationError.message
            : "unknown error"
        }`,
        "manual"
      );
    }
    throw new IndeterminateProviderMutationError(
      `Operational Outcome Writer ${writer.providerId} did not return an outcome write result`
    );
  }
}

/**
 * Before `writer.upsert` begins, Luma knows that no external page mutation
 * occurred. A local failure in lease acquisition, aggregate construction,
 * rendering, or durable preparation must therefore leave the stage retryable
 * and free any lease this execution might already have acquired.
 */
async function resetOperationalOutcomePrewriteFailure(
  dependencies: CreateFollowUpExecutionInput,
  input: CanonicalExecutionInput,
  plan: OperationalOutcomeSettlementPlan,
  externalReferences: ExternalReference[],
  error: unknown
): Promise<never> {
  const message =
    error instanceof Error
      ? error.message
      : "Luma could not prepare the Operational Outcome provider write";
  const providerConfirmedCode = "operational-outcome-prewrite-provider-not-started";

  try {
    await recordOperationalOutcomeKnownNotAppliedWithReadback({
      database: dependencies.database,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      intentId: plan.intentId,
      executionLeaseId: input.executionLeaseId,
      error: { code: providerConfirmedCode, message },
      now: new Date()
    });
  } catch (recordingError) {
    throw new PartialOperationalOutcomeSettlementError(
      externalReferences,
      "operational-outcome-prewrite-recording-unknown",
      `Luma could not persist that no Operational Outcome write had started: ${
        recordingError instanceof Error ? recordingError.message : "unknown error"
      }`,
      "manual"
    );
  }

  try {
    await markOperationalOutcomeSettlementOutputPendingAndReleaseWithReadback({
      database: dependencies.database,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      intentId: plan.intentId,
      executionLeaseId: input.executionLeaseId,
      target: plan.target,
      error: {
        code: "operational-outcome-prewrite-failed",
        message
      },
      now: new Date()
    });
  } catch (cleanupError) {
    await markOperationalOutcomeSettlementStageTerminal({
      database: dependencies.database,
      workspaceId: input.workspace.workspaceId,
      meetingId: input.meetingId,
      intentId: plan.intentId,
      stage: "outcome",
      executionLeaseId: input.executionLeaseId,
      status: "requires-manual-recovery",
      error: {
        code: "operational-outcome-prewrite-cleanup-unknown",
        message: `${message} Cleanup could not be proven: ${
          cleanupError instanceof Error ? cleanupError.message : "unknown error"
        }`
      },
      now: new Date()
    }).catch(() => undefined);

    throw new PartialOperationalOutcomeSettlementError(
      externalReferences,
      "operational-outcome-prewrite-cleanup-unknown",
      "Luma could not prove that a pre-write Operational Outcome lease was released; manual recovery is required.",
      "manual"
    );
  }

  throw new PartialOperationalOutcomeSettlementError(
    externalReferences,
    "operational-outcome-prewrite-failed",
    `${message} No provider write was attempted; explicit recovery can safely resume the settlement.`
  );
}

/**
 * A database client can lose the response after the atomic stage-completion
 * transaction committed. Re-read the durable stage before treating that case
 * as an unknown page write; otherwise a successful outcome would be falsely
 * terminalized and its released page lease would be stranded in the UI.
 */
async function completeOperationalOutcomeWriteStageWithReadback(input: {
  database: LumaDatabase;
  workspaceId: string;
  meetingId: string;
  intentId: string;
  executionLeaseId: string;
  target: OperationalOutcomeTarget;
  externalReferences: ExternalReference[];
  payloadDigest: string;
  contentDigest: string;
  operationDigest: string;
  now: Date;
  /** The exact aggregate was positively reread after an earlier unknown write. */
  manualRecovery?: boolean;
  /** Use the prior stage lease only for a proven orphaned prepared output. */
  stageExecutionLeaseId?: string;
}): Promise<void> {
  try {
    if (input.manualRecovery) {
      await completeOperationalOutcomeSettlementManualOutputAndReleasePageLease(input);
    } else {
      await completeOperationalOutcomeSettlementOutputAndReleasePageLease({
        ...input,
        executionLeaseId: input.stageExecutionLeaseId ?? input.executionLeaseId
      });
    }
    return;
  } catch (completionError) {
    const durable = await readOperationalOutcomeSettlement({
      database: input.database,
      workspaceId: input.workspaceId,
      meetingId: input.meetingId,
      intentId: input.intentId
    }).catch(() => null);

    if (
      durable &&
      durableOutcomeStageMatchesCompletion(
        durable.outcome,
        input.externalReferences,
        input.payloadDigest,
        input.contentDigest,
        input.operationDigest
      )
    ) {
      return;
    }

    throw completionError;
  }
}

/**
 * Work-stage completion has the same acknowledge-after-commit boundary as a
 * page write. A lost database response must not make a proven work mutation
 * look indeterminate when the stage row already contains that exact receipt.
 */
async function completeOperationalOutcomeWorkStageWithReadback(input: {
  database: LumaDatabase;
  workspaceId: string;
  meetingId: string;
  intentId: string;
  stage: "work";
  executionLeaseId: string;
  externalReferences: ExternalReference[];
  now: Date;
}): Promise<void> {
  try {
    await completeOperationalOutcomeSettlementStage(input);
    return;
  } catch (completionError) {
    const durable = await readOperationalOutcomeSettlement({
      database: input.database,
      workspaceId: input.workspaceId,
      meetingId: input.meetingId,
      intentId: input.intentId
    }).catch(() => null);

    if (
      durable &&
      durableWorkStageMatchesCompletion(durable.work, input.externalReferences)
    ) {
      return;
    }

    throw completionError;
  }
}

/**
 * Pending-output transition and page-lease release share one transaction. If
 * its acknowledgement is lost, the exact durable pending state proves both
 * effects committed; do not turn a known no-write into an indeterminate one.
 */
async function markOperationalOutcomeSettlementOutputPendingAndReleaseWithReadback(
  input: Parameters<
    typeof markOperationalOutcomeSettlementOutputPendingAndReleasePageLease
  >[0]
): Promise<void> {
  try {
    await markOperationalOutcomeSettlementOutputPendingAndReleasePageLease(input);
    return;
  } catch (transitionError) {
    const durable = await readOperationalOutcomeSettlement({
      database: input.database,
      workspaceId: input.workspaceId,
      meetingId: input.meetingId,
      intentId: input.intentId
    }).catch(() => null);

    if (
      durable &&
      durableOutcomeStageMatchesPendingRelease(durable.outcome, input.error)
    ) {
      return;
    }

    throw transitionError;
  }
}

/**
 * This is the narrow manual cleanup path that is durably known to precede
 * `writer.upsert`. A lost acknowledgement after the atomic reset must not
 * leave a now-pending, lease-free stage stuck behind the old manual receipt.
 */
async function abandonProvenPrewriteOperationalOutcomeAndReleaseWithReadback(
  input: Parameters<typeof abandonProvenPrewriteOperationalOutcomeAndReleasePageLease>[0]
): Promise<void> {
  const error = {
    code: "operational-outcome-prewrite-abandoned",
    message:
      "Luma confirmed this manual stage failed before any provider write and released its page lease."
  };

  try {
    await abandonProvenPrewriteOperationalOutcomeAndReleasePageLease(input);
    return;
  } catch (transitionError) {
    const durable = await readOperationalOutcomeSettlement({
      database: input.database,
      workspaceId: input.workspaceId,
      meetingId: input.meetingId,
      intentId: input.intentId
    }).catch(() => null);

    if (durable && durableOutcomeStageMatchesPendingRelease(durable.outcome, error)) {
      return;
    }

    throw transitionError;
  }
}

async function resetProvenNotAppliedManualOperationalOutcomeAndReleaseWithReadback(
  input: Parameters<
    typeof resetProvenNotAppliedManualOperationalOutcomeAndReleasePageLease
  >[0]
): Promise<void> {
  try {
    await resetProvenNotAppliedManualOperationalOutcomeAndReleasePageLease(input);
    return;
  } catch (transitionError) {
    const durable = await readOperationalOutcomeSettlement({
      database: input.database,
      workspaceId: input.workspaceId,
      meetingId: input.meetingId,
      intentId: input.intentId
    }).catch(() => null);

    if (
      durable &&
      durableOutcomeStageMatchesPendingRelease(durable.outcome, input.error)
    ) {
      return;
    }

    throw transitionError;
  }
}

async function resetProvenNotAppliedExecutingOperationalOutcomeAndReleaseWithReadback(
  input: Parameters<
    typeof resetProvenNotAppliedExecutingOperationalOutcomeAndReleasePageLease
  >[0]
): Promise<void> {
  try {
    await resetProvenNotAppliedExecutingOperationalOutcomeAndReleasePageLease(input);
    return;
  } catch (transitionError) {
    const durable = await readOperationalOutcomeSettlement({
      database: input.database,
      workspaceId: input.workspaceId,
      meetingId: input.meetingId,
      intentId: input.intentId
    }).catch(() => null);

    if (
      durable &&
      durableOutcomeStageMatchesPendingRelease(durable.outcome, input.error)
    ) {
      return;
    }

    throw transitionError;
  }
}

async function recordOperationalOutcomeKnownNotAppliedWithReadback(
  input: Parameters<typeof recordOperationalOutcomeKnownNotApplied>[0]
): Promise<void> {
  try {
    await recordOperationalOutcomeKnownNotApplied(input);
    return;
  } catch (recordingError) {
    const durable = await readOperationalOutcomeSettlement({
      database: input.database,
      workspaceId: input.workspaceId,
      meetingId: input.meetingId,
      intentId: input.intentId
    }).catch(() => null);

    if (
      durable &&
      durable.outcome.status === "executing" &&
      durable.outcome.executionLeaseId === input.executionLeaseId &&
      durable.outcome.error?.code === input.error.code &&
      durable.outcome.error.message === input.error.message
    ) {
      return;
    }

    throw recordingError;
  }
}

/**
 * Terminal stage transitions can likewise commit before a database client
 * loses its acknowledgement. Re-read an exact terminal receipt so an unknown
 * provider write never degrades into an ordinary retryable failure.
 */
async function markOperationalOutcomeSettlementStageTerminal(
  input: Parameters<typeof persistOperationalOutcomeSettlementStageTerminal>[0]
): Promise<void> {
  try {
    await persistOperationalOutcomeSettlementStageTerminal(input);
    return;
  } catch (transitionError) {
    const durable = await readOperationalOutcomeSettlement({
      database: input.database,
      workspaceId: input.workspaceId,
      meetingId: input.meetingId,
      intentId: input.intentId
    }).catch(() => null);
    const stage = durable
      ? input.stage === "work"
        ? durable.work
        : durable.outcome
      : null;

    if (stage && durableStageMatchesTerminal(stage, input)) {
      return;
    }

    throw transitionError;
  }
}

function durableWorkStageMatchesCompletion(
  stage: OperationalOutcomeSettlement["work"],
  externalReferences: ExternalReference[]
): boolean {
  return (
    stage.status === "succeeded" &&
    stage.externalReferences.length === externalReferences.length &&
    stage.externalReferences.every((reference, index) => {
      const expected = externalReferences[index];

      return expected ? sameExternalReference(reference, expected) : false;
    })
  );
}

function durableOutcomeStageMatchesPendingRelease(
  stage: OperationalOutcomeSettlement["outcome"],
  error: { code: string; message: string }
): boolean {
  return (
    stage.status === "pending" &&
    stage.executionLeaseId === null &&
    stage.preparedOutcomeJson === null &&
    stage.preparedOperationToken === null &&
    stage.payloadDigest === null &&
    stage.contentDigest === null &&
    stage.operationDigest === null &&
    stage.error?.code === error.code &&
    stage.error.message === error.message
  );
}

function durableStageMatchesTerminal(
  stage: OperationalOutcomeSettlement["work"],
  input: Parameters<typeof persistOperationalOutcomeSettlementStageTerminal>[0]
): boolean {
  const expectedReferences = input.externalReferences ?? [];

  return (
    stage.status === input.status &&
    stage.executionLeaseId === null &&
    stage.error?.code === input.error.code &&
    stage.error.message === input.error.message &&
    stage.externalReferences.length === expectedReferences.length &&
    stage.externalReferences.every((reference, index) => {
      const expected = expectedReferences[index];

      return expected ? sameExternalReference(reference, expected) : false;
    })
  );
}

function durableOutcomeStageMatchesCompletion(
  stage: OperationalOutcomeSettlement["outcome"],
  externalReferences: ExternalReference[],
  payloadDigest: string,
  contentDigest: string,
  operationDigest: string
): boolean {
  return (
    stage.status === "succeeded" &&
    stage.payloadDigest === payloadDigest &&
    stage.contentDigest === contentDigest &&
    stage.operationDigest === operationDigest &&
    stage.externalReferences.length === externalReferences.length &&
    stage.externalReferences.every((reference, index) => {
      const expected = externalReferences[index];

      return expected ? sameExternalReference(reference, expected) : false;
    })
  );
}

function sameExternalReference(
  left: ExternalReference,
  right: ExternalReference
): boolean {
  return (
    left.providerId === right.providerId &&
    left.objectType === right.objectType &&
    left.externalId === right.externalId &&
    left.url === right.url &&
    left.version === right.version
  );
}

function settlementExecutionReferences(
  plan: OperationalOutcomeSettlementPlan,
  settledWorkReferences: ExternalReference[]
): ExternalReference[] {
  return uniqueExternalReferences([
    ...settledWorkReferences,
    ...(plan.resolution.outcome.type === "link-existing"
      ? [externalReferenceForReconciliationWorkItem(plan.resolution.outcome.workItem)]
      : [])
  ]);
}

function settlementDurableExternalReferences(
  settlement: OperationalOutcomeSettlement
): ExternalReference[] {
  return uniqueExternalReferences([
    ...settlement.work.externalReferences,
    ...settlement.outcome.externalReferences
  ]);
}

function assertOperationalOutcomeReceipt(
  receipt: OperationalOutcomeReceipt,
  target: OperationalOutcomeTarget,
  expected: Pick<
    ReturnType<typeof renderOperationalOutcomeMarkdown>,
    "payloadDigest" | "contentDigest" | "operationDigest"
  >
): void {
  const reference = receipt.externalReference;

  if (
    reference.providerId !== target.providerId ||
    reference.objectType !== "document" ||
    reference.externalId !== target.page.externalId
  ) {
    throw new NonRetryableExecutionError(
      "operational-outcome-settlement-not-supported",
      "Operational Outcome Writer returned a receipt for a different source document"
    );
  }

  if (
    receipt.payloadDigest !== expected.payloadDigest ||
    receipt.contentDigest !== expected.contentDigest ||
    receipt.operationDigest !== expected.operationDigest
  ) {
    throw new NonRetryableExecutionError(
      "operational-outcome-settlement-not-supported",
      "Operational Outcome Writer returned a receipt for a different aggregate"
    );
  }
}

function uniqueExternalReferences(references: ExternalReference[]): ExternalReference[] {
  const byIdentity = new Map<string, ExternalReference>();

  for (const reference of references) {
    byIdentity.set(
      `${reference.providerId}\u0000${reference.objectType}\u0000${reference.externalId}`,
      reference
    );
  }

  return [...byIdentity.values()];
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
      case "settle-operational-outcome":
        return null;
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
          renderActionItemOwnership(item),
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

function renderActionItemOwnership(item: ActionItem): string {
  const ownership = item.ownership;

  if (ownership?.status === "confirmed") {
    return `confirmed owner ${ownership.ownerPersonId}`;
  }

  if (ownership?.status === "proposed") {
    return ownership.proposedOwnerPersonId
      ? `proposed owner ${ownership.proposedOwnerPersonId}`
      : "proposed owner requires confirmation";
  }

  if (ownership?.status === "intentionally-unassigned") {
    return "explicitly unassigned by Human Judgment";
  }

  return "owner unconfirmed";
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
  dependencies: CreateFollowUpExecutionInput,
  input: ExecuteFollowUpInput,
  idempotencyKeys: ExecutionIdempotencyKeys,
  now: Date,
  mode: "execute" | "recover"
): Promise<ExecutionClaim> {
  const { database } = dependencies;
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
    const matchingIntents = state.followUpIntentions.filter(
      (candidate) => candidate.id === input.intentId
    );
    const intent = matchingIntents[0];

    if (matchingIntents.length > 1) {
      throw new Error(
        `Follow-up Intent ${input.intentId} is ambiguous in canonical Meeting state`
      );
    }

    const resumesPartialSettlement =
      mode === "recover" &&
      intent?.type === "settle-operational-outcome" &&
      intent.status === "partially-succeeded" &&
      execution?.status === "completed" &&
      previous?.observation.outcome.status === "partially-succeeded";
    const probesManualOperationalOutcome =
      mode === "recover" &&
      intent?.type === "settle-operational-outcome" &&
      intent.status === "requires-manual-recovery" &&
      execution?.status === "completed" &&
      previous?.observation.outcome.status === "failed" &&
      previous.observation.outcome.requiresManualRecovery === true;
    const recoversExecutingManualOperationalOutcome =
      mode === "recover" &&
      intent?.type === "settle-operational-outcome" &&
      intent.status === "requires-manual-recovery" &&
      execution?.status === "executing" &&
      Boolean(execution.execution_lease_id);

    if (
      execution?.status === "completed" &&
      previous !== null &&
      previous.observation.outcome.status !== "failed" &&
      !resumesPartialSettlement
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
        const completion = await transaction.query(
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
        if (completion.affectedRows !== 1) {
          throw new Error(
            `Execution receipt ${idempotencyKey} no longer owns its active reservation`
          );
        }
        await dependencies.operationalOutcomeSourceExecutionFence?.releaseAfterReceipt({
          database: transaction,
          workspaceId: recovered.observation.workspaceId,
          meetingId: recovered.observation.meetingId,
          intentId: recovered.observation.intentId
        });
        return { type: "completed", result: recovered };
      }

      throw new Error(
        `Follow-up Intent ${input.intentId} has an incomplete execution receipt; manual recovery is required`
      );
    }

    if (
      !intent ||
      (intent.status !== "approved" &&
        !resumesPartialSettlement &&
        !probesManualOperationalOutcome &&
        !recoversExecutingManualOperationalOutcome)
    ) {
      throw new Error(
        `Follow-up Intent ${input.intentId} must be canonically approved before execution or a partial settlement must use explicit recovery`
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

    if (
      mode === "recover" &&
      !resumesPartialSettlement &&
      !probesManualOperationalOutcome
    ) {
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

    const current = isCurrentReconciliationIntent(state, intent);

    // A manual settlement can be recovered only through an exact read-only
    // marker proof. Let that inspection run even after its source changed so
    // it can safely complete a prior write or retain its lease as manual; it
    // never re-enters the normal write path on a stale source.
    return current || probesManualOperationalOutcome
      ? { type: "claimed", intent, executionLeaseId, idempotencyKey }
      : { type: "stale", intent, executionLeaseId, idempotencyKey };
  });
}

function canReadOnlyProbeManualOperationalOutcome(
  input: CanonicalExecutionInput,
  settlement: OperationalOutcomeSettlement
): boolean {
  const stage = settlement.outcome;
  const manualStage = stage.status === "requires-manual-recovery";
  const orphanedExecutingStage =
    stage.status === "executing" &&
    input.intent.type === "settle-operational-outcome" &&
    input.intent.status === "requires-manual-recovery" &&
    stage.executionLeaseId !== null &&
    stage.executionLeaseId !== input.executionLeaseId;

  return (
    (manualStage || orphanedExecutingStage) &&
    durableWorkResult(settlement.plan, settlement.work) !== null &&
    stage.preparedOutcomeJson !== null &&
    stage.preparedOperationToken !== null &&
    stage.payloadDigest !== null &&
    stage.contentDigest !== null &&
    stage.operationDigest !== null
  );
}

function canAbandonProvenPrewriteOperationalOutcome(
  settlement: OperationalOutcomeSettlement
): boolean {
  const stage = settlement.outcome;

  return (
    stage.status === "requires-manual-recovery" &&
    stage.executionLeaseId === null &&
    stage.error?.code === "operational-outcome-prewrite-cleanup-unknown"
  );
}

function canRecordStaleTerminalWorkWithoutOutcome(
  settlement: OperationalOutcomeSettlement
): boolean {
  const outcome = settlement.outcome;

  return (
    durableWorkResult(settlement.plan, settlement.work) !== null &&
    outcome.status === "pending" &&
    outcome.executionLeaseId === null &&
    outcome.externalReferences.length === 0 &&
    outcome.preparedOutcomeJson === null &&
    outcome.preparedOperationToken === null &&
    outcome.payloadDigest === null &&
    outcome.contentDigest === null &&
    outcome.operationDigest === null &&
    outcome.error === null
  );
}

type KnownNotAppliedOperationalOutcome = {
  previousErrorCode:
    | "operational-outcome-not-written-cleanup-unknown"
    | "operational-outcome-not-writable-cleanup-unknown";
  outcomeErrorCode:
    | "operational-outcome-not-written"
    | "operational-outcome-not-writable"
    | "operational-outcome-prewrite-failed"
    | "operational-outcome-prewrite-abandoned";
  message: string;
  disposition: "resumable" | "failed";
};

function knownNotAppliedManualOperationalOutcome(
  settlement: OperationalOutcomeSettlement
): KnownNotAppliedOperationalOutcome | null {
  const stage = settlement.outcome;

  if (
    stage.status !== "requires-manual-recovery" ||
    stage.executionLeaseId !== null ||
    !stage.error
  ) {
    return null;
  }

  switch (stage.error.code) {
    case "operational-outcome-not-written-cleanup-unknown":
      return {
        previousErrorCode: stage.error.code,
        outcomeErrorCode: "operational-outcome-not-written",
        message: stage.error.message,
        disposition: "resumable"
      };
    case "operational-outcome-not-writable-cleanup-unknown":
      return {
        previousErrorCode: stage.error.code,
        outcomeErrorCode: "operational-outcome-not-writable",
        message: stage.error.message,
        disposition: "failed"
      };
    default:
      return null;
  }
}

function knownNotAppliedPendingOperationalOutcome(
  settlement: OperationalOutcomeSettlement
): Omit<KnownNotAppliedOperationalOutcome, "previousErrorCode"> | null {
  const stage = settlement.outcome;

  if (
    stage.status !== "pending" ||
    stage.executionLeaseId !== null ||
    stage.preparedOutcomeJson !== null ||
    stage.preparedOperationToken !== null ||
    stage.payloadDigest !== null ||
    stage.contentDigest !== null ||
    stage.operationDigest !== null ||
    !stage.error
  ) {
    return null;
  }

  switch (stage.error.code) {
    case "operational-outcome-not-written":
      return {
        outcomeErrorCode: stage.error.code,
        message: stage.error.message,
        disposition: "resumable"
      };
    case "operational-outcome-not-writable":
      return {
        outcomeErrorCode: stage.error.code,
        message: stage.error.message,
        disposition: "failed"
      };
    case "operational-outcome-prewrite-failed":
      return {
        outcomeErrorCode: stage.error.code,
        message: stage.error.message,
        disposition: "resumable"
      };
    case "operational-outcome-prewrite-abandoned":
      return {
        outcomeErrorCode: stage.error.code,
        message: stage.error.message,
        disposition: "failed"
      };
    default:
      return null;
  }
}

type KnownNotAppliedExecutingOperationalOutcome = Omit<
  KnownNotAppliedOperationalOutcome,
  "previousErrorCode"
> & {
  previousErrorCode:
    | "operational-outcome-not-written-provider-confirmed"
    | "operational-outcome-not-writable-provider-confirmed"
    | "operational-outcome-prewrite-provider-not-started";
  previousExecutionLeaseId: string;
};

function knownNotAppliedExecutingOperationalOutcome(
  settlement: OperationalOutcomeSettlement
): KnownNotAppliedExecutingOperationalOutcome | null {
  const stage = settlement.outcome;

  if (stage.status !== "executing" || stage.executionLeaseId === null || !stage.error) {
    return null;
  }

  switch (stage.error.code) {
    case "operational-outcome-not-written-provider-confirmed":
      return {
        previousErrorCode: stage.error.code,
        previousExecutionLeaseId: stage.executionLeaseId,
        outcomeErrorCode: "operational-outcome-not-written",
        message: stage.error.message,
        disposition: "resumable"
      };
    case "operational-outcome-not-writable-provider-confirmed":
      return {
        previousErrorCode: stage.error.code,
        previousExecutionLeaseId: stage.executionLeaseId,
        outcomeErrorCode: "operational-outcome-not-writable",
        message: stage.error.message,
        disposition: "failed"
      };
    case "operational-outcome-prewrite-provider-not-started":
      return {
        previousErrorCode: stage.error.code,
        previousExecutionLeaseId: stage.executionLeaseId,
        outcomeErrorCode: "operational-outcome-prewrite-failed",
        message: stage.error.message,
        disposition: "resumable"
      };
    default:
      return null;
  }
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

function staleSourceExecutionAfterDurableSettlement(
  input: CanonicalExecutionInput,
  externalReferences: ExternalReference[],
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
      errorCode: "source-superseded-during-recovery",
      message:
        "Luma preserved the earlier durable settlement state, but its source is now superseded. Create a fresh reviewed outcome for the current source.",
      retryable: false,
      externalReferences
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
    intent.type === "settle-operational-outcome" ||
    intent.type === "create-work-item" ||
    intent.type === "update-work-item"
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

  if (intent.type === "settle-operational-outcome") {
    return true;
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
  dependencies: CreateFollowUpExecutionInput,
  result: ExecuteFollowUpResult,
  executionLeaseId: string,
  now: Date
): Promise<void> {
  await dependencies.database.transaction(async (transaction) => {
    const completion = await transaction.query(
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

    await dependencies.operationalOutcomeSourceExecutionFence?.releaseAfterReceipt({
      database: transaction,
      workspaceId: result.observation.workspaceId,
      meetingId: result.observation.meetingId,
      intentId: result.observation.intentId
    });
  });
}

async function withExecutionLock<T>(
  locks: Set<string>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  if (locks.has(key)) {
    throw new Error(
      "Follow-up Intent already has an execution in progress; wait for it to finish before retrying."
    );
  }

  locks.add(key);

  try {
    return await operation();
  } finally {
    locks.delete(key);
  }
}
