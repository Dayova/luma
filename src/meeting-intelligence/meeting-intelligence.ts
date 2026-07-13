import type {
  ActionItem,
  Decision,
  EvidenceReference,
  ExternalReference,
  FollowUpIntent,
  MeetingConclusion,
  MeetingId,
  MeetingIntelligenceError,
  MeetingIntelligenceEvent,
  MeetingIntervention,
  MeetingObservation,
  MeetingState,
  OpenQuestion,
  ParticipantBrief,
  Provenance,
  Risk,
  UtteranceCommitted,
  UtteranceRevised,
  WorkspaceConfig,
  WorkspaceId
} from "../domain/model.js";
import type {
  ActionItemProposal,
  DecisionProposal,
  MeetingAnalysisProposalBatch,
  OpenQuestionProposal,
  ReasoningModel,
  RiskProposal,
  StructuredReasoningResult
} from "../ai/reasoning-model.js";
import type {
  ConcludeMeeting,
  MeetingIntelligence,
  MeetingQueryResult,
  MeetingUpdate,
  ObserveMeeting,
  QueryMeeting
} from "./interface.js";
import type { LumaDatabase } from "../persistence/db.js";

const ANALYSIS_VERSION = "meeting-analysis-v1";
const PROMPT_VERSION = "meeting-intelligence-v1";

export type CreateMeetingIntelligenceInput = {
  database: LumaDatabase;
  reasoningModel: ReasoningModel;
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

type ConclusionRow = {
  conclusion_json: string;
};

type UtteranceVersionRow = {
  speaker_id: string;
  started_at: string;
  ended_at: string;
};

export function createMeetingIntelligence(
  input: CreateMeetingIntelligenceInput
): MeetingIntelligence {
  const now = input.now ?? (() => new Date());

  return {
    observe: (observeInput) =>
      observeMeeting(input.database, input.reasoningModel, now, observeInput),
    query: (queryInput) => queryMeeting(input.database, queryInput),
    conclude: (concludeInput) => concludeMeeting(input.database, now, concludeInput)
  };
}

async function observeMeeting(
  database: LumaDatabase,
  reasoningModel: ReasoningModel,
  now: () => Date,
  input: ObserveMeeting
): Promise<MeetingUpdate> {
  if (input.observations.length === 0) {
    throw new Error("observe requires at least one Observation");
  }

  const workspaceId = input.workspace.workspaceId;
  const meetingId = input.observations[0]?.meetingId;

  if (!meetingId) {
    throw new Error("observe requires a Meeting ID");
  }

  await ensureWorkspace(database, input.workspace, now);

  let state = await loadMeetingState(database, workspaceId, meetingId);
  const acceptedObservationIds: string[] = [];
  const duplicateObservationIds: string[] = [];
  const errors: MeetingIntelligenceError[] = [];
  const interventions: MeetingIntervention[] = [];
  const events: MeetingIntelligenceEvent[] = [];
  const evidenceForAnalysis: EvidenceReference[] = [];
  let analysisStatus: MeetingUpdate["analysisStatus"] = "not-needed";

  for (const observation of input.observations) {
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

    const accepted = await appendObservationIfNew(
      database,
      observation,
      state.revision + 1,
      now
    );

    if (!accepted) {
      duplicateObservationIds.push(observation.observationId);
      continue;
    }

    const applied = await applyObservation(database, state, observation, now);

    if (applied.error) {
      errors.push(applied.error);
      continue;
    }

    acceptedObservationIds.push(observation.observationId);
    state = applied.state;
    evidenceForAnalysis.push(...applied.evidenceForAnalysis);
    events.push(...applied.events);
  }

  if (acceptedObservationIds.length > 0) {
    state = advanceRevision(
      state,
      input.observations.at(-1)?.observedAt ?? now().toISOString()
    );
    await saveMeetingState(database, state, "observations-accepted", now);
  }

  if (evidenceForAnalysis.length > 0) {
    try {
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
            languagePolicy: input.workspace.outputLanguagePolicy ?? "meeting-majority"
          }
        });

      state = reconcileAnalysis(state, evidenceForAnalysis, analysis);
      state = {
        ...advanceRevision(state, now().toISOString()),
        lastAnalyzedAt: now().toISOString()
      };
      await saveMeetingState(database, state, "analysis-reconciled", now);
      interventions.push(...deriveInterventions(state));
      analysisStatus = "completed";
    } catch {
      analysisStatus = "deferred";
      errors.push({
        code: "analysis-temporarily-unavailable",
        retryable: true
      });
    }
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
        ? state.actionItems.filter((item) => item.ownerId === query.participantId)
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
  }
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
  return row ? parseJson<MeetingState>(row.state_json) : null;
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
  const optionsHash = outputLanguage;
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
  database: LumaDatabase,
  workspace: WorkspaceConfig,
  now: () => Date
): Promise<void> {
  await database.query(
    `INSERT INTO workspaces (workspace_id, timezone, config_json, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id)
     DO UPDATE SET timezone = EXCLUDED.timezone, config_json = EXCLUDED.config_json`,
    [
      workspace.workspaceId,
      workspace.timezone,
      JSON.stringify(workspace),
      now().toISOString()
    ]
  );
}

async function appendObservationIfNew(
  database: LumaDatabase,
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

async function applyObservation(
  database: LumaDatabase,
  state: MeetingState,
  observation: MeetingObservation,
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
      return {
        state: {
          ...state,
          participants: upsertParticipant(state.participants, observation.speakerId, {
            joinedAt: null,
            leftAt: null
          }),
          lastObservationAt: observation.observedAt
        },
        evidenceForAnalysis: [evidence],
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
        speakerId: previous.speaker_id,
        startedAt: previous.started_at,
        endedAt: previous.ended_at
      };
      const evidence = evidenceFromUtterance(committed);
      await insertUtteranceVersion(database, committed, evidence, now);
      await insertEvidence(database, state.workspaceId, state.meetingId, evidence, now);
      return {
        state: removeItemsUsingInactiveEvidence(
          state,
          evidenceIdForUtterance(observation.utteranceId, observation.replacesVersion)
        ),
        evidenceForAnalysis: [evidence],
        events: []
      };
    }
    case "human-judgment-recorded":
      return {
        state: applyHumanJudgment(state, observation),
        evidenceForAnalysis: [],
        events: []
      };
    case "follow-up-intent-approved":
      return {
        state: updateFollowUpIntentStatus(state, observation.intentId, "approved"),
        evidenceForAnalysis: [],
        events: [
          {
            type: "follow-up-awaiting-approval",
            intentIds: state.followUpIntentions
              .filter((intent) => intent.status === "suggested")
              .map((intent) => intent.id)
          }
        ]
      };
    case "follow-up-intent-rejected":
      return {
        state: updateFollowUpIntentStatus(state, observation.intentId, "rejected"),
        evidenceForAnalysis: [],
        events: []
      };
    case "follow-up-execution-recorded":
      return applyFollowUpExecutionRecorded(state, observation);
    case "external-activity-observed":
      return {
        state: applyExternalActivity(state, observation),
        evidenceForAnalysis: [],
        events: []
      };
  }
}

async function loadMeetingState(
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
    return createInitialMeetingState(workspaceId, meetingId);
  }

  return parseJson<MeetingState>(row.state_json);
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

  return parseJson<MeetingState>(row.state_json);
}

async function saveMeetingState(
  database: LumaDatabase,
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
    followUpIntentions: [],
    lastObservationAt: "",
    lastAnalyzedAt: null
  };
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
    followUpIntentions: mergeFollowUpIntentions(
      state.followUpIntentions,
      analysis.value.followUpIntentions
    )
  };
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
    const provenance = provenanceFromEvidenceIds(
      proposal.evidenceIds,
      evidenceById,
      state.revision,
      proposal.confidence,
      analysis
    );
    const existing = existingById.get(id);
    existingById.set(id, {
      id,
      description: proposal.description,
      ownerId: proposal.ownerId,
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
  return {
    evidenceId: evidenceIdForUtterance(observation.utteranceId, observation.version),
    source: "transcript",
    sourceObjectId: observation.utteranceId,
    sourceVersion: String(observation.version),
    excerpt: observation.originalText
  };
}

function evidenceIdForUtterance(utteranceId: string, version: number): string {
  return `evidence:transcript:${utteranceId}:v${version}`;
}

async function insertEvidence(
  database: LumaDatabase,
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
  database: LumaDatabase,
  observation: UtteranceCommitted,
  evidence: EvidenceReference,
  now: () => Date
): Promise<void> {
  await database.query(
    `INSERT INTO utterance_versions (
      workspace_id, meeting_id, utterance_id, version, speaker_id, started_at,
      ended_at, original_text, language, evidence_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (workspace_id, meeting_id, utterance_id, version) DO NOTHING`,
    [
      observation.workspaceId,
      observation.meetingId,
      observation.utteranceId,
      observation.version,
      observation.speakerId,
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
  database: LumaDatabase,
  state: MeetingState,
  utteranceId: string,
  version: number
): Promise<UtteranceVersionRow | null> {
  const result = await database.query<UtteranceVersionRow>(
    `SELECT speaker_id, started_at, ended_at
     FROM utterance_versions
     WHERE workspace_id = $1 AND meeting_id = $2 AND utterance_id = $3 AND version = $4`,
    [state.workspaceId, state.meetingId, utteranceId, version]
  );

  return result.rows[0] ?? null;
}

async function markUtteranceSuperseded(
  database: LumaDatabase,
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
  database: LumaDatabase,
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
  const doesNotUseEvidence = (provenance: Provenance): boolean =>
    provenance.evidence.every((evidence) => evidence.evidenceId !== evidenceId);

  return {
    ...state,
    decisions: state.decisions.filter((decision) =>
      doesNotUseEvidence(decision.provenance)
    ),
    actionItems: state.actionItems.filter((item) => doesNotUseEvidence(item.provenance)),
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
  observation: Extract<MeetingObservation, { type: "human-judgment-recorded" }>
): MeetingState {
  const judgment = observation.judgment;

  switch (judgment.kind) {
    case "confirm": {
      const meetingItemId = judgment.meetingItemId;
      return {
        ...state,
        decisions: state.decisions.map((decision) =>
          decision.id === meetingItemId
            ? {
                ...decision,
                status: "confirmed"
              }
            : decision
        ),
        actionItems: state.actionItems.map((item) =>
          item.id === meetingItemId
            ? {
                ...item,
                status: "confirmed"
              }
            : item
        )
      };
    }
    case "reject": {
      const meetingItemId = judgment.meetingItemId;
      return {
        ...state,
        decisions: state.decisions.map((decision) =>
          decision.id === meetingItemId
            ? {
                ...decision,
                status: "rejected"
              }
            : decision
        ),
        actionItems: state.actionItems.map((item) =>
          item.id === meetingItemId
            ? {
                ...item,
                status: "cancelled"
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
        actionItems: state.actionItems.map((item) =>
          item.id === meetingItemId
            ? {
                ...item,
                description: correction.statement ?? item.description,
                ownerId:
                  correction.ownerId === undefined ? item.ownerId : correction.ownerId,
                dueDate:
                  correction.dueDate === undefined ? item.dueDate : correction.dueDate,
                status: isActionItemStatus(correction.status)
                  ? correction.status
                  : item.status
              }
            : item
        )
      };
    }
    case "merge":
    case "split":
      return state;
  }
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
  const nextStatus =
    outcome.status === "succeeded"
      ? "succeeded"
      : outcome.status === "partially-succeeded"
        ? "partially-succeeded"
        : "failed";
  const externalReferences =
    outcome.status === "failed" ? [] : outcome.externalReferences;
  const nextState = updateFollowUpIntentStatus(state, observation.intentId, nextStatus);
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
      actionItems: nextActionItems
    },
    evidenceForAnalysis: [],
    events: [event]
  };
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

function mergeFollowUpIntentions(
  current: FollowUpIntent[],
  proposed: FollowUpIntent[]
): FollowUpIntent[] {
  const byId = new Map(current.map((intent) => [intent.id, intent]));

  for (const intent of proposed) {
    byId.set(intent.id, byId.get(intent.id) ?? intent);
  }

  return [...byId.values()];
}

function deriveInterventions(state: MeetingState): MeetingIntervention[] {
  return [
    ...state.actionItems
      .filter((item) => item.ownerId === null)
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
    commitments: state.actionItems.filter((item) => item.ownerId === participantId),
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
  const owner = item.ownerId ? `owner ${item.ownerId}` : "no confirmed owner";
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

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export async function loadActiveEvidenceForMeeting(
  database: LumaDatabase,
  workspaceId: WorkspaceId,
  meetingId: MeetingId
): Promise<EvidenceReference[]> {
  return loadEvidenceReferences(database, workspaceId, meetingId);
}
