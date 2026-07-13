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
import type { ExternalReference } from "../../src/domain/model.js";

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

class FakeWorkProvider implements WorkProvider {
  createCalls: CreateWorkItemInput[] = [];

  searchWorkItems(_query: WorkQuery): Promise<WorkItem[]> {
    void _query;
    return Promise.resolve([]);
  }

  getWorkItem(id: string): Promise<WorkItem> {
    return Promise.resolve({
      id,
      providerId: "github-issues",
      externalId: id,
      title: "Issue",
      description: "",
      status: "planned",
      assignees: [],
      dueDate: null,
      labels: [],
      projectId: null,
      parentId: null,
      url: `https://github.example/issues/${id}`,
      updatedAt: "2026-06-26T10:20:00.000Z"
    });
  }

  createWorkItem(input: CreateWorkItemInput): Promise<ExternalReference> {
    this.createCalls.push(input);
    return Promise.resolve({
      providerId: "github-issues",
      objectType: "work-item",
      externalId: "312",
      url: "https://github.example/issues/312"
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
              status: "suggested",
              provenance: {
                evidence: [evidence],
                confidence: "high",
                producedAtRevision: 1,
                analysisVersion: "test"
              }
            }
          ]
        };
      })
    );
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
        },
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
      meetingIntelligence,
      identityDirectory: createLumaTeamIdentityDirectory(),
      workProvider,
      now: () => new Date("2026-06-26T10:20:00.000Z")
    });

    const result = await followUpExecution.execute({
      workspace,
      meetingId: "meeting_product",
      intent: approvedIntent
    });
    const retry = await followUpExecution.execute({
      workspace,
      meetingId: "meeting_product",
      intent: approvedIntent
    });
    const afterExecution = await meetingIntelligence.query({
      workspaceId: "workspace_luma",
      meetingId: "meeting_product",
      query: {
        type: "snapshot"
      }
    });

    expect(result.idempotencyKey).toBe(
      "workspace_luma:meeting_product:intent_create_issue:execute"
    );
    expect(workProvider.createCalls).toHaveLength(1);
    expect(workProvider.createCalls[0]).toEqual(
      expect.objectContaining({
        assigneeProviderUserId: "FleetAdmiralJakob",
        mentionProviderUserIds: [
          "FleetAdmiralJakob",
          "Gamius00",
          "juliusdietrich2407-lab",
          "PhilippSchossig"
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
            providerId: "github-issues",
            objectType: "work-item",
            externalId: "312",
            url: "https://github.example/issues/312"
          }
        ],
        summary: "create-work-item succeeded: https://github.example/issues/312"
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
        providerId: "github-issues",
        objectType: "work-item",
        externalId: "312",
        url: "https://github.example/issues/312"
      }
    ]);
  });
});
