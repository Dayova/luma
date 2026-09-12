import { createLocalDiscord } from "./discord.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AiServiceError } from "../ai/ai-service-error.js";
import { createAiUsageBudget } from "../ai/ai-usage-budget.js";
import {
  createOpenAIReasoningModel,
  type OpenAIResponseClient
} from "../ai/openai-reasoning-model.js";
import { DEFAULT_OPENAI_REASONING_MODEL } from "../ai/openai-model-config.js";
import {
  createOpenAIContextAnswerer,
  type OpenAIContextAnswererResponseClient
} from "../context-intelligence/openai-context-answerer.js";
import { createContextIntelligence } from "../context-intelligence/context-intelligence.js";
import {
  createObservedSourceLedger,
  type RawConversationMessage,
  type RawConversationSnapshot
} from "../knowledge/observed-source-ledger.js";
import type { HumanJudgment, MeetingObservation } from "../domain/model.js";
import { createMeetingIntelligence } from "../meeting-intelligence/meeting-intelligence.js";
import type { LumaDatabase } from "../persistence/db.js";

const workspaceId = "luma-local-ai";
const founders = [
  "person_jakob",
  "person_fabius",
  "person_philipp",
  "person_julius"
] as const;
const commandSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("connect"), apiKey: z.string().trim().min(20).max(512) })
    .strict(),
  z.object({ type: z.literal("disconnect") }).strict(),
  z.object({ type: z.enum(["discord-check", "discord-start", "discord-stop"]) }).strict(),
  z
    .object({
      type: z.literal("analyze"),
      text: z.string().trim().min(1).max(12000),
      title: z.string().trim().min(1).max(120)
    })
    .strict(),
  z.object({ type: z.literal("select"), meetingId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("ask"), text: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("replay") }).strict(),
  z.object({ type: z.literal("conclude") }).strict(),
  z
    .object({
      type: z.literal("judge"),
      itemId: z.string().min(1).max(200),
      action: z.enum(["confirm", "reject", "owner"]),
      owner: z.enum(founders).optional()
    })
    .strict()
]);
type MeetingRow = {
  id: string;
  title: string;
  text: string;
  created_at: string;
  judgments_json: string;
};
class LocalInputError extends Error {}

/** Owns pasted sources and the optional development Discord runtime; canonical writes stay disabled. */
export async function createLiveSandboxSession(options: {
  database: LumaDatabase;
  discordDirectory?: string;
  apiKey?: string;
  /** Only deterministic tests supply response clients. The launcher always uses native adapters. */
  clients?: {
    reasoning: OpenAIResponseClient;
    answer: OpenAIContextAnswererResponseClient;
  };
  now?: () => Date;
}) {
  const database = options.database;
  const now = options.now ?? (() => new Date());
  await database.exec(`CREATE TABLE IF NOT EXISTS local_ai_meetings (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, text TEXT NOT NULL,
    created_at TEXT NOT NULL, judgments_json TEXT NOT NULL DEFAULT '[]'
  )`);
  await database.exec(`CREATE TABLE IF NOT EXISTS local_ai_questions (
    id TEXT PRIMARY KEY, asked_at TEXT NOT NULL
  )`);
  const budget = createAiUsageBudget({
    database,
    monthlyLimitUsd: 1,
    workflowLimitUsd: 0.05,
    maxWorkflowAttempts: 1,
    timezone: "Europe/Berlin",
    now
  });
  const discord = options.discordDirectory
    ? createLocalDiscord({ directory: options.discordDirectory, budget })
    : undefined;
  let apiKey = options.apiKey?.trim() || "";
  delete options.apiKey;
  let selected = (
    await database.query<MeetingRow>(
      "SELECT * FROM local_ai_meetings ORDER BY created_at DESC, id DESC LIMIT 1"
    )
  ).rows[0]?.id;
  let result: unknown = null;
  let error: { code: string; message: string } | null = null;
  const limits = { maxInputTokens: 50000, maxOutputTokens: 4096, timeoutMs: 60000 };

  const intelligence = () =>
    createMeetingIntelligence({
      database,
      now,
      reasoningModel: createOpenAIReasoningModel({
        apiKey,
        budget,
        limits,
        ...(options.clients ? { client: options.clients.reasoning } : {})
      })
    });
  async function meeting() {
    const row = selected
      ? (
          await database.query<MeetingRow>(
            "SELECT * FROM local_ai_meetings WHERE id = $1",
            [selected]
          )
        ).rows[0]
      : undefined;
    if (!row) throw new LocalInputError("Analyze or select a meeting first.");
    return row;
  }
  function requireKey() {
    if (!apiKey && !options.clients)
      throw new LocalInputError(
        "Enter your OpenAI API key in the connection panel first."
      );
  }
  function observations(row: MeetingRow): MeetingObservation[] {
    return [
      {
        type: "utterance-committed",
        observationId: `local:${row.id}`,
        workspaceId,
        meetingId: row.id,
        occurredAt: row.created_at,
        observedAt: row.created_at,
        startedAt: row.created_at,
        endedAt: row.created_at,
        utteranceId: `paste:${row.id}`,
        version: 1,
        language: "mixed",
        originalText: row.text,
        // A pasted transcript is not proof that its submitter spoke every line.
        speaker: {
          status: "unresolved",
          candidatePersonId: null,
          confidence: "unknown",
          basis: "legacy-unverified"
        }
      }
    ];
  }
  // Querying existing state never constructs a live model or requires credentials.
  const reader = createMeetingIntelligence({
    database,
    now,
    reasoningModel: {
      generateStructured: () =>
        Promise.reject(
          new AiServiceError(
            "not-configured",
            "This local operation does not run AI analysis."
          )
        )
    }
  });
  async function view() {
    const meetings = (
      await database.query<Pick<MeetingRow, "id" | "title" | "created_at">>(
        "SELECT id,title,created_at FROM local_ai_meetings ORDER BY created_at DESC,id DESC LIMIT 50"
      )
    ).rows;
    let state: unknown = null;
    if (selected) {
      try {
        const snapshot = await reader.query({
          workspaceId,
          meetingId: selected,
          query: { type: "snapshot" }
        });
        if (snapshot.type === "snapshot") state = snapshot.state;
      } catch {
        /* A saved submission can outlive an interrupted initial observation. */
      }
    }
    const row = selected ? await meeting() : undefined;
    return {
      mode: "live-ai",
      discord: discord?.status() ?? null,
      model: DEFAULT_OPENAI_REASONING_MODEL,
      connected: !!apiKey || !!options.clients,
      meetings,
      selected: selected ?? null,
      state,
      result,
      error,
      source: row
        ? { text: row.text, title: row.title, referenceAt: row.created_at }
        : null,
      usage: await budget.getStatus(workspaceId)
    };
  }
  return {
    view,
    async close() {
      apiKey = "";
      await discord?.stop();
      await database.close();
    },
    async execute(input: unknown) {
      error = null;
      result = null;
      try {
        const parsed = commandSchema.safeParse(input);
        if (!parsed.success)
          throw new LocalInputError(
            "Invalid input. Use a key of 20–512 characters, source text up to 12,000 characters, and questions up to 2,000 characters."
          );
        const command = parsed.data;
        if (
          command.type === "discord-check" ||
          command.type === "discord-start" ||
          command.type === "discord-stop"
        ) {
          if (!discord)
            throw new LocalInputError("Discord testing is unavailable in this session.");
          if (command.type === "discord-check") await discord.check();
          else if (command.type === "discord-start") await discord.start(apiKey);
          else await discord.stop();
        } else if (command.type === "connect") {
          await discord?.stop();
          apiKey = command.apiKey;
          result = {
            message:
              "Key loaded in memory. Provider access is checked on your first AI request."
          };
        } else if (command.type === "disconnect") {
          await discord?.stop();
          apiKey = "";
          result = { message: "Key removed from the session." };
        } else if (command.type === "select") {
          const previous = selected;
          selected = command.meetingId;
          try {
            await meeting();
          } catch (cause) {
            selected = previous;
            throw cause;
          }
        } else if (command.type === "analyze") {
          requireKey();
          const row: MeetingRow = {
            id: randomUUID(),
            title: command.title,
            text: command.text,
            created_at: now().toISOString(),
            judgments_json: "[]"
          };
          await database.query(
            "INSERT INTO local_ai_meetings (id,title,text,created_at) VALUES ($1,$2,$3,$4)",
            [row.id, row.title, row.text, row.created_at]
          );
          selected = row.id;
          result = await intelligence().observe({
            workspace: { workspaceId, timezone: "Europe/Berlin" },
            observations: observations(row)
          });
        } else {
          const row = await meeting();
          const scope = { workspaceId, meetingId: row.id };
          if (command.type === "replay") {
            // Exact duplicate evidence does not request another model interpretation.
            result = await reader.observe({
              workspace: { workspaceId, timezone: "Europe/Berlin" },
              observations: observations(row)
            });
          } else if (command.type === "conclude") result = await reader.conclude(scope);
          else if (command.type === "judge") {
            const snapshot = await reader.query({
              ...scope,
              query: { type: "snapshot" }
            });
            if (snapshot.type !== "snapshot")
              throw new LocalInputError("No meeting state is available.");
            const item = [
              ...snapshot.state.actionItems,
              ...snapshot.state.decisions
            ].find((item) => item.id === command.itemId);
            if (!item) throw new LocalInputError("Select a current action or decision.");
            if (
              command.action === "owner" &&
              (!command.owner ||
                !snapshot.state.actionItems.some((item) => item.id === command.itemId))
            )
              throw new LocalInputError("Select an action and its owner.");
            const judgment: HumanJudgment =
              command.action === "owner"
                ? {
                    kind: "correct",
                    meetingItemId: item.id,
                    correction: { ownerId: command.owner! }
                  }
                : { kind: command.action, meetingItemId: item.id };
            const observationId = randomUUID();
            const at = now().toISOString();
            const commands = z
              .array(z.object({ id: z.string(), at: z.string(), text: z.string() }))
              .parse(JSON.parse(row.judgments_json));
            commands.push({
              id: observationId,
              at,
              text: `Jakob instructed Luma: ${JSON.stringify(judgment)}. Selected item: ${"description" in item ? item.description : item.statement}`
            });
            await database.query(
              "UPDATE local_ai_meetings SET judgments_json = $1 WHERE id = $2",
              [JSON.stringify(commands), row.id]
            );
            result = await reader.observe({
              workspace: { workspaceId, timezone: "Europe/Berlin" },
              observations: [
                {
                  ...scope,
                  type: "human-judgment-recorded",
                  observationId,
                  occurredAt: at,
                  observedAt: at,
                  participantId: "person_jakob",
                  judgment
                }
              ]
            });
          } else if (command.type === "ask") {
            requireKey();
            const snapshot = await reader.query({
              ...scope,
              query: { type: "snapshot" }
            });
            if (snapshot.type !== "snapshot")
              throw new LocalInputError("No meeting state is available.");
            // Persisted user commands are original Human input, explicitly described as instructions.
            const humanInstructions = z
              .array(z.object({ id: z.string(), at: z.string(), text: z.string() }))
              .parse(JSON.parse(row.judgments_json));
            const questionId = createHash("sha256")
              .update(JSON.stringify([row.id, row.judgments_json, command.text]))
              .digest("hex");
            await database.query(
              "INSERT INTO local_ai_questions(id, asked_at) VALUES ($1,$2) ON CONFLICT DO NOTHING",
              [questionId, now().toISOString()]
            );
            const questionAt = (
              await database.query<{ asked_at: string }>(
                "SELECT asked_at FROM local_ai_questions WHERE id = $1",
                [questionId]
              )
            ).rows[0]!.asked_at;
            const message: RawConversationMessage = {
              id: "source",
              ordinal: 0,
              author: {
                providerUserId: "local-submitter",
                displayName: "Locally supplied transcript",
                personId: null
              },
              createdAt: row.created_at,
              editedAt: null,
              replyToMessageId: null,
              url: `https://local.luma.invalid/meetings/${row.id}#source`,
              state: "available",
              text: row.text
            };
            const corrections: RawConversationMessage[] = humanInstructions.map(
              (entry, index) => ({
                id: entry.id,
                ordinal: index + 1,
                author: {
                  providerUserId: "local-jakob",
                  displayName: "Jakob",
                  personId: "person_jakob"
                },
                createdAt: entry.at,
                editedAt: null,
                replyToMessageId: null,
                url: `https://local.luma.invalid/meetings/${row.id}#judgment-${index}`,
                state: "available",
                text: entry.text
              })
            );
            const messages: RawConversationMessage[] = [
              message,
              ...corrections,
              {
                ...message,
                id: questionId,
                ordinal: corrections.length + 1,
                author: {
                  providerUserId: "local-jakob",
                  displayName: "Jakob",
                  personId: "person_jakob"
                },
                createdAt: questionAt,
                text: command.text,
                url: `https://local.luma.invalid/meetings/${row.id}#${questionId}`
              }
            ];
            const subject = {
              type: "conversation-thread" as const,
              providerId: "local-paste",
              conversationObjectId: row.id,
              anchorMessageId: questionId
            };
            const capture: RawConversationSnapshot = {
              schemaVersion: 1,
              conversation: {
                conversationObjectId: row.id,
                parentConversationObjectId: null,
                title: row.title,
                url: message.url
              },
              boundary: {
                mode: "thread",
                anchorMessageId: questionId,
                firstMessageId: "source",
                lastMessageId: questionId,
                messageIds: messages.map((m) => m.id)
              },
              messages,
              completeness: { state: "complete" }
            };
            const context = createContextIntelligence({
              database,
              now,
              ledger: createObservedSourceLedger({ database }),
              conversationEvidenceSource: {
                capture: () =>
                  Promise.resolve({
                    source: {
                      providerId: "local-paste",
                      sourceKind: "conversation",
                      sourceObjectId: questionId,
                      parentObjectId: row.id,
                      url: message.url
                    },
                    providerVersion: null,
                    snapshot: capture,
                    observedAt: questionAt
                  })
              },
              answerer: createOpenAIContextAnswerer({
                apiKey,
                budget,
                limits,
                ...(options.clients ? { client: options.clients.answer } : {})
              })
            });
            result = await context.inquire({
              type: "ask",
              workspaceId,
              inquiryId: questionId,
              question: command.text,
              subject
            });
          }
        }
      } catch (cause) {
        // Never return provider error bodies, API keys or arbitrary thrown input to the browser.
        error =
          cause instanceof LocalInputError
            ? { code: "input", message: cause.message }
            : cause instanceof AiServiceError
              ? { code: cause.code, message: cause.message }
              : {
                  code: "operation-failed",
                  message:
                    "Luma could not complete this operation. Inspect the retained state and usage. An already-attempted question is not sent again automatically."
                };
      }
      return view();
    }
  };
}
