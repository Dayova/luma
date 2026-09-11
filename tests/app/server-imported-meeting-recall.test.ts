import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer } from "../../src/app/server.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";
import * as importedRuntime from "../../src/app/imported-source-analysis-runtime.js";
import * as sourceRuntime from "../../src/knowledge/notion-meeting-notes-source.js";
import { createGrantedImportedSourceAnalysisAccess } from "../../src/knowledge/granted-imported-source-analysis-access.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import type {
  RawConversationSnapshot,
  RawMeetingNoteSnapshot
} from "../../src/knowledge/observed-source-ledger.js";
import type { StructuredReasoningRequest } from "../../src/ai/reasoning-model.js";
import type { ContextAnswerRequest } from "../../src/context-intelligence/context-answerer.js";
import type { ContextCatalog } from "../../src/organizational-context/interface.js";
import type { MeetingState } from "../../src/domain/model.js";
import type { DiscordJsTransport } from "../../src/discord/discord-js-adapter.js";

const time = "2026-09-11T09:00:00.000Z";
const workspaceId = "workspace_recall_runtime";
const parent = "100000000000000001";
const thread = "100000000000000002";
const messageId = "100000000000000003";
const actor = "779381502311137301";
const page = "00000000-0000-0000-0000-000000000001";
const originalText =
  "We could stage the Luma rollout next week; this is still a proposal.";
const source = {
  providerId: "notion",
  sourceKind: "meeting-note" as const,
  sourceObjectId: "runtime-meeting-root",
  parentObjectId: page,
  url: `https://notion.so/${page}`
};
const raw: RawMeetingNoteSnapshot = {
  schemaVersion: 1,
  title: "Luma rollout discussion",
  lifecycle: "ready",
  calendar: null,
  recording: null,
  sections: {
    summary: { state: "available", sourceBlockId: "summary", text: "", blocks: [] },
    actionItemsAndNotes: {
      state: "available",
      sourceBlockId: "notes",
      text: "",
      blocks: []
    },
    transcript: {
      state: "available",
      sourceBlockId: "transcript",
      text: originalText,
      blocks: []
    }
  },
  markdown: {
    content: "# Luma rollout discussion",
    truncated: false,
    unknownBlockIds: []
  },
  completeness: { state: "complete" }
};
const conversation: RawConversationSnapshot = {
  schemaVersion: 1,
  conversation: {
    conversationObjectId: thread,
    parentConversationObjectId: parent,
    title: "Different founder discussion",
    url: `https://discord.com/channels/guild/${thread}`
  },
  boundary: {
    mode: "thread",
    anchorMessageId: messageId,
    firstMessageId: messageId,
    lastMessageId: messageId,
    messageIds: [messageId]
  },
  messages: [
    {
      id: messageId,
      ordinal: 0,
      author: { providerUserId: actor, displayName: "Jakob", personId: "person_jakob" },
      createdAt: time,
      editedAt: null,
      replyToMessageId: null,
      url: `https://discord.com/channels/guild/${thread}/${messageId}`,
      state: "available",
      text: "What did we decide about the Luma rollout?"
    }
  ],
  completeness: { state: "complete" }
};

afterEach(() => vi.restoreAllMocks());

describe("production imported Meeting recall composition", () => {
  it("recalls an actual runtime import with external context and fences both source and external grants", async () => {
    const database = await createPgliteDatabase();
    const warnings = vi.spyOn(console, "warn");
    let finishScan: () => void = () => undefined;
    const scanCompleted = new Promise<void>((resolve) => {
      finishScan = resolve;
    });
    let sourceAllowed = true;
    let externalAllowed = true;
    const audiences: string[][] = [];
    const requests: StructuredReasoningRequest<unknown>[] = [];
    const answers: ContextAnswerRequest[] = [];
    const external: ContextCatalog = {
      id: "programmable-external-guide",
      search: () =>
        Promise.resolve({ sourceIds: ["guide"], complete: true, warnings: [] }),
      read: ({ audience }) => {
        audiences.push([...audience.personIds]);
        return Promise.resolve(
          externalAllowed
            ? {
                id: "guide",
                kind: "knowledge-document",
                title: "Luma rollout policy",
                content: "A Luma rollout proposal still needs a founder decision.",
                version: "1",
                updatedAt: time,
                externalReference: {
                  providerId: "notion",
                  objectType: "document",
                  externalId: "guide",
                  url: "https://notion.so/guide"
                },
                standing: "current",
                authority: "source"
              }
            : null
        );
      }
    };
    vi.spyOn(importedRuntime, "importedSourceAnalysisFromEnv").mockImplementation(
      ({ ledger }) => ({
        audience: () =>
          Promise.resolve({ workspaceId, personIds: [...dayovaFounderPersonIds] }),
        access: createGrantedImportedSourceAnalysisAccess({
          ledger,
          authorize: ({ audience }) => {
            audiences.push([...audience.personIds]);
            return Promise.resolve(sourceAllowed);
          },
          evidenceSource: () => ({
            capture: () =>
              Promise.resolve({
                status: "captured",
                evidence: {
                  source,
                  providerVersion: time,
                  observedAt: time,
                  snapshot: structuredClone(raw)
                }
              })
          })
        })
      })
    );
    vi.spyOn(sourceRuntime, "createNotionMeetingNotesSourceFromEnv").mockImplementation(
      ({ ledger }) => ({
        scan: async () => ({
          records: [
            await ledger.record({
              workspaceId,
              source,
              providerVersion: time,
              observedAt: time,
              snapshot: structuredClone(raw)
            })
          ],
          nextCursor: null,
          completeness: "complete",
          partialReasons: [],
          completeScan: {
            reconcileAbsent: () => {
              finishScan();
              return Promise.resolve({ tombstones: [], partialReasons: [] });
            }
          }
        }),
        refreshPage: () => Promise.reject(new Error("No refresh requested"))
      })
    );
    let ask: Parameters<DiscordJsTransport["connect"]>[1];
    const transport: DiscordJsTransport = {
      connect: (_command, context) => {
        ask = context;
        return Promise.resolve();
      },
      disconnect: () => Promise.resolve(),
      resolveChannel: ({ channelId }) =>
        Promise.resolve({
          id: channelId,
          guildId: "guild",
          kind: channelId === parent ? "text-channel" : "public-thread",
          parentChannelId: channelId === parent ? null : parent
        }),
      createThread: () =>
        Promise.reject(new Error("The existing Ask thread must be reused")),
      sendMessage: () =>
        Promise.reject(new Error("The Ask response is returned to its transport")),
      capture: () =>
        Promise.resolve({
          source: {
            providerId: "discord",
            sourceKind: "conversation",
            sourceObjectId: messageId,
            parentObjectId: thread,
            url: conversation.messages[0]!.url
          },
          providerVersion: null,
          observedAt: time,
          snapshot: structuredClone(conversation)
        })
    };
    const app = await startServer(
      {
        DISCORD_TOKEN: "test-only",
        DISCORD_CLIENT_ID: "client_recall",
        DISCORD_GUILD_ID: "guild",
        OPENAI_API_KEY: "test-only",
        LUMA_WORKSPACE_ID: workspaceId,
        LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: parent,
        LUMA_DISCORD_CONTEXT_ASK_ENABLED: "1",
        LUMA_DISCORD_CONTEXT_ASK_PARENT_CHANNEL_IDS: parent,
        LUMA_DISCORD_CONTEXT_ASK_ALLOWED_DISCORD_USER_IDS: actor,
        NOTION_API_TOKEN: "test-only",
        NOTION_MEETINGS_DATA_SOURCE_ID: "00000000-0000-0000-0000-000000000002",
        LUMA_ORGANIZATIONAL_CONTEXT_ENABLED: "1",
        LUMA_CONTEXT_SHARING_POLICY_PATH: "/test/programmable-policy.json",
        LUMA_CONTEXT_NOTION_READONLY_API_TOKEN: "test-reader",
        LUMA_CONTEXT_NOTION_CREDENTIAL_SCOPE_ID: "test-scope",
        LUMA_CONTEXT_NOTION_PAGE_IDS: page
      },
      {
        createDatabase: () => Promise.resolve(database),
        createDiscordTransport: () => transport,
        createContextCatalogs: () => Promise.resolve([external]),
        createOpenAIReasoningModel: () => ({
          generateStructured: <T>(request: StructuredReasoningRequest<T>) => {
            requests.push(structuredClone(request));
            const transcript = request.evidence.find(
              (entry) => entry.source === "transcript"
            )!;
            const context = request.evidence.find((entry) =>
              entry.evidenceId.startsWith("organizational-context:")
            )!;
            return Promise.resolve({
              value: {
                actionItems: [],
                decisions: [
                  {
                    stableKey: "rollout",
                    statement: transcript.excerpt,
                    rationale: [],
                    status: "candidate",
                    supportingParticipantIds: [],
                    objectingParticipantIds: [],
                    relatedTopicIds: [],
                    evidenceIds: [transcript.evidenceId, context.evidenceId],
                    confidence: "high"
                  }
                ],
                openQuestions: [],
                risks: [],
                followUpIntentions: []
              } as T,
              metadata: {
                provider: "programmable",
                model: "synthetic",
                promptVersion: request.promptVersion
              }
            });
          }
        }),
        createOpenAIContextAnswerer: () => ({
          answer: (request) => {
            answers.push(structuredClone(request));
            const previous = request.organizationalEvidence?.find(
              (entry) => entry.kind === "previous-meeting-item"
            );
            if (!previous) throw new Error("The main-runtime import must be recallable");
            return Promise.resolve({
              answer: { text: originalText, evidenceIds: [previous.evidenceId] },
              facts: [],
              inferences: [],
              unresolved: [],
              metadata: {
                provider: "programmable",
                model: "synthetic",
                promptVersion: request.promptVersion
              }
            });
          }
        })
      }
    );
    try {
      // The accepted source delivery must finish before exercising revocation;
      // an intermediate persisted proposal is not a successful import receipt.
      await scanCompleted;
      expect(warnings).not.toHaveBeenCalled();
      await vi.waitFor(async () => {
        const rows = await database.query<{ state_json: string }>(
          "SELECT state_json FROM meetings WHERE workspace_id=$1",
          [workspaceId]
        );
        const state = rows.rows[0]
          ? (JSON.parse(rows.rows[0].state_json) as MeetingState)
          : null;
        expect(state?.decisions).toHaveLength(1);
        expect(
          state?.decisions[0]?.provenance.contextReceiptIds?.length
        ).toBeGreaterThanOrEqual(2);
      });
      expect(requests).toHaveLength(1);
      expect(
        requests[0]?.evidence.some((entry) => entry.source === "previous-meeting")
      ).toBe(false);
      expect(
        requests[0]?.evidence.some((entry) =>
          entry.evidenceId.startsWith("organizational-context:")
        )
      ).toBe(true);
      if (!ask) throw new Error("Context Ask was not connected");
      const response = await ask({
        guildId: "guild",
        channelId: thread,
        parentChannelId: parent,
        actorDiscordUserId: actor,
        occurredAt: time,
        messageId,
        question: conversation.messages[0]!.text!
      });
      expect(response?.content).toContain(originalText);
      expect(response?.content).toContain(source.url);
      expect(answers).toHaveLength(1);
      expect(
        answers[0]?.organizationalEvidence?.find(
          (entry) => entry.kind === "previous-meeting-item"
        )?.content
      ).toContain("proposal still needs a founder decision");
      expect(
        audiences.every(
          (ids) =>
            JSON.stringify([...ids].sort()) ===
            JSON.stringify([...dayovaFounderPersonIds].sort())
        )
      ).toBe(true);
      expect(response?.requireCurrent).toBeDefined();
      await response!.requireCurrent!();
      externalAllowed = false;
      await expect(response!.requireCurrent!()).rejects.toThrow();
      externalAllowed = true;
      await response!.requireCurrent!();
      sourceAllowed = false;
      await expect(response!.requireCurrent!()).rejects.toThrow();
      expect(answers).toHaveLength(1);
    } finally {
      await app.stop();
    }
  });
});
