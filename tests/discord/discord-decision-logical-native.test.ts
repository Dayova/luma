import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Discord from "discord.js";
import { Events, MessageFlags } from "discord.js";
import { createPgliteDatabase } from "../../src/persistence/db.js";
import { createMeetingIntelligence } from "../../src/meeting-intelligence/meeting-intelligence.js";
import { createFollowUpExecution } from "../../src/follow-up-execution/follow-up-execution.js";
import { createDiscordJsTransport } from "../../src/discord/discord-js-adapter.js";
import { createDiscordMeetingBot } from "../../src/discord/discord-meeting-bot.js";
import { createAutomaticDecisionProcessing } from "../../src/app/automatic-decision-processing.js";
import { decisionDigest } from "../../src/decision-intelligence/persistence.js";
import type {
  DecisionSource,
  CanonicalDecisionRecord,
  DecisionWriteReceipt
} from "../../src/domain/decision-records.js";
import type { DecisionRecords } from "../../src/knowledge/decision-records.js";
import { decisionRecord } from "../knowledge/decision-record-fixture.js";
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

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
const logicalId = "logical-meeting:granola-approved-capture";
async function setup() {
  const database = await createPgliteDatabase(),
    f = standingFixture(database);
  const workspace = { workspaceId: audience.workspaceId, timezone: "Europe/Berlin" };
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
  let sourceCurrent = true,
    broadened = false,
    rerouted = false;
  const source: DecisionSource = {
    ...decisionRecord().source,
    subject: { type: "meeting", meetingId: logicalId },
    audience,
    revision: "logical-capture:original",
    capturedAt: "2026-09-11T10:00:00Z",
    evidence: [
      {
        id: "source-1",
        origin: "provider-derived",
        authorPersonId: null,
        text: "Luma remains internal to the four founders.",
        reference: {
          evidenceId: "source-1",
          source: "knowledge",
          sourceObjectId: "granola-summary",
          sourceVersion: "one",
          externalReference: {
            providerId: "granola",
            objectType: "document",
            externalId: "granola-meeting",
            url: "https://notes.granola.ai/d/granola-meeting"
          }
        }
      }
    ]
  };
  const requireCurrent = (current: DecisionSource) =>
    !sourceCurrent || decisionDigest(current) !== decisionDigest(source)
      ? Promise.reject(new Error("Source changed"))
      : Promise.resolve();
  const capture = vi.fn(async (request: { subject: DecisionSource["subject"] }) => {
    if (decisionDigest(request.subject) !== decisionDigest(source.subject))
      throw new Error("Wrong original source");
    await requireCurrent(source);
    return structuredClone(source);
  });
  const interpretation = () => {
    const candidate = decisionRecord().candidate;
    candidate.decisionMakerPersonIds = ["person_jakob"];
    candidate.acceptanceEvidenceIds = [];
    return { candidate, reconciliation: { action: "create" as const } };
  };
  const interpret = vi.fn(() => Promise.resolve(interpretation()));
  const records = new Map<string, CanonicalDecisionRecord>(),
    receipts = new Map<string, DecisionWriteReceipt>();
  let lost = false;
  const write = vi.fn<DecisionRecords["write"]>(({ stage, operationId }) => {
    if (stage.type !== "create-record")
      return Promise.reject(new Error("Unexpected write"));
    const record = {
      content: structuredClone(stage.record),
      version: "one",
      reference: {
        providerId: "notion",
        objectType: "document" as const,
        externalId: stage.record.id,
        url: `https://notion.so/${stage.record.id}`
      }
    };
    records.set(record.content.id, record);
    const receipt = { record, operationId, observedAt: "2026-09-11T10:00:00Z" };
    receipts.set(operationId, receipt);
    if (lost) return Promise.reject(new Error("Lost acknowledgement"));
    return Promise.resolve(structuredClone(receipt));
  });
  const catalog: DecisionRecords = {
    providerId: "notion",
    discover: () =>
      Promise.resolve({
        id: "records",
        revision: decisionDigest([...records.values()]),
        complete: true,
        records: structuredClone([...records.values()])
      }),
    requireCurrent: ({ snapshot }) =>
      snapshot.revision !== decisionDigest([...records.values()])
        ? Promise.reject(new Error("Record head changed"))
        : Promise.resolve(),
    read: ({ recordId }) =>
      Promise.resolve(structuredClone(records.get(recordId) ?? null)),
    readReference: ({ reference }) =>
      Promise.resolve(structuredClone(records.get(reference.externalId) ?? null)),
    findWritten: ({ operationId }) =>
      Promise.resolve(structuredClone(receipts.get(operationId) ?? null)),
    write
  };
  const mi = createMeetingIntelligence({
    database,
    reasoningModel: {
      generateStructured: () => Promise.reject(new Error("No synthetic meeting analysis"))
    },
    decisionIntelligence: {
      accessPolicy: f.accessPolicy,
      audience: () => Promise.resolve(audience),
      authority: f.authority,
      records: catalog,
      evidenceSource: {
        capture: () => Promise.reject(new Error("No conversation source requested")),
        requireCurrent: () =>
          Promise.reject(new Error("No conversation source requested"))
      },
      meetingEvidenceSource: { capture, requireCurrent },
      interpreter: { interpret },
      automatic: {
        evidenceSource: { captureProcessed: capture, requireCurrent },
        detector: {
          detect: () =>
            Promise.resolve({
              complete: true,
              candidates: [{ confidence: "high", interpretation: interpretation() }]
            })
        }
      }
    }
  });
  const execution = createFollowUpExecution({ database, meetingIntelligence: mi });
  const automatic = await createAutomaticDecisionProcessing({
    database,
    workspace,
    meetingIntelligence: mi
  });
  automatic.start();
  const transport = createDiscordJsTransport({
    token: "private-test",
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
  let beforeDelivery: (() => void) | null = null;
  const resolveMeeting = vi.fn(
    (request: { workspaceId: string; meetingId: string; audience: typeof audience }) => {
      if (
        !sourceCurrent ||
        request.workspaceId !== audience.workspaceId ||
        decisionDigest(request.audience) !==
          decisionDigest({ ...audience, personIds: [...audience.personIds].sort() })
      )
        return Promise.resolve(null);
      return Promise.resolve(
        request.meetingId === logicalId
          ? rerouted
            ? "different-logical-meeting"
            : logicalId
          : null
      );
    }
  );
  const bot = createDiscordMeetingBot({
    database,
    workspace,
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
          const result = await handler(command);
          beforeDelivery?.();
          return result;
        }, ask)
    },
    decisionRecords: {
      config,
      meetingIntelligence: mi,
      execution,
      automatic,
      logicalMeetings: {
        resolveMeeting,
        currentAudience: () =>
          Promise.resolve(
            broadened
              ? { ...audience, personIds: [...audience.personIds, "guest"] }
              : audience
          )
      }
    }
  });
  await bot.start();
  closes.push(async () => {
    await bot.stop();
    await automatic.stop();
    await database.close();
  });
  let sequence = 0;
  async function command(
    subcommand: string,
    values: Record<string, string>,
    actor = founderId,
    channelId = threadId
  ) {
    const id = String(1800000000000000000n + BigInt(++sequence));
    const request = {
      isChatInputCommand: () => true,
      commandName: "decision-record",
      inGuild: () => true,
      guildId,
      id,
      channelId,
      user: { id: actor },
      createdAt: new Date("2026-09-11T10:00:00Z"),
      deferred: true,
      options: {
        getSubcommand: () => subcommand,
        getString: (key: string) => values[key] ?? null,
        getInteger: (key: string) => (values[key] ? Number(values[key]) : null)
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
    return { id, ...request.editReply.mock.calls[0]![0] };
  }
  return {
    ...f,
    database,
    mi,
    write,
    interpret,
    command,
    resolveMeeting,
    queue: async () => {
      await automatic.meeting({
        workspaceId: workspace.workspaceId,
        meetingId: logicalId,
        observationId: "accepted-granola-source",
        sourceRevision: 1,
        contentHash: source.contentHash
      });
      await expect.poll(async () => (await automatic.status()).completed).toBe(1);
    },
    loseResponse: () => {
      lost = true;
    },
    revokeSource: () => {
      sourceCurrent = false;
    },
    broaden: () => {
      broadened = true;
    },
    reroute: () => {
      rerouted = true;
    },
    beforeDelivery: (hook: () => void) => {
      beforeDelivery = hook;
    }
  };
}
describe("native LogicalMeeting Decision addressing", () => {
  it("registers all meeting addresses and records/reviews/accepts a provider-derived source without a synthetic binding", async () => {
    const f = await setup();
    const registered = JSON.stringify(sdk.put.mock.calls);
    expect(registered.match(/meeting_id/g)!.length).toBeGreaterThanOrEqual(5);
    const first = await f.command(
      "meeting",
      {
        meeting_id: logicalId,
        instruction: "Record this decision."
      },
      founderId,
      parentId
    );
    expect(first.content).toContain("needs-clarification");
    expect(first.content).toContain(`Meeting ID (meeting_id): ${logicalId}`);
    const requestId = `discord:${first.id}:decision-record`;
    const status = await f.command("status", {
      meeting_id: logicalId,
      request_id: requestId
    });
    const token = status.content.match(/Review token: ([a-f0-9]+)/)?.[1];
    expect(token).toBeTruthy();
    const accepted = await f.command("accept", {
      meeting_id: logicalId,
      request_id: requestId,
      review_token: token!,
      confirmation: "I accept this exact decision and want it recorded."
    });
    expect(accepted.content).toContain("recorded");
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(
      (await f.database.query("SELECT * FROM discord_meeting_threads")).rows
    ).toEqual([]);
    expect((await f.database.query("SELECT * FROM meetings")).rows).toEqual([]);
  });
  it("addresses automatic Granola candidates and recovers the original uncertain approved write", async () => {
    const f = await setup();
    await f.queue();
    const candidates = await f.command("candidates", { meeting_id: logicalId });
    expect(candidates.content).toContain("candidate 1/1");
    expect(candidates.content).toContain(`Meeting ID (meeting_id): ${logicalId}`);
    const requestId = candidates.content.match(/Request ID: ([^\n]+)\./)?.[1],
      token = candidates.content.match(/Review token: ([a-f0-9]+)/)?.[1];
    expect(requestId).toBeTruthy();
    expect(token).toBeTruthy();
    f.loseResponse();
    await f.command("accept", {
      meeting_id: logicalId,
      request_id: requestId!,
      review_token: token!,
      confirmation: "I accept this exact decision and want it recorded."
    });
    const recovered = await f.command("recover", {
      meeting_id: logicalId,
      request_id: requestId!
    });
    expect(recovered.content).toContain("recorded");
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.interpret).not.toHaveBeenCalled();
  });
  it("rejects mixed addresses and refuses an imported alias in an explicit LogicalMeeting address", async () => {
    const f = await setup();
    expect(
      (await f.command("candidates", { meeting_id: logicalId, source_message: "123" }))
        .content
    ).toContain("never both");
    expect(
      (
        await f.command("meeting", {
          meeting_id: "imported-alias",
          instruction: "Record this decision."
        })
      ).content
    ).toContain("could not verify");
    expect(f.interpret).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each(["source", "audience", "rerouted", "channel", "guest"])(
    "withholds final delivery after %s changes",
    async (kind) => {
      const f = await setup();
      await f.queue();
      f.beforeDelivery(() => {
        if (kind === "source") f.revokeSource();
        if (kind === "audience") f.broaden();
        if (kind === "rerouted") f.reroute();
        if (kind === "channel") f.revokeChannel();
        if (kind === "guest") f.addGuest();
      });
      const response = await f.command("candidates", { meeting_id: logicalId });
      expect(response.content).not.toContain("Luma remains internal");
      expect(response.content).not.toContain("Review token:");
      expect(f.write).not.toHaveBeenCalled();
    }
  );
});
