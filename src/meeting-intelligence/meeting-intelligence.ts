import type {
  ActionItemReconciliationMatchSignal,
  ActionItemReconciliationIntentBinding,
  ActionItemReconciliationOutcome,
  ActionItemReconciliationResolution,
  ActionItemReconciliationReview,
  ActionItemReconciliationSearchReceipt,
  ActionItemReconciliationHumanResolution,
  ActionItemReconciliationCreatedWorkMapping,
  ActionItemOwnershipAttribution,
  ActionItemOwnershipHumanResolution,
  CurrentActionItemReconciliationReview,
  ActionItem,
  Decision,
  EvidenceReference,
  ExternalReference,
  FollowUpIntent,
  HumanJudgment,
  ImportedActionItemCandidate,
  ImportedActionItemSourceBlock,
  ImportedMeetingSource,
  ImportedMeetingSourceSection,
  MeetingConclusion,
  MeetingId,
  MeetingImportedFromSource,
  MeetingIntelligenceError,
  MeetingIntelligenceEvent,
  MeetingIntervention,
  MeetingObservation,
  MeetingState,
  OpenQuestion,
  ParticipantBrief,
  Provenance,
  Risk,
  ReconciliationWorkItemSnapshot,
  SpeakerAttribution,
  SpeakerAttributionHumanResolution,
  UtteranceCommitted,
  UtteranceRevised,
  WorkspaceConfig,
  WorkspaceId
} from "../domain/model.js";
import { opaqueIdentifierSegment } from "../domain/opaque-id.js";
import {
  ownershipCanMutateCanonicalWork,
  sameActionItemOwnership
} from "../domain/action-item-ownership.js";
import {
  importedSourceCandidateEvidence,
  importedSourceCandidateId,
  importedSourceCandidateLineageKey,
  importedSourceObservationId,
  importedSourceSectionEvidence
} from "../domain/imported-source-provenance.js";
import {
  commitmentDispositionFor,
  importedActionItemDeadlineFor,
  importedActionItemCompletionFor,
  importedActionItemLanguageFor,
  importedActionItemModalityFor,
  importedActionItemOwnershipFor,
  importedActionItemSourceOwnerFor,
  isOffsetBearingInstant,
  mentionedGitHubImplementationReferencesFor,
  mentionedWorkItemExternalIdsFor
} from "../domain/imported-action-item-semantics.js";
import type {
  ActionItemProposal,
  DecisionProposal,
  FollowUpIntentProposal,
  MeetingAnalysisProposalBatch,
  OpenQuestionProposal,
  ReasoningModel,
  RiskProposal,
  StructuredReasoningResult
} from "../ai/reasoning-model.js";
import type { WorkCatalog, WorkItem } from "../work/interface.js";
import type {
  ConcludeMeeting,
  MeetingIntelligence,
  MeetingQueryResult,
  MeetingUpdate,
  ObserveMeeting,
  QueryMeeting
} from "./interface.js";
import {
  rejectUnverifiedImportedSource,
  type ImportedSourceObservationVerifier
} from "./imported-source-observation-verifier.js";
import type { LumaDatabase } from "../persistence/db.js";

const ANALYSIS_VERSION = "meeting-analysis-v1";
const PROMPT_VERSION = "meeting-intelligence-v2";
const CONCLUSION_SPEAKER_ATTRIBUTION_PROJECTION_VERSION = "speaker-attribution-v1";

export type CreateMeetingIntelligenceInput = {
  database: LumaDatabase;
  reasoningModel: ReasoningModel;
  /** Read-only catalogs; Meeting Intelligence cannot access WorkProvider writers. */
  workCatalogs?: readonly WorkCatalog[];
  /** Required for provider-backed source imports; normal observations need none. */
  importedSourceObservationVerifier?: ImportedSourceObservationVerifier;
  now?: () => Date;
};

type MeetingRow = {
  state_json: string;
};

type MeetingRevisionRow = {
  state_json: string;
};

type WorkspaceConfigRow = {
  config_json: string;
};

type UtteranceLanguageRow = {
  language: "de" | "en" | "mixed" | "unknown";
};

type ObservationPayloadRow = {
  payload_json: string;
};

type ObservationInsertRow = {
  observation_id: string;
};

type EvidenceRow = {
  reference_json: string;
};

type ActiveFollowUpExecutionRow = {
  intent_id: string;
};

type ConclusionRow = {
  conclusion_json: string;
};

type UtteranceVersionRow = {
  speaker_id: string | null;
  speaker_attribution_json: string | null;
  started_at: string;
  ended_at: string;
};

type ActiveUtteranceVersionRow = UtteranceVersionRow & {
  utterance_id: string;
  version: number;
  evidence_id: string;
  original_text: string;
};

type SpeakerAttributionProjection = {
  state: MeetingState;
  evidenceById: ReadonlyMap<string, EvidenceReference>;
  activeTranscriptEvidence: EvidenceReference[];
};

type DatabaseQuery = Pick<LumaDatabase, "query">;
type ReconciliationFlight = Promise<MeetingState>;
type ReconciliationTrigger = ActionItemReconciliationReview["trigger"];

type ReconciliationCandidateRequest = {
  candidate: ImportedActionItemCandidate;
  trigger: ReconciliationTrigger;
};

function workCatalogsByProvider(
  catalogs: readonly WorkCatalog[]
): ReadonlyMap<string, WorkCatalog> {
  const byProvider = new Map<string, WorkCatalog>();

  for (const catalog of catalogs) {
    const providerId = catalog.providerId.trim();

    if (providerId.length === 0) {
      throw new Error("Work Catalog requires a provider identity");
    }

    if (byProvider.has(providerId)) {
      throw new Error(`Work Catalog ${providerId} is configured more than once`);
    }

    byProvider.set(providerId, catalog);
  }

  return byProvider;
}

export function createMeetingIntelligence(
  input: CreateMeetingIntelligenceInput
): MeetingIntelligence {
  const now = input.now ?? (() => new Date());
  const workCatalogs = workCatalogsByProvider(input.workCatalogs ?? []);
  const importedSourceObservationVerifier =
    input.importedSourceObservationVerifier ?? rejectUnverifiedImportedSource;
  const reconciliationFlights = new Map<string, ReconciliationFlight>();

  return {
    observe: (observeInput) =>
      observeMeeting(
        input.database,
        input.reasoningModel,
        workCatalogs,
        importedSourceObservationVerifier,
        reconciliationFlights,
        now,
        observeInput
      ),
    query: (queryInput) => queryMeeting(input.database, queryInput),
    conclude: (concludeInput) => concludeMeeting(input.database, now, concludeInput)
  };
}

async function observeMeeting(
  database: LumaDatabase,
  reasoningModel: ReasoningModel,
  workCatalogs: ReadonlyMap<string, WorkCatalog>,
  importedSourceObservationVerifier: ImportedSourceObservationVerifier,
  reconciliationFlights: Map<string, ReconciliationFlight>,
  now: () => Date,
  input: ObserveMeeting
): Promise<MeetingUpdate> {
  if (!isObserveMeetingEnvelope(input)) {
    throw new Error("observe requires a workspace and a non-empty Observation list");
  }

  if (input.observations.length === 0) {
    throw new Error("observe requires at least one Observation");
  }

  // Verify source projections outside the state-write transaction. The
  // production verifier reads the same durable ledger and must never nest a
  // PGlite transaction. A second locked config read below fences a concurrent
  // first workspace configuration claim.
  const requestedWorkspace = await canonicalWorkspaceConfig(database, input.workspace);
  const meetingId = observationMeetingId(input.observations[0]) ?? "invalid-meeting";
  const sourceVerificationErrors = await verifyImportedSourceObservations(
    input.observations,
    requestedWorkspace,
    importedSourceObservationVerifier
  );

  const acceptance = await database.transaction(async (transaction) => {
    // Keep the configuration mutex until either a validated Observation claims
    // this first workspace config or this delivery rolls back. Unlike source
    // verification, this only uses local persistence and is safe to lock.
    const workspace = await lockCanonicalWorkspaceConfig(transaction, input.workspace);
    const workspaceId = workspace.workspaceId;
    let state = await loadMeetingStateForMutation(transaction, workspaceId, meetingId);
    const acceptedObservationIds: string[] = [];
    const duplicateObservationIds: string[] = [];
    const errors: MeetingIntelligenceError[] = [];
    const events: MeetingIntelligenceEvent[] = [];
    const evidenceForAnalysis: EvidenceReference[] = [];
    let stateChangedByLegacyUpgrade = false;

    if (!sameWorkspaceConfig(workspace, requestedWorkspace)) {
      return {
        workspace,
        state,
        acceptedObservationIds,
        duplicateObservationIds,
        errors: [
          { code: "concurrent-update", retryable: true }
        ] as MeetingIntelligenceError[],
        events,
        evidenceForAnalysis
      };
    }

    for (const observation of input.observations) {
      const envelopeError = observationEnvelopeError(observation);

      if (envelopeError) {
        errors.push(envelopeError);
        continue;
      }

      const sourceVerificationError = sourceVerificationErrors.get(observation);

      if (sourceVerificationError) {
        errors.push(sourceVerificationError);
        continue;
      }

      if (observation.workspaceId !== workspaceId) {
        errors.push({
          code: "invalid-observation",
          observationId: observation.observationId,
          message: "Observation workspace does not match ObserveMeeting workspace",
          retryable: false
        });
        continue;
      }

      if (observation.meetingId !== meetingId) {
        errors.push({
          code: "invalid-observation",
          observationId: observation.observationId,
          message: "All Observations in a batch must target the same Meeting",
          retryable: false
        });
        continue;
      }

      const existingObservation = await existingAcceptedObservation(
        transaction,
        workspaceId,
        observation
      );

      if (existingObservation === "same") {
        const upgradedState = upgradeLegacyImportedSourceAvailability(state, observation);

        if (upgradedState) {
          state = upgradedState;
          stateChangedByLegacyUpgrade = true;
        }

        duplicateObservationIds.push(observation.observationId);
        continue;
      }

      if (existingObservation === "different") {
        const legacyUpgrade = upgradeLegacyImportedSourceAvailability(state, observation);
        const sourceValidation =
          observation.type === "meeting-imported-from-source"
            ? validateImportedMeetingSourceObservation(observation, workspace.timezone)
            : null;

        if (legacyUpgrade && !sourceValidation) {
          state = legacyUpgrade;
          stateChangedByLegacyUpgrade = true;
          duplicateObservationIds.push(observation.observationId);
          continue;
        }

        const validationError = await validateObservationBeforeAcceptance(
          transaction,
          state,
          workspace.timezone,
          observation
        );
        errors.push(
          validationError ?? {
            code: "invalid-observation",
            observationId: observation.observationId,
            message: "Observation ID is already bound to a different canonical payload",
            retryable: false
          }
        );
        continue;
      }

      const validationError = await validateObservationBeforeAcceptance(
        transaction,
        state,
        workspace.timezone,
        observation
      );

      if (validationError) {
        errors.push(validationError);
        continue;
      }

      const accepted = await appendObservationIfNew(
        transaction,
        observation,
        state.revision + 1,
        now
      );

      if (!accepted) {
        const upgradedState = upgradeLegacyImportedSourceAvailability(state, observation);

        if (upgradedState) {
          state = upgradedState;
          stateChangedByLegacyUpgrade = true;
        }

        duplicateObservationIds.push(observation.observationId);
        continue;
      }

      const applied = await applyObservation(
        transaction,
        state,
        observation,
        workspace.timezone,
        now
      );

      if (applied.error) {
        await deleteObservation(transaction, observation);
        errors.push(applied.error);
        continue;
      }

      acceptedObservationIds.push(observation.observationId);
      state = applied.state;
      evidenceForAnalysis.push(...applied.evidenceForAnalysis);
      events.push(...applied.events);
    }

    if (acceptedObservationIds.length > 0 || stateChangedByLegacyUpgrade) {
      if (acceptedObservationIds.length > 0) {
        await ensureWorkspace(transaction, workspace, now);
      }

      state = advanceRevision(
        state,
        input.observations.at(-1)?.observedAt ?? now().toISOString()
      );

      await saveMeetingState(
        transaction,
        state,
        acceptedObservationIds.length > 0
          ? "observations-accepted"
          : "legacy-source-availability-upgraded",
        now
      );
    }

    return {
      workspace,
      state,
      acceptedObservationIds,
      duplicateObservationIds,
      errors,
      events,
      evidenceForAnalysis
    };
  });

  let state = acceptance.state;
  const workspace = acceptance.workspace;
  const workspaceId = workspace.workspaceId;
  const {
    acceptedObservationIds,
    duplicateObservationIds,
    errors,
    events,
    evidenceForAnalysis
  } = acceptance;
  const interventions: MeetingIntervention[] = [];
  let analysisStatus: MeetingUpdate["analysisStatus"] = "not-needed";

  if (evidenceForAnalysis.length > 0) {
    try {
      // A model result is valid only for the exact canonical state it saw. It
      // must never reapply over a later utterance revision or Human Judgment.
      const analysisBaseRevision = state.revision;
      const analysis =
        await reasoningModel.generateStructured<MeetingAnalysisProposalBatch>({
          workspaceId,
          meetingId,
          purpose: "understand-discussion",
          promptVersion: PROMPT_VERSION,
          schemaName: "MeetingAnalysisProposalBatch",
          evidence: evidenceForAnalysis,
          context: [],
          input: {
            revision: state.revision,
            timezone: workspace.timezone,
            languagePolicy: workspace.outputLanguagePolicy ?? "meeting-majority"
          }
        });

      // Model work happens outside a database transaction. Persist only if
      // its exact canonical base revision is still current, so a concurrently
      // accepted receipt, Human Judgment, or source revision cannot be
      // overwritten by stale model output.
      const persistedAnalysis = await persistRebasedAnalysis(
        database,
        workspaceId,
        meetingId,
        evidenceForAnalysis,
        analysis,
        analysisBaseRevision,
        now
      );
      state = persistedAnalysis.state;

      if (persistedAnalysis.applied) {
        interventions.push(...deriveInterventions(state));
        analysisStatus = "completed";
      } else {
        // A newer observation has already changed canonical state. Discard the
        // stale proposal rather than allowing AI output to reintroduce
        // superseded Evidence or overwrite Human Judgment.
        analysisStatus = "deferred";
      }
    } catch {
      analysisStatus = "deferred";
      errors.push({
        code: "analysis-temporarily-unavailable",
        retryable: true
      });
    }
  }

  // Catalog I/O is deliberately after the analysis revision fence. Otherwise
  // a slow catalog request could let a Human Judgment arrive before model
  // dispatch and make that Judgment appear to be part of the model's base
  // state. Reconciliation reloads canonical state before it persists.
  const reconciliationRequests = candidatesNeedingReconciliationForObservations(
    state,
    input.observations,
    acceptedObservationIds,
    duplicateObservationIds,
    workCatalogs,
    now()
  );

  if (reconciliationRequests.length > 0) {
    state = await reconcileAndPersistActionItemCandidates(
      database,
      state,
      reconciliationRequests,
      workspaceId,
      workCatalogs,
      reconciliationFlights,
      now
    );
  }

  return {
    workspaceId,
    meetingId,
    revision: state.revision,
    acceptedObservationIds,
    duplicateObservationIds,
    analysisStatus,
    interventions,
    events,
    errors
  };
}

const RECONCILIATION_POLICY_VERSION = "v1";
const WORK_SEARCH_LIMIT = 10;
const WORK_CATALOG_CALL_TIMEOUT_MS = 5_000;
const SEMANTIC_LINK_THRESHOLD = 35;
const INITIAL_CATALOG_RETRY_DELAY_MS = 60_000;
const MAX_CATALOG_RETRY_DELAY_MS = 60 * 60_000;

type CatalogSelection =
  | {
      providerId: string;
      catalog: WorkCatalog;
    }
  | {
      providerId: string;
      catalog: null;
      rationale: string;
    };

type CatalogSearchResult = {
  receipts: ActionItemReconciliationSearchReceipt[];
  workItems: ReconciliationWorkItemSnapshot[];
  failed: boolean;
};

type ScoredWorkItem = {
  workItem: ReconciliationWorkItemSnapshot;
  score: number;
  signals: ActionItemReconciliationMatchSignal[];
};

type WorkItemIdentity = Pick<ReconciliationWorkItemSnapshot, "providerId" | "externalId">;

type ActionItemReconciliationReviewDraft = Omit<
  ActionItemReconciliationReview,
  "id" | "policyVersion" | "attempt" | "automaticRetryNotBefore"
>;

function candidatesNeedingReconciliationForObservations(
  state: MeetingState,
  observations: MeetingObservation[],
  acceptedObservationIds: string[],
  duplicateObservationIds: string[],
  workCatalogs: ReadonlyMap<string, WorkCatalog>,
  currentTime: Date
): ReconciliationCandidateRequest[] {
  const acceptedObservationIdSet = new Set(acceptedObservationIds);
  const knownObservationIds = new Set([
    ...acceptedObservationIds,
    ...duplicateObservationIds
  ]);
  const sourceRevisionKeys = new Set(
    observations.flatMap((observation) =>
      observation.type === "meeting-imported-from-source" &&
      knownObservationIds.has(observation.observationId)
        ? [importedSourceRevisionKey(observation.source)]
        : []
    )
  );

  const currentCandidateIds = new Set(state.currentImportedActionItemCandidateIds);
  const requestsByCandidateId = new Map<string, ReconciliationCandidateRequest>();

  for (const candidate of state.importedActionItemCandidates) {
    if (
      sourceRevisionKeys.has(importedSourceRevisionKey(candidate.source.source)) &&
      currentCandidateIds.has(candidate.id) &&
      candidateNeedsReconciliation(state, candidate, workCatalogs, currentTime)
    ) {
      requestsByCandidateId.set(candidate.id, {
        candidate,
        trigger: latestReconciliationReviewForCandidate(
          state.actionItemReconciliationReviews,
          candidate.id
        )
          ? "catalog-retry"
          : "initial-source-import"
      });
    }
  }

  for (const observation of observations) {
    if (observation.type !== "human-judgment-recorded") {
      continue;
    }

    const judgment = observation.judgment;

    if (!acceptedObservationIdSet.has(observation.observationId)) {
      continue;
    }

    if (judgment.kind === "refresh-action-item-reconciliation") {
      const review = state.actionItemReconciliationReviews.find(
        (candidate) => candidate.id === judgment.reviewId
      );
      const candidate = review
        ? state.importedActionItemCandidates.find(
            (imported) => imported.id === review.candidateId
          )
        : undefined;

      if (candidate && currentCandidateIds.has(candidate.id)) {
        requestsByCandidateId.set(candidate.id, {
          candidate,
          trigger: "human-refresh"
        });
      }
    }

    if (judgment.kind === "resolve-action-item-ownership") {
      const candidate = state.importedActionItemCandidates.find(
        (imported) =>
          currentCandidateIds.has(imported.id) &&
          actionItemOwnershipClaimId(imported) === judgment.claimId
      );

      if (candidate) {
        requestsByCandidateId.set(candidate.id, {
          candidate,
          trigger: "human-ownership-resolution"
        });
      }
    }
  }

  return [...requestsByCandidateId.values()].sort((left, right) =>
    left.candidate.id.localeCompare(right.candidate.id)
  );
}

function candidateNeedsReconciliation(
  state: MeetingState,
  candidate: ImportedActionItemCandidate,
  workCatalogs: ReadonlyMap<string, WorkCatalog>,
  currentTime: Date
): boolean {
  const latestReview = latestReconciliationReviewForCandidate(
    state.actionItemReconciliationReviews,
    candidate.id
  );

  if (!latestReview) {
    return true;
  }

  if (
    state.actionItemReconciliationHumanResolutions.some(
      (resolution) => resolution.reviewId === latestReview.id
    )
  ) {
    return false;
  }

  if (!latestReview.retryable) {
    return false;
  }

  if (hasFailedCatalogRead(latestReview)) {
    return automaticCatalogRetryIsDue(latestReview, currentTime);
  }

  return latestReview.searches.some(
    (receipt) =>
      receipt.status === "not-configured" &&
      selectWorkCatalog(candidate, workCatalogs).catalog !== null
  );
}

function hasFailedCatalogRead(
  review: Pick<ActionItemReconciliationReview, "searches">
): boolean {
  return review.searches.some((receipt) => receipt.status === "failed");
}

function automaticCatalogRetryIsDue(
  review: Pick<
    ActionItemReconciliationReview,
    "searches" | "reviewedAt" | "automaticRetryNotBefore"
  >,
  currentTime: Date
): boolean {
  if (!hasFailedCatalogRead(review)) {
    return true;
  }

  const retryAt = Date.parse(review.automaticRetryNotBefore ?? review.reviewedAt);

  return Number.isFinite(retryAt) && retryAt <= currentTime.getTime();
}

function automaticCatalogRetryNotBefore(
  existingReviews: ActionItemReconciliationReview[],
  review: ActionItemReconciliationReviewDraft
): string | null {
  if (!hasFailedCatalogRead(review)) {
    return null;
  }

  const priorReviews = existingReviews
    .filter(
      (existing) =>
        existing.candidateId === review.candidateId &&
        existing.catalogProviderId === review.catalogProviderId &&
        existing.policyVersion === RECONCILIATION_POLICY_VERSION
    )
    .sort(compareReconciliationReviewsByRecency);
  let consecutiveFailures = 1;

  for (const existing of priorReviews) {
    if (!hasFailedCatalogRead(existing)) {
      break;
    }

    consecutiveFailures += 1;
  }

  const reviewedAt = Date.parse(review.reviewedAt);

  return new Date(reviewedAt + catalogRetryDelayMs(consecutiveFailures)).toISOString();
}

function catalogRetryDelayMs(consecutiveFailures: number): number {
  return Math.min(
    INITIAL_CATALOG_RETRY_DELAY_MS *
      2 ** Math.min(Math.max(0, consecutiveFailures - 1), 30),
    MAX_CATALOG_RETRY_DELAY_MS
  );
}

function latestReconciliationReviewForCandidate(
  reviews: ActionItemReconciliationReview[],
  candidateId: string
): ActionItemReconciliationReview | null {
  return (
    reviews
      .filter(
        (review) =>
          review.candidateId === candidateId &&
          review.policyVersion === RECONCILIATION_POLICY_VERSION
      )
      .sort(compareReconciliationReviewsByRecency)[0] ?? null
  );
}

function actionItemOwnershipClaimId(candidate: ImportedActionItemCandidate): string {
  return `attribution:ownership:${opaqueIdentifierSegment(candidate.lineageKey)}:${opaqueIdentifierSegment(JSON.stringify(candidate.sourceOwner))}`;
}

function acceptedOwnershipResolutionsForCandidate(
  resolutions: ActionItemOwnershipHumanResolution[],
  candidate: ImportedActionItemCandidate
): ActionItemOwnershipHumanResolution | null {
  const claimId = actionItemOwnershipClaimId(candidate);

  return (
    resolutions
      .filter(
        (resolution) =>
          resolution.claimId === claimId &&
          resolution.candidateLineageKey === candidate.lineageKey
      )
      .sort(
        (left, right) =>
          right.resolvedAt.localeCompare(left.resolvedAt) ||
          right.id.localeCompare(left.id)
      )[0] ?? null
  );
}

function effectiveActionItemOwnershipForCandidate(
  candidate: ImportedActionItemCandidate,
  resolution: ActionItemOwnershipHumanResolution | null
): ActionItemOwnershipAttribution {
  return resolution?.ownership ?? candidate.ownership;
}

function compareReconciliationReviewsByRecency(
  left: ActionItemReconciliationReview,
  right: ActionItemReconciliationReview
): number {
  return (
    right.attempt - left.attempt ||
    right.reviewedAt.localeCompare(left.reviewedAt) ||
    right.id.localeCompare(left.id)
  );
}

async function reconcileAndPersistActionItemCandidates(
  database: LumaDatabase,
  acceptedState: MeetingState,
  requests: ReconciliationCandidateRequest[],
  workspaceId: WorkspaceId,
  workCatalogs: ReadonlyMap<string, WorkCatalog>,
  flights: Map<string, ReconciliationFlight>,
  now: () => Date
): Promise<MeetingState> {
  const flightKey = [
    acceptedState.workspaceId,
    acceptedState.meetingId,
    ...requests.map((request) => `${request.candidate.id}:${request.trigger}`).sort()
  ].join("|");
  const inFlight = flights.get(flightKey);

  if (inFlight) {
    return inFlight;
  }

  const flight = (async () => {
    const reviews = await reconcileImportedActionItemCandidates(
      requests,
      acceptedState.actionItemReconciliationReviews,
      acceptedState.actionItemReconciliationHumanResolutions,
      acceptedState.actionItemOwnershipHumanResolutions,
      acceptedState.actionItemReconciliationCreatedWorkMappings,
      workspaceId,
      workCatalogs,
      now
    );
    return persistActionItemReconciliationReviews(database, acceptedState, reviews, now);
  })();

  flights.set(flightKey, flight);

  try {
    return await flight;
  } finally {
    if (flights.get(flightKey) === flight) {
      flights.delete(flightKey);
    }
  }
}

async function reconcileImportedActionItemCandidates(
  requests: ReconciliationCandidateRequest[],
  existingReviews: ActionItemReconciliationReview[],
  existingResolutions: ActionItemReconciliationHumanResolution[],
  existingOwnershipResolutions: ActionItemOwnershipHumanResolution[],
  existingCreatedWorkMappings: ActionItemReconciliationCreatedWorkMapping[],
  workspaceId: WorkspaceId,
  workCatalogs: ReadonlyMap<string, WorkCatalog>,
  now: () => Date
): Promise<ActionItemReconciliationReviewDraft[]> {
  const reviews: ActionItemReconciliationReviewDraft[] = [];

  for (const request of requests) {
    const candidate = request.candidate;
    const ownership = effectiveActionItemOwnershipForCandidate(
      candidate,
      acceptedOwnershipResolutionsForCandidate(existingOwnershipResolutions, candidate)
    );
    const review = await reconcileImportedActionItemCandidate(
      candidate,
      existingReviews,
      existingResolutions,
      existingCreatedWorkMappings,
      workspaceId,
      workCatalogs,
      now
    );
    reviews.push({
      ...review,
      ownership,
      trigger: request.trigger
    });
  }

  return reviews;
}

async function persistActionItemReconciliationReviews(
  database: LumaDatabase,
  acceptedState: MeetingState,
  reviews: ActionItemReconciliationReviewDraft[],
  now: () => Date
): Promise<MeetingState> {
  if (reviews.length === 0) {
    return acceptedState;
  }

  return database.transaction(async (transaction) => {
    const persistedAt = now();
    const latestState = await loadMeetingStateForMutation(
      transaction,
      acceptedState.workspaceId,
      acceptedState.meetingId
    );
    const currentCandidateIds = new Set(
      latestState.currentImportedActionItemCandidateIds
    );
    const candidatesById = new Map(
      latestState.importedActionItemCandidates.map((candidate) => [
        candidate.id,
        candidate
      ])
    );
    const additions = reviews
      .flatMap((review) => {
        const currentCandidate = candidatesById.get(review.candidateId);
        const latestReview = latestReconciliationReviewForCandidate(
          latestState.actionItemReconciliationReviews,
          review.candidateId
        );
        const hasHumanResolution = latestReview
          ? latestState.actionItemReconciliationHumanResolutions.some(
              (resolution) => resolution.reviewId === latestReview.id
            )
          : false;

        const isHumanReview =
          review.trigger === "human-refresh" ||
          review.trigger === "human-ownership-resolution";

        if (!(
          currentCandidateIds.has(review.candidateId) &&
          currentCandidate !== undefined &&
          sameImportedCandidate(currentCandidate, review.candidate) &&
          (!hasHumanResolution || isHumanReview) &&
          (!latestReview || latestReview.retryable || isHumanReview) &&
          (!latestReview ||
            isHumanReview ||
            automaticCatalogRetryIsDue(latestReview, persistedAt))
        )) {
          return [];
        }

        const attempt =
          latestState.actionItemReconciliationReviews
            .filter(
              (existing) =>
                existing.candidateId === review.candidateId &&
                existing.catalogProviderId === review.catalogProviderId &&
                existing.policyVersion === RECONCILIATION_POLICY_VERSION
            )
            .reduce((maximum, existing) => Math.max(maximum, existing.attempt), 0) + 1;

        return [
          {
            ...review,
            id: reconciliationReviewId(
              review.candidate,
              review.catalogProviderId,
              attempt
            ),
            policyVersion: RECONCILIATION_POLICY_VERSION,
            attempt,
            automaticRetryNotBefore: automaticCatalogRetryNotBefore(
              latestState.actionItemReconciliationReviews,
              review
            )
          }
        ];
      })
      .sort((left, right) => left.id.localeCompare(right.id));

    if (additions.length === 0) {
      return latestState;
    }

    for (const review of additions) {
      for (const evidence of review.evidence) {
        await insertEvidence(
          transaction,
          latestState.workspaceId,
          latestState.meetingId,
          evidence,
          now
        );
      }
    }

    const nextState = advanceRevision(
      {
        ...latestState,
        actionItemReconciliationReviews: [
          ...latestState.actionItemReconciliationReviews,
          ...additions
        ]
      },
      now().toISOString()
    );
    await saveMeetingState(transaction, nextState, "action-items-reconciled", now);
    return nextState;
  });
}

async function reconcileImportedActionItemCandidate(
  candidate: ImportedActionItemCandidate,
  existingReviews: ActionItemReconciliationReview[],
  existingResolutions: ActionItemReconciliationHumanResolution[],
  existingCreatedWorkMappings: ActionItemReconciliationCreatedWorkMapping[],
  workspaceId: WorkspaceId,
  workCatalogs: ReadonlyMap<string, WorkCatalog>,
  now: () => Date
): Promise<ActionItemReconciliationReviewDraft> {
  const catalogSelection = selectWorkCatalog(candidate, workCatalogs);

  if (
    candidate.source.source.completeness !== "complete" ||
    candidate.source.source.actionItemsAvailability !== "available"
  ) {
    return reconciliationReview(
      candidate,
      catalogSelection.providerId,
      {
        searches: [],
        matchSignals: [],
        outcome: {
          type: "needs-clarification",
          rationale:
            "The imported source is incomplete or its Action Items are unavailable."
        },
        workItems: []
      },
      now
    );
  }

  if (candidate.completion === "completed") {
    return reconciliationReview(
      candidate,
      catalogSelection.providerId,
      {
        searches: [],
        matchSignals: [],
        outcome: {
          type: "reject-not-work",
          rationale: "The source marks this Action Item as already completed."
        },
        workItems: []
      },
      now
    );
  }

  if (candidate.modality.kind !== "commitment" && candidate.modality.kind !== "request") {
    return reconciliationReview(
      candidate,
      catalogSelection.providerId,
      {
        searches: [],
        matchSignals: [],
        outcome: {
          type: "needs-clarification",
          rationale:
            "The source wording does not make a clear work commitment or request."
        },
        workItems: []
      },
      now
    );
  }

  if (
    candidate.deadline.confidence !== "exact" &&
    candidate.deadline.confidence !== "normalized"
  ) {
    return reconciliationReview(
      candidate,
      catalogSelection.providerId,
      {
        searches: [],
        matchSignals: [],
        outcome: {
          type: "needs-clarification",
          rationale: "The source deadline is absent or ambiguous."
        },
        workItems: []
      },
      now
    );
  }

  if (candidate.mentionedWorkItemReferences.length > 1) {
    return reconciliationReview(
      candidate,
      catalogSelection.providerId,
      {
        searches: [],
        matchSignals: [],
        outcome: {
          type: "needs-clarification",
          rationale: "The source names more than one possible canonical work item."
        },
        workItems: []
      },
      now
    );
  }

  if (!catalogSelection.catalog) {
    const query =
      candidate.mentionedWorkItemReferences[0]?.externalId ?? candidate.description;

    return reconciliationReview(
      candidate,
      catalogSelection.providerId,
      {
        searches: [
          {
            providerId: catalogSelection.providerId,
            query,
            status: "not-configured",
            workItems: [],
            failure: "catalog-not-configured"
          }
        ],
        matchSignals: [],
        outcome: {
          type: "needs-clarification",
          rationale: catalogSelection.rationale
        },
        workItems: []
      },
      now
    );
  }

  const search = await searchCanonicalWork(
    catalogSelection.catalog,
    workspaceId,
    candidate
  );

  if (search.failed) {
    return reconciliationReview(
      candidate,
      catalogSelection.providerId,
      {
        searches: search.receipts,
        matchSignals: [],
        outcome: {
          type: "needs-clarification",
          rationale: "The canonical Work Catalog could not be fully read."
        },
        workItems: search.workItems
      },
      now
    );
  }

  const priorMappings = priorMappedWorkItems(
    candidate,
    existingReviews,
    existingResolutions,
    existingCreatedWorkMappings
  );

  if (priorMappings.length > 1) {
    return reconciliationReview(
      candidate,
      catalogSelection.providerId,
      {
        searches: search.receipts,
        matchSignals: [],
        outcome: {
          type: "needs-clarification",
          rationale:
            "Earlier source revisions map this Action Item lineage to conflicting work items."
        },
        workItems: search.workItems
      },
      now
    );
  }

  const scoredWorkItems = search.workItems
    .map((workItem) => scoreWorkItem(candidate, workItem, priorMappings))
    .sort(compareScoredWorkItems);
  const matchSignals = stableMatchSignals([
    ...scoredWorkItems,
    ...priorMappings
      .filter(
        (prior) =>
          !search.workItems.some((workItem) => sameWorkItemIdentity(workItem, prior))
      )
      .map((prior) => ({
        workItem: prior,
        score: 0,
        signals: [
          {
            kind: "prior-mapping" as const,
            score: 500,
            detail: "An earlier source revision proposed this work item.",
            workItem: {
              providerId: prior.providerId,
              externalId: prior.externalId
            }
          }
        ]
      }))
  ]);
  const exactReference = candidate.mentionedWorkItemReferences[0];

  if (exactReference) {
    const exactMatches = uniqueWorkItemSnapshots(
      search.workItems.filter(
        (workItem) =>
          workItem.providerId === exactReference.providerId &&
          workItem.externalId === exactReference.externalId
      )
    );

    if (exactMatches.length !== 1) {
      return reconciliationReview(
        candidate,
        catalogSelection.providerId,
        {
          searches: search.receipts,
          matchSignals,
          outcome: {
            type: "needs-clarification",
            rationale:
              "The source's explicit work-item reference was not uniquely retrievable."
          },
          workItems: search.workItems
        },
        now
      );
    }

    const exactMatch = exactMatches[0];

    if (!exactMatch) {
      throw new Error("expected a uniquely matched Work Item");
    }

    const priorMapping = priorMappings[0];
    const semanticCompetitor = scoredWorkItems.find(
      (scored) =>
        !sameWorkItemIdentity(scored.workItem, exactMatch) &&
        semanticScoreForSignals(scored.signals) >= SEMANTIC_LINK_THRESHOLD
    );

    if (
      (priorMapping && !sameWorkItemIdentity(priorMapping, exactMatch)) ||
      semanticCompetitor
    ) {
      return reconciliationReview(
        candidate,
        catalogSelection.providerId,
        {
          searches: search.receipts,
          matchSignals,
          outcome: {
            type: "needs-clarification",
            rationale:
              "The explicit work-item reference conflicts with another plausible mapping."
          },
          workItems: search.workItems
        },
        now
      );
    }

    return reconciliationReview(
      candidate,
      catalogSelection.providerId,
      {
        searches: search.receipts,
        matchSignals,
        outcome: outcomeForSelectedWorkItem(
          candidate,
          exactMatch,
          catalogSelection.catalog.supportsConditionalUpdates === true
        ),
        workItems: search.workItems
      },
      now
    );
  }

  if (search.workItems.length === 0) {
    if (priorMappings.length > 0) {
      return reconciliationReview(
        candidate,
        catalogSelection.providerId,
        {
          searches: search.receipts,
          matchSignals,
          outcome: {
            type: "needs-clarification",
            rationale:
              "A prior mapping was not found by the completed canonical work search."
          },
          workItems: []
        },
        now
      );
    }

    return reconciliationReview(
      candidate,
      catalogSelection.providerId,
      {
        searches: search.receipts,
        matchSignals,
        outcome: {
          type: "create-new",
          rationale: "A completed canonical work search returned no work items."
        },
        workItems: []
      },
      now
    );
  }

  const plausibleWorkItems = scoredWorkItems.filter(
    (scored) => scored.score >= SEMANTIC_LINK_THRESHOLD
  );
  const selected = plausibleWorkItems[0];
  const tied =
    selected &&
    plausibleWorkItems.filter((scored) => scored.score === selected.score).length > 1;
  const priorMapping = priorMappings[0];

  if (!selected || tied) {
    return reconciliationReview(
      candidate,
      catalogSelection.providerId,
      {
        searches: search.receipts,
        matchSignals,
        outcome: {
          type: "needs-clarification",
          rationale:
            "The canonical work search did not identify one clear matching work item."
        },
        workItems: search.workItems
      },
      now
    );
  }

  if (priorMapping && !sameWorkItemIdentity(priorMapping, selected.workItem)) {
    return reconciliationReview(
      candidate,
      catalogSelection.providerId,
      {
        searches: search.receipts,
        matchSignals,
        outcome: {
          type: "needs-clarification",
          rationale:
            "The best current match conflicts with a prior source-lineage mapping."
        },
        workItems: search.workItems
      },
      now
    );
  }

  return reconciliationReview(
    candidate,
    catalogSelection.providerId,
    {
      searches: search.receipts,
      matchSignals,
      outcome: outcomeForSelectedWorkItem(
        candidate,
        selected.workItem,
        catalogSelection.catalog.supportsConditionalUpdates === true
      ),
      workItems: search.workItems
    },
    now
  );
}

function selectWorkCatalog(
  candidate: ImportedActionItemCandidate,
  workCatalogs: ReadonlyMap<string, WorkCatalog>
): CatalogSelection {
  const explicitReference = candidate.mentionedWorkItemReferences[0];

  if (explicitReference) {
    const catalog = workCatalogs.get(explicitReference.providerId) ?? null;

    return catalog
      ? { providerId: explicitReference.providerId, catalog }
      : {
          providerId: explicitReference.providerId,
          catalog: null,
          rationale: "The source references a Work Catalog that is not configured."
        };
  }

  const sourceCatalog = workCatalogs.get(candidate.source.source.workItemProviderId);

  if (sourceCatalog) {
    return {
      providerId: candidate.source.source.workItemProviderId,
      catalog: sourceCatalog
    };
  }

  if (candidate.source.source.workItemProviderId.trim().length > 0) {
    return {
      providerId: candidate.source.source.workItemProviderId,
      catalog: null,
      rationale: "The source-bound Work Catalog is not configured."
    };
  }

  if (workCatalogs.size === 1) {
    const entry = [...workCatalogs.entries()][0];

    if (entry) {
      return { providerId: entry[0], catalog: entry[1] };
    }
  }

  return {
    providerId: workCatalogs.size === 0 ? "unconfigured" : "ambiguous",
    catalog: null,
    rationale:
      workCatalogs.size === 0
        ? "No canonical Work Catalog is configured."
        : "The source does not identify which configured Work Catalog is canonical."
  };
}

async function searchCanonicalWork(
  catalog: WorkCatalog,
  workspaceId: WorkspaceId,
  candidate: ImportedActionItemCandidate
): Promise<CatalogSearchResult> {
  const queries = uniqueStrings([
    candidate.mentionedWorkItemReferences[0]?.externalId,
    candidate.description
  ]);
  const cachedWorkItems = new Map<string, ReconciliationWorkItemSnapshot>();
  const receipts: ActionItemReconciliationSearchReceipt[] = [];

  for (const query of queries) {
    try {
      const results = await withWorkCatalogDeadline(
        catalog.searchWorkItems({
          workspaceId,
          text: query,
          limit: WORK_SEARCH_LIMIT
        })
      );
      const workItems: ReconciliationWorkItemSnapshot[] = [];

      for (const result of [...results].sort(compareWorkItems)) {
        if (result.providerId !== catalog.providerId) {
          throw new Error("work-catalog-provider-mismatch");
        }

        const key = workItemIdentityKey(result.providerId, result.externalId);
        let snapshot = cachedWorkItems.get(key);

        if (!snapshot) {
          const hydrated = await withWorkCatalogDeadline(catalog.getWorkItem(result.id));

          if (
            hydrated.providerId !== catalog.providerId ||
            hydrated.externalId !== result.externalId
          ) {
            throw new Error("work-catalog-retrieval-mismatch");
          }

          snapshot = reconciliationWorkItemSnapshot(hydrated);
          cachedWorkItems.set(key, snapshot);
        }

        workItems.push(snapshot);
      }

      receipts.push({
        providerId: catalog.providerId,
        query,
        status: "completed",
        workItems: uniqueWorkItemSnapshots(workItems),
        failure: null
      });
    } catch {
      receipts.push({
        providerId: catalog.providerId,
        query,
        status: "failed",
        workItems: [],
        failure: "work-catalog-read-failed"
      });

      return {
        receipts,
        workItems: uniqueWorkItemSnapshots([...cachedWorkItems.values()]),
        failed: true
      };
    }
  }

  return {
    receipts,
    workItems: uniqueWorkItemSnapshots([...cachedWorkItems.values()]),
    failed: false
  };
}

function reconciliationWorkItemSnapshot(
  workItem: WorkItem
): ReconciliationWorkItemSnapshot {
  return {
    providerId: workItem.providerId,
    lookupId: workItem.id,
    externalId: workItem.externalId,
    title: workItem.title,
    description: workItem.description,
    status: workItem.status,
    assignees: workItem.assignees,
    dueDate: workItem.dueDate,
    labels: [...workItem.labels],
    projectId: workItem.projectId,
    parentId: workItem.parentId,
    url: workItem.url,
    updatedAt: workItem.updatedAt
  };
}

function compareWorkItems(left: WorkItem, right: WorkItem): number {
  return workItemIdentityKey(left.providerId, left.externalId).localeCompare(
    workItemIdentityKey(right.providerId, right.externalId)
  );
}

function uniqueWorkItemSnapshots(
  workItems: ReconciliationWorkItemSnapshot[]
): ReconciliationWorkItemSnapshot[] {
  return [
    ...new Map(
      workItems.map((workItem) => [
        workItemIdentityKey(workItem.providerId, workItem.externalId),
        workItem
      ])
    ).values()
  ].sort((left, right) =>
    workItemIdentityKey(left.providerId, left.externalId).localeCompare(
      workItemIdentityKey(right.providerId, right.externalId)
    )
  );
}

function priorMappedWorkItems(
  candidate: ImportedActionItemCandidate,
  reviews: ActionItemReconciliationReview[],
  resolutions: ActionItemReconciliationHumanResolution[],
  createdWorkMappings: ActionItemReconciliationCreatedWorkMapping[]
): WorkItemIdentity[] {
  const reviewsById = new Map(reviews.map((review) => [review.id, review]));

  return uniqueWorkItemIdentities([
    ...resolutions
      .filter(
        (resolution) =>
          reviewsById.get(resolution.reviewId)?.candidateLineageKey ===
            candidate.lineageKey && resolution.candidateId !== candidate.id
      )
      .sort((left, right) => right.resolvedAt.localeCompare(left.resolvedAt))
      .flatMap((resolution) => {
        const workItem = outcomeWorkItem(resolution.outcome);
        return workItem ? [workItem] : [];
      }),
    ...createdWorkMappings
      .filter((mapping) => mapping.candidateLineageKey === candidate.lineageKey)
      .map((mapping) => ({
        providerId: mapping.externalReference.providerId,
        externalId: mapping.externalReference.externalId
      }))
  ]);
}

function uniqueWorkItemIdentities(workItems: WorkItemIdentity[]): WorkItemIdentity[] {
  return [
    ...new Map(
      workItems.map((workItem) => [
        workItemIdentityKey(workItem.providerId, workItem.externalId),
        { providerId: workItem.providerId, externalId: workItem.externalId }
      ])
    ).values()
  ].sort((left, right) =>
    workItemIdentityKey(left.providerId, left.externalId).localeCompare(
      workItemIdentityKey(right.providerId, right.externalId)
    )
  );
}

function scoreWorkItem(
  candidate: ImportedActionItemCandidate,
  workItem: ReconciliationWorkItemSnapshot,
  priorMappings: WorkItemIdentity[]
): ScoredWorkItem {
  const signals: ActionItemReconciliationMatchSignal[] = [];
  let score = 0;
  const identity = {
    providerId: workItem.providerId,
    externalId: workItem.externalId
  };

  if (
    candidate.mentionedWorkItemReferences.some(
      (reference) =>
        reference.providerId === workItem.providerId &&
        reference.externalId === workItem.externalId
    )
  ) {
    signals.push({
      kind: "exact-id",
      score: 1_000,
      detail: "The source explicitly names this work item.",
      workItem: identity
    });
    score += 1_000;
  }

  if (priorMappings.some((prior) => sameWorkItemIdentity(prior, workItem))) {
    signals.push({
      kind: "prior-mapping",
      score: 500,
      detail: "An earlier source revision proposed this same work item.",
      workItem: identity
    });
    score += 500;
  }

  const semanticScore = semanticSimilarityScore(
    candidate.description,
    `${workItem.title}\n${workItem.description}`
  );

  if (semanticScore > 0) {
    signals.push({
      kind: "semantic",
      score: semanticScore,
      detail: "Normalized source wording overlaps this work item's title or description.",
      workItem: identity
    });
    score += semanticScore;
  }

  if (
    workItem.projectId &&
    candidate.projectHints.some(
      (hint) =>
        normalizeComparisonText(hint) ===
        normalizeComparisonText(workItem.projectId ?? "")
    )
  ) {
    signals.push({
      kind: "project",
      score: 25,
      detail: "The candidate's project hint matches this work item.",
      workItem: identity
    });
    score += 25;
  }

  const componentMatches = candidate.componentHints.filter((hint) =>
    workItem.labels.some(
      (label) => normalizeComparisonText(label) === normalizeComparisonText(hint)
    )
  );

  if (componentMatches.length > 0) {
    signals.push({
      kind: "component",
      score: 20,
      detail: "The candidate's component hint matches a work-item label.",
      workItem: identity
    });
    score += 20;
  }

  const ownerText =
    candidate.sourceOwner.state === "unmapped" ? candidate.sourceOwner.sourceText : null;

  if (
    ownerText &&
    workItem.assignees.some(
      (assignee) =>
        normalizeComparisonText(assignee.displayName) ===
        normalizeComparisonText(ownerText)
    )
  ) {
    signals.push({
      kind: "ownership",
      score: 15,
      detail: "The source owner wording matches a work-item assignee.",
      workItem: identity
    });
    score += 15;
  }

  if (hasRecentWorkActivity(candidate, workItem)) {
    signals.push({
      kind: "activity",
      score: 5,
      detail: "The work item is active and was updated near the observed source time.",
      workItem: identity
    });
    score += 5;
  }

  return { workItem, score, signals };
}

function hasRecentWorkActivity(
  candidate: ImportedActionItemCandidate,
  workItem: ReconciliationWorkItemSnapshot
): boolean {
  if (workItem.status !== "active" && workItem.status !== "blocked") {
    return false;
  }

  const sourceAt = Date.parse(candidate.source.source.capturedAt);
  const updatedAt = Date.parse(workItem.updatedAt);

  return (
    Number.isFinite(sourceAt) &&
    Number.isFinite(updatedAt) &&
    Math.abs(sourceAt - updatedAt) <= 30 * 24 * 60 * 60 * 1_000
  );
}

function semanticSimilarityScore(left: string, right: string): number {
  const leftTokens = new Set(semanticTokens(left));
  const rightTokens = new Set(semanticTokens(right));

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;

  return union === 0 ? 0 : Math.round((shared / union) * 100);
}

function semanticTokens(value: string): string[] {
  const ignored = new Set([
    "a",
    "an",
    "and",
    "by",
    "das",
    "der",
    "die",
    "for",
    "ich",
    "im",
    "in",
    "of",
    "the",
    "to",
    "und",
    "will",
    "wir"
  ]);

  return (normalizeComparisonText(value).match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (token) => !ignored.has(token)
  );
}

function normalizeComparisonText(value: string): string {
  return value.normalize("NFKD").toLocaleLowerCase("de-DE").trim();
}

function compareScoredWorkItems(left: ScoredWorkItem, right: ScoredWorkItem): number {
  return (
    right.score - left.score ||
    workItemIdentityKey(left.workItem.providerId, left.workItem.externalId).localeCompare(
      workItemIdentityKey(right.workItem.providerId, right.workItem.externalId)
    )
  );
}

function stableMatchSignals(
  scoredWorkItems: ReadonlyArray<Pick<ScoredWorkItem, "signals">>
): ActionItemReconciliationMatchSignal[] {
  return scoredWorkItems
    .flatMap((scored) => scored.signals)
    .sort((left, right) => {
      const leftIdentity = left.workItem
        ? workItemIdentityKey(left.workItem.providerId, left.workItem.externalId)
        : "";
      const rightIdentity = right.workItem
        ? workItemIdentityKey(right.workItem.providerId, right.workItem.externalId)
        : "";

      return (
        right.score - left.score ||
        left.kind.localeCompare(right.kind) ||
        leftIdentity.localeCompare(rightIdentity) ||
        left.detail.localeCompare(right.detail)
      );
    });
}

function semanticScoreForSignals(signals: ActionItemReconciliationMatchSignal[]): number {
  return signals
    .filter((signal) => signal.kind === "semantic")
    .reduce((score, signal) => score + signal.score, 0);
}

function outcomeForSelectedWorkItem(
  candidate: ImportedActionItemCandidate,
  workItem: ReconciliationWorkItemSnapshot,
  supportsConditionalUpdates: boolean
): ActionItemReconciliationOutcome {
  if (workItem.status === "completed" || workItem.status === "cancelled") {
    return {
      type: "needs-clarification",
      rationale: "The selected work item is already in a terminal provider state."
    };
  }

  if (
    candidate.deadline.normalizedDate !== null &&
    candidate.deadline.normalizedDate !== workItem.dueDate
  ) {
    if (!supportsConditionalUpdates) {
      return {
        type: "needs-clarification",
        rationale:
          "The canonical Work Catalog cannot conditionally update this work item; keep the grounded change for a manual tracker update."
      };
    }

    return {
      type: "update-existing",
      workItem,
      rationale:
        "One canonical work item was selected, and the source may require a reviewable update."
    };
  }

  return {
    type: "link-existing",
    workItem,
    rationale:
      "One canonical work item was selected without a proposed source-derived change."
  };
}

function reconciliationReview(
  candidate: ImportedActionItemCandidate,
  providerId: string,
  input: {
    searches: ActionItemReconciliationSearchReceipt[];
    matchSignals: ActionItemReconciliationMatchSignal[];
    outcome: ActionItemReconciliationOutcome;
    workItems: ReconciliationWorkItemSnapshot[];
  },
  now: () => Date
): ActionItemReconciliationReviewDraft {
  return {
    catalogProviderId: providerId,
    candidateId: candidate.id,
    candidateLineageKey: candidate.lineageKey,
    candidate,
    ownership: candidate.ownership,
    evidence: uniqueEvidence([
      ...candidate.evidence,
      ...uniqueWorkItemSnapshots(input.workItems).map((workItem) =>
        reconciliationWorkEvidence(candidate, workItem)
      )
    ]),
    searches: input.searches,
    matchSignals: input.matchSignals,
    outcome: input.outcome,
    trigger: "initial-source-import",
    retryable: input.searches.some(
      (search) => search.status === "failed" || search.status === "not-configured"
    ),
    reviewStatus: "proposed",
    reviewedAt: now().toISOString()
  };
}

function reconciliationWorkEvidence(
  candidate: ImportedActionItemCandidate,
  workItem: ReconciliationWorkItemSnapshot
): EvidenceReference {
  return {
    evidenceId: `evidence:reconciliation-work:${opaqueIdentifierSegment(candidate.id)}:${opaqueIdentifierSegment(workItem.providerId)}:${opaqueIdentifierSegment(workItem.externalId)}:${opaqueIdentifierSegment(workItem.updatedAt)}`,
    source: "work",
    sourceObjectId: workItem.externalId,
    sourceVersion: workItem.updatedAt,
    excerpt: [workItem.title, workItem.description].filter(Boolean).join("\n"),
    externalReference: {
      providerId: workItem.providerId,
      objectType: "work-item",
      externalId: workItem.externalId,
      url: workItem.url,
      version: workItem.updatedAt
    }
  };
}

function outcomeWorkItem(
  outcome: ActionItemReconciliationOutcome
): ReconciliationWorkItemSnapshot | null {
  if (outcome.type === "link-existing" || outcome.type === "update-existing") {
    return outcome.workItem;
  }

  return null;
}

function reconciliationReviewId(
  candidate: ImportedActionItemCandidate,
  providerId: string,
  attempt: number
): string {
  return `reconciliation:${opaqueIdentifierSegment(candidate.id)}:${opaqueIdentifierSegment(providerId)}:${RECONCILIATION_POLICY_VERSION}:attempt:${attempt}`;
}

function workItemIdentityKey(providerId: string, externalId: string): string {
  return `${opaqueIdentifierSegment(providerId)}:${opaqueIdentifierSegment(externalId)}`;
}

function sameWorkItemIdentity(left: WorkItemIdentity, right: WorkItemIdentity): boolean {
  return left.providerId === right.providerId && left.externalId === right.externalId;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

async function withWorkCatalogDeadline<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("work-catalog-read-timeout")),
          WORK_CATALOG_CALL_TIMEOUT_MS
        );
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function sameImportedCandidate(
  left: ImportedActionItemCandidate,
  right: ImportedActionItemCandidate
): boolean {
  return (
    left.id === right.id &&
    left.lineageKey === right.lineageKey &&
    left.originalText === right.originalText &&
    left.description === right.description &&
    left.completion === right.completion &&
    left.source.sourceBlockId === right.source.sourceBlockId &&
    left.source.sourceExcerpt === right.source.sourceExcerpt &&
    sameImportedMeetingSource(left.source.source, right.source.source)
  );
}

async function queryMeeting(
  database: LumaDatabase,
  input: QueryMeeting
): Promise<MeetingQueryResult> {
  const state = await requireMeetingState(database, input.workspaceId, input.meetingId);
  const query = input.query;

  switch (query.type) {
    case "snapshot":
      return {
        type: "snapshot",
        state
      };
    case "catch-up": {
      const previousState = await loadMeetingStateAtBoundary(
        database,
        input.workspaceId,
        input.meetingId,
        query.since
      );
      const changes = deriveCatchUpChanges(previousState, state);
      return {
        type: "catch-up",
        answer: {
          text: changes.text,
          evidence: changes.evidence,
          uncertainty: changes.evidence.length > 0 ? "none" : "insufficient-evidence"
        }
      };
    }
    case "freeform": {
      const matchingActionItems = query.participantId
        ? state.actionItems.filter((item) => {
            const ownership = actionItemOwnership(item);
            return (
              ownership.status === "confirmed" &&
              ownership.ownerPersonId === query.participantId
            );
          })
        : state.actionItems;
      const evidence = matchingActionItems.flatMap((item) => item.provenance.evidence);
      return {
        type: "freeform",
        answer: {
          text:
            matchingActionItems.length > 0
              ? matchingActionItems
                  .map((item) => formatActionAnswer(item, query.text))
                  .join("\n")
              : "I do not have enough evidence to answer that factually.",
          evidence,
          uncertainty: evidence.length > 0 ? "none" : "insufficient-evidence"
        }
      };
    }
    case "decision-history": {
      const matchingDecisions = state.decisions.filter((decision) =>
        decision.statement.toLowerCase().includes(query.topic.toLowerCase())
      );
      const evidence = matchingDecisions.flatMap(
        (decision) => decision.provenance.evidence
      );
      return {
        type: "decision-history",
        answer: {
          text:
            matchingDecisions.length > 0
              ? matchingDecisions
                  .map((decision) => `${decision.status}: ${decision.statement}`)
                  .join("\n")
              : "I do not have evidence for that Decision history.",
          evidence,
          uncertainty: evidence.length > 0 ? "none" : "insufficient-evidence"
        }
      };
    }
    case "participant-brief": {
      return {
        type: "participant-brief",
        brief: buildParticipantBrief(state, query.participantId, "en")
      };
    }
    case "action-item-reconciliation-review": {
      return {
        type: "action-item-reconciliation-review",
        reviews: currentActionItemReconciliationReviews(state)
      };
    }
    case "action-item-reconciliation-history": {
      return {
        type: "action-item-reconciliation-history",
        reviews: [...state.actionItemReconciliationReviews].sort(
          (left, right) =>
            left.candidateId.localeCompare(right.candidateId) ||
            left.attempt - right.attempt ||
            left.id.localeCompare(right.id)
        )
      };
    }
    default:
      throw new Error("Unsupported Meeting query type");
  }
}

function currentActionItemReconciliationReviews(
  state: MeetingState
): CurrentActionItemReconciliationReview[] {
  const currentCandidateIds = new Set(state.currentImportedActionItemCandidateIds);
  const latestReviewsByCandidate = new Map<string, ActionItemReconciliationReview>();

  for (const review of [...state.actionItemReconciliationReviews].sort(
    compareReconciliationReviewsByRecency
  )) {
    if (
      currentCandidateIds.has(review.candidateId) &&
      !latestReviewsByCandidate.has(review.candidateId) &&
      review.policyVersion === RECONCILIATION_POLICY_VERSION
    ) {
      latestReviewsByCandidate.set(review.candidateId, review);
    }
  }

  const views = [...latestReviewsByCandidate.values()]
    .map((proposal) => {
      const humanResolution = latestHumanResolutionForReview(
        state.actionItemReconciliationHumanResolutions,
        proposal.id
      );

      return {
        proposal,
        ownershipClaimId: actionItemOwnershipClaimId(proposal.candidate),
        ownership: proposal.ownership,
        effectiveOutcome: humanResolution?.outcome ?? proposal.outcome,
        status: humanResolution ? "human-resolved" : "proposed",
        conflictingCandidateIds: [],
        humanResolution
      } satisfies CurrentActionItemReconciliationReview;
    })
    .sort((left, right) =>
      left.proposal.candidateId.localeCompare(right.proposal.candidateId)
    );

  return viewsWithCrossCandidateConflicts(views);
}

function latestHumanResolutionForReview(
  resolutions: ActionItemReconciliationHumanResolution[],
  reviewId: string
): ActionItemReconciliationHumanResolution | null {
  return (
    resolutions
      .filter((resolution) => resolution.reviewId === reviewId)
      .sort(
        (left, right) =>
          right.resolvedAt.localeCompare(left.resolvedAt) ||
          right.id.localeCompare(left.id)
      )[0] ?? null
  );
}

function viewsWithCrossCandidateConflicts(
  views: CurrentActionItemReconciliationReview[]
): CurrentActionItemReconciliationReview[] {
  const groups = new Map<string, CurrentActionItemReconciliationReview[]>();

  for (const view of views) {
    const key = reconciliationConflictKey(view);

    if (key) {
      groups.set(key, [...(groups.get(key) ?? []), view]);
    }
  }

  const conflictsByCandidate = new Map<string, string[]>();

  for (const members of groups.values()) {
    if (members.length < 2) {
      continue;
    }

    const humanResolved = members.filter((member) => member.status === "human-resolved");
    const blocked =
      humanResolved.length > 0
        ? members.filter((member) => member.status !== "human-resolved")
        : members;

    for (const member of blocked) {
      conflictsByCandidate.set(
        member.proposal.candidateId,
        members
          .filter((other) => other.proposal.candidateId !== member.proposal.candidateId)
          .map((other) => other.proposal.candidateId)
          .sort()
      );
    }
  }

  return views.map((view) => {
    const conflictingCandidateIds =
      conflictsByCandidate.get(view.proposal.candidateId) ?? [];

    if (conflictingCandidateIds.length === 0) {
      return view;
    }

    return {
      ...view,
      effectiveOutcome: {
        type: "needs-clarification",
        rationale:
          "Another current source candidate proposes the same work target or new-work draft."
      },
      status: "blocked-by-conflict",
      conflictingCandidateIds
    };
  });
}

function reconciliationConflictKey(
  view: CurrentActionItemReconciliationReview
): string | null {
  const workItem = outcomeWorkItem(view.effectiveOutcome);

  if (workItem) {
    return `work:${workItemIdentityKey(workItem.providerId, workItem.externalId)}`;
  }

  return view.effectiveOutcome.type === "create-new"
    ? `create:${semanticTokens(view.proposal.candidate.description).sort().join("|")}`
    : null;
}

async function loadMeetingStateAtBoundary(
  database: LumaDatabase,
  workspaceId: WorkspaceId,
  meetingId: MeetingId,
  since: { type: "time"; value: string } | { type: "revision"; value: number }
): Promise<MeetingState | null> {
  const result =
    since.type === "revision"
      ? await database.query<MeetingRevisionRow>(
          `SELECT state_json
             FROM meeting_revisions
            WHERE workspace_id = $1 AND meeting_id = $2 AND revision <= $3
            ORDER BY revision DESC
            LIMIT 1`,
          [workspaceId, meetingId, since.value]
        )
      : await database.query<MeetingRevisionRow>(
          `SELECT state_json
             FROM meeting_revisions
            WHERE workspace_id = $1 AND meeting_id = $2 AND created_at <= $3
            ORDER BY revision DESC
            LIMIT 1`,
          [workspaceId, meetingId, since.value]
        );
  const row = result.rows[0];
  return row ? normalizeMeetingState(parseJson<MeetingState>(row.state_json)) : null;
}

function deriveCatchUpChanges(
  previousState: MeetingState | null,
  currentState: MeetingState
): {
  text: string;
  evidence: EvidenceReference[];
} {
  const decisions = changedMeetingItems(
    previousState?.decisions ?? [],
    currentState.decisions
  );
  const actionItems = changedMeetingItems(
    previousState?.actionItems ?? [],
    currentState.actionItems
  );
  const openQuestions = changedMeetingItems(
    previousState?.openQuestions ?? [],
    currentState.openQuestions
  );
  const risks = changedMeetingItems(previousState?.risks ?? [], currentState.risks);
  const lines = [
    ...decisions.map(
      (decision) => `Decision (${decision.status}): ${decision.statement}`
    ),
    ...actionItems.map((item) => `Action Item (${item.status}): ${item.description}`),
    ...openQuestions.map(
      (question) => `Open Question (${question.status}): ${question.question}`
    ),
    ...risks.map((risk) => `Risk (${risk.severity}): ${risk.statement}`)
  ];
  const evidence = uniqueEvidence([
    ...decisions.flatMap((decision) => decision.provenance.evidence),
    ...actionItems.flatMap((item) => item.provenance.evidence),
    ...openQuestions.flatMap((question) => question.provenance.evidence),
    ...risks.flatMap((risk) => risk.provenance.evidence)
  ]);

  return {
    text:
      lines.length > 0
        ? `Grounded changes:\n${lines.join("\n")}`
        : "No grounded changes are available for this Meeting yet.",
    evidence
  };
}

function changedMeetingItems<T extends { id: string }>(previous: T[], current: T[]): T[] {
  const previousById = new Map(previous.map((item) => [item.id, item]));

  return current.filter((item) => {
    const previousItem = previousById.get(item.id);
    return !previousItem || JSON.stringify(previousItem) !== JSON.stringify(item);
  });
}

function uniqueEvidence(evidence: EvidenceReference[]): EvidenceReference[] {
  return [
    ...new Map(evidence.map((reference) => [reference.evidenceId, reference])).values()
  ];
}

async function concludeMeeting(
  database: LumaDatabase,
  now: () => Date,
  input: ConcludeMeeting
): Promise<MeetingConclusion> {
  const state = await requireMeetingState(database, input.workspaceId, input.meetingId);
  const outputLanguage = await resolveConclusionOutputLanguage(database, input);
  // Older conclusions may have cached a legacy `speaker_id` as if it were a
  // verified attribution. Version this projection so a current read rebuilds
  // from the safe attribution overlay rather than replaying that cache.
  const optionsHash = `${outputLanguage}:${CONCLUSION_SPEAKER_ATTRIBUTION_PROJECTION_VERSION}`;
  const existing = await database.query<ConclusionRow>(
    `SELECT conclusion_json FROM conclusions
     WHERE workspace_id = $1 AND meeting_id = $2 AND revision = $3 AND options_hash = $4`,
    [input.workspaceId, input.meetingId, state.revision, optionsHash]
  );

  const existingRow = existing.rows[0];

  if (existingRow) {
    return parseJson<MeetingConclusion>(existingRow.conclusion_json);
  }

  const conclusion: MeetingConclusion = {
    workspaceId: state.workspaceId,
    meetingId: state.meetingId,
    revision: state.revision,
    summary: {
      brief: renderConclusionBrief(state, outputLanguage),
      detailed: renderConclusionDetail(state, outputLanguage)
    },
    topics: state.topics,
    decisions: state.decisions,
    actionItems: state.actionItems,
    openQuestions: state.openQuestions,
    risks: state.risks,
    followUpIntentions: state.followUpIntentions,
    participantBriefs: state.participants.map((participant) =>
      buildParticipantBrief(state, participant.personId, outputLanguage)
    ),
    outputLanguage,
    provenance: combineProvenance(state, state.revision),
    createdAt: now().toISOString()
  };

  await database.query(
    `INSERT INTO conclusions (
      workspace_id, meeting_id, revision, options_hash, conclusion_json, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      conclusion.workspaceId,
      conclusion.meetingId,
      conclusion.revision,
      optionsHash,
      JSON.stringify(conclusion),
      conclusion.createdAt
    ]
  );

  return conclusion;
}

async function resolveConclusionOutputLanguage(
  database: LumaDatabase,
  input: ConcludeMeeting
): Promise<"de" | "en"> {
  if (input.outputLanguage) {
    return input.outputLanguage;
  }

  const workspaceResult = await database.query<WorkspaceConfigRow>(
    `SELECT config_json FROM workspaces WHERE workspace_id = $1`,
    [input.workspaceId]
  );
  const workspaceRow = workspaceResult.rows[0];
  const workspace = workspaceRow
    ? parseJson<WorkspaceConfig>(workspaceRow.config_json)
    : null;

  if (workspace?.outputLanguagePolicy === "german") {
    return "de";
  }

  if (workspace?.outputLanguagePolicy === "english") {
    return "en";
  }

  const utteranceResult = await database.query<UtteranceLanguageRow>(
    `SELECT language
       FROM utterance_versions
      WHERE workspace_id = $1
        AND meeting_id = $2
        AND superseded_by_version IS NULL`,
    [input.workspaceId, input.meetingId]
  );
  let germanScore = 0;
  let englishScore = 0;

  for (const utterance of utteranceResult.rows) {
    if (utterance.language === "de") {
      germanScore += 1;
    } else if (utterance.language === "en") {
      englishScore += 1;
    } else if (utterance.language === "mixed") {
      germanScore += 0.5;
      englishScore += 0.5;
    }
  }

  if (germanScore !== englishScore) {
    return germanScore > englishScore ? "de" : "en";
  }

  const meetingStartedResult = await database.query<ObservationPayloadRow>(
    `SELECT payload_json
       FROM meeting_observations
      WHERE workspace_id = $1 AND meeting_id = $2 AND type = 'meeting-started'
      ORDER BY occurred_at ASC
      LIMIT 1`,
    [input.workspaceId, input.meetingId]
  );
  const meetingStartedRow = meetingStartedResult.rows[0];

  if (meetingStartedRow) {
    const observation = parseJson<MeetingObservation>(meetingStartedRow.payload_json);

    if (
      observation.type === "meeting-started" &&
      (observation.languageMode === "de" || observation.languageMode === "en")
    ) {
      return observation.languageMode;
    }
  }

  return "en";
}

function renderConclusionBrief(state: MeetingState, outputLanguage: "de" | "en"): string {
  if (outputLanguage === "de") {
    return state.actionItems.length > 0
      ? `Das Meeting hat ${state.actionItems.length} belegte Action Item(s).`
      : "Das Meeting hat noch keine belegten Action Items.";
  }

  return state.actionItems.length > 0
    ? `The Meeting has ${state.actionItems.length} grounded Action Item(s).`
    : "The Meeting has no grounded Action Items yet.";
}

function renderConclusionDetail(
  state: MeetingState,
  outputLanguage: "de" | "en"
): string {
  return [
    ...state.decisions.map(
      (decision) =>
        `${outputLanguage === "de" ? "Entscheidung" : "Decision"}: ${decision.statement}`
    ),
    ...state.actionItems.map((item) => `Action Item: ${item.description}`)
  ].join("\n");
}

async function ensureWorkspace(
  database: DatabaseQuery,
  workspace: WorkspaceConfig,
  now: () => Date
): Promise<void> {
  await database.query(
    `INSERT INTO workspaces (workspace_id, timezone, config_json, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id)
     DO NOTHING`,
    [
      workspace.workspaceId,
      workspace.timezone,
      JSON.stringify(workspace),
      now().toISOString()
    ]
  );
}

/**
 * A workspace's timezone and publication policy are configuration, not an
 * attribute of an incoming observation.  Once persisted, they are read-only
 * at this boundary so rejected (or merely stale) deliveries cannot rewrite
 * how Luma interprets evidence.
 */
async function canonicalWorkspaceConfig(
  database: DatabaseQuery,
  workspace: WorkspaceConfig
): Promise<WorkspaceConfig> {
  const result = await database.query<WorkspaceConfigRow>(
    `SELECT config_json FROM workspaces WHERE workspace_id = $1`,
    [workspace.workspaceId]
  );
  const row = result.rows[0];

  return row ? parseCanonicalWorkspaceConfig(row, workspace) : workspace;
}

/**
 * Serializes only the local workspace configuration claim. Source verification
 * remains outside this transaction so the ledger-backed verifier never nests
 * PGlite work inside Meeting Intelligence's acceptance transaction.
 */
async function lockCanonicalWorkspaceConfig(
  database: DatabaseQuery,
  workspace: WorkspaceConfig
): Promise<WorkspaceConfig> {
  await database.query(
    `INSERT INTO workspace_config_locks (workspace_id)
     VALUES ($1)
     ON CONFLICT (workspace_id)
     DO UPDATE SET workspace_id = EXCLUDED.workspace_id`,
    [workspace.workspaceId]
  );
  const result = await database.query<WorkspaceConfigRow>(
    `SELECT config_json
       FROM workspaces
      WHERE workspace_id = $1
      FOR UPDATE`,
    [workspace.workspaceId]
  );
  const row = result.rows[0];

  if (!row) {
    return workspace;
  }

  return parseCanonicalWorkspaceConfig(row, workspace);
}

function parseCanonicalWorkspaceConfig(
  row: WorkspaceConfigRow,
  workspace: WorkspaceConfig
): WorkspaceConfig {
  const persisted = parseJson<WorkspaceConfig>(row.config_json);

  if (
    persisted.workspaceId !== workspace.workspaceId ||
    typeof persisted.timezone !== "string" ||
    persisted.timezone.trim().length === 0
  ) {
    throw new Error(`Workspace ${workspace.workspaceId} has invalid persisted config`);
  }

  return persisted;
}

function sameWorkspaceConfig(left: WorkspaceConfig, right: WorkspaceConfig): boolean {
  return canonicalJsonValue(left) === canonicalJsonValue(right);
}

async function appendObservationIfNew(
  database: DatabaseQuery,
  observation: MeetingObservation,
  acceptedRevision: number,
  now: () => Date
): Promise<boolean> {
  const inserted = await database.query<ObservationInsertRow>(
    `INSERT INTO meeting_observations (
      workspace_id, meeting_id, observation_id, type, occurred_at, observed_at,
      payload_json, accepted_revision, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (workspace_id, observation_id) DO NOTHING
    RETURNING observation_id`,
    [
      observation.workspaceId,
      observation.meetingId,
      observation.observationId,
      observation.type,
      observation.occurredAt,
      observation.observedAt,
      JSON.stringify(observation),
      acceptedRevision,
      now().toISOString()
    ]
  );

  return inserted.rows.length > 0;
}

type ExistingObservationRow = {
  payload_json: string;
};

async function existingAcceptedObservation(
  database: DatabaseQuery,
  workspaceId: WorkspaceId,
  observation: MeetingObservation
): Promise<"none" | "same" | "different"> {
  const existing = await database.query<ExistingObservationRow>(
    `SELECT payload_json
       FROM meeting_observations
      WHERE workspace_id = $1 AND observation_id = $2
      LIMIT 1`,
    [workspaceId, observation.observationId]
  );
  const row = existing.rows[0];

  if (!row) {
    return "none";
  }

  return canonicalLegacyObservationPayload(parseJson<unknown>(row.payload_json)) ===
    canonicalObservationPayload(observation)
    ? "same"
    : "different";
}

function canonicalObservationPayload(value: unknown): string {
  return canonicalJsonValue(JSON.parse(JSON.stringify(value)));
}

function canonicalLegacyObservationPayload(value: unknown): string {
  return canonicalJsonValue(
    normalizeLegacySourceBoundImplementationReferences(JSON.parse(JSON.stringify(value)))
  );
}

/**
 * LUM-10 added deterministic fields to an otherwise immutable imported-source
 * Observation. A sync may replay the same pre-LUM-10 source revision, so
 * comparison upgrades only genuinely absent fields from its already-persisted
 * source block. Any present (including malformed) value remains observable as
 * a conflict and is never silently repaired.
 */
function normalizeLegacySourceBoundImplementationReferences(value: unknown): unknown {
  if (!isRecord(value) || value["type"] !== "meeting-imported-from-source") {
    return value;
  }

  const source = normalizeLegacyImplementationReferenceSource(value["source"]);
  const providerId = implementationReferenceProviderIdForLegacyPayload(source);
  const candidates = Array.isArray(value["candidates"])
    ? value["candidates"].map((candidate) =>
        normalizeLegacyImplementationReferenceCandidate(candidate, providerId)
      )
    : value["candidates"];

  return {
    ...value,
    source,
    candidates
  };
}

function normalizeLegacyImplementationReferenceSource(value: unknown): unknown {
  if (!isRecord(value) || value["implementationReferenceProviderId"] !== undefined) {
    return value;
  }

  return {
    ...value,
    implementationReferenceProviderId: "github-code"
  };
}

function implementationReferenceProviderIdForLegacyPayload(
  value: unknown
): string | null {
  return isRecord(value) && isNonBlankString(value["implementationReferenceProviderId"])
    ? value["implementationReferenceProviderId"]
    : null;
}

function normalizeLegacyImplementationReferenceCandidate(
  value: unknown,
  rootProviderId: string | null
): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const candidateSource = value["source"];

  if (!isRecord(candidateSource)) {
    return value;
  }

  const nestedSource = normalizeLegacyImplementationReferenceSource(
    candidateSource["source"]
  );
  const providerId =
    implementationReferenceProviderIdForLegacyPayload(nestedSource) ?? rootProviderId;
  const sourceExcerpt = candidateSource["sourceExcerpt"];
  const references =
    value["sourceBoundImplementationReferences"] === undefined &&
    typeof sourceExcerpt === "string" &&
    providerId !== null
      ? mentionedGitHubImplementationReferencesFor(sourceExcerpt, providerId)
      : value["sourceBoundImplementationReferences"];

  return {
    ...value,
    ...(value["sourceBoundImplementationReferences"] === undefined
      ? { sourceBoundImplementationReferences: references }
      : {}),
    source: {
      ...candidateSource,
      source: nestedSource
    }
  };
}

async function verifyImportedSourceObservations(
  observations: MeetingObservation[],
  workspace: WorkspaceConfig,
  verifier: ImportedSourceObservationVerifier
): Promise<ReadonlyMap<MeetingObservation, MeetingIntelligenceError>> {
  const errors = new Map<MeetingObservation, MeetingIntelligenceError>();

  await Promise.all(
    observations.map(async (observation) => {
      if (!isImportedSourceObservationEnvelope(observation)) {
        return;
      }

      const verification = await verifier.verify({ workspace, observation });

      if (verification.status === "verified") {
        return;
      }

      errors.set(
        observation,
        verification.status === "unavailable"
          ? {
              code: "source-verification-unavailable",
              observationId: observation.observationId,
              message: verification.message,
              retryable: true
            }
          : {
              code: "invalid-observation",
              observationId: observation.observationId,
              message: verification.message,
              retryable: false
            }
      );
    })
  );

  return errors;
}

function isObserveMeetingEnvelope(value: unknown): value is ObserveMeeting {
  if (!isRecord(value) || !Array.isArray(value["observations"])) {
    return false;
  }

  const workspace = value["workspace"];
  return (
    isRecord(workspace) &&
    isNonBlankString(workspace["workspaceId"]) &&
    isNonBlankString(workspace["timezone"])
  );
}

function observationEnvelopeError(value: unknown): MeetingIntelligenceError | null {
  const observationId =
    isRecord(value) && isNonBlankString(value["observationId"])
      ? value["observationId"]
      : "invalid-observation";

  if (!isRecord(value)) {
    return invalidObservationEnvelope(observationId, "Observation must be an object");
  }

  if (
    !isNonBlankString(value["type"]) ||
    !isNonBlankString(value["workspaceId"]) ||
    !isNonBlankString(value["meetingId"]) ||
    !isNonBlankString(value["observationId"]) ||
    !isNonBlankString(value["occurredAt"]) ||
    !isNonBlankString(value["observedAt"])
  ) {
    return invalidObservationEnvelope(
      observationId,
      "Observation is missing a required immutable envelope field"
    );
  }

  if (!knownObservationType(value["type"])) {
    return invalidObservationEnvelope(observationId, "Observation type is not supported");
  }

  if (value["type"] === "meeting-imported-from-source") {
    if (!isImportedSourceObservationEnvelope(value)) {
      return invalidObservationEnvelope(
        observationId,
        "Imported source Observation is missing its source manifest"
      );
    }
  }

  return null;
}

function isImportedSourceObservationEnvelope(
  value: unknown
): value is MeetingImportedFromSource {
  if (!isRecord(value) || value["type"] !== "meeting-imported-from-source") {
    return false;
  }

  const source = value["source"];
  return (
    isRecord(source) &&
    source["sourceKind"] === "meeting-note" &&
    isNonBlankString(source["providerId"]) &&
    isNonBlankString(source["sourceObjectId"]) &&
    Array.isArray(value["sourceSections"]) &&
    Array.isArray(value["actionItemBlocks"]) &&
    Array.isArray(value["evidence"]) &&
    Array.isArray(value["candidates"])
  );
}

function knownObservationType(value: string): boolean {
  return [
    "meeting-started",
    "meeting-ended",
    "utterance-committed",
    "utterance-revised",
    "participant-joined",
    "participant-left",
    "agenda-changed",
    "meeting-imported-from-source",
    "human-judgment-recorded",
    "follow-up-intent-approved",
    "follow-up-intent-rejected",
    "follow-up-execution-recorded",
    "external-activity-observed"
  ].includes(value);
}

function observationMeetingId(value: unknown): MeetingId | null {
  return isRecord(value) && isNonBlankString(value["meetingId"])
    ? value["meetingId"]
    : null;
}

function invalidObservationEnvelope(
  observationId: string,
  message: string
): MeetingIntelligenceError {
  return {
    code: "invalid-observation",
    observationId,
    message,
    retryable: false
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalJsonValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonValue).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(record[key])}`)
    .join(",")}}`;
}

async function deleteObservation(
  database: DatabaseQuery,
  observation: MeetingObservation
): Promise<void> {
  await database.query(
    `DELETE FROM meeting_observations
      WHERE workspace_id = $1 AND observation_id = $2`,
    [observation.workspaceId, observation.observationId]
  );
}

async function applyObservation(
  database: DatabaseQuery,
  state: MeetingState,
  observation: MeetingObservation,
  workspaceTimezone: string,
  now: () => Date
): Promise<{
  state: MeetingState;
  evidenceForAnalysis: EvidenceReference[];
  events: MeetingIntelligenceEvent[];
  error?: MeetingIntelligenceError;
}> {
  switch (observation.type) {
    case "meeting-started":
      return {
        state: {
          ...state,
          lifecycle: "live",
          title: observation.title,
          participants: observation.participantIds.map((personId) => ({
            personId,
            joinedAt: observation.startedAt,
            leftAt: null
          })),
          speakerInferredParticipantIds: [],
          lastObservationAt: observation.observedAt
        },
        evidenceForAnalysis: [],
        events: []
      };
    case "meeting-ended":
      return {
        state: {
          ...state,
          lifecycle: "ended",
          lastObservationAt: observation.observedAt
        },
        evidenceForAnalysis: [],
        events: []
      };
    case "participant-joined":
      return {
        state: {
          ...state,
          participants: upsertParticipant(state.participants, observation.participantId, {
            joinedAt: observation.occurredAt,
            leftAt: null
          }),
          speakerInferredParticipantIds: withoutSpeakerInferredParticipantId(
            state,
            observation.participantId
          ),
          lastObservationAt: observation.observedAt
        },
        evidenceForAnalysis: [],
        events: []
      };
    case "participant-left":
      return {
        state: {
          ...state,
          participants: upsertParticipant(state.participants, observation.participantId, {
            joinedAt: null,
            leftAt: observation.occurredAt
          }),
          speakerInferredParticipantIds: withoutSpeakerInferredParticipantId(
            state,
            observation.participantId
          ),
          lastObservationAt: observation.observedAt
        },
        evidenceForAnalysis: [],
        events: []
      };
    case "agenda-changed":
      return {
        state: {
          ...state,
          agenda: observation.agenda,
          lastObservationAt: observation.observedAt
        },
        evidenceForAnalysis: [],
        events: []
      };
    case "meeting-imported-from-source":
      return applyImportedMeetingSource(
        database,
        state,
        observation,
        workspaceTimezone,
        now
      );
    case "utterance-committed": {
      const evidence = evidenceFromUtterance(observation);
      await insertUtteranceVersion(database, observation, evidence, now);
      await insertEvidence(
        database,
        observation.workspaceId,
        observation.meetingId,
        evidence,
        now
      );
      const projected = await projectCurrentSpeakerAttribution(database, state, {
        persistEvidence: true
      });
      return {
        state: {
          ...projected.state,
          lastObservationAt: observation.observedAt
        },
        evidenceForAnalysis: [
          projected.evidenceById.get(evidence.evidenceId) ?? evidence
        ],
        events: []
      };
    }
    case "utterance-revised": {
      const previous = await loadUtteranceVersion(
        database,
        state,
        observation.utteranceId,
        observation.replacesVersion
      );

      if (!previous) {
        return {
          state,
          evidenceForAnalysis: [],
          events: [],
          error: {
            code: "invalid-observation",
            observationId: observation.observationId,
            message: "Utterance revision must replace an existing version",
            retryable: false
          }
        };
      }

      await markUtteranceSuperseded(database, state, observation, now);
      await deactivateEvidence(
        database,
        state.workspaceId,
        state.meetingId,
        evidenceIdForUtterance(observation.utteranceId, observation.replacesVersion)
      );
      const committed: UtteranceCommitted = {
        ...observation,
        type: "utterance-committed",
        // A transcript revision inherits only the prior *source* claim. Any
        // Human correction remains an append-only overlay that the current
        // projection applies afterwards; it must never become purported
        // provider evidence in the new immutable utterance row.
        speaker: speakerAttributionFromStoredUtterance(previous),
        startedAt: previous.started_at,
        endedAt: previous.ended_at
      };
      const evidence = evidenceFromUtterance(committed);
      await insertUtteranceVersion(database, committed, evidence, now);
      await insertEvidence(database, state.workspaceId, state.meetingId, evidence, now);
      const projected = await projectCurrentSpeakerAttribution(
        database,
        removeItemsUsingInactiveEvidence(
          state,
          evidenceIdForUtterance(observation.utteranceId, observation.replacesVersion)
        ),
        { persistEvidence: true }
      );
      return {
        state: {
          ...projected.state,
          lastObservationAt: observation.observedAt
        },
        evidenceForAnalysis: [
          projected.evidenceById.get(evidence.evidenceId) ?? evidence
        ],
        events: []
      };
    }
    case "human-judgment-recorded": {
      if (observation.judgment.kind === "resolve-action-item-reconciliation") {
        return applyActionItemReconciliationHumanJudgment(
          database,
          state,
          observation,
          now
        );
      }
      if (observation.judgment.kind === "resolve-action-item-ownership") {
        return applyActionItemOwnershipHumanJudgment(database, state, observation, now);
      }
      if (observation.judgment.kind === "resolve-speaker-attribution") {
        return applySpeakerAttributionHumanJudgment(database, state, observation, now);
      }
      if (observation.judgment.kind === "refresh-action-item-reconciliation") {
        return {
          state: {
            ...state,
            lastObservationAt: observation.observedAt
          },
          evidenceForAnalysis: [],
          events: []
        };
      }

      const humanEvidence = humanJudgmentEvidenceForMeetingItem(observation);

      if (humanEvidence) {
        await insertEvidence(
          database,
          state.workspaceId,
          state.meetingId,
          humanEvidence,
          now
        );
      }

      return {
        state: applyHumanJudgment(state, observation, humanEvidence),
        evidenceForAnalysis: [],
        events: []
      };
    }
    case "follow-up-intent-approved": {
      const nextState = updateFollowUpIntentStatus(
        state,
        observation.intentId,
        "approved"
      );
      return {
        state: nextState,
        evidenceForAnalysis: [],
        events: [
          {
            type: "follow-up-awaiting-approval",
            intentIds: nextState.followUpIntentions
              .filter((intent) => intent.status === "suggested")
              .map((intent) => intent.id)
          }
        ]
      };
    }
    case "follow-up-intent-rejected":
      return {
        state: updateFollowUpIntentStatus(state, observation.intentId, "rejected"),
        evidenceForAnalysis: [],
        events: []
      };
    case "follow-up-execution-recorded": {
      const executionError = await validateFollowUpExecutionReceipt(
        database,
        state,
        observation
      );

      if (executionError) {
        return { state, evidenceForAnalysis: [], events: [], error: executionError };
      }

      return applyFollowUpExecutionRecorded(state, observation);
    }
    case "external-activity-observed":
      return {
        state: applyExternalActivity(state, observation),
        evidenceForAnalysis: [],
        events: []
      };
  }
}

async function applyImportedMeetingSource(
  database: DatabaseQuery,
  state: MeetingState,
  observation: MeetingImportedFromSource,
  workspaceTimezone: string,
  now: () => Date
): Promise<{
  state: MeetingState;
  evidenceForAnalysis: EvidenceReference[];
  events: MeetingIntelligenceEvent[];
  error?: MeetingIntelligenceError;
}> {
  const validationError = validateImportedMeetingSourceObservation(
    observation,
    workspaceTimezone
  );

  if (validationError) {
    return {
      state,
      evidenceForAnalysis: [],
      events: [],
      error: validationError
    };
  }

  const importedSources = appendSourceIfNew(state.importedSources, observation.source);
  const importedActionItemCandidates = appendCandidatesIfNew(
    state.importedActionItemCandidates,
    observation.candidates
  );
  const currentImportedActionItemCandidateIds = currentCandidateIdsAfterImport(
    state,
    observation,
    importedSources,
    importedActionItemCandidates
  );

  if (
    await activeExecutionWouldBeSuperseded(
      database,
      state,
      currentImportedActionItemCandidateIds
    )
  ) {
    return {
      state,
      evidenceForAnalysis: [],
      events: [],
      error: {
        code: "concurrent-update",
        retryable: true
      }
    };
  }

  for (const evidence of observation.evidence) {
    await insertEvidence(
      database,
      observation.workspaceId,
      observation.meetingId,
      evidence,
      now
    );
  }

  return {
    state: {
      ...state,
      lifecycle: state.lifecycle === "scheduled" ? "imported" : state.lifecycle,
      title: state.title || observation.source.title || "Imported Meeting",
      importedSources,
      importedActionItemCandidates,
      currentImportedActionItemCandidateIds,
      followUpIntentions: invalidateSupersededReconciliationIntents(
        state.followUpIntentions,
        currentImportedActionItemCandidateIds
      ),
      lastObservationAt: observation.observedAt
    },
    evidenceForAnalysis: [],
    events: []
  };
}

async function activeExecutionWouldBeSuperseded(
  database: DatabaseQuery,
  state: MeetingState,
  currentCandidateIds: string[]
): Promise<boolean> {
  const current = new Set(currentCandidateIds);
  const affectedIntentIds = state.followUpIntentions.flatMap((intent) => {
    const binding = reconciliationBindingForIntent(intent);

    return (intent.status === "approved" ||
      (intent.type === "settle-operational-outcome" &&
        (intent.status === "partially-succeeded" ||
          intent.status === "requires-manual-recovery"))) &&
      binding &&
      !current.has(binding.candidateId)
      ? [intent.id]
      : [];
  });

  if (affectedIntentIds.length === 0) {
    return false;
  }

  const active = await database.query<ActiveFollowUpExecutionRow>(
    `SELECT intent_id
       FROM follow_up_executions
      WHERE workspace_id = $1
        AND meeting_id = $2
        AND operation = 'execute'
        AND status = 'executing'`,
    [state.workspaceId, state.meetingId]
  );
  const activeIntentIds = new Set(active.rows.map((row) => row.intent_id));

  return affectedIntentIds.some((intentId) => activeIntentIds.has(intentId));
}

function invalidateSupersededReconciliationIntents(
  intents: FollowUpIntent[],
  currentCandidateIds: string[]
): FollowUpIntent[] {
  const current = new Set(currentCandidateIds);

  return intents.map((intent) => {
    const binding = reconciliationBindingForIntent(intent);

    return (intent.status === "suggested" || intent.status === "approved") &&
      binding &&
      !current.has(binding.candidateId)
      ? { ...intent, status: "invalidated" }
      : intent;
  });
}

async function validateObservationBeforeAcceptance(
  database: DatabaseQuery,
  state: MeetingState,
  workspaceTimezone: string,
  observation: MeetingObservation
): Promise<MeetingIntelligenceError | null> {
  if (observation.type === "utterance-committed") {
    if (observation.speaker.basis === "human-confirmation") {
      return {
        code: "invalid-observation",
        observationId: observation.observationId,
        message:
          "Utterance speaker attribution may not claim Human confirmation; record a resolve-speaker-attribution Human Judgment instead",
        retryable: false
      };
    }

    const speakerError = speakerAttributionValidationError(observation.speaker);

    return speakerError
      ? {
          code: "invalid-observation",
          observationId: observation.observationId,
          message: `Utterance speaker attribution ${speakerError}`,
          retryable: false
        }
      : null;
  }

  if (observation.type === "meeting-imported-from-source") {
    return (
      validateImportedMeetingSourceObservation(observation, workspaceTimezone) ??
      validateImportedMeetingSourceAgainstState(state, observation)
    );
  }

  if (observation.type === "human-judgment-recorded") {
    if (observation.judgment.kind === "resolve-action-item-reconciliation") {
      return validateActionItemReconciliationHumanJudgment(state, observation);
    }

    if (observation.judgment.kind === "resolve-action-item-ownership") {
      return validateActionItemOwnershipHumanJudgment(database, state, observation);
    }

    if (observation.judgment.kind === "resolve-speaker-attribution") {
      return validateSpeakerAttributionHumanJudgment(observation);
    }

    if (observation.judgment.kind === "refresh-action-item-reconciliation") {
      return validateActionItemReconciliationRefresh(state, observation);
    }
  }

  if (observation.type === "follow-up-intent-approved") {
    return validateFollowUpIntentApproval(state, observation);
  }

  if (observation.type === "follow-up-intent-rejected") {
    return validateFollowUpIntentRejection(state, observation);
  }

  return null;
}

function speakerAttributionValidationError(value: unknown): string | null {
  if (!isRecord(value)) {
    return "must be an explicit attribution object";
  }

  const status = value["status"];
  const confidence = value["confidence"];
  const basis = value["basis"];

  if (status === "attributed") {
    const personId = value["personId"];

    if (typeof personId !== "string" || personId.trim().length === 0) {
      return "must name a canonical Person when attributed";
    }

    if (confidence !== "deterministic" && confidence !== "high") {
      return "may be attributed only with deterministic or high confidence";
    }

    return ["provider-identity", "human-confirmation"].includes(String(basis))
      ? null
      : "has an unsupported attributed basis";
  }

  if (status === "unresolved") {
    const candidatePersonId = value["candidatePersonId"];

    if (candidatePersonId !== null && typeof candidatePersonId !== "string") {
      return "has an invalid unresolved candidate Person";
    }

    if (!["medium", "low", "unknown"].includes(String(confidence))) {
      return "has an invalid unresolved confidence";
    }

    return [
      "provider-speaker-label",
      "calendar-context",
      "audio-diarization",
      "contextual-inference",
      "human-confirmation",
      "legacy-unverified"
    ].includes(String(basis))
      ? null
      : "has an unsupported unresolved basis";
  }

  return "has an unsupported status";
}

function validateFollowUpIntentApproval(
  state: MeetingState,
  observation: Extract<MeetingObservation, { type: "follow-up-intent-approved" }>
): MeetingIntelligenceError | null {
  const matchingIntents = state.followUpIntentions.filter(
    (candidate) => candidate.id === observation.intentId
  );
  const intent = matchingIntents[0];

  if (matchingIntents.length > 1) {
    return invalidFollowUpIntentApproval(
      observation,
      "Follow-up Intent ID is ambiguous in canonical Meeting state"
    );
  }

  if (!intent) {
    return invalidFollowUpIntentApproval(
      observation,
      "Follow-up Intent must exist before it can be approved"
    );
  }

  if (intent.type === "update-knowledge") {
    return invalidFollowUpIntentApproval(
      observation,
      "The legacy generic update-knowledge Intent is disabled. Luma will not create or update a Notion document without a Human-selected canonical target, exact region, and conflict policy."
    );
  }

  if (intent.status !== "suggested" && intent.status !== "failed") {
    return invalidFollowUpIntentApproval(
      observation,
      "Follow-up Intent must be suggested or failed before it can be approved"
    );
  }

  if (intent.status === "failed" && reconciliationBindingForIntent(intent)) {
    return invalidFollowUpIntentApproval(
      observation,
      "A failed reconciliation Follow-up Intent requires a fresh Human reconciliation review before it can be approved"
    );
  }

  const binding = reconciliationBindingForIntent(intent);

  if (!binding) {
    return null;
  }

  const review = currentActionItemReconciliationReviews(state).find(
    (current) => current.proposal.id === binding.reviewId
  );

  if (
    !review ||
    review.status !== "human-resolved" ||
    review.proposal.candidateId !== binding.candidateId ||
    review.proposal.candidateLineageKey !== binding.candidateLineageKey ||
    !sameReconciliationIntentOutcome(intent, review.effectiveOutcome)
  ) {
    return invalidFollowUpIntentApproval(
      observation,
      "Follow-up Intent's reconciled source candidate is no longer current"
    );
  }

  return null;
}

function reconciliationBindingForIntent(
  intent: FollowUpIntent
): ActionItemReconciliationIntentBinding | null {
  return intent.type === "settle-operational-outcome" ||
    intent.type === "create-work-item" ||
    intent.type === "update-work-item"
    ? (intent.reconciliation ?? null)
    : null;
}

function sameReconciliationIntentOutcome(
  intent: FollowUpIntent,
  outcome: ActionItemReconciliationOutcome
): boolean {
  if (intent.type === "settle-operational-outcome") {
    return true;
  }

  if (intent.type === "create-work-item") {
    return outcome.type === "create-new";
  }

  return (
    intent.type === "update-work-item" &&
    outcome.type === "update-existing" &&
    intent.externalReference.providerId === outcome.workItem.providerId &&
    intent.externalReference.externalId === outcome.workItem.externalId &&
    (intent.providerObjectId === undefined ||
      intent.providerObjectId === outcome.workItem.lookupId) &&
    intent.externalReference.version === outcome.workItem.updatedAt
  );
}

function invalidFollowUpIntentApproval(
  observation: Extract<MeetingObservation, { type: "follow-up-intent-approved" }>,
  message: string
): MeetingIntelligenceError {
  return {
    code: "invalid-observation",
    observationId: observation.observationId,
    message,
    retryable: false
  };
}

function validateFollowUpIntentRejection(
  state: MeetingState,
  observation: Extract<MeetingObservation, { type: "follow-up-intent-rejected" }>
): MeetingIntelligenceError | null {
  const intent = state.followUpIntentions.find(
    (candidate) => candidate.id === observation.intentId
  );

  if (!intent || (intent.status !== "suggested" && intent.status !== "failed")) {
    return {
      code: "invalid-observation",
      observationId: observation.observationId,
      message: "Follow-up Intent must be suggested or failed before it can be rejected",
      retryable: false
    };
  }

  return null;
}

function validateImportedMeetingSourceObservation(
  observation: MeetingImportedFromSource,
  workspaceTimezone: string
): MeetingIntelligenceError | null {
  if (observation.observationId !== importedSourceObservationId(observation.source)) {
    return invalidImportedSourceObservation(
      observation,
      "Imported source Observation ID does not match its immutable source revision"
    );
  }

  if (
    !Number.isSafeInteger(observation.source.sourceRevision) ||
    observation.source.sourceRevision < 1
  ) {
    return invalidImportedSourceObservation(
      observation,
      "Imported source revision must be a positive integer"
    );
  }

  const sourceReferenceError = validateImportedSourceExternalReference(
    observation.source
  );

  if (sourceReferenceError) {
    return invalidImportedSourceObservation(observation, sourceReferenceError);
  }

  const evidenceById = new Map(
    observation.evidence.map((evidence) => [evidence.evidenceId, evidence])
  );

  if (evidenceById.size !== observation.evidence.length) {
    return invalidImportedSourceObservation(
      observation,
      "Imported source Evidence IDs must be unique"
    );
  }

  if (
    isConfirmedRemovedSource(observation.source) &&
    (observation.source.actionItemsAvailability !== "unavailable" ||
      observation.sourceSections.length > 0 ||
      observation.actionItemBlocks.length > 0 ||
      observation.evidence.length > 0 ||
      observation.candidates.length > 0)
  ) {
    return invalidImportedSourceObservation(
      observation,
      "A confirmed removed source may not carry reusable source material or Action Item candidates"
    );
  }

  const sectionsByName = new Map<
    ImportedMeetingSourceSection["section"],
    ImportedMeetingSourceSection
  >();
  const expectedEvidenceById = new Map<string, EvidenceReference>();

  for (const section of observation.sourceSections) {
    if (
      !isImportedSourceSectionName(section.section) ||
      section.sourceBlockId.length === 0
    ) {
      return invalidImportedSourceObservation(
        observation,
        "Imported source section manifest contains an invalid section or block identity"
      );
    }

    if (sectionsByName.has(section.section)) {
      return invalidImportedSourceObservation(
        observation,
        `Imported source section ${section.section} appears more than once`
      );
    }

    sectionsByName.set(section.section, section);
    const expectedEvidence = importedSourceSectionEvidence(observation.source, section);
    expectedEvidenceById.set(expectedEvidence.evidenceId, expectedEvidence);
  }

  const hasActionItemsSection = sectionsByName.has("action-items-and-notes");

  if (
    observation.source.actionItemsAvailability === "unknown" ||
    (observation.source.actionItemsAvailability === "available") !== hasActionItemsSection
  ) {
    return invalidImportedSourceObservation(
      observation,
      "Imported Action Items availability does not match the source-section manifest"
    );
  }

  if (
    observation.source.actionItemsAvailability === "unavailable" &&
    observation.actionItemBlocks.length > 0
  ) {
    return invalidImportedSourceObservation(
      observation,
      "Unavailable Action Items source content cannot declare Action Item blocks"
    );
  }

  const actionItemBlocksById = new Map<string, ImportedActionItemSourceBlock>();
  const actionItemsSection = sectionsByName.get("action-items-and-notes");

  for (const block of observation.actionItemBlocks) {
    if (
      block.sourceBlockId.trim().length === 0 ||
      typeof block.excerpt !== "string" ||
      (block.completion !== "open" && block.completion !== "completed")
    ) {
      return invalidImportedSourceObservation(
        observation,
        "Imported Action Item block manifest contains invalid source material"
      );
    }

    if (actionItemBlocksById.has(block.sourceBlockId)) {
      return invalidImportedSourceObservation(
        observation,
        `Imported Action Item block ${block.sourceBlockId} appears more than once`
      );
    }

    if (
      actionItemsSection &&
      block.excerpt.trim().length > 0 &&
      !containsWholeSourcePhrase(actionItemsSection.excerpt, block.excerpt)
    ) {
      return invalidImportedSourceObservation(
        observation,
        `Imported Action Item block ${block.sourceBlockId} is not grounded in the Action Items section`
      );
    }

    actionItemBlocksById.set(block.sourceBlockId, block);
  }

  const candidateIds = new Set<string>();
  const candidatesBySourceBlockId = new Map<string, ImportedActionItemCandidate>();

  for (const candidate of observation.candidates) {
    if (candidateIds.has(candidate.id)) {
      return invalidImportedSourceObservation(
        observation,
        `Imported Action Item Candidate ${candidate.id} appears more than once`
      );
    }

    candidateIds.add(candidate.id);

    if (
      !sameImportedMeetingSource(candidate.source.source, observation.source) ||
      candidate.source.source.actionItemsAvailability !==
        observation.source.actionItemsAvailability
    ) {
      return invalidImportedSourceObservation(
        observation,
        `Imported Action Item Candidate ${candidate.id} does not match the observed source identity`
      );
    }

    if (
      candidate.id !==
        importedSourceCandidateId(observation.source, candidate.source.sourceBlockId) ||
      candidate.lineageKey !==
        importedSourceCandidateLineageKey(
          observation.source,
          candidate.source.sourceBlockId
        )
    ) {
      return invalidImportedSourceObservation(
        observation,
        `Imported Action Item Candidate ${candidate.id} does not use its source-derived identity`
      );
    }

    if (
      candidate.originalText !== candidate.source.sourceExcerpt ||
      candidate.description !== candidate.source.sourceExcerpt
    ) {
      return invalidImportedSourceObservation(
        observation,
        `Imported Action Item Candidate ${candidate.id} does not preserve its source wording`
      );
    }

    const semanticsError = validateImportedCandidateSourceSemantics(candidate);

    if (semanticsError) {
      return invalidImportedSourceObservation(
        observation,
        `Imported Action Item Candidate ${candidate.id} ${semanticsError}`
      );
    }

    const deadlineError = validateImportedCandidateDeadline(
      candidate,
      observation.source,
      workspaceTimezone
    );

    if (deadlineError) {
      return invalidImportedSourceObservation(
        observation,
        `Imported Action Item Candidate ${candidate.id} ${deadlineError}`
      );
    }

    const workItemReferenceError = validateImportedCandidateWorkItemReferences(
      candidate,
      observation.source.workItemProviderId
    );

    if (workItemReferenceError) {
      return invalidImportedSourceObservation(
        observation,
        `Imported Action Item Candidate ${candidate.id} ${workItemReferenceError}`
      );
    }

    const implementationReferenceError =
      validateImportedCandidateImplementationReferences(candidate);

    if (implementationReferenceError) {
      return invalidImportedSourceObservation(
        observation,
        `Imported Action Item Candidate ${candidate.id} ${implementationReferenceError}`
      );
    }

    const hintError = validateImportedCandidateHints(candidate);

    if (hintError) {
      return invalidImportedSourceObservation(
        observation,
        `Imported Action Item Candidate ${candidate.id} ${hintError}`
      );
    }

    if (
      candidate.source.sourceSection !== "action-items-and-notes" ||
      candidate.source.sourceBlockId.length === 0
    ) {
      return invalidImportedSourceObservation(
        observation,
        `Imported Action Item Candidate ${candidate.id} has an invalid source block identity`
      );
    }

    if (!sectionsByName.has("action-items-and-notes")) {
      return invalidImportedSourceObservation(
        observation,
        `Imported Action Item Candidate ${candidate.id} has no available Action Items source section`
      );
    }

    const sourceBlock = actionItemBlocksById.get(candidate.source.sourceBlockId);

    if (
      !sourceBlock ||
      sourceBlock.excerpt !== candidate.source.sourceExcerpt ||
      importedActionItemCompletionFor(sourceBlock.excerpt, sourceBlock.completion) !==
        candidate.completion
    ) {
      return invalidImportedSourceObservation(
        observation,
        `Imported Action Item Candidate ${candidate.id} is not bound to its source Action Item block`
      );
    }

    if (candidatesBySourceBlockId.has(candidate.source.sourceBlockId)) {
      return invalidImportedSourceObservation(
        observation,
        `Imported Action Item block ${candidate.source.sourceBlockId} maps to more than one candidate`
      );
    }

    candidatesBySourceBlockId.set(candidate.source.sourceBlockId, candidate);

    if (candidate.evidence.length !== 1) {
      return invalidImportedSourceObservation(
        observation,
        `Imported Action Item Candidate ${candidate.id} must have exactly one source Evidence reference`
      );
    }

    const candidateEvidence = candidate.evidence[0];
    const expectedCandidateEvidence = importedSourceCandidateEvidence(
      observation.source,
      candidate.source
    );

    if (
      !candidateEvidence ||
      !sameEvidenceReference(candidateEvidence, expectedCandidateEvidence)
    ) {
      return invalidImportedSourceObservation(
        observation,
        `Imported Action Item Candidate ${candidate.id} is not bound to its canonical source Evidence`
      );
    }

    expectedEvidenceById.set(
      expectedCandidateEvidence.evidenceId,
      expectedCandidateEvidence
    );
  }

  for (const block of observation.actionItemBlocks) {
    const candidate = candidatesBySourceBlockId.get(block.sourceBlockId);

    if (block.excerpt.trim().length > 0 && !candidate) {
      return invalidImportedSourceObservation(
        observation,
        `Imported Action Item block ${block.sourceBlockId} is missing its source-derived candidate`
      );
    }

    if (block.excerpt.trim().length === 0 && candidate) {
      return invalidImportedSourceObservation(
        observation,
        `Empty Imported Action Item block ${block.sourceBlockId} cannot declare a candidate`
      );
    }
  }

  if (evidenceById.size !== expectedEvidenceById.size) {
    return invalidImportedSourceObservation(
      observation,
      "Imported source Evidence does not exactly match the declared source sections and Action Item blocks"
    );
  }

  for (const [evidenceId, expectedEvidence] of expectedEvidenceById) {
    const observedEvidence = evidenceById.get(evidenceId);

    if (!observedEvidence || !sameEvidenceReference(observedEvidence, expectedEvidence)) {
      return invalidImportedSourceObservation(
        observation,
        `Imported source Evidence ${evidenceId} is not bound to the declared source manifest`
      );
    }
  }

  return null;
}

function validateActionItemReconciliationHumanJudgment(
  state: MeetingState,
  observation: Extract<MeetingObservation, { type: "human-judgment-recorded" }>
): MeetingIntelligenceError | null {
  const judgment = observation.judgment;

  if (judgment.kind !== "resolve-action-item-reconciliation") {
    return null;
  }

  const currentReview = currentActionItemReconciliationReviews(state).find(
    (review) => review.proposal.id === judgment.reviewId
  );

  if (!currentReview) {
    return invalidHumanReconciliationJudgment(
      observation,
      "Human Judgment must target a current Action Item reconciliation proposal"
    );
  }

  if (
    state.actionItemReconciliationHumanResolutions.some(
      (resolution) => resolution.reviewId === judgment.reviewId
    )
  ) {
    return invalidHumanReconciliationJudgment(
      observation,
      "Action Item reconciliation proposal already has Human Judgment"
    );
  }

  const resolvedConflict =
    currentReview.status === "blocked-by-conflict" &&
    currentReview.conflictingCandidateIds
      .map((candidateId) =>
        currentActionItemReconciliationReviews(state).find(
          (review) => review.proposal.candidateId === candidateId
        )
      )
      .find((review) => review?.status === "human-resolved");

  if (resolvedConflict && judgment.resolution.type !== "reject-proposal") {
    return invalidHumanReconciliationJudgment(
      observation,
      "Human Judgment must reject a conflicting proposal before selecting or accepting another work outcome"
    );
  }

  if (
    reconciliationResolutionMutatesCanonicalWork(
      currentReview.proposal,
      judgment.resolution
    ) &&
    !ownershipCanMutateCanonicalWork(currentReview.ownership)
  ) {
    return invalidHumanReconciliationJudgment(
      observation,
      "A proposed Action Item owner must be confirmed or explicitly left unassigned before Human Judgment can authorize a canonical work mutation"
    );
  }

  switch (judgment.resolution.type) {
    case "accept-proposal":
      if (currentReview.proposal.outcome.type === "needs-clarification") {
        return invalidHumanReconciliationJudgment(
          observation,
          "Human Judgment must select an explicit outcome for a clarification proposal"
        );
      }

      return validateReconciliationIntentIdAvailability(
        state,
        observation,
        currentReview.proposal
      );
    case "reject-proposal":
      return validateReconciliationIntentIdAvailability(
        state,
        observation,
        currentReview.proposal
      );
    case "select-existing": {
      const selected = reconciliationWorkItemFromReview(
        currentReview.proposal,
        judgment.resolution.providerId,
        judgment.resolution.externalId
      );

      if (!selected) {
        return invalidHumanReconciliationJudgment(
          observation,
          "Human Judgment may only select work items hydrated in the reconciliation proposal"
        );
      }

      if (
        judgment.resolution.action === "update-existing" &&
        currentReview.proposal.outcome.type !== "update-existing"
      ) {
        return invalidHumanReconciliationJudgment(
          observation,
          "This Work Catalog cannot safely execute a conditional update; keep the source-derived change as a manual tracker review"
        );
      }

      return validateReconciliationIntentIdAvailability(
        state,
        observation,
        currentReview.proposal
      );
    }
    case "select-create-new": {
      if (!completedZeroResultSearch(currentReview.proposal)) {
        return invalidHumanReconciliationJudgment(
          observation,
          "Human Judgment may only select new work after a completed zero-result canonical search"
        );
      }

      return validateReconciliationIntentIdAvailability(
        state,
        observation,
        currentReview.proposal
      );
    }
    case "select-needs-clarification":
      return validateReconciliationIntentIdAvailability(
        state,
        observation,
        currentReview.proposal
      );
  }
}

function reconciliationResolutionMutatesCanonicalWork(
  review: ActionItemReconciliationReview,
  resolution: ActionItemReconciliationResolution
): boolean {
  switch (resolution.type) {
    case "accept-proposal":
      return (
        review.outcome.type === "create-new" || review.outcome.type === "update-existing"
      );
    case "select-create-new":
      return true;
    case "select-existing":
      return resolution.action === "update-existing";
    case "reject-proposal":
    case "select-needs-clarification":
      return false;
  }
}

async function validateActionItemOwnershipHumanJudgment(
  database: DatabaseQuery,
  state: MeetingState,
  observation: Extract<MeetingObservation, { type: "human-judgment-recorded" }>
): Promise<MeetingIntelligenceError | null> {
  const judgment = observation.judgment;

  if (judgment.kind !== "resolve-action-item-ownership") {
    return null;
  }

  const candidate = state.importedActionItemCandidates.find(
    (value) =>
      value.id !== "" &&
      state.currentImportedActionItemCandidateIds.includes(value.id) &&
      actionItemOwnershipClaimId(value) === judgment.claimId
  );

  if (!candidate) {
    return invalidHumanReconciliationJudgment(
      observation,
      "Human ownership Judgment must target one current source-backed ownership claim"
    );
  }

  const activeSettlement = state.followUpIntentions.some((intent) => {
    const binding = reconciliationBindingForIntent(intent);

    return (
      binding?.candidateId === candidate.id &&
      (intent.status === "executing" || intent.status === "partially-succeeded")
    );
  });

  if (activeSettlement) {
    return invalidHumanReconciliationJudgment(
      observation,
      "Human ownership Judgment cannot supersede a candidate while its canonical settlement is executing"
    );
  }

  // Meeting-state Intent status is only updated when Follow-up Execution
  // records its receipt. The durable reservation is therefore the authority
  // while a settlement is between canonical preflight and a provider call.
  // This query follows the same Meeting-row → execution-row lock order as
  // Follow-up Execution's claim, so a correction either sees the active
  // reservation or commits before a future claim can use the old review.
  const activeExecutions = await database.query<{ intent_id: string }>(
    `SELECT intent_id
       FROM follow_up_executions
      WHERE workspace_id = $1
        AND meeting_id = $2
        AND operation = 'execute'
        AND status IN ('executing', 'receipt-recorded')
      FOR UPDATE`,
    [state.workspaceId, state.meetingId]
  );
  const activeExecutionIntentIds = new Set(
    activeExecutions.rows.map((execution) => execution.intent_id)
  );
  const activeReconciliationExecution = state.followUpIntentions.some((intent) => {
    const binding = reconciliationBindingForIntent(intent);

    return (
      binding?.candidateId === candidate.id && activeExecutionIntentIds.has(intent.id)
    );
  });

  if (activeReconciliationExecution) {
    return invalidHumanReconciliationJudgment(
      observation,
      "Human ownership Judgment cannot supersede a candidate while its canonical settlement holds an active execution reservation"
    );
  }

  if (
    judgment.resolution.type === "confirm-owner" &&
    judgment.resolution.ownerPersonId.trim().length === 0
  ) {
    return invalidHumanReconciliationJudgment(
      observation,
      "Human ownership confirmation must name one canonical Person"
    );
  }

  return null;
}

function validateSpeakerAttributionHumanJudgment(
  observation: Extract<MeetingObservation, { type: "human-judgment-recorded" }>
): MeetingIntelligenceError | null {
  const judgment = observation.judgment;

  if (judgment.kind !== "resolve-speaker-attribution") {
    return null;
  }

  if (
    typeof judgment.utteranceId !== "string" ||
    judgment.utteranceId.trim().length === 0 ||
    !Number.isSafeInteger(judgment.version) ||
    judgment.version < 1
  ) {
    return {
      code: "invalid-observation",
      observationId: observation.observationId,
      message: "Human speaker attribution must target one versioned utterance",
      retryable: false
    };
  }

  if (
    judgment.personId !== null &&
    (typeof judgment.personId !== "string" || judgment.personId.trim().length === 0)
  ) {
    return {
      code: "invalid-observation",
      observationId: observation.observationId,
      message:
        "Human speaker attribution must name a canonical Person or explicitly remain unresolved",
      retryable: false
    };
  }

  return null;
}

function validateReconciliationIntentIdAvailability(
  state: MeetingState,
  observation: Extract<MeetingObservation, { type: "human-judgment-recorded" }>,
  review: ActionItemReconciliationReview
): MeetingIntelligenceError | null {
  const intentId = `follow-up-intent:reconciliation:${opaqueIdentifierSegment(review.id)}:settle`;

  return state.followUpIntentions.some((intent) => intent.id === intentId)
    ? invalidHumanReconciliationJudgment(
        observation,
        "A Follow-up Intent already uses this reconciliation proposal identity"
      )
    : null;
}

function validateActionItemReconciliationRefresh(
  state: MeetingState,
  observation: Extract<MeetingObservation, { type: "human-judgment-recorded" }>
): MeetingIntelligenceError | null {
  const judgment = observation.judgment;

  if (judgment.kind !== "refresh-action-item-reconciliation") {
    return null;
  }

  const currentReview = currentActionItemReconciliationReviews(state).find(
    (review) => review.proposal.id === judgment.reviewId
  );

  if (!currentReview) {
    return invalidHumanReconciliationJudgment(
      observation,
      "A reconciliation refresh must target a current proposal"
    );
  }

  if (
    currentReview.status === "proposed" &&
    currentReview.proposal.retryable &&
    hasFailedCatalogRead(currentReview.proposal)
  ) {
    return null;
  }

  if (currentReview.status !== "human-resolved") {
    return invalidHumanReconciliationJudgment(
      observation,
      "A reconciliation refresh must target a retryable catalog failure or a current Human-resolved proposal"
    );
  }

  const refreshableIntent = state.followUpIntentions.find((intent) => {
    const binding = reconciliationBindingForIntent(intent);

    return (
      (intent.status === "failed" || intent.status === "requires-manual-recovery") &&
      binding?.reviewId === judgment.reviewId &&
      binding.candidateId === currentReview.proposal.candidateId
    );
  });

  if (!refreshableIntent) {
    return invalidHumanReconciliationJudgment(
      observation,
      "A reconciliation refresh requires a failed or manually recoverable canonical Follow-up Intent"
    );
  }

  return null;
}

function invalidHumanReconciliationJudgment(
  observation: Extract<MeetingObservation, { type: "human-judgment-recorded" }>,
  message: string
): MeetingIntelligenceError {
  return {
    code: "invalid-observation",
    observationId: observation.observationId,
    message,
    retryable: false
  };
}

function reconciliationWorkItemFromReview(
  review: ActionItemReconciliationReview,
  providerId: string,
  externalId: string
): ReconciliationWorkItemSnapshot | null {
  return (
    review.searches
      .flatMap((search) => search.workItems)
      .find(
        (workItem) =>
          workItem.providerId === providerId && workItem.externalId === externalId
      ) ?? null
  );
}

function completedZeroResultSearch(review: ActionItemReconciliationReview): boolean {
  return (
    review.searches.length > 0 &&
    review.searches.every(
      (search) => search.status === "completed" && search.workItems.length === 0
    )
  );
}

function validateImportedCandidateDeadline(
  candidate: ImportedActionItemCandidate,
  source: ImportedMeetingSource,
  workspaceTimezone: string
): string | null {
  const deadline = candidate.deadline;

  if (!deadline || typeof deadline !== "object") {
    return "has no valid deadline metadata";
  }

  if (deadline.timezone !== workspaceTimezone) {
    return "uses a deadline timezone that does not match the workspace";
  }

  const expected = importedActionItemDeadlineFor(
    candidate.source.sourceExcerpt,
    workspaceTimezone,
    source.deadlineReferenceAt
  );

  if (
    deadline.originalPhrase !== expected.originalPhrase ||
    deadline.normalizedDate !== expected.normalizedDate ||
    deadline.confidence !== expected.confidence
  ) {
    return "has deadline metadata that does not match its source wording and source reference time";
  }

  if (deadline.normalizedDate !== null && !isValidCalendarDate(deadline.normalizedDate)) {
    return "has an invalid normalized deadline date";
  }

  return null;
}

function validateImportedSourceExternalReference(
  source: ImportedMeetingSource
): string | null {
  const reference = source.externalReference;
  const expectedExternalId = source.parentObjectId ?? source.sourceObjectId;
  const expectedVersion = source.providerVersion ?? source.contentHash;

  if (source.sourceKind !== "meeting-note") {
    return "Imported source kind must be meeting-note";
  }

  if (
    !reference ||
    reference.providerId !== source.providerId ||
    reference.objectType !== "document" ||
    reference.externalId !== expectedExternalId ||
    reference.version !== expectedVersion ||
    typeof reference.url !== "string" ||
    reference.url.trim().length === 0
  ) {
    return "Imported source external reference is not bound to its source identity";
  }

  if (
    typeof source.workItemProviderId !== "string" ||
    source.workItemProviderId.trim().length === 0
  ) {
    return "Imported source does not declare a WorkProvider identity";
  }

  if (
    typeof source.implementationReferenceProviderId !== "string" ||
    source.implementationReferenceProviderId.trim().length === 0
  ) {
    return "Imported source does not declare an implementation reference provider identity";
  }

  if (
    source.deadlineReferenceAt !== null &&
    !isOffsetBearingInstant(source.deadlineReferenceAt)
  ) {
    return "Imported source has an invalid deadline reference time";
  }

  return null;
}

function validateImportedCandidateSourceSemantics(
  candidate: ImportedActionItemCandidate
): string | null {
  const excerpt = candidate.source.sourceExcerpt;
  const expectedLanguage = importedActionItemLanguageFor(excerpt);
  const expectedModality = importedActionItemModalityFor(excerpt);
  const expectedSourceOwner = importedActionItemSourceOwnerFor(excerpt);
  const expectedOwnership = importedActionItemOwnershipFor(excerpt);

  if (candidate.language !== expectedLanguage) {
    return "has language metadata that does not match its source wording";
  }

  if (
    candidate.modality.kind !== expectedModality.kind ||
    candidate.modality.sourceForm !== expectedModality.sourceForm
  ) {
    return "has modality metadata that does not match its source wording";
  }

  if (
    candidate.sourceOwner.state !== expectedSourceOwner.state ||
    candidate.sourceOwner.sourceText !== expectedSourceOwner.sourceText
  ) {
    return "has source owner wording that does not match its source wording";
  }

  if (!sameActionItemOwnership(candidate.ownership, expectedOwnership)) {
    return "has ownership attribution that is more certain than its source wording";
  }

  return null;
}

function isValidCalendarDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);

  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function validateImportedCandidateWorkItemReferences(
  candidate: ImportedActionItemCandidate,
  workItemProviderId: string
): string | null {
  const references = candidate.mentionedWorkItemReferences;

  if (!Array.isArray(references)) {
    return "has invalid mentioned work-item references";
  }

  const expectedExternalIds = mentionedWorkItemExternalIdsFor(
    candidate.source.sourceExcerpt
  );
  const expectedReferences = expectedExternalIds.map((externalId) => ({
    providerId: workItemProviderId,
    objectType: "work-item" as const,
    externalId
  }));

  const normalizedReferences = references
    .map((reference) => {
      if (
        !reference ||
        typeof reference !== "object" ||
        typeof reference.providerId !== "string" ||
        reference.providerId.trim().length === 0 ||
        reference.objectType !== "work-item" ||
        typeof reference.externalId !== "string" ||
        reference.externalId.trim().length === 0
      ) {
        return null;
      }

      return {
        providerId: reference.providerId,
        objectType: reference.objectType,
        externalId: reference.externalId
      };
    })
    .sort((left, right) => {
      if (!left || !right) {
        return left ? -1 : right ? 1 : 0;
      }

      return (
        left.providerId.localeCompare(right.providerId) ||
        left.externalId.localeCompare(right.externalId)
      );
    });

  if (normalizedReferences.some((reference) => reference === null)) {
    return "has invalid mentioned work-item references";
  }

  if (
    normalizedReferences.some(
      (reference) =>
        reference !== null && !expectedExternalIds.includes(reference.externalId)
    )
  ) {
    return "has a mentioned work-item reference that does not occur in its source excerpt";
  }

  if (normalizedReferences.length !== expectedReferences.length) {
    return "does not declare exactly the work-item references present in its source excerpt";
  }

  for (const [index, reference] of normalizedReferences.entries()) {
    const expected = expectedReferences[index];

    if (
      !reference ||
      !expected ||
      reference.providerId !== expected.providerId ||
      reference.objectType !== expected.objectType ||
      reference.externalId !== expected.externalId
    ) {
      return "does not declare exactly the work-item references present in its source excerpt";
    }
  }

  return null;
}

function validateImportedCandidateImplementationReferences(
  candidate: ImportedActionItemCandidate
): string | null {
  const references = candidate.sourceBoundImplementationReferences;

  if (!Array.isArray(references)) {
    return "has invalid source-bound GitHub implementation references";
  }

  const expected = mentionedGitHubImplementationReferencesFor(
    candidate.source.sourceExcerpt,
    candidate.source.source.implementationReferenceProviderId
  );
  const normalized = references
    .map((reference) => {
      if (
        !reference ||
        typeof reference !== "object" ||
        typeof reference.providerId !== "string" ||
        reference.providerId.trim().length === 0 ||
        (reference.objectType !== "pull-request" && reference.objectType !== "commit") ||
        typeof reference.externalId !== "string" ||
        reference.externalId.trim().length === 0 ||
        typeof reference.url !== "string" ||
        reference.url.trim().length === 0
      ) {
        return null;
      }

      return {
        providerId: reference.providerId,
        objectType: reference.objectType,
        externalId: reference.externalId,
        url: reference.url
      };
    })
    .sort((left, right) => {
      if (!left || !right) {
        return left ? -1 : right ? 1 : 0;
      }

      return (
        compareImportedImplementationReference(left.externalId, right.externalId) ||
        compareImportedImplementationReference(left.objectType, right.objectType)
      );
    });

  if (normalized.some((reference) => reference === null)) {
    return "has invalid source-bound GitHub implementation references";
  }

  if (normalized.length !== expected.length) {
    return "does not declare exactly the GitHub implementation references present in its source excerpt";
  }

  for (const [index, reference] of normalized.entries()) {
    const expectedReference = expected[index];

    if (
      !reference ||
      !expectedReference ||
      reference.providerId !== expectedReference.providerId ||
      reference.objectType !== expectedReference.objectType ||
      reference.externalId !== expectedReference.externalId ||
      reference.url !== expectedReference.url
    ) {
      return "does not declare exactly the GitHub implementation references present in its source excerpt";
    }
  }

  return null;
}

function compareImportedImplementationReference(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateImportedCandidateHints(
  candidate: ImportedActionItemCandidate
): string | null {
  for (const [kind, hints] of [
    ["project", candidate.projectHints],
    ["component", candidate.componentHints]
  ] as const) {
    if (!Array.isArray(hints)) {
      return `has invalid ${kind} hints`;
    }

    const normalizedHints = new Set<string>();

    for (const hint of hints) {
      if (typeof hint !== "string" || hint.trim().length === 0) {
        return `has invalid ${kind} hints`;
      }

      const normalizedHint = normalizeComparisonText(hint);

      if (normalizedHints.has(normalizedHint)) {
        return `mentions the same ${kind} hint more than once`;
      }

      if (!containsWholeSourcePhrase(candidate.source.sourceExcerpt, hint)) {
        return `has a ${kind} hint that does not occur in its source excerpt`;
      }

      normalizedHints.add(normalizedHint);
    }
  }

  return null;
}

function containsWholeSourcePhrase(text: string, phrase: string): boolean {
  const normalizedText = normalizeComparisonText(text);
  const normalizedPhrase = normalizeComparisonText(phrase);
  let start = normalizedText.indexOf(normalizedPhrase);

  while (start >= 0) {
    const before = start === 0 ? null : (normalizedText[start - 1] ?? null);
    const end = start + normalizedPhrase.length;
    const after = end === normalizedText.length ? null : (normalizedText[end] ?? null);

    if (!isOpaqueIdentifierCharacter(before) && !isOpaqueIdentifierCharacter(after)) {
      return true;
    }

    start = normalizedText.indexOf(normalizedPhrase, start + normalizedPhrase.length);
  }

  return false;
}

function isOpaqueIdentifierCharacter(value: string | null): boolean {
  return value !== null && /[\p{L}\p{N}_-]/u.test(value);
}

function validateImportedMeetingSourceAgainstState(
  state: MeetingState,
  observation: MeetingImportedFromSource
): MeetingIntelligenceError | null {
  const existingSourceRevision = state.importedSources.find(
    (source) =>
      source.providerId === observation.source.providerId &&
      source.sourceObjectId === observation.source.sourceObjectId &&
      source.sourceRevision === observation.source.sourceRevision
  );

  if (existingSourceRevision) {
    if (sameImportedMeetingSource(existingSourceRevision, observation.source)) {
      return null;
    }

    return invalidImportedSourceObservation(
      observation,
      "Imported source revision conflicts with the immutable source history"
    );
  }

  const existingCandidatesById = new Map(
    state.importedActionItemCandidates.map((candidate) => [candidate.id, candidate])
  );

  for (const candidate of observation.candidates) {
    if (existingCandidatesById.has(candidate.id)) {
      return invalidImportedSourceObservation(
        observation,
        `Imported Action Item Candidate ${candidate.id} conflicts with an accepted candidate`
      );
    }
  }

  return null;
}

function isImportedSourceSectionName(
  value: unknown
): value is ImportedMeetingSourceSection["section"] {
  return (
    value === "summary" || value === "action-items-and-notes" || value === "transcript"
  );
}

function invalidImportedSourceObservation(
  observation: MeetingImportedFromSource,
  message: string
): MeetingIntelligenceError {
  return {
    code: "invalid-observation",
    observationId: observation.observationId,
    message,
    retryable: false
  };
}

function sameImportedMeetingSource(
  left: ImportedMeetingSource,
  right: ImportedMeetingSource
): boolean {
  return (
    left.providerId === right.providerId &&
    left.sourceKind === right.sourceKind &&
    left.sourceObjectId === right.sourceObjectId &&
    left.parentObjectId === right.parentObjectId &&
    left.sourceRevision === right.sourceRevision &&
    left.contentHash === right.contentHash &&
    left.providerVersion === right.providerVersion &&
    left.title === right.title &&
    left.workItemProviderId === right.workItemProviderId &&
    left.implementationReferenceProviderId === right.implementationReferenceProviderId &&
    left.deadlineReferenceAt === right.deadlineReferenceAt &&
    left.completeness === right.completeness &&
    sameActionItemsAvailability(
      left.actionItemsAvailability,
      right.actionItemsAvailability
    ) &&
    left.capturedAt === right.capturedAt &&
    sameExternalReference(left.externalReference, right.externalReference) &&
    sameCompletenessReasons(left.completenessReasons, right.completenessReasons)
  );
}

function sameActionItemsAvailability(
  left: ImportedMeetingSource["actionItemsAvailability"],
  right: ImportedMeetingSource["actionItemsAvailability"]
): boolean {
  return left === right || left === "unknown" || right === "unknown";
}

function sameCompletenessReasons(
  left: ImportedMeetingSource["completenessReasons"],
  right: ImportedMeetingSource["completenessReasons"]
): boolean {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];

  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every(
      (reason, index) =>
        reason.code === normalizedRight[index]?.code &&
        reason.message === normalizedRight[index]?.message &&
        reason.sourceBlockId === normalizedRight[index]?.sourceBlockId
    )
  );
}

function sameEvidenceReference(
  left: EvidenceReference,
  right: EvidenceReference
): boolean {
  return (
    left.evidenceId === right.evidenceId &&
    left.source === right.source &&
    left.sourceObjectId === right.sourceObjectId &&
    left.participantId === right.participantId &&
    left.sourceVersion === right.sourceVersion &&
    left.excerpt === right.excerpt &&
    left.startedAtMs === right.startedAtMs &&
    left.endedAtMs === right.endedAtMs &&
    sameOptionalExternalReference(left.externalReference, right.externalReference)
  );
}

function sameOptionalExternalReference(
  left: ExternalReference | undefined,
  right: ExternalReference | undefined
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : sameExternalReference(left, right);
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

function appendSourceIfNew(
  current: ImportedMeetingSource[],
  next: ImportedMeetingSource
): ImportedMeetingSource[] {
  const identity = importedSourceRevisionKey(next);

  if (current.some((source) => importedSourceRevisionKey(source) === identity)) {
    return current;
  }

  return [...current, next];
}

function upgradeLegacyImportedSourceAvailability(
  state: MeetingState,
  observation: MeetingObservation
): MeetingState | null {
  if (observation.type !== "meeting-imported-from-source") {
    return null;
  }

  const sourceKey = importedSourceRevisionKey(observation.source);
  const legacySource = state.importedSources.find(
    (source) => importedSourceRevisionKey(source) === sourceKey
  );

  if (
    !legacySource ||
    legacySource.actionItemsAvailability !== "unknown" ||
    observation.source.actionItemsAvailability === "unknown" ||
    !sameImportedMeetingSource(legacySource, observation.source)
  ) {
    return null;
  }

  const importedSources = state.importedSources.map((source) =>
    importedSourceRevisionKey(source) === sourceKey ? observation.source : source
  );
  const importedActionItemCandidates = state.importedActionItemCandidates.map(
    (candidate) =>
      importedSourceRevisionKey(candidate.source.source) === sourceKey
        ? {
            ...candidate,
            source: {
              ...candidate.source,
              source: observation.source
            }
          }
        : candidate
  );
  const upgradedState = {
    ...state,
    importedSources,
    importedActionItemCandidates
  };

  return {
    ...upgradedState,
    currentImportedActionItemCandidateIds: currentCandidateIdsAfterImport(
      upgradedState,
      observation,
      importedSources,
      importedActionItemCandidates
    )
  };
}

function appendCandidatesIfNew(
  current: ImportedActionItemCandidate[],
  next: ImportedActionItemCandidate[]
): ImportedActionItemCandidate[] {
  const byId = new Map(current.map((candidate) => [candidate.id, candidate]));

  for (const candidate of next) {
    if (!byId.has(candidate.id)) {
      byId.set(candidate.id, candidate);
    }
  }

  return [...byId.values()];
}

function currentCandidateIdsAfterImport(
  state: MeetingState,
  observation: MeetingImportedFromSource,
  importedSources: ImportedMeetingSource[],
  importedCandidates: ImportedActionItemCandidate[]
): string[] {
  const currentIds =
    state.currentImportedActionItemCandidateIds ??
    state.importedActionItemCandidates.map((candidate) => candidate.id);
  const byId = new Map(importedCandidates.map((candidate) => [candidate.id, candidate]));
  const currentIdsForObservedSource = currentIds.filter((candidateId) => {
    const candidate = byId.get(candidateId);

    return (
      candidate?.source.source.providerId === observation.source.providerId &&
      candidate.source.source.sourceObjectId === observation.source.sourceObjectId
    );
  });
  const currentIdsFromOtherSources = currentIds.filter(
    (candidateId) => !currentIdsForObservedSource.includes(candidateId)
  );
  const sourceRevisions = knownImportedSourceRevisions(
    importedSources,
    importedCandidates
  )
    .filter(
      (source) =>
        source.providerId === observation.source.providerId &&
        source.sourceObjectId === observation.source.sourceObjectId
    )
    .sort((left, right) => right.sourceRevision - left.sourceRevision);
  const selectedSource = latestEligibleCandidateSource(
    sourceRevisions,
    importedCandidates
  );

  if (!selectedSource) {
    // A confirmed removal is a boundary: an unavailable source read after it
    // cannot silently resurrect candidates from before the root was removed.
    if (sourceRevisions.some(isConfirmedRemovedSource)) {
      return currentIdsFromOtherSources;
    }

    return [...currentIdsFromOtherSources, ...currentIdsForObservedSource];
  }

  const currentIdsFromSelectedSource = importedCandidates
    .filter(
      (candidate) =>
        candidate.source.source.providerId === selectedSource.providerId &&
        candidate.source.source.sourceObjectId === selectedSource.sourceObjectId &&
        candidate.source.source.sourceRevision === selectedSource.sourceRevision
    )
    .map((candidate) => candidate.id);

  return [...currentIdsFromOtherSources, ...currentIdsFromSelectedSource];
}

/**
 * Serializes every state-changing Meeting transaction, including the first
 * Observation for a Meeting that does not yet have a `meetings` row. Holding
 * the lock row before `SELECT … FOR UPDATE` makes the state read, revision
 * check, and eventual upsert one atomic ownership interval on PostgreSQL as
 * well as the current PGlite runtime.
 */
async function loadMeetingStateForMutation(
  database: DatabaseQuery,
  workspaceId: WorkspaceId,
  meetingId: MeetingId
): Promise<MeetingState> {
  await database.query(
    `INSERT INTO meeting_state_locks (workspace_id, meeting_id)
     VALUES ($1, $2)
     ON CONFLICT (workspace_id, meeting_id)
     DO UPDATE SET meeting_id = EXCLUDED.meeting_id`,
    [workspaceId, meetingId]
  );
  const rows = await database.query<MeetingRow>(
    `SELECT state_json
       FROM meetings
      WHERE workspace_id = $1 AND meeting_id = $2
      FOR UPDATE`,
    [workspaceId, meetingId]
  );
  const row = rows.rows[0];

  if (!row) {
    return createInitialMeetingState(workspaceId, meetingId);
  }

  return (
    await projectCurrentSpeakerAttribution(
      database,
      normalizeMeetingState(parseJson<MeetingState>(row.state_json))
    )
  ).state;
}

async function requireMeetingState(
  database: LumaDatabase,
  workspaceId: WorkspaceId,
  meetingId: MeetingId
): Promise<MeetingState> {
  const rows = await database.query<MeetingRow>(
    `SELECT state_json FROM meetings WHERE workspace_id = $1 AND meeting_id = $2`,
    [workspaceId, meetingId]
  );
  const row = rows.rows[0];

  if (!row) {
    throw new Error("meeting-not-found");
  }

  return (
    await projectCurrentSpeakerAttribution(
      database,
      normalizeMeetingState(parseJson<MeetingState>(row.state_json))
    )
  ).state;
}

async function saveMeetingState(
  database: DatabaseQuery,
  state: MeetingState,
  reason: string,
  now: () => Date
): Promise<void> {
  const timestamp = now().toISOString();
  await database.query(
    `INSERT INTO meetings (
      workspace_id, meeting_id, revision, state_json, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (workspace_id, meeting_id)
    DO UPDATE SET revision = EXCLUDED.revision, state_json = EXCLUDED.state_json, updated_at = EXCLUDED.updated_at`,
    [
      state.workspaceId,
      state.meetingId,
      state.revision,
      JSON.stringify(state),
      timestamp,
      timestamp
    ]
  );
  await database.query(
    `INSERT INTO meeting_revisions (
      workspace_id, meeting_id, revision, state_json, reason, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (workspace_id, meeting_id, revision) DO NOTHING`,
    [
      state.workspaceId,
      state.meetingId,
      state.revision,
      JSON.stringify(state),
      reason,
      timestamp
    ]
  );
}

function createInitialMeetingState(
  workspaceId: WorkspaceId,
  meetingId: MeetingId
): MeetingState {
  return {
    workspaceId,
    meetingId,
    revision: 0,
    lifecycle: "scheduled",
    title: "",
    participants: [],
    agenda: [],
    currentTopicId: null,
    topics: [],
    proposals: [],
    decisions: [],
    actionItems: [],
    openQuestions: [],
    risks: [],
    humanJudgmentItemIds: [],
    followUpIntentions: [],
    importedSources: [],
    importedActionItemCandidates: [],
    currentImportedActionItemCandidateIds: [],
    actionItemReconciliationReviews: [],
    actionItemReconciliationHumanResolutions: [],
    actionItemOwnershipHumanResolutions: [],
    speakerAttributionHumanResolutions: [],
    speakerInferredParticipantIds: [],
    actionItemReconciliationCreatedWorkMappings: [],
    lastObservationAt: "",
    lastAnalyzedAt: null
  };
}

function normalizeMeetingState(state: MeetingState): MeetingState {
  const importedSources = (state.importedSources ?? []).map(
    normalizeImportedMeetingSource
  );
  const sourceByRevision = new Map(
    importedSources.map((source) => [importedSourceRevisionKey(source), source])
  );
  const importedActionItemCandidates = (state.importedActionItemCandidates ?? []).map(
    (candidate) =>
      normalizeImportedActionItemCandidate(
        candidate,
        sourceByRevision.get(importedSourceRevisionKey(candidate.source.source))
      )
  );
  const actionItems = state.actionItems.map(normalizeActionItemOwnership);

  return {
    ...state,
    humanJudgmentItemIds: Array.from(
      new Set(
        (state.humanJudgmentItemIds ?? []).filter(
          (meetingItemId): meetingItemId is string =>
            typeof meetingItemId === "string" && meetingItemId.length > 0
        )
      )
    ),
    importedSources,
    importedActionItemCandidates,
    actionItems,
    actionItemReconciliationReviews: normalizeActionItemReconciliationReviews(
      state.actionItemReconciliationReviews ?? []
    ),
    actionItemReconciliationHumanResolutions:
      state.actionItemReconciliationHumanResolutions ?? [],
    actionItemOwnershipHumanResolutions: state.actionItemOwnershipHumanResolutions ?? [],
    speakerAttributionHumanResolutions: state.speakerAttributionHumanResolutions ?? [],
    speakerInferredParticipantIds: Array.from(
      new Set(
        (state.speakerInferredParticipantIds ?? []).filter(
          (personId): personId is string =>
            typeof personId === "string" && personId.length > 0
        )
      )
    ),
    actionItemReconciliationCreatedWorkMappings:
      state.actionItemReconciliationCreatedWorkMappings ?? [],
    currentImportedActionItemCandidateIds:
      state.currentImportedActionItemCandidateIds ??
      deriveCurrentImportedActionItemCandidateIds(
        importedSources,
        importedActionItemCandidates
      )
  };
}

function normalizeActionItemOwnership(item: ActionItem): ActionItem {
  const ownership = item.ownership ?? ownershipForLegacyActionItem(item.ownerId);

  return {
    ...item,
    ownership,
    ownerId: ownership.status === "confirmed" ? ownership.ownerPersonId : null
  };
}

function ownershipForLegacyActionItem(
  ownerId: string | null
): ActionItemOwnershipAttribution {
  return ownerId
    ? {
        status: "proposed",
        proposedOwnerPersonId: ownerId,
        confidence: "low",
        basis: "inferred-assignment"
      }
    : {
        status: "unresolved",
        reason: "no-owner-stated",
        likelyOwnerPersonId: null
      };
}

function actionItemOwnership(item: ActionItem): ActionItemOwnershipAttribution {
  return item.ownership ?? ownershipForLegacyActionItem(item.ownerId);
}

function ownershipForHumanActionItemCorrection(
  current: ActionItemOwnershipAttribution,
  correctedOwnerId: string | null | undefined
): ActionItemOwnershipAttribution {
  if (correctedOwnerId === undefined) {
    return current;
  }

  return correctedOwnerId === null
    ? {
        status: "intentionally-unassigned",
        basis: "human-confirmation"
      }
    : {
        status: "confirmed",
        ownerPersonId: correctedOwnerId,
        confidence: "deterministic",
        basis: "human-confirmation"
      };
}

function ownerIdForHumanActionItemCorrection(
  current: ActionItemOwnershipAttribution,
  correctedOwnerId: string | null | undefined
): string | null {
  const ownership = ownershipForHumanActionItemCorrection(current, correctedOwnerId);
  return ownership.status === "confirmed" ? ownership.ownerPersonId : null;
}

function normalizeActionItemReconciliationReviews(
  reviews: ActionItemReconciliationReview[]
): ActionItemReconciliationReview[] {
  const nextAttemptByCandidateAndCatalog = new Map<string, number>();

  return reviews.map((review) => {
    const candidate = normalizeImportedActionItemCandidate(review.candidate, undefined);
    const catalogProviderId =
      review.catalogProviderId ??
      review.searches[0]?.providerId ??
      outcomeWorkItem(review.outcome)?.providerId ??
      "unconfigured";
    const key = `${review.candidateId}:${catalogProviderId}:${review.policyVersion ?? RECONCILIATION_POLICY_VERSION}`;
    const inferredAttempt = (nextAttemptByCandidateAndCatalog.get(key) ?? 0) + 1;
    const attempt =
      Number.isSafeInteger(review.attempt) && review.attempt > 0
        ? review.attempt
        : inferredAttempt;

    nextAttemptByCandidateAndCatalog.set(
      key,
      Math.max(nextAttemptByCandidateAndCatalog.get(key) ?? 0, attempt)
    );

    return {
      ...review,
      candidate,
      ownership: review.ownership ?? candidate.ownership,
      policyVersion: review.policyVersion ?? RECONCILIATION_POLICY_VERSION,
      attempt,
      trigger: review.trigger ?? "initial-source-import",
      retryable:
        review.retryable ??
        review.searches.some(
          (search) => search.status === "failed" || search.status === "not-configured"
        ),
      automaticRetryNotBefore:
        review.automaticRetryNotBefore ??
        (hasFailedCatalogRead(review) ? review.reviewedAt : null),
      catalogProviderId
    };
  });
}

function deriveCurrentImportedActionItemCandidateIds(
  importedSources: ImportedMeetingSource[],
  importedCandidates: ImportedActionItemCandidate[]
): string[] {
  const knownSources = knownImportedSourceRevisions(importedSources, importedCandidates);

  const sourceIdentities = [
    ...new Set(knownSources.map((source) => importedSourceIdentityKey(source)))
  ].sort();

  return sourceIdentities.flatMap((identity) => {
    const sourceRevisions = knownSources.filter(
      (source) => importedSourceIdentityKey(source) === identity
    );
    const selectedSource = latestEligibleCandidateSource(
      sourceRevisions,
      importedCandidates
    );

    if (!selectedSource) {
      return [];
    }

    return importedCandidates
      .filter(
        (candidate) =>
          importedSourceRevisionKey(candidate.source.source) ===
          importedSourceRevisionKey(selectedSource)
      )
      .map((candidate) => candidate.id);
  });
}

function knownImportedSourceRevisions(
  importedSources: ImportedMeetingSource[],
  importedCandidates: ImportedActionItemCandidate[]
): ImportedMeetingSource[] {
  const sourcesByRevision = new Map(
    importedSources.map((source) => [importedSourceRevisionKey(source), source])
  );

  for (const candidate of importedCandidates) {
    const source = candidate.source.source;
    const key = importedSourceRevisionKey(source);

    if (!sourcesByRevision.has(key)) {
      sourcesByRevision.set(key, source);
    }
  }

  return [...sourcesByRevision.values()];
}

function latestEligibleCandidateSource(
  sourceRevisions: ImportedMeetingSource[],
  importedCandidates: ImportedActionItemCandidate[]
): ImportedMeetingSource | undefined {
  const newestFirst = [...sourceRevisions].sort(
    (left, right) => right.sourceRevision - left.sourceRevision
  );
  const latestRemovalIndex = newestFirst.findIndex(isConfirmedRemovedSource);
  // An absence conclusion invalidates all earlier material. Only a later,
  // readable source revision may establish current candidates again.
  const revisionsAfterLatestRemoval =
    latestRemovalIndex === -1 ? newestFirst : newestFirst.slice(0, latestRemovalIndex);

  return revisionsAfterLatestRemoval.filter(
    (source) =>
      source.actionItemsAvailability === "available" ||
      (source.actionItemsAvailability === "unknown" &&
        importedCandidates.some(
          (candidate) =>
            importedSourceRevisionKey(candidate.source.source) ===
            importedSourceRevisionKey(source)
        ))
  )[0];
}

function isConfirmedRemovedSource(source: ImportedMeetingSource): boolean {
  return source.completeness === "removed";
}

function normalizeImportedMeetingSource(
  source: ImportedMeetingSource
): ImportedMeetingSource {
  return {
    ...source,
    completenessReasons: source.completenessReasons ?? [],
    actionItemsAvailability: source.actionItemsAvailability ?? "unknown",
    workItemProviderId: source.workItemProviderId ?? "linear",
    implementationReferenceProviderId:
      source.implementationReferenceProviderId ?? "github-code",
    deadlineReferenceAt: source.deadlineReferenceAt ?? null
  };
}

function normalizeImportedActionItemCandidate(
  candidate: ImportedActionItemCandidate,
  source: ImportedMeetingSource | undefined
): ImportedActionItemCandidate {
  const wasLegacyCompleted = isLegacyCompletedModality(candidate.modality);
  const completion =
    candidate.completion === "completed" || candidate.completion === "open"
      ? candidate.completion
      : wasLegacyCompleted
        ? "completed"
        : "open";

  const legacyOwner = (candidate as unknown as Record<string, unknown>)["owner"];
  const sourceOwner =
    candidate.sourceOwner ??
    normalizeLegacyImportedActionItemSourceOwner(legacyOwner) ??
    importedActionItemSourceOwnerFor(candidate.source.sourceExcerpt);
  const normalizedSource =
    source ?? normalizeImportedMeetingSource(candidate.source.source);

  return {
    ...candidate,
    completion,
    sourceOwner,
    ownership:
      candidate.ownership ??
      importedActionItemOwnershipFor(candidate.source.sourceExcerpt),
    projectHints: Array.isArray(candidate.projectHints) ? candidate.projectHints : [],
    componentHints: Array.isArray(candidate.componentHints)
      ? candidate.componentHints
      : [],
    mentionedWorkItemReferences: normalizeImportedWorkItemReferences(candidate),
    sourceBoundImplementationReferences: normalizeImportedImplementationReferences(
      candidate,
      normalizedSource.implementationReferenceProviderId
    ),
    modality: wasLegacyCompleted
      ? { kind: "unknown", sourceForm: candidate.modality.sourceForm ?? null }
      : candidate.modality,
    source: {
      ...candidate.source,
      source: normalizedSource
    }
  };
}

function normalizeLegacyImportedActionItemSourceOwner(
  value: unknown
): ImportedActionItemCandidate["sourceOwner"] | null {
  if (!isRecord(value)) {
    return null;
  }

  const state = value["state"];
  const sourceText = value["sourceText"];

  if (state === "unmapped" && typeof sourceText === "string") {
    return { state, sourceText };
  }

  if (state === "ambiguous" && typeof sourceText === "string") {
    return { state, sourceText };
  }

  if (state === "unspecified" && sourceText === null) {
    return { state, sourceText };
  }

  // Old persisted "known" values were source labels, not proof of a Person.
  // Preserve their wording only as an unmapped source claim.
  if (state === "known" && typeof sourceText === "string") {
    return { state: "unmapped", sourceText };
  }

  return null;
}

function normalizeImportedWorkItemReferences(
  candidate: ImportedActionItemCandidate
): ImportedActionItemCandidate["mentionedWorkItemReferences"] {
  if (Array.isArray(candidate.mentionedWorkItemReferences)) {
    return candidate.mentionedWorkItemReferences;
  }

  const legacyIds: unknown = Reflect.get(candidate, "mentionedWorkItemIds");

  if (!Array.isArray(legacyIds)) {
    return [];
  }

  return legacyIds.flatMap((externalId) =>
    typeof externalId === "string" && externalId.trim().length > 0
      ? [
          {
            providerId: "linear",
            objectType: "work-item" as const,
            externalId
          }
        ]
      : []
  );
}

function normalizeImportedImplementationReferences(
  candidate: ImportedActionItemCandidate,
  providerId: string
): ImportedActionItemCandidate["sourceBoundImplementationReferences"] {
  return Array.isArray(candidate.sourceBoundImplementationReferences)
    ? candidate.sourceBoundImplementationReferences
    : mentionedGitHubImplementationReferencesFor(
        candidate.source.sourceExcerpt,
        providerId
      );
}

function isLegacyCompletedModality(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "completed"
  );
}

function importedSourceRevisionKey(source: ImportedMeetingSource): string {
  return `${importedSourceIdentityKey(source)}:r${source.sourceRevision}`;
}

function importedSourceIdentityKey(source: ImportedMeetingSource): string {
  return `${opaqueIdentifierSegment(source.providerId)}:${opaqueIdentifierSegment(source.sourceObjectId)}`;
}

function advanceRevision(state: MeetingState, observedAt: string): MeetingState {
  return {
    ...state,
    revision: state.revision + 1,
    lastObservationAt: observedAt
  };
}

function reconcileAnalysis(
  state: MeetingState,
  allowedEvidence: EvidenceReference[],
  analysis: StructuredReasoningResult<MeetingAnalysisProposalBatch>
): MeetingState {
  const evidenceById = new Map(
    allowedEvidence.map((evidence) => [evidence.evidenceId, evidence])
  );

  return {
    ...state,
    decisions: reconcileDecisions(
      state,
      analysis.value.decisions,
      evidenceById,
      analysis
    ),
    actionItems: reconcileActionItems(
      state,
      analysis.value.actionItems,
      evidenceById,
      analysis
    ),
    openQuestions: reconcileOpenQuestions(
      state,
      analysis.value.openQuestions,
      evidenceById,
      analysis
    ),
    risks: reconcileRisks(state, analysis.value.risks, evidenceById, analysis),
    followUpIntentions: reconcileFollowUpIntentions(
      state.followUpIntentions,
      analysis.value.followUpIntentions,
      evidenceById,
      state.revision,
      analysis
    )
  };
}

async function persistRebasedAnalysis(
  database: LumaDatabase,
  workspaceId: WorkspaceId,
  meetingId: MeetingId,
  evidence: EvidenceReference[],
  analysis: StructuredReasoningResult<MeetingAnalysisProposalBatch>,
  expectedRevision: number,
  now: () => Date
): Promise<{ state: MeetingState; applied: boolean }> {
  return database.transaction(async (transaction) => {
    const latest = await loadMeetingStateForMutation(transaction, workspaceId, meetingId);

    if (latest.revision !== expectedRevision) {
      return { state: latest, applied: false };
    }

    const timestamp = now().toISOString();
    const next = {
      ...advanceRevision(reconcileAnalysis(latest, evidence, analysis), timestamp),
      lastAnalyzedAt: timestamp
    };

    await saveMeetingState(transaction, next, "analysis-reconciled", now);
    return { state: next, applied: true };
  });
}

function reconcileActionItems(
  state: MeetingState,
  proposals: ActionItemProposal[],
  evidenceById: Map<string, EvidenceReference>,
  analysis: StructuredReasoningResult<MeetingAnalysisProposalBatch>
): ActionItem[] {
  const existingById = new Map(state.actionItems.map((item) => [item.id, item]));

  for (const proposal of proposals) {
    const id = actionItemId(proposal.stableKey);
    const existing = existingById.get(id);

    // A Human-confirmed or corrected item is canonical until another Human
    // Judgment changes it. New AI evidence can create other items, but it
    // must not silently replace the Human's representation of this one.
    if (existing && state.humanJudgmentItemIds.includes(id)) {
      continue;
    }

    const provenance = provenanceFromEvidenceIds(
      proposal.evidenceIds,
      evidenceById,
      state.revision,
      proposal.confidence,
      analysis
    );
    const ownership = ownershipForActionItemProposal(proposal, provenance.evidence);
    existingById.set(id, {
      id,
      description: proposal.description,
      ownership,
      ownerId: ownership.status === "confirmed" ? ownership.ownerPersonId : null,
      dueDate: proposal.dueDate.normalizedDate,
      dueDateConfidence: proposal.dueDate.confidence,
      status: existing?.status === "cancelled" ? existing.status : proposal.status,
      relatedDecisionIds: proposal.relatedDecisionIds,
      externalReferences: existing?.externalReferences ?? [],
      provenance
    });
  }

  return [...existingById.values()];
}

/**
 * A model-supplied Person ID is a proposal, never a fact. The one automatic
 * confirmation allowed here is a directly cited, deterministic speaker making
 * a first-person commitment in the source itself.
 */
function ownershipForActionItemProposal(
  proposal: ActionItemProposal,
  evidence: EvidenceReference[]
): ActionItemOwnershipAttribution {
  const speakerOwnership = speakerSelfCommitmentOwnership(evidence);

  if (speakerOwnership) {
    return speakerOwnership;
  }

  return proposal.ownerId
    ? {
        status: "proposed",
        proposedOwnerPersonId: proposal.ownerId,
        confidence: "low",
        basis: "inferred-assignment"
      }
    : {
        status: "unresolved",
        reason: "no-owner-stated",
        likelyOwnerPersonId: null
      };
}

function refreshedActionItemOwnership(
  item: ActionItem,
  evidence: EvidenceReference[]
): ActionItemOwnershipAttribution {
  const current = actionItemOwnership(item);

  if (current.status === "confirmed" && current.basis === "human-confirmation") {
    return current;
  }

  if (current.status === "intentionally-unassigned") {
    return current;
  }

  const speakerOwnership = speakerSelfCommitmentOwnership(evidence);

  if (speakerOwnership) {
    return speakerOwnership;
  }

  if (current.status === "confirmed" && current.basis === "self-commitment") {
    return {
      status: "unresolved",
      reason: "missing-speaker",
      likelyOwnerPersonId: null
    };
  }

  return current;
}

function speakerSelfCommitmentOwnership(
  evidence: EvidenceReference[]
): ActionItemOwnershipAttribution | null {
  const selfCommittedSpeakers = Array.from(
    new Set(
      evidence.flatMap((reference) =>
        reference.source === "transcript" &&
        reference.participantId &&
        isSpeakerSelfCommitment(reference.excerpt)
          ? [reference.participantId]
          : []
      )
    )
  );

  if (selfCommittedSpeakers.length === 1) {
    const ownerPersonId = selfCommittedSpeakers[0];

    return ownerPersonId
      ? {
          status: "confirmed",
          ownerPersonId,
          confidence: "deterministic",
          basis: "self-commitment"
        }
      : null;
  }

  return selfCommittedSpeakers.length > 1
    ? {
        status: "unresolved",
        reason: "conflicting-speaker",
        likelyOwnerPersonId: null
      }
    : null;
}

// The acknowledgement separator admits either a comma with optional
// surrounding whitespace, whitespace alone, or no separator. Keeping those
// alternatives disjoint avoids polynomial backtracking on a rejected source
// utterance with a long whitespace run.
const SPEAKER_SELF_COMMITMENT =
  /\b(?:ich\s+(?:mache|übernehme|kümmere\s+mich|bearbeite|werde\s+(?:das\s+)?(?:machen|übernehmen))|(?:das\s+)?(?:mache|übernehme)\s+ich|ja(?:\s*,\s*|\s+)?(?:mache|übernehme)\s+ich|i(?:\s+will|'ll)\s+(?:do|take|handle|own|prepare))\b/iu;

function isSpeakerSelfCommitment(text: string | undefined): boolean {
  if (!text) {
    return false;
  }

  const normalized = text.trim();

  // A question, refusal, or merely stated capability is not an accepted
  // commitment. Failing closed here is preferable to turning one ambiguous
  // sentence into a durable owner assertion.
  if (
    normalized.endsWith("?") ||
    commitmentDispositionFor(normalized) !== "affirmative"
  ) {
    return false;
  }

  return SPEAKER_SELF_COMMITMENT.test(normalized);
}

function reconcileDecisions(
  state: MeetingState,
  proposals: DecisionProposal[],
  evidenceById: Map<string, EvidenceReference>,
  analysis: StructuredReasoningResult<MeetingAnalysisProposalBatch>
): Decision[] {
  const existingById = new Map(
    state.decisions.map((decision) => [decision.id, decision])
  );

  for (const proposal of proposals) {
    const id = decisionId(proposal.stableKey);
    const existing = existingById.get(id);

    if (existing && state.humanJudgmentItemIds.includes(id)) {
      continue;
    }

    existingById.set(id, {
      id,
      statement: proposal.statement,
      rationale: proposal.rationale,
      status: existing?.status === "rejected" ? "rejected" : proposal.status,
      supersedesDecisionId: existing?.supersedesDecisionId ?? null,
      supersededByDecisionId: existing?.supersededByDecisionId ?? null,
      supportingParticipantIds: proposal.supportingParticipantIds,
      objectingParticipantIds: proposal.objectingParticipantIds,
      relatedTopicIds: proposal.relatedTopicIds,
      provenance: provenanceFromEvidenceIds(
        proposal.evidenceIds,
        evidenceById,
        state.revision,
        proposal.confidence,
        analysis
      )
    });
  }

  return [...existingById.values()];
}

function reconcileOpenQuestions(
  state: MeetingState,
  proposals: OpenQuestionProposal[],
  evidenceById: Map<string, EvidenceReference>,
  analysis: StructuredReasoningResult<MeetingAnalysisProposalBatch>
): OpenQuestion[] {
  const existingById = new Map(
    state.openQuestions.map((question) => [question.id, question])
  );

  for (const proposal of proposals) {
    const id = openQuestionId(proposal.stableKey);
    existingById.set(id, {
      id,
      question: proposal.question,
      raisedBy: proposal.raisedBy,
      status: existingById.get(id)?.status ?? "open",
      possibleAnswers: existingById.get(id)?.possibleAnswers ?? [],
      provenance: provenanceFromEvidenceIds(
        proposal.evidenceIds,
        evidenceById,
        state.revision,
        proposal.confidence,
        analysis
      )
    });
  }

  return [...existingById.values()];
}

function reconcileRisks(
  state: MeetingState,
  proposals: RiskProposal[],
  evidenceById: Map<string, EvidenceReference>,
  analysis: StructuredReasoningResult<MeetingAnalysisProposalBatch>
): Risk[] {
  const existingById = new Map(state.risks.map((risk) => [risk.id, risk]));

  for (const proposal of proposals) {
    const id = riskId(proposal.stableKey);
    existingById.set(id, {
      id,
      statement: proposal.statement,
      severity: proposal.severity,
      mitigation: proposal.mitigation,
      provenance: provenanceFromEvidenceIds(
        proposal.evidenceIds,
        evidenceById,
        state.revision,
        proposal.confidence,
        analysis
      )
    });
  }

  return [...existingById.values()];
}

function provenanceFromEvidenceIds(
  evidenceIds: string[],
  evidenceById: Map<string, EvidenceReference>,
  producedAtRevision: number,
  confidence: Provenance["confidence"],
  analysis: StructuredReasoningResult<MeetingAnalysisProposalBatch>
): Provenance {
  const evidence = evidenceIds.map((evidenceId) => {
    const reference = evidenceById.get(evidenceId);

    if (!reference) {
      throw new Error(`unknown evidence id from model: ${evidenceId}`);
    }

    return reference;
  });

  if (evidence.length === 0) {
    throw new Error("factual proposal requires evidence");
  }

  return {
    evidence,
    confidence,
    producedAtRevision,
    analysisVersion: ANALYSIS_VERSION,
    modelMetadata: analysis.metadata
  };
}

function combineProvenance(state: MeetingState, revision: number): Provenance {
  const evidence = [
    ...state.decisions.flatMap((decision) => decision.provenance.evidence),
    ...state.actionItems.flatMap((item) => item.provenance.evidence),
    ...state.openQuestions.flatMap((question) => question.provenance.evidence),
    ...state.risks.flatMap((risk) => risk.provenance.evidence)
  ];

  return {
    evidence,
    confidence: evidence.length > 0 ? "high" : "low",
    producedAtRevision: revision,
    analysisVersion: ANALYSIS_VERSION
  };
}

function evidenceFromUtterance(observation: UtteranceCommitted): EvidenceReference {
  const deterministicSpeakerPersonId = deterministicallyAttributedSpeakerPersonId(
    observation.speaker
  );

  return {
    evidenceId: evidenceIdForUtterance(observation.utteranceId, observation.version),
    source: "transcript",
    sourceObjectId: observation.utteranceId,
    ...(deterministicSpeakerPersonId
      ? { participantId: deterministicSpeakerPersonId }
      : {}),
    sourceVersion: String(observation.version),
    excerpt: observation.originalText
  };
}

function evidenceIdForUtterance(utteranceId: string, version: number): string {
  return `evidence:transcript:${utteranceId}:v${version}`;
}

function withoutSpeakerInferredParticipantId(
  state: MeetingState,
  personId: string
): string[] {
  return (state.speakerInferredParticipantIds ?? []).filter(
    (candidate) => candidate !== personId
  );
}

function legacyUnverifiedSpeakerAttribution(): SpeakerAttribution {
  return {
    status: "unresolved",
    candidatePersonId: null,
    confidence: "unknown",
    basis: "legacy-unverified"
  };
}

/**
 * `EvidenceReference.participantId` is a factual projection used by
 * participant queries and self-commitment ownership. Keep a high-confidence
 * speaker claim in the immutable utterance record, but do not silently
 * strengthen it into that deterministic projection.
 */
function deterministicallyAttributedSpeakerPersonId(
  speaker: SpeakerAttribution
): string | null {
  return speaker.status === "attributed" && speaker.confidence === "deterministic"
    ? speaker.personId
    : null;
}

function speakerAttributionFromStoredUtterance(
  row: UtteranceVersionRow
): SpeakerAttribution {
  if (!row.speaker_attribution_json) {
    return legacyUnverifiedSpeakerAttribution();
  }

  try {
    const parsed: unknown = JSON.parse(row.speaker_attribution_json);
    const error = speakerAttributionValidationError(parsed);

    if (error) {
      return legacyUnverifiedSpeakerAttribution();
    }

    return parsed as SpeakerAttribution;
  } catch {
    return legacyUnverifiedSpeakerAttribution();
  }
}

/**
 * Human speaker resolutions are append-only overlays. They never rewrite the
 * captured source attribution, but a correction for an utterance carries
 * forward when that same utterance receives a later transcript revision.
 */
function effectiveSpeakerAttributionForUtterance(
  state: MeetingState,
  utteranceId: string,
  version: number,
  sourceAttribution: SpeakerAttribution
): SpeakerAttribution {
  const resolution = state.speakerAttributionHumanResolutions
    .filter(
      (candidate) => candidate.utteranceId === utteranceId && candidate.version <= version
    )
    .sort(
      (left, right) =>
        right.version - left.version ||
        right.resolvedAt.localeCompare(left.resolvedAt) ||
        right.id.localeCompare(left.id)
    )[0];

  return resolution?.speaker ?? sourceAttribution;
}

/**
 * Rebuild the current speaker-derived projection from immutable utterance
 * records plus Human attribution overlays. Source utterance rows stay
 * untouched; only the current derived Evidence and Meeting State view change.
 *
 * This is also the legacy safety boundary: a historic bare `speaker_id` is
 * intentionally treated as unresolved rather than re-exposed as a Person.
 */
async function projectCurrentSpeakerAttribution(
  database: DatabaseQuery,
  state: MeetingState,
  options: { persistEvidence?: boolean } = {}
): Promise<SpeakerAttributionProjection> {
  const rows = await database.query<ActiveUtteranceVersionRow>(
    `SELECT utterance_id, version, speaker_id, speaker_attribution_json,
            started_at, ended_at, evidence_id, original_text
       FROM utterance_versions
      WHERE workspace_id = $1
        AND meeting_id = $2
        AND superseded_by_version IS NULL
      ORDER BY utterance_id ASC, version ASC`,
    [state.workspaceId, state.meetingId]
  );
  const evidenceById = new Map<string, EvidenceReference>();
  const activeTranscriptEvidence: EvidenceReference[] = [];
  const activeSpeakerIds = new Set<string>();

  for (const row of rows.rows) {
    const speaker = effectiveSpeakerAttributionForUtterance(
      state,
      row.utterance_id,
      row.version,
      speakerAttributionFromStoredUtterance(row)
    );
    const deterministicSpeakerPersonId =
      deterministicallyAttributedSpeakerPersonId(speaker);
    const evidence: EvidenceReference = {
      evidenceId: row.evidence_id,
      source: "transcript",
      sourceObjectId: row.utterance_id,
      ...(deterministicSpeakerPersonId
        ? { participantId: deterministicSpeakerPersonId }
        : {}),
      sourceVersion: String(row.version),
      excerpt: row.original_text
    };

    evidenceById.set(evidence.evidenceId, evidence);
    activeTranscriptEvidence.push(evidence);

    if (deterministicSpeakerPersonId) {
      activeSpeakerIds.add(deterministicSpeakerPersonId);
    }

    if (options.persistEvidence) {
      // Deliberately do not upsert here: a re-projection must never reactivate
      // superseded transcript Evidence. This only refreshes a known active row.
      await database.query(
        `UPDATE evidence
            SET source = $4,
                source_object_id = $5,
                source_version = $6,
                excerpt = $7,
                reference_json = $8
          WHERE workspace_id = $1
            AND meeting_id = $2
            AND evidence_id = $3
            AND active = TRUE`,
        [
          state.workspaceId,
          state.meetingId,
          evidence.evidenceId,
          evidence.source,
          evidence.sourceObjectId,
          evidence.sourceVersion ?? null,
          evidence.excerpt ?? null,
          JSON.stringify(evidence)
        ]
      );
    }
  }

  const directlyObservedParticipantIds = new Set(
    state.participants
      .filter(
        (participant) => participant.joinedAt !== null || participant.leftAt !== null
      )
      .map((participant) => participant.personId)
  );
  const retainedParticipants = state.participants.filter(
    (participant) =>
      directlyObservedParticipantIds.has(participant.personId) ||
      activeSpeakerIds.has(participant.personId)
  );
  const participants = [...retainedParticipants];

  for (const personId of activeSpeakerIds) {
    if (!participants.some((participant) => participant.personId === personId)) {
      participants.push({ personId, joinedAt: null, leftAt: null });
    }
  }

  return {
    state: replaceEvidenceReferencesInState(
      {
        ...state,
        participants,
        speakerInferredParticipantIds: [...activeSpeakerIds].filter(
          (personId) => !directlyObservedParticipantIds.has(personId)
        )
      },
      evidenceById
    ),
    evidenceById,
    activeTranscriptEvidence
  };
}

function replaceEvidenceReferencesInState(
  state: MeetingState,
  replacements: ReadonlyMap<string, EvidenceReference>
): MeetingState {
  if (replacements.size === 0) {
    return state;
  }

  const replaceReference = (reference: EvidenceReference): EvidenceReference =>
    replacements.get(reference.evidenceId) ?? reference;
  const replaceProvenance = (provenance: Provenance): Provenance => ({
    ...provenance,
    evidence: provenance.evidence.map(replaceReference)
  });
  const replaceCandidate = (
    candidate: ImportedActionItemCandidate
  ): ImportedActionItemCandidate => ({
    ...candidate,
    evidence: candidate.evidence.map(replaceReference)
  });

  return {
    ...state,
    topics: state.topics.map((topic) => ({
      ...topic,
      provenance: replaceProvenance(topic.provenance)
    })),
    proposals: state.proposals.map((proposal) => ({
      ...proposal,
      provenance: replaceProvenance(proposal.provenance)
    })),
    decisions: state.decisions.map((decision) => ({
      ...decision,
      provenance: replaceProvenance(decision.provenance)
    })),
    actionItems: state.actionItems.map((item) => {
      const provenance = replaceProvenance(item.provenance);
      const ownership = refreshedActionItemOwnership(item, provenance.evidence);

      return {
        ...item,
        ownership,
        ownerId: ownership.status === "confirmed" ? ownership.ownerPersonId : null,
        provenance
      };
    }),
    openQuestions: state.openQuestions.map((question) => ({
      ...question,
      provenance: replaceProvenance(question.provenance)
    })),
    risks: state.risks.map((risk) => ({
      ...risk,
      provenance: replaceProvenance(risk.provenance)
    })),
    followUpIntentions: state.followUpIntentions.map((intent) => ({
      ...intent,
      provenance: replaceProvenance(intent.provenance)
    })),
    importedActionItemCandidates:
      state.importedActionItemCandidates.map(replaceCandidate),
    actionItemReconciliationReviews: state.actionItemReconciliationReviews.map(
      (review) => ({
        ...review,
        candidate: replaceCandidate(review.candidate),
        evidence: review.evidence.map(replaceReference)
      })
    ),
    actionItemReconciliationHumanResolutions:
      state.actionItemReconciliationHumanResolutions.map((resolution) => ({
        ...resolution,
        evidence: replaceReference(resolution.evidence)
      })),
    actionItemOwnershipHumanResolutions: state.actionItemOwnershipHumanResolutions.map(
      (resolution) => ({
        ...resolution,
        evidence: replaceReference(resolution.evidence)
      })
    ),
    speakerAttributionHumanResolutions: state.speakerAttributionHumanResolutions.map(
      (resolution) => ({
        ...resolution,
        evidence: replaceReference(resolution.evidence)
      })
    )
  };
}

async function insertEvidence(
  database: DatabaseQuery,
  workspaceId: WorkspaceId,
  meetingId: MeetingId,
  evidence: EvidenceReference,
  now: () => Date
): Promise<void> {
  await database.query(
    `INSERT INTO evidence (
      workspace_id, meeting_id, evidence_id, source, source_object_id, source_version,
      excerpt, active, reference_json, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $9)
    ON CONFLICT (workspace_id, meeting_id, evidence_id)
    DO UPDATE SET active = TRUE, reference_json = EXCLUDED.reference_json`,
    [
      workspaceId,
      meetingId,
      evidence.evidenceId,
      evidence.source,
      evidence.sourceObjectId,
      evidence.sourceVersion ?? null,
      evidence.excerpt ?? null,
      JSON.stringify(evidence),
      now().toISOString()
    ]
  );
}

async function insertUtteranceVersion(
  database: DatabaseQuery,
  observation: UtteranceCommitted,
  evidence: EvidenceReference,
  now: () => Date
): Promise<void> {
  await database.query(
    `INSERT INTO utterance_versions (
      workspace_id, meeting_id, utterance_id, version, speaker_id,
      speaker_attribution_json, started_at, ended_at, original_text, language,
      evidence_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (workspace_id, meeting_id, utterance_id, version) DO NOTHING`,
    [
      observation.workspaceId,
      observation.meetingId,
      observation.utteranceId,
      observation.version,
      observation.speaker.status === "attributed" ? observation.speaker.personId : null,
      JSON.stringify(observation.speaker),
      observation.startedAt,
      observation.endedAt,
      observation.originalText,
      observation.language,
      evidence.evidenceId,
      now().toISOString()
    ]
  );
}

async function loadUtteranceVersion(
  database: DatabaseQuery,
  state: MeetingState,
  utteranceId: string,
  version: number
): Promise<UtteranceVersionRow | null> {
  const result = await database.query<UtteranceVersionRow>(
    `SELECT speaker_id, speaker_attribution_json, started_at, ended_at
     FROM utterance_versions
     WHERE workspace_id = $1 AND meeting_id = $2 AND utterance_id = $3 AND version = $4`,
    [state.workspaceId, state.meetingId, utteranceId, version]
  );

  return result.rows[0] ?? null;
}

async function markUtteranceSuperseded(
  database: DatabaseQuery,
  state: MeetingState,
  observation: UtteranceRevised,
  now: () => Date
): Promise<void> {
  await database.query(
    `UPDATE utterance_versions
     SET superseded_by_version = $1, created_at = created_at
     WHERE workspace_id = $2 AND meeting_id = $3 AND utterance_id = $4 AND version = $5`,
    [
      observation.version,
      state.workspaceId,
      state.meetingId,
      observation.utteranceId,
      observation.replacesVersion
    ]
  );
  now();
}

async function deactivateEvidence(
  database: DatabaseQuery,
  workspaceId: WorkspaceId,
  meetingId: MeetingId,
  evidenceId: string
): Promise<void> {
  await database.query(
    `UPDATE evidence
     SET active = FALSE
     WHERE workspace_id = $1 AND meeting_id = $2 AND evidence_id = $3`,
    [workspaceId, meetingId, evidenceId]
  );
}

function removeItemsUsingInactiveEvidence(
  state: MeetingState,
  evidenceId: string
): MeetingState {
  const humanProtectedItemIds = new Set(state.humanJudgmentItemIds);
  const doesNotUseEvidence = (provenance: Provenance): boolean =>
    provenance.evidence.every((evidence) => evidence.evidenceId !== evidenceId);
  const withoutInactiveEvidence = (provenance: Provenance): Provenance => ({
    ...provenance,
    evidence: provenance.evidence.filter(
      (reference) => reference.evidenceId !== evidenceId
    )
  });

  return {
    ...state,
    decisions: state.decisions.flatMap((decision) =>
      humanProtectedItemIds.has(decision.id)
        ? [{ ...decision, provenance: withoutInactiveEvidence(decision.provenance) }]
        : doesNotUseEvidence(decision.provenance)
          ? [decision]
          : []
    ),
    actionItems: state.actionItems.flatMap((item) =>
      humanProtectedItemIds.has(item.id)
        ? [{ ...item, provenance: withoutInactiveEvidence(item.provenance) }]
        : doesNotUseEvidence(item.provenance)
          ? [item]
          : []
    ),
    openQuestions: state.openQuestions.filter((question) =>
      doesNotUseEvidence(question.provenance)
    ),
    risks: state.risks.filter((risk) => doesNotUseEvidence(risk.provenance))
  };
}

async function loadEvidenceReferences(
  database: LumaDatabase,
  workspaceId: WorkspaceId,
  meetingId: MeetingId
): Promise<EvidenceReference[]> {
  const rows = await database.query<EvidenceRow>(
    `SELECT reference_json FROM evidence
     WHERE workspace_id = $1 AND meeting_id = $2 AND active = TRUE
     ORDER BY created_at ASC`,
    [workspaceId, meetingId]
  );

  return rows.rows.map((row) => parseJson<EvidenceReference>(row.reference_json));
}

function applyHumanJudgment(
  state: MeetingState,
  observation: Extract<MeetingObservation, { type: "human-judgment-recorded" }>,
  evidence: EvidenceReference | null
): MeetingState {
  const judgment = observation.judgment;

  switch (judgment.kind) {
    case "confirm": {
      const meetingItemId = judgment.meetingItemId;
      return {
        ...state,
        humanJudgmentItemIds: withHumanJudgmentItemId(state, meetingItemId),
        decisions: state.decisions.map((decision) =>
          decision.id === meetingItemId
            ? {
                ...decision,
                status: "confirmed",
                provenance: humanJudgmentProvenance(state, decision.provenance, evidence)
              }
            : decision
        ),
        actionItems: state.actionItems.map((item) =>
          item.id === meetingItemId
            ? {
                ...item,
                status: "confirmed",
                provenance: humanJudgmentProvenance(state, item.provenance, evidence)
              }
            : item
        )
      };
    }
    case "reject": {
      const meetingItemId = judgment.meetingItemId;
      return {
        ...state,
        humanJudgmentItemIds: withHumanJudgmentItemId(state, meetingItemId),
        decisions: state.decisions.map((decision) =>
          decision.id === meetingItemId
            ? {
                ...decision,
                status: "rejected",
                provenance: humanJudgmentProvenance(state, decision.provenance, evidence)
              }
            : decision
        ),
        actionItems: state.actionItems.map((item) =>
          item.id === meetingItemId
            ? {
                ...item,
                status: "cancelled",
                provenance: humanJudgmentProvenance(state, item.provenance, evidence)
              }
            : item
        )
      };
    }
    case "correct": {
      const meetingItemId = judgment.meetingItemId;
      const correction = judgment.correction;
      return {
        ...state,
        humanJudgmentItemIds: withHumanJudgmentItemId(state, meetingItemId),
        decisions: state.decisions.map((decision) =>
          decision.id === meetingItemId
            ? {
                ...decision,
                statement: correction.statement ?? decision.statement,
                status: isDecisionStatus(correction.status)
                  ? correction.status
                  : decision.status,
                provenance: humanJudgmentProvenance(state, decision.provenance, evidence)
              }
            : decision
        ),
        actionItems: state.actionItems.map((item) =>
          item.id === meetingItemId
            ? {
                ...item,
                description: correction.statement ?? item.description,
                ownership: ownershipForHumanActionItemCorrection(
                  actionItemOwnership(item),
                  correction.ownerId
                ),
                ownerId: ownerIdForHumanActionItemCorrection(
                  actionItemOwnership(item),
                  correction.ownerId
                ),
                dueDate:
                  correction.dueDate === undefined ? item.dueDate : correction.dueDate,
                status: isActionItemStatus(correction.status)
                  ? correction.status
                  : item.status,
                provenance: humanJudgmentProvenance(state, item.provenance, evidence)
              }
            : item
        )
      };
    }
    case "merge":
    case "split":
    case "resolve-action-item-reconciliation":
    case "resolve-action-item-ownership":
    case "resolve-speaker-attribution":
    case "refresh-action-item-reconciliation":
      return state;
  }
}

function humanJudgmentEvidenceForMeetingItem(
  observation: Extract<MeetingObservation, { type: "human-judgment-recorded" }>
): EvidenceReference | null {
  const judgment = observation.judgment;

  if (
    judgment.kind !== "confirm" &&
    judgment.kind !== "reject" &&
    judgment.kind !== "correct"
  ) {
    return null;
  }

  return {
    evidenceId: `evidence:human-judgment:${opaqueIdentifierSegment(observation.observationId)}`,
    source: "human-judgment",
    sourceObjectId: judgment.meetingItemId,
    participantId: observation.participantId,
    sourceVersion: observation.observationId,
    excerpt: `Human Judgment ${judgment.kind} recorded for Meeting item ${judgment.meetingItemId}.`
  };
}

function humanJudgmentProvenance(
  state: MeetingState,
  existing: Provenance,
  evidence: EvidenceReference | null
): Provenance {
  if (!evidence) {
    return existing;
  }

  const byId = new Map(
    [...existing.evidence, evidence].map((reference) => [reference.evidenceId, reference])
  );

  return {
    evidence: [...byId.values()],
    confidence: "high",
    producedAtRevision: state.revision + 1,
    analysisVersion: "human-judgment"
  };
}

function withHumanJudgmentItemId(
  state: MeetingState,
  meetingItemId: string
): MeetingState["humanJudgmentItemIds"] {
  return state.humanJudgmentItemIds.includes(meetingItemId)
    ? state.humanJudgmentItemIds
    : [...state.humanJudgmentItemIds, meetingItemId];
}

async function applyActionItemReconciliationHumanJudgment(
  database: DatabaseQuery,
  state: MeetingState,
  observation: Extract<MeetingObservation, { type: "human-judgment-recorded" }>,
  now: () => Date
): Promise<{
  state: MeetingState;
  evidenceForAnalysis: EvidenceReference[];
  events: MeetingIntelligenceEvent[];
}> {
  const judgment = observation.judgment;

  if (judgment.kind !== "resolve-action-item-reconciliation") {
    throw new Error("expected an Action Item reconciliation Human Judgment");
  }

  const review = state.actionItemReconciliationReviews.find(
    (candidate) => candidate.id === judgment.reviewId
  );

  if (!review) {
    throw new Error("validated reconciliation review disappeared before application");
  }

  const outcome = humanResolutionOutcome(review, judgment.resolution);
  const evidence = actionItemReconciliationHumanJudgmentEvidence(observation, review);
  const resolution: ActionItemReconciliationHumanResolution = {
    id: `reconciliation-resolution:${opaqueIdentifierSegment(observation.observationId)}`,
    reviewId: review.id,
    candidateId: review.candidateId,
    participantId: observation.participantId,
    resolution: judgment.resolution,
    outcome,
    evidence,
    resolvedAt: observation.observedAt
  };
  await insertEvidence(
    database,
    observation.workspaceId,
    observation.meetingId,
    evidence,
    now
  );

  const intent = followUpIntentForHumanResolution(state, review, resolution);
  const followUpIntentions = intent
    ? [...state.followUpIntentions, intent]
    : state.followUpIntentions;

  return {
    state: {
      ...state,
      actionItemReconciliationHumanResolutions: [
        ...state.actionItemReconciliationHumanResolutions,
        resolution
      ],
      followUpIntentions
    },
    evidenceForAnalysis: [],
    events: intent
      ? [{ type: "follow-up-awaiting-approval", intentIds: [intent.id] }]
      : []
  };
}

async function applyActionItemOwnershipHumanJudgment(
  database: DatabaseQuery,
  state: MeetingState,
  observation: Extract<MeetingObservation, { type: "human-judgment-recorded" }>,
  now: () => Date
): Promise<{
  state: MeetingState;
  evidenceForAnalysis: EvidenceReference[];
  events: MeetingIntelligenceEvent[];
}> {
  const judgment = observation.judgment;

  if (judgment.kind !== "resolve-action-item-ownership") {
    throw new Error("expected an Action Item ownership Human Judgment");
  }

  const candidate = state.importedActionItemCandidates.find(
    (value) =>
      state.currentImportedActionItemCandidateIds.includes(value.id) &&
      actionItemOwnershipClaimId(value) === judgment.claimId
  );

  if (!candidate) {
    throw new Error("validated ownership claim disappeared before application");
  }

  const evidence: EvidenceReference = {
    evidenceId: `evidence:human-judgment:ownership:${opaqueIdentifierSegment(observation.observationId)}`,
    source: "human-judgment",
    sourceObjectId: judgment.claimId,
    participantId: observation.participantId,
    sourceVersion: observation.observationId,
    excerpt: `Human Judgment resolved Action Item ownership claim ${judgment.claimId}.`
  };
  const ownership = ownershipFromHumanJudgment(judgment);
  const resolution: ActionItemOwnershipHumanResolution = {
    id: `ownership-resolution:${opaqueIdentifierSegment(observation.observationId)}`,
    claimId: judgment.claimId,
    candidateId: candidate.id,
    candidateLineageKey: candidate.lineageKey,
    participantId: observation.participantId,
    ownership,
    evidence,
    resolvedAt: observation.observedAt
  };

  await insertEvidence(
    database,
    observation.workspaceId,
    observation.meetingId,
    evidence,
    now
  );

  return {
    state: {
      ...state,
      actionItemOwnershipHumanResolutions: [
        ...state.actionItemOwnershipHumanResolutions,
        resolution
      ],
      followUpIntentions: invalidateSupersededOwnershipReconciliationIntents(
        state.followUpIntentions,
        candidate.lineageKey
      ),
      lastObservationAt: observation.observedAt
    },
    evidenceForAnalysis: [],
    events: []
  };
}

function ownershipFromHumanJudgment(
  judgment: Extract<HumanJudgment, { kind: "resolve-action-item-ownership" }>
): ActionItemOwnershipAttribution {
  switch (judgment.resolution.type) {
    case "confirm-owner":
      return {
        status: "confirmed",
        ownerPersonId: judgment.resolution.ownerPersonId,
        confidence: "deterministic",
        basis: "human-confirmation"
      };
    case "intentionally-unassigned":
      return {
        status: "intentionally-unassigned",
        basis: "human-confirmation"
      };
    case "keep-unresolved":
      return {
        status: "unresolved",
        reason: judgment.resolution.reason ?? "insufficient-acceptance",
        likelyOwnerPersonId: null
      };
  }
}

function invalidateSupersededOwnershipReconciliationIntents(
  intents: FollowUpIntent[],
  candidateLineageKey: string
): FollowUpIntent[] {
  return intents.map((intent) => {
    const binding = reconciliationBindingForIntent(intent);

    return binding?.candidateLineageKey === candidateLineageKey &&
      (intent.status === "suggested" || intent.status === "approved")
      ? { ...intent, status: "invalidated" }
      : intent;
  });
}

async function applySpeakerAttributionHumanJudgment(
  database: DatabaseQuery,
  state: MeetingState,
  observation: Extract<MeetingObservation, { type: "human-judgment-recorded" }>,
  now: () => Date
): Promise<{
  state: MeetingState;
  evidenceForAnalysis: EvidenceReference[];
  events: MeetingIntelligenceEvent[];
  error?: MeetingIntelligenceError;
}> {
  const judgment = observation.judgment;

  if (judgment.kind !== "resolve-speaker-attribution") {
    throw new Error("expected a speaker attribution Human Judgment");
  }

  const utterance = await loadUtteranceVersion(
    database,
    state,
    judgment.utteranceId,
    judgment.version
  );

  if (!utterance) {
    return {
      state,
      evidenceForAnalysis: [],
      events: [],
      error: {
        code: "invalid-observation",
        observationId: observation.observationId,
        message: "Human speaker attribution must target an existing versioned utterance",
        retryable: false
      }
    };
  }

  const speaker: SpeakerAttribution = judgment.personId
    ? {
        status: "attributed",
        personId: judgment.personId,
        confidence: "deterministic",
        basis: "human-confirmation"
      }
    : {
        status: "unresolved",
        candidatePersonId: null,
        confidence: "unknown",
        basis: "human-confirmation"
      };
  const evidence: EvidenceReference = {
    evidenceId: `evidence:human-judgment:speaker:${opaqueIdentifierSegment(observation.observationId)}`,
    source: "human-judgment",
    sourceObjectId: `${judgment.utteranceId}:v${judgment.version}`,
    participantId: observation.participantId,
    sourceVersion: observation.observationId,
    excerpt: `Human Judgment resolved speaker attribution for utterance ${judgment.utteranceId} version ${judgment.version}.`
  };
  const resolution: SpeakerAttributionHumanResolution = {
    id: `speaker-attribution-resolution:${opaqueIdentifierSegment(observation.observationId)}`,
    utteranceId: judgment.utteranceId,
    version: judgment.version,
    participantId: observation.participantId,
    speaker,
    evidence,
    resolvedAt: observation.observedAt
  };

  await insertEvidence(
    database,
    observation.workspaceId,
    observation.meetingId,
    evidence,
    now
  );

  const projected = await projectCurrentSpeakerAttribution(
    database,
    {
      ...state,
      speakerAttributionHumanResolutions: [
        ...state.speakerAttributionHumanResolutions,
        resolution
      ]
    },
    { persistEvidence: true }
  );
  const correctedTranscriptEvidence = projected.activeTranscriptEvidence.filter(
    (reference) =>
      reference.sourceObjectId === judgment.utteranceId &&
      Number(reference.sourceVersion) >= judgment.version
  );

  return {
    state: {
      ...projected.state,
      lastObservationAt: observation.observedAt
    },
    evidenceForAnalysis: uniqueEvidence([evidence, ...correctedTranscriptEvidence]),
    events: []
  };
}

function humanResolutionOutcome(
  review: ActionItemReconciliationReview,
  resolution: ActionItemReconciliationResolution
): ActionItemReconciliationOutcome {
  switch (resolution.type) {
    case "accept-proposal":
      return review.outcome;
    case "reject-proposal":
      return {
        type: "reject-not-work",
        rationale:
          resolution.reason ?? "Human Judgment rejected this reconciliation proposal."
      };
    case "select-existing": {
      const workItem = reconciliationWorkItemFromReview(
        review,
        resolution.providerId,
        resolution.externalId
      );

      if (!workItem) {
        throw new Error("validated reconciliation target disappeared before application");
      }

      return {
        type: resolution.action,
        workItem,
        rationale: "Human Judgment selected this canonical work item."
      };
    }
    case "select-create-new":
      return {
        type: "create-new",
        rationale: "Human Judgment selected a new canonical work item."
      };
    case "select-needs-clarification":
      return {
        type: "needs-clarification",
        rationale:
          resolution.reason ??
          "Human Judgment kept this reconciliation open for clarification."
      };
  }
}

function actionItemReconciliationHumanJudgmentEvidence(
  observation: Extract<MeetingObservation, { type: "human-judgment-recorded" }>,
  review: ActionItemReconciliationReview
): EvidenceReference {
  return {
    evidenceId: `evidence:human-judgment:reconciliation:${opaqueIdentifierSegment(observation.observationId)}`,
    source: "human-judgment",
    sourceObjectId: review.id,
    participantId: observation.participantId,
    sourceVersion: observation.observationId,
    excerpt: `Human Judgment resolved Action Item reconciliation proposal ${review.id}.`
  };
}

function followUpIntentForHumanResolution(
  state: MeetingState,
  review: ActionItemReconciliationReview,
  resolution: ActionItemReconciliationHumanResolution
): FollowUpIntent {
  const provenance: Provenance = {
    evidence: uniqueEvidence([...review.evidence, resolution.evidence]),
    confidence: "high",
    producedAtRevision: state.revision + 1,
    analysisVersion: "human-reconciliation-v1"
  };

  return {
    id: `follow-up-intent:reconciliation:${opaqueIdentifierSegment(review.id)}:settle`,
    type: "settle-operational-outcome",
    reconciliation: {
      reviewId: review.id,
      candidateId: review.candidateId,
      candidateLineageKey: review.candidateLineageKey
    },
    relatedMeetingItemIds: [],
    status: "suggested",
    provenance
  };
}

type FollowUpExecutionReservationRow = {
  execution_lease_id: string | null;
};

/**
 * Public `observe` is allowed to record receipts, but only Follow-up
 * Execution can mint the one-time DB lease that makes a receipt authoritative.
 */
async function validateFollowUpExecutionReceipt(
  database: DatabaseQuery,
  state: MeetingState,
  observation: Extract<MeetingObservation, { type: "follow-up-execution-recorded" }>
): Promise<MeetingIntelligenceError | null> {
  const intent = state.followUpIntentions.find(
    (candidate) => candidate.id === observation.intentId
  );

  const canResumePartialSettlement =
    intent?.type === "settle-operational-outcome" &&
    intent.status === "partially-succeeded";
  const canProbeManualOperationalOutcome =
    intent?.type === "settle-operational-outcome" &&
    intent.status === "requires-manual-recovery";
  const canProbeManualLegacyGenericKnowledgeCreate =
    intent?.type === "update-knowledge" && intent.status === "requires-manual-recovery";

  if (
    !intent ||
    (intent.status !== "approved" &&
      !canResumePartialSettlement &&
      !canProbeManualOperationalOutcome &&
      !canProbeManualLegacyGenericKnowledgeCreate)
  ) {
    return invalidFollowUpExecutionReceipt(
      observation,
      "Follow-up execution receipt must target a canonically approved, resumable partial, manual-probe settlement, or historic generic-create recovery Intent"
    );
  }

  if (typeof observation.executionLeaseId !== "string" || !observation.executionLeaseId) {
    return invalidFollowUpExecutionReceipt(
      observation,
      "Follow-up execution receipt must carry an execution lease"
    );
  }

  const reservation = await database.query<FollowUpExecutionReservationRow>(
    `UPDATE follow_up_executions
        SET status = 'receipt-recorded', updated_at = updated_at
      WHERE workspace_id = $1
        AND meeting_id = $2
        AND intent_id = $3
        AND operation = 'execute'
        AND status = 'executing'
        AND execution_lease_id = $4
      RETURNING execution_lease_id`,
    [
      observation.workspaceId,
      observation.meetingId,
      observation.intentId,
      observation.executionLeaseId
    ]
  );

  if (reservation.rows[0]?.execution_lease_id !== observation.executionLeaseId) {
    return invalidFollowUpExecutionReceipt(
      observation,
      "Follow-up execution receipt is not bound to an active execution lease"
    );
  }

  return null;
}

function invalidFollowUpExecutionReceipt(
  observation: Extract<MeetingObservation, { type: "follow-up-execution-recorded" }>,
  message: string
): MeetingIntelligenceError {
  return {
    code: "invalid-observation",
    observationId: observation.observationId,
    message,
    retryable: false
  };
}

function applyFollowUpExecutionRecorded(
  state: MeetingState,
  observation: Extract<MeetingObservation, { type: "follow-up-execution-recorded" }>
): {
  state: MeetingState;
  evidenceForAnalysis: EvidenceReference[];
  events: MeetingIntelligenceEvent[];
} {
  const outcome = observation.outcome;
  const requiresManualRecovery =
    outcome.status === "failed" &&
    (outcome.requiresManualRecovery === true ||
      outcome.errorCode === "provider-outcome-unknown" ||
      outcome.errorCode === "operational-outcome-invalid-receipt");
  const nextStatus =
    outcome.status === "succeeded"
      ? "succeeded"
      : outcome.status === "partially-succeeded"
        ? "partially-succeeded"
        : requiresManualRecovery
          ? "requires-manual-recovery"
          : "failed";
  const externalReferences =
    outcome.status === "failed"
      ? (outcome.externalReferences ?? [])
      : outcome.externalReferences;
  const nextState = updateFollowUpIntentStatus(state, observation.intentId, nextStatus);
  const executedIntent = state.followUpIntentions.find(
    (intent) => intent.id === observation.intentId
  );
  const actionItemReconciliationCreatedWorkMappings =
    appendCreatedWorkMappingsFromExecution(
      nextState.actionItemReconciliationCreatedWorkMappings,
      nextState,
      executedIntent,
      externalReferences,
      observation.observedAt
    );
  const nextActionItems = nextState.actionItems.map((item) =>
    nextState.followUpIntentions.some(
      (intent) =>
        intent.id === observation.intentId &&
        intent.type === "create-work-item" &&
        intent.relatedMeetingItemIds.includes(item.id)
    )
      ? {
          ...item,
          externalReferences: mergeExternalReferences(
            item.externalReferences,
            externalReferences
          )
        }
      : item
  );

  const event: MeetingIntelligenceEvent =
    outcome.status === "succeeded"
      ? {
          type: "follow-up-execution-succeeded",
          intentId: observation.intentId,
          externalReferences,
          summary: outcome.summary ?? "Follow-up execution succeeded."
        }
      : outcome.status === "partially-succeeded"
        ? {
            type: "follow-up-execution-partially-succeeded",
            intentId: observation.intentId,
            externalReferences,
            message: outcome.message
          }
        : {
            type: "follow-up-execution-failed",
            intentId: observation.intentId,
            message: outcome.message,
            retryable: outcome.retryable
          };

  return {
    state: {
      ...nextState,
      actionItems: nextActionItems,
      actionItemReconciliationCreatedWorkMappings
    },
    evidenceForAnalysis: [],
    events: [event]
  };
}

function appendCreatedWorkMappingsFromExecution(
  current: ActionItemReconciliationCreatedWorkMapping[],
  state: MeetingState,
  intent: FollowUpIntent | undefined,
  externalReferences: ExternalReference[],
  recordedAt: string
): ActionItemReconciliationCreatedWorkMapping[] {
  const reconciliation = intent ? reconciliationBindingForIntent(intent) : null;

  if (!intent || !reconciliation) {
    return current;
  }

  const createsWork =
    intent.type === "create-work-item" ||
    (intent.type === "settle-operational-outcome" &&
      state.actionItemReconciliationHumanResolutions.some(
        (resolution) =>
          resolution.reviewId === reconciliation.reviewId &&
          resolution.outcome.type === "create-new"
      ));

  if (!createsWork) {
    return current;
  }

  const mappings = externalReferences
    .filter(
      (reference) =>
        reference.objectType === "work-item" &&
        (intent.type !== "create-work-item" ||
          !intent.providerId ||
          reference.providerId === intent.providerId)
    )
    .map((externalReference) => ({
      id: `reconciliation-created-work:${opaqueIdentifierSegment(intent.id)}:${opaqueIdentifierSegment(externalReference.providerId)}:${opaqueIdentifierSegment(externalReference.externalId)}`,
      reviewId: reconciliation.reviewId,
      candidateId: reconciliation.candidateId,
      candidateLineageKey: reconciliation.candidateLineageKey,
      externalReference,
      recordedAt
    }));
  const existingIds = new Set(current.map((mapping) => mapping.id));

  return [...current, ...mappings.filter((mapping) => !existingIds.has(mapping.id))];
}

function applyExternalActivity(
  state: MeetingState,
  observation: Extract<MeetingObservation, { type: "external-activity-observed" }>
): MeetingState {
  const statusByKind = {
    "work-started": "in-progress",
    "work-blocked": "blocked",
    "work-completed": "completed",
    "pull-request-opened": "in-progress",
    "pull-request-merged": "completed",
    "knowledge-updated": "confirmed"
  } as const;

  const nextStatus = statusByKind[observation.activity.kind];
  return {
    ...state,
    actionItems: state.actionItems.map((item) =>
      observation.activity.relatedMeetingItemIds.includes(item.id)
        ? {
            ...item,
            status: nextStatus === "confirmed" ? item.status : nextStatus,
            externalReferences: mergeExternalReferences(item.externalReferences, [
              observation.activity.externalReference
            ])
          }
        : item
    )
  };
}

function updateFollowUpIntentStatus(
  state: MeetingState,
  intentId: string,
  status: FollowUpIntent["status"]
): MeetingState {
  return {
    ...state,
    followUpIntentions: state.followUpIntentions.map((intent) =>
      intent.id === intentId
        ? {
            ...intent,
            status
          }
        : intent
    )
  };
}

function reconcileFollowUpIntentions(
  current: FollowUpIntent[],
  proposed: FollowUpIntentProposal[],
  evidenceById: Map<string, EvidenceReference>,
  revision: number,
  analysis: StructuredReasoningResult<MeetingAnalysisProposalBatch>
): FollowUpIntent[] {
  const byId = new Map(current.map((intent) => [intent.id, intent]));

  for (const proposal of proposed) {
    if (byId.has(proposal.id)) {
      continue;
    }

    const provenance = provenanceFromEvidenceIds(
      proposal.evidenceIds,
      evidenceById,
      revision,
      proposal.confidence,
      analysis
    );
    const common = {
      id: proposal.id,
      relatedMeetingItemIds: proposal.relatedMeetingItemIds,
      status: "suggested" as const,
      provenance
    };

    switch (proposal.type) {
      case "record-meeting":
        byId.set(proposal.id, {
          ...common,
          type: proposal.type,
          title: proposal.title
        });
        break;
      case "update-knowledge":
        // Retain the model proposal and its provenance as an audit record, but
        // do not surface arbitrary Markdown as an approvable Notion mutation.
        // LUM-11 owns the later Human-selected canonical patch capability.
        byId.set(proposal.id, {
          ...common,
          status: "rejected",
          type: proposal.type,
          title: proposal.title,
          bodyMarkdown: proposal.bodyMarkdown
        });
        break;
      case "create-work-item":
        byId.set(proposal.id, {
          ...common,
          type: proposal.type,
          title: proposal.title,
          description: proposal.description,
          assigneeId: proposal.assigneeId,
          mentionPersonIds: proposal.mentionPersonIds,
          dueDate: proposal.dueDate
        });
        break;
      case "update-work-item":
        byId.set(proposal.id, {
          ...common,
          type: proposal.type,
          externalReference: proposal.externalReference,
          description: proposal.description
        });
        break;
      case "comment-on-code-change":
        byId.set(proposal.id, {
          ...common,
          type: proposal.type,
          externalReference: proposal.externalReference,
          bodyMarkdown: proposal.bodyMarkdown
        });
        break;
    }
  }

  return [...byId.values()];
}

function deriveInterventions(state: MeetingState): MeetingIntervention[] {
  return [
    ...state.actionItems
      .filter((item) => {
        const ownership = actionItemOwnership(item);
        return ownership.status === "proposed" || ownership.status === "unresolved";
      })
      .map((item): MeetingIntervention => ({
        type: "missing-action-owner",
        actionItemId: item.id
      })),
    ...state.actionItems
      .filter((item) => item.dueDate === null)
      .map((item): MeetingIntervention => ({
        type: "missing-action-deadline",
        actionItemId: item.id
      })),
    ...state.decisions
      .filter((decision) => decision.status === "candidate")
      .map((decision): MeetingIntervention => ({
        type: "decision-confirmation-needed",
        decisionId: decision.id
      }))
  ];
}

function upsertParticipant(
  participants: MeetingState["participants"],
  personId: string,
  patch: {
    joinedAt: string | null;
    leftAt: string | null;
  }
): MeetingState["participants"] {
  const existing = participants.find((participant) => participant.personId === personId);

  if (!existing) {
    return [
      ...participants,
      {
        personId,
        joinedAt: patch.joinedAt,
        leftAt: patch.leftAt
      }
    ];
  }

  return participants.map((participant) =>
    participant.personId === personId
      ? {
          ...participant,
          joinedAt: patch.joinedAt ?? participant.joinedAt,
          leftAt: patch.leftAt
        }
      : participant
  );
}

function buildParticipantBrief(
  state: MeetingState,
  participantId: string,
  outputLanguage: "de" | "en"
): ParticipantBrief {
  return {
    participantId,
    commitments: state.actionItems.filter((item) => {
      const ownership = actionItemOwnership(item);
      return (
        ownership.status === "confirmed" && ownership.ownerPersonId === participantId
      );
    }),
    decisionsAffectingWork: state.decisions.filter(
      (decision) => decision.status === "confirmed"
    ),
    unresolvedQuestions: state.openQuestions.filter(
      (question) => question.status === "open"
    ),
    outputLanguage
  };
}

function formatActionAnswer(item: ActionItem, queryText: string): string {
  const prefix = /warum|wieso|why/i.test(queryText)
    ? "Grounded Action Item"
    : "Action Item";
  const ownership = actionItemOwnership(item);
  const owner =
    ownership.status === "confirmed"
      ? `confirmed owner ${ownership.ownerPersonId}`
      : ownership.status === "proposed"
        ? ownership.proposedOwnerPersonId
          ? `proposed owner ${ownership.proposedOwnerPersonId}`
          : "proposed owner requires confirmation"
        : ownership.status === "intentionally-unassigned"
          ? "explicitly unassigned by Human Judgment"
          : "no confirmed owner";
  const due = item.dueDate ? `due ${item.dueDate}` : "no confirmed deadline";
  return `${prefix}: ${item.description}; ${owner}; ${due}.`;
}

function actionItemId(stableKey: string): string {
  return `action:${slug(stableKey)}`;
}

function decisionId(stableKey: string): string {
  return `decision:${slug(stableKey)}`;
}

function openQuestionId(stableKey: string): string {
  return `question:${slug(stableKey)}`;
}

function riskId(stableKey: string): string {
  return `risk:${slug(stableKey)}`;
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function mergeExternalReferences(
  current: readonly ExternalReference[],
  next: readonly ExternalReference[]
): ActionItem["externalReferences"] {
  const byIdentity = new Map<string, ActionItem["externalReferences"][number]>();

  for (const reference of [...current, ...next]) {
    byIdentity.set(
      `${reference.providerId}:${reference.objectType}:${reference.externalId}`,
      reference
    );
  }

  return [...byIdentity.values()];
}

function isActionItemStatus(value: unknown): value is ActionItem["status"] {
  return (
    value === "candidate" ||
    value === "confirmed" ||
    value === "planned" ||
    value === "in-progress" ||
    value === "blocked" ||
    value === "completed" ||
    value === "cancelled"
  );
}

function isDecisionStatus(value: unknown): value is Decision["status"] {
  return (
    value === "candidate" ||
    value === "confirmed" ||
    value === "rejected" ||
    value === "superseded"
  );
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export async function loadActiveEvidenceForMeeting(
  database: LumaDatabase,
  workspaceId: WorkspaceId,
  meetingId: MeetingId
): Promise<EvidenceReference[]> {
  const rows = await database.query<MeetingRow>(
    `SELECT state_json FROM meetings WHERE workspace_id = $1 AND meeting_id = $2`,
    [workspaceId, meetingId]
  );
  const row = rows.rows[0];

  if (!row) {
    return [];
  }

  const projection = await projectCurrentSpeakerAttribution(
    database,
    normalizeMeetingState(parseJson<MeetingState>(row.state_json))
  );
  const evidence = await loadEvidenceReferences(database, workspaceId, meetingId);

  return evidence.map(
    (reference) => projection.evidenceById.get(reference.evidenceId) ?? reference
  );
}
