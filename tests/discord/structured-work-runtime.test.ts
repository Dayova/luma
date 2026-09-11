import { createGrantedImportedSourceAnalysisAccess } from "../../src/knowledge/granted-imported-source-analysis-access.js";
import { createLedgerBackedImportedSourceVerifier } from "../../src/knowledge/ledger-backed-imported-source-verifier.js";
import { observedMeetingNoteToObservation } from "../../src/knowledge/meeting-notes-ingestion.js";
import type { RawMeetingNoteSnapshot } from "../../src/knowledge/observed-source-ledger.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Discord from "discord.js";
import { ChannelType, Events, MessageFlags } from "discord.js";
import { createDiscordJsTransport } from "../../src/discord/discord-js-adapter.js";
import { createDiscordMeetingBot } from "../../src/discord/discord-meeting-bot.js";
import {
  createStructuredWorkRuntime,
  structuredWorkRuntimeConfig
} from "../../src/app/structured-work-runtime.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createObservedSourceLedger } from "../../src/knowledge/observed-source-ledger.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import { createWorkspaceAccessPolicy } from "../../src/access/workspace-access-policy.js";
import { createLumaTeamIdentityDirectory } from "../../src/identity/static-identity-directory.js";
import { createAiUsageBudget } from "../../src/ai/ai-usage-budget.js";
import { aiRequestLimitsFromEnv } from "../../src/ai/ai-request.js";
import { AiServiceError } from "../../src/ai/ai-service-error.js";
import { dayovaFounderPersonIds } from "../../src/app/founder-access.js";
import type { StructuredWorkInterpreter } from "../../src/structured-work/interface.js";
import {
  sourceFixture,
  structuredWorkFixture,
  recordSchema
} from "../structured-work/fixture.js";
import { discordAudienceFixture } from "./discord-audience-fixture.js";

const sdk = vi.hoisted(() => ({
  emit: (_event: string, ..._values: unknown[]): boolean => {
    void _event;
    void _values;
    return false;
  },
  get: vi.fn(),
  put: vi.fn(),
  fetch: vi.fn(),
  destroy: vi.fn(),
  options: vi.fn()
}));
vi.mock("discord.js", async (originalImport) => {
  const original = await originalImport<typeof Discord>();
  const { EventEmitter } = await import("node:events");
  return {
    ...original,
    Client: class extends EventEmitter {
      user = { id: "bot_luma" };
      rest = { get: sdk.get };
      channels = { fetch: sdk.fetch };
      constructor(options: unknown) {
        super();
        sdk.options(options);
        sdk.emit = this.emit.bind(this);
      }
      login() {
        queueMicrotask(() => this.emit(original.Events.ClientReady));
        return Promise.resolve();
      }
      destroy = sdk.destroy;
    },
    REST: class {
      setToken() {
        return this;
      }
      put = sdk.put;
    }
  };
});
const workspace = { workspaceId: "workspace_dayova", timezone: "Europe/Berlin" },
  parentId = "100000000000000001",
  threadId = "200000000000000001",
  sourceId = "300000000000000009",
  founderId = "779381502311137301";
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(importMeeting = false) {
  const database = await createPgliteDatabase();
  cleanup.push(() => database.close());
  const directory = await mkdtemp(join(tmpdir(), "luma-structured-runtime-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const identities = createLumaTeamIdentityDirectory();
  const people = await identities.getPeople({
    workspaceId: workspace.workspaceId,
    personIds: [...dayovaFounderPersonIds]
  });
  const accessPolicy = createWorkspaceAccessPolicy({
    workspaceId: workspace.workspaceId,
    identityDirectory: identities,
    authorizedPersonIds: dayovaFounderPersonIds
  });
  const targetsPath = join(directory, "targets.json"),
    sharingPath = join(directory, "sharing.json"),
    dataSourceId = "8fd29131-8312-411d-a833-f320f1afbfaf";
  const targetPolicy = {
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
  };
  const sharing = {
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
  };
  await writeFile(targetsPath, JSON.stringify(targetPolicy), { mode: 0o600 });
  await writeFile(sharingPath, JSON.stringify(sharing), { mode: 0o600 });
  const env = {
    LUMA_DISCORD_STRUCTURED_WORK_ENABLED: "1",
    LUMA_DISCORD_STRUCTURED_WORK_PARENT_CHANNEL_IDS: parentId,
    LUMA_DISCORD_STRUCTURED_WORK_ALLOWED_DISCORD_USER_IDS: people
      .map((p) => p.discordUserId)
      .join(","),
    LUMA_DISCORD_ALLOWED_PARENT_CHANNEL_IDS: parentId,
    LUMA_STRUCTURED_WORK_TARGETS_PATH: targetsPath,
    LUMA_CONTEXT_SHARING_POLICY_PATH: sharingPath,
    LUMA_STRUCTURED_WORK_NOTION_CREDENTIAL_SCOPE_ID: "tables-write",
    LUMA_STRUCTURED_WORK_LINEAR_CREDENTIAL_SCOPE_ID: "validation-work",
    LINEAR_TEAM_ID: "team",
    LINEAR_API_KEY: "test-only",
    OPENAI_API_KEY: "test-only",
    LUMA_STRUCTURED_WORK_NOTION_API_TOKEN: "test-only",
    LUMA_STRUCTURED_WORK_SIGNING_KEY: "test-only-signing-key-at-least-32-bytes"
  };
  const config = structuredWorkRuntimeConfig(env)!;
  const ledger = createObservedSourceLedger({ database });
  const importedIdentity = {
    providerId: "notion",
    sourceKind: "meeting-note" as const,
    sourceObjectId: "imported-root",
    parentObjectId: "3d52e872-28bf-80ae-befe-d1c0e2c39df5",
    url: "https://notion.so/3d52e87228bf80aebefed1c0e2c39df5"
  };
  const time = "2026-09-11T10:00:00.000Z";
  const section = (id: string, text: string) => ({
    state: "available" as const,
    sourceBlockId: id,
    text,
    blocks: [
      { id: `${id}-paragraph`, type: "paragraph", text, checked: null, children: [] }
    ]
  });
  const importedSnapshot: RawMeetingNoteSnapshot = {
    schemaVersion: 1,
    title: "Learning times",
    lifecycle: "ready",
    calendar: { startAt: time, endAt: time, attendeeProviderUserIds: [founderId] },
    recording: null,
    sections: {
      summary: section("summary", "Generated summary of learning times discussion."),
      actionItemsAndNotes: section("notes", "Validate flexible learning times."),
      transcript: section(
        "transcript",
        "Jakob: I will validate the hypothesis. This speaker label is unverified."
      )
    },
    markdown: { content: "# Learning times", truncated: false, unknownBlockIds: [] },
    completeness: { state: "complete" }
  };
  let importedGranted = true;
  const importedAccess = createGrantedImportedSourceAnalysisAccess({
    ledger,
    authorize: () => Promise.resolve(importedGranted),
    evidenceSource: () => ({
      capture: () =>
        Promise.resolve({
          status: "captured",
          evidence: {
            source: importedIdentity,
            providerVersion: null,
            observedAt: time,
            snapshot: structuredClone(importedSnapshot)
          }
        })
    })
  });
  const importedObservation = importMeeting
    ? observedMeetingNoteToObservation(
        {
          workspace,
          source: await ledger.record({
            workspaceId: workspace.workspaceId,
            source: importedIdentity,
            providerVersion: null,
            observedAt: time,
            snapshot: importedSnapshot
          })
        },
        "linear"
      )
    : null;

  const live = discordAudienceFixture({
    botId: "bot_luma",
    channel: (id) => ({
      id,
      guildId: "guild",
      type: id === parentId ? ChannelType.GuildText : ChannelType.PublicThread,
      parentId: id === parentId ? null : parentId
    })
  });
  live.state.ownerId = founderId;
  live.state.members = [
    ...people.map((p) => ({
      user: { id: p.discordUserId!, bot: false },
      roles: ["team"]
    })),
    { user: { id: "bot_luma", bot: true }, roles: ["bots"] }
  ];
  sdk.get.mockImplementation(live.read);
  const originals = sourceFixture().evidence;
  const messages = originals.map((entry, index) => ({
    id:
      index === originals.length - 1
        ? sourceId
        : String(300000000000000001n + BigInt(index)),
    channelId: threadId,
    content: index === originals.length - 1 ? `<@bot_luma> ${entry.text}` : entry.text,
    author: {
      id: people.find((p) => p.personId === `person_${entry.authorPersonId}`)!
        .discordUserId!,
      username: "Founder",
      bot: false
    },
    mentions: {
      users: new Map(index === originals.length - 1 ? [["bot_luma", {}]] : [])
    },
    createdAt: new Date(`2026-09-11T12:00:0${index}.000Z`),
    editedAt: null,
    reference: null,
    url: `https://discord.com/channels/guild/${threadId}/${index === originals.length - 1 ? sourceId : String(300000000000000001n + BigInt(index))}`,
    system: false,
    webhookId: null,
    type: 0,
    attachments: new Map(),
    embeds: [],
    stickers: new Map(),
    components: [],
    poll: null,
    messageSnapshots: new Map(),
    flags: { has: () => false }
  }));
  sdk.fetch.mockImplementation((id: string) =>
    Promise.resolve({
      id,
      guildId: "guild",
      type: id === parentId ? ChannelType.GuildText : ChannelType.PublicThread,
      parentId: id === parentId ? null : parentId,
      isThread: () => id !== parentId,
      name: "Learning times",
      url: `https://discord.com/channels/guild/${id}`,
      permissionsFor: () => ({ has: () => true }),
      messages: {
        fetch: (request: { message?: string; before?: string }) =>
          request.message
            ? Promise.resolve(messages.find((message) => message.id === request.message))
            : Promise.resolve(
                new Map(
                  messages
                    .filter((message) => message.id < request.before!)
                    .reverse()
                    .map((message) => [message.id, message])
                )
              )
      }
    })
  );
  const transport = createDiscordJsTransport({
    token: "test-only",
    clientId: "app",
    guildId: "guild",
    allowedParentChannelIds: [parentId],
    structuredWork: config.discord,
    authorizeHumanReader: async (providerUserId) =>
      !!(await accessPolicy.authorize({
        workspaceId: workspace.workspaceId,
        providerId: "discord",
        providerUserId
      }))
  });
  const external = structuredWorkFixture(database),
    budget = createAiUsageBudget({ database });
  let modelError: Error | null = null;
  const interpret = vi.fn<StructuredWorkInterpreter["interpret"]>(
    async (request, proof) => {
      await proof.requireCurrent();
      if (modelError) throw modelError;
      const plan = await external.interpret();
      const evidence =
        request.source.instructionSource?.evidence ?? request.source.evidence;
      plan.record.evidenceIds = [evidence[0]!.id];
      plan.work.evidenceIds = [evidence[0]!.id, evidence[4]!.id, evidence[5]!.id];
      plan.work.ownership = {
        status: "confirmed",
        personId: "person_jakob",
        evidenceIds: [evidence[4]!.id, evidence[5]!.id]
      };
      return plan;
    }
  );
  const interpreterFactory = vi.fn(() => ({ interpret }));
  const app = await createStructuredWorkRuntime(
    {
      config,
      env,
      workspaceId: workspace.workspaceId,
      database,
      ledger,
      ...(importMeeting ? { importedSourceAccess: importedAccess } : {}),
      conversationEvidenceSource: transport,
      identityDirectory: identities,
      accessPolicy,
      work: external.configuration.work,
      budget,
      limits: aiRequestLimitsFromEnv({}),
      model: "gpt-5.6-luna"
    },
    {
      createInterpreter: interpreterFactory,
      createRecords: (parameters) => {
        const provider = external.configuration.records;
        const allowed = async () => {
          if (
            !(await parameters.authorize({
              audience: {
                workspaceId: workspace.workspaceId,
                personIds: [...dayovaFounderPersonIds]
              },
              objectType: "data-source",
              externalId: dataSourceId,
              dataSourceId,
              targetKey: "hypotheses",
              signal: new AbortController().signal
            }))
          )
            throw new Error("Denied destination");
        };
        return {
          ...provider,
          inspect: async (request) => {
            await allowed();
            return provider.inspect(request);
          },
          requireCurrent: async (request) => {
            await allowed();
            return provider.requireCurrent(request);
          },
          create: async (request) => {
            await allowed();
            return provider.create(request);
          }
        };
      }
    }
  );
  cleanup.push(() => app.stop());
  const make = () => {
    const mi = createMeetingIntelligence({
      database,
      reasoningModel: {
        generateStructured: () => Promise.reject(new Error("No fake Meeting"))
      },
      structuredWork: app.configuration,
      importedSourceObservationVerifier: createLedgerBackedImportedSourceVerifier({
        ledger
      }),
      importedSourceAnalysis: {
        access: importedAccess,
        audience: () =>
          Promise.resolve({
            workspaceId: workspace.workspaceId,
            personIds: [...dayovaFounderPersonIds]
          })
      }
    });
    const execution = createFollowUpExecution({ database, meetingIntelligence: mi });
    const bot = createDiscordMeetingBot({
      database,
      meetingIntelligence: mi,
      followUpExecution: execution,
      structuredWork: app.discord({ meetingIntelligence: mi, execution }),
      identityDirectory: identities,
      authorizedPersonIds: dayovaFounderPersonIds,
      transport,
      workspace,
      guildId: "guild",
      allowedParentChannelIds: [parentId],
      importedMeetingAccess: {
        resolve: () => Promise.resolve(importedObservation?.meetingId ?? null),
        requireCurrent: async ({ state, personIds }) => {
          for (const source of state.importedSources)
            await importedAccess.requireCurrent({
              source,
              audience: { workspaceId: workspace.workspaceId, personIds: [...personIds] }
            });
        }
      }
    });
    return { bot, mi };
  };
  const runtime = make();
  if (importedObservation)
    await runtime.mi.observe({ workspace, observations: [importedObservation] });
  await runtime.bot.start();
  cleanup.push(() => runtime.bot.stop());
  let interactionId = 0;
  const command = async (
    name = "request",
    values: Record<string, string | boolean | number> = {},
    actor = founderId,
    commandName = "structured-work"
  ) => {
    const options = { source_message: sourceId, target: "hypotheses", ...values };
    const request = {
      isChatInputCommand: () => true,
      commandName,
      inGuild: () => true,
      guildId: "guild",
      id: `request-${++interactionId}`,
      channelId: threadId,
      user: { id: actor },
      createdAt: new Date(),
      deferred: true,
      options: {
        getSubcommand: () => name,
        getString: (key: string) => options[key as keyof typeof options] ?? null,
        getBoolean: (key: string) => options[key as keyof typeof options] ?? null,
        getInteger: (key: string) => options[key as keyof typeof options] ?? null
      },
      deferReply: vi.fn(() => Promise.resolve()),
      editReply: vi.fn<
        (value: { content: string; allowedMentions?: unknown }) => Promise<void>
      >(() => Promise.resolve())
    };
    sdk.emit(Events.InteractionCreate, request);
    await expect
      .poll(() => request.editReply.mock.calls.length, { timeout: 15000 })
      .toBe(1);
    expect(request.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    return request.editReply.mock.calls[0]![0].content;
  };
  if (importedObservation) {
    const bound = await command(
      "bind",
      { source_page: importedIdentity.url },
      founderId,
      "meeting"
    );
    expect(bound).toContain("attached");
  }
  return {
    command,
    external,
    database,
    revokeImported: () => {
      importedGranted = false;
    },
    app,
    runtime,
    messages,
    live,
    interpret,
    budget,
    interpreterFactory,
    denyDestination: async () => {
      sharing.grants = [];
      await writeFile(sharingPath, JSON.stringify(sharing));
    },
    revokeTarget: async () => {
      targetPolicy.targets[0]!.authorizedPersonIds = ["person_fabius"];
      await writeFile(targetsPath, JSON.stringify(targetPolicy));
    },
    modelError: (error: Error) => {
      modelError = error;
    }
  };
}
function requestId(content: string) {
  const id = content.match(/Request ID: ([^\s]+)/u)?.[1];
  if (!id) throw new Error(content);
  return id.replace(/\.$/u, "");
}
describe("native structured work runtime", () => {
  it("drains a timed-out model's admitted proof before store closure and refuses late proof admission", async () => {
    const f = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const admitted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let proofFinished = false;
    f.interpret.mockImplementationOnce((_request, proof) => {
      void proof.requireCurrent().catch(() => {});
      return Promise.reject(
        new AiServiceError("timeout", "Synthetic bounded provider timeout")
      );
    });
    const request = {
      requestId: "request",
      workspace,
      instruction: "Original",
      requesterPersonId: "person_jakob",
      source: sourceFixture(),
      records: { schema: recordSchema, records: [], complete: true, revision: "1" },
      work: []
    };
    await expect(
      f.app.configuration.interpreter.interpret(request, {
        requireCurrent: async () => {
          started();
          await gate;
          await f.database.query("SELECT 1");
          proofFinished = true;
        }
      })
    ).rejects.toThrow("timeout");
    await admitted;
    let stopped = false;
    const stopping = f.app.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(proofFinished).toBe(true);
    const lateProof = vi.fn(() => Promise.resolve());
    await expect(
      f.app.configuration.interpreter.interpret(request, { requireCurrent: lateProof })
    ).rejects.toThrow("stopped");
    expect(lateProof).not.toHaveBeenCalled();
    expect(await f.app.configuration.audience(workspace.workspaceId)).toBeNull();
  });

  it("executes the explicit original fixture through native Discord, owned MI/FUE and the shared application factory", async () => {
    const f = await setup();
    const content = await f.command();
    expect(content).toContain("completed");
    expect(content).toContain("Notion record: created");
    expect(content).toContain("Linear task: created");
    expect(f.external.createRecord).toHaveBeenCalledTimes(1);
    expect(f.external.createIssue).toHaveBeenCalledTimes(1);
    expect(f.external.createIssue.mock.calls[0]![0].assigneeId).toBe(
      "67e00026-a426-4476-83bb-fe679fc5ca9c"
    );
    expect(f.interpreterFactory).toHaveBeenCalledWith(
      expect.objectContaining({ budget: f.budget })
    );
    const repeated = await f.command();
    expect(repeated).toContain(requestId(content));
    expect(f.interpret).toHaveBeenCalledTimes(1);
    expect(f.external.createRecord).toHaveBeenCalledTimes(1);
    expect(await f.command("status", { request_id: requestId(content) })).toContain(
      "completed"
    );
    const registered = JSON.stringify(sdk.put.mock.calls);
    expect(registered).toContain("structured-work");
    expect(registered).toContain("meeting");
    expect(sdk.options.mock.calls[0]?.[0]).toHaveProperty("intents", [1, 2, 512, 32768]);
  });
  it("uses the actual bound imported Meeting and distinct authenticated command without inventing transcript ownership", async () => {
    const f = await setup(true);
    const content = await f.command("request", { meeting: true });
    expect(content).toContain("completed");
    expect(content).toContain("Meeting: true");
    const source = f.interpret.mock.calls[0]![0].source;
    expect(source.subject.type).toBe("meeting");
    expect(source.instructionSource?.subject.anchorMessageId).toBe(sourceId);
    expect(source.evidence.every((evidence) => evidence.authorPersonId === null)).toBe(
      true
    );
    expect(f.external.createIssue.mock.calls[0]![0].assigneeId).toBe(
      "67e00026-a426-4476-83bb-fe679fc5ca9c"
    );
    f.revokeImported();
    const denied = await f.command("status", {
      meeting: true,
      request_id: requestId(content)
    });
    expect(denied).not.toContain("notion.so");
    expect(f.external.createRecord).toHaveBeenCalledTimes(1);
  });
  it("retains Notion success and recovers a lost Linear acknowledgement without another write", async () => {
    const f = await setup();
    f.external.loseWork();
    const content = await f.command();
    expect(content).toContain("Notion record: created");
    expect(content).toContain("unknown");
    const id = requestId(content);
    expect(await f.command()).toContain(id);
    expect(await f.command("recover", { request_id: id })).toContain("completed");
    expect(f.external.createRecord).toHaveBeenCalledTimes(1);
    expect(f.external.createIssue).toHaveBeenCalledTimes(1);
    expect(f.interpret).toHaveBeenCalledTimes(1);
  });
  it.each([
    "another-founder",
    "guest",
    "conceptual",
    "incomplete",
    "target",
    "destination",
    "unbound-meeting"
  ])("refuses %s before any model or mutation", async (kind) => {
    const f = await setup();
    if (kind === "conceptual")
      f.messages.at(-1)!.content = "<@bot_luma> Could this hypothesis be worth testing?";
    if (kind === "incomplete") Object.assign(f.messages[0]!, { embeds: [{}] });
    if (kind === "destination") await f.denyDestination();
    if (kind === "target") await f.revokeTarget();
    await f.command(
      "request",
      kind === "unbound-meeting" ? { meeting: true } : {},
      kind === "another-founder"
        ? "726409024894926869"
        : kind === "guest"
          ? "777777777777777777"
          : founderId
    );
    expect(f.interpret).not.toHaveBeenCalled();
    expect(f.external.createRecord).not.toHaveBeenCalled();
    expect(f.external.createIssue).not.toHaveBeenCalled();
  });
  it("renders quota exhaustion as a retained classified failure with no paid retry", async () => {
    const f = await setup();
    f.modelError(new AiServiceError("budget-exhausted", "private provider detail"));
    const content = await f.command();
    expect(content).toContain("budget-exhausted");
    expect(content).not.toContain("private provider detail");
    await f.command();
    expect(f.interpret).toHaveBeenCalledTimes(1);
    expect(f.external.createRecord).not.toHaveBeenCalled();
  });
  it("withholds prior private results after a newly admitted guest can read the channel", async () => {
    const f = await setup();
    const content = await f.command();
    f.live.state.members.push({
      user: { id: "guest-person", bot: false },
      roles: ["team"]
    });
    const denied = await f.command("status", { request_id: requestId(content) });
    expect(denied).not.toContain("Flexible learning");
    expect(denied).not.toContain("notion.so");
  });
  it("keeps all preview fields accessible across pages without silently truncating them", async () => {
    const f = await setup();
    f.external.override((plan) => {
      plan.work.description =
        "Detailed validation step. ".repeat(150) + "FINAL QUALIFICATION";
      plan.record.reconciliation = {
        action: "clarify",
        reason: "Choose the matching hypothesis"
      };
    });
    const first = await f.command();
    const id = requestId(first);
    expect(first).toContain("needs-clarification");
    const last = await f.command("status", { request_id: id, page: 1000 });
    expect(last).toContain("FINAL QUALIFICATION");
    expect(last.length).toBeLessThan(2000);
    expect(f.external.createRecord).not.toHaveBeenCalled();
  });
});
