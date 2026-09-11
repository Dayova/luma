import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningLumaApp } from "../../src/app/server.js";
import { createDecisionRuntime } from "../../src/app/decision-runtime.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import { createNotionReadOnlyKnowledgeCatalogForTest } from "../../src/knowledge/notion-read-only-knowledge-catalog.js";
import {
  createNotionDecisionRecords,
  type NotionDecisionTransport
} from "../../src/knowledge/notion-decision-records.js";
import { createOpenAIDecisionInterpreter } from "../../src/decision-intelligence/openai-decision-interpreter.js";
import { decisionAuthorityContentHash } from "../../src/decision-intelligence/notion-decision-authority.js";
import type { DecisionSource } from "../../src/domain/decision-records.js";
import type { DiscordJsTransport } from "../../src/discord/discord-js-adapter.js";
import type { DiscordContextAskMention } from "../../src/discord/discord-context-ask-runtime.js";
import { captureFixture, subject, workspace } from "../consultation/harness.js";

const authorityId = "3bc2e872-28bf-8193-9669-ec8c5a94aae3";
const dataSourceId = "3d52e872-28bf-80ae-befe-d1c0e2c39df5";
const recordPageId = "3d52e872-28bf-81f9-8d79-c1233431c8bd";
const founders =
  "779381502311137301,726409024894926869,1492911575806251219,1376219174723911841";
let database: LumaDatabase, folder: string, app: RunningLumaApp | undefined;
beforeEach(async () => {
  database = await createPgliteDatabase();
  folder = await mkdtemp(join(tmpdir(), "luma-decision-runtime-"));
});
afterEach(async () => {
  if (app) await app.stop();
  else await database.close();
  app = undefined;
  await rm(folder, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function fixture(monthlyLimit = "30") {
  const authorityText =
    "Jakob owns Luma, including technical work. Other roles remain provisional.";
  const authorityPath = join(folder, "authority.json"),
    sharingPath = join(folder, "sharing.json");
  const sharing = {
    version: 1,
    workspaceId: workspace.workspaceId,
    grants: [
      {
        provider: "notion",
        credentialScopeId: "authority-read",
        resources: [authorityId],
        personIds: [...dayovaFounderPersonIds]
      },
      {
        provider: "notion",
        credentialScopeId: "decisions-write",
        resources: [dataSourceId],
        personIds: [...dayovaFounderPersonIds]
      }
    ]
  };
  await writeFile(sharingPath, JSON.stringify(sharing), { mode: 0o600 });
  await writeFile(
    authorityPath,
    JSON.stringify({
      schemaVersion: 1,
      workspaceId: workspace.workspaceId,
      documentId: authorityId,
      contentHash: decisionAuthorityContentHash(authorityText),
      grants: [
        {
          id: "luma-owner",
          personId: "person_jakob",
          scopeId: "luma",
          kind: "project-ownership",
          standing: "current",
          excerpt: "Jakob owns Luma, including technical work.",
          delegatedBy: null,
          consultedPersonIds: []
        }
      ]
    }),
    { mode: 0o600 }
  );
  const env = {
    DISCORD_TOKEN: "test-only",
    DISCORD_CLIENT_ID: "application",
    DISCORD_GUILD_ID: "guild",
    LUMA_WORKSPACE_ID: workspace.workspaceId,
    LUMA_REASONING_MODEL_PROVIDER: "disabled",
    OPENAI_API_KEY: "test-only",
    LUMA_AI_MONTHLY_LIMIT_USD: monthlyLimit,
    LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: "100000000000000001",
    LUMA_DISCORD_DECISION_RECORDS_ENABLED: "1",
    LUMA_DISCORD_DECISION_RECORDS_PARENT_CHANNEL_IDS: "100000000000000001",
    LUMA_DISCORD_DECISION_RECORDS_ALLOWED_DISCORD_USER_IDS: founders,
    LUMA_DECISION_RECORDS_DATA_SOURCE_ID: dataSourceId,
    LUMA_DECISION_RECORDS_CREDENTIAL_SCOPE_ID: "decisions-write",
    LUMA_DECISION_RECORDS_SIGNING_KEY: "test-only-signing-key-longer-than-32-bytes",
    LUMA_DECISION_RECORDS_NOTION_API_TOKEN: "test-only-write",
    LUMA_DECISION_AUTHORITY_POLICY_PATH: authorityPath,
    LUMA_CONTEXT_SHARING_POLICY_PATH: sharingPath,
    LUMA_CONTEXT_NOTION_READONLY_API_TOKEN: "test-only-read",
    LUMA_CONTEXT_NOTION_CREDENTIAL_SCOPE_ID: "authority-read",
    LUMA_CONTEXT_NOTION_PAGE_IDS: authorityId
  };
  const raw = captureFixture();
  const anchor = raw.snapshot.messages[0]!;
  if (anchor.state !== "available") throw new Error("fixture");
  anchor.text = "<@luma> record this decision";
  anchor.ordinal = 1;
  const statement = {
    ...structuredClone(anchor),
    id: "300000000000000000",
    ordinal: 0,
    text: "Luma bleibt vorerst nur für uns vier Gründer intern."
  };
  raw.snapshot.messages.unshift(statement);
  raw.snapshot.boundary.firstMessageId = statement.id;
  raw.snapshot.boundary.messageIds.unshift(statement.id);
  let channelCurrent = true,
    authorityCurrent = true,
    loseResponse = false;
  let handler: Parameters<DiscordJsTransport["connect"]>[1];
  let commandHandler: Parameters<DiscordJsTransport["connect"]>[0];
  const transport: DiscordJsTransport = {
    connect: (commands, mentions) => {
      commandHandler = commands;
      handler = mentions;
      return Promise.resolve();
    },
    disconnect: () => Promise.resolve(),
    capture: () =>
      channelCurrent
        ? Promise.resolve(structuredClone(raw))
        : Promise.reject(new Error("Source permission revoked")),
    resolveChannel: ({ channelId }) =>
      Promise.resolve(
        channelCurrent
          ? {
              id: channelId,
              guildId: "guild",
              kind: "public-thread",
              parentChannelId: "100000000000000001",
              botCanRead: true,
              botCanReply: true,
              botCanCreatePublicThreads: false
            }
          : null
      ),
    createThread: () => Promise.reject(new Error("No synthetic Meeting")),
    sendMessage: () => Promise.reject(new Error("No unrelated publication"))
  };
  const pages = new Map<string, string>();
  const writes: string[] = [];
  const notion: NotionDecisionTransport = {
    list: () =>
      Promise.resolve({
        object: "list",
        results: [...pages.keys()].map((id) => ({ object: "page", id })),
        has_more: false,
        next_cursor: null
      }),
    readPage: (id) =>
      Promise.resolve({
        object: "page",
        id,
        url: `https://notion.so/${id}`,
        archived: false,
        in_trash: false,
        last_edited_time: "2026-09-11T10:00:00Z",
        parent: { type: "data_source_id", data_source_id: dataSourceId }
      }),
    readMarkdown: (id) =>
      Promise.resolve({
        object: "page_markdown",
        id,
        markdown: pages.get(id),
        truncated: false,
        unknown_block_ids: []
      }),
    create: ({ markdown }) => {
      writes.push("create");
      pages.set(recordPageId, markdown);
      return loseResponse
        ? Promise.reject(new Error("Lost acknowledgement"))
        : Promise.resolve({ object: "page", id: recordPageId });
    },
    replace: () => Promise.reject(new Error("Unexpected patch"))
  };
  const model = vi.fn(({ input }: { input: string }) => {
    const parsed = JSON.parse(input) as { source: DecisionSource };
    const evidence = parsed.source.evidence.find(
      (item) => item.reference.sourceObjectId === statement.id
    )!;
    return Promise.resolve({
      outputText: JSON.stringify({
        candidate: {
          statement: { text: evidence.text, evidenceIds: [evidence.id] },
          modality: "final-decision",
          scopeId: "luma",
          decisionMakerPersonIds: ["person_jakob"],
          acceptanceEvidenceIds: [evidence.id],
          context: null,
          rationale: [],
          alternatives: [],
          consequences: [],
          effectiveAt: null,
          disposition: "adopt",
          objections: [],
          unresolved: [],
          relatedWorkReferenceIds: [],
          implementationReferenceIds: []
        },
        reconciliation: { action: "create" }
      }),
      model: "gpt-5.6-luna",
      serviceTier: "default",
      status: "completed",
      usage: {
        inputTokens: 100,
        cachedInputTokens: 10,
        cacheWriteTokens: 20,
        outputTokens: 10,
        reasoningTokens: 5
      }
    });
  });
  app = await startServer(env, {
    createDatabase: () => Promise.resolve(database),
    createDiscordTransport: () => transport,
    createOpenAIReasoningModel: () => {
      throw new Error("Meeting analysis is disabled");
    },
    createDecisionRuntime: (input) =>
      createDecisionRuntime(input, {
        createKnowledge: (config) =>
          createNotionReadOnlyKnowledgeCatalogForTest(config, {
            retrievePage: () =>
              Promise.resolve({
                object: "page",
                id: authorityId,
                url: `https://notion.so/${authorityId}`,
                archived: !authorityCurrent,
                in_trash: !authorityCurrent,
                last_edited_time: "2026-09-11T10:00:00Z",
                properties: {
                  Name: { type: "title", title: [{ plain_text: "Ownership" }] }
                }
              }),
            retrieveMarkdown: () =>
              Promise.resolve({
                object: "page_markdown",
                id: authorityId,
                markdown: authorityText,
                truncated: false,
                unknown_block_ids: []
              })
          }),
        createRecords: (config) =>
          createNotionDecisionRecords({ ...config, transport: notion }),
        createInterpreter: (config) =>
          createOpenAIDecisionInterpreter({ ...config, client: { create: model } })
      })
  });
  const mention: DiscordContextAskMention = {
    guildId: "guild",
    channelId: subject.conversationObjectId,
    parentChannelId: "100000000000000001",
    actorDiscordUserId: "779381502311137301",
    messageId: subject.anchorMessageId,
    question: "record this decision",
    occurredAt: "2026-09-11T10:00:00Z",
    purpose: "decision-record"
  };
  return {
    writes,
    pages,
    model,
    raw,
    mention,
    invoke: () => {
      if (!handler) throw new Error("Missing native mention handler");
      return handler(mention);
    },
    recover: () =>
      commandHandler({
        type: "decision-record-recover",
        interactionId: "recover-1",
        guildId: "guild",
        channelId: subject.conversationObjectId,
        actorDiscordUserId: mention.actorDiscordUserId,
        sourceMessageId: mention.messageId,
        requestId: `discord:${mention.messageId}:decision-record`,
        occurredAt: mention.occurredAt
      }),
    revokeChannel: () => {
      channelCurrent = false;
    },
    revokeAuthority: () => {
      authorityCurrent = false;
    },
    loseResponse: () => {
      loseResponse = true;
    },
    revokeDestination: async () => {
      sharing.grants = sharing.grants.filter(
        (grant) => grant.credentialScopeId !== "decisions-write"
      );
      await writeFile(sharingPath, JSON.stringify(sharing), { mode: 0o600 });
    }
  };
}
describe("composed production Decision Records", () => {
  it("records from a founder mention through real source, ownership, budget, MI, execution and Notion adapters without a Meeting", async () => {
    const f = await fixture();
    const result = await f.invoke();
    expect(result?.content).toContain(`https://notion.so/${recordPageId}`);
    expect(f.writes).toEqual(["create"]);
    expect(f.pages.get(recordPageId)).toContain("Luma bleibt");
    expect((await database.query("SELECT * FROM meetings")).rows).toEqual([]);
    expect(
      (await database.query("SELECT capability FROM ai_usage_requests")).rows
    ).toEqual([{ capability: "decision-interpretation" }]);
    await f.invoke();
    expect(f.writes).toEqual(["create"]);
    expect(f.model).toHaveBeenCalledTimes(1);
    f.revokeAuthority();
    await expect(result?.requireCurrent?.()).rejects.toThrow();
  });
  it("recovers a lost native creation acknowledgement by finding the signed original page without another write or model call", async () => {
    const f = await fixture();
    f.loseResponse();
    expect((await f.invoke())?.content).toContain("uncertain");
    expect(f.writes).toEqual(["create"]);
    const recovered = await f.recover();
    expect(recovered.content).toContain(`https://notion.so/${recordPageId}`);
    expect(recovered.content).toContain("recorded");
    expect(f.writes).toEqual(["create"]);
    expect(f.model).toHaveBeenCalledTimes(1);
  });
  it.each(["budget", "destination", "source"])(
    "exposes %s refusal with no canonical mutation",
    async (failure) => {
      const f = await fixture(failure === "budget" ? "0" : "30");
      if (failure === "destination") await f.revokeDestination();
      if (failure === "source") f.revokeChannel();
      const result = await f.invoke();
      expect(f.writes).toEqual([]);
      if (failure === "source") expect(result).toBeNull();
      else expect(result?.content).toBeTruthy();
      if (failure === "budget") expect(result?.content).toContain("AI budget reached");
      expect(f.model).not.toHaveBeenCalled();
    }
  );
});
