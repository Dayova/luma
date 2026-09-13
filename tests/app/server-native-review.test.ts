import { createImportedSourceAnalysisRouter } from "../../src/app/imported-source-analysis-router.js";
import type { ImportedSourceAnalysisReceipt } from "../../src/meeting-intelligence/imported-source-analysis.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningLumaApp } from "../../src/app/server.js";
import { createNativeNotionReviewResources } from "../../src/app/native-notion-review-config.js";
import type { NativeNotionReviewRuntime } from "../../src/app/native-notion-review-runtime.js";
import { createOpenAIReasoningModel } from "../../src/ai/openai-reasoning-model.js";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import type { DiscordJsTransport } from "../../src/discord/discord-js-adapter.js";
import type { WorkProvider } from "../../src/work/interface.js";
import {
  createLinearReadOnlyApiForTest,
  createLinearReadOnlyWorkCatalogForTest
} from "../../src/work/linear-read-only-work-catalog.js";
import {
  evidence,
  ids,
  locator,
  people,
  providerHarness,
  workspace
} from "../native-review/native-notion-review-fixtures.js";

let database: LumaDatabase, folder: string, app: RunningLumaApp | undefined;
beforeEach(async () => {
  database = await createPgliteDatabase();
  folder = await mkdtemp(join(tmpdir(), "luma-main-native-"));
});
afterEach(async () => {
  if (app) await app.stop();
  else await database.close();
  app = undefined;
  await rm(folder, { recursive: true, force: true });
});

async function fixture(limit = "30", withWriter = false, providerId = "linear") {
  const h = providerHarness();
  const sharingPath = join(folder, "sharing.json");
  await writeFile(
    sharingPath,
    JSON.stringify({
      version: 1,
      workspaceId: workspace.workspaceId,
      grants: [
        {
          provider: "notion",
          credentialScopeId: "native-page",
          resources: [ids.page],
          personIds: people.map((p) => p.personId)
        },
        {
          provider: "linear",
          credentialScopeId: "native-linear",
          resources: ["team"],
          personIds: people.map((p) => p.personId)
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
    LUMA_IDENTITY_PEOPLE_JSON: JSON.stringify(people),
    LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: "100000000000000001",
    OPENAI_API_KEY: "test-only",
    LUMA_AI_MONTHLY_LIMIT_USD: limit,
    LUMA_NATIVE_REVIEW_ENABLED: "1",
    LUMA_NATIVE_NOTION_WORKSPACE_ID: ids.space,
    LUMA_NATIVE_NOTION_AGENT_ID: ids.agent,
    LUMA_NATIVE_NOTION_PAGE_ID: ids.page,
    LUMA_NATIVE_NOTION_AGENT_READ_TOKEN: "test-agent-reader",
    LUMA_NATIVE_NOTION_ADMIN_READ_TOKEN: "test-admin-reader",
    LUMA_NATIVE_NOTION_READONLY_API_TOKEN: "test-page-reader",
    LUMA_NATIVE_NOTION_CREDENTIAL_SCOPE_ID: "native-page",
    LUMA_LINEAR_PROVIDER_ID: providerId,
    LINEAR_READONLY_API_KEY: "test-linear-reader",
    LINEAR_TEAM_ID: "team",
    LUMA_NATIVE_LINEAR_CREDENTIAL_SCOPE_ID: "native-linear",
    LUMA_CONTEXT_SHARING_POLICY_PATH: sharingPath,
    LUMA_NATIVE_REVIEW_MCP_BEARER_TOKEN: "test-only-native-bearer-longer-than-32-bytes"
  };
  const disconnect = vi.fn(() => Promise.resolve());
  const transport: DiscordJsTransport = {
    connect: () => Promise.resolve(),
    disconnect,
    resolveChannel: () => Promise.resolve(null),
    capture: () => Promise.reject(new Error("No Discord source capture")),
    createThread: () => Promise.reject(new Error("No thread creation")),
    sendMessage: () => Promise.reject(new Error("No Discord publication"))
  };
  let native!: NativeNotionReviewRuntime;
  let releaseProof: (() => void) | undefined,
    proofEntered: (() => void) | undefined,
    hold: Promise<void> | undefined;
  let holdOnce = false;
  const readSearch = vi.fn(() => Promise.resolve([]));
  const writerCall = vi.fn(() =>
    Promise.reject(new Error("Native review must use the read-only catalog"))
  );
  const writer: WorkProvider = {
    providerId,
    searchWorkItems: writerCall,
    getWorkItem: writerCall,
    createWorkItem: writerCall,
    updateWorkItem: writerCall,
    addComment: writerCall
  };
  const sdk = vi.fn(() =>
    Promise.resolve({
      outputText: JSON.stringify({
        actionItems: [],
        decisions: [],
        openQuestions: [],
        risks: [],
        followUpIntentions: []
      }),
      model: "gpt-5.6-luna",
      serviceTier: "default",
      status: "completed",
      usage: {
        inputTokens: 100,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 20,
        reasoningTokens: 0
      }
    })
  );
  const close = vi.spyOn(database, "close");
  app = await startServer(env, {
    createDatabase: () => Promise.resolve(database),
    createDiscordTransport: () => transport,
    ...(withWriter ? { createWorkProvider: () => writer } : {}),
    createOpenAIReasoningModel: (input) =>
      createOpenAIReasoningModel({ ...input, client: { create: sdk } }),
    createNativeNotionReviewResources: (input) => {
      const resources = createNativeNotionReviewResources(
        { ...input, config: { ...input.config, port: 0 } },
        {
          createAccess: () => h.createAccess(),
          createEvidenceSource: () => ({
            capture: async () => {
              if (holdOnce) {
                holdOnce = false;
                proofEntered?.();
                await hold;
                await database.query("SELECT 1");
              }
              return { status: "captured", evidence: evidence() };
            }
          }),
          createWorkCatalog: (config) =>
            createLinearReadOnlyWorkCatalogForTest({
              providerId: config.providerId ?? "linear",
              teamId: "team",
              api: createLinearReadOnlyApiForTest({
                searchIssues: readSearch,
                getIssue: () => Promise.reject(new Error("Unexpected lookup"))
              })
            })
        }
      );
      return {
        ...resources,
        createRuntime: (shared) => {
          const host = resources.createRuntime(shared);
          native = host.runtime;
          return host;
        }
      };
    }
  });
  return {
    env,
    transport,
    h,
    native,
    sdk,
    readSearch,
    writerCall,
    close,
    disconnect,
    holdNextProof() {
      hold = new Promise<void>((resolve) => {
        releaseProof = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        proofEntered = resolve;
      });
      holdOnce = true;
      return { entered, release: () => releaseProof?.() };
    }
  };
}

describe("native Notion review in shared production composition", () => {
  it("uses one MI, durable source proof and AI ledger with a dedicated reader alongside an existing writer", async () => {
    const h = await fixture("30", true, "linear_dayova");
    const first = await h.native.review(locator);
    expect(first.receipt.outcome.type).toBe("reviewed");
    expect(first.reviews).toHaveLength(1);
    expect(first.analysis.status).toBe("completed");
    expect(h.readSearch).toHaveBeenCalled();
    expect(h.writerCall).not.toHaveBeenCalled();
    expect(h.sdk).toHaveBeenCalledTimes(1);
    expect(await h.native.review(locator)).toEqual(first);
    expect(h.sdk).toHaveBeenCalledTimes(1);
    expect(
      (await database.query("SELECT * FROM meeting_imported_source_receipts")).rows
    ).toHaveLength(1);
    h.h.permissions.permissions.pop();
    await expect(h.native.review(locator)).rejects.toThrow();
    expect(
      (await database.query("SELECT * FROM native_review_instructions")).rows
    ).toHaveLength(1);
    expect(h.writerCall).not.toHaveBeenCalled();
    const stored = (
      await database.query<{ receipt_json: string }>(
        "SELECT receipt_json FROM meeting_imported_source_receipts"
      )
    ).rows[0]!;
    const original = JSON.parse(stored.receipt_json) as ImportedSourceAnalysisReceipt;
    const broadReader = vi.fn(() => Promise.resolve());
    const disabled = createImportedSourceAnalysisRouter({
      database,
      workspaceId: workspace.workspaceId,
      audience: () => Promise.resolve(original.audience),
      generic: {
        audience: () => Promise.resolve(original.audience),
        access: { requireCurrent: broadReader, requireRetained: broadReader }
      }
    });
    try {
      await expect(
        disabled.configuration!.access.requireCurrent({
          source: original.source,
          audience: original.audience
        })
      ).rejects.toThrow();
      await expect(
        disabled.configuration!.access.requireRetained({
          source: original.source,
          audience: original.audience
        })
      ).rejects.toThrow();
      expect(broadReader).not.toHaveBeenCalled();
    } finally {
      await disabled.stop();
    }
  });
  it("starts without a writer and reports the shared exhausted budget without an AI call", async () => {
    const h = await fixture("0");
    const result = await h.native.review(locator);
    expect(result.analysis).toMatchObject({
      status: "deferred",
      errors: [{ code: "analysis-budget-exhausted" }]
    });
    expect(h.sdk).not.toHaveBeenCalled();
    expect(h.readSearch).toHaveBeenCalled();
    expect(await app!.capabilityProblems!()).toContain("ai-budget-exhausted");
  });
  it("drains an admitted native source proof before closing the shared store", async () => {
    const h = await fixture("0");
    const proof = h.holdNextProof();
    const review = h.native.review(locator);
    await proof.entered;
    const stopping = app!.stop();
    await Promise.resolve();
    expect(h.close).not.toHaveBeenCalled();
    proof.release();
    await review;
    await stopping;
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.disconnect).toHaveBeenCalledTimes(1);
  });
  it("can restart after native review is disabled while retaining its reader-only configuration", async () => {
    const h = await fixture("0");
    await app!.stop();
    app = undefined;
    database = await createPgliteDatabase();
    app = await startServer(
      { ...h.env, LUMA_NATIVE_REVIEW_ENABLED: "0" },
      {
        createDatabase: () => Promise.resolve(database),
        createDiscordTransport: () => h.transport
      }
    );
    expect(app).toBeDefined();
    expect(h.disconnect).toHaveBeenCalledTimes(1);
  });
  it("rejects incomplete native configuration before acquiring runtime resources", async () => {
    const createDatabase = vi.fn(() => Promise.resolve(database));
    await expect(
      startServer(
        {
          DISCORD_GUILD_ID: "guild",
          LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: "100000000000000001",
          LUMA_NATIVE_REVIEW_ENABLED: "1"
        },
        { createDatabase }
      )
    ).rejects.toThrow("Native Notion review");
    expect(createDatabase).not.toHaveBeenCalled();
  });
});
