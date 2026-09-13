import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Discord from "discord.js";
import { Events, MessageFlags } from "discord.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import { createDiscordJsTransport } from "../../src/discord/discord-js-adapter.js";
import { createDiscordMeetingBot } from "../../src/discord/discord-meeting-bot.js";
import { createDecisionStandingPolicy } from "../../src/decision-intelligence/standing-permission.js";
import { createDiscordDecisionPermissionSourceAccess } from "../../src/discord/discord-decision-standing-runtime.js";
import {
  audience,
  founderId,
  guildId,
  parentId,
  standingFixture,
  threadId
} from "../decision-intelligence/standing-permission-fixture.js";
const sdk = vi.hoisted(() => ({
  emit: (_event: string, ..._values: unknown[]): boolean => {
    void _event;
    void _values;
    return false;
  },
  get: vi.fn(),
  put: vi.fn(),
  destroy: vi.fn()
}));
vi.mock("discord.js", async (importOriginal) => {
  const original = await importOriginal<typeof Discord>(),
    { EventEmitter } = await import("node:events");
  return {
    ...original,
    Client: class extends EventEmitter {
      user = { id: "bot_luma" };
      rest = { get: sdk.get };
      constructor() {
        super();
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
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
async function setup() {
  const database = await createPgliteDatabase(),
    f = standingFixture(database);
  sdk.get.mockImplementation(f.read);
  const config = {
    parentChannelIds: [parentId],
    allowedDiscordUserIds: [
      founderId,
      "726409024894926869",
      "1376219174723911841",
      "1492911575806251219"
    ],
    maxMessages: 50,
    maxEvidenceChars: 32000,
    minIntervalMs: 1000
  };
  const transport = createDiscordJsTransport({
    token: "private-test-token",
    clientId: "bot_luma",
    guildId,
    allowedParentChannelIds: [parentId],
    decisionRecords: config,
    authorizeHumanReader: async (providerUserId) =>
      (await f.accessPolicy.authorize({
        workspaceId: audience.workspaceId,
        providerId: "discord",
        providerUserId
      })) !== null
  });
  const sourceAccess = createDiscordDecisionPermissionSourceAccess({
    workspaceId: audience.workspaceId,
    guildId,
    parentChannelIds: [parentId],
    founderPersonIds: audience.personIds,
    identityDirectory: f.identityDirectory,
    accessPolicy: f.accessPolicy,
    resolveChannel: (request) => transport.resolveChannel(request)
  });
  const policy = await createDecisionStandingPolicy({
    database,
    workspaceId: audience.workspaceId,
    audience,
    accessPolicy: f.accessPolicy,
    authority: f.authority,
    sourceAccess
  });
  const mi = createMeetingIntelligence({
      database,
      reasoningModel: {
        generateStructured: () =>
          Promise.reject(new Error("No model call from a permission command"))
      }
    }),
    execution = createFollowUpExecution({ database, meetingIntelligence: mi });
  let beforeDelivery: (() => Promise<void>) | null = null;
  const bot = createDiscordMeetingBot({
    database,
    workspace: { workspaceId: audience.workspaceId, timezone: "Europe/Berlin" },
    meetingIntelligence: mi,
    followUpExecution: execution,
    identityDirectory: f.identityDirectory,
    authorizedPersonIds: audience.personIds,
    guildId,
    allowedParentChannelIds: [parentId],
    transport: {
      ...transport,
      connect: (handler, ask) =>
        transport.connect(async (command) => {
          const response = await handler(command);
          await beforeDelivery?.();
          return response;
        }, ask)
    },
    decisionRecords: {
      config,
      standingPolicy: policy,
      meetingIntelligence: {
        observe: () =>
          Promise.reject(new Error("No source analysis from permission control")),
        query: () => Promise.reject(new Error("No Decision request created")),
        conclude: () => Promise.reject(new Error("No Meeting created"))
      },
      execution
    }
  });
  await bot.start();
  cleanup.push(async () => {
    await bot.stop();
    await policy.stop();
    await database.close();
  });
  let sequence = 0;
  async function command(
    values: Record<string, string>,
    options: { actor?: string; channel?: string; interactionId?: string } = {}
  ) {
    const interactionId =
      options.interactionId ?? String(1800000000000000000n + BigInt(++sequence));
    const request = {
      isChatInputCommand: () => true,
      commandName: "decision-record",
      inGuild: () => true,
      guildId,
      id: interactionId,
      channelId: options.channel ?? parentId,
      user: { id: options.actor ?? founderId },
      createdAt: new Date("2026-09-11T09:00:00Z"),
      deferred: true,
      options: {
        getSubcommand: () => "automatic",
        getString: (key: string) => values[key] ?? null
      },
      deferReply: vi.fn(() => Promise.resolve()),
      editReply: vi.fn<
        (value: { content: string; allowedMentions?: unknown }) => Promise<void>
      >(() => Promise.resolve())
    };
    sdk.emit(Events.InteractionCreate, request);
    await expect
      .poll(() => request.editReply.mock.calls.length, { timeout: 10000 })
      .toBe(1);
    expect(request.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    return request.editReply.mock.calls[0]![0];
  }
  return {
    ...f,
    permissionCommand: f.command,
    database,
    policy,
    command,
    transport,
    beforeDelivery: (hook: () => Promise<void>) => {
      beforeDelivery = hook;
    }
  };
}
const enable = {
  action: "enable",
  scope: "luma",
  class: "new-decisions",
  sharing: "four-founders"
};
describe("native founder recording permission", () => {
  it("registers typed choices and enables, reads and disables without a Meeting, model or extra confirmation", async () => {
    const f = await setup();
    expect(JSON.stringify(sdk.put.mock.calls)).toContain("decisions-and-corrections");
    const enabled = await f.command(enable);
    expect(enabled.content).toContain("recording: active");
    expect(enabled.content).toContain("person_jakob");
    expect(enabled.content).toContain("create or link records");
    expect(enabled.content).toContain(
      `Origin channel: https://discord.com/channels/${guildId}/${parentId}`
    );
    expect(enabled.allowedMentions).toEqual({ parse: [] });
    expect((await f.command({ action: "status", scope: "luma" })).content).toContain(
      "recording: active"
    );
    expect((await f.command({ action: "disable", scope: "luma" })).content).toContain(
      "recording: disabled"
    );
    expect(await f.policy.read({ audience })).toEqual([]);
    const meetings = await f.database.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM meetings"
    );
    expect(meetings.rows[0]?.count).toBe(0);
  });
  it("does not interpret omitted choices or prose as standing authorization", async () => {
    const f = await setup();
    expect((await f.command({ action: "enable", scope: "luma" })).content).toContain(
      "recording class and sharing:four-founders"
    );
    await f.command({ ...enable, class: "I guess yes" });
    await f.command({ ...enable, sharing: "guests" });
    expect(await f.policy.read({ audience })).toEqual([]);
  });
  it("keeps another founder's status and disable limited to their own permission", async () => {
    const f = await setup();
    await f.command(enable);
    const other = await f.command(
      { action: "status", scope: "luma" },
      { actor: "726409024894926869", channel: threadId }
    );
    expect(other.content).toContain("Owner: person_fabius");
    expect(other.content).not.toContain("person_jakob");
    await f.command(
      { action: "disable", scope: "luma" },
      { actor: "726409024894926869" }
    );
    expect(
      (await f.policy.read({ audience })).map((grant) => grant.authorizedBy)
    ).toEqual(["person_jakob"]);
  });
  it("withholds private status after the origin gains a guest administrator", async () => {
    const f = await setup();
    await f.command(enable);
    f.addGuest();
    const response = await f.command({ action: "status", scope: "luma" });
    expect(response.content).not.toContain("Grant:");
    expect(response.content).not.toContain("recording: active");
  });
  it("requires all original four recipients to remain present in the real native audience proof", async () => {
    const f = await setup();
    await f.command(enable);
    f.missingReader("726409024894926869");
    const status = await f.command({ action: "status", scope: "luma" });
    expect(status.content).not.toContain("recording: active");
    expect(await f.policy.read({ audience })).toEqual([]);
  });
  it("retains the latest disabled state when Discord redelivers an old enable interaction", async () => {
    const f = await setup(),
      old = "1800000000000000001";
    await f.command(enable, { interactionId: old });
    await f.command(
      { action: "disable", scope: "luma" },
      { interactionId: "1800000000000000003" }
    );
    expect((await f.command(enable, { interactionId: old })).content).toContain(
      "recording: disabled"
    );
  });
  it("withholds a stale active receipt when permission is disabled before final reply", async () => {
    const f = await setup();
    await f.command(enable);
    f.beforeDelivery(async () => {
      await f.policy.command({
        ...f.permissionCommand(99),
        choice: { action: "disable" }
      });
    });
    const response = (await f.command({ action: "status", scope: "luma" })).content;
    expect(response).not.toContain("recording: active");
    expect(response).toContain("/decision-record automatic with action:status");
    expect(await f.policy.read({ audience })).toEqual([]);
  });
});
