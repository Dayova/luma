import { afterEach, describe, expect, it } from "vitest";
import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel,
  StructuredReasoningRequest,
  StructuredReasoningResult
} from "../../src/ai/reasoning-model.js";
import type {
  ActionItemStatus,
  Confidence,
  DecisionStatus,
  DueDateConfidence,
  EvidenceReference,
  HumanJudgment,
  MeetingObservation,
  MeetingState
} from "../../src/domain/model.js";
import type { GroundedAnswer } from "../../src/meeting-intelligence/interface.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";

type ItemSpec = {
  key: string;
  text: string;
  sourceCount?: number;
  occurredAt?: string;
  confidence?: Confidence;
} & (
  | { kind: "decision"; status?: DecisionStatus }
  | {
      kind: "action";
      status?: ActionItemStatus;
      proposedOwner?: string;
      dueDate?: { date: string; confidence: DueDateConfidence };
    }
  | { kind: "question" }
);

class ProgrammableReasoningModel implements ReasoningModel {
  readonly specs = new Map<string, ItemSpec[]>();
  calls = 0;
  generateStructured<T>(
    request: StructuredReasoningRequest<T>
  ): Promise<StructuredReasoningResult<T>> {
    this.calls += 1;
    const batch: MeetingAnalysisProposalBatch = {
      decisions: [],
      actionItems: [],
      openQuestions: [],
      risks: [],
      followUpIntentions: []
    };
    for (const spec of this.specs.get(request.workspaceId) ?? []) {
      const sources = request.evidence.filter((reference) =>
        reference.sourceObjectId.startsWith(`${spec.key}:source:`)
      );
      // On a later analysis the new Utterance supports a fresh proposal for
      // the same stable item; Human Judgment must still retain precedence.
      const evidenceIds = (sources.length > 0 ? sources : request.evidence).map(
        (reference) => reference.evidenceId
      );
      if (evidenceIds.length === 0)
        throw new Error("A test proposal requires original Evidence");
      if (spec.kind === "decision") {
        batch.decisions.push({
          stableKey: spec.key,
          statement: spec.text,
          status: spec.status ?? "candidate",
          rationale: [],
          supportingParticipantIds: [],
          objectingParticipantIds: [],
          relatedTopicIds: [],
          evidenceIds,
          confidence: spec.confidence ?? "high"
        });
      } else if (spec.kind === "action") {
        batch.actionItems.push({
          stableKey: spec.key,
          description: spec.text,
          status: spec.status ?? "candidate",
          ownerId: spec.proposedOwner ?? null,
          dueDate: {
            originalPhrase: null,
            normalizedDate: spec.dueDate?.date ?? null,
            confidence: spec.dueDate?.confidence ?? "unknown",
            timezone: "Europe/Berlin"
          },
          relatedDecisionIds: [],
          evidenceIds,
          confidence: spec.confidence ?? "high"
        });
      } else {
        batch.openQuestions.push({
          stableKey: spec.key,
          question: spec.text,
          raisedBy: "person_philipp",
          evidenceIds,
          confidence: spec.confidence ?? "high"
        });
      }
    }
    return Promise.resolve({
      value: batch as T,
      metadata: {
        provider: "test",
        model: "programmable",
        promptVersion: request.promptVersion
      }
    });
  }
}

const now = "2026-09-09T12:00:00.000Z";
const meetingId = "meeting_shared_identifier";
const primaryWorkspace = "workspace_dayova";
const databases: LumaDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
});
async function fixture(specs: ItemSpec[]) {
  const database = await createPgliteDatabase();
  databases.push(database);
  const model = new ProgrammableReasoningModel();
  const intelligence = createMeetingIntelligence({
    database,
    reasoningModel: model,
    now: () => new Date(now)
  });
  let judgmentSequence = 0;
  async function seed(items: ItemSpec[], workspaceId = primaryWorkspace) {
    model.specs.set(workspaceId, items);
    const observations: MeetingObservation[] = items.flatMap((item) =>
      Array.from({ length: item.sourceCount ?? 1 }, (_, index) => ({
        type: "utterance-committed" as const,
        observationId: `${item.key}:observation:${index}`,
        workspaceId,
        meetingId,
        occurredAt: item.occurredAt ?? now,
        observedAt: item.occurredAt ?? now,
        utteranceId: `${item.key}:source:${index}`,
        version: 1,
        speaker: {
          status: "attributed" as const,
          personId: "person_philipp",
          confidence: "deterministic" as const,
          basis: "provider-identity" as const
        },
        startedAt: item.occurredAt ?? now,
        endedAt: item.occurredAt ?? now,
        originalText: item.text,
        language: "mixed" as const
      }))
    );
    const update = await intelligence.observe({
      workspace: { workspaceId, timezone: "Europe/Berlin" },
      observations
    });
    expect(update.errors).toEqual([]);
    expect(update.analysisStatus).toBe("completed");
  }
  async function judge(
    judgments: HumanJudgment[],
    workspaceId = primaryWorkspace,
    occurredAt = now
  ) {
    const update = await intelligence.observe({
      workspace: { workspaceId, timezone: "Europe/Berlin" },
      observations: judgments.map((judgment) => ({
        type: "human-judgment-recorded" as const,
        observationId: `judgment:${++judgmentSequence}`,
        workspaceId,
        meetingId,
        occurredAt,
        observedAt: occurredAt,
        participantId: "person_jakob",
        judgment
      }))
    });
    expect(update.errors).toEqual([]);
  }
  async function snapshot(workspaceId = primaryWorkspace): Promise<MeetingState> {
    const result = await intelligence.query({
      workspaceId,
      meetingId,
      query: { type: "snapshot" }
    });
    if (result.type !== "snapshot") throw new Error("Expected a snapshot");
    return result.state;
  }
  async function ask(
    text: string,
    participantId?: string,
    workspaceId = primaryWorkspace
  ): Promise<GroundedAnswer> {
    const result = await intelligence.query({
      workspaceId,
      meetingId,
      query: { type: "freeform", text, ...(participantId ? { participantId } : {}) }
    });
    if (result.type !== "freeform") throw new Error("Expected a freeform answer");
    return result.answer;
  }
  async function history(
    topic: string,
    workspaceId = primaryWorkspace
  ): Promise<GroundedAnswer> {
    const result = await intelligence.query({
      workspaceId,
      meetingId,
      query: { type: "decision-history", topic }
    });
    if (result.type !== "decision-history") throw new Error("Expected Decision history");
    return result.answer;
  }
  await seed(specs);
  return { database, model, intelligence, seed, judge, snapshot, ask, history };
}

function uniqueEvidence(
  items: Array<{ provenance: { evidence: EvidenceReference[] } }>
): EvidenceReference[] {
  return [
    ...new Map(
      items
        .flatMap((item) => item.provenance.evidence)
        .map((reference) => [reference.evidenceId, reference])
    ).values()
  ];
}
function expectEvidenceFor(
  answer: GroundedAnswer,
  items: Array<{ provenance: { evidence: EvidenceReference[] } }>
) {
  const sort = (evidence: EvidenceReference[]) =>
    [...evidence].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  const addresses = uniqueEvidence(items).map(({ excerpt: _excerpt, ...address }) => {
    void _excerpt;
    return address;
  });
  expect(sort(answer.evidence)).toEqual(sort(addresses));
}
const decisionSpecs: ItemSpec[] = [
  {
    kind: "decision",
    key: "release-current",
    text: "Release checklist uses a staged rollout."
  },
  {
    kind: "decision",
    key: "release-old",
    text: "Release checklist uses an immediate rollout."
  },
  {
    kind: "decision",
    key: "release-rejected",
    text: "Release checklist skips verification."
  },
  {
    kind: "decision",
    key: "release-candidate",
    text: "Release checklist might include a public launch."
  },
  { kind: "decision", key: "billing", text: "Billing uses a monthly invoice." },
  {
    kind: "action",
    key: "release-work",
    text: "Prepare the release checklist.",
    proposedOwner: "person_jakob"
  },
  {
    kind: "question",
    key: "release-question",
    text: "Who reviews the release checklist?"
  }
];
async function decisionFixture() {
  const f = await fixture(decisionSpecs);
  await f.judge([
    { kind: "confirm", meetingItemId: "decision:release-current" },
    {
      kind: "correct",
      meetingItemId: "decision:release-old",
      correction: { status: "superseded" }
    },
    { kind: "reject", meetingItemId: "decision:release-rejected" },
    { kind: "confirm", meetingItemId: "decision:billing" }
  ]);
  return f;
}

describe("scoped Meeting questions", () => {
  it("answers current Decisions independently of caller identity and excludes superseded, rejected and candidate choices", async () => {
    const f = await decisionFixture();
    const snapshot = await f.snapshot();
    const selected = snapshot.decisions.filter(
      (decision) => decision.status === "confirmed"
    );
    const modelCalls = f.model.calls;
    for (const question of ["What did we decide?", "Was haben wir entschieden?"]) {
      const answer = await f.ask(question, "person_jakob");
      expect(answer.text).toContain("Release checklist uses a staged rollout.");
      expect(answer.text).toContain("Billing uses a monthly invoice.");
      for (const excluded of [
        "immediate rollout",
        "skips verification",
        "might include",
        "Prepare the release",
        "Who reviews"
      ])
        expect(answer.text).not.toContain(excluded);
      expect(answer.uncertainty).toBe("none");
      expectEvidenceFor(answer, selected);
    }
    expect(f.model.calls).toBe(modelCalls);
    expect(await f.snapshot()).toEqual(snapshot);
  });

  it("matches an explicit normalized topic phrase without returning other Decisions or their Evidence", async () => {
    const f = await decisionFixture();
    const snapshot = await f.snapshot();
    const selected = snapshot.decisions.filter(
      (decision) => decision.id === "decision:release-current"
    );
    for (const question of [
      "What did we decide about RELEASE   CHECKLIST?",
      "Was haben wir entschieden zu release checklist?"
    ]) {
      const answer = await f.ask(question, "person_jakob");
      expect(answer.text).toContain("Release checklist uses a staged rollout.");
      expect(answer.text).not.toContain("Billing");
      expectEvidenceFor(answer, selected);
    }
    const missing = await f.ask("What did we decide about release budget?");
    expect(missing.uncertainty).toBe("insufficient-evidence");
    expect(missing.evidence).toEqual([]);
  });

  it("distinguishes current Decisions from explicit history while preserving historic statuses", async () => {
    const f = await decisionFixture();
    const before = await f.snapshot();
    const selected = before.decisions.filter((decision) =>
      decision.statement.includes("Release checklist")
    );
    const typed = await f.history("release checklist");
    const natural = await f.ask("Show decision history about release checklist");
    for (const answer of [typed, natural]) {
      for (const decision of selected) {
        expect(answer.text).toContain(decision.statement);
        expect(answer.text).toContain(decision.status);
      }
      expect(answer.text).not.toContain("Billing");
      expectEvidenceFor(answer, selected);
    }
    const allHistory = await f.ask("Show decision history");
    expect(allHistory.text).toContain("Billing uses a monthly invoice.");
    expectEvidenceFor(allHistory, before.decisions);
    expect(await f.history("release checklist")).toEqual(typed);
    expect(await f.snapshot()).toEqual(before);
  });

  it("answers open questions with their own Evidence rather than unrelated work", async () => {
    const f = await fixture([
      { kind: "question", key: "release", text: "Who reviews the release checklist?" },
      {
        kind: "question",
        key: "support",
        text: "Wie behandeln wir offene Supportfragen?"
      },
      { kind: "action", key: "work", text: "Prepare the release checklist." },
      {
        kind: "decision",
        key: "choice",
        text: "Use a staged rollout.",
        status: "confirmed"
      }
    ]);
    const state = await f.snapshot();
    for (const question of [
      "What questions are still open?",
      "Welche Fragen sind noch offen?"
    ]) {
      const answer = await f.ask(question, "person_jakob");
      expect(answer.text).toContain("Who reviews the release checklist?");
      expect(answer.text).toContain("Wie behandeln wir offene Supportfragen?");
      expect(answer.text).not.toContain("Prepare the release checklist.");
      expect(answer.text).not.toContain("Use a staged rollout.");
      expectEvidenceFor(answer, state.openQuestions);
    }
  });

  it("keeps personal ownership explicit while showing provisional work in shared answers", async () => {
    const f = await fixture([
      {
        kind: "action",
        key: "jakob",
        text: "Prepare the release checklist.",
        proposedOwner: "person_jakob"
      },
      {
        kind: "action",
        key: "fabius",
        text: "Review the billing workflow.",
        proposedOwner: "person_fabius"
      },
      {
        kind: "action",
        key: "proposed",
        text: "We could invite support testers.",
        proposedOwner: "person_jakob"
      },
      {
        kind: "action",
        key: "unresolved",
        text: "Someone should review the incident procedure."
      },
      {
        kind: "action",
        key: "completed",
        text: "Publish the completed launch note.",
        status: "completed",
        proposedOwner: "person_jakob"
      },
      {
        kind: "action",
        key: "cancelled",
        text: "Prepare the cancelled migration.",
        status: "cancelled",
        proposedOwner: "person_jakob"
      }
    ]);
    await f.judge([
      {
        kind: "correct",
        meetingItemId: "action:jakob",
        correction: { ownerId: "person_jakob", status: "confirmed" }
      },
      {
        kind: "correct",
        meetingItemId: "action:fabius",
        correction: { ownerId: "person_fabius", status: "planned" }
      },
      {
        kind: "correct",
        meetingItemId: "action:completed",
        correction: { ownerId: "person_jakob", status: "completed" }
      },
      {
        kind: "correct",
        meetingItemId: "action:cancelled",
        correction: { ownerId: "person_jakob", status: "cancelled" }
      }
    ]);
    const snapshot = await f.snapshot();
    const current = snapshot.actionItems.filter(
      (item) => !["completed", "cancelled"].includes(item.status)
    );
    for (const question of ["What are our action items?", "Was sind unsere Aufgaben?"]) {
      const answer = await f.ask(question, "person_jakob");
      for (const item of current) expect(answer.text).toContain(item.description);
      expect(answer.text).toContain("proposed owner person_jakob");
      expect(answer.text).toMatch(/unresolved|no confirmed owner/i);
      expect(answer.text).not.toContain("completed launch note");
      expect(answer.text).not.toContain("cancelled migration");
      expect(answer.uncertainty).toBe("partial");
      expectEvidenceFor(answer, current);
    }
    for (const question of [
      "What are my action items?",
      "Was sind meine Aufgaben?",
      "What do I own?"
    ]) {
      const answer = await f.ask(question, "person_jakob");
      expect(answer.text).toContain("Prepare the release checklist.");
      expect(answer.text).toContain("confirmed owner person_jakob");
      for (const excluded of [
        "billing",
        "support testers",
        "incident procedure",
        "completed launch",
        "cancelled migration"
      ])
        expect(answer.text).not.toContain(excluded);
      expectEvidenceFor(
        answer,
        current.filter((item) => item.id === "action:jakob")
      );
    }
    expect((await f.ask("What are my action items?")).evidence).toEqual([]);
    expect((await f.ask("What are my action items?", "person_julius")).evidence).toEqual(
      []
    );
    const scoped = await f.ask(
      "What are our action items about release checklist?",
      "person_fabius"
    );
    expect(scoped.text).toContain("Prepare the release checklist.");
    expectEvidenceFor(
      scoped,
      current.filter((item) => item.id === "action:jakob")
    );
  });

  it("fails safely for unsupported, named-person and multi-intent requests without model calls or state changes", async () => {
    const f = await decisionFixture();
    const before = await f.snapshot();
    const calls = f.model.calls;
    for (const question of [
      "What does Jakob own?",
      "Who is the CEO?",
      "What did we decide and what are our action items?",
      "What are my action items and what questions are still open?",
      "Tell me everything",
      "What did we not decide?",
      ""
    ]) {
      const answer = await f.ask(question, "person_jakob");
      expect(answer.uncertainty).toBe("insufficient-evidence");
      expect(answer.evidence).toEqual([]);
      expect(answer.text).not.toContain("staged rollout");
      expect(answer.text).not.toContain("Prepare the release checklist");
    }
    expect(f.model.calls).toBe(calls);
    expect(await f.snapshot()).toEqual(before);
  });

  it("preserves a Human correction and superseded status through fresh model reanalysis", async () => {
    const f = await fixture([
      {
        kind: "decision",
        key: "current",
        text: "Release checklist uses the initial process.",
        status: "candidate"
      },
      {
        kind: "decision",
        key: "old",
        text: "Release checklist uses an obsolete process.",
        status: "confirmed"
      }
    ]);
    await f.judge([
      {
        kind: "correct",
        meetingItemId: "decision:current",
        correction: {
          statement: "Release checklist uses the Human-approved staged process.",
          status: "confirmed"
        }
      },
      {
        kind: "correct",
        meetingItemId: "decision:old",
        correction: { status: "superseded" }
      }
    ]);
    const corrected = await f.snapshot();
    f.model.specs.set(primaryWorkspace, [
      {
        kind: "decision",
        key: "current",
        text: "AI suggests replacing the Human process.",
        status: "candidate"
      },
      {
        kind: "decision",
        key: "old",
        text: "AI suggests reviving the obsolete process.",
        status: "confirmed"
      }
    ]);
    const update = await f.intelligence.observe({
      workspace: { workspaceId: primaryWorkspace, timezone: "Europe/Berlin" },
      observations: [
        {
          type: "utterance-committed",
          observationId: "later:observation",
          workspaceId: primaryWorkspace,
          meetingId,
          occurredAt: now,
          observedAt: now,
          utteranceId: "later:source",
          version: 1,
          speaker: {
            status: "attributed",
            personId: "person_fabius",
            confidence: "deterministic",
            basis: "provider-identity"
          },
          startedAt: now,
          endedAt: now,
          originalText: "We discussed more release options.",
          language: "en"
        }
      ]
    });
    expect(update.errors).toEqual([]);
    expect(update.analysisStatus).toBe("completed");
    expect(f.model.calls).toBe(2);
    const after = await f.snapshot();
    expect(after.decisions).toEqual(corrected.decisions);
    const current = await f.ask("What did we decide about release checklist?");
    expect(current.text).toContain("Human-approved staged process");
    expect(current.text).not.toContain("obsolete process");
    expect(current.text).not.toContain("AI suggests");
    expectEvidenceFor(
      current,
      corrected.decisions.filter((decision) => decision.status === "confirmed")
    );
    const history = await f.history("release checklist");
    expect(history.text).toContain("superseded");
    expect(history.text).toContain("obsolete process");
  });

  it("retains old current Human-confirmed Decisions without inventing an age expiry", async () => {
    const f = await fixture([
      {
        kind: "decision",
        key: "old-current",
        text: "Release checklist requires two reviewers.",
        occurredAt: "2020-01-02T10:00:00.000Z"
      }
    ]);
    await f.judge(
      [{ kind: "confirm", meetingItemId: "decision:old-current" }],
      primaryWorkspace,
      "2020-01-02T10:01:00.000Z"
    );
    const answer = await f.ask("What did we decide about release checklist?");
    expect(answer.text).toContain("Release checklist requires two reviewers.");
    expect(answer.uncertainty).toBe("none");
    expectEvidenceFor(answer, (await f.snapshot()).decisions);
  });

  it("bounds item count and reports omitted results without returning their Evidence", async () => {
    const f = await fixture(
      Array.from({ length: 12 }, (_, index) => ({
        kind: "decision" as const,
        key: `decision-${index}`,
        text: `Release rule ${index.toString().padStart(2, "0")}: require review.`,
        status: "confirmed" as const
      }))
    );
    const before = await f.snapshot();
    const answer = await f.ask("What did we decide?");
    const selected = before.decisions.filter((decision) =>
      answer.text.includes(decision.statement)
    );
    expect(selected).toHaveLength(8);
    expect(answer.text.length).toBeLessThanOrEqual(1600);
    expect(answer.text).toMatch(/omitt|more|not shown|limit/i);
    expect(answer.uncertainty).toBe("partial");
    expectEvidenceFor(answer, selected);
    expect(await f.snapshot()).toEqual(before);
  });

  it("bounds answer text using complete items rather than silently cutting their statements", async () => {
    const f = await fixture(
      Array.from({ length: 8 }, (_, index) => ({
        kind: "decision" as const,
        key: `long-${index}`,
        text: `Release policy ${index}: ${"retain original source wording and review context; ".repeat(8)}END-${index}`,
        status: "confirmed" as const
      }))
    );
    const state = await f.snapshot();
    const answer = await f.ask("What did we decide?");
    const selected = state.decisions.filter((decision) =>
      answer.text.includes(decision.statement)
    );
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(8);
    expect(answer.text.length).toBeLessThanOrEqual(1600);
    for (let index = 0; index < 8; index += 1) {
      if (answer.text.includes(`Release policy ${index}:`))
        expect(answer.text).toContain(`END-${index}`);
    }
    expect(answer.text).toMatch(/omitt|more|not shown|limit/i);
    expect(answer.uncertainty).toBe("partial");
    expectEvidenceFor(answer, selected);
  });

  it("caps Evidence references by omitting whole items while retaining every source for included claims", async () => {
    const f = await fixture(
      Array.from({ length: 8 }, (_, index) => ({
        kind: "decision" as const,
        key: `evidence-${index}`,
        text: `Release Evidence rule ${index}: check all sources.`,
        status: "confirmed" as const,
        sourceCount: 4
      }))
    );
    const before = await f.snapshot();
    const answer = await f.ask("What did we decide?");
    const selected = before.decisions.filter((decision) =>
      answer.text.includes(decision.statement)
    );
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(8);
    expect(answer.evidence.length).toBeLessThanOrEqual(24);
    expect(answer.uncertainty).toBe("partial");
    expect(answer.text).toMatch(/omitt|more|not shown|limit/i);
    expectEvidenceFor(answer, selected);
    expect(await f.snapshot()).toEqual(before);
  });

  it("preserves uncertainty for an ambiguous deadline even after ownership and work are confirmed", async () => {
    const f = await fixture([
      {
        kind: "action",
        key: "deadline",
        text: "Prepare the release checklist next Friday.",
        proposedOwner: "person_jakob",
        status: "confirmed",
        dueDate: { date: "2026-09-18", confidence: "ambiguous" }
      }
    ]);
    await f.judge([
      {
        kind: "correct",
        meetingItemId: "action:deadline",
        correction: { ownerId: "person_jakob", status: "confirmed" }
      }
    ]);
    const answer = await f.ask("What are my action items?", "person_jakob");
    expect(answer.text).toContain("confirmed owner person_jakob");
    expect(answer.text).toContain("2026-09-18");
    expect(answer.text).toContain("ambiguous");
    expect(answer.uncertainty).toBe("partial");
    expectEvidenceFor(answer, (await f.snapshot()).actionItems);
  });

  it("omits claims supported only by revised speech and retains active Human Judgment without relabeling replacement speech as support", async () => {
    const f = await fixture([
      {
        kind: "decision",
        key: "raw",
        text: "Release checklist skips review.",
        status: "confirmed"
      },
      {
        kind: "decision",
        key: "protected",
        text: "Release checklist uses one reviewer.",
        status: "candidate"
      }
    ]);
    await f.judge([
      {
        kind: "correct",
        meetingItemId: "decision:protected",
        correction: {
          statement: "Release checklist requires two Human reviewers.",
          status: "confirmed"
        }
      }
    ]);
    f.model.specs.set(primaryWorkspace, []);
    const update = await f.intelligence.observe({
      workspace: { workspaceId: primaryWorkspace, timezone: "Europe/Berlin" },
      observations: ["raw", "protected"].map((key) => ({
        type: "utterance-revised" as const,
        observationId: `${key}:revision`,
        workspaceId: primaryWorkspace,
        meetingId,
        occurredAt: now,
        observedAt: now,
        utteranceId: `${key}:source:0`,
        replacesVersion: 1,
        version: 2,
        originalText:
          "The transcript was corrected; the original statement was not said.",
        language: "en" as const
      }))
    });
    expect(update.errors).toEqual([]);
    expect(update.analysisStatus).toBe("completed");
    const state = await f.snapshot();
    const answer = await f.ask("What did we decide about release checklist?");
    expect(answer.text).toContain("Release checklist requires two Human reviewers.");
    expect(answer.text).not.toContain("skips review");
    expect(answer.text).not.toContain("uses one reviewer");
    expect(answer.text).not.toContain("transcript was corrected");
    expect(answer.evidence.length).toBeGreaterThan(0);
    expect(
      answer.evidence.every((reference) => reference.source === "human-judgment")
    ).toBe(true);
    expectEvidenceFor(
      answer,
      state.decisions.filter((decision) => decision.id === "decision:protected")
    );
    expect(await f.snapshot()).toEqual(state);
  });

  it("qualifies confirmed items with low or medium model confidence until explicit Human confirmation", async () => {
    const f = await fixture([
      {
        kind: "decision",
        key: "low-decision",
        text: "Release checklist uses the staged process.",
        status: "confirmed",
        confidence: "low"
      },
      {
        kind: "decision",
        key: "medium-decision",
        text: "Billing uses monthly invoices.",
        status: "confirmed",
        confidence: "medium"
      },
      {
        kind: "action",
        key: "low-work",
        text: "I will prepare the release checklist.",
        status: "confirmed",
        confidence: "low",
        proposedOwner: "person_philipp"
      },
      {
        kind: "action",
        key: "medium-work",
        text: "I will handle the billing workflow.",
        status: "confirmed",
        confidence: "medium",
        proposedOwner: "person_philipp"
      }
    ]);
    const before = await f.snapshot();
    for (const action of before.actionItems) {
      expect(action.status).toBe("confirmed");
      expect(action.ownership).toMatchObject({
        status: "confirmed",
        ownerPersonId: "person_philipp",
        basis: "self-commitment",
        confidence: "deterministic"
      });
    }
    const decisions = await f.ask("What did we decide?");
    const actions = await f.ask("What are my action items?", "person_philipp");
    for (const answer of [decisions, actions]) {
      expect(answer.uncertainty).toBe("partial");
      expect(answer.text).toContain("[Recorded confidence: low]");
      expect(answer.text).toContain("[Recorded confidence: medium]");
    }
    expectEvidenceFor(decisions, before.decisions);
    expectEvidenceFor(actions, before.actionItems);
    await f.judge(
      [...before.decisions, ...before.actionItems].map((item) => ({
        kind: "confirm",
        meetingItemId: item.id
      }))
    );
    const confirmed = await f.snapshot();
    for (const item of [...confirmed.decisions, ...confirmed.actionItems])
      expect(item.provenance.confidence).toBe("high");
    const confirmedDecisions = await f.ask("What did we decide?");
    const confirmedActions = await f.ask("What are my action items?", "person_philipp");
    for (const answer of [confirmedDecisions, confirmedActions]) {
      expect(answer.uncertainty).toBe("none");
      expect(answer.text).not.toContain("[Recorded confidence: low]");
      expect(answer.text).not.toContain("[Recorded confidence: medium]");
    }
    expectEvidenceFor(confirmedDecisions, confirmed.decisions);
    expectEvidenceFor(confirmedActions, confirmed.actionItems);
  });

  it("keeps identical Meeting and item identities isolated between workspaces", async () => {
    const f = await fixture([
      {
        kind: "decision",
        key: "shared-key",
        text: "Dayova keeps the release private.",
        status: "confirmed"
      }
    ]);
    await f.seed(
      [
        {
          kind: "decision",
          key: "shared-key",
          text: "Other workspace publishes its launch.",
          status: "confirmed"
        }
      ],
      "workspace_other"
    );
    const first = await f.ask("What did we decide?");
    const second = await f.ask("What did we decide?", undefined, "workspace_other");
    expect(first.text).toContain("Dayova keeps the release private.");
    expect(first.text).not.toContain("Other workspace");
    expect(second.text).toContain("Other workspace publishes its launch.");
    expect(second.text).not.toContain("Dayova");
    expectEvidenceFor(first, (await f.snapshot()).decisions);
    expectEvidenceFor(second, (await f.snapshot("workspace_other")).decisions);
  });
});
