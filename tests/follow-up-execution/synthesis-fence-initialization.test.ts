import { describe, expect, it } from "vitest";
import type {
  MeetingAnalysisProposalBatch,
  ReasoningModel,
  StructuredReasoningRequest
} from "../../src/ai/reasoning-model.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import { createLumaTeamIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import type { KnowledgeProvider } from "../../src/knowledge/interface.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";

const workspace = { workspaceId: "workspace_dayova", timezone: "Europe/Berlin" };
const at = "2026-09-11T09:00:00.000Z";

describe("Synthesis execution fence initialization", () => {
  it("records successful receipts and idempotent replay without schema DDL in completion transactions", async () => {
    const store = await createPgliteDatabase();
    let rejectedTransactionalDDL = 0;
    let fenceInitializations = 0;
    let writes = 0;
    type Transaction = Parameters<Parameters<LumaDatabase["transaction"]>[0]>[0];
    const database = new Proxy(store, {
      get(target, property): unknown {
        if (property === "transaction")
          return (callback: (tx: Transaction) => Promise<unknown>) =>
            target.transaction((tx) =>
              callback(
                new Proxy(tx, {
                  get(transaction, key): unknown {
                    if (key === "query")
                      return <T>(sql: string, params?: unknown[]) => {
                        if (
                          sql.includes(
                            "CREATE TABLE IF NOT EXISTS synthesis_action_execution_fences"
                          )
                        ) {
                          rejectedTransactionalDDL++;
                          return Promise.reject(
                            new Error(
                              "Schema locks are forbidden in receipt transactions"
                            )
                          );
                        }
                        return transaction.query<T>(sql, params);
                      };
                    const value: unknown = Reflect.get(transaction, key, transaction);
                    return typeof value === "function" ? value.bind(transaction) : value;
                  }
                })
              )
            );
        if (property === "query")
          return <T>(sql: string, params?: unknown[]) => {
            if (
              sql.includes("CREATE TABLE IF NOT EXISTS synthesis_action_execution_fences")
            )
              fenceInitializations++;
            return target.query<T>(sql, params);
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const reasoningModel: ReasoningModel = {
      generateStructured<T>(request: StructuredReasoningRequest<T>) {
        const value: MeetingAnalysisProposalBatch = {
          decisions: [],
          actionItems: [],
          openQuestions: [],
          risks: [],
          followUpIntentions: [
            {
              type: "record-meeting",
              id: "record",
              title: "Release discussion",
              relatedMeetingItemIds: [],
              evidenceIds: [request.evidence[0]!.evidenceId],
              confidence: "high"
            }
          ]
        };
        return Promise.resolve({
          value: value as T,
          metadata: {
            provider: "fixture",
            model: "fixture",
            promptVersion: request.promptVersion
          }
        });
      }
    };
    const mi = createMeetingIntelligence({ database, reasoningModel });
    const knowledgeProvider: KnowledgeProvider = {
      providerId: "notion",
      search: () => Promise.resolve([]),
      getDocument: () => Promise.reject(new Error("No read expected")),
      listChanges: () => Promise.resolve({ changes: [], nextCursor: null }),
      createDocument: () => {
        writes++;
        return Promise.resolve({
          providerId: "notion",
          objectType: "document",
          externalId: "record",
          url: "https://notion.so/record"
        });
      }
    };
    try {
      await mi.observe({
        workspace,
        observations: [
          {
            type: "utterance-committed",
            observationId: "speech",
            workspaceId: workspace.workspaceId,
            meetingId: "meeting",
            occurredAt: at,
            observedAt: at,
            utteranceId: "speech",
            version: 1,
            speaker: {
              status: "attributed",
              personId: "person_jakob",
              confidence: "deterministic",
              basis: "provider-identity"
            },
            startedAt: at,
            endedAt: at,
            originalText: "We will record this release discussion.",
            language: "en"
          }
        ]
      });
      await mi.observe({
        workspace,
        observations: [
          {
            type: "follow-up-intent-approved",
            observationId: "approval",
            workspaceId: workspace.workspaceId,
            meetingId: "meeting",
            occurredAt: at,
            observedAt: at,
            intentId: "record",
            approvedBy: "person_jakob"
          }
        ]
      });
      const execution = createFollowUpExecution({
        database,
        meetingIntelligence: mi,
        identityDirectory: createLumaTeamIdentityDirectory(),
        knowledgeProvider
      });
      const input = { workspace, meetingId: "meeting", intentId: "record" };
      expect((await execution.execute(input)).observation.outcome.status).toBe(
        "succeeded"
      );
      expect((await execution.recover(input)).observation.outcome.status).toBe(
        "succeeded"
      );
      expect((await execution.execute(input)).observation.outcome.status).toBe(
        "succeeded"
      );
      expect(writes).toBe(1);
      expect(rejectedTransactionalDDL).toBe(0);
      expect(fenceInitializations).toBe(1);
    } finally {
      await store.close();
    }
  });
});
