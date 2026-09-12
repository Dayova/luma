import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CorpusFixture, MeetingCorpus, SampleArchive } from "../../evals/corpus.js";
import { ReplayModel } from "../../evals/replay-model.js";
import type { HumanJudgment, MeetingObservation } from "../domain/model.js";
import { createMeetingIntelligence } from "../meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase } from "../persistence/db.js";

export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("load"), scenario: z.string().max(150) }).strict(),
  z.object({ type: z.literal("next") }).strict(),
  z.object({ type: z.literal("replay") }).strict(),
  z.object({ type: z.literal("conclude") }).strict(),
  z.object({ type: z.literal("ask"), text: z.string().trim().min(1).max(2000) }).strict(),
  z
    .object({
      type: z.literal("judge"),
      itemId: z.string().min(1).max(200),
      action: z.enum(["confirm", "reject", "supersede", "owner"]),
      owner: z
        .enum(["person_jakob", "person_fabius", "person_philipp", "person_julius"])
        .optional()
    })
    .strict()
]);

export async function createSandboxSession(
  corpus: MeetingCorpus,
  samples: SampleArchive
) {
  const database = await createPgliteDatabase();
  const model = new ReplayModel(samples);
  const intelligence = createMeetingIntelligence({
    database,
    reasoningModel: model,
    now: () => new Date(corpus.referenceAt)
  });
  const workspace = { workspaceId: "local-sandbox", timezone: corpus.timezone };
  const scenarios = corpus.fixtures.filter((f) =>
    f.steps.every((s) => s.type !== "import" && s.type !== "reconciliation")
  );
  let fixture: CorpusFixture | undefined;
  let meetingId = "";
  let position = 0;
  let lastObservation: MeetingObservation[] | undefined;
  let result: unknown = null;
  const scope = () => ({ workspaceId: workspace.workspaceId, meetingId });

  async function judge(judgment: HumanJudgment, observationId: string = randomUUID()) {
    return intelligence.observe({
      workspace,
      observations: [
        {
          ...scope(),
          type: "human-judgment-recorded",
          observationId: `${meetingId}:${observationId}`,
          occurredAt: corpus.referenceAt,
          observedAt: corpus.referenceAt,
          participantId: "person_jakob",
          judgment
        }
      ]
    });
  }

  async function next() {
    const step = fixture?.steps[position];
    if (!fixture || !step)
      throw new Error("No remaining scenario step. Load a scenario to start again.");
    switch (step.type) {
      case "observe": {
        model.sampleId = step.sample;
        const observations: MeetingObservation[] = step.utterances.map((index) => {
          const utterance = fixture?.utterances[index];
          if (!utterance) throw new Error("Missing fixture utterance");
          const at = utterance.occurredAt ?? corpus.referenceAt;
          return {
            ...scope(),
            type: "utterance-committed",
            observationId: `${meetingId}:${step.id}:${index}`,
            utteranceId: `${meetingId}:${step.id}:${index}`,
            version: 1,
            occurredAt: at,
            observedAt: at,
            startedAt: at,
            endedAt: at,
            originalText: utterance.text,
            language: fixture?.language ?? "mixed",
            speaker: {
              status: "attributed",
              personId: utterance.speakerId,
              confidence: "deterministic",
              basis: "provider-identity"
            }
          };
        });
        result = await intelligence.observe({ workspace, observations });
        lastObservation = observations;
        break;
      }
      case "judge":
        result = await judge(
          {
            kind: "correct",
            meetingItemId: step.itemId,
            correction: {
              ...(step.correction.status !== undefined
                ? { status: step.correction.status }
                : {}),
              ...(step.correction.ownerId !== undefined
                ? { ownerId: step.correction.ownerId }
                : {}),
              ...(step.correction.description !== undefined
                ? { statement: step.correction.description }
                : {})
            }
          },
          step.id
        );
        break;
      case "snapshot":
        result = await intelligence.query({ ...scope(), query: { type: "snapshot" } });
        break;
      case "ask":
        result = await intelligence.query({
          ...scope(),
          query: {
            type: "freeform",
            text: step.text,
            ...(step.participantId ? { participantId: step.participantId } : {})
          }
        });
        break;
      case "conclude":
        result = await intelligence.conclude(scope());
        break;
      default:
        throw new Error("This scenario is available in the full offline checks.");
    }
    position++;
  }

  async function view() {
    const snapshot = meetingId
      ? await intelligence.query({ ...scope(), query: { type: "snapshot" } })
      : null;
    return {
      mode: "Offline sandbox — simulated AI proposals, real Luma core",
      referenceAt: corpus.referenceAt,
      timezone: corpus.timezone,
      scenarios: scenarios.map((f) => ({
        id: f.id,
        utterances: f.utterances,
        steps: f.steps
      })),
      scenario: fixture?.id ?? null,
      position,
      state: snapshot?.type === "snapshot" ? snapshot.state : null,
      result,
      paidRequests: 0,
      costUsd: 0
    };
  }

  return {
    view,
    close: () => database.close(),
    async execute(input: unknown) {
      const command = commandSchema.parse(input);
      if (command.type === "load") {
        const selected = scenarios.find((s) => s.id === command.scenario);
        if (!selected) throw new Error("Unknown scenario");
        fixture = selected;
        // Every load has its own Meeting; prior sandbox observations remain intact until exit.
        meetingId = `sandbox:${randomUUID()}`;
        position = 0;
        lastObservation = undefined;
        result = null;
        await next();
      } else {
        if (!fixture) throw new Error("Load a scenario first");
        switch (command.type) {
          case "next":
            await next();
            break;
          case "replay":
            if (!lastObservation) throw new Error("No observation to replay");
            result = await intelligence.observe({
              workspace,
              observations: lastObservation
            });
            break;
          case "ask":
            result = await intelligence.query({
              ...scope(),
              query: {
                type: "freeform",
                text: command.text,
                participantId: "person_jakob"
              }
            });
            break;
          case "conclude":
            result = await intelligence.conclude(scope());
            break;
          case "judge": {
            const snapshot = await intelligence.query({
              ...scope(),
              query: { type: "snapshot" }
            });
            if (snapshot.type !== "snapshot") throw new Error("Missing snapshot");
            const items = [...snapshot.state.actionItems, ...snapshot.state.decisions];
            if (!items.some((item) => item.id === command.itemId))
              throw new Error("Select a current action or decision");
            if (
              command.action === "owner" &&
              (!command.owner ||
                !snapshot.state.actionItems.some((item) => item.id === command.itemId))
            )
              throw new Error("An action and owner are required");
            result = await judge(
              command.action === "confirm" || command.action === "reject"
                ? { kind: command.action, meetingItemId: command.itemId }
                : {
                    kind: "correct",
                    meetingItemId: command.itemId,
                    correction:
                      command.action === "supersede"
                        ? { status: "superseded" }
                        : { ownerId: command.owner! }
                  }
            );
            break;
          }
        }
      }
      return view();
    }
  };
}
