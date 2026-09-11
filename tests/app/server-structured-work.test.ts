import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningLumaApp } from "../../src/app/server.js";
import { createStructuredWorkRuntime } from "../../src/app/structured-work-runtime.js";
import { createOpenAIStructuredWorkInterpreter } from "../../src/structured-work/openai-structured-work-interpreter.js";
import { createPgliteDatabase, type LumaDatabase } from "../../src/persistence/db.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";
import type { DiscordJsTransport } from "../../src/discord/discord-js-adapter.js";
import type { StructuredWorkSource } from "../../src/domain/structured-work.js";
import { captureFixture, subject, workspace } from "../consultation/harness.js";
import { structuredWorkFixture } from "../structured-work/fixture.js";

let database: LumaDatabase, folder: string, app: RunningLumaApp | undefined;
beforeEach(async () => {
  database = await createPgliteDatabase();
  folder = await mkdtemp(join(tmpdir(), "luma-main-structured-"));
});
afterEach(async () => {
  if (app) await app.stop();
  else await database.close();
  app = undefined;
  await rm(folder, { recursive: true, force: true });
});

async function fixture(limit = "30") {
  const dataSourceId = "8fd29131-8312-411d-a833-f320f1afbfaf";
  const targetsPath = join(folder, "targets.json"),
    sharingPath = join(folder, "sharing.json");
  await writeFile(
    targetsPath,
    JSON.stringify({
      version: 1,
      workspaceId: workspace.workspaceId,
      targets: [
        {
          key: "hypotheses",
          label: "Hypotheses",
          dataSourceId,
          titleField: "hypothesis",
          fields: {
            hypothesis: { property: "Hypothesis", type: "text", required: true },
            evidence: { property: "Evidence so far", type: "text" },
            status: { property: "Status", type: "choice", required: true }
          },
          defaults: { status: { type: "choice", value: "To validate" } },
          authorizedPersonIds: [...dayovaFounderPersonIds]
        }
      ]
    }),
    { mode: 0o600 }
  );
  await writeFile(
    sharingPath,
    JSON.stringify({
      version: 1,
      workspaceId: workspace.workspaceId,
      grants: [
        {
          provider: "notion",
          credentialScopeId: "tables-write",
          resources: [dataSourceId],
          personIds: [...dayovaFounderPersonIds]
        },
        {
          provider: "linear",
          credentialScopeId: "validation-work",
          resources: ["team"],
          personIds: [...dayovaFounderPersonIds]
        }
      ]
    }),
    { mode: 0o600 }
  );
  const raw = captureFixture(),
    anchor = raw.snapshot.messages[0]!;
  if (anchor.state !== "available") throw new Error("fixture");
  anchor.text =
    "<@luma> Add this hypothesis to our Hypotheses table and create a Linear task to validate it.";
  anchor.ordinal = 1;
  const commitment = {
    ...structuredClone(anchor),
    id: "300000000000000000",
    ordinal: 0,
    text: "I will validate whether flexible learning times improve student engagement."
  };
  raw.snapshot.messages.unshift(commitment);
  raw.snapshot.boundary.firstMessageId = commitment.id;
  raw.snapshot.boundary.messageIds.unshift(commitment.id);
  let granted = true;
  let handler: Parameters<DiscordJsTransport["connect"]>[0];
  const disconnect = vi.fn(() => Promise.resolve());
  const transport: DiscordJsTransport = {
    connect: (commands) => {
      handler = commands;
      return Promise.resolve();
    },
    disconnect,
    capture: () =>
      granted
        ? Promise.resolve(structuredClone(raw))
        : Promise.reject(new Error("revoked")),
    resolveChannel: ({ channelId }) =>
      Promise.resolve(
        granted
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
  const external = structuredWorkFixture(database);
  const model = vi.fn(async ({ input }: { input: string }) => {
    const request = JSON.parse(input) as { source: StructuredWorkSource };
    const evidence = request.source.evidence;
    const plan = await external.interpret();
    plan.record.evidenceIds = [evidence[0]!.id];
    plan.work.evidenceIds = evidence.map((e) => e.id);
    plan.work.ownership = {
      status: "confirmed",
      personId: "person_jakob",
      evidenceIds: [evidence[0]!.id]
    };
    return {
      outputText: JSON.stringify({
        ...plan,
        record: {
          ...plan.record,
          fields: Object.entries(plan.record.fields).map(([key, value]) => ({
            key,
            value
          }))
        }
      }),
      model: "gpt-5.6-luna",
      serviceTier: "default",
      status: "completed",
      usage: {
        inputTokens: 100,
        outputTokens: 30,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0
      }
    };
  });
  const env = {
    DISCORD_TOKEN: "test-only",
    DISCORD_CLIENT_ID: "application",
    DISCORD_GUILD_ID: "guild",
    LUMA_WORKSPACE_ID: workspace.workspaceId,
    LUMA_REASONING_MODEL_PROVIDER: "disabled",
    LUMA_AI_MONTHLY_LIMIT_USD: limit,
    OPENAI_API_KEY: "test-only",
    LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: "100000000000000001",
    LUMA_DISCORD_STRUCTURED_WORK_ENABLED: "1",
    LUMA_DISCORD_STRUCTURED_WORK_PARENT_CHANNEL_IDS: "100000000000000001",
    LUMA_DISCORD_STRUCTURED_WORK_ALLOWED_DISCORD_USER_IDS:
      "779381502311137301,726409024894926869,1492911575806251219,1376219174723911841",
    LUMA_STRUCTURED_WORK_TARGETS_PATH: targetsPath,
    LUMA_CONTEXT_SHARING_POLICY_PATH: sharingPath,
    LUMA_STRUCTURED_WORK_NOTION_CREDENTIAL_SCOPE_ID: "tables-write",
    LUMA_STRUCTURED_WORK_LINEAR_CREDENTIAL_SCOPE_ID: "validation-work",
    LINEAR_TEAM_ID: "team",
    LINEAR_API_KEY: "test-only",
    LUMA_STRUCTURED_WORK_NOTION_API_TOKEN: "test-only",
    LUMA_STRUCTURED_WORK_SIGNING_KEY: "test-only-signing-key-longer-than-32-bytes"
  };
  app = await startServer(env, {
    createDatabase: () => Promise.resolve(database),
    createDiscordTransport: () => transport,
    createWorkProvider: () => external.configuration.work,
    createOpenAIReasoningModel: () => {
      throw new Error("No Meeting analysis");
    },
    createStructuredWorkRuntime: (input) =>
      createStructuredWorkRuntime(input, {
        createRecords: () => external.configuration.records,
        createInterpreter: (config) =>
          createOpenAIStructuredWorkInterpreter({ ...config, client: { create: model } })
      })
  });
  const command = {
    type: "structured-work-request" as const,
    targetKey: "hypotheses",
    meeting: false,
    sourceMessageId: subject.anchorMessageId,
    guildId: "guild",
    channelId: subject.conversationObjectId,
    actorDiscordUserId: "779381502311137301",
    occurredAt: "2026-09-11T10:00:00.000Z"
  };
  return {
    disconnect,
    model,
    external,
    invoke: (interactionId: string) => handler({ ...command, interactionId }),
    revoke: () => {
      granted = false;
    }
  };
}

describe("structured work through the actual shared main app", () => {
  it("stops ingress immediately but keeps the real store open for an admitted health read", async () => {
    const f = await fixture();
    let release = () => {},
      entered = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transaction = database.transaction.bind(database);
    let intercepted = false;
    const gate = vi
      .spyOn(database, "transaction")
      .mockImplementation(
        async <T>(work: Parameters<typeof database.transaction<T>>[0]) => {
          if (!intercepted) {
            intercepted = true;
            entered();
            await held;
          }
          return transaction(work);
        }
      );
    const close = vi.spyOn(database, "close");
    const read = app!.capabilityProblems!();
    let stopping: Promise<void> | undefined;
    try {
      await started;
      stopping = app!.stop();
      await vi.waitFor(() => expect(f.disconnect).toHaveBeenCalledTimes(1));
      expect(close).not.toHaveBeenCalled();
      expect(await app!.capabilityProblems!()).toEqual(["capability-status-unavailable"]);
      release();
      await read;
      await stopping;
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await read.catch(() => undefined);
      await stopping;
      gate.mockRestore();
      close.mockRestore();
    }
  });
  it("creates both requested records once and preserves the original command across native retries", async () => {
    const f = await fixture();
    const result = await f.invoke("first");
    expect(result.content).toContain("completed");
    expect(f.model).toHaveBeenCalledTimes(1);
    expect(f.external.createRecord).toHaveBeenCalledTimes(1);
    expect(f.external.createIssue).toHaveBeenCalledTimes(1);
    const retry = await f.invoke("second");
    expect(retry.content).toContain("completed");
    expect(f.model).toHaveBeenCalledTimes(1);
    expect(f.external.createRecord).toHaveBeenCalledTimes(1);
    expect(f.external.createIssue).toHaveBeenCalledTimes(1);
    f.revoke();
    expect((await f.invoke("revoked")).content).not.toContain("Flexible learning times");
    expect(f.model).toHaveBeenCalledTimes(1);
  });
  it("exposes the shared zero monthly cap without a model call or either mutation", async () => {
    const f = await fixture("0");
    expect(await app!.capabilityProblems!()).toContain("ai-budget-exhausted");
    const result = await f.invoke("no-budget");
    expect(result.content).toMatch(/budget|limit/i);
    expect(f.model).not.toHaveBeenCalled();
    expect(f.external.createRecord).not.toHaveBeenCalled();
    expect(f.external.createIssue).not.toHaveBeenCalled();
  });
});
