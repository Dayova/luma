import { describe, expect, it } from "vitest";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import type { MeetingIntelligence } from "../../src/meeting-intelligence/interface.js";
import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../../src/ai/reasoning-model.js";
import type {
  WorkProvider,
  WorkItem,
  WorkQuery,
  CreateWorkItemInput
} from "../../src/work/interface.js";
import type { ExternalReference, MeetingObservation } from "../../src/domain/model.js";

class ProgrammableReasoningModel implements ReasoningModel {
  private readonly handler: (
    request: StructuredReasoningRequest<MeetingAnalysisProposalBatch>
  ) => MeetingAnalysisProposalBatch;

  constructor(
    handler: (
      request: StructuredReasoningRequest<MeetingAnalysisProposalBatch>
    ) => MeetingAnalysisProposalBatch
  ) {
    this.handler = handler;
  }

  generateStructured<T>(
    request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    return Promise.resolve({
      value: this.handler(
        request as StructuredReasoningRequest<MeetingAnalysisProposalBatch>
      ) as T,
      metadata: {
        provider: "test",
        model: "programmable",
        promptVersion: request.promptVersion
      }
    });
  }
}

class DeferredReasoningModel implements ReasoningModel {
  private releaseAnalysis: (() => void) | null = null;
  private signalAnalysis: (() => void) | null = null;
  private readonly analysisReleased = new Promise<void>((resolve) => {
    this.releaseAnalysis = resolve;
  });
  private readonly analysisStarted = new Promise<void>((resolve) => {
    this.signalAnalysis = resolve;
  });

  async generateStructured<T>(
    request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    this.signalAnalysis?.();
    this.signalAnalysis = null;
    await this.analysisReleased;
    return {
      value: {
        actionItems: [],
        decisions: [],
        openQuestions: [],
        risks: [],
        followUpIntentions: []
      } as T,
      metadata: {
        provider: "test",
        model: "deferred",
        promptVersion: request.promptVersion
      }
    };
  }

  waitForAnalysis(): Promise<void> {
    return this.analysisStarted;
  }

  release(): void {
    this.releaseAnalysis?.();
    this.releaseAnalysis = null;
  }
}

/**
 * Produces one grounded Action Item immediately, then holds the next model
 * result so a Human correction can arrive while that analysis is in flight.
 */
class DeferredSecondActionItemReasoningModel implements ReasoningModel {
  private callCount = 0;
  private releaseAnalysis: (() => void) | null = null;
  private signalAnalysis: (() => void) | null = null;
  private readonly analysisReleased = new Promise<void>((resolve) => {
    this.releaseAnalysis = resolve;
  });
  private readonly analysisStarted = new Promise<void>((resolve) => {
    this.signalAnalysis = resolve;
  });

  async generateStructured<T>(
    request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    this.callCount += 1;
    const evidence = request.evidence[0];

    if (!evidence) {
      throw new Error("expected Evidence for deferred analysis");
    }

    if (this.callCount > 1) {
      this.signalAnalysis?.();
      this.signalAnalysis = null;
      await this.analysisReleased;
    }

    return {
      value: {
        actionItems: [
          {
            stableKey: "human-protected-action",
            description:
              this.callCount === 1
                ? "Prepare the initial release checklist"
                : "AI stale replacement for the release checklist",
            ownerId: "person_jakob",
            dueDate: {
              originalPhrase: null,
              normalizedDate: null,
              confidence: "unknown",
              timezone: "Europe/Berlin"
            },
            status: "candidate",
            relatedDecisionIds: [],
            evidenceIds: [evidence.evidenceId],
            confidence: "high"
          }
        ],
        decisions: [],
        openQuestions: [],
        risks: [],
        followUpIntentions: []
      } as T,
      metadata: {
        provider: "test",
        model: "deferred-second-action-item",
        promptVersion: request.promptVersion
      }
    };
  }

  waitForSecondAnalysis(): Promise<void> {
    return this.analysisStarted;
  }

  release(): void {
    this.releaseAnalysis?.();
    this.releaseAnalysis = null;
  }
}

class FakeWorkProvider implements WorkProvider {
  readonly providerId = "linear";
  createCalls: CreateWorkItemInput[] = [];

  searchWorkItems(_query: WorkQuery): Promise<WorkItem[]> {
    void _query;
    return Promise.resolve([]);
  }

  getWorkItem(id: string): Promise<WorkItem> {
    return Promise.resolve({
      id,
      providerId: this.providerId,
      externalId: id,
      title: "Issue",
      description: "",
      status: "planned",
      assignees: [],
      dueDate: null,
      labels: [],
      projectId: null,
      parentId: null,
      url: `https://linear.example/DAY-${id}`,
      updatedAt: "2026-06-26T10:20:00.000Z"
    });
  }

  createWorkItem(input: CreateWorkItemInput): Promise<ExternalReference> {
    this.createCalls.push(input);
    return Promise.resolve({
      providerId: this.providerId,
      objectType: "work-item",
      externalId: "312",
      url: "https://linear.example/DAY-312"
    });
  }

  updateWorkItem(): Promise<ExternalReference> {
    return Promise.reject(new Error("not needed by this test"));
  }

  addComment(): Promise<void> {
    return Promise.reject(new Error("not needed by this test"));
  }
}

async function createHarness(model: ReasoningModel): Promise<MeetingIntelligence> {
  const database = await createPgliteDatabase();

  return createMeetingIntelligence({
    database,
    reasoningModel: model,
    now: () => new Date("2026-06-26T10:20:00.000Z")
  });
}

function noMeetingAnalysisProposals(): MeetingAnalysisProposalBatch {
  return {
    actionItems: [],
    decisions: [],
    openQuestions: [],
    risks: [],
    followUpIntentions: []
  };
}

/**
 * Preserves the existing action during a Human speaker correction so the test
 * proves projection remaps its provenance rather than a fresh model proposal.
 */
function actionItemFromTranscriptUnlessHumanCorrection(
  request: StructuredReasoningRequest<MeetingAnalysisProposalBatch>
): MeetingAnalysisProposalBatch {
  const transcript = request.evidence.find(
    (evidence) => evidence.source === "transcript"
  );

  if (
    !transcript ||
    request.evidence.some((evidence) => evidence.source === "human-judgment")
  ) {
    return noMeetingAnalysisProposals();
  }

  return {
    actionItems: [
      {
        stableKey: "speaker-attribution-provenance",
        description: "Prepare the release checklist.",
        ownerId: null,
        dueDate: {
          originalPhrase: null,
          normalizedDate: null,
          confidence: "unknown",
          timezone: "Europe/Berlin"
        },
        status: "candidate",
        relatedDecisionIds: [],
        evidenceIds: [transcript.evidenceId],
        confidence: "high"
      }
    ],
    decisions: [],
    openQuestions: [],
    risks: [],
    followUpIntentions: []
  };
}

describe("MeetingIntelligence observe/query", () => {
  it("returns a validation error for malformed public source input and rejects unknown query kinds", async () => {
    const database = await createPgliteDatabase();
    const workspace = {
      workspaceId: "workspace_public_boundary",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_public_boundary";
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProgrammableReasoningModel(() => ({
        actionItems: [],
        decisions: [],
        openQuestions: [],
        risks: [],
        followUpIntentions: []
      }))
    });

    try {
      const malformed = {
        type: "meeting-imported-from-source",
        observationId: "public-boundary:malformed-source",
        workspaceId: workspace.workspaceId,
        meetingId,
        occurredAt: "2026-08-08T10:00:00.000Z",
        observedAt: "2026-08-08T10:00:01.000Z"
      } as unknown as MeetingObservation;
      const result = await meetingIntelligence.observe({
        workspace,
        observations: [malformed]
      });

      expect(result.acceptedObservationIds).toEqual([]);
      expect(result.errors).toEqual([
        expect.objectContaining({
          code: "invalid-observation",
          observationId: "public-boundary:malformed-source"
        })
      ]);

      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "meeting-started",
            observationId: "public-boundary:start",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T10:01:00.000Z",
            observedAt: "2026-08-08T10:01:01.000Z",
            title: "Public boundary",
            startedAt: "2026-08-08T10:01:00.000Z",
            languageMode: "en",
            participantIds: []
          }
        ]
      });

      await expect(
        meetingIntelligence.query({
          workspaceId: workspace.workspaceId,
          meetingId,
          query: { type: "unsupported" } as never
        })
      ).rejects.toThrow("Unsupported Meeting query type");
    } finally {
      await database.close();
    }
  });

  it("uses the current Meeting Intelligence prompt version for analysis", async () => {
    const database = await createPgliteDatabase();
    const workspace = {
      workspaceId: "workspace_prompt_version",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_prompt_version";
    let observedPromptVersion: string | null = null;
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProgrammableReasoningModel((request) => {
        observedPromptVersion = request.promptVersion;
        return noMeetingAnalysisProposals();
      })
    });

    try {
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "meeting-started",
            observationId: "prompt-version:start",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-09T10:00:00.000Z",
            observedAt: "2026-08-09T10:00:01.000Z",
            title: "Prompt provenance",
            startedAt: "2026-08-09T10:00:00.000Z",
            languageMode: "en",
            participantIds: []
          }
        ]
      });
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "utterance-committed",
            observationId: "prompt-version:utterance",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-09T10:01:00.000Z",
            observedAt: "2026-08-09T10:01:01.000Z",
            utteranceId: "prompt-version:utt",
            version: 1,
            speaker: {
              status: "attributed",
              personId: "person_jakob",
              confidence: "deterministic",
              basis: "provider-identity"
            },
            startedAt: "2026-08-09T10:00:58.000Z",
            endedAt: "2026-08-09T10:01:02.000Z",
            originalText: "We should retain prompt provenance.",
            language: "en"
          }
        ]
      });

      expect(observedPromptVersion).toBe("meeting-intelligence-v2");
    } finally {
      await database.close();
    }
  });

  it("discards delayed model analysis when a newer Observation changes canonical state", async () => {
    const database = await createPgliteDatabase();
    const reasoningModel = new DeferredReasoningModel();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel,
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });
    const workspace = {
      workspaceId: "workspace_analysis_rebase",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_analysis_rebase";

    try {
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "meeting-started",
            observationId: "analysis-rebase:start",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:00:00.000Z",
            observedAt: "2026-08-08T09:00:01.000Z",
            title: "Analysis rebase",
            startedAt: "2026-08-08T09:00:00.000Z",
            languageMode: "en",
            participantIds: []
          }
        ]
      });

      const delayedObservation = meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "utterance-committed",
            observationId: "analysis-rebase:utterance",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:05:00.000Z",
            observedAt: "2026-08-08T09:05:01.000Z",
            utteranceId: "analysis-rebase:utt",
            version: 1,
            speaker: {
              status: "attributed",
              personId: "person_jakob",
              confidence: "deterministic",
              basis: "provider-identity"
            },
            startedAt: "2026-08-08T09:04:58.000Z",
            endedAt: "2026-08-08T09:05:02.000Z",
            originalText: "I will keep the Meeting state current.",
            language: "en"
          }
        ]
      });
      await reasoningModel.waitForAnalysis();

      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "meeting-ended",
            observationId: "analysis-rebase:end",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:06:00.000Z",
            observedAt: "2026-08-08T09:06:01.000Z",
            endedAt: "2026-08-08T09:06:00.000Z"
          }
        ]
      });

      reasoningModel.release();
      const delayedUpdate = await delayedObservation;

      expect(delayedUpdate.analysisStatus).toBe("deferred");

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "snapshot" }
      });
      expect(snapshot).toMatchObject({
        type: "snapshot",
        state: { lifecycle: "ended", lastAnalyzedAt: null }
      });
    } finally {
      await database.close();
    }
  });

  it("does not let delayed AI analysis overwrite a newer Human correction", async () => {
    const database = await createPgliteDatabase();
    const reasoningModel = new DeferredSecondActionItemReasoningModel();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel,
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });
    const workspace = {
      workspaceId: "workspace_analysis_human_judgment",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_analysis_human_judgment";

    try {
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "utterance-committed",
            observationId: "analysis-human:first-utterance",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:00:00.000Z",
            observedAt: "2026-08-08T09:00:01.000Z",
            utteranceId: "analysis-human:first",
            version: 1,
            speaker: {
              status: "attributed",
              personId: "person_jakob",
              confidence: "deterministic",
              basis: "provider-identity"
            },
            startedAt: "2026-08-08T08:59:58.000Z",
            endedAt: "2026-08-08T09:00:02.000Z",
            originalText: "I will prepare the release checklist.",
            language: "en"
          }
        ]
      });

      const delayedObservation = meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "utterance-committed",
            observationId: "analysis-human:second-utterance",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:05:00.000Z",
            observedAt: "2026-08-08T09:05:01.000Z",
            utteranceId: "analysis-human:second",
            version: 1,
            speaker: {
              status: "attributed",
              personId: "person_jakob",
              confidence: "deterministic",
              basis: "provider-identity"
            },
            startedAt: "2026-08-08T09:04:58.000Z",
            endedAt: "2026-08-08T09:05:02.000Z",
            originalText: "The checklist should include the deployment runbook.",
            language: "en"
          }
        ]
      });
      await reasoningModel.waitForSecondAnalysis();

      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "analysis-human:correction",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:06:00.000Z",
            observedAt: "2026-08-08T09:06:01.000Z",
            participantId: "person_jakob",
            judgment: {
              kind: "correct",
              meetingItemId: "action:human-protected-action",
              correction: {
                statement: "Human-approved release checklist with deployment runbook",
                status: "confirmed"
              }
            }
          }
        ]
      });

      reasoningModel.release();
      const delayedUpdate = await delayedObservation;

      expect(delayedUpdate.analysisStatus).toBe("deferred");

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected snapshot result");
      }

      expect(snapshot.state.actionItems).toEqual([
        expect.objectContaining({
          id: "action:human-protected-action",
          description: "Human-approved release checklist with deployment runbook",
          status: "confirmed"
        })
      ]);
    } finally {
      await database.close();
    }
  });

  it("keeps a Human correction authoritative across a later fresh AI analysis", async () => {
    const database = await createPgliteDatabase();
    let analysisCount = 0;
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProgrammableReasoningModel((request) => {
        analysisCount += 1;
        const evidence = request.evidence[0];

        if (!evidence) {
          throw new Error("expected Evidence for analysis");
        }

        return {
          actionItems: [
            {
              stableKey: "human-protected-fresh-action",
              description:
                analysisCount === 1
                  ? "Prepare the initial release checklist"
                  : "AI replacement after new discussion evidence",
              ownerId: "person_jakob",
              dueDate: {
                originalPhrase: null,
                normalizedDate: null,
                confidence: "unknown",
                timezone: "Europe/Berlin"
              },
              status: "candidate",
              relatedDecisionIds: [],
              evidenceIds: [evidence.evidenceId],
              confidence: "high"
            }
          ],
          decisions: [
            {
              stableKey: "human-protected-fresh-decision",
              statement:
                analysisCount === 1
                  ? "Use the initial release process"
                  : "AI replacement for the release process",
              rationale: [],
              status: "candidate",
              supportingParticipantIds: [],
              objectingParticipantIds: [],
              relatedTopicIds: [],
              evidenceIds: [evidence.evidenceId],
              confidence: "high"
            }
          ],
          openQuestions: [],
          risks: [],
          followUpIntentions: []
        };
      }),
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });
    const workspace = {
      workspaceId: "workspace_fresh_human_judgment",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_fresh_human_judgment";

    try {
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "utterance-committed",
            observationId: "fresh-human:first-utterance",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:00:00.000Z",
            observedAt: "2026-08-08T09:00:01.000Z",
            utteranceId: "fresh-human:first",
            version: 1,
            speaker: {
              status: "attributed",
              personId: "person_jakob",
              confidence: "deterministic",
              basis: "provider-identity"
            },
            startedAt: "2026-08-08T08:59:58.000Z",
            endedAt: "2026-08-08T09:00:02.000Z",
            originalText: "I will prepare the release checklist.",
            language: "en"
          }
        ]
      });

      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "fresh-human:decision-correction",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:01:30.000Z",
            observedAt: "2026-08-08T09:01:31.000Z",
            participantId: "person_jakob",
            judgment: {
              kind: "correct",
              meetingItemId: "decision:human-protected-fresh-decision",
              correction: {
                statement: "Human-approved release process",
                status: "confirmed"
              }
            }
          }
        ]
      });

      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "fresh-human:correction",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:01:00.000Z",
            observedAt: "2026-08-08T09:01:01.000Z",
            participantId: "person_jakob",
            judgment: {
              kind: "correct",
              meetingItemId: "action:human-protected-fresh-action",
              correction: {
                statement: "Human-approved release checklist",
                status: "confirmed"
              }
            }
          }
        ]
      });

      const freshAnalysis = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "utterance-revised",
            observationId: "fresh-human:revised-utterance",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:02:00.000Z",
            observedAt: "2026-08-08T09:02:01.000Z",
            utteranceId: "fresh-human:first",
            replacesVersion: 1,
            version: 2,
            originalText: "The checklist should include a new deployment note.",
            language: "en"
          }
        ]
      });

      expect(freshAnalysis.analysisStatus).toBe("completed");
      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected snapshot result");
      }

      expect(snapshot.state.humanJudgmentItemIds).toEqual(
        expect.arrayContaining([
          "action:human-protected-fresh-action",
          "decision:human-protected-fresh-decision"
        ])
      );
      const action = snapshot.state.actionItems.find(
        (item) => item.id === "action:human-protected-fresh-action"
      );
      const decision = snapshot.state.decisions.find(
        (item) => item.id === "decision:human-protected-fresh-decision"
      );

      expect(action?.description).toBe("Human-approved release checklist");
      expect(action?.status).toBe("confirmed");
      expect(
        action?.provenance.evidence.some(
          (reference) => reference.source === "human-judgment"
        )
      ).toBe(true);
      expect(
        action?.provenance.evidence.some(
          (reference) =>
            reference.evidenceId === "evidence:transcript:fresh-human:first:v1"
        )
      ).toBe(false);
      expect(decision?.statement).toBe("Human-approved release process");
      expect(decision?.status).toBe("confirmed");
      expect(
        decision?.provenance.evidence.some(
          (reference) => reference.source === "human-judgment"
        )
      ).toBe(true);
      expect(
        decision?.provenance.evidence.some(
          (reference) =>
            reference.evidenceId === "evidence:transcript:fresh-human:first:v1"
        )
      ).toBe(false);
    } finally {
      await database.close();
    }
  });

  it("does not let a rejected observation rewrite canonical workspace configuration", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProgrammableReasoningModel(() => ({
        actionItems: [],
        decisions: [],
        openQuestions: [],
        risks: [],
        followUpIntentions: []
      }))
    });
    const canonicalWorkspace = {
      workspaceId: "workspace_config_safety",
      timezone: "Europe/Berlin"
    };

    try {
      await meetingIntelligence.observe({
        workspace: canonicalWorkspace,
        observations: [
          {
            type: "meeting-started",
            observationId: "workspace-config:seed",
            workspaceId: canonicalWorkspace.workspaceId,
            meetingId: "meeting_config_safety",
            occurredAt: "2026-08-08T09:00:00.000Z",
            observedAt: "2026-08-08T09:00:01.000Z",
            title: "Configuration safety",
            startedAt: "2026-08-08T09:00:00.000Z",
            languageMode: "en",
            participantIds: []
          }
        ]
      });

      const rejected = await meetingIntelligence.observe({
        workspace: {
          ...canonicalWorkspace,
          timezone: "America/Los_Angeles"
        },
        observations: [
          {
            type: "meeting-ended",
            observationId: "workspace-config:forged",
            workspaceId: "other-workspace",
            meetingId: "meeting_config_safety",
            occurredAt: "2026-08-08T09:01:00.000Z",
            observedAt: "2026-08-08T09:01:01.000Z",
            endedAt: "2026-08-08T09:01:00.000Z"
          }
        ]
      });

      expect(rejected.acceptedObservationIds).toEqual([]);
      expect(rejected.errors).toEqual([
        expect.objectContaining({ code: "invalid-observation" })
      ]);
      const stored = await database.query<{ timezone: string; config_json: string }>(
        `SELECT timezone, config_json FROM workspaces WHERE workspace_id = $1`,
        [canonicalWorkspace.workspaceId]
      );
      expect(stored.rows[0]).toEqual({
        timezone: "Europe/Berlin",
        config_json: JSON.stringify(canonicalWorkspace)
      });
    } finally {
      await database.close();
    }
  });

  it("does not let an invalid first delivery claim a workspace timezone", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProgrammableReasoningModel(() => ({
        actionItems: [],
        decisions: [],
        openQuestions: [],
        risks: [],
        followUpIntentions: []
      }))
    });
    const workspaceId = "workspace_first_delivery_config";
    const invalidWorkspace = {
      workspaceId,
      timezone: "America/Los_Angeles"
    };
    const canonicalWorkspace = {
      workspaceId,
      timezone: "Europe/Berlin"
    };

    try {
      const invalid = await meetingIntelligence.observe({
        workspace: invalidWorkspace,
        observations: [
          {
            type: "utterance-revised",
            observationId: "workspace-first-invalid:revision",
            workspaceId,
            meetingId: "meeting_first_delivery_config",
            occurredAt: "2026-08-08T09:00:00.000Z",
            observedAt: "2026-08-08T09:00:01.000Z",
            utteranceId: "missing-utterance",
            replacesVersion: 1,
            version: 2,
            originalText: "This source text has no original utterance.",
            language: "en"
          }
        ]
      });

      expect(invalid.acceptedObservationIds).toEqual([]);
      const beforeValidDelivery = await database.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count FROM workspaces WHERE workspace_id = $1`,
        [workspaceId]
      );
      expect(beforeValidDelivery.rows[0]?.count).toBe("0");

      await meetingIntelligence.observe({
        workspace: canonicalWorkspace,
        observations: [
          {
            type: "meeting-started",
            observationId: "workspace-first-valid:start",
            workspaceId,
            meetingId: "meeting_first_delivery_config",
            occurredAt: "2026-08-08T09:01:00.000Z",
            observedAt: "2026-08-08T09:01:01.000Z",
            title: "Canonical workspace configuration",
            startedAt: "2026-08-08T09:01:00.000Z",
            languageMode: "en",
            participantIds: []
          }
        ]
      });

      const stored = await database.query<{ config_json: string }>(
        `SELECT config_json FROM workspaces WHERE workspace_id = $1`,
        [workspaceId]
      );
      expect(stored.rows[0]?.config_json).toBe(JSON.stringify(canonicalWorkspace));
    } finally {
      await database.close();
    }
  });

  it("serializes competing first workspace configurations before acceptance", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProgrammableReasoningModel(() => ({
        actionItems: [],
        decisions: [],
        openQuestions: [],
        risks: [],
        followUpIntentions: []
      }))
    });
    const workspaceId = "workspace_competing_first_config";
    const berlin = { workspaceId, timezone: "Europe/Berlin" };
    const losAngeles = { workspaceId, timezone: "America/Los_Angeles" };

    const start = (workspace: typeof berlin, meetingId: string) =>
      meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "meeting-started",
            observationId: `competing-first:${meetingId}`,
            workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:00:00.000Z",
            observedAt: "2026-08-08T09:00:01.000Z",
            title: "Competing first configuration",
            startedAt: "2026-08-08T09:00:00.000Z",
            languageMode: "en",
            participantIds: []
          }
        ]
      });

    try {
      const [first, second] = await Promise.all([
        start(berlin, "meeting_competing_berlin"),
        start(losAngeles, "meeting_competing_los_angeles")
      ]);
      const updates = [first, second];
      const accepted = updates.filter(
        (update) => update.acceptedObservationIds.length > 0
      );
      const rejected = updates.filter((update) => update.errors.length > 0);

      expect(accepted).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.errors[0]).toMatchObject({
        code: "concurrent-update",
        retryable: true
      });
      const winningWorkspace = accepted[0] === first ? berlin : losAngeles;
      const stored = await database.query<{ config_json: string }>(
        `SELECT config_json FROM workspaces WHERE workspace_id = $1`,
        [workspaceId]
      );

      expect(stored.rows[0]?.config_json).toBe(JSON.stringify(winningWorkspace));
    } finally {
      await database.close();
    }
  });

  it("returns grounded changes after the requested Revision", async () => {
    const meetingIntelligence = await createHarness(
      new ProgrammableReasoningModel((request) => {
        const evidence = request.evidence[0];

        if (!evidence) {
          throw new Error("expected utterance evidence");
        }

        return {
          actionItems: [
            {
              stableKey: "release-checklist",
              description: "Prepare the release checklist",
              ownerId: "person_jakob",
              dueDate: {
                originalPhrase: null,
                normalizedDate: null,
                confidence: "unknown",
                timezone: "Europe/Berlin"
              },
              status: "confirmed",
              relatedDecisionIds: [],
              evidenceIds: [evidence.evidenceId],
              confidence: "high"
            }
          ],
          decisions: [],
          openQuestions: [],
          risks: [],
          followUpIntentions: []
        };
      })
    );
    const start = await meetingIntelligence.observe({
      workspace: {
        workspaceId: "workspace_luma",
        timezone: "Europe/Berlin"
      },
      observations: [
        {
          type: "meeting-started",
          observationId: "obs_catchup_start",
          workspaceId: "workspace_luma",
          meetingId: "meeting_catchup",
          occurredAt: "2026-06-26T10:00:00.000Z",
          observedAt: "2026-06-26T10:00:01.000Z",
          title: "Release Meeting",
          startedAt: "2026-06-26T10:00:00.000Z",
          languageMode: "en",
          participantIds: ["person_jakob"]
        }
      ]
    });
    await meetingIntelligence.observe({
      workspace: {
        workspaceId: "workspace_luma",
        timezone: "Europe/Berlin"
      },
      observations: [
        {
          type: "utterance-committed",
          observationId: "obs_catchup_utterance",
          workspaceId: "workspace_luma",
          meetingId: "meeting_catchup",
          occurredAt: "2026-06-26T10:05:00.000Z",
          observedAt: "2026-06-26T10:05:01.000Z",
          utteranceId: "utt_catchup",
          version: 1,
          speaker: {
            status: "attributed",
            personId: "person_jakob",
            confidence: "deterministic",
            basis: "provider-identity"
          },
          startedAt: "2026-06-26T10:04:58.000Z",
          endedAt: "2026-06-26T10:05:02.000Z",
          originalText: "I will prepare the release checklist.",
          language: "en"
        }
      ]
    });
    const snapshot = await meetingIntelligence.query({
      workspaceId: "workspace_luma",
      meetingId: "meeting_catchup",
      query: { type: "snapshot" }
    });

    if (snapshot.type !== "snapshot") {
      throw new Error("expected snapshot result");
    }

    const afterStart = await meetingIntelligence.query({
      workspaceId: "workspace_luma",
      meetingId: "meeting_catchup",
      query: {
        type: "catch-up",
        since: { type: "revision", value: start.revision }
      }
    });
    const afterCurrent = await meetingIntelligence.query({
      workspaceId: "workspace_luma",
      meetingId: "meeting_catchup",
      query: {
        type: "catch-up",
        since: { type: "revision", value: snapshot.state.revision }
      }
    });

    expect(afterStart.type === "catch-up" ? afterStart.answer.text : null).toContain(
      "Prepare the release checklist"
    );
    expect(afterCurrent).toEqual({
      type: "catch-up",
      answer: {
        text: "No grounded changes are available for this Meeting yet.",
        evidence: [],
        uncertainty: "insufficient-evidence"
      }
    });
  });

  it("observes mixed-language speech as evidence and returns a grounded action item without provider work", async () => {
    const meetingIntelligence = await createHarness(
      new ProgrammableReasoningModel((request) => {
        const evidence = request.evidence[0];

        if (!evidence) {
          throw new Error("expected utterance evidence");
        }

        return {
          actionItems: [
            {
              stableKey: "github-issue-owner",
              description: "Handle the GitHub Issue",
              ownerId: "person_jakob",
              dueDate: {
                originalPhrase: "bis Montag",
                normalizedDate: "2026-06-29",
                confidence: "normalized",
                timezone: "Europe/Berlin"
              },
              status: "confirmed",
              relatedDecisionIds: [],
              evidenceIds: [evidence.evidenceId],
              confidence: "high"
            }
          ],
          decisions: [],
          openQuestions: [],
          risks: [],
          followUpIntentions: []
        };
      })
    );

    await meetingIntelligence.observe({
      workspace: {
        workspaceId: "workspace_luma",
        timezone: "Europe/Berlin"
      },
      observations: [
        {
          type: "meeting-started",
          observationId: "obs_start",
          workspaceId: "workspace_luma",
          meetingId: "meeting_product",
          occurredAt: "2026-06-26T10:00:00.000Z",
          observedAt: "2026-06-26T10:00:01.000Z",
          title: "Product Meeting",
          startedAt: "2026-06-26T10:00:00.000Z",
          languageMode: "multilingual",
          participantIds: ["person_jakob", "person_philipp"]
        },
        {
          type: "utterance-committed",
          observationId: "obs_utterance_1",
          workspaceId: "workspace_luma",
          meetingId: "meeting_product",
          occurredAt: "2026-06-26T10:05:00.000Z",
          observedAt: "2026-06-26T10:05:01.000Z",
          utteranceId: "utt_1",
          version: 1,
          speaker: {
            status: "attributed",
            personId: "person_jakob",
            confidence: "deterministic",
            basis: "provider-identity"
          },
          startedAt: "2026-06-26T10:04:58.000Z",
          endedAt: "2026-06-26T10:05:02.000Z",
          originalText: "Jakob übernimmt das GitHub Issue bis Montag.",
          language: "mixed"
        }
      ]
    });

    const snapshot = await meetingIntelligence.query({
      workspaceId: "workspace_luma",
      meetingId: "meeting_product",
      query: {
        type: "snapshot"
      }
    });

    expect(snapshot.type).toBe("snapshot");

    if (snapshot.type !== "snapshot") {
      throw new Error("expected snapshot result");
    }

    expect(snapshot.state.revision).toBe(2);
    expect(snapshot.state.actionItems).toEqual([
      expect.objectContaining({
        description: "Handle the GitHub Issue",
        ownership: {
          status: "proposed",
          proposedOwnerPersonId: "person_jakob",
          confidence: "low",
          basis: "inferred-assignment"
        },
        ownerId: null,
        dueDate: "2026-06-29",
        dueDateConfidence: "normalized",
        status: "confirmed",
        externalReferences: []
      })
    ]);
    expect(snapshot.state.actionItems[0]?.provenance.evidence).toEqual([
      expect.objectContaining({
        source: "transcript",
        sourceObjectId: "utt_1",
        sourceVersion: "1",
        excerpt: "Jakob übernimmt das GitHub Issue bis Montag."
      })
    ]);
  });

  it("confirms a deterministic German speaker self-commitment for a general Action Item", async () => {
    const database = await createPgliteDatabase();
    const workspace = {
      workspaceId: "workspace_general_self_commitment",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_general_self_commitment";
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProgrammableReasoningModel((request) => {
        const evidence = request.evidence[0];

        if (!evidence) {
          throw new Error("expected transcript Evidence");
        }

        return {
          actionItems: [
            {
              stableKey: "german-self-commitment",
              description: "Complete the release checklist.",
              ownerId: "person_jakob",
              dueDate: {
                originalPhrase: null,
                normalizedDate: null,
                confidence: "unknown",
                timezone: "Europe/Berlin"
              },
              status: "candidate",
              relatedDecisionIds: [],
              evidenceIds: [evidence.evidenceId],
              confidence: "high"
            }
          ],
          decisions: [],
          openQuestions: [],
          risks: [],
          followUpIntentions: []
        };
      }),
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });

    try {
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "utterance-committed",
            observationId: "general-self-commitment:utterance",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:05:00.000Z",
            observedAt: "2026-08-08T09:05:01.000Z",
            utteranceId: "general-self-commitment:utt",
            version: 1,
            speaker: {
              status: "attributed",
              personId: "person_jakob",
              confidence: "deterministic",
              basis: "provider-identity"
            },
            startedAt: "2026-08-08T09:04:58.000Z",
            endedAt: "2026-08-08T09:05:02.000Z",
            originalText: "Ich mache das.",
            language: "de"
          }
        ]
      });

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "snapshot" }
      });
      const participantAnswer = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: {
          type: "freeform",
          text: "What does Jakob own?",
          participantId: "person_jakob"
        }
      });

      if (snapshot.type !== "snapshot" || participantAnswer.type !== "freeform") {
        throw new Error("expected Meeting snapshot and freeform answer");
      }

      expect(snapshot.state.actionItems).toEqual([
        expect.objectContaining({
          id: "action:german-self-commitment",
          ownerId: "person_jakob",
          ownership: {
            status: "confirmed",
            ownerPersonId: "person_jakob",
            confidence: "deterministic",
            basis: "self-commitment"
          }
        })
      ]);
      expect(participantAnswer.answer.text).toContain("confirmed owner person_jakob");
    } finally {
      await database.close();
    }
  });

  it("does not turn a refusal, question, or capability statement into confirmed self-ownership", async () => {
    const cases = [
      { text: "Ich mache das nicht.", language: "de" as const },
      { text: "Das mache ich nicht.", language: "de" as const },
      { text: "Ich übernehme das nie.", language: "de" as const },
      { text: "Das mache ich keinesfalls.", language: "de" as const },
      { text: "Ich übernehme keinerlei Verantwortung.", language: "de" as const },
      { text: "Ich mache das vielleicht.", language: "de" as const },
      { text: "Wenn ihr das wollt, mache ich das.", language: "de" as const },
      { text: "Ich mache das nur im Notfall.", language: "de" as const },
      { text: "Ich übernehme das bei Bedarf.", language: "de" as const },
      { text: "I can take that.", language: "en" as const },
      { text: "I will take no ownership of this.", language: "en" as const },
      { text: "Ich mache das?", language: "de" as const }
    ];

    for (const [index, scenario] of cases.entries()) {
      const database = await createPgliteDatabase();
      const workspace = {
        workspaceId: `workspace_non_commitment_owner_${index}`,
        timezone: "Europe/Berlin"
      };
      const meetingId = `meeting_non_commitment_owner_${index}`;
      const meetingIntelligence = createMeetingIntelligence({
        database,
        reasoningModel: new ProgrammableReasoningModel((request) => {
          const evidence = request.evidence[0];

          if (!evidence) {
            throw new Error("expected transcript Evidence");
          }

          return {
            actionItems: [
              {
                stableKey: `non-commitment-owner-${index}`,
                description: "Handle the release checklist.",
                ownerId: "person_jakob",
                dueDate: {
                  originalPhrase: null,
                  normalizedDate: null,
                  confidence: "unknown",
                  timezone: "Europe/Berlin"
                },
                status: "candidate",
                relatedDecisionIds: [],
                evidenceIds: [evidence.evidenceId],
                confidence: "high"
              }
            ],
            decisions: [],
            openQuestions: [],
            risks: [],
            followUpIntentions: []
          };
        }),
        now: () => new Date("2026-08-08T10:00:00.000Z")
      });

      try {
        await meetingIntelligence.observe({
          workspace,
          observations: [
            {
              type: "utterance-committed",
              observationId: `non-commitment-owner:${index}`,
              workspaceId: workspace.workspaceId,
              meetingId,
              occurredAt: "2026-08-08T09:05:00.000Z",
              observedAt: "2026-08-08T09:05:01.000Z",
              utteranceId: `non-commitment-owner:utt:${index}`,
              version: 1,
              speaker: {
                status: "attributed",
                personId: "person_jakob",
                confidence: "deterministic",
                basis: "provider-identity"
              },
              startedAt: "2026-08-08T09:04:58.000Z",
              endedAt: "2026-08-08T09:05:02.000Z",
              originalText: scenario.text,
              language: scenario.language
            }
          ]
        });
        const snapshot = await meetingIntelligence.query({
          workspaceId: workspace.workspaceId,
          meetingId,
          query: { type: "snapshot" }
        });

        if (snapshot.type !== "snapshot") {
          throw new Error("expected Meeting snapshot");
        }

        expect(snapshot.state.actionItems[0]).toMatchObject({
          ownerId: null,
          ownership: {
            status: "proposed",
            proposedOwnerPersonId: "person_jakob"
          }
        });
      } finally {
        await database.close();
      }
    }
  }, 40_000);

  it("does not strengthen a high-confidence speaker claim into deterministic self-ownership", async () => {
    const database = await createPgliteDatabase();
    const workspace = {
      workspaceId: "workspace_high_confidence_speaker",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_high_confidence_speaker";
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProgrammableReasoningModel((request) => {
        const evidence = request.evidence[0];

        if (!evidence) {
          throw new Error("expected transcript Evidence");
        }

        return {
          actionItems: [
            {
              stableKey: "high-confidence-speaker-owner",
              description: "Complete the release checklist.",
              ownerId: "person_jakob",
              dueDate: {
                originalPhrase: null,
                normalizedDate: null,
                confidence: "unknown",
                timezone: "Europe/Berlin"
              },
              status: "candidate",
              relatedDecisionIds: [],
              evidenceIds: [evidence.evidenceId],
              confidence: "high"
            }
          ],
          decisions: [],
          openQuestions: [],
          risks: [],
          followUpIntentions: []
        };
      }),
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });

    try {
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "utterance-committed",
            observationId: "high-confidence-speaker:utterance",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:05:00.000Z",
            observedAt: "2026-08-08T09:05:01.000Z",
            utteranceId: "high-confidence-speaker:utt",
            version: 1,
            speaker: {
              status: "attributed",
              personId: "person_jakob",
              confidence: "high",
              basis: "provider-identity"
            },
            startedAt: "2026-08-08T09:04:58.000Z",
            endedAt: "2026-08-08T09:05:02.000Z",
            originalText: "Ich mache das.",
            language: "de"
          }
        ]
      });
      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(snapshot.state.actionItems[0]).toMatchObject({
        ownerId: null,
        ownership: {
          status: "proposed",
          proposedOwnerPersonId: "person_jakob"
        }
      });
      expect(snapshot.state.participants).not.toContainEqual(
        expect.objectContaining({ personId: "person_jakob" })
      );
      expect(snapshot.state.actionItems[0]?.provenance.evidence).toEqual([
        expect.not.objectContaining({ participantId: "person_jakob" })
      ]);
    } finally {
      await database.close();
    }
  });

  it("keeps a model owner proposal out of a low-confidence speaker's participant view", async () => {
    const database = await createPgliteDatabase();
    const workspace = {
      workspaceId: "workspace_general_proposed_owner",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_general_proposed_owner";
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProgrammableReasoningModel((request) => {
        const evidence = request.evidence[0];

        if (!evidence) {
          throw new Error("expected transcript Evidence");
        }

        return {
          actionItems: [
            {
              stableKey: "low-confidence-owner-proposal",
              description: "Complete the release checklist.",
              ownerId: "person_jakob",
              dueDate: {
                originalPhrase: null,
                normalizedDate: null,
                confidence: "unknown",
                timezone: "Europe/Berlin"
              },
              status: "candidate",
              relatedDecisionIds: [],
              evidenceIds: [evidence.evidenceId],
              confidence: "high"
            }
          ],
          decisions: [],
          openQuestions: [],
          risks: [],
          followUpIntentions: []
        };
      }),
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });

    try {
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "utterance-committed",
            observationId: "general-proposed-owner:utterance",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:05:00.000Z",
            observedAt: "2026-08-08T09:05:01.000Z",
            utteranceId: "general-proposed-owner:utt",
            version: 1,
            speaker: {
              status: "unresolved",
              candidatePersonId: "person_jakob",
              confidence: "low",
              basis: "provider-speaker-label"
            },
            startedAt: "2026-08-08T09:04:58.000Z",
            endedAt: "2026-08-08T09:05:02.000Z",
            originalText: "Ich mache das.",
            language: "de"
          }
        ]
      });

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "snapshot" }
      });
      const generalAnswer = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "freeform", text: "What is the release checklist Action Item?" }
      });
      const participantAnswer = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: {
          type: "freeform",
          text: "What does Jakob own?",
          participantId: "person_jakob"
        }
      });

      if (
        snapshot.type !== "snapshot" ||
        generalAnswer.type !== "freeform" ||
        participantAnswer.type !== "freeform"
      ) {
        throw new Error("expected Meeting snapshot and freeform answers");
      }

      expect(snapshot.state.participants).toEqual([]);
      expect(snapshot.state.actionItems).toEqual([
        expect.objectContaining({
          id: "action:low-confidence-owner-proposal",
          ownerId: null,
          ownership: {
            status: "proposed",
            proposedOwnerPersonId: "person_jakob",
            confidence: "low",
            basis: "inferred-assignment"
          }
        })
      ]);
      expect(generalAnswer.answer.text).toContain("proposed owner person_jakob");
      expect(generalAnswer.answer.text).not.toContain("confirmed owner person_jakob");
      expect(participantAnswer).toEqual({
        type: "freeform",
        answer: {
          text: "I do not have enough evidence to answer that factually.",
          evidence: [],
          uncertainty: "insufficient-evidence"
        }
      });
    } finally {
      await database.close();
    }
  });

  it("does not duplicate Evidence or Meeting Items when an Observation is retried", async () => {
    let modelCalls = 0;
    const meetingIntelligence = await createHarness(
      new ProgrammableReasoningModel((request) => {
        modelCalls += 1;
        const evidence = request.evidence[0];

        if (!evidence) {
          throw new Error("expected utterance evidence");
        }

        return {
          actionItems: [
            {
              stableKey: "github-issue-owner",
              description: "Handle the GitHub Issue",
              ownerId: "person_jakob",
              dueDate: {
                originalPhrase: "bis Montag",
                normalizedDate: "2026-06-29",
                confidence: "normalized",
                timezone: "Europe/Berlin"
              },
              status: "confirmed",
              relatedDecisionIds: [],
              evidenceIds: [evidence.evidenceId],
              confidence: "high"
            }
          ],
          decisions: [],
          openQuestions: [],
          risks: [],
          followUpIntentions: []
        };
      })
    );

    const utterance = {
      type: "utterance-committed" as const,
      observationId: "obs_utterance_1",
      workspaceId: "workspace_luma",
      meetingId: "meeting_product",
      occurredAt: "2026-06-26T10:05:00.000Z",
      observedAt: "2026-06-26T10:05:01.000Z",
      utteranceId: "utt_1",
      version: 1,
      speaker: {
        status: "attributed",
        personId: "person_jakob",
        confidence: "deterministic",
        basis: "provider-identity"
      } as const,
      startedAt: "2026-06-26T10:04:58.000Z",
      endedAt: "2026-06-26T10:05:02.000Z",
      originalText: "Jakob übernimmt das GitHub Issue bis Montag.",
      language: "mixed" as const
    } satisfies Extract<MeetingObservation, { type: "utterance-committed" }>;

    await meetingIntelligence.observe({
      workspace: {
        workspaceId: "workspace_luma",
        timezone: "Europe/Berlin"
      },
      observations: [utterance]
    });
    const retry = await meetingIntelligence.observe({
      workspace: {
        workspaceId: "workspace_luma",
        timezone: "Europe/Berlin"
      },
      observations: [utterance]
    });

    const snapshot = await meetingIntelligence.query({
      workspaceId: "workspace_luma",
      meetingId: "meeting_product",
      query: {
        type: "snapshot"
      }
    });

    expect(retry.duplicateObservationIds).toEqual(["obs_utterance_1"]);
    expect(modelCalls).toBe(1);
    expect(snapshot.type).toBe("snapshot");

    if (snapshot.type !== "snapshot") {
      throw new Error("expected snapshot result");
    }

    expect(snapshot.state.revision).toBe(2);
    expect(snapshot.state.actionItems).toHaveLength(1);
    expect(snapshot.state.actionItems[0]?.provenance.evidence).toHaveLength(1);
  });

  it("does not consume an Observation id when application fails validation", async () => {
    const meetingIntelligence = await createHarness(
      new ProgrammableReasoningModel(() => ({
        actionItems: [],
        decisions: [],
        openQuestions: [],
        risks: [],
        followUpIntentions: []
      }))
    );
    const workspace = {
      workspaceId: "workspace_luma",
      timezone: "Europe/Berlin"
    };
    const invalidRevision = {
      type: "utterance-revised" as const,
      observationId: "obs_missing_utterance_revision",
      workspaceId: workspace.workspaceId,
      meetingId: "meeting_invalid_revision",
      occurredAt: "2026-06-26T10:06:00.000Z",
      observedAt: "2026-06-26T10:06:01.000Z",
      utteranceId: "utt_missing",
      replacesVersion: 1,
      version: 2,
      originalText: "This revision has no original utterance.",
      language: "en" as const
    };

    const firstAttempt = await meetingIntelligence.observe({
      workspace,
      observations: [invalidRevision]
    });
    const retry = await meetingIntelligence.observe({
      workspace,
      observations: [invalidRevision]
    });

    expect(firstAttempt.acceptedObservationIds).toEqual([]);
    expect(firstAttempt.duplicateObservationIds).toEqual([]);
    expect(retry.acceptedObservationIds).toEqual([]);
    expect(retry.duplicateObservationIds).toEqual([]);

    for (const update of [firstAttempt, retry]) {
      const invalidError = update.errors[0];

      if (!invalidError || invalidError.code !== "invalid-observation") {
        throw new Error("expected an invalid Observation error");
      }

      expect(invalidError.message).toContain("must replace an existing version");
    }
  });

  it("keeps an unresolved speaker out of Meeting participants and transcript Evidence", async () => {
    const database = await createPgliteDatabase();
    let evidenceForAnalysis: StructuredReasoningRequest<MeetingAnalysisProposalBatch>["evidence"] =
      [];
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProgrammableReasoningModel((request) => {
        evidenceForAnalysis = request.evidence;

        return {
          actionItems: [],
          decisions: [],
          openQuestions: [],
          risks: [],
          followUpIntentions: []
        };
      }),
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });
    const workspace = {
      workspaceId: "workspace_unresolved_speaker",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_unresolved_speaker";

    try {
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "meeting-started",
            observationId: "unresolved-speaker:start",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:00:00.000Z",
            observedAt: "2026-08-08T09:00:01.000Z",
            title: "Unresolved speaker",
            startedAt: "2026-08-08T09:00:00.000Z",
            languageMode: "de",
            participantIds: []
          },
          {
            type: "utterance-committed",
            observationId: "unresolved-speaker:utterance",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:05:00.000Z",
            observedAt: "2026-08-08T09:05:01.000Z",
            utteranceId: "unresolved-speaker:utt",
            version: 1,
            speaker: {
              status: "unresolved",
              candidatePersonId: "person_jakob",
              confidence: "low",
              basis: "provider-speaker-label"
            },
            startedAt: "2026-08-08T09:04:58.000Z",
            endedAt: "2026-08-08T09:05:02.000Z",
            originalText: "Ich mache das.",
            language: "de"
          }
        ]
      });

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected snapshot result");
      }

      expect(snapshot.state.participants).toEqual([]);
      expect(evidenceForAnalysis).toEqual([
        expect.objectContaining({
          evidenceId: "evidence:transcript:unresolved-speaker:utt:v1",
          source: "transcript",
          sourceObjectId: "unresolved-speaker:utt",
          sourceVersion: "1",
          excerpt: "Ich mache das."
        })
      ]);
      expect(evidenceForAnalysis[0]).not.toHaveProperty("participantId");
    } finally {
      await database.close();
    }
  });

  it("rejects a high-confidence provider speaker label as a confirmed speaker", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProgrammableReasoningModel(() => ({
        actionItems: [],
        decisions: [],
        openQuestions: [],
        risks: [],
        followUpIntentions: []
      })),
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });
    const workspace = {
      workspaceId: "workspace_unverified_speaker_label",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_unverified_speaker_label";

    try {
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "meeting-started",
            observationId: "unverified-speaker-label:start",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:00:00.000Z",
            observedAt: "2026-08-08T09:00:01.000Z",
            title: "Unverified speaker label",
            startedAt: "2026-08-08T09:00:00.000Z",
            languageMode: "de",
            participantIds: []
          }
        ]
      });
      const rejected = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "utterance-committed",
            observationId: "unverified-speaker-label:utterance",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:05:00.000Z",
            observedAt: "2026-08-08T09:05:01.000Z",
            utteranceId: "unverified-speaker-label:utt",
            version: 1,
            speaker: {
              status: "attributed",
              personId: "person_jakob",
              confidence: "high",
              basis: "provider-speaker-label"
            },
            startedAt: "2026-08-08T09:04:58.000Z",
            endedAt: "2026-08-08T09:05:02.000Z",
            originalText: "Ich mache das.",
            language: "de"
          } as unknown as Extract<MeetingObservation, { type: "utterance-committed" }>
        ]
      });
      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected snapshot result");
      }

      expect(rejected.acceptedObservationIds).toEqual([]);
      expect(rejected.errors).toHaveLength(1);
      expect(rejected.errors[0]).toMatchObject({
        code: "invalid-observation",
        observationId: "unverified-speaker-label:utterance"
      });
      const rejectedSpeakerLabel = rejected.errors[0];

      if (!rejectedSpeakerLabel || rejectedSpeakerLabel.code !== "invalid-observation") {
        throw new Error("expected invalid speaker-label observation");
      }

      expect(rejectedSpeakerLabel.message).toContain("unsupported attributed basis");
      expect(snapshot.state.participants).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("requires a durable Human Judgment instead of accepting a caller-claimed Human speaker confirmation", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProgrammableReasoningModel(() => ({
        actionItems: [],
        decisions: [],
        openQuestions: [],
        risks: [],
        followUpIntentions: []
      })),
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });
    const workspace = {
      workspaceId: "workspace_forged_human_speaker_confirmation",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_forged_human_speaker_confirmation";

    try {
      const rejected = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "utterance-committed",
            observationId: "forged-human-speaker-confirmation:utterance",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:05:00.000Z",
            observedAt: "2026-08-08T09:05:01.000Z",
            utteranceId: "forged-human-speaker-confirmation:utt",
            version: 1,
            speaker: {
              status: "attributed",
              personId: "person_jakob",
              confidence: "deterministic",
              basis: "human-confirmation"
            },
            startedAt: "2026-08-08T09:04:58.000Z",
            endedAt: "2026-08-08T09:05:02.000Z",
            originalText: "Ich mache das.",
            language: "de"
          }
        ]
      });

      expect(rejected.acceptedObservationIds).toEqual([]);
      expect(rejected.errors).toHaveLength(1);
      const rejectedError = rejected.errors[0];

      if (!rejectedError || rejectedError.code !== "invalid-observation") {
        throw new Error("expected an invalid caller-claimed Human attribution");
      }

      expect(rejectedError.observationId).toBe(
        "forged-human-speaker-confirmation:utterance"
      );
      expect(rejectedError.message).toContain("resolve-speaker-attribution");
    } finally {
      await database.close();
    }
  });

  it("revises a legacy speaker id as unresolved rather than upgrading it to a participant", async () => {
    const database = await createPgliteDatabase();
    let evidenceForAnalysis: StructuredReasoningRequest<MeetingAnalysisProposalBatch>["evidence"] =
      [];
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProgrammableReasoningModel((request) => {
        evidenceForAnalysis = request.evidence;

        return {
          actionItems: [],
          decisions: [],
          openQuestions: [],
          risks: [],
          followUpIntentions: []
        };
      }),
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });
    const workspace = {
      workspaceId: "workspace_legacy_speaker",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_legacy_speaker";

    try {
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "meeting-started",
            observationId: "legacy-speaker:start",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:00:00.000Z",
            observedAt: "2026-08-08T09:00:01.000Z",
            title: "Legacy speaker attribution",
            startedAt: "2026-08-08T09:00:00.000Z",
            languageMode: "de",
            participantIds: []
          }
        ]
      });
      await database.query(
        `INSERT INTO utterance_versions (
          workspace_id, meeting_id, utterance_id, version, speaker_id,
          speaker_attribution_json, started_at, ended_at, original_text, language,
          evidence_id, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          workspace.workspaceId,
          meetingId,
          "legacy-speaker:utt",
          1,
          "person_jakob",
          null,
          "2026-08-08T09:04:58.000Z",
          "2026-08-08T09:05:02.000Z",
          "Ich mache das.",
          "de",
          "evidence:transcript:legacy-speaker:utt:v1",
          "2026-08-08T09:05:01.000Z"
        ]
      );

      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "utterance-revised",
            observationId: "legacy-speaker:revision",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:06:00.000Z",
            observedAt: "2026-08-08T09:06:01.000Z",
            utteranceId: "legacy-speaker:utt",
            replacesVersion: 1,
            version: 2,
            originalText: "Ich mache das morgen.",
            language: "de"
          }
        ]
      });

      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "snapshot" }
      });
      const revisedUtterance = await database.query<{
        speaker_id: string | null;
        speaker_attribution_json: string | null;
      }>(
        `SELECT speaker_id, speaker_attribution_json
           FROM utterance_versions
          WHERE workspace_id = $1 AND meeting_id = $2
            AND utterance_id = $3 AND version = $4`,
        [workspace.workspaceId, meetingId, "legacy-speaker:utt", 2]
      );
      const persistedEvidence = await database.query<{ reference_json: string }>(
        `SELECT reference_json
           FROM evidence
          WHERE workspace_id = $1 AND meeting_id = $2 AND evidence_id = $3`,
        [workspace.workspaceId, meetingId, "evidence:transcript:legacy-speaker:utt:v2"]
      );

      if (snapshot.type !== "snapshot") {
        throw new Error("expected snapshot result");
      }

      expect(snapshot.state.participants).toEqual([]);
      expect(evidenceForAnalysis[0]).not.toHaveProperty("participantId");
      expect(revisedUtterance.rows).toEqual([
        {
          speaker_id: null,
          speaker_attribution_json: JSON.stringify({
            status: "unresolved",
            candidatePersonId: null,
            confidence: "unknown",
            basis: "legacy-unverified"
          })
        }
      ]);
      const persistedEvidenceReference: unknown = JSON.parse(
        persistedEvidence.rows[0]?.reference_json ?? "{}"
      );
      expect(persistedEvidenceReference).not.toHaveProperty("participantId");
    } finally {
      await database.close();
    }
  });

  it("rejects a Human speaker correction for a nonexistent utterance version", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProgrammableReasoningModel(() => ({
        actionItems: [],
        decisions: [],
        openQuestions: [],
        risks: [],
        followUpIntentions: []
      })),
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });
    const workspace = {
      workspaceId: "workspace_detached_speaker_correction",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_detached_speaker_correction";

    try {
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "meeting-started",
            observationId: "detached-speaker-correction:start",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:00:00.000Z",
            observedAt: "2026-08-08T09:00:01.000Z",
            title: "Detached speaker correction",
            startedAt: "2026-08-08T09:00:00.000Z",
            languageMode: "de",
            participantIds: []
          }
        ]
      });
      const rejected = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "detached-speaker-correction:resolve",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:05:00.000Z",
            observedAt: "2026-08-08T09:05:01.000Z",
            participantId: "person_jakob",
            judgment: {
              kind: "resolve-speaker-attribution",
              utteranceId: "missing-utterance",
              version: 1,
              personId: "person_philipp"
            }
          }
        ]
      });
      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "snapshot" }
      });

      if (snapshot.type !== "snapshot") {
        throw new Error("expected snapshot result");
      }

      expect(rejected.acceptedObservationIds).toEqual([]);
      expect(rejected.errors).toHaveLength(1);
      expect(rejected.errors[0]).toMatchObject({
        code: "invalid-observation",
        observationId: "detached-speaker-correction:resolve"
      });
      const rejectedSpeakerCorrection = rejected.errors[0];

      if (
        !rejectedSpeakerCorrection ||
        rejectedSpeakerCorrection.code !== "invalid-observation"
      ) {
        throw new Error("expected invalid speaker correction observation");
      }

      expect(rejectedSpeakerCorrection.message).toContain(
        "must target an existing versioned utterance"
      );
      expect(snapshot.state.speakerAttributionHumanResolutions).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("keeps a Human speaker correction as an overlay when the transcript later revises", async () => {
    const database = await createPgliteDatabase();
    const workspace = {
      workspaceId: "workspace_speaker_correction_revision_overlay",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_speaker_correction_revision_overlay";
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProgrammableReasoningModel(() => ({
        actionItems: [],
        decisions: [],
        openQuestions: [],
        risks: [],
        followUpIntentions: []
      })),
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });

    try {
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "utterance-committed",
            observationId: "speaker-overlay:v1",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:05:00.000Z",
            observedAt: "2026-08-08T09:05:01.000Z",
            utteranceId: "speaker-overlay:utt",
            version: 1,
            speaker: {
              status: "attributed",
              personId: "person_jakob",
              confidence: "deterministic",
              basis: "provider-identity"
            },
            startedAt: "2026-08-08T09:04:58.000Z",
            endedAt: "2026-08-08T09:05:02.000Z",
            originalText: "Ich mache das.",
            language: "de"
          },
          {
            type: "human-judgment-recorded",
            observationId: "speaker-overlay:correct-v1",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:06:00.000Z",
            observedAt: "2026-08-08T09:06:01.000Z",
            participantId: "person_philipp",
            judgment: {
              kind: "resolve-speaker-attribution",
              utteranceId: "speaker-overlay:utt",
              version: 1,
              personId: "person_philipp"
            }
          },
          {
            type: "utterance-revised",
            observationId: "speaker-overlay:v2",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:07:00.000Z",
            observedAt: "2026-08-08T09:07:01.000Z",
            utteranceId: "speaker-overlay:utt",
            replacesVersion: 1,
            version: 2,
            originalText: "Ich mache das bis Freitag.",
            language: "de"
          }
        ]
      });
      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "snapshot" }
      });
      const stored = await database.query<{ speaker_attribution_json: string }>(
        `SELECT speaker_attribution_json
           FROM utterance_versions
          WHERE workspace_id = $1 AND meeting_id = $2
            AND utterance_id = $3 AND version = 2`,
        [workspace.workspaceId, meetingId, "speaker-overlay:utt"]
      );
      const activeEvidence = await database.query<{ reference_json: string }>(
        `SELECT reference_json
           FROM evidence
          WHERE workspace_id = $1 AND meeting_id = $2
            AND evidence_id = $3 AND active = TRUE`,
        [workspace.workspaceId, meetingId, "evidence:transcript:speaker-overlay:utt:v2"]
      );

      if (snapshot.type !== "snapshot") {
        throw new Error("expected Meeting snapshot");
      }

      expect(stored.rows[0]?.speaker_attribution_json).toBe(
        JSON.stringify({
          status: "attributed",
          personId: "person_jakob",
          confidence: "deterministic",
          basis: "provider-identity"
        })
      );
      expect(snapshot.state.participants).toEqual([
        { personId: "person_philipp", joinedAt: null, leftAt: null }
      ]);
      const activeEvidenceReference: unknown = JSON.parse(
        activeEvidence.rows[0]?.reference_json ?? "{}"
      );

      expect(activeEvidenceReference).toMatchObject({
        source: "transcript",
        sourceObjectId: "speaker-overlay:utt",
        sourceVersion: "2",
        participantId: "person_philipp"
      });
    } finally {
      await database.close();
    }
  });

  it("reprojects active revised speaker Evidence and Action Item provenance after a Human correction", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProgrammableReasoningModel(
        actionItemFromTranscriptUnlessHumanCorrection
      ),
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });
    const workspace = {
      workspaceId: "workspace_speaker_reprojection",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_speaker_reprojection";

    try {
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "meeting-started",
            observationId: "speaker-reprojection:start",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:00:00.000Z",
            observedAt: "2026-08-08T09:00:01.000Z",
            title: "Speaker reprojection",
            startedAt: "2026-08-08T09:00:00.000Z",
            languageMode: "de",
            participantIds: []
          },
          {
            type: "utterance-committed",
            observationId: "speaker-reprojection:source-v1",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:05:00.000Z",
            observedAt: "2026-08-08T09:05:01.000Z",
            utteranceId: "speaker-reprojection:utt",
            version: 1,
            speaker: {
              status: "attributed",
              personId: "person_jakob",
              confidence: "deterministic",
              basis: "provider-identity"
            },
            startedAt: "2026-08-08T09:04:58.000Z",
            endedAt: "2026-08-08T09:05:02.000Z",
            originalText: "Ich mache das.",
            language: "de"
          }
        ]
      });
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "utterance-revised",
            observationId: "speaker-reprojection:source-v2",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:06:00.000Z",
            observedAt: "2026-08-08T09:06:01.000Z",
            utteranceId: "speaker-reprojection:utt",
            replacesVersion: 1,
            version: 2,
            originalText: "Ich mache das morgen.",
            language: "de"
          }
        ]
      });
      const correction = await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "speaker-reprojection:correct-v1",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:07:00.000Z",
            observedAt: "2026-08-08T09:07:01.000Z",
            participantId: "person_jakob",
            judgment: {
              kind: "resolve-speaker-attribution",
              utteranceId: "speaker-reprojection:utt",
              version: 1,
              personId: "person_philipp"
            }
          }
        ]
      });
      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "snapshot" }
      });
      const sourceVersion = await database.query<{
        speaker_id: string | null;
        speaker_attribution_json: string | null;
      }>(
        `SELECT speaker_id, speaker_attribution_json
           FROM utterance_versions
          WHERE workspace_id = $1 AND meeting_id = $2
            AND utterance_id = $3 AND version = $4`,
        [workspace.workspaceId, meetingId, "speaker-reprojection:utt", 1]
      );
      const activeEvidence = await database.query<{ reference_json: string }>(
        `SELECT reference_json
           FROM evidence
          WHERE workspace_id = $1 AND meeting_id = $2 AND evidence_id = $3`,
        [
          workspace.workspaceId,
          meetingId,
          "evidence:transcript:speaker-reprojection:utt:v2"
        ]
      );
      const humanCorrectionEvidence = await database.query<{ reference_json: string }>(
        `SELECT reference_json
           FROM evidence
          WHERE workspace_id = $1
            AND meeting_id = $2
            AND source = 'human-judgment'
            AND source_object_id = $3
            AND source_version = $4`,
        [
          workspace.workspaceId,
          meetingId,
          "speaker-reprojection:utt:v1",
          "speaker-reprojection:correct-v1"
        ]
      );

      if (snapshot.type !== "snapshot") {
        throw new Error("expected snapshot result");
      }

      const actionItem = snapshot.state.actionItems.find(
        (candidate) => candidate.id === "action:speaker-attribution-provenance"
      );

      if (!actionItem) {
        throw new Error("expected Action Item derived from the revised transcript");
      }

      const activeEvidenceReference: unknown = JSON.parse(
        activeEvidence.rows[0]?.reference_json ?? "{}"
      );
      const humanCorrectionEvidenceReference: unknown = JSON.parse(
        humanCorrectionEvidence.rows[0]?.reference_json ?? "{}"
      );

      expect(correction.acceptedObservationIds).toEqual([
        "speaker-reprojection:correct-v1"
      ]);
      expect(snapshot.state.participants).toEqual([
        { personId: "person_philipp", joinedAt: null, leftAt: null }
      ]);
      expect(sourceVersion.rows).toEqual([
        {
          speaker_id: "person_jakob",
          speaker_attribution_json: JSON.stringify({
            status: "attributed",
            personId: "person_jakob",
            confidence: "deterministic",
            basis: "provider-identity"
          })
        }
      ]);
      expect(activeEvidenceReference).toMatchObject({
        source: "transcript",
        sourceObjectId: "speaker-reprojection:utt",
        sourceVersion: "2",
        participantId: "person_philipp"
      });
      expect(humanCorrectionEvidenceReference).toMatchObject({
        source: "human-judgment",
        participantId: "person_jakob"
      });
      expect(actionItem.provenance.evidence).toEqual([
        expect.objectContaining({
          evidenceId: "evidence:transcript:speaker-reprojection:utt:v2",
          participantId: "person_philipp"
        })
      ]);
      expect(actionItem.provenance.evidence).not.toContainEqual(
        expect.objectContaining({ participantId: "person_jakob" })
      );
      expect(actionItem).toMatchObject({
        ownership: {
          status: "confirmed",
          ownerPersonId: "person_philipp",
          confidence: "deterministic",
          basis: "self-commitment"
        },
        ownerId: "person_philipp"
      });
    } finally {
      await database.close();
    }
  });

  it("keeps a directly observed attendee when Human Judgment makes their speaker attribution unresolved", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProgrammableReasoningModel(
        actionItemFromTranscriptUnlessHumanCorrection
      ),
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });
    const workspace = {
      workspaceId: "workspace_direct_attendee_speaker_correction",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_direct_attendee_speaker_correction";
    const startedAt = "2026-08-08T09:00:00.000Z";

    try {
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "meeting-started",
            observationId: "direct-attendee-correction:start",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: startedAt,
            observedAt: "2026-08-08T09:00:01.000Z",
            title: "Direct attendee speaker correction",
            startedAt,
            languageMode: "de",
            participantIds: ["person_jakob"]
          },
          {
            type: "utterance-committed",
            observationId: "direct-attendee-correction:source",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:05:00.000Z",
            observedAt: "2026-08-08T09:05:01.000Z",
            utteranceId: "direct-attendee-correction:utt",
            version: 1,
            speaker: {
              status: "attributed",
              personId: "person_jakob",
              confidence: "deterministic",
              basis: "provider-identity"
            },
            startedAt: "2026-08-08T09:04:58.000Z",
            endedAt: "2026-08-08T09:05:02.000Z",
            originalText: "Ich mache das.",
            language: "de"
          }
        ]
      });
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "human-judgment-recorded",
            observationId: "direct-attendee-correction:unresolved",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:06:00.000Z",
            observedAt: "2026-08-08T09:06:01.000Z",
            participantId: "person_philipp",
            judgment: {
              kind: "resolve-speaker-attribution",
              utteranceId: "direct-attendee-correction:utt",
              version: 1,
              personId: null
            }
          }
        ]
      });
      const snapshot = await meetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "snapshot" }
      });
      const activeEvidence = await database.query<{ reference_json: string }>(
        `SELECT reference_json
           FROM evidence
          WHERE workspace_id = $1 AND meeting_id = $2 AND evidence_id = $3`,
        [
          workspace.workspaceId,
          meetingId,
          "evidence:transcript:direct-attendee-correction:utt:v1"
        ]
      );
      const humanCorrectionEvidence = await database.query<{ reference_json: string }>(
        `SELECT reference_json
           FROM evidence
          WHERE workspace_id = $1
            AND meeting_id = $2
            AND source = 'human-judgment'
            AND source_object_id = $3
            AND source_version = $4`,
        [
          workspace.workspaceId,
          meetingId,
          "direct-attendee-correction:utt:v1",
          "direct-attendee-correction:unresolved"
        ]
      );

      if (snapshot.type !== "snapshot") {
        throw new Error("expected snapshot result");
      }

      const actionItem = snapshot.state.actionItems.find(
        (candidate) => candidate.id === "action:speaker-attribution-provenance"
      );

      if (!actionItem) {
        throw new Error("expected Action Item derived from the transcript");
      }

      const activeEvidenceReference: unknown = JSON.parse(
        activeEvidence.rows[0]?.reference_json ?? "{}"
      );
      const humanCorrectionEvidenceReference: unknown = JSON.parse(
        humanCorrectionEvidence.rows[0]?.reference_json ?? "{}"
      );

      expect(snapshot.state.participants).toEqual([
        { personId: "person_jakob", joinedAt: startedAt, leftAt: null }
      ]);
      expect(snapshot.state.speakerInferredParticipantIds).toEqual([]);
      expect(activeEvidenceReference).not.toHaveProperty("participantId");
      expect(humanCorrectionEvidenceReference).toMatchObject({
        source: "human-judgment",
        participantId: "person_philipp"
      });
      expect(actionItem.provenance.evidence[0]).not.toHaveProperty("participantId");
      expect(actionItem).toMatchObject({
        ownership: {
          status: "unresolved",
          reason: "missing-speaker",
          likelyOwnerPersonId: null
        },
        ownerId: null
      });
    } finally {
      await database.close();
    }
  });

  it("fails closed when reopening legacy speaker rows without attribution JSON", async () => {
    const database = await createPgliteDatabase();
    const workspace = {
      workspaceId: "workspace_legacy_speaker_reopen",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_legacy_speaker_reopen";
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProgrammableReasoningModel(
        actionItemFromTranscriptUnlessHumanCorrection
      ),
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });

    try {
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "utterance-committed",
            observationId: "legacy-speaker-reopen:source",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T09:05:00.000Z",
            observedAt: "2026-08-08T09:05:01.000Z",
            utteranceId: "legacy-speaker-reopen:utt",
            version: 1,
            speaker: {
              status: "attributed",
              personId: "person_jakob",
              confidence: "deterministic",
              basis: "provider-identity"
            },
            startedAt: "2026-08-08T09:04:58.000Z",
            endedAt: "2026-08-08T09:05:02.000Z",
            originalText: "Ich mache das.",
            language: "de"
          }
        ]
      });
      await database.query(
        `UPDATE utterance_versions
            SET speaker_attribution_json = NULL
          WHERE workspace_id = $1 AND meeting_id = $2
            AND utterance_id = $3 AND version = $4`,
        [workspace.workspaceId, meetingId, "legacy-speaker-reopen:utt", 1]
      );
      const reopenedMeetingIntelligence = createMeetingIntelligence({
        database,
        reasoningModel: new ProgrammableReasoningModel(noMeetingAnalysisProposals),
        now: () => new Date("2026-08-08T10:00:00.000Z")
      });
      const snapshot = await reopenedMeetingIntelligence.query({
        workspaceId: workspace.workspaceId,
        meetingId,
        query: { type: "snapshot" }
      });
      const legacyRow = await database.query<{
        speaker_id: string | null;
        speaker_attribution_json: string | null;
      }>(
        `SELECT speaker_id, speaker_attribution_json
           FROM utterance_versions
          WHERE workspace_id = $1 AND meeting_id = $2
            AND utterance_id = $3 AND version = $4`,
        [workspace.workspaceId, meetingId, "legacy-speaker-reopen:utt", 1]
      );

      if (snapshot.type !== "snapshot") {
        throw new Error("expected snapshot result");
      }

      const actionItem = snapshot.state.actionItems.find(
        (candidate) => candidate.id === "action:speaker-attribution-provenance"
      );

      if (!actionItem) {
        throw new Error("expected Action Item derived from the legacy transcript");
      }

      expect(legacyRow.rows).toEqual([
        { speaker_id: "person_jakob", speaker_attribution_json: null }
      ]);
      expect(snapshot.state.participants).toEqual([]);
      expect(snapshot.state.speakerInferredParticipantIds).toEqual([]);
      expect(actionItem.provenance.evidence[0]).not.toHaveProperty("participantId");
    } finally {
      await database.close();
    }
  });

  it("reconsiders Meeting Items when a transcript utterance is revised", async () => {
    const meetingIntelligence = await createHarness(
      new ProgrammableReasoningModel((request) => {
        const evidence = request.evidence[0];

        if (!evidence?.excerpt) {
          throw new Error("expected utterance evidence");
        }

        const ownerId = evidence.excerpt.includes("Philipp")
          ? "person_philipp"
          : "person_jakob";

        return {
          actionItems: [
            {
              stableKey: "github-issue-owner",
              description: "Handle the GitHub Issue",
              ownerId,
              dueDate: {
                originalPhrase: null,
                normalizedDate: null,
                confidence: "unknown",
                timezone: "Europe/Berlin"
              },
              status: "confirmed",
              relatedDecisionIds: [],
              evidenceIds: [evidence.evidenceId],
              confidence: "high"
            }
          ],
          decisions: [],
          openQuestions: [],
          risks: [],
          followUpIntentions: []
        };
      })
    );

    await meetingIntelligence.observe({
      workspace: {
        workspaceId: "workspace_luma",
        timezone: "Europe/Berlin"
      },
      observations: [
        {
          type: "utterance-committed",
          observationId: "obs_utterance_1",
          workspaceId: "workspace_luma",
          meetingId: "meeting_product",
          occurredAt: "2026-06-26T10:05:00.000Z",
          observedAt: "2026-06-26T10:05:01.000Z",
          utteranceId: "utt_1",
          version: 1,
          speaker: {
            status: "attributed",
            personId: "person_jakob",
            confidence: "deterministic",
            basis: "provider-identity"
          },
          startedAt: "2026-06-26T10:04:58.000Z",
          endedAt: "2026-06-26T10:05:02.000Z",
          originalText: "Jakob übernimmt das Issue.",
          language: "de"
        }
      ]
    });
    await meetingIntelligence.observe({
      workspace: {
        workspaceId: "workspace_luma",
        timezone: "Europe/Berlin"
      },
      observations: [
        {
          type: "utterance-revised",
          observationId: "obs_utterance_1_revision",
          workspaceId: "workspace_luma",
          meetingId: "meeting_product",
          occurredAt: "2026-06-26T10:06:00.000Z",
          observedAt: "2026-06-26T10:06:01.000Z",
          utteranceId: "utt_1",
          replacesVersion: 1,
          version: 2,
          originalText: "Philipp übernimmt das Issue.",
          language: "de"
        }
      ]
    });

    const snapshot = await meetingIntelligence.query({
      workspaceId: "workspace_luma",
      meetingId: "meeting_product",
      query: {
        type: "snapshot"
      }
    });

    expect(snapshot.type).toBe("snapshot");

    if (snapshot.type !== "snapshot") {
      throw new Error("expected snapshot result");
    }

    expect(snapshot.state.actionItems).toHaveLength(1);
    expect(snapshot.state.actionItems[0]).toEqual(
      expect.objectContaining({
        ownerId: null,
        ownership: {
          status: "proposed",
          proposedOwnerPersonId: "person_philipp",
          confidence: "low",
          basis: "inferred-assignment"
        }
      })
    );
    expect(snapshot.state.actionItems[0]?.provenance.evidence).toEqual([
      expect.objectContaining({
        sourceObjectId: "utt_1",
        sourceVersion: "2",
        excerpt: "Philipp übernimmt das Issue."
      })
    ]);
  });

  it("lets Human Judgment reject an AI-proposed candidate Decision before conclusion", async () => {
    const meetingIntelligence = await createHarness(
      new ProgrammableReasoningModel((request) => {
        const evidence = request.evidence[0];

        if (!evidence) {
          throw new Error("expected utterance evidence");
        }

        return {
          actionItems: [],
          decisions: [
            {
              stableKey: "linear-maybe",
              statement: "Use Linear for work tracking",
              rationale: ["A participant mentioned Linear as a possibility."],
              status: "candidate",
              supportingParticipantIds: [],
              objectingParticipantIds: [],
              relatedTopicIds: [],
              evidenceIds: [evidence.evidenceId],
              confidence: "medium"
            }
          ],
          openQuestions: [],
          risks: [],
          followUpIntentions: []
        };
      })
    );

    await meetingIntelligence.observe({
      workspace: {
        workspaceId: "workspace_luma",
        timezone: "Europe/Berlin"
      },
      observations: [
        {
          type: "utterance-committed",
          observationId: "obs_decision_candidate",
          workspaceId: "workspace_luma",
          meetingId: "meeting_product",
          occurredAt: "2026-06-26T10:05:00.000Z",
          observedAt: "2026-06-26T10:05:01.000Z",
          utteranceId: "utt_decision",
          version: 1,
          speaker: {
            status: "attributed",
            personId: "person_jakob",
            confidence: "deterministic",
            basis: "provider-identity"
          },
          startedAt: "2026-06-26T10:04:58.000Z",
          endedAt: "2026-06-26T10:05:02.000Z",
          originalText: "Wir könnten vielleicht Linear verwenden.",
          language: "de"
        }
      ]
    });
    await meetingIntelligence.observe({
      workspace: {
        workspaceId: "workspace_luma",
        timezone: "Europe/Berlin"
      },
      observations: [
        {
          type: "human-judgment-recorded",
          observationId: "obs_reject_decision",
          workspaceId: "workspace_luma",
          meetingId: "meeting_product",
          occurredAt: "2026-06-26T10:06:00.000Z",
          observedAt: "2026-06-26T10:06:01.000Z",
          participantId: "person_jakob",
          judgment: {
            kind: "reject",
            meetingItemId: "decision:linear-maybe",
            reason: "It was only a possibility, not a decision."
          }
        }
      ]
    });

    const conclusion = await meetingIntelligence.conclude({
      workspaceId: "workspace_luma",
      meetingId: "meeting_product"
    });

    expect(conclusion.decisions).toEqual([
      expect.objectContaining({
        id: "decision:linear-maybe",
        status: "rejected"
      })
    ]);
    expect(conclusion.decisions.some((decision) => decision.status === "confirmed")).toBe(
      false
    );
  });

  it("persists Evidence and defers analysis when the ReasoningModel is unavailable", async () => {
    const meetingIntelligence = await createHarness({
      generateStructured() {
        return Promise.reject(new Error("model timeout"));
      }
    });

    const update = await meetingIntelligence.observe({
      workspace: {
        workspaceId: "workspace_luma",
        timezone: "Europe/Berlin"
      },
      observations: [
        {
          type: "utterance-committed",
          observationId: "obs_utterance_1",
          workspaceId: "workspace_luma",
          meetingId: "meeting_product",
          occurredAt: "2026-06-26T10:05:00.000Z",
          observedAt: "2026-06-26T10:05:01.000Z",
          utteranceId: "utt_1",
          version: 1,
          speaker: {
            status: "attributed",
            personId: "person_jakob",
            confidence: "deterministic",
            basis: "provider-identity"
          },
          startedAt: "2026-06-26T10:04:58.000Z",
          endedAt: "2026-06-26T10:05:02.000Z",
          originalText: "Jakob übernimmt das GitHub Issue bis Montag.",
          language: "mixed"
        }
      ]
    });

    const snapshot = await meetingIntelligence.query({
      workspaceId: "workspace_luma",
      meetingId: "meeting_product",
      query: {
        type: "snapshot"
      }
    });

    expect(update.analysisStatus).toBe("deferred");
    expect(update.errors).toEqual([
      {
        code: "analysis-temporarily-unavailable",
        retryable: true
      }
    ]);
    expect(snapshot.type).toBe("snapshot");

    if (snapshot.type !== "snapshot") {
      throw new Error("expected snapshot result");
    }

    expect(snapshot.state.revision).toBe(1);
    expect(snapshot.state.actionItems).toEqual([]);
  });

  it("uses the Meeting majority language for a Conclusion when no language is requested", async () => {
    const meetingIntelligence = await createHarness(
      new ProgrammableReasoningModel(() => ({
        actionItems: [],
        decisions: [],
        openQuestions: [],
        risks: [],
        followUpIntentions: []
      }))
    );

    await meetingIntelligence.observe({
      workspace: {
        workspaceId: "workspace_luma",
        timezone: "Europe/Berlin",
        outputLanguagePolicy: "meeting-majority"
      },
      observations: [
        {
          type: "meeting-started",
          observationId: "obs_german_start",
          workspaceId: "workspace_luma",
          meetingId: "meeting_german",
          occurredAt: "2026-06-26T10:00:00.000Z",
          observedAt: "2026-06-26T10:00:01.000Z",
          title: "Produktbesprechung",
          startedAt: "2026-06-26T10:00:00.000Z",
          languageMode: "de",
          participantIds: ["person_jakob"]
        },
        {
          type: "utterance-committed",
          observationId: "obs_german_utterance",
          workspaceId: "workspace_luma",
          meetingId: "meeting_german",
          occurredAt: "2026-06-26T10:05:00.000Z",
          observedAt: "2026-06-26T10:05:01.000Z",
          utteranceId: "utt_german",
          version: 1,
          speaker: {
            status: "attributed",
            personId: "person_jakob",
            confidence: "deterministic",
            basis: "provider-identity"
          },
          startedAt: "2026-06-26T10:04:58.000Z",
          endedAt: "2026-06-26T10:05:02.000Z",
          originalText: "Wir veröffentlichen die neue Version am Montag.",
          language: "de"
        }
      ]
    });

    const conclusion = await meetingIntelligence.conclude({
      workspaceId: "workspace_luma",
      meetingId: "meeting_german"
    });

    expect(conclusion.outputLanguage).toBe("de");
    expect(conclusion.summary.brief).toBe(
      "Das Meeting hat noch keine belegten Action Items."
    );
  });

  it("uses the declared Meeting language before the first Utterance", async () => {
    const meetingIntelligence = await createHarness(
      new ProgrammableReasoningModel(() => ({
        actionItems: [],
        decisions: [],
        openQuestions: [],
        risks: [],
        followUpIntentions: []
      }))
    );

    await meetingIntelligence.observe({
      workspace: {
        workspaceId: "workspace_luma",
        timezone: "Europe/Berlin",
        outputLanguagePolicy: "meeting-majority"
      },
      observations: [
        {
          type: "meeting-started",
          observationId: "obs_declared_german_start",
          workspaceId: "workspace_luma",
          meetingId: "meeting_declared_german",
          occurredAt: "2026-06-26T10:00:00.000Z",
          observedAt: "2026-06-26T10:00:01.000Z",
          title: "Produktbesprechung",
          startedAt: "2026-06-26T10:00:00.000Z",
          languageMode: "de",
          participantIds: ["person_jakob"]
        }
      ]
    });

    const conclusion = await meetingIntelligence.conclude({
      workspaceId: "workspace_luma",
      meetingId: "meeting_declared_german"
    });

    expect(conclusion.outputLanguage).toBe("de");
  });

  it("returns the same persisted Conclusion when called again at the same Revision", async () => {
    const meetingIntelligence = await createHarness(
      new ProgrammableReasoningModel((request) => {
        const evidence = request.evidence[0];

        if (!evidence) {
          throw new Error("expected utterance evidence");
        }

        return {
          actionItems: [
            {
              stableKey: "github-issue-owner",
              description: "Handle the GitHub Issue",
              ownerId: "person_jakob",
              dueDate: {
                originalPhrase: null,
                normalizedDate: null,
                confidence: "unknown",
                timezone: "Europe/Berlin"
              },
              status: "confirmed",
              relatedDecisionIds: [],
              evidenceIds: [evidence.evidenceId],
              confidence: "high"
            }
          ],
          decisions: [],
          openQuestions: [],
          risks: [],
          followUpIntentions: []
        };
      })
    );

    await meetingIntelligence.observe({
      workspace: {
        workspaceId: "workspace_luma",
        timezone: "Europe/Berlin"
      },
      observations: [
        {
          type: "utterance-committed",
          observationId: "obs_utterance_1",
          workspaceId: "workspace_luma",
          meetingId: "meeting_product",
          occurredAt: "2026-06-26T10:05:00.000Z",
          observedAt: "2026-06-26T10:05:01.000Z",
          utteranceId: "utt_1",
          version: 1,
          speaker: {
            status: "attributed",
            personId: "person_jakob",
            confidence: "deterministic",
            basis: "provider-identity"
          },
          startedAt: "2026-06-26T10:04:58.000Z",
          endedAt: "2026-06-26T10:05:02.000Z",
          originalText: "Jakob übernimmt das Issue.",
          language: "de"
        }
      ]
    });

    const first = await meetingIntelligence.conclude({
      workspaceId: "workspace_luma",
      meetingId: "meeting_product"
    });
    const second = await meetingIntelligence.conclude({
      workspaceId: "workspace_luma",
      meetingId: "meeting_product"
    });

    expect(second).toEqual(first);
  });

  it("does not let approval turn a model-supplied generic owner into a Linear assignee", async () => {
    const database = await createPgliteDatabase();
    const meetingIntelligence = createMeetingIntelligence({
      database,
      now: () => new Date("2026-06-26T10:20:00.000Z"),
      reasoningModel: new ProgrammableReasoningModel((request) => {
        const evidence = request.evidence[0];

        if (!evidence) {
          throw new Error("expected utterance evidence");
        }

        return {
          actionItems: [
            {
              stableKey: "github-issue-owner",
              description: "Handle the GitHub Issue",
              ownerId: "person_jakob",
              dueDate: {
                originalPhrase: "bis Montag",
                normalizedDate: "2026-06-29",
                confidence: "normalized",
                timezone: "Europe/Berlin"
              },
              status: "confirmed",
              relatedDecisionIds: [],
              evidenceIds: [evidence.evidenceId],
              confidence: "high"
            }
          ],
          decisions: [],
          openQuestions: [],
          risks: [],
          followUpIntentions: [
            {
              id: "intent_create_issue",
              type: "create-work-item",
              title: "Handle the GitHub Issue",
              description: "Follow up on the Meeting Action Item.",
              assigneeId: "person_jakob",
              mentionPersonIds: ["person_fabius", "person_julius", "person_philipp"],
              dueDate: "2026-06-29",
              relatedMeetingItemIds: ["action:github-issue-owner"],
              evidenceIds: [evidence.evidenceId],
              confidence: "high"
            }
          ]
        };
      })
    });
    const workspace = {
      workspaceId: "workspace_luma",
      timezone: "Europe/Berlin"
    };

    await meetingIntelligence.observe({
      workspace,
      observations: [
        {
          type: "utterance-committed",
          observationId: "obs_utterance_1",
          workspaceId: "workspace_luma",
          meetingId: "meeting_product",
          occurredAt: "2026-06-26T10:05:00.000Z",
          observedAt: "2026-06-26T10:05:01.000Z",
          utteranceId: "utt_1",
          version: 1,
          speaker: {
            status: "attributed",
            personId: "person_jakob",
            confidence: "deterministic",
            basis: "provider-identity"
          },
          startedAt: "2026-06-26T10:04:58.000Z",
          endedAt: "2026-06-26T10:05:02.000Z",
          originalText: "Jakob übernimmt das GitHub Issue bis Montag.",
          language: "mixed"
        }
      ]
    });
    await meetingIntelligence.observe({
      workspace,
      observations: [
        {
          type: "follow-up-intent-approved",
          observationId: "obs_approve_intent",
          workspaceId: "workspace_luma",
          meetingId: "meeting_product",
          occurredAt: "2026-06-26T10:08:00.000Z",
          observedAt: "2026-06-26T10:08:01.000Z",
          intentId: "intent_create_issue",
          approvedBy: "person_jakob"
        }
      ]
    });

    const beforeExecution = await meetingIntelligence.query({
      workspaceId: "workspace_luma",
      meetingId: "meeting_product",
      query: {
        type: "snapshot"
      }
    });

    if (beforeExecution.type !== "snapshot") {
      throw new Error("expected snapshot result");
    }

    const approvedIntent = beforeExecution.state.followUpIntentions[0];

    if (!approvedIntent) {
      throw new Error("expected follow-up intent");
    }

    const workProvider = new FakeWorkProvider();
    const followUpExecution = createFollowUpExecution({
      database,
      meetingIntelligence,
      workProvider,
      now: () => new Date("2026-06-26T10:20:00.000Z")
    });

    const result = await followUpExecution.execute({
      workspace,
      meetingId: "meeting_product",
      intentId: approvedIntent.id
    });
    const afterExecution = await meetingIntelligence.query({
      workspaceId: "workspace_luma",
      meetingId: "meeting_product",
      query: {
        type: "snapshot"
      }
    });

    expect(result.idempotencyKey).toBe(
      JSON.stringify([
        "workspace_luma",
        "meeting_product",
        "intent_create_issue",
        "execute"
      ])
    );
    expect(workProvider.createCalls).toHaveLength(0);
    expect(result.events).toHaveLength(1);
    const failureEvent = result.events[0];

    if (!failureEvent || failureEvent.type !== "follow-up-execution-failed") {
      throw new Error("expected a failed generic work-item receipt event");
    }

    expect(failureEvent).toMatchObject({
      intentId: "intent_create_issue",
      retryable: false
    });
    expect(failureEvent.message).toContain("durable ownership confirmation");
    expect(afterExecution.type).toBe("snapshot");

    if (afterExecution.type !== "snapshot") {
      throw new Error("expected snapshot result");
    }

    expect(afterExecution.state.followUpIntentions[0]).toEqual(
      expect.objectContaining({
        id: "intent_create_issue",
        status: "failed"
      })
    );
    expect(afterExecution.state.actionItems[0]?.externalReferences).toEqual([]);
  });

  it("does not record a false success for an unimplemented code-comment Intent", async () => {
    const database = await createPgliteDatabase();
    const workspace = {
      workspaceId: "workspace_code_comment",
      timezone: "Europe/Berlin"
    };
    const meetingId = "meeting_code_comment";
    const meetingIntelligence = createMeetingIntelligence({
      database,
      reasoningModel: new ProgrammableReasoningModel((request) => ({
        actionItems: [],
        decisions: [],
        openQuestions: [],
        risks: [],
        followUpIntentions: [
          {
            id: "intent_comment_code",
            type: "comment-on-code-change",
            externalReference: {
              providerId: "github",
              objectType: "pull-request",
              externalId: "42",
              url: "https://github.com/dayova/luma/pull/42"
            },
            bodyMarkdown: "Please preserve original source Evidence.",
            relatedMeetingItemIds: [],
            evidenceIds: [request.evidence[0]?.evidenceId ?? "missing-evidence"],
            confidence: "high"
          }
        ]
      }))
    });

    try {
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "utterance-committed",
            observationId: "code-comment:utterance",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T10:00:00.000Z",
            observedAt: "2026-08-08T10:00:01.000Z",
            utteranceId: "code-comment:utt",
            version: 1,
            speaker: {
              status: "attributed",
              personId: "person_jakob",
              confidence: "deterministic",
              basis: "provider-identity"
            },
            startedAt: "2026-08-08T09:59:58.000Z",
            endedAt: "2026-08-08T10:00:02.000Z",
            originalText: "Please add the source integrity comment to the pull request.",
            language: "en"
          }
        ]
      });
      await meetingIntelligence.observe({
        workspace,
        observations: [
          {
            type: "follow-up-intent-approved",
            observationId: "code-comment:approval",
            workspaceId: workspace.workspaceId,
            meetingId,
            occurredAt: "2026-08-08T10:01:00.000Z",
            observedAt: "2026-08-08T10:01:01.000Z",
            intentId: "intent_comment_code",
            approvedBy: "person_jakob"
          }
        ]
      });

      const result = await createFollowUpExecution({
        database,
        meetingIntelligence
      }).execute({
        workspace,
        meetingId,
        intentId: "intent_comment_code"
      });

      expect(result.observation.outcome).toMatchObject({ status: "failed" });
      expect(result.events).toEqual([
        expect.objectContaining({ type: "follow-up-execution-failed" })
      ]);
    } finally {
      await database.close();
    }
  });
});
