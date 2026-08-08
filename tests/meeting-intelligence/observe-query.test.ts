import { describe, expect, it } from "vitest";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import { createLumaTeamIdentityDirectory } from "../../src/identity/static-identity-directory.js";
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
    _request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    void _request;
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
        promptVersion: "meeting-intelligence-v1"
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
            speakerId: "person_jakob",
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
            speakerId: "person_jakob",
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
            speakerId: "person_jakob",
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
            speakerId: "person_jakob",
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
          speakerId: "person_jakob",
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
          speakerId: "person_jakob",
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
        ownerId: "person_jakob",
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
      speakerId: "person_jakob",
      startedAt: "2026-06-26T10:04:58.000Z",
      endedAt: "2026-06-26T10:05:02.000Z",
      originalText: "Jakob übernimmt das GitHub Issue bis Montag.",
      language: "mixed" as const
    };

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
          speakerId: "person_jakob",
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
        ownerId: "person_philipp"
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
          speakerId: "person_jakob",
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
          speakerId: "person_jakob",
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
          speakerId: "person_jakob",
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
          speakerId: "person_jakob",
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

  it("executes an approved provider-independent create-work-item intent and records a Discord receipt event", async () => {
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
          speakerId: "person_jakob",
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
      identityDirectory: createLumaTeamIdentityDirectory(),
      workProvider,
      now: () => new Date("2026-06-26T10:20:00.000Z")
    });

    const result = await followUpExecution.execute({
      workspace,
      meetingId: "meeting_product",
      intentId: approvedIntent.id
    });
    const restartedFollowUpExecution = createFollowUpExecution({
      database,
      meetingIntelligence,
      identityDirectory: createLumaTeamIdentityDirectory(),
      workProvider,
      now: () => new Date("2026-06-26T10:21:00.000Z")
    });
    const retry = await restartedFollowUpExecution.execute({
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
    expect(workProvider.createCalls).toHaveLength(1);
    expect(workProvider.createCalls[0]).toEqual(
      expect.objectContaining({
        assigneeProviderUserId: "67e00026-a426-4476-83bb-fe679fc5ca9c",
        mentionProviderUserIds: [
          "67e00026-a426-4476-83bb-fe679fc5ca9c",
          "5213a22b-1699-499f-8901-e34204add045",
          "cfca93a4-7a23-4d8a-a5c9-56dd9b4b84c8",
          "810f1e3b-321b-4e74-bb7b-92cf1608e3ba"
        ]
      })
    );
    expect(retry).toEqual(result);
    expect(result.events).toEqual([
      {
        type: "follow-up-execution-succeeded",
        intentId: "intent_create_issue",
        externalReferences: [
          {
            providerId: "linear",
            objectType: "work-item",
            externalId: "312",
            url: "https://linear.example/DAY-312"
          }
        ],
        summary: "create-work-item succeeded: https://linear.example/DAY-312"
      }
    ]);
    expect(afterExecution.type).toBe("snapshot");

    if (afterExecution.type !== "snapshot") {
      throw new Error("expected snapshot result");
    }

    expect(afterExecution.state.followUpIntentions[0]).toEqual(
      expect.objectContaining({
        id: "intent_create_issue",
        status: "succeeded"
      })
    );
    expect(afterExecution.state.actionItems[0]?.externalReferences).toEqual([
      {
        providerId: "linear",
        objectType: "work-item",
        externalId: "312",
        url: "https://linear.example/DAY-312"
      }
    ]);
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
            speakerId: "person_jakob",
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
